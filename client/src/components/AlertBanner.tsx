import type { AlertRecord } from "../../../shared/types";

// Shown on every tab while at least one CRITICAL alert is active. Text + symbol, not colour alone.
export default function AlertBanner({ alerts }: { alerts: AlertRecord[] }) {
  const critical = alerts.filter((a) => a.status === "active" && a.severity === "critical");
  if (critical.length === 0) return null;
  return (
    <div className="banner" role="alert">
      <strong>⛔ CRITICAL{critical.length > 1 ? ` (${critical.length} active alerts)` : " ALERT"}</strong>
      <ul>
        {critical.map((a) => (
          <li key={a.id}>
            <b>{a.zoneName}</b>: {a.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
