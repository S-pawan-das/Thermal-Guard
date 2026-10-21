# Thermal Guard — Milestone 1

Simulated temperature dashboard. React + Vite (client), Express + Socket.IO (server), shared types.
All data is SIMULATED; no real sensors.

```powershell
npm install        # once, from the thermal-guard folder
npm run dev        # starts server (3001) and client (5173)
```
Open http://localhost:5173. Stop with Ctrl+C.

Optional: copy `server\.env.example` to `server\.env` to change the port.
Other scripts: `npm run typecheck`, `npm run build`, `npm start` (server build only).

## Milestone 2 — Floor-plan editor
Open the **Floor plan** tab. Tools: Select/move, Draw zone, Add exit; template buttons; optional background image (PNG/JPEG/WebP, max 2 MB).
Changes autosave to `server/data/floorplan.json` (git-ignored) through `GET/PUT /api/floorplan`.

**Coordinates:** fixed logical plan of 1000 × 600 units, origin top-left. The future simulation grid uses 10-unit cells (100 × 60); zone edges snap to it.
See `shared/floorplan.ts`. Static zone config (`PlanZone`) is separate from live readings (`Zone`); link them by `id` later.

Automated checks (validation, templates, storage): `npm test`

## Milestone 3 — Per-zone temperature limits
Select a zone in the Floor plan tab and use **Temperature limits**: type (general / hot process / cold storage), min °C, max °C and warning margin °C.
Rules (same for every zone, `validateLimits` in `shared/floorplan.ts`): finite numbers between -100 and 1000, min < max, and 0 <= warning margin < half the range.
**Save limits** sends `PUT /api/zones/:id/limits`; the server validates first, so a rejected save leaves the last valid values untouched.
A successful save is pushed to the dashboard immediately. Zone type is a label only; status uses one rule (`statusFor`) for all zones.
Floor plans saved by Milestone 2 are upgraded on load with default limits (general, 15–30 °C, warning margin 2 °C).

## Milestone 4 — Thermal grid simulator (demo model, not realistic fire physics)
`server/src/thermal.ts` holds a 40 × 25 grid on the same 1000 × 600 plan coordinates (cell = 25 × 24 plan units).
Zone temperatures come from the cells each zone overlaps: **max cell** = heat risk, **min cell** = cold risk, **average** = display.
Dashboard status uses the worse of the coldest and hottest cell against the zone's limits.

| Setting | Default | Allowed | Effect |
|---|---|---|---|
| `ambientC` | 22 | -50…60 | room temperature everything relaxes toward |
| `diffusion` | 0.15 | 0…**0.2** | heat spreading per step. Explicit 2-D diffusion is stable up to 0.25; capped at 0.2 for margin. Spread ≈ √(2·diffusion·steps) cells |
| `ambientRate` | 0.005 | 0…0.2 | per-step pull to ambient. Time constant ≈ 1/rate steps (200 steps) |
| `wallConductance` | 0.02 | 0…1 | heat crossing between different zones (or zone and open floor). 0 = sealed, 1 = no walls. Doors are not modelled |
| `failureRate` | 0.004 | 0…0.2 | how fast a failed cooler's zone drifts toward `failureTempC` (or ambient) |

Cold-storage zones get a cooler holding the middle of their limits (strength 0.2 per step). Heat sources pull one cell toward `targetC` (strength 0–1 per step) and never exceed it.

**Demo speed** = steps per update × updates per second. Set in `server/.env`: `SIM_INTERVAL_MS` (100–10000, default 1000) and `SIM_STEPS_PER_TICK` (1–50, default 1).
With the defaults a cold room warms past its max limit about 15 s after a failure and is near ambient after ~3 minutes. `SIM_STEPS_PER_TICK=5` makes everything 5× faster without changing the numerics.

Control with curl (PowerShell; replace `ZONEID`):
```powershell
curl.exe http://localhost:3001/api/sim
curl.exe -X POST http://localhost:3001/api/sim/cooling-failure -H "Content-Type: application/json" -d "{\"zoneId\":\"ZONEID\"}"
curl.exe -X POST http://localhost:3001/api/sim/heat-source -H "Content-Type: application/json" -d "{\"id\":\"fire1\",\"zoneId\":\"ZONEID\",\"targetC\":300,\"strength\":0.3}"
curl.exe -X POST http://localhost:3001/api/sim/reset
```
`PUT /api/sim/scenario` replaces the whole scenario (seed, params, scheduled sources/failures) and restarts at step 0; `reset` returns to the start of the current scenario.

## Milestone 5 — Alerts and simulator controls
**Alert rules** (`server/src/alerts.ts`, evaluated on the server from the live zone readings; nothing is ever invented):
high side uses the hottest cell, low side the coldest cell, with the same logic. `m` = distance to the limit.
`m < 0` → **critical** (exactly at the limit is still allowed); `m < warnMarginC` → **warning**.
**Hysteresis** (`ALERT_HYSTERESIS_C`, default 0.3 °C): an alert only steps down once `m` improves by that much more, so a reading wobbling around a threshold does not flicker.
**Deduplication/cooldown** (`ALERT_COOLDOWN_MS`, default 60000): one active alert per zone, side and severity; identical updates do nothing. If the same alert recovered less than the cooldown ago it is re-opened (same id, "seen N×") instead of adding a new row.
Alerts are kept in `server/data/alerts.json` (git-ignored; last 500). Alerts still active when the server stops are closed as "server restart".

**Reset semantics:** reset restores the baseline (step 0, scenario start temperatures, no runtime fires, no failed coolers; the paused/running state is left as it is). **Alert history is kept**; active alerts are closed as "scenario reset". Clear history separately with "Clear resolved history" (`DELETE /api/alerts`; active alerts stay).

| Endpoint | Body | Notes |
|---|---|---|
| `GET /api/alerts` | | full history, newest first |
| `DELETE /api/alerts` | | removes resolved alerts only |
| `POST /api/sim/fire` | `{zoneId, targetC?=300, strength?=0.3}` | one fire per zone; unknown zone → 400 |
| `POST /api/sim/cooling-failure` | `{zoneId?="*", failureTempC?}` | only zones with a cooler (cold-storage); unknown zone → 400 |
| `POST /api/sim/set-temperature` | `{zoneId, temperatureC}` | finite, -100…1000; sets every cell the zone covers once |
| `POST /api/sim/pause` / `resume` | | |
| `POST /api/sim/reset` | | see above |

Responses are `{ok:true,message}` or `{error}` with HTTP 400. Socket.IO: `state` (now also carries `sim`: paused, step, scenario, fires, failedCoolers, baseline) and the new `alerts` event (`{alerts: AlertRecord[]}`, sent on connect and whenever an alert changes).
Sound is off until you click "Enable alert sound" (browsers block autoplay); everything works without it.
Note: `POST /api/sim/cooling-failure` now rejects unknown zone ids (it used to accept anything).

## Milestone 6 — Factory heatmap
New **Heatmap** tab: the live 40 × 25 thermal grid drawn as a smooth colour field over the floor plan (blue = cool, green = in range, red = hot).
- The server now sends the whole grid with every `state` message (`grid: {cols, rows, values}`, °C rounded to 0.1; about 5 KB per update).
- **Scale:** "Relative to zone limits" colours each cell by where it sits between its own zone's min and max limit (0.15 = min limit, 0.85 = max limit, saturated beyond), so a cold room and a paint booth both read green when in range. "Absolute °C" uses one scale for the whole floor. Colour logic: `shared/heat.ts` (tested in `server/test/heat.check.ts`).
- Zone outlines take the status colour (green / amber / red) and carry a text label with average and hottest-cell temperature, so status never depends on colour alone. Fires and failed coolers are marked.
- **3D model** (default, three.js; `client/src/factory3d/FactoryScene.ts`): a real 3D factory you can orbit (drag), zoom (scroll) and pan (right-drag). Walls with doorways, conveyors that move, machines, ovens and tanks, storage racks, pallets and desks are drawn per zone from its name/type (`shared/equipment.ts`; visual only, no thermal effect). The floor is the live heat field; machines glow when the floor under them is hot; each zone has a floating label with temperature and status plus a beacon; fires show as flames. Hover the floor for a cell's temperature. **2D map** is the flat version; it is also the fallback if the browser has no WebGL.
- **Load factory demo** replaces the plan with the Factory template and starts a "running factory" scenario: ten machines (assembly line, paint-booth ovens, heat-sealers, dock equipment) that keep radiating heat. They use the existing heat-source engine (`client/src/demo.ts`). **Remove machines** returns to the plain ambient scenario.

Still a teaching/demo model: heat spreads by diffusion, with no airflow, ventilation or HVAC, and the machine positions are fixed.

## Milestone 7 — AI early warning (trained model)
A small neural network, trained from scratch on simulated incidents, forecasts for every zone whether it will leave its limits within the next 30 steps. Details, commands and honest test results: **`ml/README.md`** and `ml/RESULTS.md`.
- The server feeds the model one reading per zone per simulation step (even at high demo speed) and adds `ai: {risk, alert, horizon}` to each zone in the `state` message. Zone cards show an "AI forecast" bar with a text status (Stable / EARLY WARNING / OUT OF RANGE); the 3D labels show "AI EARLY WARNING".
- Reset, a new scenario, a new floor plan, or edited limits clear the model's history, so it never reasons from stale readings. The model stays quiet for the first 12 steps of history.
- Retrain with `npm run ml:train`, re-test with `npm run ml:eval`.
- **Bug fix in the simulator:** a zone is now measured (and a cold room cooled) on the grid cells whose centre lies inside it. Before, cells merely overlapping its edge counted, so any cold-storage zone whose edges were not on the 25 × 24 cell grid read about room temperature at its edge and showed "critical" from the first second.
