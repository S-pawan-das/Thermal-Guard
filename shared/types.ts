// The single "data contract" shared by server and client.
// Always import with `import type { ... }` so nothing is bundled at runtime.

export type ZoneStatus = "normal" | "warning" | "critical";

export type ZoneType = "general" | "hot-process" | "cold-storage";

// One limit system for EVERY zone. `type` is only a label; it never changes the rules.
export interface ZoneLimits {
  type: ZoneType;
  minC: number; // lowest permitted temperature (°C)
  maxC: number; // highest permitted temperature (°C)
  warnMarginC: number; // "warning" when within this many °C of minC or maxC
}

// A LIVE reading: the saved zone limits plus a temperature.
export interface Zone extends ZoneLimits {
  id: string;
  name: string;
  temperatureC: number; // average of the zone's grid cells (for display)
  minCellC: number; // coldest intersecting cell: low-temperature risk
  maxCellC: number; // hottest intersecting cell: high-temperature risk
  timestamp: string; // ISO 8601
  status: ZoneStatus;
  ai?: ZoneForecast; // early-warning model output (absent until the server has enough history)
}

// Output of the trained early-warning model (shared/forecast.ts) for one zone.
export interface ZoneForecast {
  risk: number; // 0..1: chance the zone goes out of range within the next `horizon` simulation steps
  alert: boolean; // the model's alarm is on (risk stayed above its tuned threshold, or the zone is already out of range)
  horizon: number; // look-ahead in simulation steps
}

// What the simulator is doing right now (server-authoritative).
export interface SimStatus {
  paused: boolean;
  step: number;
  scenario: string; // scenario name, e.g. "ambient"
  fires: { id: string; zoneId?: string }[]; // active heat sources
  failedCoolers: string[]; // zone ids whose cooler has failed
  baseline: boolean; // true when no fire and no failed cooler is active
}

// The whole thermal grid, row by row (index = row * cols + col), °C rounded to 0.1.
// Same geometry as the engine: SIM_COLS x SIM_ROWS cells over the 1000 x 600 plan.
export interface GridSnapshot {
  cols: number;
  rows: number;
  values: number[];
}

export interface StateMessage {
  simulated: true;
  timestamp: string; // ISO 8601
  zones: Zone[];
  sim?: SimStatus;
  grid?: GridSnapshot; // drives the Heatmap tab
}

// ---- Alerts (server-authoritative; broadcast on the "alerts" Socket.IO event) ----
export type AlertSeverity = "warning" | "critical";
export type AlertKind = "high" | "low"; // which limit the reading is approaching / has crossed

export interface AlertRecord {
  id: string; // stable, never reused, e.g. "A-000012"
  zoneId: string;
  zoneName: string;
  kind: AlertKind;
  severity: AlertSeverity;
  status: "active" | "resolved";
  reason: string; // human-readable
  readingC: number; // hottest (high) or coldest (low) cell when the alert started
  peakC: number; // worst reading seen while active
  limitC: number; // the limit that applies (maxC or minC)
  startedAt: string; // ISO 8601
  updatedAt: string;
  resolvedAt: string | null;
  resolution: "recovered" | "escalated" | "scenario reset" | "zone removed" | "server restart" | null;
  occurrences: number; // 1, +1 each time the same alert is re-opened inside the cooldown
}

export interface AlertsMessage {
  alerts: AlertRecord[]; // newest first; all active alerts plus recent history
}

// ---- Floor plan: STATIC configuration (saved on the server) ----
// Kept separate from the live `Zone` readings above. Link them later by `id`.
// All coordinates are "plan units" — see shared/floorplan.ts.

export interface PlanZone extends ZoneLimits {
  id: string;
  name: string;
  x: number; // top-left corner
  y: number;
  w: number;
  h: number;
}

export interface ExitMarker {
  id: string;
  x: number;
  y: number;
}

export interface FloorPlanConfig {
  version: 2;
  zones: PlanZone[];
  exits: ExitMarker[];
  background: string | null; // PNG/JPEG/WebP data URL, or null
}
