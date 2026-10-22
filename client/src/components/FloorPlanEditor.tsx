import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, PointerEvent as RPointerEvent } from "react";
import type { ExitMarker, FloorPlanConfig, LinkKind, PlanLink, PlanZone, ZoneType } from "../../../shared/types";
import {
  PLAN_WIDTH, PLAN_HEIGHT, GRID_SIZE, MIN_ZONE_SIZE, MAX_ZONES, MAX_EXITS, MAX_NAME_LENGTH, MAX_LINKS,
  SIM_COLS, SIM_ROWS, SIM_CELL_W, SIM_CELL_H, LINK_KINDS, LINK_LABEL,
  clamp, snap, clampRect, checkName, validatePlan, validateLimits, DEFAULT_LIMITS, ZONE_TYPES, ZONE_TYPE_LABEL,
  planToSimCell, cellsBounds, regionOutline, zoneMiddle, linkBetween,
} from "../../../shared/floorplan";
import { TEMPLATES } from "../templates";

type Tool = "select" | "zone" | "paint" | "link" | "exit";
type Sel = { kind: "zone" | "exit" | "link"; id: string } | null;
type Drag =
  | { mode: "draw"; x0: number; y0: number; x1: number; y1: number }
  | { mode: "move"; kind: "zone" | "exit"; id: string; dx: number; dy: number; orig?: number[]; grab?: { col: number; row: number } }
  | { mode: "paint"; cells: number[]; erase: boolean; target?: string }
  | null;
type SaveState = "idle" | "saving" | "saved" | "error";

const TOOL_LABEL: Record<Tool, string> = { select: "Select / move", zone: "Draw room", paint: "Paint region", link: "Connect", exit: "Add exit" };
const TOOL_HINT: Record<Tool, string> = {
  select: "Click a zone, exit or connection to select it. Drag a zone or exit to move it.",
  zone: "Drag on the plan to draw a walled room. Edges snap to the grid.",
  paint: "Paint any shape on the grid, like an area of an open hall with no walls. Select a painted region first to add to it (or erase from it).",
  link: "Click one zone, then another, to connect them with a pipe, duct, conveyor or door. Heat can travel along connections.",
  exit: "Click on the plan to place an exit marker.",
};
const BRUSHES = [1, 2, 3, 5];
const LINK_STYLE: Record<LinkKind, { colour: string; width: number; dash: number[] }> = {
  pipe: { colour: "#1d6fb8", width: 5, dash: [10, 6] },
  duct: { colour: "#7a5cc7", width: 4, dash: [3, 6] },
  conveyor: { colour: "#5b6470", width: 6, dash: [16, 6] },
  door: { colour: "#e8590c", width: 4, dash: [] },
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
function nextRegionName(zones: PlanZone[]) {
  const used = new Set(zones.map((z) => z.name.toLowerCase()));
  for (let n = 1; ; n++) if (!used.has(`area ${n}`)) return `Area ${n}`;
}
/** Cells covered by a square brush of `size` cells centred on the cell under (x, y). */
function brushCells(x: number, y: number, size: number): number[] {
  const { col, row } = planToSimCell(x, y);
  const out: number[] = [];
  for (let dr = -Math.floor(size / 2); dr <= Math.floor((size - 1) / 2); dr++)
    for (let dc = -Math.floor(size / 2); dc <= Math.floor((size - 1) / 2); dc++) {
      const c = col + dc, r = row + dr;
      if (c >= 0 && c < SIM_COLS && r >= 0 && r < SIM_ROWS) out.push(r * SIM_COLS + c);
    }
  return out;
}
const distToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
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
  const [brush, setBrush] = useState(2);
  const [erase, setErase] = useState(false);
  const [linkKind, setLinkKind] = useState<LinkKind>("pipe");
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [width, setWidth] = useState(900);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const planRef = useRef<FloorPlanConfig | null>(null);
  planRef.current = plan;

  const selZone = sel?.kind === "zone" ? plan?.zones.find((z) => z.id === sel.id) : undefined;
  const selExit = sel?.kind === "exit" ? plan?.exits.find((x) => x.id === sel.id) : undefined;
  const selLink = sel?.kind === "link" ? plan?.links?.find((l) => l.id === sel.id) : undefined;
  const links = plan?.links ?? [];

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
      if (z.cells) {
        // painted region: every cell, then the outline of the shape
        for (const i of z.cells) ctx.fillRect((i % SIM_COLS) * SIM_CELL_W, Math.floor(i / SIM_COLS) * SIM_CELL_H, SIM_CELL_W + 0.5, SIM_CELL_H + 0.5);
        ctx.beginPath();
        for (const [x0, y0, x1, y1] of regionOutline(z.cells)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
        ctx.stroke();
      } else {
        ctx.fillRect(z.x, z.y, z.w, z.h);
        ctx.strokeRect(z.x, z.y, z.w, z.h);
      }
      ctx.save();
      ctx.beginPath();
      if (z.cells) ctx.rect(0, 0, PLAN_WIDTH, PLAN_HEIGHT); else ctx.rect(z.x, z.y, z.w, z.h);
      ctx.clip();
      ctx.fillStyle = "#1d2025";
      ctx.font = "600 15px 'Segoe UI', sans-serif";
      if (z.cells) { const m = zoneMiddle(z); ctx.textAlign = "center"; ctx.fillText(z.name, m.x, m.y + 5); ctx.textAlign = "start"; }
      else ctx.fillText(z.name, z.x + 8, z.y + 22);
      ctx.restore();
    }

    // connections (pipes, ducts, conveyors, doors)
    const zoneById = new Map((plan?.zones ?? []).map((z) => [z.id, z]));
    for (const l of plan?.links ?? []) {
      const za = zoneById.get(l.a), zb = zoneById.get(l.b);
      if (!za || !zb) continue;
      const a = zoneMiddle(za), b = zoneMiddle(zb), st = LINK_STYLE[l.kind], on = sel?.kind === "link" && sel.id === l.id;
      ctx.save();
      if (on) { ctx.setLineDash([]); ctx.strokeStyle = "#1d2025"; ctx.lineWidth = st.width + 5; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      ctx.setLineDash(st.dash); ctx.strokeStyle = st.colour; ctx.lineWidth = st.width; ctx.lineCap = "butt";
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffffff"; ctx.strokeStyle = st.colour; ctx.lineWidth = 2;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.beginPath(); ctx.arc(mx, my, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = st.colour; ctx.font = "800 12px 'Segoe UI', sans-serif"; ctx.textAlign = "center";
      ctx.fillText(LINK_LABEL[l.kind][0], mx, my + 4);
      ctx.restore();
    }
    if (tool === "link" && linkFrom && hover) {
      const za = zoneById.get(linkFrom);
      if (za) { const a = zoneMiddle(za); ctx.save(); ctx.setLineDash([6, 6]); ctx.strokeStyle = LINK_STYLE[linkKind].colour; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(hover.x, hover.y); ctx.stroke(); ctx.restore(); }
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

    if (drag?.mode === "paint") {
      ctx.fillStyle = drag.erase ? "rgba(214,38,74,.35)" : "rgba(232,89,12,.35)";
      for (const i of drag.cells) ctx.fillRect((i % SIM_COLS) * SIM_CELL_W, Math.floor(i / SIM_COLS) * SIM_CELL_H, SIM_CELL_W + 0.5, SIM_CELL_H + 0.5);
    }
    if (drag?.mode === "draw") {
      const r = clampRect(drag.x0, drag.y0, drag.x1, drag.y1);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = "#e8590c";
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([]);
    }
  }, [plan, img, drag, sel, width, tool, linkFrom, hover, linkKind]);

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
        setLinkFrom(null);
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
        ? { ...p, zones: p.zones.filter((z) => z.id !== sel.id), links: (p.links ?? []).filter((l) => l.a !== sel.id && l.b !== sel.id) }
        : sel.kind === "link"
          ? { ...p, links: (p.links ?? []).filter((l) => l.id !== sel.id) }
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
    if ((plan.zones.length || plan.exits.length) && !window.confirm("Replace the current zones, connections and exits with this template?")) return;
    const b = t.build();
    setSel(null);
    edit((p) => ({ ...p, zones: b.zones, exits: b.exits, links: b.links ?? [] }));
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

  function hit(x: number, y: number, withLinks = true): Sel {
    if (!plan) return null;
    for (const ex of plan.exits) if (Math.hypot(ex.x - x, ex.y - y) <= 14) return { kind: "exit", id: ex.id };
    if (withLinks) {
      const byId = new Map(plan.zones.map((z) => [z.id, z]));
      for (const l of links) {
        const za = byId.get(l.a), zb = byId.get(l.b);
        if (!za || !zb) continue;
        const a = zoneMiddle(za), b = zoneMiddle(zb);
        if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= 9) return { kind: "link", id: l.id };
      }
    }
    const cell = (() => { const c = planToSimCell(x, y); return c.row * SIM_COLS + c.col; })();
    for (let i = plan.zones.length - 1; i >= 0; i--) {
      const z = plan.zones[i];
      if (z.cells ? z.cells.includes(cell) : x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return { kind: "zone", id: z.id };
    }
    return null;
  }
  function addLink(from: string, to: string) {
    if (!plan) return;
    if (from === to) return setMsg("Pick a different second zone.");
    if (linkBetween(links, from, to)) return setMsg("Those two zones are already connected. Select the connection to change it.");
    if (links.length >= MAX_LINKS) return setMsg(`At most ${MAX_LINKS} connections are allowed.`);
    const id = newId("link", new Set([...plan.zones.map((z) => z.id), ...plan.exits.map((x) => x.id), ...links.map((l) => l.id)]));
    edit((q) => ({ ...q, links: [...(q.links ?? []), { id, a: from, b: to, kind: linkKind }] }));
    setSel({ kind: "link", id });
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
    } else if (tool === "paint") {
      const target = selZone?.cells ? selZone.id : undefined;
      setDrag({ mode: "paint", cells: brushCells(p.x, p.y, brush), erase: erase && !!target, target });
    } else if (tool === "link") {
      const h = hit(p.x, p.y, false);
      if (h?.kind !== "zone") return setMsg("Click a zone to start or finish a connection.");
      setMsg(null);
      if (!linkFrom) { setLinkFrom(h.id); setHover(p); } else { addLink(linkFrom, h.id); setLinkFrom(null); }
    } else {
      const h = hit(p.x, p.y);
      setSel(h);
      if (h?.kind === "link") return;
      const o: PlanZone | ExitMarker | undefined =
        h?.kind === "zone" ? plan.zones.find((z) => z.id === h.id) : h ? plan.exits.find((x) => x.id === h.id) : undefined;
      if (h && o) {
        const zc = h.kind === "zone" ? (o as PlanZone).cells : undefined;
        setDrag({ mode: "move", kind: h.kind, id: h.id, dx: p.x - o.x, dy: p.y - o.y, ...(zc ? { orig: zc, grab: planToSimCell(p.x, p.y) } : {}) });
      }
    }
  }

  function onMove(ev: RPointerEvent<HTMLCanvasElement>) {
    const p = toPlan(ev);
    if (tool === "link" && linkFrom) setHover(p);
    if (!drag) return;
    if (drag.mode === "draw") {
      setDrag({ ...drag, x1: snap(p.x), y1: snap(p.y) });
    } else if (drag.mode === "paint") {
      const add = brushCells(p.x, p.y, brush).filter((i) => !drag.cells.includes(i));
      if (add.length) setDrag({ ...drag, cells: [...drag.cells, ...add] });
    } else {
      moved.current = true;
      setPlan((q) => {
        if (!q) return q;
        if (drag.kind === "zone" && drag.orig && drag.grab) {
          const now = planToSimCell(p.x, p.y);
          const b = cellsBounds(drag.orig);
          const c0 = Math.round(b.x / SIM_CELL_W), c1 = c0 + Math.round(b.w / SIM_CELL_W) - 1, r0 = Math.round(b.y / SIM_CELL_H), r1 = r0 + Math.round(b.h / SIM_CELL_H) - 1;
          const dc = clamp(now.col - drag.grab.col, -c0, SIM_COLS - 1 - c1), dr = clamp(now.row - drag.grab.row, -r0, SIM_ROWS - 1 - r1);
          const cells = drag.orig.map((i) => (Math.floor(i / SIM_COLS) + dr) * SIM_COLS + (i % SIM_COLS) + dc);
          return { ...q, zones: q.zones.map((z) => (z.id === drag.id ? { ...z, cells, ...cellsBounds(cells) } : z)) };
        }
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
    } else if (drag.mode === "paint") {
      const taken = new Set([...plan.zones.map((z) => z.id), ...plan.exits.map((x) => x.id), ...links.map((l) => l.id)]);
      if (drag.target) {
        const tz = plan.zones.find((z) => z.id === drag.target);
        if (tz?.cells) {
          const next = drag.erase ? tz.cells.filter((i) => !drag.cells.includes(i)) : [...new Set([...tz.cells, ...drag.cells])].sort((a, b) => a - b);
          if (!next.length) { setSel({ kind: "zone", id: tz.id }); setMsg("A region needs at least one cell. Use Delete to remove it."); }
          else edit((q) => ({ ...q, zones: q.zones.map((z) => (z.id === tz.id ? { ...z, cells: next, ...cellsBounds(next) } : z)) }));
        }
      } else if (drag.cells.length) {
        if (plan.zones.length >= MAX_ZONES) setMsg(`At most ${MAX_ZONES} zones are allowed.`);
        else {
          const id = newId("region", taken);
          const cells = [...drag.cells].sort((a, b) => a - b);
          edit((q) => ({ ...q, zones: [...q.zones, { id, name: nextRegionName(q.zones), cells, ...cellsBounds(cells), ...DEFAULT_LIMITS }] }));
          setSel({ kind: "zone", id });
        }
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
            <button key={t} className={`btn ${tool === t ? "on" : ""}`} disabled={!plan} onClick={() => { setTool(t); setLinkFrom(null); setErase(false); }}>
              {TOOL_LABEL[t]}
            </button>
          ))}
          {tool === "paint" && (
            <>
              <label className="inline">Brush
                <select value={brush} onChange={(e) => setBrush(Number(e.target.value))}>
                  {BRUSHES.map((b) => <option key={b} value={b}>{b} × {b} cells</option>)}
                </select>
              </label>
              <button className={`btn ${erase ? "on" : ""}`} disabled={!selZone?.cells} title={selZone?.cells ? "Erase cells from the selected region" : "Select a painted region to erase from it"} onClick={() => setErase((v) => !v)}>Erase</button>
            </>
          )}
          {tool === "link" && (
            <label className="inline">Type
              <select value={linkKind} onChange={(e) => setLinkKind(e.target.value as LinkKind)}>
                {LINK_KINDS.map((k) => <option key={k} value={k}>{LINK_LABEL[k]}</option>)}
              </select>
            </label>
          )}
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
            onPointerLeave={() => setHover(null)}
          />
        </div>
        <p className="hint">{tool === "link" && linkFrom ? "Now click the second zone." : TOOL_HINT[tool]} Grid cell = {GRID_SIZE} units. Plan size {PLAN_WIDTH} × {PLAN_HEIGHT}.</p>
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
            {selZone.cells ? (
              <p className="hint">Painted region: {selZone.cells.length} cells, no walls. Use “Paint region” with this selected to add cells, or Erase to remove them.</p>
            ) : (
              <p className="hint">x {selZone.x}, y {selZone.y}, {selZone.w} × {selZone.h} units</p>
            )}
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
        {selLink && (
          <div className="details">
            <p><b>{LINK_LABEL[selLink.kind]}</b> between {plan?.zones.find((z) => z.id === selLink.a)?.name} and {plan?.zones.find((z) => z.id === selLink.b)?.name}</p>
            <label>
              Type
              <select value={selLink.kind} onChange={(e) => edit((q) => ({ ...q, links: (q.links ?? []).map((l) => (l.id === selLink.id ? { ...l, kind: e.target.value as LinkKind } : l)) }))}>
                {LINK_KINDS.map((k) => <option key={k} value={k}>{LINK_LABEL[k]}</option>)}
              </select>
            </label>
            <p className="hint">Heat and fire risk travel along open connections. In the Simulator and What-if panels you can isolate one.</p>
            <button className="btn danger" onClick={deleteSel}>Delete connection</button>
          </div>
        )}
        {selExit && (
          <div className="details">
            <p>Exit marker</p>
            <p className="hint">x {selExit.x}, y {selExit.y}</p>
            <button className="btn danger" onClick={deleteSel}>Delete exit</button>
          </div>
        )}
        <h2 style={{ marginTop: 18 }}>Connections ({links.length})</h2>
        {links.length === 0 && <p className="hint">None. Use “Connect” to link two zones with a pipe, duct, conveyor or door.</p>}
        <ul className="list">
          {links.map((l) => (
            <li key={l.id}>
              <button className={sel?.id === l.id ? "on" : ""} onClick={() => setSel({ kind: "link", id: l.id })}>
                {LINK_LABEL[l.kind]}: {plan?.zones.find((z) => z.id === l.a)?.name} ↔ {plan?.zones.find((z) => z.id === l.b)?.name}
              </button>
            </li>
          ))}
        </ul>
        <p className="hint">Exits: {plan?.exits.length ?? 0}</p>
      </aside>
    </section>
  );
}
