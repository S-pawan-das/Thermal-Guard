import { useState } from "react";
import type { SimStatus, Zone } from "../../../shared/types";
import Icon from "./icons";

type Note = { kind: "ok" | "error"; text: string } | null;
const parseTemp = (t: string) => (/^-?\d+(\.\d+)?$/.test(t.trim()) ? Number(t.trim()) : NaN);

export default function SimControls({ zones, sim }: { zones: Zone[]; sim?: SimStatus }) {
  const [zoneId, setZoneId] = useState("");
  const [temp, setTemp] = useState("");
  const [failTemp, setFailTemp] = useState("");
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const zone = zones.find((z) => z.id === zoneId) ?? zones[0];
  const nameOf = (id?: string) => zones.find((z) => z.id === id)?.name ?? id ?? "a position";

  async function call(path: string, body?: object) {
    setBusy(true);
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const data = await res.json().catch(() => ({}));
      setNote(res.ok ? { kind: "ok", text: data.message || "Done." } : { kind: "error", text: data.error || `HTTP ${res.status}` });
    } catch {
      setNote({ kind: "error", text: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  }

  function setTemperature() {
    const v = parseTemp(temp);
    if (!Number.isFinite(v)) return setNote({ kind: "error", text: "Enter a temperature as a plain number, e.g. 12.5." });
    call("/api/sim/set-temperature", { zoneId: zone.id, temperatureC: v });
  }
  function failCooler() {
    const body: { zoneId: string; failureTempC?: number } = { zoneId: zone.id };
    if (failTemp.trim()) {
      const v = parseTemp(failTemp);
      if (!Number.isFinite(v)) return setNote({ kind: "error", text: "Failure temperature must be a plain number, or leave it empty for ambient." });
      body.failureTempC = v;
    }
    call("/api/sim/cooling-failure", body);
  }

  if (zones.length === 0) return <p className="empty">Create at least one zone in the Floor plan tab to use the simulator controls.</p>;
  // Fires with a zone are user incidents; fires without one are the scenario's machine heat sources.
  const zoneFires = sim?.fires.filter((f) => f.zoneId) ?? [];
  const machines = (sim?.fires.length ?? 0) - zoneFires.length;
  const issues = [
    ...zoneFires.map((f) => `Fire in ${nameOf(f.zoneId)}`),
    ...(machines > 0 ? [`${machines} machine heat source${machines > 1 ? "s" : ""} running`] : []),
    ...(sim?.failedCoolers.map((id) => `Cooler failed in ${nameOf(id)}`) ?? []),
  ];
  return (
    <section className="simbox">
      <div className="simstatus" role="status">
        <div className="row">
          <span className="tag">{sim?.scenario ?? "—"}</span>
          <span className={`tag ${sim?.paused ? "warm" : "good"}`}>{sim?.paused ? "⏸ Paused" : "▶ Running"}</span>
          <span className="tag">step {sim?.step ?? 0}</span>
          {sim?.baseline && <span className="tag good">Baseline: no fire, no failed cooler</span>}
          {issues.map((t, i) => <span key={i} className={`tag ${t.includes("machine") ? "warm" : "bad"}`}>{t}</span>)}
        </div>
      </div>

      <label className="pick">
        Zone to affect
        <select value={zone.id} onChange={(e) => setZoneId(e.target.value)}>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
      </label>

      <div className="act">
        <span className="ai-ico hot"><Icon name="flame" /></span>
        <h3>Start a fire</h3>
        <p>Heats the middle of the zone toward 300 °C.</p>
        <div className="ctl"><button className="btn danger" disabled={busy} onClick={() => call("/api/sim/fire", { zoneId: zone.id })}>Start fire</button></div>
      </div>

      <div className="act">
        <span className="ai-ico cold"><Icon name="snowflake" /></span>
        <h3>Fail the cooler</h3>
        <p>{zone.type === "cold-storage" ? "The room drifts toward ambient (or the failure °C)." : "Only cold-storage zones have a cooler."}</p>
        <div className="ctl">
          <input aria-label="Failure temperature (optional)" placeholder="failure °C" inputMode="decimal" value={failTemp} onChange={(e) => setFailTemp(e.target.value)} />
          <button className="btn danger" disabled={busy || zone.type !== "cold-storage"} onClick={failCooler}>Fail cooler</button>
        </div>
      </div>

      <div className="act">
        <span className="ai-ico"><Icon name="thermo" /></span>
        <h3>Set zone temperature</h3>
        <p>One-time override of every cell the zone covers; the simulation continues from there.</p>
        <div className="ctl">
          <input aria-label="Temperature in °C" placeholder="°C" inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} />
          <button className="btn" disabled={busy} onClick={setTemperature}>Set</button>
        </div>
      </div>

      <div className="act">
        <span className="ai-ico"><Icon name={sim?.paused ? "play" : "pause"} /></span>
        <h3>Simulation</h3>
        <p>Reset removes fires and failures and restores the baseline. Alert history is kept.</p>
        <div className="ctl">
          <button className="btn" disabled={busy} onClick={() => call(sim?.paused ? "/api/sim/resume" : "/api/sim/pause")}>{sim?.paused ? "Resume" : "Pause"}</button>
          <button className="btn" disabled={busy} onClick={() => call("/api/sim/reset")}><Icon name="reset" size={16} /> Reset</button>
        </div>
      </div>

      {note && <p className={note.kind === "ok" ? "field-ok" : "field-error"} role={note.kind === "ok" ? "status" : "alert"}>{note.kind === "ok" ? "✔ " : "✖ "}{note.text}</p>}
    </section>
  );
}
