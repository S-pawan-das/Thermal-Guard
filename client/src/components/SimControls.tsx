import { useState } from "react";
import type { SimStatus, Zone } from "../../../shared/types";

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
  return (
    <section className="simbox">
      <div className="simstatus" role="status">
        <p>
          <b>Scenario:</b> {sim?.scenario ?? "—"} · <b>{sim?.paused ? "⏸ PAUSED" : "▶ Running"}</b> · step {sim?.step ?? 0}
        </p>
        <p>
          {sim?.baseline ? "Baseline: no fire and no failed cooler." : ""}
          {sim?.fires.map((f) => `Fire in ${nameOf(f.zoneId)}. `)}
          {sim?.failedCoolers.map((id) => `Cooler failed in ${nameOf(id)}. `)}
        </p>
      </div>

      <label>
        Zone
        <select value={zone.id} onChange={(e) => setZoneId(e.target.value)}>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
      </label>

      <div className="simrow">
        <button className="btn danger" disabled={busy} onClick={() => call("/api/sim/fire", { zoneId: zone.id })}>Start fire in zone</button>
        <span className="hint">Heats the middle of the zone toward 300 °C.</span>
      </div>
      <div className="simrow">
        <input aria-label="Failure temperature (optional)" placeholder="failure °C (optional)" inputMode="decimal" value={failTemp} onChange={(e) => setFailTemp(e.target.value)} />
        <button className="btn danger" disabled={busy || zone.type !== "cold-storage"} onClick={failCooler}>Fail cooler</button>
        <span className="hint">{zone.type === "cold-storage" ? "Room drifts toward ambient (or the failure °C)." : "Only cold-storage zones have a cooler."}</span>
      </div>
      <div className="simrow">
        <input aria-label="Temperature in °C" placeholder="°C" inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} />
        <button className="btn" disabled={busy} onClick={setTemperature}>Set zone temperature</button>
        <span className="hint">One-time demo override of every cell the zone covers.</span>
      </div>
      <div className="simrow">
        <button className="btn" disabled={busy} onClick={() => call(sim?.paused ? "/api/sim/resume" : "/api/sim/pause")}>{sim?.paused ? "Resume" : "Pause"}</button>
        <button className="btn" disabled={busy} onClick={() => call("/api/sim/reset")}>Reset scenario</button>
        <span className="hint">Reset removes fires and failures and restores the baseline. Alert history is kept.</span>
      </div>
      {note && <p className={note.kind === "ok" ? "field-ok" : "field-error"} role={note.kind === "ok" ? "status" : "alert"}>{note.kind === "ok" ? "✔ " : "✖ "}{note.text}</p>}
    </section>
  );
}
