import { useState } from "react";
import type { AlertRecord } from "../../../shared/types";
import Icon from "./icons";

const time = (iso: string) => new Date(iso).toLocaleTimeString();

export default function AlertFeed({ alerts, soundOn, onToggleSound }: { alerts: AlertRecord[]; soundOn: boolean; onToggleSound: () => void }) {
  const [note, setNote] = useState<string | null>(null);

  async function clearHistory() {
    if (!window.confirm("Delete resolved alerts from the history? Active alerts are kept.")) return;
    try {
      const res = await fetch("/api/alerts", { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      setNote(res.ok ? body.message : body.error || `HTTP ${res.status}`);
    } catch {
      setNote("Could not reach the server.");
    }
  }

  return (
    <section className="feed" id="alerts" aria-label="Alert feed">
      <div className="feed-head">
        <h2>Alerts <span style={{ color: "var(--muted)", fontWeight: 600 }}>({alerts.filter((a) => a.status === "active").length} active)</span></h2>
        <button className="switch" role="switch" aria-checked={soundOn} onClick={onToggleSound}>
          <Icon name={soundOn ? "volume" : "mute"} size={18} /> Alert sound <i />
        </button>
        <button className="btn" onClick={clearHistory}><Icon name="trash" size={16} /> Clear resolved</button>
      </div>
      {note && <p className="hint" role="status">{note}</p>}
      {alerts.length === 0 ? (
        <p className="hint">No alerts. They appear only when a zone's readings approach or cross its limits.</p>
      ) : (
        <ul className="alert-list">
          {alerts.map((a) => (
            <li key={a.id} className={`alert-item ${a.severity} ${a.status}`}>
              <span className="dot"><Icon name={a.severity === "critical" ? "stop" : "alert"} size={20} /></span>
              <div className="top">
                <span className="sev">{a.severity === "critical" ? "⛔ CRITICAL" : "⚠ WARNING"}</span>
                <b>{a.zoneName}</b>
                <span className="kind">{a.kind === "high" ? "High temperature" : "Low temperature"}</span>
              </div>
              <span className="why">{a.reason}</span>
              <small>
                {a.status === "active" ? "ACTIVE since " + time(a.startedAt) : `Resolved ${a.resolvedAt ? time(a.resolvedAt) : ""} (${a.resolution})`}
                {" · "}worst {a.peakC} °C{a.occurrences > 1 ? ` · seen ${a.occurrences}×` : ""} · {a.id}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
