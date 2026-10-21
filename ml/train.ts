import fs from "node:fs";
import path from "node:path";
import { featurize, FEATURE_COUNT, HISTORY, HORIZON, MIN_HISTORY, type ForecastModel, type Layer } from "../shared/forecast";
import { makeEpisodes, mulberry32, EPISODE_STEPS, type Episode } from "./episodes";
import { aiDetector, summarize } from "./metrics";

/**
 * Trains the early-warning model from scratch (no outside model, no Python): a small neural network
 * 28 inputs -> 48 -> 24 -> 1 risk, trained on simulated episodes, written to shared/forecastModel.ts.
 *   npm run ml:train            (about 5 minutes; seeds are fixed so it is reproducible)
 * Environment: ML_TRAIN_EPISODES (default 700), ML_VAL_EPISODES (default 200), ML_EPOCHS (default 18).
 */
const N_TRAIN = Number(process.env.ML_TRAIN_EPISODES) || 700;
const N_VAL = Number(process.env.ML_VAL_EPISODES) || 200;
const EPOCHS = Number(process.env.ML_EPOCHS) || 18;
const SEEDS = { train: 1, val: 100_000 }; // the test set (eval.ts) uses 900_000+, never seen here
const KEEP_EASY_NEG = 0.15; // easy negatives are subsampled and re-weighted so the training prior stays natural
const FA_TARGET = 5; // validation false-alarm budget when choosing the alarm threshold: per 100 zone-episodes

interface Data { X: Float32Array; y: Uint8Array; w: Float32Array; n: number }

function buildSamples(eps: Episode[], seed: number): Data {
  const rng = mulberry32(seed);
  const xs: number[][] = [], ys: number[] = [], ws: number[] = [];
  for (const ep of eps)
    ep.zones.forEach((z, zi) => {
      const crit = ep.critical[zi], seen = ep.seen[zi];
      for (let t = MIN_HISTORY - 1; t <= EPISODE_STEPS - 1 - HORIZON; t++) {
        if (crit[t]) continue; // already out of range: nothing to forecast
        const label = crit.slice(t + 1, t + 1 + HORIZON).some(Boolean) ? 1 : 0;
        const x = featurize(seen.slice(Math.max(0, t - HISTORY + 1), t + 1), z);
        const hard = label === 1 || x[0] < 0.35 || x[1] < 0.35; // positives and near-limit negatives are always kept
        if (!hard && rng() >= KEEP_EASY_NEG) continue;
        xs.push(x); ys.push(label); ws.push(hard ? 1 : 1 / KEEP_EASY_NEG);
      }
    });
  const X = new Float32Array(xs.length * FEATURE_COUNT);
  xs.forEach((x, i) => X.set(x, i * FEATURE_COUNT));
  return { X, y: Uint8Array.from(ys), w: Float32Array.from(ws), n: xs.length };
}

// ---------------- the network ----------------
class Net {
  W: Float64Array[] = []; B: Float64Array[] = [];
  constructor(public sizes: number[], rng: () => number) {
    for (let l = 0; l < sizes.length - 1; l++) {
      const fanIn = sizes[l], fanOut = sizes[l + 1];
      const w = new Float64Array(fanIn * fanOut);
      for (let i = 0; i < w.length; i++) w[i] = (rng() * 2 - 1) * Math.sqrt(6 / fanIn); // He-style uniform init
      this.W.push(w); this.B.push(new Float64Array(fanOut));
    }
  }
  forward(x: ArrayLike<number>, off: number, acts: Float64Array[]): number {
    const s0 = this.sizes[0];
    for (let i = 0; i < s0; i++) acts[0][i] = x[off + i];
    const last = this.W.length - 1;
    for (let l = 0; l <= last; l++) {
      const inn = this.sizes[l], out = this.sizes[l + 1], W = this.W[l], B = this.B[l], a = acts[l], o = acts[l + 1];
      for (let j = 0; j < out; j++) {
        let s = B[j];
        const base = j * inn;
        for (let i = 0; i < inn; i++) s += W[base + i] * a[i];
        o[j] = l === last ? 1 / (1 + Math.exp(-s)) : s > 0 ? s : 0;
      }
    }
    return acts[last + 1][0];
  }
}

function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0, pos = 0;
  idx.forEach((i, r) => { if (labels[i]) { rankSum += r + 1; pos++; } });
  const neg = labels.length - pos;
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}

function main() {
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  log(`generating ${N_TRAIN} training and ${N_VAL} validation episodes...`);
  const trainEps = makeEpisodes(SEEDS.train, N_TRAIN);
  const valEps = makeEpisodes(SEEDS.val, N_VAL);
  const tr = buildSamples(trainEps, 11), va = buildSamples(valEps, 12);
  log(`samples: train ${tr.n} (${tr.y.reduce((a, b) => a + b, 0)} positive), validation ${va.n}`);

  // standardise with training statistics
  const mean = new Array<number>(FEATURE_COUNT).fill(0), std = new Array<number>(FEATURE_COUNT).fill(0);
  for (let i = 0; i < tr.n; i++) for (let f = 0; f < FEATURE_COUNT; f++) mean[f] += tr.X[i * FEATURE_COUNT + f] / tr.n;
  for (let i = 0; i < tr.n; i++) for (let f = 0; f < FEATURE_COUNT; f++) std[f] += (tr.X[i * FEATURE_COUNT + f] - mean[f]) ** 2 / tr.n;
  for (let f = 0; f < FEATURE_COUNT; f++) std[f] = Math.max(1e-6, Math.sqrt(std[f]));
  const norm = (d: Data) => { for (let i = 0; i < d.n; i++) for (let f = 0; f < FEATURE_COUNT; f++) d.X[i * FEATURE_COUNT + f] = (d.X[i * FEATURE_COUNT + f] - mean[f]) / std[f]; };
  norm(tr); norm(va);

  const sizes = [FEATURE_COUNT, 48, 24, 1];
  const rng = mulberry32(2024);
  const net = new Net(sizes, rng);
  const acts = sizes.map((s) => new Float64Array(s));
  const params = [...net.W, ...net.B];
  const grads = params.map((p) => new Float64Array(p.length));
  const m1 = params.map((p) => new Float64Array(p.length)), m2 = params.map((p) => new Float64Array(p.length));
  const BATCH = 256, nL = net.W.length;
  const order = Uint32Array.from({ length: tr.n }, (_, i) => i);
  const dz = sizes.map((s) => new Float64Array(s));
  let step = 0, best = { loss: Infinity, auc: 0, W: net.W.map((w) => w.slice()), B: net.B.map((b) => b.slice()), epoch: 0 };

  const evalVal = () => {
    let loss = 0, wsum = 0; const sc: number[] = [], lb: number[] = [];
    for (let i = 0; i < va.n; i++) {
      const p = Math.min(1 - 1e-7, Math.max(1e-7, net.forward(va.X, i * FEATURE_COUNT, acts)));
      loss += va.w[i] * -(va.y[i] ? Math.log(p) : Math.log(1 - p)); wsum += va.w[i];
      if (i % 3 === 0) { sc.push(p); lb.push(va.y[i]); }
    }
    return { loss: loss / wsum, auc: auc(sc, lb) };
  };

  for (let epoch = 1; epoch <= EPOCHS; epoch++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    const lr = 0.0003 + (0.003 - 0.0003) * 0.5 * (1 + Math.cos((Math.PI * (epoch - 1)) / EPOCHS)); // cosine decay
    for (let s0 = 0; s0 < tr.n; s0 += BATCH) {
      const end = Math.min(tr.n, s0 + BATCH);
      grads.forEach((g) => g.fill(0));
      for (let k = s0; k < end; k++) {
        const i = order[k];
        const p = net.forward(tr.X, i * FEATURE_COUNT, acts);
        dz[nL][0] = tr.w[i] * (p - tr.y[i]);
        for (let l = nL - 1; l >= 0; l--) {
          const inn = sizes[l], out = sizes[l + 1], W = net.W[l], gW = grads[l], gB = grads[nL + l], a = acts[l];
          if (l > 0) dz[l].fill(0);
          for (let j = 0; j < out; j++) {
            const d = dz[l + 1][j];
            if (d === 0) continue;
            gB[j] += d;
            const base = j * inn;
            for (let q = 0; q < inn; q++) { gW[base + q] += d * a[q]; if (l > 0) dz[l][q] += W[base + q] * d; }
          }
          if (l > 0) for (let q = 0; q < inn; q++) if (acts[l][q] <= 0) dz[l][q] = 0; // relu derivative
        }
      }
      step++;
      const b1 = 0.9, b2 = 0.999, c1 = 1 - Math.pow(b1, step), c2 = 1 - Math.pow(b2, step), inv = 1 / (end - s0);
      for (let pi = 0; pi < params.length; pi++) {
        const P = params[pi], G = grads[pi], M = m1[pi], V = m2[pi];
        for (let q = 0; q < P.length; q++) {
          const g = G[q] * inv;
          M[q] = b1 * M[q] + (1 - b1) * g; V[q] = b2 * V[q] + (1 - b2) * g * g;
          P[q] -= (lr * (M[q] / c1)) / (Math.sqrt(V[q] / c2) + 1e-8);
        }
      }
    }
    const v = evalVal();
    log(`epoch ${epoch}/${EPOCHS}  lr ${lr.toFixed(4)}  val loss ${v.loss.toFixed(4)}  val AUC ${v.auc.toFixed(4)}`);
    if (epoch - best.epoch >= 6 && v.loss >= best.loss) { log("no improvement for 6 epochs: stopping early"); break; }
    if (v.loss < best.loss) best = { loss: v.loss, auc: v.auc, W: net.W.map((w) => w.slice()), B: net.B.map((b) => b.slice()), epoch };
  }
  log(`best epoch ${best.epoch} (val loss ${best.loss.toFixed(4)}, AUC ${best.auc.toFixed(4)})`);

  const layers: Layer[] = best.W.map((w, l) => ({
    in: sizes[l], out: sizes[l + 1], act: l === best.W.length - 1 ? "sigmoid" : "relu",
    w: Array.from(w, (v) => Number(v.toFixed(6))), b: Array.from(best.B[l], (v) => Number(v.toFixed(6))),
  }));
  const model: ForecastModel = {
    version: 1, horizon: HORIZON, history: HISTORY, mean: mean.map((v) => Number(v.toFixed(6))), std: std.map((v) => Number(v.toFixed(6))), layers,
    alarm: { threshold: 0.7, debounce: 2, release: 0.5 },
    meta: { trainEpisodes: N_TRAIN, valEpisodes: N_VAL, trainSamples: tr.n, bestEpoch: best.epoch, valAuc: Number(best.auc.toFixed(4)), network: sizes.join("-"), trained: new Date().toISOString().slice(0, 10) },
  };

  // choose the alarm threshold on VALIDATION episodes: the earliest-warning setting that stays within the false-alarm budget
  log(`choosing alarm threshold on validation episodes (false-alarm budget ${FA_TARGET} per 100 zone-episodes)...`);
  let chosen = { thr: 0.95, early: -1, fa: Infinity };
  for (const thr of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    model.alarm = { threshold: thr, debounce: 2, release: Math.max(0.1, thr - 0.2) };
    const s = summarize(valEps, aiDetector(model));
    console.log(`   threshold ${thr.toFixed(2)}: warned early ${(100 * s.earlyRate).toFixed(0)}%  median lead ${s.medianLead}  false alarms ${s.falseAlarmsPer100.toFixed(1)} per 100`);
    if (s.falseAlarmsPer100 <= FA_TARGET && s.earlyRate > chosen.early) chosen = { thr, early: s.earlyRate, fa: s.falseAlarmsPer100 };
  }
  if (chosen.early < 0) chosen.thr = 0.95;
  model.alarm = { threshold: chosen.thr, debounce: 2, release: Math.max(0.1, chosen.thr - 0.2) };
  model.meta.alarmThreshold = chosen.thr;
  log(`chosen alarm threshold ${chosen.thr}`);

  const out = path.resolve(__dirname, "../shared/forecastModel.ts");
  fs.writeFileSync(out, `// GENERATED by ml/train.ts (npm run ml:train). Do not edit by hand.\nimport type { ForecastModel } from "./forecast";\n\nexport const FORECAST_MODEL: ForecastModel = ${JSON.stringify(model)};\n`);
  log(`model written to ${out}`);
}
main();
