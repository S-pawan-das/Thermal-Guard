import type { Zone } from "../../shared/types";
import { LINK_LABEL, MINUTES_PER_STEP } from "../../shared/floorplan";
import type { Condition } from "./alerts";
import { CYCLE_WINDOW, type MachineCondition } from "./cycle";
import type { SpreadFinding } from "./spread";
import type { ThermalSim } from "./thermal";

/** Turns spread findings and machine-pattern deviations into alert conditions with a plain-language "what is the problem". */
const r1 = (v: number) => Math.round(v * 10) / 10;
const min = (steps: number) => Math.round(steps * MINUTES_PER_STEP);

export function spreadConditions(findings: SpreadFinding[], zones: Zone[], sim: ThermalSim): Condition[] {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const zoneName = (id: string) => byId.get(id)?.name ?? id;
  return findings.map((f) => {
    const t = byId.get(f.targetZoneId)!;
    const linkNames = f.linkIds.map((id) => sim.getLinks().find((l) => l.id === id)).filter((l) => !!l).map((l) => LINK_LABEL[l!.kind].toLowerCase());
    const cause = f.onFire ? `a fire in ${f.sourceName}` : `${f.sourceName} out of range (${zoneMax(byId, f.sourceZoneId)} °C)`;
    const eta = f.etaSteps !== null ? `${t.name} is predicted to exceed its ${f.limitC} °C maximum in about ${min(f.etaSteps)} min` : null;
    const first = sim.getLinks().find((l) => l.id === f.linkIds[0]);
    const other = first ? zoneName(first.a === f.sourceZoneId ? first.b : first.a) : f.targetName;
    return {
      zoneId: f.targetZoneId, zoneName: t.name, kind: "spread" as const, subject: f.sourceZoneId, severity: f.severity,
      title: f.severity === "critical" ? `Connected room in danger: heat is spreading to ${t.name}` : `${t.name} is connected to a zone in danger`,
      reason: `${t.name} is connected to ${f.sourceName} by a ${linkNames[0] ?? f.via}${f.hops > 1 ? ` (${f.hops} links away)` : ""}, which has ${cause}.${eta ? ` ${eta}.` : " No limit breach is predicted yet."}`,
      explain: [
        `Source of danger: ${cause}.`,
        `Heat route: ${f.sourceName} → ${f.hops > 1 ? "… → " : ""}${t.name} through ${linkNames.join(" → ") || f.via}.`,
        eta ? `Prediction (digital twin): ${eta}; worst predicted cell ${f.peakC ?? "?"} °C.` : `The digital twin does not predict a breach within the horizon, but the connection stays open.`,
      ],
      advice: first ? `Isolate the ${LINK_LABEL[first.kind].toLowerCase()} between ${f.sourceName} and ${other} now, then deal with the source.` : `Isolate the connection to ${f.sourceName}.`,
      etaSteps: f.etaSteps, readingC: t.maxCellC, limitC: f.limitC,
    };
  });
}
const zoneMax = (byId: Map<string, Zone>, id: string) => byId.get(id)?.maxCellC ?? "?";

export function machineConditions(list: MachineCondition[], zoneNames: Map<string, string>, hasZone: (id: string) => boolean): Condition[] {
  const out: Condition[] = [];
  for (const m of list) {
    if (!m.zoneId || !hasZone(m.zoneId)) continue; // an alert needs a zone to belong to
    const zoneName = zoneNames.get(m.zoneId) ?? m.zoneId;
    const common = [
      `Learned normal: +${r1(m.usualC)} °C after ${CYCLE_WINDOW} min (from ${m.cycles} earlier cycles).`,
      `Now: +${r1(m.riseC)} °C after ${m.minute} min, against +${r1(m.expectedC)} °C expected at this point (${m.ratioPct}% of normal).`,
    ];
    if (m.verdict === "underperform") {
      out.push({
        zoneId: m.zoneId, zoneName, kind: "underperform", subject: m.machineId, severity: "warning",
        title: `${m.name}: working below its normal efficiency — needs repair`,
        reason: `${m.name} is heating slower than usual: +${r1(m.riseC)} °C after ${m.minute} min, normally +${r1(m.expectedC)} °C (${m.ratioPct}% of normal).`,
        explain: [...common, `If this continues it ends at +${r1(m.projectedC)} °C instead of +${r1(m.usualC)} °C.`, "Likely causes: worn or fouled heating element, reduced load, blocked heat path, or a faulty probe."],
        advice: `Schedule maintenance: the machine delivers about ${m.ratioPct}% of its normal heat output (lower efficiency).`,
        etaSteps: null, readingC: m.riseC, limitC: m.expectedC,
      });
    } else {
      out.push({
        zoneId: m.zoneId, zoneName, kind: "overshoot", subject: m.machineId, severity: "critical",
        title: `${m.name}: heating faster than its normal pattern — keep under surveillance, stop if it continues`,
        reason: `${m.name} is heating faster than usual: +${r1(m.riseC)} °C after ${m.minute} min, normally +${r1(m.expectedC)} °C (${m.ratioPct}% of normal).`,
        explain: [...common, `If this continues it reaches +${r1(m.projectedC)} °C instead of +${r1(m.usualC)} °C by minute ${CYCLE_WINDOW}.`, "Likely causes: failed cooling or ventilation, runaway load, heater stuck on, or a faulty probe."],
        advice: `Keep ${m.name} under surveillance and stop it if the rise does not level off: a disaster can develop even though no limit is crossed yet.`,
        etaSteps: null, readingC: m.riseC, limitC: m.expectedC,
      });
    }
  }
  return out;
}
