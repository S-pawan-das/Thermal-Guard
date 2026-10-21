import type { Zone, ZoneStatus } from "../../../shared/types";
import { ZONE_TYPE_LABEL } from "../../../shared/floorplan";
import Icon from "./icons";

const LABEL: Record<ZoneStatus, string> = { normal: "✓ Normal", warning: "▲ Near limit", critical: "✖ Out of range" };
const STROKE: Record<ZoneStatus, string> = { normal: "#0f9d68", warning: "#f2a900", critical: "#d6264a" };

// Semicircle dial, like a thermostat: the left end is the zone's minimum, the right end its maximum.
const CX = 120, CY = 118, R = 92;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pt = (f: number, r = R) => [CX + r * Math.cos(Math.PI * (1 - f)), CY - r * Math.sin(Math.PI * (1 - f))] as const;
const arc = (f0: number, f1: number) => {
  const [x0, y0] = pt(f0), [x1, y1] = pt(f1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

function Gauge({ zone }: { zone: Zone }) {
  const { minC, maxC, warnMarginC, temperatureC, minCellC, maxCellC, status } = zone;
  const range = Math.max(1e-6, maxC - minC);
  const frac = (t: number) => (t - minC) / range;
  const f = clamp(frac(temperatureC), 0, 1);
  const wf = clamp(warnMarginC / range, 0, 0.5);
  const [kx, ky] = pt(f);
  const tick = (t: number) => {
    const g = clamp(frac(t), 0, 1), [x0, y0] = pt(g, R - 12), [x1, y1] = pt(g, R + 12);
    return { x0, y0, x1, y1 };
  };
  const lo = tick(minCellC), hi = tick(maxCellC);
  const color = STROKE[status];
  return (
    <svg className="gauge" viewBox="0 0 240 150" role="img" aria-label={`${zone.name}: ${temperatureC.toFixed(1)} °C, limits ${minC} to ${maxC} °C`}>
      <path d={arc(0, 1)} fill="none" stroke="#e8eaed" strokeWidth={14} strokeLinecap="round" />
      {wf > 0.01 && <path d={arc(0, wf)} fill="none" stroke="#fde7a6" strokeWidth={14} strokeLinecap="round" />}
      {wf > 0.01 && <path d={arc(1 - wf, 1)} fill="none" stroke="#fde7a6" strokeWidth={14} strokeLinecap="round" />}
      {f > 0.004 && <path d={arc(0, f)} fill="none" style={{ stroke: color }} strokeWidth={14} strokeLinecap="round" />}
      <line x1={lo.x0} y1={lo.y0} x2={lo.x1} y2={lo.y1} stroke="#111214" strokeOpacity={0.45} strokeWidth={2.5} strokeLinecap="round" />
      <line x1={hi.x0} y1={hi.y0} x2={hi.x1} y2={hi.y1} stroke="#111214" strokeOpacity={0.45} strokeWidth={2.5} strokeLinecap="round" />
      <circle cx={kx} cy={ky} r={11} fill="#fff" style={{ stroke: color }} strokeWidth={5} />
      <text className="num" x={CX} y={CY - 4} textAnchor="middle">
        {temperatureC.toFixed(1)}<tspan className="unit" dx={3}>°C</tspan>
      </text>
      <text className="lab" x={CX} y={CY + 16} textAnchor="middle">Temperature</text>
      <text className="end" x={CX - R} y={CY + 30} textAnchor="middle">{minC}°C</text>
      <text className="end" x={CX + R} y={CY + 30} textAnchor="middle">{maxC}°C</text>
    </svg>
  );
}

export default function ZoneCard({ zone }: { zone: Zone }) {
  const { name, type, status, ai } = zone;
  const icon = type === "cold-storage" ? "snowflake" : type === "hot-process" ? "flame" : "factory";
  const tone = type === "cold-storage" ? "cold" : type === "hot-process" ? "hot" : "";
  return (
    <article className={`zcard ${status}`}>
      <header className="zhead">
        <span className={`zicon ${tone}`}><Icon name={icon} size={22} /></span>
        <div className="grow">
          <h2>{name}</h2>
          <small>{ZONE_TYPE_LABEL[type]}</small>
        </div>
        <span className={`status ${status}`}>{LABEL[status]}</span>
      </header>
      <Gauge zone={zone} />
      <p className="zmeta">
        <span>Coldest {zone.minCellC} °C</span>
        <span>Hottest {zone.maxCellC} °C</span>
      </p>
      <p className="zmeta"><span>Warning within {zone.warnMarginC} °C of a limit</span></p>
      {ai && (
        <div className={`ai ${ai.alert ? "on" : ""}`} role="status">
          <div className="ai-head">
            <span className="l"><Icon name="sparkle" size={16} /> AI forecast</span>
            <b>{ai.alert ? (status === "critical" ? "✖ OUT OF RANGE" : "⚠ EARLY WARNING") : "✓ Stable"}</b>
          </div>
          <div className="ai-bar" aria-hidden="true"><div style={{ width: `${Math.round(ai.risk * 100)}%` }} /></div>
          <small>{Math.round(ai.risk * 100)}% risk of leaving the limits within {ai.horizon} steps</small>
        </div>
      )}
    </article>
  );
}
