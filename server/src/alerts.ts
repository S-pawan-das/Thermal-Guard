import type { AlertKind, AlertRecord, AlertSeverity, Zone } from "../../shared/types";

/**
 * ALERT ENGINE (server-authoritative; reads only real simulated readings).
 *
 * For every zone it watches two independent sides with the SAME rule:
 *   high: reading = hottest cell,  margin m = maxC - reading
 *   low : reading = coldest cell,  margin m = reading - minC
 *   m < 0          -> critical (a limit is crossed; exactly at the limit is still allowed)
 *   m < warnMarginC -> warning  (approaching the limit)
 * Hysteresis (h): once raised, a level is only left when m improves by h more:
 *   critical -> warning/normal needs m >= h;  warning -> normal needs m >= warnMarginC + h.
 * Deduplication: one alert per (zone, side, severity) at a time; repeated identical readings change nothing.
 * Cooldown: if the same (zone, side, severity) alert recovered less than cooldownMs ago, it is RE-OPENED
 * (same id, occurrences + 1) instead of adding a new row to the feed.
 * Events: created, reopened, resolved. Reading/peak updates are kept quietly and only sent with the next event.
 */
export interface AlertConfig { hysteresisC: number; cooldownMs: number; maxHistory: number }
export const DEFAULT_ALERT_CONFIG: AlertConfig = { hysteresisC: 0.3, cooldownMs: 60_000, maxHistory: 500 };
export type AlertChange = { type: "created" | "reopened" | "resolved"; alert: AlertRecord };
type Level = 0 | 1 | 2;

const fin = (...v: unknown[]) => v.every((x) => typeof x === "number" && Number.isFinite(x));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Pure rule, exported for tests. m = distance to the limit (positive = safe side). */
export function nextLevel(prev: Level, m: number, warn: number, h: number): Level {
  if (m < 0) return 2;
  if (prev === 2) return m < h ? 2 : m < warn + h ? 1 : 0;
  if (prev === 1) return m < warn + h ? 1 : 0;
  return m < warn ? 1 : 0;
}

export class AlertEngine {
  private alerts: AlertRecord[] = []; // oldest first
  private level = new Map<string, Level>();
  private seq = 0;
  constructor(private cfg: AlertConfig = DEFAULT_ALERT_CONFIG, private now: () => number = Date.now) {}

  list(): AlertRecord[] { return this.alerts; }
  active(): AlertRecord[] { return this.alerts.filter((a) => a.status === "active"); }
  /** All active alerts plus the most recent history, newest first. */
  recent(limit = 100): AlertRecord[] {
    const sorted = [...this.alerts].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? 1 : -1));
    const keep = new Set(sorted.slice(0, limit));
    for (const a of sorted) if (a.status === "active") keep.add(a);
    return sorted.filter((a) => keep.has(a));
  }

  /** Restore saved history. Alerts that were active when the server stopped are closed ("server restart"). */
  load(history: unknown): void {
    this.alerts = [];
    this.level.clear();
    if (!Array.isArray(history)) return;
    const iso = new Date(this.now()).toISOString();
    for (const h of history) {
      const a = h as Partial<AlertRecord> | null;
      if (!a || typeof a !== "object" || typeof a.id !== "string" || typeof a.zoneId !== "string" || typeof a.zoneName !== "string") continue;
      if ((a.kind !== "high" && a.kind !== "low") || (a.severity !== "warning" && a.severity !== "critical")) continue;
      if (!fin(a.readingC, a.peakC, a.limitC) || typeof a.startedAt !== "string" || typeof a.reason !== "string") continue;
      const wasActive = a.status === "active";
      this.alerts.push({
        id: a.id, zoneId: a.zoneId, zoneName: a.zoneName, kind: a.kind, severity: a.severity, reason: a.reason.slice(0, 300),
        readingC: a.readingC as number, peakC: a.peakC as number, limitC: a.limitC as number, startedAt: a.startedAt,
        status: "resolved", updatedAt: wasActive ? iso : typeof a.updatedAt === "string" ? a.updatedAt : a.startedAt,
        resolvedAt: wasActive ? iso : typeof a.resolvedAt === "string" ? a.resolvedAt : a.startedAt,
        resolution: wasActive ? "server restart" : a.resolution ?? "recovered",
        occurrences: Number.isInteger(a.occurrences) && (a.occurrences as number) > 0 ? (a.occurrences as number) : 1,
      });
      const n = Number(a.id.replace(/^A-/, ""));
      if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
    }
    this.alerts = this.alerts.slice(-this.cfg.maxHistory);
  }

  /** Evaluate the live zone readings. Returns only what changed. Zones with invalid numbers are skipped. */
  evaluate(zones: Zone[]): AlertChange[] {
    const out: AlertChange[] = [];
    const present = new Set<string>();
    for (const z of zones) {
      present.add(z.id);
      if (!fin(z.minC, z.maxC, z.warnMarginC, z.minCellC, z.maxCellC) || z.minC >= z.maxC || z.warnMarginC < 0) continue;
      this.check(z, "high", z.maxC - z.maxCellC, z.maxCellC, z.maxC, out);
      this.check(z, "low", z.minCellC - z.minC, z.minCellC, z.minC, out);
    }
    for (const a of this.active()) if (!present.has(a.zoneId)) this.resolve(a, "zone removed", out);
    for (const key of [...this.level.keys()]) if (!present.has(key.split(":")[0])) this.level.delete(key);
    return out;
  }

  /** Close every active alert (history is kept) and forget the per-zone state, e.g. after a scenario reset. */
  resolveAll(resolution: "scenario reset" | "zone removed"): AlertChange[] {
    const out: AlertChange[] = [];
    for (const a of this.active()) this.resolve(a, resolution, out);
    this.level.clear();
    return out;
  }

  /** Delete resolved alerts. Active alerts stay. Returns how many were removed. */
  clearHistory(): number {
    const before = this.alerts.length;
    this.alerts = this.alerts.filter((a) => a.status === "active");
    return before - this.alerts.length;
  }

  private check(z: Zone, kind: AlertKind, m: number, reading: number, limit: number, out: AlertChange[]): void {
    const key = `${z.id}:${kind}`;
    const prev = this.level.get(key) ?? 0;
    const lvl = nextLevel(prev, m, z.warnMarginC, this.cfg.hysteresisC);
    const act = this.alerts.find((a) => a.status === "active" && a.zoneId === z.id && a.kind === kind);
    if (act && (kind === "high" ? reading > act.peakC : reading < act.peakC)) act.peakC = reading;
    if (lvl === prev) return;
    this.level.set(key, lvl);
    if (act) this.resolve(act, lvl > prev ? "escalated" : "recovered", out);
    if (lvl > 0) this.open(z, kind, lvl === 2 ? "critical" : "warning", reading, limit, out);
  }

  private reason(kind: AlertKind, sev: AlertSeverity, reading: number, limit: number, warn: number): string {
    const side = kind === "high" ? "Hottest" : "Coldest";
    if (sev === "critical") return `${side} cell reads ${r1(reading)} °C, ${kind === "high" ? "above" : "below"} the ${limit} °C ${kind === "high" ? "maximum" : "minimum"}.`;
    return `${side} cell reads ${r1(reading)} °C, within ${warn} °C of the ${limit} °C ${kind === "high" ? "maximum" : "minimum"}.`;
  }

  private open(z: Zone, kind: AlertKind, severity: AlertSeverity, reading: number, limit: number, out: AlertChange[]): void {
    const nowMs = this.now(), iso = new Date(nowMs).toISOString();
    const reason = this.reason(kind, severity, reading, limit, z.warnMarginC);
    const old = this.alerts.find((a) =>
      a.status === "resolved" && a.zoneId === z.id && a.kind === kind && a.severity === severity &&
      (a.resolution === "recovered" || a.resolution === "escalated") && a.resolvedAt !== null && nowMs - Date.parse(a.resolvedAt) < this.cfg.cooldownMs);
    if (old) {
      Object.assign(old, { status: "active", resolvedAt: null, resolution: null, updatedAt: iso, occurrences: old.occurrences + 1, readingC: reading, peakC: reading, reason, zoneName: z.name, limitC: limit });
      out.push({ type: "reopened", alert: old });
      return;
    }
    const a: AlertRecord = {
      id: `A-${String(++this.seq).padStart(6, "0")}`, zoneId: z.id, zoneName: z.name, kind, severity, status: "active", reason,
      readingC: reading, peakC: reading, limitC: limit, startedAt: iso, updatedAt: iso, resolvedAt: null, resolution: null, occurrences: 1,
    };
    this.alerts.push(a);
    while (this.alerts.length > this.cfg.maxHistory) { // drop the oldest resolved alert first
      const i = this.alerts.findIndex((x) => x.status === "resolved");
      this.alerts.splice(i < 0 ? 0 : i, 1);
    }
    out.push({ type: "created", alert: a });
  }

  private resolve(a: AlertRecord, resolution: NonNullable<AlertRecord["resolution"]>, out: AlertChange[]): void {
    const iso = new Date(this.now()).toISOString();
    Object.assign(a, { status: "resolved", resolvedAt: iso, updatedAt: iso, resolution });
    out.push({ type: "resolved", alert: a });
  }
}
