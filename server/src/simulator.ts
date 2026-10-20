import type { StateMessage, Zone } from "../../shared/types";
import { statusForCells } from "../../shared/floorplan";
import type { ThermalSim } from "./thermal";

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Builds the live message: each zone's saved limits plus statistics of the grid cells it covers. */
export function getState(sim: ThermalSim, now: Date = new Date()): StateMessage {
  const timestamp = now.toISOString();
  const stats = new Map(sim.zoneStats().map((s) => [s.id, s]));
  const zones: Zone[] = sim.getZones().map((p) => {
    const s = stats.get(p.id)!;
    return {
      id: p.id, name: p.name, type: p.type, minC: p.minC, maxC: p.maxC, warnMarginC: p.warnMarginC,
      temperatureC: round1(s.avgC), minCellC: round1(s.minC), maxCellC: round1(s.maxC),
      timestamp, status: statusForCells(round1(s.minC), round1(s.maxC), p), // same rounded numbers the alerts use
    };
  });
  return { simulated: true, timestamp, zones, sim: sim.status() };
}
