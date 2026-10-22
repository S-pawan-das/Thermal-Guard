import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as RPointerEvent } from "react";
import type { FloorPlanConfig, LinkKind, StateMessage, ZoneStatus } from "../../../shared/types";
import {
  PLAN_WIDTH, PLAN_HEIGHT, SIM_COLS, SIM_ROWS, SIM_CELL_W, SIM_CELL_H, validatePlan, clamp, regionOutline, zoneMiddle, statusForCells, LINK_LABEL,
} from "../../../shared/floorplan";
import { cellOwners, colourPositions, heatRgb, type HeatMode } from "../../../shared/heat";
import { TEMPLATES } from "../templates";
import { FACTORY_DEMO_SCENARIO, HALL_DEMO_SCENARIO } from "../demo";
import { FactoryScene, type Probe } from "../factory3d/FactoryScene";
import { fmtMinutes, getJson, type TwinResponse } from "../twinApi";
import Icon from "./icons";

const STATUS_COLOUR: Record<ZoneStatus, string> = { normal: "#0f9d68", warning: "#d98f00", critical: "#d6264a" };
const STATUS_TEXT: Record<ZoneStatus, string> = { normal: "OK", warning: "WARNING", critical: "CRITICAL" };
const LINK_COLOUR: Record<LinkKind, string> = { pipe: "#1d6fb8", duct: "#7a5cc7", conveyor: "#5b6470", door: "#e8590c" };
const LINK_DASH: Record<LinkKind, number[]> = { pipe: [10, 6], duct: [3, 6], conveyor: [16, 6], door: [] };
const HORIZON_MIN = 60;

type View = "3d" | "2d";
type Note = { kind: "ok" | "error"; text: string } | null;

export default function HeatmapView({ state }: { state: StateMessage | null }) {
  const [plan, setPlan] = useState<FloorPlanConfig | null>(null);
  const [mode, setMode] = useState<HeatMode>("limits");
  const [view, setView] = useState<View>("3d");
  const [glError, setGlError] = useState<string | null>(null);
  const [labels, setLabels] = useState(true);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(900);
  const [ahead, setAhead] = useState(0); // minutes into the future shown on the floor; 0 = live
  const [playing, setPlaying] = useState(false);
  const [twin, setTwin] = useState<TwinResponse | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FactoryScene | null>(null);
  const cellCanvas = useRef<HTMLCanvasElement | null>(null); // one pixel per simulation cell, scaled up smoothly

  // Zone geometry is not part of the live message, so load the saved plan and reload it when the zones change.
  const zoneSig = (state?.zones ?? []).map((z) => `${z.id}:${z.name}:${z.minC}:${z.maxC}`).join("|") + "|" + (state?.links ?? []).map((l) => l.id).join(",");
  const loadPlan = async () => {
    try {
      const res = await fetch("/api/floorplan");
      const v = validatePlan(await res.json());
      if (res.ok && v.ok) setPlan(v.plan);
    } catch {
      /* keep the last plan; the heatmap still draws */
    }
  };
  useEffect(() => { void loadPlan(); }, [zoneSig]);

  // The twin: the simulator forked at this moment and run forward. Refreshed every few seconds.
  useEffect(() => {
    let dead = false;
    const pull = () => getJson<TwinResponse>(`/api/twin?minutes=${HORIZON_MIN}`).then((t) => { if (!dead) setTwin(t); }, () => undefined);
    void pull();
    const t = setInterval(pull, 4000);
    return () => { dead = true; clearInterval(t); };
  }, [zoneSig]);

  // play the forecast like a video
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setAhead((a) => (a >= HORIZON_MIN ? 0 : Math.min(HORIZON_MIN, a + 5))), 650);
    return () => clearInterval(t);
  }, [playing]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [view]);

  const zones = plan?.zones ?? [];
  const owners = useMemo(() => cellOwners(zones), [plan]);
  const frame = useMemo(() => {
    if (!ahead || !twin) return null;
    const want = ahead / twin.minutesPerStep;
    return twin.frames.reduce((best, f) => (Math.abs(f.inSteps - want) < Math.abs(best.inSteps - want) ? f : best), twin.frames[0]);
  }, [ahead, twin]);
  const predicting = ahead > 0 && !!frame;
  const gridValues = predicting ? frame!.grid : state?.grid?.values;
  const valid = !!gridValues && gridValues.length === SIM_COLS * SIM_ROWS && state?.grid?.cols === SIM_COLS && state?.grid?.rows === SIM_ROWS;
  const colours = useMemo(() => (valid ? colourPositions(gridValues!, zones, owners, mode) : null), [gridValues, valid, plan, mode]);

  // per-zone figures for labels and outlines: live from the server, predicted from the chosen frame
  const zoneView = useMemo(() => {
    const live = new Map((state?.zones ?? []).map((z) => [z.id, z]));
    return zones.map((z, zi) => {
      const lz = live.get(z.id);
      if (!predicting || !valid) return { status: (lz?.status ?? "normal") as ZoneStatus, avg: lz?.temperatureC, max: lz?.maxCellC, ai: !!lz?.ai?.alert };
      let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
      for (let i = 0; i < owners.length; i++) if (owners[i] === zi) { const v = gridValues![i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; n++; }
      return n ? { status: statusForCells(mn, mx, z), avg: sum / n, max: mx, ai: false } : { status: "normal" as ZoneStatus, avg: undefined, max: undefined, ai: false };
    });
  }, [plan, state?.zones, predicting, valid, gridValues, owners]);

  useEffect(() => {
    const c = canvasRef.current;
    const ctx = view === "2d" ? c?.getContext("2d") : null;
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.max(1, Math.round((width * dpr * PLAN_HEIGHT) / PLAN_WIDTH));
    const k = c.width / PLAN_WIDTH;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = "#eceff2";
    ctx.fillRect(0, 0, PLAN_WIDTH, PLAN_HEIGHT);

    // 1. the heat field: one pixel per cell, stretched with smoothing so it reads as a continuous field
    if (colours) {
      const off = (cellCanvas.current ??= document.createElement("canvas"));
      off.width = SIM_COLS;
      off.height = SIM_ROWS;
      const octx = off.getContext("2d")!;
      const img = octx.createImageData(SIM_COLS, SIM_ROWS);
      for (let i = 0; i < SIM_COLS * SIM_ROWS; i++) {
        const [r, g, b] = heatRgb(colours.u[i]);
        img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(off, 0, 0, PLAN_WIDTH, PLAN_HEIGHT);
    }

    // 2. connections (pipes, ducts, conveyors, doors), coloured by danger
    const byId = new Map(zones.map((z) => [z.id, z]));
    const linkState = new Map((state?.links ?? []).map((l) => [l.id, l]));
    for (const l of plan?.links ?? []) {
      const za = byId.get(l.a), zb = byId.get(l.b);
      if (!za || !zb) continue;
      const a = zoneMiddle(za), b = zoneMiddle(zb), ls = linkState.get(l.id);
      const colour = ls?.closed ? "#aab4bd" : ls?.danger === "spread" ? "#d6264a" : ls?.danger === "watch" ? "#d98f00" : LINK_COLOUR[l.kind];
      ctx.save();
      ctx.setLineDash(ls?.closed ? [4, 8] : LINK_DASH[l.kind]);
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = colour; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.fillStyle = "#fff"; ctx.strokeStyle = colour; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(mx, my, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = colour; ctx.font = "800 12px 'Segoe UI', sans-serif"; ctx.textAlign = "center";
      ctx.fillText(ls?.closed ? "✕" : ls?.danger === "spread" ? "!" : LINK_LABEL[l.kind][0], mx, my + 4);
      ctx.restore();
    }

    // 3. zone walls (or the outline of a painted region), status colour and labels
    zones.forEach((z, zi) => {
      const zv = zoneView[zi];
      const status = zv?.status ?? "normal";
      ctx.strokeStyle = STATUS_COLOUR[status];
      ctx.lineWidth = status === "normal" ? 2.5 : 5;
      if (z.cells) {
        ctx.beginPath();
        for (const [x0, y0, x1, y1] of regionOutline(z.cells)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
        ctx.stroke();
      } else ctx.strokeRect(z.x, z.y, z.w, z.h);
      if (!labels) return;
      ctx.save();
      ctx.beginPath();
      if (z.cells) ctx.rect(0, 0, PLAN_WIDTH, PLAN_HEIGHT); else ctx.rect(z.x, z.y, z.w, z.h);
      ctx.clip();
      const line1 = z.name;
      const line2 = zv?.avg !== undefined && zv.max !== undefined ? `${predicting ? "≈ " : ""}${zv.avg.toFixed(1)} °C  (max ${zv.max.toFixed(1)})` : "";
      const line3 = zv && status !== "normal" ? `${status === "critical" ? "✖" : "▲"} ${predicting ? "WILL BE " : ""}${STATUS_TEXT[status]}` : zv?.ai ? "✦ AI EARLY WARNING" : "";
      ctx.font = "700 14px 'Segoe UI', sans-serif";
      const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width, ctx.measureText(line3).width) + 12;
      const h = line3 ? 56 : 40;
      const m = z.cells ? zoneMiddle(z) : null;
      const bx = m ? m.x - w / 2 : z.x + 6, by = m ? m.y - h / 2 : z.y + 6;
      ctx.fillStyle = "rgba(255,255,255,.9)";
      ctx.fillRect(bx, by, z.cells ? w : Math.min(w, z.w - 12), h);
      ctx.textAlign = "start";
      ctx.fillStyle = "#1d2025";
      ctx.fillText(line1, bx + 6, by + 17);
      ctx.font = "600 12px 'Segoe UI', sans-serif";
      ctx.fillStyle = "#5b6470";
      ctx.fillText(line2, bx + 6, by + 33);
      if (line3) { ctx.fillStyle = status === "normal" ? "#b57f00" : STATUS_COLOUR[status]; ctx.fillText(line3, bx + 6, by + 48); }
      ctx.restore();
    });

    // 4. markers: fires and failed coolers come from the live simulator status
    ctx.textAlign = "start";
    for (const f of state?.sim?.fires ?? []) {
      const z = zones.find((q) => q.id === f.zoneId);
      if (!z) continue;
      const m = zoneMiddle(z);
      ctx.font = "26px 'Segoe UI Emoji', sans-serif";
      ctx.fillText("🔥", m.x - 13, m.y + 9);
    }
    for (const id of state?.sim?.failedCoolers ?? []) {
      const z = zones.find((q) => q.id === id);
      if (!z) continue;
      const m = zoneMiddle(z);
      ctx.font = "700 12px 'Segoe UI', sans-serif";
      ctx.fillStyle = "#1d6fb8";
      ctx.fillText("❄ COOLER FAILED", z.cells ? m.x - 50 : z.x + 12, z.cells ? m.y + 40 : z.y + z.h - 12);
    }
    for (const ex of plan?.exits ?? []) {
      ctx.save();
      ctx.translate(ex.x, ex.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#1d6fb8";
      ctx.fillRect(-7, -7, 14, 14);
      ctx.restore();
    }
    if (predicting) {
      ctx.font = "800 22px 'Segoe UI', sans-serif";
      ctx.fillStyle = "rgba(29,32,37,.75)";
      ctx.fillText(`PREDICTION  +${fmtMinutes(ahead)}`, 16, PLAN_HEIGHT - 16);
    }
  }, [colours, plan, width, labels, state?.sim, state?.links, zoneView, view, predicting, ahead]);

  // ---- 3D scene: created once per visit to the 3D view, fed by the effects below ----
  useEffect(() => {
    if (view !== "3d" || !stageRef.current) return;
    let scene: FactoryScene;
    try {
      scene = new FactoryScene(stageRef.current);
    } catch (err) {
      setGlError((err as Error).message || "WebGL is not available.");
      setView("2d");
      return;
    }
    setGlError(null);
    sceneRef.current = scene;
    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(stageRef.current);
    return () => { ro.disconnect(); scene.dispose(); sceneRef.current = null; };
  }, [view]);
  useEffect(() => { sceneRef.current?.setPlan(plan, owners); sceneRef.current?.update(state, colours, predicting ? gridValues : undefined); }, [plan, owners, view]);
  useEffect(() => { sceneRef.current?.update(state, colours, predicting ? gridValues : undefined); }, [state, colours, view, predicting, gridValues]);

  function onMove(ev: RPointerEvent<HTMLCanvasElement>) {
    if (!valid) return setProbe(null);
    const r = ev.currentTarget.getBoundingClientRect();
    const px = clamp(((ev.clientX - r.left) / r.width) * PLAN_WIDTH, 0, PLAN_WIDTH - 1e-6);
    const py = clamp(((ev.clientY - r.top) / r.height) * PLAN_HEIGHT, 0, PLAN_HEIGHT - 1e-6);
    const col = Math.floor(px / SIM_CELL_W), row = Math.floor(py / SIM_CELL_H);
    const i = row * SIM_COLS + col;
    const zone = owners[i] >= 0 ? zones[owners[i]] : undefined;
    setProbe({ x: ev.clientX - r.left, y: ev.clientY - r.top, text: `${predicting ? "≈ " : ""}${gridValues![i].toFixed(1)} °C · ${zone?.name ?? "open floor"}` });
  }

  async function send(path: string, method: string, body: unknown) {
    const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  }
  async function loadDemo(key: "factory" | "hall") {
    const t = TEMPLATES.find((x) => x.key === key)!;
    if (zones.length && !window.confirm(`This replaces your current zones with the ${key === "hall" ? "open hall" : "Factory"} template and starts a machine simulation. Continue?`)) return;
    setBusy(true);
    setNote(null);
    setAhead(0);
    try {
      const b = t.build();
      await send("/api/floorplan", "PUT", { version: 2, zones: b.zones, exits: b.exits, links: b.links ?? [], background: plan?.background ?? null });
      await send("/api/sim/scenario", "PUT", key === "hall" ? HALL_DEMO_SCENARIO : FACTORY_DEMO_SCENARIO);
      await loadPlan();
      setNote({
        kind: "ok",
        text: key === "hall"
          ? "Open-hall demo running: areas are painted shapes with no walls. Machines heat the hall; open Insights to see what the twin predicts."
          : "Factory demo running: machines heat the assembly line, paint booth and packaging. Pipes and conveyors connect the rooms.",
      });
    } catch (err) {
      setNote({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function clearMachines() {
    setBusy(true);
    setNote(null);
    try {
      await send("/api/sim/scenario", "PUT", { name: "ambient" });
      setNote({ kind: "ok", text: "Machines removed. The floor relaxes back to ambient." });
    } catch (err) {
      setNote({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const range = colours?.range;
  const legend =
    mode === "limits"
      ? ["at min limit", "mid-range", "at max limit"]
      : range ? [`${range.lo} °C`, `${Math.round((range.lo + range.hi) / 2)} °C`, `${range.hi} °C`] : ["", "", ""];
  const gradient = `linear-gradient(90deg, ${Array.from({ length: 12 }, (_, i) => `rgb(${heatRgb(i / 11).join(",")})`).join(",")})`;
  const breaches = (twin?.zones ?? []).filter((z) => z.breach).sort((a, b) => a.breach!.inSteps - b.breach!.inSteps);

  if (state && state.zones.length === 0)
    return (
      <section className="heat-empty">
        <p className="empty">No zones yet, so there is nothing to heat. Draw zones or paint regions in the Floor plan tab, or start a ready-made demo.</p>
        <div className="toolbar">
          <button className="btn on" disabled={busy} onClick={() => loadDemo("factory")}>Load factory demo</button>
          <button className="btn" disabled={busy} onClick={() => loadDemo("hall")}>Load open-hall demo</button>
        </div>
        {note && <p className={note.kind === "ok" ? "field-ok" : "field-error"}>{note.text}</p>}
      </section>
    );

  return (
    <section className="heatview">
      <div className="toolbar">
        <label className="inline">Scale
          <select value={mode} onChange={(e) => setMode(e.target.value as HeatMode)}>
            <option value="limits">Relative to zone limits</option>
            <option value="absolute">Absolute °C</option>
          </select>
        </label>
        <div className="seg" role="group" aria-label="View">
          <button className={`btn ${view === "3d" ? "on" : ""}`} onClick={() => { setView("3d"); setProbe(null); }}>3D model</button>
          <button className={`btn ${view === "2d" ? "on" : ""}`} onClick={() => { setView("2d"); setProbe(null); }}>2D map</button>
        </div>
        {view === "3d" && <button className="btn" onClick={() => sceneRef.current?.resetView()}>Reset view</button>}
        {view === "2d" && <button className={`btn ${labels ? "on" : ""}`} onClick={() => setLabels((v) => !v)}>Labels</button>}
        <span className="sep" />
        <button className="btn" disabled={busy} onClick={() => loadDemo("factory")}>Factory demo</button>
        <button className="btn" disabled={busy} onClick={() => loadDemo("hall")}>Open-hall demo</button>
        <button className="btn" disabled={busy} onClick={clearMachines}>Remove machines</button>
      </div>
      {note && <p className={note.kind === "ok" ? "field-ok" : "field-error"} role={note.kind === "ok" ? "status" : "alert"}>{note.kind === "ok" ? "✔ " : "✖ "}{note.text}</p>}

      <div className={`timeline ${predicting ? "on" : ""}`} aria-label="Prediction">
        <button className="round-btn" aria-label={playing ? "Pause forecast" : "Play forecast"} onClick={() => setPlaying((p) => !p)}><Icon name={playing ? "pause" : "play"} size={18} /></button>
        <div className="tl-body">
          <div className="tl-top">
            <b>{ahead === 0 ? "Live now" : `Prediction: +${fmtMinutes(ahead)}`}</b>
            <span>{ahead === 0 ? "Drag right to see where the heat goes next" : "Digital twin: the simulator run forward from this moment"}</span>
          </div>
          <input type="range" min={0} max={HORIZON_MIN} step={5} value={ahead} aria-label="Minutes ahead" onChange={(e) => { setAhead(Number(e.target.value)); setPlaying(false); }} />
          <div className="tl-ticks"><span>Now</span><span>+{HORIZON_MIN / 4} min</span><span>+{HORIZON_MIN / 2} min</span><span>+{(HORIZON_MIN * 3) / 4} min</span><span>+{HORIZON_MIN} min</span></div>
        </div>
      </div>
      <div className="forecast-chips" aria-live="polite">
        {breaches.length === 0 ? (
          <span className="chip-note good">✔ No zone is predicted to leave its limits in the next {HORIZON_MIN} min</span>
        ) : (
          breaches.slice(0, 4).map((z) => (
            <button key={z.id} className={`chip-note ${z.breach!.inSteps === 0 ? "bad" : "warn"}`} onClick={() => setAhead(Math.min(HORIZON_MIN, Math.max(5, Math.ceil((z.breach!.inSteps * twin!.minutesPerStep) / 5) * 5)))}>
              {z.breach!.inSteps === 0 ? "✖" : "▲"} {z.name}: {z.breach!.inSteps === 0 ? `already ${z.breach!.kind === "high" ? "above" : "below"} its limit` : `${z.breach!.kind === "high" ? "above" : "below"} its ${z.breach!.kind === "high" ? z.limitMaxC : z.limitMinC} °C limit in ${fmtMinutes(z.breach!.inSteps * twin!.minutesPerStep)}`}
            </button>
          ))
        )}
      </div>

      {glError && <p className="field-error" role="alert">3D view is not available in this browser ({glError}). Showing the 2D map instead.</p>}
      {view === "3d" ? (
        <div className="stage3d" ref={stageRef} onPointerMove={(e) => setProbe(sceneRef.current?.probe(e.clientX, e.clientY) ?? null)} onPointerLeave={() => setProbe(null)} aria-label="3D factory model with live temperatures">
          {predicting && <div className="pred-badge">PREDICTION · +{fmtMinutes(ahead)} · not live</div>}
          {probe && <div className="probe" style={{ left: probe.x + 12, top: probe.y + 12 }}>{probe.text}</div>}
        </div>
      ) : (
        <div ref={wrapRef} className="canvaswrap heatwrap">
          <canvas ref={canvasRef} onPointerMove={onMove} onPointerLeave={() => setProbe(null)} aria-label="Factory floor temperature heatmap" />
          {probe && <div className="probe" style={{ left: probe.x + 12, top: probe.y + 12 }}>{probe.text}</div>}
        </div>
      )}

      <div className="legend" aria-label="Colour scale">
        <div className="bar" style={{ background: gradient }} />
        <div className="ticks"><span>{legend[0]}</span><span>{legend[1]}</span><span>{legend[2]}</span></div>
      </div>
      <p className="hint">
        {mode === "limits"
          ? "Each cell is coloured by where it sits between its own zone's min and max limit, so a cold room and a paint booth both read green when they are in range."
          : "One °C scale for the whole floor, from the coldest to the hottest cell."}{" "}
        Zone status shows as a text label and a beacon (green OK, amber warning, red critical). Pipes, ducts and conveyors show where heat can travel; they turn red when a connected zone is in danger. {view === "3d" ? "Drag to orbit, scroll to zoom, right-drag to pan. Hover the floor for a cell's temperature." : "Hover the map for the temperature of any cell."}
      </p>
      {!state && <p className="empty">Waiting for the first reading from the server…</p>}
    </section>
  );
}
