// Shapes shared by the server (server/src/twin.ts) and the client (Insights, Heatmap prediction).

export interface ZoneOutlook {
  id: string;
  name: string;
  limitMinC: number;
  limitMaxC: number;
  nowMaxC: number;
  nowMinC: number;
  peakC: number; // hottest cell of the zone at any time in the horizon
  lowC: number; // coldest cell of the zone at any time in the horizon
  endMaxC: number;
  breach: { kind: "high" | "low"; inSteps: number } | null; // first limit crossing (0 = already out of range)
  overshootC: number; // how far past the limit the worst moment goes (0 if it stays inside)
}
export interface TwinResult {
  fromStep: number;
  steps: number;
  every: number;
  minutesPerStep: number;
  frames: { inSteps: number; grid: number[] }[]; // predicted heat field, including inSteps = 0 (now)
  zones: ZoneOutlook[];
}

export type Action =
  | { kind: "stop-source"; sourceId: string }
  | { kind: "cooling"; zoneId: string; targetC: number; strength: number }
  | { kind: "vent"; zoneId: string; strength: number }
  | { kind: "isolate-link"; linkId: string }
  | { kind: "repair-cooler"; zoneId: string };

export interface ActionResult {
  action: Action;
  key: string;
  label: string;
  harmBefore: number;
  harmAfter: number;
  prevents: string[]; // zones that stay inside their limits because of it
  stillBreaching: string[];
  bought: string; // plain-language effect
  worstPeakAfter: number | null; // hottest predicted cell among zones that were going to breach
  worstPeakBefore: number | null;
  score: number; // harm removed (higher is better)
}

export interface Cause {
  kind: "source" | "cooler" | "link" | "other";
  id: string;
  label: string;
  reducesByC: number; // how much lower the zone's worst predicted cell is if this cause is removed
  sharePct: number; // share of all removable heat
}
export interface CauseReport { zoneId: string; zoneName: string; side: "high" | "low"; peakC: number; causes: Cause[]; summary: string }

