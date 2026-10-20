import { promises as fs } from "fs";
import path from "path";
import type { AlertRecord, FloorPlanConfig, PlanZone, ZoneLimits } from "../../shared/types";
import { emptyPlan, migratePlan, validatePlan } from "../../shared/floorplan";

// Plain JSON file; no database needed. Folder can be changed with DATA_DIR in server/.env.
export const PLAN_FILE = path.resolve(process.env.DATA_DIR || "data", "floorplan.json");

// Last plan known to be valid (used by the live-data loop so it never reads the disk each second).
let cache: FloorPlanConfig | null = null;
export const peekPlan = (): FloorPlanConfig | null => cache;

// Writes run one at a time so two requests can't overwrite each other.
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(f: () => Promise<T>): Promise<T> {
  const run = chain.then(f, f);
  chain = run.catch(() => undefined);
  return run;
}

export async function loadPlan(): Promise<FloorPlanConfig> {
  let text: string;
  try {
    text = await fs.readFile(PLAN_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return (cache = emptyPlan()); // first run
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${PLAN_FILE} is not valid JSON`);
  }
  const result = validatePlan(migratePlan(parsed)); // version-1 files get default limits
  if (!result.ok) throw new Error(`Saved floor plan is invalid: ${result.error}`);
  return (cache = result.plan);
}

async function write(plan: FloorPlanConfig): Promise<void> {
  await fs.mkdir(path.dirname(PLAN_FILE), { recursive: true });
  const tmp = `${PLAN_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(plan), "utf8");
  await fs.rename(tmp, PLAN_FILE); // write-then-rename so a crash never leaves a half-written file
  cache = plan; // only updated after a successful write
}

export const savePlan = (plan: FloorPlanConfig): Promise<void> => locked(() => write(plan));

/** Changes only the limits of one zone. Returns the updated zone, or null if the id doesn't exist. */
export const updateZoneLimits = (id: string, limits: ZoneLimits): Promise<PlanZone | null> =>
  locked(async () => {
    const plan = await loadPlan();
    const zone = plan.zones.find((z) => z.id === id);
    if (!zone) return null;
    const updated: PlanZone = { ...zone, ...limits };
    await write({ ...plan, zones: plan.zones.map((z) => (z.id === id ? updated : z)) });
    return updated;
  });

// ---- alert history (same pattern: one JSON file, write-then-rename, serialized writes) ----
export const ALERTS_FILE = path.resolve(process.env.DATA_DIR || "data", "alerts.json");

/** Returns the raw saved list; the alert engine sanitizes it. A corrupt file is set aside, never overwritten. */
export async function loadAlertHistory(): Promise<unknown[]> {
  let text: string;
  try {
    text = await fs.readFile(ALERTS_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    await fs.rename(ALERTS_FILE, `${ALERTS_FILE}.corrupt`);
    console.error(`${ALERTS_FILE} was not valid JSON; moved to alerts.json.corrupt and starting empty.`);
    return [];
  }
}

export const saveAlertHistory = (alerts: AlertRecord[]): Promise<void> =>
  locked(async () => {
    await fs.mkdir(path.dirname(ALERTS_FILE), { recursive: true });
    const tmp = `${ALERTS_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(alerts), "utf8");
    await fs.rename(tmp, ALERTS_FILE);
  });
