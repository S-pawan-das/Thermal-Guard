import type { Zone } from "../../../shared/types";
import { ZONE_TYPE_LABEL } from "../../../shared/floorplan";

const LABEL: Record<Zone["status"], string> = {
  normal: "Normal",
  warning: "Near limit",
  critical: "Out of range",
};

export default function ZoneCard({ zone }: { zone: Zone }) {
  const { name, type, temperatureC, minC, maxC, warnMarginC, status } = zone;
  // Position of the reading on the min–max bar, clamped to 0–100%.
  const pct = Math.min(100, Math.max(0, ((temperatureC - minC) / (maxC - minC)) * 100));
  return (
    <article className={`card ${status}`}>
      <header>
        <h2>{name}</h2>
        <span className="badge">{LABEL[status]}</span>
      </header>
      <p className="ztype">{ZONE_TYPE_LABEL[type]}</p>
      <p className="temp">
        {temperatureC.toFixed(1)}
        <span>°C</span>
      </p>
      <div className="range" aria-hidden="true">
        <div className="marker" style={{ left: `${pct}%` }} />
      </div>
      <p className="limits">
        <span>Min {minC} °C</span>
        <span>Max {maxC} °C</span>
      </p>
      <p className="ztype">Coldest cell {zone.minCellC} °C · hottest cell {zone.maxCellC} °C</p>
      <p className="ztype">Warning within {warnMarginC} °C of a limit</p>
    </article>
  );
}
