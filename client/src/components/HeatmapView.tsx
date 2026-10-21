import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as RPointerEvent } from "react";
import type { FloorPlanConfig, StateMessage, ZoneStatus } from "../../../shared/types";
import { PLAN_WIDTH, PLAN_HEIGHT, SIM_COLS, SIM_ROWS, validatePlan, clamp } from "../../../shared/floorplan";
import { cellOwners, colourPositions, heatRgb, type HeatMode } from "../../../shared/heat";
import { TEMPLATES } from "../templates";
import { FACTORY_DEMO_SCENARIO } from "../demo";
import { FactoryScene, type Probe } from "../factory3d/FactoryScene";

const STATUS_COLOUR: Record<ZoneStatus, string> = { normal: "#3fb68b", warning: "#e0a43a", critical: "#ff5a5f" };
const STATUS_TEXT: Record<ZoneStatus, string> = { normal: "OK", warning: "WARNING", critical: "CRITICAL" };

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FactoryScene | null>(null);
  const cellCanvas = useRef<HTMLCanvasElement | null>(null); // one pixel per simulation cell, scaled up smoothly

  // Zone geometry is not part of the live message, so load the saved plan and reload it when the zones change.
  const zoneSig = (state?.zones ?? []).map((z) => `${z.id}:${z.name}:${z.minC}:${z.maxC}`).join("|");
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
  const grid = state?.grid;
  const valid = grid && grid.cols === SIM_COLS && grid.rows === SIM_ROWS && grid.values.length === SIM_COLS * SIM_ROWS;
  const colours = useMemo(() => (valid ? colourPositions(grid!.values, zones, owners, mode) : null), [grid, plan, mode]);

  useEffect(() => {
    const c = canvasRef.current;
    const ctx = view === "2d" ? c?.getContext("2d") : null;
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.max(1, Math.round((width * dpr * PLAN_HEIGHT) / PLAN_WIDTH));
    const k = c.width / PLAN_WIDTH;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = "#0b1115";
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

    // 2. zone walls, status colour and labels
    const live = new Map((state?.zones ?? []).map((z) => [z.id, z]));
    for (const z of zones) {
      const lz = live.get(z.id);
      const status = lz?.status ?? "normal";
      ctx.strokeStyle = STATUS_COLOUR[status];
      ctx.lineWidth = status === "normal" ? 2.5 : 5;
      ctx.strokeRect(z.x, z.y, z.w, z.h);
      if (!labels) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(z.x, z.y, z.w, z.h);
      ctx.clip();
      const line1 = z.name;
      const line2 = lz ? `${lz.temperatureC.toFixed(1)} °C  (max ${lz.maxCellC.toFixed(1)})` : "";
      const line3 = lz && status !== "normal" ? `${status === "critical" ? "✖" : "▲"} ${STATUS_TEXT[status]}` : "";
      ctx.font = "700 14px 'Segoe UI', sans-serif";
      const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width, ctx.measureText(line3).width) + 12;
      const h = line3 ? 56 : 40;
      ctx.fillStyle = "rgba(8,14,18,.72)";
      ctx.fillRect(z.x + 6, z.y + 6, Math.min(w, z.w - 12), h);
      ctx.fillStyle = "#f2f7f9";
      ctx.fillText(line1, z.x + 12, z.y + 23);
      ctx.font = "600 12px 'Segoe UI', sans-serif";
      ctx.fillStyle = "#d3e0e5";
      ctx.fillText(line2, z.x + 12, z.y + 39);
      if (line3) { ctx.fillStyle = STATUS_COLOUR[status]; ctx.fillText(line3, z.x + 12, z.y + 54); }
      ctx.restore();
    }

    // 3. markers: fires and failed coolers come from the live simulator status
    for (const f of state?.sim?.fires ?? []) {
      const z = zones.find((q) => q.id === f.zoneId);
      if (!z) continue;
      ctx.font = "26px 'Segoe UI Emoji', sans-serif";
      ctx.fillText("🔥", z.x + z.w / 2 - 13, z.y + z.h / 2 + 9);
    }
    for (const id of state?.sim?.failedCoolers ?? []) {
      const z = zones.find((q) => q.id === id);
      if (!z) continue;
      ctx.font = "700 12px 'Segoe UI', sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText("❄ COOLER FAILED", z.x + 12, z.y + z.h - 12);
    }
    for (const ex of plan?.exits ?? []) {
      ctx.save();
      ctx.translate(ex.x, ex.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#4cc3ff";
      ctx.fillRect(-7, -7, 14, 14);
      ctx.restore();
    }
  }, [colours, plan, width, labels, state?.sim, state?.zones, view]);

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
  useEffect(() => { sceneRef.current?.setPlan(plan, owners); sceneRef.current?.update(state, colours); }, [plan, owners, view]);
  useEffect(() => { sceneRef.current?.update(state, colours); }, [state, colours, view]);

  function onMove(ev: RPointerEvent<HTMLCanvasElement>) {
    if (!valid) return setProbe(null);
    const r = ev.currentTarget.getBoundingClientRect();
    const px = clamp(((ev.clientX - r.left) / r.width) * PLAN_WIDTH, 0, PLAN_WIDTH - 1e-6);
    const py = clamp(((ev.clientY - r.top) / r.height) * PLAN_HEIGHT, 0, PLAN_HEIGHT - 1e-6);
    const col = Math.floor((px / PLAN_WIDTH) * SIM_COLS), row = Math.floor((py / PLAN_HEIGHT) * SIM_ROWS);
    const i = row * SIM_COLS + col;
    const zone = owners[i] >= 0 ? zones[owners[i]] : undefined;
    setProbe({ x: ev.clientX - r.left, y: ev.clientY - r.top, text: `${grid!.values[i].toFixed(1)} °C · ${zone?.name ?? "open floor"}` });
  }

  async function send(path: string, method: string, body: unknown) {
    const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  }
  async function loadDemo() {
    const t = TEMPLATES.find((x) => x.key === "factory")!;
    if (zones.length && !window.confirm("This replaces your current zones with the Factory template and starts a machine simulation. Continue?")) return;
    setBusy(true);
    setNote(null);
    try {
      const b = t.build();
      await send("/api/floorplan", "PUT", { version: 2, zones: b.zones, exits: b.exits, background: plan?.background ?? null });
      await send("/api/sim/scenario", "PUT", FACTORY_DEMO_SCENARIO);
      await loadPlan();
      setNote({ kind: "ok", text: "Factory demo running: machines heat the assembly line, paint booth and packaging." });
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

  if (state && state.zones.length === 0)
    return (
      <section className="heat-empty">
        <p className="empty">No zones yet, so there is nothing to heat. Draw zones in the Floor plan tab, or start the ready-made demo.</p>
        <button className="btn on" disabled={busy} onClick={loadDemo}>Load factory demo</button>
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
        <button className="btn" disabled={busy} onClick={loadDemo}>Load factory demo</button>
        <button className="btn" disabled={busy} onClick={clearMachines}>Remove machines</button>
      </div>
      {note && <p className={note.kind === "ok" ? "field-ok" : "field-error"} role={note.kind === "ok" ? "status" : "alert"}>{note.kind === "ok" ? "✔ " : "✖ "}{note.text}</p>}

      {glError && <p className="field-error" role="alert">3D view is not available in this browser ({glError}). Showing the 2D map instead.</p>}
      {view === "3d" ? (
        <div className="stage3d" ref={stageRef} onPointerMove={(e) => setProbe(sceneRef.current?.probe(e.clientX, e.clientY) ?? null)} onPointerLeave={() => setProbe(null)} aria-label="3D factory model with live temperatures">
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
        Zone status shows as a text label and a beacon (green OK, amber warning, red critical). {view === "3d" ? "Drag to orbit, scroll to zoom, right-drag to pan. Machines glow when the floor under them runs hot. Hover the floor for a cell's temperature." : "Hover the map for the temperature of any cell."}
      </p>
      {!state && <p className="empty">Waiting for the first reading from the server…</p>}
    </section>
  );
}
