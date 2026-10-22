import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import type { AlertsMessage, StateMessage, ZoneForecast } from "../../shared/types";
import { MINUTES_PER_STEP } from "../../shared/floorplan";
import { Forecaster } from "../../shared/forecast";
import { FORECAST_MODEL } from "../../shared/forecastModel";
import { validateLimits, validatePlan } from "../../shared/floorplan";
import { getState } from "./simulator";
import { ThermalSim, validateFailure, validateFire, validateScenario, validateSetTemperature, validateSource } from "./thermal";
import { AlertEngine } from "./alerts";
import { CycleMonitor } from "./cycle";
import { analyzeSpread } from "./spread";
import { machineConditions, spreadConditions } from "./insights";
import { MAX_TWIN_STEPS, applyAction, describeAction, evaluateActions, explainCauses, parseAction, runTwin, type TwinResult } from "./twin";
import { loadPlan, peekPlan, savePlan, updateZoneLimits, loadAlertHistory, saveAlertHistory, PLAN_FILE } from "./storage";

const PORT = Number(process.env.PORT) || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } });

// ---- thermal simulation ----
const envInt = (v: string | undefined, def: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : def;
};
const INTERVAL_MS = envInt(process.env.SIM_INTERVAL_MS, 1000, 100, 10000); // real time between updates
const STEPS_PER_TICK = envInt(process.env.SIM_STEPS_PER_TICK, 1, 1, 50); // simulation steps per update (demo speed)
const sim = new ThermalSim();
// ---- early-warning model: sees ONE reading per zone per simulation step, exactly like in training (see ml/) ----
const forecaster = new Forecaster(FORECAST_MODEL);
let forecasts = new Map<string, ZoneForecast>();
const round1 = (v: number) => Math.round(v * 10) / 10;
function observeForecasts() {
  const limits = new Map(sim.getZones().map((z) => [z.id, z]));
  const next = new Map<string, ZoneForecast>();
  for (const s of sim.zoneStats()) {
    const z = limits.get(s.id);
    if (z) next.set(s.id, forecaster.observe(s.id, { avg: round1(s.avgC), min: round1(s.minC), max: round1(s.maxC) }, z));
  }
  forecasts = next;
}
const resetForecasts = () => { forecaster.reset(); forecasts = new Map(); };
// ---- learned machine patterns (see cycle.ts) ----
const monitor = new CycleMonitor();
/** Learn each machine's normal warm-up curve from simulated earlier days, then start watching from the current step. */
function rehearse() {
  try { monitor.trainFromHistory(sim); } catch (err) { console.error("Could not learn machine patterns:", (err as Error).message); }
  monitor.resetRuns();
  monitor.observe(sim);
}
const syncZones = () => {
  const plan = peekPlan();
  if (plan) { sim.setZones(plan.zones); sim.setLinks(plan.links ?? []); resetForecasts(); rehearse(); }
};

// ---- predictive twin used by the live loop: only while something is in danger (see spread.ts) ----
const SPREAD_HORIZON = 90; // steps
let outlookCache: { step: number; res: TwinResult } | null = null;
let lastFindings: ReturnType<typeof analyzeSpread>["findings"] = [];
const current = (): StateMessage => {
  const st = getState(sim, new Date(), forecasts);
  const danger = st.zones.some((z) => z.maxCellC > z.maxC) || (st.sim?.fires ?? []).some((f) => f.zoneId);
  let outlook: TwinResult | null = null;
  if (danger && sim.getLinks().length) {
    if (!outlookCache || outlookCache.step !== sim.step) outlookCache = { step: sim.step, res: runTwin(sim, SPREAD_HORIZON, { frames: false }) };
    outlook = outlookCache.res;
  }
  const sp = analyzeSpread(sim, st.zones, outlook);
  lastFindings = sp.findings;
  if (sp.links.length) st.links = sp.links;
  const machines = monitor.statuses(sim);
  if (machines.length) st.machines = machines;
  return st;
};
let lastState: StateMessage | null = null;

// ---- alerts: evaluated here, on the server, from the same readings the dashboard shows ----
const envNum = (v: string | undefined, def: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const alerts = new AlertEngine({
  hysteresisC: envNum(process.env.ALERT_HYSTERESIS_C, 0.3, 0, 5),
  cooldownMs: envNum(process.env.ALERT_COOLDOWN_MS, 60_000, 0, 3_600_000),
  maxHistory: 500,
});
const alertsMessage = (): AlertsMessage => ({ alerts: alerts.recent(100) });
function announceAlerts() {
  io.emit("alerts", alertsMessage());
  saveAlertHistory(alerts.list()).catch((err) => console.error("Could not save alert history:", (err as Error).message));
}
/** Publish the live state, and any alert changes it causes, to every client (used after every change). */
const pendingEnrich: string[] = [];
/** One "what is the problem" analysis per tick, so a burst of alerts never freezes the loop. */
function enrichOne(): boolean {
  const id = pendingEnrich.shift();
  const a = id ? alerts.list().find((x) => x.id === id) : undefined;
  if (!a || a.status !== "active" || a.explain) return false;
  const horizon = 60;
  try {
    const ev = a.severity === "critical" ? evaluateActions(sim, horizon) : null;
    const rep = explainCauses(sim, a.zoneId, horizon, ev?.baseline);
    const best = ev?.results.find((r) => r.score > 0);
    const explain = rep ? [rep.summary, ...rep.causes.map((c) => `${c.label}: ${c.reducesByC} °C lower if removed (${c.sharePct}%)`)] : [];
    alerts.annotate(a.id, {
      explain,
      ...(best ? { advice: `${best.label}. ${best.bought}` } : {}),
    });
    return true;
  } catch (err) {
    console.error("Could not analyse alert:", (err as Error).message);
    return false;
  }
}
const pushState = () => {
  const st = current();
  const zoneNames = new Map(st.zones.map((z) => [z.id, z.name]));
  const changes = [
    ...alerts.evaluate(st.zones),
    ...alerts.sync([
      ...spreadConditions(lastFindings, st.zones, sim),
      ...machineConditions(monitor.conditions(sim), zoneNames, (id) => zoneNames.has(id)),
    ]),
  ];
  for (const c of changes) if ((c.type === "created" || c.type === "reopened") && c.alert.kind === "high" && !c.alert.explain && !pendingEnrich.includes(c.alert.id)) pendingEnrich.push(c.alert.id);
  const enriched = enrichOne();
  lastState = st;
  io.emit("state", st);
  if (changes.length || enriched) announceAlerts();
};

/** One engine step plus everything that must see every step (early-warning model, machine-pattern monitor). */
function stepOnce() {
  sim.tick(1);
  observeForecasts();
  monitor.observe(sim);
}
let timer: NodeJS.Timeout | null = null;
function stopLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
function startLoop() {
  stopLoop(); // never more than one timer
  timer = setInterval(() => {
    for (let k = 0; k < STEPS_PER_TICK && !sim.paused; k++) stepOnce(); // one model observation per step, even at high demo speed
    pushState();
  }, INTERVAL_MS);
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", simulated: true, time: new Date().toISOString() });
});

app.get("/api/floorplan", async (_req, res) => {
  try {
    res.json(await loadPlan());
  } catch (err) {
    console.error("Could not load floor plan:", (err as Error).message);
    res.status(500).json({ error: "Could not read the saved floor plan. See the server console." });
  }
});

app.put("/api/floorplan", express.json({ limit: "3mb" }), async (req, res) => {
  const result = validatePlan(req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  try {
    await savePlan(result.plan);
    syncZones();
    pushState();
    res.json(result.plan);
  } catch (err) {
    console.error("Could not save floor plan:", (err as Error).message);
    res.status(500).json({ error: "Could not write the floor plan file." });
  }
});

// Update one zone's limits. Invalid input is rejected BEFORE anything is written.
app.put("/api/zones/:id/limits", express.json({ limit: "10kb" }), async (req, res) => {
  const result = validateLimits(req.body);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  try {
    const zone = await updateZoneLimits(req.params.id, result.limits);
    if (!zone) {
      res.status(404).json({ error: "Zone not found." });
      return;
    }
    syncZones();
    pushState();
    res.json(zone);
  } catch (err) {
    console.error("Could not save zone limits:", (err as Error).message);
    res.status(500).json({ error: "Could not write the floor plan file." });
  }
});

// ---- simulation control (no UI yet: use curl, see README) ----
app.get("/api/sim", (_req, res) => {
  res.json({
    step: sim.step, intervalMs: INTERVAL_MS, stepsPerTick: STEPS_PER_TICK, ambientC: sim.ambientC,
    scenario: sim.getScenario(), zones: sim.zoneStats(), grid: sim.getGrid().map((v) => Math.round(v * 10) / 10),
  });
});
app.put("/api/sim/scenario", express.json({ limit: "100kb" }), (req, res) => {
  const r = validateScenario(req.body);
  if (!r.ok) return void res.status(400).json({ error: r.error });
  sim.setScenario(r.value);
  resetForecasts();
  rehearse();
  if (alerts.resolveAll("scenario reset").length) announceAlerts();
  pushState();
  res.json(sim.getScenario());
});
// Reset: temperatures back to the scenario baseline, step 0, runtime fires and failed coolers removed.
// Alert HISTORY is kept (active alerts are closed as "scenario reset"); use DELETE /api/alerts to clear history.
app.post("/api/sim/reset", (_req, res) => {
  sim.reset();
  resetForecasts();
  monitor.resetRuns();
  monitor.observe(sim);
  if (alerts.resolveAll("scenario reset").length) announceAlerts();
  pushState();
  res.json({ ok: true, message: "Simulation reset to baseline. Alert history was kept." });
});
const zoneName = (id: string) => sim.getZones().find((z) => z.id === id)?.name ?? id;
const small = express.json({ limit: "10kb" });
const zoneIds = () => sim.zoneIds();
app.post("/api/sim/heat-source", small, (req, res) => {
  const r = validateSource(req.body);
  if (!r.ok) return void res.status(400).json({ error: r.error });
  if (r.value.zoneId !== undefined && !zoneIds().includes(r.value.zoneId)) return void res.status(400).json({ error: "Unknown zone id." });
  try {
    sim.addSource({ ...r.value, startStep: Math.max(r.value.startStep, sim.step) });
  } catch (err) {
    return void res.status(400).json({ error: (err as Error).message });
  }
  res.json(r.value);
});
app.delete("/api/sim/heat-sources", (_req, res) => {
  sim.clearRuntimeSources();
  res.json({ ok: true });
});
app.post("/api/sim/fire", small, (req, res) => {
  const r = validateFire(req.body, zoneIds());
  if (!r.ok) return void res.status(400).json({ error: r.error });
  try {
    sim.startFire(r.value.zoneId, r.value.targetC, r.value.strength);
  } catch (err) {
    return void res.status(400).json({ error: (err as Error).message });
  }
  pushState();
  res.json({ ok: true, message: `Fire started in ${zoneName(r.value.zoneId)}.` });
});
app.post("/api/sim/cooling-failure", small, (req, res) => {
  const r = validateFailure(req.body, zoneIds(), sim.cooledZoneIds());
  if (!r.ok) return void res.status(400).json({ error: r.error });
  sim.triggerFailure(r.value.zoneId, r.value.failureTempC);
  pushState();
  res.json({ ok: true, message: r.value.zoneId === "*" ? "Cooling failed in every cooled zone." : `Cooling failed in ${zoneName(r.value.zoneId)}.` });
});
app.post("/api/sim/set-temperature", small, (req, res) => {
  const r = validateSetTemperature(req.body, zoneIds());
  if (!r.ok) return void res.status(400).json({ error: r.error });
  sim.setZoneTemperature(r.value.zoneId, r.value.temperatureC);
  pushState();
  res.json({ ok: true, message: `${zoneName(r.value.zoneId)} set to ${r.value.temperatureC} °C. The simulation continues from there.` });
});
app.post("/api/sim/pause", (_req, res) => {
  sim.paused = true;
  pushState();
  res.json({ ok: true, message: "Simulation paused." });
});
app.post("/api/sim/resume", (_req, res) => {
  sim.paused = false;
  pushState();
  res.json({ ok: true, message: "Simulation resumed." });
});

// ---- predictive twin: forecast, what-if actions, root cause (all computed on forks of the live simulation) ----
const horizonSteps = (q: unknown, def = 30) => {
  const m = Number(q);
  const minutes = Number.isFinite(m) && m > 0 ? m : def;
  return Math.min(MAX_TWIN_STEPS, Math.max(1, Math.round(minutes / MINUTES_PER_STEP)));
};
app.get("/api/twin", (req, res) => {
  const steps = horizonSteps(req.query.minutes);
  res.json({ ...runTwin(sim, steps, { every: Math.max(1, Math.ceil(steps / 12)) }), minutes: steps * MINUTES_PER_STEP });
});
app.get("/api/twin/actions", (req, res) => {
  const steps = horizonSteps(req.query.minutes, 60);
  const ev = evaluateActions(sim, steps);
  res.json({ minutes: steps * MINUTES_PER_STEP, baseline: ev.baseline.zones, results: ev.results.slice(0, 8) });
});
app.get("/api/twin/causes", (req, res) => {
  const steps = horizonSteps(req.query.minutes, 60);
  const zoneId = typeof req.query.zoneId === "string" ? req.query.zoneId : "";
  const rep = explainCauses(sim, zoneId, steps);
  if (!rep) return void res.status(404).json({ error: "Unknown zone id." });
  res.json({ minutes: steps * MINUTES_PER_STEP, ...rep });
});
// Apply an action to the LIVE simulation (what the "Apply" button on a what-if result does).
app.post("/api/twin/apply", small, (req, res) => {
  const r = parseAction(req.body, sim);
  if (!r.ok) return void res.status(400).json({ error: r.error });
  const label = describeAction(sim, r.action);
  if (!applyAction(sim, r.action)) return void res.status(400).json({ error: "That action does not apply right now." });
  pushState();
  res.json({ ok: true, message: `${label}: done.${r.action.kind === "cooling" || r.action.kind === "vent" ? " It stays on until the simulation is reset." : ""}` });
});
app.post("/api/sim/link", small, (req, res) => {
  const b = (req.body ?? {}) as { linkId?: unknown; closed?: unknown };
  if (typeof b.linkId !== "string" || typeof b.closed !== "boolean" || !sim.setLinkClosed(b.linkId, b.closed)) return void res.status(400).json({ error: "Needs a known linkId and closed: true/false." });
  pushState();
  res.json({ ok: true, message: b.closed ? "Connection isolated: no heat travels through it." : "Connection reopened." });
});

// ---- machine patterns ----
app.get("/api/machines", (_req, res) => {
  res.json({ machines: sim.getScenario().sources.filter((s) => s.zoneId === undefined).map((s) => ({ id: s.id, name: s.name ?? s.id })) });
});
// Start a new working day: everything starts cold, and ONE machine runs normally, worn (weak) or runaway (overheat).
app.post("/api/sim/start-day", small, (req, res) => {
  const b = (req.body ?? {}) as { machineId?: unknown; mode?: unknown };
  const mode = b.mode === "weak" || b.mode === "overheat" || b.mode === "normal" ? b.mode : null;
  if (!mode) return void res.status(400).json({ error: 'mode must be "normal", "weak" or "overheat".' });
  const sc = sim.getScenario();
  const machines = sc.sources.filter((s) => s.zoneId === undefined);
  if (!machines.length) return void res.status(400).json({ error: "There are no machines yet. Load the factory demo first (Heatmap tab)." });
  const target = typeof b.machineId === "string" ? machines.find((m) => m.id === b.machineId) : machines[Math.floor(machines.length / 2)];
  if (!target) return void res.status(400).json({ error: "Unknown machine." });
  const eff = mode === "weak" ? 0.5 : mode === "overheat" ? 1.8 : 1;
  sim.setScenario({ ...sc, sources: sc.sources.map((s) => { const { efficiency: _drop, ...rest } = s; return s.id === target.id && eff !== 1 ? { ...rest, efficiency: eff } : rest; }) });
  resetForecasts();
  monitor.resetRuns();
  monitor.observe(sim);
  if (alerts.resolveAll("scenario reset").length) announceAlerts();
  pushState();
  const what = mode === "normal" ? "normally" : mode === "weak" ? "at about 50% output (worn)" : "at about 180% output (runaway)";
  res.json({ ok: true, message: `A new day starts. ${target.name ?? target.id} runs ${what}. The monitor compares every minute with its learned pattern.` });
});
// Fast-forward factory time (e.g. to the end of the 30-minute window).
app.post("/api/sim/fast-forward", small, (req, res) => {
  const m = Number((req.body ?? {}).minutes);
  const n = Number.isFinite(m) ? Math.min(120, Math.max(1, Math.round(m / MINUTES_PER_STEP))) : 0;
  if (!n) return void res.status(400).json({ error: "minutes must be a number between 1 and 120." });
  if (sim.paused) return void res.status(400).json({ error: "The simulation is paused." });
  for (let k = 0; k < n; k++) stepOnce();
  pushState();
  res.json({ ok: true, message: `Advanced ${n * MINUTES_PER_STEP} minutes of factory time.` });
});

// ---- alert history ----
app.get("/api/alerts", (_req, res) => {
  res.json({ alerts: alerts.recent(alerts.list().length) });
});
app.delete("/api/alerts", (_req, res) => {
  const removed = alerts.clearHistory();
  announceAlerts();
  res.json({ ok: true, removed, message: `Cleared ${removed} resolved alert(s). Active alerts were kept.` });
});

// Turns malformed JSON / oversized bodies into clean JSON errors.
app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status === 500) console.error("Unexpected error:", err);
  res.status(status).json({ error: status === 413 ? "Request too large." : status === 500 ? "Server error." : "Invalid request." });
});

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.emit("state", lastState ?? current()); // send immediately so the UI doesn't wait 1s
  socket.emit("alerts", alertsMessage());
  socket.on("disconnect", () => console.log(`Client disconnected: ${socket.id}`));
});

httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process or change PORT in server/.env.`);
  } else {
    console.error("Server error:", err.message);
  }
  stopLoop();
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`Thermal Guard server running on http://localhost:${PORT} (simulated data)`);
  console.log(`Floor plan file: ${PLAN_FILE}`);
  console.log(`Simulation: ${STEPS_PER_TICK} step(s) every ${INTERVAL_MS} ms`);
  // start stepping only once the saved plan is known, so a fresh run always begins from the same initial state
  Promise.all([
    loadPlan().then(syncZones, (err) => console.error("Could not load floor plan:", (err as Error).message)),
    loadAlertHistory().then((h) => alerts.load(h), (err) => console.error("Could not load alert history:", (err as Error).message)),
  ])
    .finally(() => {
      pushState();
      startLoop();
    });
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down...`);
  stopLoop();
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
