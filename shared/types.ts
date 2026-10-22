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
  links?: LinkStatus[]; // live state of every pipe / duct / conveyor / door
  machines?: MachineStatus[]; // learned-pattern monitor, one entry per machine that has run a cycle
}

// A connection and whether heat is currently threatening the zone at its far end.
export interface LinkStatus {
  id: string;
  a: string;
  b: string;
  kind: LinkKind;
  closed: boolean; // isolated (valve shut / door closed): no heat travels
  danger: "none" | "watch" | "spread"; // spread = one end is critical/on fire and heat is expected to travel
}

// Live view of one machine's temperature rise since it started, against its learned normal.
export interface MachineStatus {
  id: string; // machine id (stable across cycles)
  name: string;
  zoneId?: string;
  running: boolean;
  minute: number; // minutes since the current cycle started (1 sim step = 1 minute of factory time, see MINUTES_PER_STEP in floorplan.ts)
  window: number; // length of the learned curve in minutes
  riseC: number; // observed rise so far at the machine's probe, °C
  expectedC: number | null; // learned normal rise at this minute (null while nothing is learned yet)
  bandC: number | null; // +/- tolerance around expectedC
  projectedC: number | null; // projected rise at the end of the window if the pattern continues
  usualC: number | null; // learned normal rise at the end of the window
  cycles: number; // cycles the profile was learned from
  verdict: "learning" | "normal" | "underperform" | "overshoot";
  curve: { m: number; mean: number; sd: number }[]; // learned normal curve
  actual: { m: number; v: number }[]; // observed curve of the current / last cycle
}

// ---- Alerts (server-authoritative; broadcast on the "alerts" Socket.IO event) ----
export type AlertSeverity = "warning" | "critical";
// high / low: a limit is approached or crossed. spread: heat can travel here from a connected zone.
// underperform / overshoot: a machine's temperature rise after start differs from its learned normal (repair vs. danger).
export type AlertKind = "high" | "low" | "spread" | "underperform" | "overshoot";

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
  // Optional "what is the problem" detail (spread / machine-pattern alerts, and root causes of limit alerts).
  title?: string; // short headline, e.g. "Machine heating slower than usual"
  explain?: string[]; // bullet lines: what was observed, what is normal, likely causes
  advice?: string; // the recommended action
  subject?: string; // what the alert is about besides the zone: machine id, link id, ...
  etaSteps?: number | null; // predicted steps until a limit is crossed, when known
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
  x: number; // top-left corner (for a painted region: the corner of its bounding box)
  y: number;
  w: number;
  h: number;
  // FREE-FORM REGION: when present, the zone is exactly these simulation cells (index = row * SIM_COLS + col), any shape,
  // with no walls around it (an open hall). x/y/w/h are then just its bounding box, recomputed by validatePlan.
  cells?: number[];
}

// A physical connection that heat can travel along between two zones.
export type LinkKind = "pipe" | "duct" | "conveyor" | "door";
export interface PlanLink {
  id: string;
  a: string; // zone id
  b: string; // zone id
  kind: LinkKind;
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
  links?: PlanLink[]; // pipes, ducts, conveyors and doors between zones (absent in old files = none)
  background: string | null; // PNG/JPEG/WebP data URL, or null
}
