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
