import { useEffect, useState } from "react";
import type { MachineStatus, StateMessage } from "../../../shared/types";
import { getJson, postJson, fmtMinutes, type Action, type ActionResult, type CauseReport } from "../twinApi";
import Icon from "./icons";

type Note = { kind: "ok" | "error"; text: string } | null;
const VERDICT: Record<MachineStatus["verdict"], { label: string; cls: string; text: string }> = {
  learning: { label: "Learning", cls: "", text: "Not enough earlier cycles yet to judge." },
  normal: { label: "Normal", cls: "good", text: "Heating up the way it usually does." },
  underperform: { label: "Under-performing", cls: "warn", text: "Heating slower than usual: likely needs repair, or its efficiency has dropped." },
  overshoot: { label: "Running hot", cls: "bad", text: "Heating faster than usual: keep it under surveillance and stop it if it continues." },
};

function CycleChart({ m }: { m: MachineStatus }) {
  const W = 320, H = 130, L = 30, B = 20, T = 8, R = 8;
  const maxY = Math.max(1, ...m.curve.map((c) => c.mean + c.sd), ...m.actual.map((a) => a.v)) * 1.1;
  const x = (min: number) => L + (min / m.window) * (W - L - R);
  const y = (v: number) => T + (1 - Math.max(0, v) / maxY) * (H - T - B);
  const band = m.curve.length
    ? m.curve.map((c, i) => `${i ? "L" : "M"}${x(c.m)},${y(c.mean + c.sd)}`).join("") + [...m.curve].reverse().map((c) => `L${x(c.m)},${y(c.mean - c.sd)}`).join("") + "Z"
    : "";
  const mean = m.curve.map((c, i) => `${i ? "L" : "M"}${x(c.m)},${y(c.mean)}`).join("");
  const act = m.actual.map((a, i) => `${i ? "L" : "M"}${x(a.m)},${y(a.v)}`).join("");
  const colour = m.verdict === "overshoot" ? "#d6264a" : m.verdict === "underperform" ? "#d98f00" : "#0f9d68";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${m.name}: temperature rise this cycle against the learned pattern`} className="cycle-chart">
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="#d5d8dc" />
      <line x1={L} y1={T} x2={L} y2={H - B} stroke="#d5d8dc" />
      {band && <path d={band} fill="#9aa3ad" opacity=".22" />}
      {mean && <path d={mean} fill="none" stroke="#6b7480" strokeWidth="2" strokeDasharray="5 4" />}
      {act && <path d={act} fill="none" stroke={colour} strokeWidth="3" strokeLinecap="round" />}
      <text x={L - 4} y={T + 8} fontSize="9" textAnchor="end" fill="#666a71">{Math.round(maxY)}°</text>
      <text x={L - 4} y={H - B} fontSize="9" textAnchor="end" fill="#666a71">0°</text>
      <text x={L} y={H - 5} fontSize="9" fill="#666a71">start</text>
      <text x={W - R} y={H - 5} fontSize="9" textAnchor="end" fill="#666a71">{m.window} min</text>
    </svg>
  );
}

export default function Insights({ state }: { state: StateMessage | null }) {
  const [actions, setActions] = useState<ActionResult[]>([]);
  const [baseMin, setBaseMin] = useState(60);
  const [causes, setCauses] = useState<CauseReport | null>(null);
  const [zoneId, setZoneId] = useState("");
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const [machineId, setMachineId] = useState("");
  const zones = state?.zones ?? [];
  const machines = state?.machines ?? [];
  const links = state?.links ?? [];
  const zoneName = (id?: string) => zones.find((z) => z.id === id)?.name;

  useEffect(() => {
    let dead = false;
    const pull = () => {
      getJson<{ minutes: number; results: ActionResult[] }>("/api/twin/actions?minutes=60").then((r) => { if (!dead) { setActions(r.results); setBaseMin(r.minutes); } }, () => undefined);
    };
    pull();
    const t = setInterval(pull, 5000);
    return () => { dead = true; clearInterval(t); };
  }, []);

  const focus = zoneId || zones.find((z) => z.status !== "normal")?.id || zones[0]?.id || "";
  useEffect(() => {
    if (!focus) return;
    let dead = false;
    const pull = () => getJson<CauseReport>(`/api/twin/causes?zoneId=${encodeURIComponent(focus)}&minutes=60`).then((r) => { if (!dead) setCauses(r); }, () => { if (!dead) setCauses(null); });
    pull();
    const t = setInterval(pull, 5000);
    return () => { dead = true; clearInterval(t); };
  }, [focus]);

  async function run(p: Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    setBusy(true);
    const r = await p;
    setNote(r.ok ? { kind: "ok", text: r.message } : { kind: "error", text: r.error });
    setBusy(false);
  }
  const apply = (a: Action) => run(postJson("/api/twin/apply", a));
  const startDay = (mode: "normal" | "weak" | "overheat") => run(postJson("/api/sim/start-day", { machineId: machineId || undefined, mode }));

  if (state && zones.length === 0) return <p className="empty">Nothing to analyse yet. In the Heatmap tab, load the Factory demo or the Open-hall demo.</p>;

  const problems = machines.filter((m) => m.verdict === "underperform" || m.verdict === "overshoot");
  const closedIds = new Set(links.filter((l) => l.closed).map((l) => l.id));

  return (
    <section className="insights">
      {note && <p className={note.kind === "ok" ? "field-ok" : "field-error"} role={note.kind === "ok" ? "status" : "alert"}>{note.kind === "ok" ? "✔ " : "✖ "}{note.text}</p>}

      <div className="card ins-card">
        <h2><Icon name="pulse" size={20} /> Machine patterns</h2>
        <p className="hint">Each machine's usual temperature rise after it starts was learned from earlier cycles (simulated history in this demo). Today's cycle is compared minute by minute: slower means repair or lower efficiency, faster means surveillance or stop.</p>
        <div className="toolbar">
          <label className="inline">Machine
            <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              <option value="">All machines</option>
              {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <button className="btn" disabled={busy} onClick={() => startDay("normal")}>Start a normal day</button>
          <button className="btn" disabled={busy} onClick={() => startDay("weak")}>Start: weak machine</button>
          <button className="btn danger" disabled={busy} onClick={() => startDay("overheat")}>Start: overheating</button>
          <button className="btn" disabled={busy} onClick={() => run(postJson("/api/sim/fast-forward", { minutes: 30 }))}>Skip 30 min</button>
        </div>
        {problems.length > 0 && <p className="chip-note bad" role="alert">{problems.length} machine{problems.length > 1 ? "s" : ""} off their usual pattern: {problems.map((p) => p.name).join(", ")}</p>}
        {machines.length === 0 ? (
          <p className="hint">No machines in the scenario. Load a demo from the Heatmap tab.</p>
        ) : (
          <div className="mach-grid">
            {machines.map((m) => {
              const v = VERDICT[m.verdict];
              return (
                <article key={m.id} className={`mach ${v.cls}`}>
                  <header><b>{m.name}</b><span className={`chip-note ${v.cls || ""}`}>{v.label}</span></header>
                  <small>{zoneName(m.zoneId) ?? "open floor"} · {m.running ? `running, minute ${m.minute} of ${m.window}` : "not running"}</small>
                  {m.curve.length > 0 || m.actual.length > 0 ? <CycleChart m={m} /> : <p className="hint">Waiting for a cycle.</p>}
                  <p className="mach-text">{v.text}</p>
                  {m.expectedC !== null && (
                    <p className="mach-nums">Now +{m.riseC} °C, usual +{m.expectedC} °C (±{m.bandC}).{m.projectedC !== null && m.usualC !== null ? ` At this pace: +${m.projectedC} °C after ${m.window} min, usually +${m.usualC} °C.` : ""}</p>
                  )}
                  <small>Learned from {m.cycles} earlier cycle{m.cycles === 1 ? "" : "s"}</small>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="card ins-card">
        <h2><Icon name="wand" size={20} /> What should I do? <span className="sub">next {baseMin} min, simulated on a copy of the plant</span></h2>
        {actions.length === 0 ? (
          <p className="chip-note good">✔ Nothing is predicted to go out of range, so no action is needed.</p>
        ) : (
          <ul className="act-list">
            {actions.slice(0, 5).map((a) => (
              <li key={a.key}>
                <div><b>{a.label}</b><p>{a.bought}</p></div>
                <button className="btn primary" disabled={busy} onClick={() => apply(a.action)}>Do it</button>
              </li>
            ))}
          </ul>
        )}
        {links.length > 0 && (
          <>
            <h3>Connections</h3>
            <ul className="act-list">
              {links.map((l) => (
                <li key={l.id}>
                  <div><b>{zoneName(l.a) ?? l.a} ↔ {zoneName(l.b) ?? l.b}</b><p>{l.kind}{l.closed ? " · isolated" : l.danger === "spread" ? " · heat is predicted to travel through it" : l.danger === "watch" ? " · watch" : ""}</p></div>
                  <button className="btn" disabled={busy} onClick={() => run(postJson("/api/sim/link", { linkId: l.id, closed: !closedIds.has(l.id) }))}>{l.closed ? "Reopen" : "Isolate"}</button>
                </li>
              ))}
            </ul>
          </>
        )}
        {note === null && <p className="hint">Each option is run through the same simulator as the live plant and ranked by how much predicted harm it removes.</p>}
      </div>

      <div className="card ins-card">
        <h2><Icon name="search" size={20} /> Why is it heating?</h2>
        <label className="inline">Zone
          <select value={focus} onChange={(e) => setZoneId(e.target.value)}>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        {causes ? (
          <>
            <p className="why-summary">{causes.summary}</p>
            <ul className="cause-list">
              {causes.causes.map((c) => (
                <li key={c.kind + c.id}>
                  <div className="cause-top"><b>{c.label}</b><span>{c.sharePct}%</span></div>
                  <div className="cause-bar"><i style={{ width: `${Math.min(100, c.sharePct)}%` }} /></div>
                  <small>Removing it lowers the worst cell by {c.reducesByC} °C</small>
                </li>
              ))}
            </ul>
            <p className="hint">Found by re-running the next {fmtMinutes(60)} with each possible cause removed in turn.</p>
          </>
        ) : <p className="hint">Nothing to explain: this zone is predicted to stay in range.</p>}
      </div>
    </section>
  );
}
