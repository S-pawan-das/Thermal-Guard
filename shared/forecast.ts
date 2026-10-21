import type { ZoneLimits } from "./types";

/**
 * EARLY-WARNING FORECASTER (shared by the server and by the training/evaluation scripts in /ml, so the model
 * behaves exactly the same in training, in tests and live).
 *
 * Question the model answers, for ONE zone, every simulation step:
 *   "Will this zone go out of its limits (critical) within the next HORIZON steps?"
 * Inputs: only what a real sensor system would have: the zone's recent coldest / hottest / average reading
 * (last HISTORY steps) and the zone's own limits. It does not see the simulator, fires or failures.
 * Output: a risk between 0 and 1. The alarm turns on when the risk stays at/above a threshold chosen on validation data.
 */
export const HISTORY = 48; // steps of history kept per zone
export const HORIZON = 30; // look-ahead in simulation steps
export const MIN_HISTORY = 13; // below this many readings the model stays quiet (its trend lines need a few points)
export const FEATURE_COUNT = 28;

export interface Reading { avg: number; min: number; max: number }
export type LimitsLike = Pick<ZoneLimits, "type" | "minC" | "maxC" | "warnMarginC">;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Least-squares slope (°C per step) of the `w` values that end `back` steps before the newest one; 0 if fewer than 3 points exist. */
function slopeOf(y: readonly number[], w: number, back = 0): number {
  const end = y.length - back, start = Math.max(0, end - w), k = end - start;
  if (k < 3) return 0;
  let sy = 0;
  for (let i = start; i < end; i++) sy += y[i];
  const my = sy / k, mx = (k - 1) / 2;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < k; i++) { sxy += (i - mx) * (y[start + i] - my); sxx += (i - mx) * (i - mx); }
  return sxy / sxx;
}
/** Spread of the readings around their own straight line over the last `w` steps: a noise estimate. */
function residualStd(y: readonly number[], w: number): number {
  const end = y.length, start = Math.max(0, end - w), k = end - start;
  if (k < 4) return 0;
  const sl = slopeOf(y, w);
  let my = 0;
  for (let i = start; i < end; i++) my += y[i] / k;
  const mx = (k - 1) / 2;
  let ss = 0;
  for (let i = 0; i < k; i++) { const e = y[start + i] - (my + sl * (i - mx)); ss += e * e; }
  return Math.sqrt(ss / (k - 2));
}

/** hist = oldest .. newest (any length >= 1; windows simply use the readings that exist). */
export function featurize(hist: readonly Reading[], l: LimitsLike): number[] {
  const mx = hist.map((r) => r.max), mn = hist.map((r) => r.min), av = hist.map((r) => r.avg);
  const cur = hist[hist.length - 1];
  const range = Math.max(1e-6, l.maxC - l.minC);
  const scaled = (v: number) => clamp((v * HORIZON) / range, -5, 5); // change over the horizon, as a fraction of the zone's range
  const hiGap = l.maxC - cur.max, loGap = cur.min - l.minC;
  const sMax24 = slopeOf(mx, 24), sMin24 = slopeOf(mn, 24);
  const etaHi = sMax24 > 1e-3 ? clamp(hiGap / sMax24 / HORIZON, 0, 4) : 4; // straight-line time to the max limit, in horizons
  const etaLo = sMin24 < -1e-3 ? clamp(loGap / -sMin24 / HORIZON, 0, 4) : 4;
  const spread = hist.map((r) => r.max - r.min);
  return [
    clamp(hiGap / range, -1, 3), clamp(loGap / range, -1, 3), clamp((cur.avg - l.minC) / range, -1, 3),
    scaled(slopeOf(mx, 6)), scaled(slopeOf(mx, 12)), scaled(sMax24), scaled(slopeOf(mx, 48)),
    scaled(slopeOf(mn, 6)), scaled(slopeOf(mn, 12)), scaled(sMin24), scaled(slopeOf(mn, 48)),
    scaled(slopeOf(av, 6)), scaled(slopeOf(av, 12)), scaled(slopeOf(av, 24)), scaled(slopeOf(av, 48)),
    scaled(slopeOf(mx, 12) - slopeOf(mx, 12, 12)), scaled(slopeOf(mn, 12) - slopeOf(mn, 12, 12)), // acceleration
    clamp((cur.max - cur.min) / range, 0, 5), scaled(slopeOf(spread, 12)),
    clamp(residualStd(mx, 12) / range, 0, 1), clamp(residualStd(mn, 12) / range, 0, 1), // how noisy the readings are
    etaHi, etaLo,
    l.warnMarginC / range, clamp(range / 40, 0, 3),
    l.type === "cold-storage" ? 1 : 0, l.type === "hot-process" ? 1 : 0, l.type === "general" ? 1 : 0,
  ];
}

export interface Layer { in: number; out: number; w: number[]; b: number[]; act: "relu" | "sigmoid" } // w is out x in, row-major
export interface ForecastModel {
  version: 1;
  horizon: number;
  history: number;
  mean: number[];
  std: number[];
  layers: Layer[];
  alarm: { threshold: number; debounce: number; release: number }; // risk >= threshold for `debounce` steps turns the alarm on; below `release` turns it off
  meta: Record<string, string | number>;
}

export function predictRisk(m: ForecastModel, x: number[]): number {
  let a = x.map((v, i) => (v - m.mean[i]) / Math.max(1e-6, m.std[i]));
  for (const L of m.layers) {
    const out = new Array<number>(L.out);
    for (let o = 0; o < L.out; o++) {
      let s = L.b[o];
      const base = o * L.in;
      for (let i = 0; i < L.in; i++) s += L.w[base + i] * a[i];
      out[o] = L.act === "relu" ? (s > 0 ? s : 0) : 1 / (1 + Math.exp(-s));
    }
    a = out;
  }
  const r = a[0];
  return Number.isFinite(r) ? clamp(r, 0, 1) : 0;
}

export interface ForecastResult { risk: number; alert: boolean; horizon: number }
const isCritical = (r: Reading, l: LimitsLike) => r.min < l.minC || r.max > l.maxC;

/** Keeps each zone's recent history and alarm state. Feed it ONE reading per zone per simulation step. */
export class Forecaster {
  private hist = new Map<string, Reading[]>();
  private state = new Map<string, { run: number; on: boolean; sig: string }>();
  constructor(private model: ForecastModel) {}

  get horizon() { return this.model.horizon; }
  reset(): void { this.hist.clear(); this.state.clear(); }

  observe(id: string, r: Reading, l: LimitsLike): ForecastResult {
    const sig = `${l.type}|${l.minC}|${l.maxC}|${l.warnMarginC}`;
    let st = this.state.get(id);
    if (!st || st.sig !== sig) { st = { run: 0, on: false, sig }; this.state.set(id, st); this.hist.set(id, []); } // limits edited: start fresh
    const h = this.hist.get(id)!;
    h.push(r);
    if (h.length > this.model.history) h.shift();

    if (isCritical(r, l)) { st.run = this.model.alarm.debounce; st.on = true; return { risk: 1, alert: true, horizon: this.model.horizon }; } // already out of range
    if (h.length < MIN_HISTORY) return { risk: 0, alert: false, horizon: this.model.horizon };
    const risk = predictRisk(this.model, featurize(h, l));
    const { threshold, debounce, release } = this.model.alarm;
    if (risk >= threshold) { st.run++; if (st.run >= debounce) st.on = true; }
    else { st.run = 0; if (risk < release) st.on = false; }
    return { risk, alert: st.on, horizon: this.model.horizon };
  }
}
