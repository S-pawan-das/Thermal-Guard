import { ThermalSim } from "./thermal";
import { MINUTES_PER_STEP } from "../../shared/floorplan";
import type { Action, ActionResult, Cause, CauseReport, TwinResult, ZoneOutlook } from "../../shared/twinTypes";
export type { Action, ActionResult, Cause, CauseReport, TwinResult, ZoneOutlook };

/**
 * PREDICTIVE DIGITAL TWIN
 *
 * The twin is the same deterministic simulator that produces the live readings, forked at the current state and run forward.
 * So "what happens in 30 minutes" is not a statistical guess about one zone: it is the physics of the whole floor
 * (diffusion, machines, coolers, pipes between rooms) advanced from exactly where the plant is now.
 *
 *  - runTwin():          the predicted heat field at a few moments ahead + when each zone first leaves its limits.
 *  - evaluateActions():  tries every sensible intervention on a fork (stop a machine, emergency cooling, ventilate,
 *                        isolate a pipe, repair a cooler) and ranks them by how much damage they prevent.
 *  - explainCauses():    counterfactuals: re-runs the future with one cause removed at a time, so the alert can say
 *                        WHY a zone is heating and by how much each cause contributes.
 * Nothing here touches the live simulation; every function works on forks.
 */

export const MAX_TWIN_STEPS = 240;
const r1 = (v: number) => Math.round(v * 10) / 10;

export function runTwin(base: ThermalSim, steps: number, opts: { every?: number; frames?: boolean } = {}): TwinResult {
  const n = Math.min(MAX_TWIN_STEPS, Math.max(1, Math.trunc(steps)));
  const every = Math.max(1, Math.trunc(opts.every ?? Math.ceil(n / 12)));
  const f = base.fork();
  const zones = base.getZones();
  const track = zones.map((z) => ({ z, now: { max: 0, min: 0 }, peak: -Infinity, low: Infinity, endMax: 0, high: -1, lowAt: -1 }));
  const frames: TwinResult["frames"] = [];
  const snap = (k: number) => {
    const stats = new Map(f.zoneStats().map((s) => [s.id, s]));
    for (const t of track) {
      const s = stats.get(t.z.id);
      if (!s) continue;
      if (k === 0) t.now = { max: s.maxC, min: s.minC };
      if (s.maxC > t.peak) t.peak = s.maxC;
      if (s.minC < t.low) t.low = s.minC;
      if (t.high < 0 && s.maxC > t.z.maxC) t.high = k;
      if (t.lowAt < 0 && s.minC < t.z.minC) t.lowAt = k;
      t.endMax = s.maxC;
    }
    if (opts.frames !== false && (k === 0 || k % every === 0 || k === n)) frames.push({ inSteps: k, grid: f.getGrid().map(r1) });
  };
  snap(0);
  for (let k = 1; k <= n; k++) { f.tick(1); snap(k); }
  return {
    fromStep: base.step, steps: n, every, minutesPerStep: MINUTES_PER_STEP, frames,
    zones: track.map((t) => {
      const high = t.high >= 0, low = t.lowAt >= 0;
      const first = high && low ? (t.high <= t.lowAt ? "high" : "low") : high ? "high" : low ? "low" : null;
      const over = Math.max(high ? t.peak - t.z.maxC : 0, low ? t.z.minC - t.low : 0);
      return {
        id: t.z.id, name: t.z.name, limitMinC: t.z.minC, limitMaxC: t.z.maxC,
        nowMaxC: r1(t.now.max), nowMinC: r1(t.now.min), peakC: r1(t.peak), lowC: r1(t.low), endMaxC: r1(t.endMax),
        breach: first === "high" ? { kind: "high", inSteps: t.high } : first === "low" ? { kind: "low", inSteps: t.lowAt } : null,
        overshootC: r1(Math.max(0, over)),
      };
    }),
  };
}

/** One number for "how bad is this future": every zone that leaves its limits costs a lot, more the deeper and the sooner. */
export function harmOf(r: TwinResult): number {
  let h = 0;
  for (const z of r.zones) if (z.breach) h += 20 + z.overshootC * 2 + ((r.steps - z.breach.inSteps) / r.steps) * 10;
  return Math.round(h * 10) / 10;
}

// ---------------------------------------------------------------------------------------------------------------
// What-if actions
// ---------------------------------------------------------------------------------------------------------------
export const actionKey = (a: Action): string =>
  a.kind === "stop-source" ? `stop:${a.sourceId}` : a.kind === "isolate-link" ? `isolate:${a.linkId}` : `${a.kind}:${a.zoneId}`;

/** Apply an action to a simulation (a fork for what-if, the live sim for "Apply"). Returns false if it does not apply. */
export function applyAction(sim: ThermalSim, a: Action): boolean {
  switch (a.kind) {
    case "stop-source": return sim.stopSource(a.sourceId);
    case "isolate-link": return sim.setLinkClosed(a.linkId, true);
    case "repair-cooler": return sim.repairCooler(a.zoneId);
    case "cooling": sim.addActuator({ id: `cool-${a.zoneId}`, zoneId: a.zoneId, kind: "cooling", targetC: a.targetC, strength: a.strength }); return true;
    case "vent": sim.addActuator({ id: `vent-${a.zoneId}`, zoneId: a.zoneId, kind: "vent", targetC: sim.ambientC, strength: a.strength }); return true;
  }
}

export function describeAction(sim: ThermalSim, a: Action): string {
  const zone = (id: string) => sim.getZones().find((z) => z.id === id)?.name ?? id;
  switch (a.kind) {
    case "stop-source": {
      const s = sim.allSources().find((x) => x.id === a.sourceId);
      return `Stop ${s?.name ?? (s?.zoneId ? `the fire in ${zone(s.zoneId)}` : a.sourceId)}`;
    }
    case "isolate-link": {
      const l = sim.getLinks().find((x) => x.id === a.linkId);
      return l ? `Isolate the ${l.kind} between ${zone(l.a)} and ${zone(l.b)}` : "Isolate a link";
    }
    case "repair-cooler": return `Restore the cooler in ${zone(a.zoneId)}`;
    case "cooling": return `Emergency cooling in ${zone(a.zoneId)} (to ${r1(a.targetC)} °C)`;
    case "vent": return `Ventilate ${zone(a.zoneId)} with outside air`;
  }
}

/** The interventions worth trying right now: only things that exist and relate to a zone that is hot, at risk or involved. */
export function candidateActions(sim: ThermalSim, base: TwinResult): Action[] {
  const out: Action[] = [];
  const risky = new Set<string>();
  const atRisk = (z: ZoneOutlook) => z.breach !== null || z.peakC > z.limitMaxC - 3 || z.nowMaxC > z.limitMaxC - 3;
  for (const z of base.zones) if (atRisk(z)) risky.add(z.id);
  for (const s of sim.activeSources()) out.push({ kind: "stop-source", sourceId: s.id });
  for (const z of sim.getZones()) {
    if (sim.hasFailedCooler(z.id)) out.push({ kind: "repair-cooler", zoneId: z.id });
    if (!risky.has(z.id)) continue;
    const range = z.maxC - z.minC;
    const target = Math.max(z.minC + z.warnMarginC + 0.5, z.maxC - range * 0.45);
    out.push({ kind: "cooling", zoneId: z.id, targetC: target, strength: 0.12 });
    out.push({ kind: "vent", zoneId: z.id, strength: 0.06 });
  }
  for (const l of sim.getLinks()) if (!sim.isLinkClosed(l.id) && (risky.has(l.a) || risky.has(l.b))) out.push({ kind: "isolate-link", linkId: l.id });
  return out;
}

export function evaluateActions(sim: ThermalSim, steps: number): { baseline: TwinResult; results: ActionResult[] } {
  const baseline = runTwin(sim, steps, { frames: false });
  const harmBefore = harmOf(baseline);
  const results: ActionResult[] = [];
  const breaching = baseline.zones.filter((z) => z.breach);
  const peakBefore = breaching.length ? Math.max(...breaching.map((z) => z.peakC)) : null;
  for (const action of candidateActions(sim, baseline)) {
    const f = sim.fork();
    if (!applyAction(f, action)) continue;
    const after = runTwin(f, steps, { frames: false });
    const harmAfter = harmOf(after);
    const afterBy = new Map(after.zones.map((z) => [z.id, z]));
    const prevents = breaching.filter((z) => !afterBy.get(z.id)?.breach).map((z) => z.name);
    const still = after.zones.filter((z) => z.breach).map((z) => z.name);
    const worstAfter = breaching.length ? Math.max(...breaching.map((z) => afterBy.get(z.id)?.peakC ?? z.peakC)) : null;
    let bought: string;
    if (!breaching.length) bought = "No zone is predicted to leave its limits, so this changes nothing important.";
    else if (prevents.length === breaching.length) bought = `Keeps ${prevents.join(", ")} inside the limits for the whole ${steps * MINUTES_PER_STEP} minutes.`;
    else if (prevents.length) bought = `Saves ${prevents.join(", ")}; ${still.join(", ")} still ${still.length > 1 ? "go" : "goes"} out of range.`;
    else {
      const delayed = breaching.map((z) => ({ z, a: afterBy.get(z.id)?.breach })).filter((x) => x.a && x.z.breach && x.a.inSteps > x.z.breach.inSteps);
      bought = delayed.length
        ? `Does not prevent the breach but delays it by up to ${Math.max(...delayed.map((x) => (x.a!.inSteps - x.z.breach!.inSteps) * MINUTES_PER_STEP))} min.`
        : "Makes little difference.";
    }
    results.push({
      action, key: actionKey(action), label: describeAction(sim, action), harmBefore, harmAfter, prevents, stillBreaching: still, bought,
      worstPeakBefore: peakBefore, worstPeakAfter: worstAfter, score: Math.round((harmBefore - harmAfter) * 10) / 10,
    });
  }
  results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return { baseline, results };
}

// ---------------------------------------------------------------------------------------------------------------
// Root cause: counterfactuals
// ---------------------------------------------------------------------------------------------------------------
export function explainCauses(sim: ThermalSim, zoneId: string, steps: number, base?: TwinResult): CauseReport | null {
  const zone = sim.getZones().find((z) => z.id === zoneId);
  if (!zone) return null;
  const baseline = base ?? runTwin(sim, steps, { frames: false });
  const own = baseline.zones.find((z) => z.id === zoneId)!;
  const side: "high" | "low" = own.breach?.kind === "low" ? "low" : "high";
  const metric = (r: TwinResult) => { const z = r.zones.find((q) => q.id === zoneId)!; return side === "high" ? z.peakC : -z.lowC; };
  const m0 = metric(baseline);
  const tests: { kind: Cause["kind"]; id: string; label: string; mutate: (f: ThermalSim) => void }[] = [];
  for (const s of sim.activeSources())
    tests.push({ kind: "source", id: s.id, label: s.name ?? (s.zoneId ? `Fire in ${sim.getZones().find((z) => z.id === s.zoneId)?.name ?? s.zoneId}` : s.id), mutate: (f) => { f.stopSource(s.id); } });
  if (sim.hasFailedCooler(zoneId)) tests.push({ kind: "cooler", id: zoneId, label: `Failed cooler in ${zone.name}`, mutate: (f) => { f.repairCooler(zoneId); } });
  for (const l of sim.getLinks()) {
    if (sim.isLinkClosed(l.id) || (l.a !== zoneId && l.b !== zoneId)) continue;
    const other = sim.getZones().find((z) => z.id === (l.a === zoneId ? l.b : l.a));
    tests.push({ kind: "link", id: l.id, label: `Heat arriving through the ${l.kind} from ${other?.name ?? "a connected zone"}`, mutate: (f) => { f.setLinkClosed(l.id, true); } });
  }
  const raw: Cause[] = [];
  for (const t of tests) {
    const f = sim.fork();
    t.mutate(f);
    const d = m0 - metric(runTwin(f, steps, { frames: false }));
    if (d >= 0.15) raw.push({ kind: t.kind, id: t.id, label: t.label, reducesByC: r1(d), sharePct: 0 });
  }
  raw.sort((a, b) => b.reducesByC - a.reducesByC);
  const total = raw.reduce((s, c) => s + c.reducesByC, 0);
  for (const c of raw) c.sharePct = total > 0 ? Math.round((c.reducesByC / total) * 100) : 0;
  const causes = raw.slice(0, 4);
  const summary = causes.length
    ? `Main cause: ${causes[0].label} (${causes[0].sharePct}% of the removable heat; without it the worst cell would be ${causes[0].reducesByC} °C ${side === "high" ? "cooler" : "warmer"}).`
    : "No single machine, cooler fault or connection explains it; the zone is drifting on its own (ambient exchange or nearby heat).";
  return { zoneId, zoneName: zone.name, side, peakC: side === "high" ? own.peakC : own.lowC, causes, summary };
}

/** Validates an action coming from the HTTP API against the live simulation. */
export function parseAction(body: unknown, sim: ThermalSim): { ok: true; action: Action } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Action must be a JSON object.");
  const b = body as Record<string, unknown>;
  const zoneOk = (v: unknown) => typeof v === "string" && sim.getZones().some((z) => z.id === v);
  const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  switch (b.kind) {
    case "stop-source":
      return typeof b.sourceId === "string" && sim.allSources().some((s) => s.id === b.sourceId) ? { ok: true, action: { kind: "stop-source", sourceId: b.sourceId } } : bad("Unknown heat source.");
    case "isolate-link":
      return typeof b.linkId === "string" && sim.getLinks().some((l) => l.id === b.linkId) ? { ok: true, action: { kind: "isolate-link", linkId: b.linkId } } : bad("Unknown link.");
    case "repair-cooler":
      return zoneOk(b.zoneId) ? { ok: true, action: { kind: "repair-cooler", zoneId: b.zoneId as string } } : bad("Unknown zone.");
    case "cooling":
      return zoneOk(b.zoneId) && num(b.targetC, -100, 1000) && num(b.strength, 0, 0.5) ? { ok: true, action: { kind: "cooling", zoneId: b.zoneId as string, targetC: b.targetC as number, strength: b.strength as number } } : bad("Invalid cooling action.");
    case "vent":
      return zoneOk(b.zoneId) && num(b.strength, 0, 0.5) ? { ok: true, action: { kind: "vent", zoneId: b.zoneId as string, strength: b.strength as number } } : bad("Invalid ventilation action.");
    default: return bad("Unknown action kind.");
  }
}
