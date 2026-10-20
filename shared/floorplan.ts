import type { FloorPlanConfig, PlanZone, ZoneLimits, ZoneStatus, ZoneType } from "./types";

/**
 * CANONICAL FLOOR-PLAN COORDINATE SYSTEM
 * - A fixed logical canvas of 1000 x 600 "plan units"; origin top-left, x right, y down.
 * - Independent of screen pixels: the editor scales plan units to whatever size the browser gives it.
 * - The future simulation grid uses square cells of GRID_SIZE units: 100 columns x 60 rows.
 *   Cell (col,row) covers x in [col*10, col*10+10) and y in [row*10, row*10+10).
 *   Zone edges are snapped to this grid, so every zone is a whole number of cells.
 */
export const PLAN_WIDTH = 1000;
export const PLAN_HEIGHT = 600;
export const GRID_SIZE = 10;
export const GRID_COLS = PLAN_WIDTH / GRID_SIZE;
export const GRID_ROWS = PLAN_HEIGHT / GRID_SIZE;
export const MIN_ZONE_SIZE = 20;
export const MAX_ZONES = 50;
export const MAX_EXITS = 20;
export const MAX_NAME_LENGTH = 40;
export const MAX_BACKGROUND_CHARS = 2_900_000; // ~2 MB image as base64

/**
 * SIMULATION GRID (same plan coordinates, no second coordinate system).
 * 40 x 25 cells over the 1000 x 600 plan: each cell is 25 x 24 plan units. Cell (col,row) covers
 * x in [col*25, col*25+25) and y in [row*24, row*24+24). Cells are slightly non-square (25 vs 24);
 * the engine treats them as equal-sized.
 */
export const SIM_COLS = 40;
export const SIM_ROWS = 25;
export const SIM_CELL_W = PLAN_WIDTH / SIM_COLS;
export const SIM_CELL_H = PLAN_HEIGHT / SIM_ROWS;

export function planToSimCell(x: number, y: number) {
  return { col: clamp(Math.floor(x / SIM_CELL_W), 0, SIM_COLS - 1), row: clamp(Math.floor(y / SIM_CELL_H), 0, SIM_ROWS - 1) };
}
export function simCellToPlan(col: number, row: number) {
  return { x: col * SIM_CELL_W, y: row * SIM_CELL_H, w: SIM_CELL_W, h: SIM_CELL_H };
}
/** Inclusive cell ranges of every cell that overlaps the rectangle with positive area. */
export function zoneSimCells(z: { x: number; y: number; w: number; h: number }) {
  const c0 = clamp(Math.floor(z.x / SIM_CELL_W), 0, SIM_COLS - 1);
  const r0 = clamp(Math.floor(z.y / SIM_CELL_H), 0, SIM_ROWS - 1);
  return {
    c0, r0,
    c1: clamp(Math.ceil((z.x + z.w) / SIM_CELL_W) - 1, c0, SIM_COLS - 1),
    r1: clamp(Math.ceil((z.y + z.h) / SIM_CELL_H) - 1, r0, SIM_ROWS - 1),
  };
}

export const emptyPlan = (): FloorPlanConfig => ({ version: 2, zones: [], exits: [], background: null });
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const snap = (v: number) => Math.round(v / GRID_SIZE) * GRID_SIZE;

export function planToCell(x: number, y: number) {
  return {
    col: clamp(Math.floor(x / GRID_SIZE), 0, GRID_COLS - 1),
    row: clamp(Math.floor(y / GRID_SIZE), 0, GRID_ROWS - 1),
  };
}
export function cellToPlan(col: number, row: number) {
  return { x: col * GRID_SIZE, y: row * GRID_SIZE, w: GRID_SIZE, h: GRID_SIZE };
}

/** Turn two drag corners (any direction) into a snapped rectangle inside the plan. */
export function clampRect(x0: number, y0: number, x1: number, y1: number) {
  const xa = snap(clamp(Math.min(x0, x1), 0, PLAN_WIDTH));
  const xb = snap(clamp(Math.max(x0, x1), 0, PLAN_WIDTH));
  const ya = snap(clamp(Math.min(y0, y1), 0, PLAN_HEIGHT));
  const yb = snap(clamp(Math.max(y0, y1), 0, PLAN_HEIGHT));
  return { x: xa, y: ya, w: xb - xa, h: yb - ya };
}

/** Returns an error message, or null if the name is acceptable. */
export function checkName(name: string, zones: PlanZone[], selfId?: string): string | null {
  const t = name.trim();
  if (!t) return "Zone name cannot be empty.";
  if (t.length > MAX_NAME_LENGTH) return `Zone name must be ${MAX_NAME_LENGTH} characters or fewer.`;
  if (zones.some((z) => z.id !== selfId && z.name.toLowerCase() === t.toLowerCase()))
    return `A zone named "${t}" already exists.`;
  return null;
}

export type PlanResult = { ok: true; plan: FloorPlanConfig } | { ok: false; error: string };
const fail = (error: string): PlanResult => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BG_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const EPS = 1e-6;

// ---- temperature limits: ONE generic system for every zone type ----
export const ZONE_TYPES: readonly ZoneType[] = ["general", "hot-process", "cold-storage"];
export const ZONE_TYPE_LABEL: Record<ZoneType, string> = {
  general: "General",
  "hot-process": "Hot process",
  "cold-storage": "Cold storage",
};
export const TEMP_MIN = -100; // sanity bounds, °C
export const TEMP_MAX = 1000;
/** Used for new zones, and for zones saved before limits existed. */
export const DEFAULT_LIMITS: ZoneLimits = { type: "general", minC: 15, maxC: 30, warnMarginC: 2 };

export type LimitsResult = { ok: true; limits: ZoneLimits } | { ok: false; error: string };
const limitsFail = (error: string): LimitsResult => ({ ok: false, error });

/** Validates {type, minC, maxC, warnMarginC}. Used by the backend AND the editor form. */
export function validateLimits(input: unknown): LimitsResult {
  if (!isObj(input)) return limitsFail("Limits must be a JSON object.");
  const { type, minC, maxC, warnMarginC } = input;
  if (typeof type !== "string" || !(ZONE_TYPES as readonly string[]).includes(type))
    return limitsFail(`Zone type must be one of: ${ZONE_TYPES.join(", ")}.`);
  if (!isNum(minC)) return limitsFail("Minimum temperature must be a finite number.");
  if (!isNum(maxC)) return limitsFail("Maximum temperature must be a finite number.");
  if (!isNum(warnMarginC)) return limitsFail("Warning margin must be a finite number.");
  if (minC < TEMP_MIN || maxC > TEMP_MAX) return limitsFail(`Temperatures must be between ${TEMP_MIN} and ${TEMP_MAX} °C.`);
  if (minC >= maxC) return limitsFail("Minimum must be lower than maximum.");
  const half = (maxC - minC) / 2;
  if (warnMarginC < 0) return limitsFail("Warning margin cannot be negative.");
  if (warnMarginC >= half) return limitsFail(`Warning margin must be less than half the range (${half} °C for this range).`);
  return { ok: true, limits: { type: type as ZoneType, minC, maxC, warnMarginC } };
}

/** The one status rule for all zones. Exactly at a limit is still allowed. */
export function statusFor(t: number, l: Pick<ZoneLimits, "minC" | "maxC" | "warnMarginC">): ZoneStatus {
  if (t < l.minC || t > l.maxC) return "critical";
  if (t < l.minC + l.warnMarginC || t > l.maxC - l.warnMarginC) return "warning";
  return "normal";
}

/** Status from a zone's coldest and hottest cell: the worse of the two ends decides. */
export function statusForCells(minCell: number, maxCell: number, l: Pick<ZoneLimits, "minC" | "maxC" | "warnMarginC">): ZoneStatus {
  const a = statusFor(minCell, l);
  const b = statusFor(maxCell, l);
  return a === "critical" || b === "critical" ? "critical" : a === "warning" || b === "warning" ? "warning" : "normal";
}

/** Upgrades a version-1 saved plan (no limits) to version 2 by adding DEFAULT_LIMITS to each zone. */
export function migratePlan(input: unknown): unknown {
  if (!isObj(input) || input.version !== 1 || !Array.isArray(input.zones)) return input;
  return { ...input, version: 2, zones: input.zones.map((z: unknown) => (isObj(z) ? { ...DEFAULT_LIMITS, ...z } : z)) };
}

/** Shared by server (before saving/after loading) and client (after loading). Returns a cleaned copy. */
export function validatePlan(input: unknown): PlanResult {
  if (!isObj(input)) return fail("Floor plan must be a JSON object.");
  if (input.version !== 2) return fail("Unsupported floor plan version.");
  if (!Array.isArray(input.zones) || !Array.isArray(input.exits)) return fail("Floor plan needs zones and exits lists.");
  if (input.zones.length > MAX_ZONES) return fail(`At most ${MAX_ZONES} zones are allowed.`);
  if (input.exits.length > MAX_EXITS) return fail(`At most ${MAX_EXITS} exit markers are allowed.`);

  const ids = new Set<string>();
  const zones: PlanZone[] = [];
  for (let i = 0; i < input.zones.length; i++) {
    const raw: unknown = input.zones[i];
    const label = `Zone ${i + 1}`;
    if (!isObj(raw)) return fail(`${label} is not an object.`);
    const { id, name, x, y, w, h } = raw;
    if (typeof id !== "string" || !ID_RE.test(id)) return fail(`${label} has an invalid id.`);
    if (ids.has(id)) return fail(`Duplicate id "${id}".`);
    if (typeof name !== "string") return fail(`${label} has no name.`);
    const nameErr = checkName(name, zones);
    if (nameErr) return fail(`${label}: ${nameErr}`);
    if (!isNum(x) || !isNum(y) || !isNum(w) || !isNum(h)) return fail(`${label} ("${name.trim()}") has invalid geometry.`);
    if (w < MIN_ZONE_SIZE || h < MIN_ZONE_SIZE) return fail(`${label} ("${name.trim()}") is smaller than ${MIN_ZONE_SIZE} units.`);
    if (x < 0 || y < 0 || x + w > PLAN_WIDTH + EPS || y + h > PLAN_HEIGHT + EPS)
      return fail(`${label} ("${name.trim()}") is outside the floor plan.`);
    const lim = validateLimits(raw);
    if (!lim.ok) return fail(`${label} ("${name.trim()}"): ${lim.error}`);
    ids.add(id);
    zones.push({ id, name: name.trim(), x, y, w, h, ...lim.limits });
  }

  const exits: FloorPlanConfig["exits"] = [];
  for (let i = 0; i < input.exits.length; i++) {
    const raw: unknown = input.exits[i];
    const label = `Exit ${i + 1}`;
    if (!isObj(raw)) return fail(`${label} is not an object.`);
    const { id, x, y } = raw;
    if (typeof id !== "string" || !ID_RE.test(id)) return fail(`${label} has an invalid id.`);
    if (ids.has(id)) return fail(`Duplicate id "${id}".`);
    if (!isNum(x) || !isNum(y)) return fail(`${label} has invalid coordinates.`);
    if (x < 0 || y < 0 || x > PLAN_WIDTH || y > PLAN_HEIGHT) return fail(`${label} is outside the floor plan.`);
    ids.add(id);
    exits.push({ id, x, y });
  }

  const bg = input.background ?? null;
  if (bg !== null && (typeof bg !== "string" || bg.length > MAX_BACKGROUND_CHARS || !BG_RE.test(bg)))
    return fail("Background must be a PNG, JPEG or WebP image of at most 2 MB.");

  return { ok: true, plan: { version: 2, zones, exits, background: bg } };
}
