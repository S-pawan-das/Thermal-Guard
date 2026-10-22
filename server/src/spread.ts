import type { LinkStatus, Zone } from "../../shared/types";
import { MINUTES_PER_STEP, LINK_LABEL } from "../../shared/floorplan";
import type { ThermalSim } from "./thermal";
import type { TwinResult } from "./twin";

/**
 * SPREAD ANALYSIS: which connected rooms are in danger because a neighbour is burning or out of range?
 *
 * A zone is a DANGER SOURCE when its hottest cell is above its maximum or a fire burns in it. Heat can travel from it along every
 * open link (pipe, duct, conveyor, door) to the zone at the other end, and on through further links (up to MAX_HOPS).
 * A reached zone is flagged:
 *   critical - the digital twin predicts it will leave its limits within the horizon (the simulation already carries heat through
 *              the links, so this is physics, not a rule of thumb), with the minutes until it happens;
 *   warning  - it is connected to the danger but the twin does not (yet) predict a breach.
 * Closing a link removes it from the analysis immediately.
 */
export const MAX_HOPS = 3;

export interface SpreadFinding {
  sourceZoneId: string;
  sourceName: string;
  targetZoneId: string;
  targetName: string;
  hops: number;
  linkIds: string[]; // the path
  via: string; // "pipeline", "air duct", ...
  severity: "warning" | "critical";
  etaSteps: number | null; // predicted steps until the target leaves its limits
  onFire: boolean;
  peakC: number | null; // predicted worst cell of the target
  limitC: number;
}

export function analyzeSpread(sim: ThermalSim, zones: Zone[], outlook: TwinResult | null): { findings: SpreadFinding[]; links: LinkStatus[] } {
  const links = sim.getLinks();
  const byId = new Map(zones.map((z) => [z.id, z]));
  const fireZones = new Set(sim.status().fires.map((f) => f.zoneId).filter((x): x is string => !!x));
  const danger = new Set<string>();
  for (const z of zones) if (z.maxCellC > z.maxC || fireZones.has(z.id)) danger.add(z.id);

  const status = new Map<string, LinkStatus["danger"]>();
  const findings: SpreadFinding[] = [];
  const open = links.filter((l) => !sim.isLinkClosed(l.id));
  const rank = { none: 0, watch: 1, spread: 2 } as const;
  const mark = (id: string, d: LinkStatus["danger"]) => { if (rank[d] > rank[status.get(id) ?? "none"]) status.set(id, d); };

  for (const src of danger) {
    // breadth-first over open links
    const seen = new Map<string, { hops: number; path: string[] }>([[src, { hops: 0, path: [] }]]);
    const queue = [src];
    while (queue.length) {
      const cur = queue.shift()!;
      const here = seen.get(cur)!;
      if (here.hops >= MAX_HOPS) continue;
      for (const l of open) {
        const next = l.a === cur ? l.b : l.b === cur ? l.a : null;
        if (!next || seen.has(next)) continue;
        seen.set(next, { hops: here.hops + 1, path: [...here.path, l.id] });
        queue.push(next);
      }
    }
    for (const [zid, info] of seen) {
      if (zid === src || danger.has(zid) || !byId.has(zid)) continue;
      const target = byId.get(zid)!;
      const out = outlook?.zones.find((o) => o.id === zid);
      const predicted = out?.breach?.kind === "high" ? out.breach.inSteps : null;
      const severity = predicted !== null ? "critical" : "warning";
      const first = links.find((l) => l.id === info.path[0]);
      findings.push({
        sourceZoneId: src, sourceName: byId.get(src)!.name, targetZoneId: zid, targetName: target.name, hops: info.hops, linkIds: info.path,
        via: first ? LINK_LABEL[first.kind].toLowerCase() : "link", severity, etaSteps: predicted, onFire: fireZones.has(src),
        peakC: out ? out.peakC : null, limitC: target.maxC,
      });
      for (const id of info.path) mark(id, severity === "critical" ? "spread" : "watch");
    }
  }
  // keep the most urgent finding per target zone
  const best = new Map<string, SpreadFinding>();
  for (const f of findings) {
    const cur = best.get(f.targetZoneId);
    const urgent = (x: SpreadFinding) => (x.severity === "critical" ? 0 : 1) * 1e6 + (x.etaSteps ?? 1e5) + x.hops;
    if (!cur || urgent(f) < urgent(cur)) best.set(f.targetZoneId, f);
  }
  return {
    findings: [...best.values()],
    links: links.map((l) => ({ id: l.id, a: l.a, b: l.b, kind: l.kind, closed: sim.isLinkClosed(l.id), danger: status.get(l.id) ?? "none" })),
  };
}

export const minutes = (steps: number) => Math.round(steps * MINUTES_PER_STEP);
