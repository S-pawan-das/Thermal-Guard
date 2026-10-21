import { Forecaster, HORIZON, MIN_HISTORY, type ForecastModel } from "../shared/forecast";
import type { Episode } from "./episodes";

/**
 * SCORING RULES (used for validation while training AND for the final held-out test, so they cannot drift apart).
 * Every detector sees only the noisy readings (`ep.seen`). Ground truth is the real, noise-free state (`ep.critical`).
 *
 *  - Breach: the first step where a zone is really out of range.
 *  - Early warning: the detector's alarm is already ON in the step just before the breach. Lead time = steps from the start
 *    of that alarm to the breach (capped at LEAD_CAP so a permanently-on alarm cannot look great).
 *  - Missed: no alarm before the breach (the alarm, if any, comes at the breach or later).
 *  - False alarm: an alarm that switches on while the zone is in range and NO breach follows within HORIZON steps.
 */
export const LEAD_CAP = 90;
export type Alarm = boolean[];
export type Detector = (ep: Episode, zi: number) => Alarm;

/** Plain threshold alarm: on while a reading is outside the limits. */
export const thresholdCritical: Detector = (ep, zi) => ep.seen[zi].map((r) => r.min < ep.zones[zi].minC || r.max > ep.zones[zi].maxC);

/**
 * The app's existing warning level (a strong baseline): on once a reading is within the warning margin of a limit (or beyond it),
 * and, like the real AlertEngine (ALERT_HYSTERESIS_C = 0.3 °C), off only when it is back 0.3 °C clear of the margin.
 */
export const thresholdWarning: Detector = (ep, zi) => {
  const z = ep.zones[zi];
  let on = false;
  return ep.seen[zi].map((r) => {
    const m = Math.min(z.maxC - r.max, r.min - z.minC); // distance to the nearest limit (negative = outside)
    if (m < z.warnMarginC) on = true;
    else if (m >= z.warnMarginC + 0.3) on = false;
    return on;
  });
};

/** Simple non-ML forecaster: straight-line extrapolation of the last 8 steps; on when it predicts a breach within HORIZON steps. */
export const linearTrend: Detector = (ep, zi) => {
  const z = ep.zones[zi], h = ep.seen[zi];
  let run = 0, on = false;
  return h.map((r, t) => {
    if (r.min < z.minC || r.max > z.maxC) { on = true; run = 2; return true; }
    if (t < MIN_HISTORY - 1) return false;
    const o = h[t - 8], sMax = (r.max - o.max) / 8, sMin = (r.min - o.min) / 8;
    const hit = (sMax > 0.01 && (z.maxC - r.max) / sMax <= HORIZON) || (sMin < -0.01 && (r.min - z.minC) / -sMin <= HORIZON);
    if (hit) { run++; if (run >= 2) on = true; } else { run = 0; on = false; }
    return on;
  });
};

export const aiDetector = (model: ForecastModel): Detector => (ep, zi) => {
  const f = new Forecaster(model);
  return ep.seen[zi].map((r) => f.observe("z", r, ep.zones[zi]).alert);
};

export interface Summary {
  zoneEpisodes: number;
  events: number; // zone-episodes with a real breach
  early: number; // events warned before the breach
  earlyRate: number;
  medianLead: number; // over ALL events (missed events count as 0)
  medianLeadWhenEarly: number;
  falseAlarms: number;
  falseAlarmsPer100: number; // per 100 zone-episodes (one zone, 360 steps each)
  alarmRuns: number;
}

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function summarize(eps: Episode[], det: Detector): Summary {
  let zoneEpisodes = 0, events = 0, early = 0, falseAlarms = 0, alarmRuns = 0;
  const leads: number[] = [], leadsEarly: number[] = [];
  for (const ep of eps)
    ep.zones.forEach((_, zi) => {
      const crit = ep.critical[zi];
      const b = crit.indexOf(true);
      if (b >= 0 && b < 20) return; // started out of range: nothing to forecast
      zoneEpisodes++;
      const a = det(ep, zi);
      if (b >= 0) {
        events++;
        let lead = 0;
        if (a[b - 1]) { let s = b - 1; while (s > 0 && a[s - 1]) s--; lead = Math.min(LEAD_CAP, b - s); early++; leadsEarly.push(lead); }
        leads.push(lead);
      }
      for (let t = 0; t < a.length; t++) {
        if (!a[t] || (t > 0 && a[t - 1])) continue; // not a rising edge
        alarmRuns++;
        if (crit[t]) continue; // zone already out of range
        if (!crit.slice(t + 1, t + 1 + HORIZON).some(Boolean)) falseAlarms++;
      }
    });
  return {
    zoneEpisodes, events, early, earlyRate: events ? early / events : 0,
    medianLead: median(leads), medianLeadWhenEarly: median(leadsEarly),
    falseAlarms, falseAlarmsPer100: zoneEpisodes ? (100 * falseAlarms) / zoneEpisodes : 0, alarmRuns,
  };
}
