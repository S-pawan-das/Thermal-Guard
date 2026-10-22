import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { AlertRecord, AlertsMessage, StateMessage, Zone, ZoneType } from "../../shared/types";
import ZoneCard from "./components/ZoneCard";
import FloorPlanEditor from "./components/FloorPlanEditor";
import AlertBanner from "./components/AlertBanner";
import AlertFeed from "./components/AlertFeed";
import SimControls from "./components/SimControls";
import Insights from "./components/Insights";
import HeatmapView from "./components/HeatmapView";
import Onboarding from "./components/Onboarding";
import Icon, { type IconName } from "./components/icons";

type Connection = "connecting" | "connected" | "disconnected";
type View = "dashboard" | "heat" | "insights" | "plan" | "sim";
type Filter = "all" | "attention" | ZoneType;

const CONN_LABEL: Record<Connection, string> = { connecting: "Connecting", connected: "Live", disconnected: "Offline" };
const TITLES: Record<View, [string, string]> = {
  dashboard: ["Your Factory", "Overview"],
  heat: ["Live Factory", "Heatmap"],
  insights: ["Machine", "Insights"],
  plan: ["Plan Your", "Floor"],
  sim: ["Incident", "Simulator"],
};
const NAV: { view: View; label: string; icon: IconName }[] = [
  { view: "dashboard", label: "Dashboard", icon: "home" },
  { view: "heat", label: "Heatmap", icon: "cube" },
  { view: "insights", label: "Insights", icon: "pulse" },
  { view: "plan", label: "Floor plan", icon: "layout" },
  { view: "sim", label: "Simulator", icon: "sliders" },
];
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs attention" },
  { key: "cold-storage", label: "Cold storage" },
  { key: "general", label: "General" },
  { key: "hot-process", label: "Hot process" },
];

const INTRO_KEY = "thermalGuardIntroSeen";
const introSeen = () => {
  try {
    return localStorage.getItem(INTRO_KEY) === "1" || new URLSearchParams(location.search).get("intro") === "0";
  } catch {
    return false;
  }
};
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
const needsAttention = (z: Zone) => z.status !== "normal" || !!z.ai?.alert;

export default function App() {
  const [state, setState] = useState<StateMessage | null>(null);
  const [conn, setConn] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [filter, setFilter] = useState<Filter>("all");
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [soundOn, setSoundOn] = useState(false);
  const [intro, setIntro] = useState(() => !introSeen());
  const audio = useRef<AudioContext | null>(null);
  const seenCritical = useRef<Set<string> | null>(null);

  const finishIntro = () => {
    try { localStorage.setItem(INTRO_KEY, "1"); } catch { /* private mode: the intro will just show again */ }
    setIntro(false);
  };

  // Sound is OFF until the user clicks (browsers block autoplay). The app works fully without it.
  const beep = () => {
    const ctx = audio.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  };
  const toggleSound = () => {
    if (!soundOn) {
      audio.current ??= new AudioContext();
      void audio.current.resume();
      beep(); // confirms that sound works
    }
    setSoundOn((v) => !v);
  };

  useEffect(() => {
    const socket = io(); // same origin; Vite proxies /socket.io to the backend
    socket.on("connect", () => { setConn("connected"); setError(null); });
    socket.on("disconnect", () => setConn("disconnected"));
    socket.on("connect_error", () => {
      setConn("disconnected");
      setError("Cannot reach the backend. Check that the server is running on port 3001.");
    });
    socket.io.on("reconnect_attempt", () => setConn("connecting"));
    socket.on("state", (msg: StateMessage) => setState(msg));
    socket.on("alerts", (msg: AlertsMessage) => setAlerts(msg.alerts));
    return () => { socket.close(); };
  }, []);

  // beep once for each NEW critical alert (never for ones that were already active when the page loaded)
  useEffect(() => {
    const ids = new Set(alerts.filter((a) => a.status === "active" && a.severity === "critical").map((a) => a.id));
    if (seenCritical.current && soundOn && [...ids].some((id) => !seenCritical.current!.has(id))) beep();
    seenCritical.current = ids;
  }, [alerts]);

  const zones = state?.zones ?? [];
  const activeAlerts = alerts.filter((a) => a.status === "active").length;
  const nCritical = zones.filter((z) => z.status === "critical").length;
  const nAttention = zones.filter(needsAttention).length;
  const nAi = zones.filter((z) => z.ai?.alert).length;
  const shown = zones.filter((z) => (filter === "all" ? true : filter === "attention" ? needsAttention(z) : z.type === filter));

  const goAlerts = () => {
    setView("dashboard");
    setTimeout(() => document.getElementById("alerts")?.scrollIntoView({ behavior: "smooth" }), 60);
  };
  const [t1, t2] = TITLES[view];

  return (
    <div className="app">
      {intro && <Onboarding onDone={finishIntro} />}

      <header className="appbar">
        <div className="avatar" aria-hidden="true">TG</div>
        <div className="hello">
          <b>Hi, Operator</b>
          <span>{greeting()} · <span className="pill-sim">SIMULATED DATA</span></span>
        </div>
        <div className="grow" />
        <span className={`conn ${conn}`} role="status"><b>{CONN_LABEL[conn]}</b><span>{state ? new Date(state.timestamp).toLocaleTimeString() : "no data yet"}</span></span>
        <button className="round-btn" onClick={goAlerts} aria-label={`Alerts: ${activeAlerts} active`}>
          <Icon name="bell" />
          {activeAlerts > 0 && <span className="count">{activeAlerts}</span>}
        </button>
      </header>

      <h1 className="title">{t1}<br /><em>{t2}</em></h1>

      <AlertBanner alerts={alerts} />

      {view === "heat" ? (
        <HeatmapView state={state} />
      ) : view === "insights" ? (
        <Insights state={state} />
      ) : view === "plan" ? (
        <FloorPlanEditor />
      ) : view === "sim" ? (
        <SimControls zones={zones} sim={state?.sim} />
      ) : (
        <>
          {error && <p className="alert" role="alert">{error}</p>}
          {state && (
            <section className="hero" aria-label="Plant status">
              <div className="hero-in">
                <div>
                  <div className="hero-tags">
                    <span className="tag">{zones.length} zones</span>
                    {state.sim && <span className={`tag ${state.sim.paused ? "warm" : "good"}`}>{state.sim.paused ? "Paused" : "Running"} · step {state.sim.step}</span>}
                    {nAi > 0 && <span className="tag warm">✦ {nAi} AI warning{nAi > 1 ? "s" : ""}</span>}
                  </div>
                  <h2>{nCritical > 0 ? `${nCritical} zone${nCritical > 1 ? "s" : ""} out of range` : nAttention > 0 ? `${nAttention} zone${nAttention > 1 ? "s" : ""} need attention` : zones.length ? "All zones stable" : "No zones yet"}</h2>
                  <p>{zones.length ? "Open the heatmap to see where the heat is." : "Open the Floor plan tab, draw a zone and set its temperature limits."}</p>
                </div>
                <div className="kpis">
                  <div className="kpi good"><b>{zones.length - nAttention}</b><span>Stable</span></div>
                  <div className={`kpi ${nAttention ? "warn" : ""}`}><b>{nAttention}</b><span>Attention</span></div>
                  <div className={`kpi ${activeAlerts ? "bad" : ""}`}><b>{activeAlerts}</b><span>Alerts</span></div>
                </div>
              </div>
            </section>
          )}

          {zones.length > 0 && (
            <div className="chips" role="tablist" aria-label="Filter zones">
              {FILTERS.map((f) => (
                <button key={f.key} role="tab" aria-selected={filter === f.key} className={`chip ${filter === f.key ? "on" : ""}`} onClick={() => setFilter(f.key)}>
                  {f.label}{f.key === "attention" && nAttention ? ` (${nAttention})` : ""}
                </button>
              ))}
            </div>
          )}

          {state && zones.length === 0 ? (
            <p className="empty">No zones yet. Open the Floor plan tab, draw a zone and set its temperature limits.</p>
          ) : state ? (
            shown.length === 0 ? (
              <p className="empty">No zones match this filter right now.</p>
            ) : (
              <main className={`grid ${conn !== "connected" ? "stale" : ""}`}>
                {shown.map((z) => <ZoneCard key={z.id} zone={z} />)}
              </main>
            )
          ) : (
            <p className="empty">Waiting for the first reading from the server…</p>
          )}
          <AlertFeed alerts={alerts} soundOn={soundOn} onToggleSound={toggleSound} />
        </>
      )}

      <p className="foot-link">Thermal Guard · all data is simulated · <button onClick={() => setIntro(true)}>Show intro</button></p>

      <nav className="dock" aria-label="Main">
        {NAV.map((n) => (
          <button key={n.view} className={view === n.view ? "on" : ""} aria-label={n.label} aria-current={view === n.view ? "page" : undefined} title={n.label} onClick={() => setView(n.view)}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
