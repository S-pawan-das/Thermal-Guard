import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, PointerEvent as RPointerEvent } from "react";
import type { ExitMarker, FloorPlanConfig, PlanZone, ZoneType } from "../../../shared/types";
import {
  PLAN_WIDTH, PLAN_HEIGHT, GRID_SIZE, MIN_ZONE_SIZE, MAX_ZONES, MAX_EXITS, MAX_NAME_LENGTH,
  clamp, snap, clampRect, checkName, validatePlan, validateLimits, DEFAULT_LIMITS, ZONE_TYPES, ZONE_TYPE_LABEL,
} from "../../../shared/floorplan";
import { TEMPLATES } from "../templates";

type Tool = "select" | "zone" | "exit";
type Sel = { kind: "zone" | "exit"; id: string } | null;
type Drag =
  | { mode: "draw"; x0: number; y0: number; x1: number; y1: number }
  | { mode: "move"; kind: "zone" | "exit"; id: string; dx: number; dy: number }
  | null;
type SaveState = "idle" | "saving" | "saved" | "error";

const TOOL_LABEL: Record<Tool, string> = { select: "Select / move", zone: "Draw zone", exit: "Add exit" };
const TOOL_HINT: Record<Tool, string> = {
  select: "Click a zone or exit to select it. Drag to move it.",
  zone: "Drag on the plan to draw a zone. Edges snap to the grid.",
  exit: "Click on the plan to place an exit marker.",
};
const SAVE_LABEL: Record<SaveState, string> = { idle: "No changes", saving: "Saving…", saved: "Saved", error: "Not saved" };
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function newId(prefix: string, taken: Set<string>) {
  let id: string;
  do id = `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  while (taken.has(id));
  return id;
}
function nextZoneName(zones: PlanZone[]) {
  const used = new Set(zones.map((z) => z.name.toLowerCase()));
  for (let n = 1; ; n++) if (!used.has(`zone ${n}`)) return `Zone ${n}`;
}

function parseTemp(text: string): number {
  const t = text.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN; // "", "NaN", "Infinity", "1e5", "0x10" all become NaN
}

type FormStatus = { kind: "idle" | "saving" | "saved" | "error"; text?: string };

// Edits one zone's temperature limits. Nothing in the plan changes until the server accepts the save.
function LimitsForm({ zone, blocked, onSaved }: { zone: PlanZone; blocked: boolean; onSaved: (z: PlanZone) => void }) {
  const [type, setType] = useState<ZoneType>(zone.type);
  const [min, setMin] = useState(String(zone.minC));
  const [max, setMax] = useState(String(zone.maxC));
  const [warn, setWarn] = useState(String(zone.warnMarginC));
  const [status, setStatus] = useState<FormStatus>({ kind: "idle" });

  // Re-sync the fields when the saved values change (after a save, or when a template is loaded).
  useEffect(() => {
    setType(zone.type);
    setMin(String(zone.minC));
    setMax(String(zone.maxC));
    setWarn(String(zone.warnMarginC));
  }, [zone.type, zone.minC, zone.maxC, zone.warnMarginC]);

  const candidate = { type, minC: parseTemp(min), maxC: parseTemp(max), warnMarginC: parseTemp(warn) };
  const check = validateLimits(candidate);
  const changed =
    type !== zone.type || candidate.minC !== zone.minC || candidate.maxC !== zone.maxC || candidate.warnMarginC !== zone.warnMarginC;
  const touch = () => setStatus({ kind: "idle" });

  async function save() {
    if (!check.ok) return;
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(`/api/zones/${encodeURIComponent(zone.id)}/limits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(check.limits),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onSaved(body as PlanZone);
      setStatus({ kind: "saved", text: "Saved." });
    } catch (err) {
      setStatus({ kind: "error", text: `Not saved: ${(err as Error).message} The last saved values are still in use.` });
    }
  }

  return (
    <div className="limits-form">
      <h3>Temperature limits</h3>
      <p className="saved-values">
        Saved: {zone.minC} to {zone.maxC} °C, warning margin {zone.warnMarginC} °C, {ZONE_TYPE_LABEL[zone.type]}
      </p>
      <label>
        Zone type
        <select value={type} onChange={(e) => { setType(e.target.value as ZoneType); touch(); }}>
          {ZONE_TYPES.map((t) => (
            <option key={t} value={t}>{ZONE_TYPE_LABEL[t]}</option>
          ))}
        </select>
      </label>
      <div className="row3">
        <label>
          Min °C
          <input inputMode="decimal" value={min} onChange={(e) => { setMin(e.target.value); touch(); }} />
        </label>
        <label>
          Max °C
          <input inputMode="decimal" value={max} onChange={(e) => { setMax(e.target.value); touch(); }} />
        </label>
        <label>
          Warn °C
          <input inputMode="decimal" value={warn} onChange={(e) => { setWarn(e.target.value); touch(); }} />
        </label>
      </div>
      {!check.ok && changed && <p className="field-error" role="alert">{check.error}</p>}
      {status.kind === "error" && <p className="field-error" role="alert">{status.text}</p>}
      {status.kind === "saved" && !changed && <p className="field-ok">{status.text}</p>}
      <button className="btn" disabled={!check.ok || !changed || blocked || status.kind === "saving"} onClick={save}>
        {status.kind === "saving" ? "Saving…" : "Save limits"}
      </button>
    </div>
  );
}

export default function FloorPlanEditor() {
  const [plan, setPlan] = useState<FloorPlanConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rev, setRev] = useState(0); // bumped on every user change; triggers autosave
  const [save, setSave] = useState<SaveState>("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [sel, setSel] = useState<Sel>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [draft, setDraft] = useState("");
  const [width, setWidth] = useState(900);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const planRef = useRef<FloorPlanConfig | null>(null);
  planRef.current = plan;

  const selZone = sel?.kind === "zone" ? plan?.zones.find((z) => z.id === sel.id) : undefined;
  const selExit = sel?.kind === "exit" ? plan?.exits.find((x) => x.id === sel.id) : undefined;

  const edit = (fn: (p: FloorPlanConfig) => FloorPlanConfig) => {
    setMsg(null);
    setPlan((p) => (p ? fn(p) : p));
    setRev((r) => r + 1);
  };

  // ---- load saved plan ----
  const load = async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/floorplan");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const v = validatePlan(body);
      if (!v.ok) throw new Error(v.error);
      setPlan(v.plan);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, []);

  // ---- autosave (debounced). Never runs if loading failed, so saved data can't be overwritten. ----
  useEffect(() => {
    if (rev === 0 || !plan) return;
    setSave("saving");
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/floorplan", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(planRef.current),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        setSave("saved");
      } catch (err) {
        setSave("error");
        setMsg(`Not saved: ${(err as Error).message}`);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [rev]);

  // ---- background image element ----
  const bg = plan?.background ?? null;
  useEffect(() => {
    if (!bg) {
      setImg(null);
      return;
    }
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = bg;
  }, [bg]);

  // ---- responsive size ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ---- drawing: everything is drawn in plan units; the transform scales to pixels ----
  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.max(1, Math.round((width * dpr * PLAN_HEIGHT) / PLAN_WIDTH));
    const k = c.width / PLAN_WIDTH;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = "#eceff2";
    ctx.fillRect(0, 0, PLAN_WIDTH, PLAN_HEIGHT);

    if (img) {
      const s = Math.min(PLAN_WIDTH / img.naturalWidth, PLAN_HEIGHT / img.naturalHeight);
      const w = img.naturalWidth * s;
      const h = img.naturalHeight * s;
      ctx.globalAlpha = 0.55;
      ctx.drawImage(img, (PLAN_WIDTH - w) / 2, (PLAN_HEIGHT - h) / 2, w, h);
      ctx.globalAlpha = 1;
    }

    ctx.lineWidth = 1 / k;
    for (let x = 0; x <= PLAN_WIDTH; x += GRID_SIZE) {
      ctx.strokeStyle = x % 50 === 0 ? "rgba(60,70,90,.20)" : "rgba(60,70,90,.07)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, PLAN_HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y <= PLAN_HEIGHT; y += GRID_SIZE) {
      ctx.strokeStyle = y % 50 === 0 ? "rgba(60,70,90,.20)" : "rgba(60,70,90,.07)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(PLAN_WIDTH, y);
      ctx.stroke();
    }

    for (const z of plan?.zones ?? []) {
      const on = sel?.kind === "zone" && sel.id === z.id;
      ctx.fillStyle = on ? "rgba(15,157,104,.28)" : "rgba(15,157,104,.13)";
      ctx.strokeStyle = on ? "#1d2025" : "#0f9d68";
      ctx.lineWidth = on ? 3 : 2;
      ctx.fillRect(z.x, z.y, z.w, z.h);
      ctx.strokeRect(z.x, z.y, z.w, z.h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(z.x, z.y, z.w, z.h);
      ctx.clip();
      ctx.fillStyle = "#1d2025";
      ctx.font = "600 15px 'Segoe UI', sans-serif";
      ctx.fillText(z.name, z.x + 8, z.y + 22);
      ctx.restore();
    }

    for (const ex of plan?.exits ?? []) {
      const on = sel?.kind === "exit" && sel.id === ex.id;
      ctx.save();
      ctx.translate(ex.x, ex.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = "#1d6fb8";
      ctx.fillRect(-8, -8, 16, 16);
      if (on) {
        ctx.strokeStyle = "#1d2025";
        ctx.lineWidth = 3;
        ctx.strokeRect(-8, -8, 16, 16);
      }
      ctx.restore();
      ctx.fillStyle = "#1d6fb8";
      ctx.font = "600 12px 'Segoe UI', sans-serif";
      ctx.fillText("EXIT", ex.x + 14, ex.y + 4);
    }

    if (drag?.mode === "draw") {
      const r = clampRect(drag.x0, drag.y0, drag.x1, drag.y1);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#e8590c";
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
    }
  }, [plan, img, drag, sel, width]);

  // ---- keyboard: Delete removes selection, Escape deselects ----
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((ev.key === "Delete" || ev.key === "Backspace") && sel) {
        ev.preventDefault();
        deleteSel();
      } else if (ev.key === "Escape") {
        setSel(null);
        setTool("select");
        setDrag(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel]);

  useEffect(() => {
    setDraft(selZone?.name ?? "");
  }, [selZone?.id]);

  // ---- actions ----
  function deleteSel() {
    if (!sel) return;
    edit((p) =>
      sel.kind === "zone"
        ? { ...p, zones: p.zones.filter((z) => z.id !== sel.id) }
        : { ...p, exits: p.exits.filter((x) => x.id !== sel.id) }
    );
    setSel(null);
  }

  function rename(zone: PlanZone) {
    if (!plan) return;
    const t = draft.trim();
    const err = checkName(t, plan.zones, zone.id);
    if (err) {
      setMsg(err);
      setDraft(zone.name);
      return;
    }
    if (t !== zone.name) edit((p) => ({ ...p, zones: p.zones.map((z) => (z.id === zone.id ? { ...z, name: t } : z)) }));
  }

  function loadTemplate(key: string) {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t || !plan) return;
    if ((plan.zones.length || plan.exits.length) && !window.confirm("Replace the current zones and exits with this template?")) return;
    const b = t.build();
    setSel(null);
    edit((p) => ({ ...p, zones: b.zones, exits: b.exits }));
  }

  function onFile(ev: ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (!f) return;
    if (!IMAGE_TYPES.includes(f.type)) return setMsg("Unsupported file type. Use PNG, JPEG or WebP.");
    if (f.size > MAX_IMAGE_BYTES) return setMsg("Image is larger than 2 MB. Choose a smaller file.");
    const rd = new FileReader();
    rd.onerror = () => setMsg("The file could not be read.");
    rd.onload = () => {
      const url = String(rd.result);
      const probe = new Image();
      probe.onload = () => edit((p) => ({ ...p, background: url }));
      probe.onerror = () => setMsg("That file is not a valid image.");
      probe.src = url;
    };
    rd.readAsDataURL(f);
  }

  // ---- pointer handling (screen pixels -> plan units) ----
  const toPlan = (ev: RPointerEvent<HTMLCanvasElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    return {
      x: clamp(((ev.clientX - r.left) / r.width) * PLAN_WIDTH, 0, PLAN_WIDTH),
      y: clamp(((ev.clientY - r.top) / r.height) * PLAN_HEIGHT, 0, PLAN_HEIGHT),
    };
  };

  function hit(x: number, y: number): Sel {
    if (!plan) return null;
    for (const ex of plan.exits) if (Math.hypot(ex.x - x, ex.y - y) <= 14) return { kind: "exit", id: ex.id };
    for (let i = plan.zones.length - 1; i >= 0; i--) {
      const z = plan.zones[i];
      if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return { kind: "zone", id: z.id };
    }
    return null;
  }

  function onDown(ev: RPointerEvent<HTMLCanvasElement>) {
    if (!plan || ev.button !== 0) return;
    const p = toPlan(ev);
    ev.currentTarget.setPointerCapture(ev.pointerId);
    moved.current = false;
    if (tool === "exit") {
      if (plan.exits.length >= MAX_EXITS) return setMsg(`At most ${MAX_EXITS} exit markers are allowed.`);
      const id = newId("exit", new Set([...plan.zones.map((z) => z.id), ...plan.exits.map((x) => x.id)]));
      edit((q) => ({ ...q, exits: [...q.exits, { id, x: snap(p.x), y: snap(p.y) }] }));
      setSel({ kind: "exit", id });
      setTool("select");
    } else if (tool === "zone") {
      setSel(null);
      setDrag({ mode: "draw", x0: snap(p.x), y0: snap(p.y), x1: snap(p.x), y1: snap(p.y) });
    } else {
      const h = hit(p.x, p.y);
      setSel(h);
      const o: PlanZone | ExitMarker | undefined =
        h?.kind === "zone" ? plan.zones.find((z) => z.id === h.id) : h ? plan.exits.find((x) => x.id === h.id) : undefined;
      if (h && o) setDrag({ mode: "move", kind: h.kind, id: h.id, dx: p.x - o.x, dy: p.y - o.y });
    }
  }

  function onMove(ev: RPointerEvent<HTMLCanvasElement>) {
    if (!drag) return;
    const p = toPlan(ev);
    if (drag.mode === "draw") {
      setDrag({ ...drag, x1: snap(p.x), y1: snap(p.y) });
    } else {
      moved.current = true;
      setPlan((q) => {
        if (!q) return q;
        if (drag.kind === "zone")
          return {
            ...q,
            zones: q.zones.map((z) =>
              z.id === drag.id
                ? { ...z, x: clamp(snap(p.x - drag.dx), 0, PLAN_WIDTH - z.w), y: clamp(snap(p.y - drag.dy), 0, PLAN_HEIGHT - z.h) }
                : z
            ),
          };
        return {
          ...q,
          exits: q.exits.map((x) =>
            x.id === drag.id ? { ...x, x: clamp(snap(p.x - drag.dx), 0, PLAN_WIDTH), y: clamp(snap(p.y - drag.dy), 0, PLAN_HEIGHT) } : x
          ),
        };
      });
    }
  }

  function onUp() {
    if (!drag || !plan) return;
    if (drag.mode === "draw") {
      const r = clampRect(drag.x0, drag.y0, drag.x1, drag.y1);
      if (r.w < MIN_ZONE_SIZE || r.h < MIN_ZONE_SIZE) {
        setMsg(`Zone is too small. Drag at least ${MIN_ZONE_SIZE} × ${MIN_ZONE_SIZE} units.`);
      } else if (plan.zones.length >= MAX_ZONES) {
        setMsg(`At most ${MAX_ZONES} zones are allowed.`);
      } else {
        const id = newId("zone", new Set([...plan.zones.map((z) => z.id), ...plan.exits.map((x) => x.id)]));
        edit((q) => ({ ...q, zones: [...q.zones, { id, name: nextZoneName(q.zones), ...r, ...DEFAULT_LIMITS }] }));
        setSel({ kind: "zone", id });
      }
    } else if (moved.current) {
      setMsg(null);
      setRev((n) => n + 1); // the move was applied live; now save it
    }
    setDrag(null);
  }

  return (
    <section className="editor">
      <div className="stage">
        <div className="toolbar">
          {(Object.keys(TOOL_LABEL) as Tool[]).map((t) => (
            <button key={t} className={`btn ${tool === t ? "on" : ""}`} disabled={!plan} onClick={() => setTool(t)}>
              {TOOL_LABEL[t]}
            </button>
          ))}
          <span className="sep" />
          {TEMPLATES.map((t) => (
            <button key={t.key} className="btn" disabled={!plan} onClick={() => loadTemplate(t.key)}>
              {t.label}
            </button>
          ))}
          <label className="btn">
            Upload background
            <input type="file" hidden disabled={!plan} accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" onChange={onFile} />
          </label>
          {plan?.background && (
            <button className="btn" onClick={() => edit((p) => ({ ...p, background: null }))}>
              Remove background
            </button>
          )}
          <span className={`savestate ${save}`}>{SAVE_LABEL[save]}</span>
        </div>

        {loadError && (
          <p className="alert" role="alert">
            Could not load the saved floor plan: {loadError}{" "}
            <button className="btn" onClick={load}>Retry</button>
          </p>
        )}
        {msg && <p className="alert" role="alert">{msg}</p>}

        <div ref={wrapRef} className="canvaswrap">
          <canvas
            ref={canvasRef}
            style={{ cursor: tool === "select" ? "default" : "crosshair" }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => setDrag(null)}
          />
        </div>
        <p className="hint">{TOOL_HINT[tool]} Grid cell = {GRID_SIZE} units. Plan size {PLAN_WIDTH} × {PLAN_HEIGHT}.</p>
      </div>

      <aside className="side">
        <h2>Zones ({plan?.zones.length ?? 0})</h2>
        {plan && plan.zones.length === 0 && <p className="hint">No zones yet. Use “Draw zone” or load a template.</p>}
        <ul className="list">
          {plan?.zones.map((z) => (
            <li key={z.id}>
              <button className={sel?.id === z.id ? "on" : ""} onClick={() => setSel({ kind: "zone", id: z.id })}>
                {z.name}
              </button>
            </li>
          ))}
        </ul>

        {selZone && (
          <div className="details">
            <label>
              Name
              <input
                value={draft}
                maxLength={MAX_NAME_LENGTH + 20}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => rename(selZone)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
            </label>
            <p className="hint">x {selZone.x}, y {selZone.y}, {selZone.w} × {selZone.h} units</p>
            <LimitsForm
              key={selZone.id}
              zone={selZone}
              blocked={save === "saving"}
              onSaved={(u) =>
                setPlan((p) =>
                  p
                    ? {
                        ...p,
                        zones: p.zones.map((z) =>
                          z.id === u.id ? { ...z, type: u.type, minC: u.minC, maxC: u.maxC, warnMarginC: u.warnMarginC } : z
                        ),
                      }
                    : p
                )
              }
            />
            <button className="btn danger" onClick={deleteSel}>Delete zone</button>
          </div>
        )}
        {selExit && (
          <div className="details">
            <p>Exit marker</p>
            <p className="hint">x {selExit.x}, y {selExit.y}</p>
            <button className="btn danger" onClick={deleteSel}>Delete exit</button>
          </div>
        )}
        <p className="hint">Exits: {plan?.exits.length ?? 0}</p>
      </aside>
    </section>
  );
}
