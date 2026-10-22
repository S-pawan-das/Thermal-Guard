import type { MachineStatus } from "../../shared/types";
import { MINUTES_PER_STEP } from "../../shared/floorplan";
import { HeatSource, ThermalSim } from "./thermal";

/**
 * MACHINE-CYCLE MONITOR  (learned pattern, not a threshold)
 *
 * Every machine warms its surroundings in a repeatable way after it starts: "+10 °C in 30 minutes". The monitor learns that
 * rise-versus-minutes curve for each machine (mean and spread per minute, from earlier cycles) and then watches every new cycle
 * against it, minute by minute, long before any temperature limit is near:
 *   - rising SLOWER than usual  -> the machine is delivering less than before: repair / efficiency problem (warning)
 *   - rising FASTER than usual  -> something is wrong (lost cooling, runaway load): keep it under surveillance, stop it (critical)
 * A deviation counts only after it has lasted DEBOUNCE minutes, and it is cleared the same way, so noise does not flap the alert.
 *
 * Probe: the average of the 3x3 cells around the machine (what a temperature probe mounted on it would read).
 * Time: one engine step = MINUTES_PER_STEP minutes of factory time.
 * Learning: runs are added to the profile while it is young (< MIN_CYCLES), afterwards only runs judged normal are, so a failing
 * machine can never teach the monitor that failing is normal. trainFromHistory() seeds the profile from several simulated past
 * cycles (with realistic wear-and-load variation) so the monitor is useful immediately.
 */
export const CYCLE_WINDOW = 30; // minutes of the learned curve
export const MIN_CYCLES = 2; // cycles needed before verdicts are given
export const MIN_MINUTE = 5; // no verdict before this minute of a cycle
export const DEBOUNCE = 3; // consecutive minutes a deviation (or recovery) must last
const r1 = (v: number) => Math.round(v * 10) / 10;

interface Profile {
  cycles: number;
  mean: number[]; // index = minute 0..CYCLE_WINDOW
  m2: number[]; // Welford sum of squares
}
type Verdict = MachineStatus["verdict"];
interface Run {
  startStep: number;
  startTemp: number;
  rise: number[]; // observed rise per minute index (NaN = not seen)
  verdict: Verdict;
  streak: number; // consecutive minutes disagreeing with the current verdict
  candidate: Verdict;
  finished: boolean;
  lastMinute: number;
}

export interface MachineCondition {
  machineId: string;
  name: string;
  zoneId: string | undefined;
  verdict: "underperform" | "overshoot";
  minute: number;
  riseC: number;
  expectedC: number;
  usualC: number;
  projectedC: number;
  ratioPct: number;
  cycles: number;
}

const emptyProfile = (): Profile => ({ cycles: 0, mean: new Array(CYCLE_WINDOW + 1).fill(0), m2: new Array(CYCLE_WINDOW + 1).fill(0) });
const sdOf = (p: Profile, m: number) => (p.cycles > 1 ? Math.sqrt(p.m2[m] / (p.cycles - 1)) : 0);
/** Allowed deviation at minute m: 2.5 spread widths, at least 20 % of the expected rise, at least 0.6 °C. */
export const bandAt = (p: Profile, m: number) => Math.max(2.5 * sdOf(p, m), 0.2 * p.mean[m], 0.6);

function addToProfile(p: Profile, curve: number[]) {
  p.cycles++;
  for (let m = 0; m <= CYCLE_WINDOW; m++) {
    const x = Number.isFinite(curve[m]) ? curve[m] : p.mean[m];
    const d = x - p.mean[m];
    p.mean[m] += d / p.cycles;
    p.m2[m] += d * (x - p.mean[m]);
  }
}

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class CycleMonitor {
  private profiles = new Map<string, Profile>();
  private runs = new Map<string, Run>();
  private names = new Map<string, { name: string; zoneId?: string; zoneName?: string }>();

  /** Forget the current cycles (after a reset / new scenario) but keep what was learned. */
  resetRuns(): void { this.runs.clear(); }
  forgetAll(): void { this.profiles.clear(); this.runs.clear(); this.names.clear(); }
  profileCount(): number { return this.profiles.size; }

  /** Call once after every engine step. */
  observe(sim: ThermalSim): void {
    for (const s of sim.allSources()) {
      if (s.zoneId !== undefined) continue; // fires / incidents are not machines
      const key = s.machineId ?? s.id;
      const cell = sim.cellOfSource(s);
      if (cell < 0) continue;
      const active = sim.step > s.startStep && (s.endStep === null || sim.step <= s.endStep);
      const zi = sim.zoneIndexAt(cell);
      const zone = zi >= 0 ? sim.getZones()[zi] : undefined;
      this.names.set(key, { name: s.name ?? key, zoneId: zone?.id, zoneName: zone?.name });
      const local = sim.localTemp(cell);
      let run = this.runs.get(key);
      if (active && (!run || run.startStep !== s.startStep)) {
        // first sample of a new cycle: the temperature one step ago is the "before" reading
        run = { startStep: s.startStep, startTemp: this.before.get(key) ?? local, rise: new Array(CYCLE_WINDOW + 1).fill(NaN), verdict: "learning", streak: 0, candidate: "learning", finished: false, lastMinute: 0 };
        run.rise[0] = 0;
        this.runs.set(key, run);
      }
      this.before.set(key, local);
      if (!run || run.finished || !active) continue;
      const m = Math.round((sim.step - run.startStep) * MINUTES_PER_STEP);
      if (m < 1 || m > CYCLE_WINDOW) { if (m > CYCLE_WINDOW) this.finish(key, run); continue; }
      run.rise[m] = local - run.startTemp;
      run.lastMinute = m;
      this.judge(key, run, m);
      if (m >= CYCLE_WINDOW) this.finish(key, run);
    }
    // a machine switched off mid-cycle: keep what we saw, but never learn from a partial cycle
    for (const [key, run] of this.runs) {
      const s = sim.allSources().find((x) => (x.machineId ?? x.id) === key && x.startStep === run.startStep);
      if (!s || (s.endStep !== null && sim.step > s.endStep)) run.finished = true;
    }
  }
  private before = new Map<string, number>();

  private judge(key: string, run: Run, m: number): void {
    const p = this.profiles.get(key);
    if (!p || p.cycles < MIN_CYCLES) { run.verdict = "learning"; return; }
    if (m < MIN_MINUTE || p.mean[m] < 1) return;
    const obs = run.rise[m], exp = p.mean[m], band = bandAt(p, m);
    const now: Verdict = obs < exp - band ? "underperform" : obs > exp + band ? "overshoot" : "normal";
    if (run.verdict === "learning") { run.verdict = "normal"; run.candidate = "normal"; }
    if (now === run.verdict) { run.streak = 0; run.candidate = run.verdict; return; }
    if (now === run.candidate) run.streak++; else { run.candidate = now; run.streak = 1; }
    if (run.streak >= DEBOUNCE) { run.verdict = now; run.streak = 0; }
  }

  private finish(key: string, run: Run): void {
    run.finished = true;
    if (run.lastMinute < CYCLE_WINDOW) return; // partial cycle: not used for learning
    let p = this.profiles.get(key);
    if (!p) { p = emptyProfile(); this.profiles.set(key, p); }
    if (p.cycles < MIN_CYCLES || run.verdict === "normal") addToProfile(p, run.rise);
  }

  /**
   * Seed every machine's profile from `days` simulated earlier cycles: the same plant started from cold with each machine
   * running at an efficiency drawn from 0.95-1.05 (wear and load vary a little from day to day).
   */
  trainFromHistory(sim: ThermalSim, days = 5, seed = 11): number {
    const machines = sim.allSources().filter((s) => s.zoneId === undefined);
    if (!machines.length) return 0;
    const rnd = mulberry32(seed);
    const base = sim.getScenario();
    const learned = new Map<string, Profile>();
    for (let d = 0; d < days; d++) {
      const sources: HeatSource[] = machines.map((s) => ({ ...s, startStep: 0, endStep: null, efficiency: 0.95 + 0.1 * rnd() }));
      const t = new ThermalSim({ ...base, sources, failures: [] }, sim.getZones());
      t.setLinks(sim.getLinks());
      const mon = new CycleMonitor();
      mon.observe(t); // the reading before anything starts
      for (let k = 0; k < CYCLE_WINDOW + 1; k++) { t.tick(1); mon.observe(t); }
      for (const [key, run] of mon.runs) {
        if (run.lastMinute < CYCLE_WINDOW) continue;
        let p = learned.get(key);
        if (!p) { p = emptyProfile(); learned.set(key, p); }
        addToProfile(p, run.rise);
      }
    }
    for (const [key, p] of learned) this.profiles.set(key, p);
    return learned.size;
  }

  statuses(sim: ThermalSim): MachineStatus[] {
    const out: MachineStatus[] = [];
    const activeKeys = new Set(sim.activeSources().map((s) => s.machineKey));
    for (const [key, run] of this.runs) {
      const meta = this.names.get(key);
      const p = this.profiles.get(key);
      const ready = !!p && p.cycles >= MIN_CYCLES;
      const m = run.lastMinute;
      const expected = ready && m >= 1 ? p!.mean[m] : null;
      const rise = Number.isFinite(run.rise[m]) ? run.rise[m] : 0;
      const usual = ready ? p!.mean[CYCLE_WINDOW] : null;
      const projected = ready && expected !== null && expected >= 1 && usual !== null ? rise * (usual / expected) : null;
      out.push({
        id: key, name: meta?.name ?? key, zoneId: meta?.zoneId, running: activeKeys.has(key) && !run.finished, minute: m, window: CYCLE_WINDOW,
        riseC: r1(rise), expectedC: expected === null ? null : r1(expected), bandC: expected === null ? null : r1(bandAt(p!, m)),
        projectedC: projected === null ? null : r1(projected), usualC: usual === null ? null : r1(usual), cycles: p?.cycles ?? 0,
        verdict: ready ? (run.verdict === "learning" ? "normal" : run.verdict) : "learning",
        curve: ready ? p!.mean.map((mean, i) => ({ m: i, mean: r1(mean), sd: r1(bandAt(p!, i)) })).filter((_, i) => i % 2 === 0 || i === CYCLE_WINDOW) : [],
        actual: run.rise.map((v, i) => ({ m: i, v: r1(v) })).filter((x) => Number.isFinite(x.v)),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Machines whose current cycle is judged abnormal, for the alert engine. */
  conditions(sim: ThermalSim): MachineCondition[] {
    const out: MachineCondition[] = [];
    for (const st of this.statuses(sim)) {
      if (st.verdict !== "underperform" && st.verdict !== "overshoot") continue;
      const run = this.runs.get(st.id)!;
      if (!st.running && run.finished && run.lastMinute < CYCLE_WINDOW) continue; // switched off: the problem is handled
      out.push({
        machineId: st.id, name: st.name, zoneId: st.zoneId, verdict: st.verdict, minute: st.minute, riseC: st.riseC,
        expectedC: st.expectedC ?? 0, usualC: st.usualC ?? 0, projectedC: st.projectedC ?? st.riseC,
        ratioPct: st.expectedC ? Math.round((st.riseC / st.expectedC) * 100) : 100, cycles: st.cycles,
      });
    }
    return out;
  }
}
