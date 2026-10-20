import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { AlertRecord, AlertsMessage, StateMessage } from "../../shared/types";
import ZoneCard from "./components/ZoneCard";
import FloorPlanEditor from "./components/FloorPlanEditor";
import AlertBanner from "./components/AlertBanner";
import AlertFeed from "./components/AlertFeed";
import SimControls from "./components/SimControls";

type Connection = "connecting" | "connected" | "disconnected";
type View = "dashboard" | "plan" | "sim";
const CONN_LABEL: Record<Connection, string> = {
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
};

export default function App() {
  const [state, setState] = useState<StateMessage | null>(null);
  const [conn, setConn] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [soundOn, setSoundOn] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const seenCritical = useRef<Set<string> | null>(null);

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
    socket.on("connect", () => {
      setConn("connected");
      setError(null);
    });
    socket.on("disconnect", () => setConn("disconnected"));
    socket.on("connect_error", () => {
      setConn("disconnected");
      setError("Cannot reach the backend. Check that the server is running on port 3001.");
    });
    socket.io.on("reconnect_attempt", () => setConn("connecting"));
    socket.on("state", (msg: StateMessage) => setState(msg));
    socket.on("alerts", (msg: AlertsMessage) => setAlerts(msg.alerts));
    return () => {
      socket.close();
    };
  }, []);

  // beep once for each NEW critical alert (never for ones that were already active when the page loaded)
  useEffect(() => {
    const ids = new Set(alerts.filter((a) => a.status === "active" && a.severity === "critical").map((a) => a.id));
    if (seenCritical.current && soundOn && [...ids].some((id) => !seenCritical.current!.has(id))) beep();
    seenCritical.current = ids;
  }, [alerts]);

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Thermal Guard</h1>
          <span className="sim">SIMULATED DATA</span>
        </div>
        <div className="meta">
          <span className={`conn ${conn}`}>{CONN_LABEL[conn]}</span>
          <small>
            Last updated: {state ? new Date(state.timestamp).toLocaleTimeString() : "no data yet"}
          </small>
        </div>
      </header>

      <nav className="tabs">
        <button className={view === "dashboard" ? "on" : ""} onClick={() => setView("dashboard")}>Dashboard</button>
        <button className={view === "plan" ? "on" : ""} onClick={() => setView("plan")}>Floor plan</button>
        <button className={view === "sim" ? "on" : ""} onClick={() => setView("sim")}>Simulator</button>
      </nav>

      <AlertBanner alerts={alerts} />

      {view === "plan" ? (
        <FloorPlanEditor />
      ) : view === "sim" ? (
        <SimControls zones={state?.zones ?? []} sim={state?.sim} />
      ) : (
        <>
          {error && <p className="alert" role="alert">{error}</p>}
          {state && state.zones.length === 0 ? (
            <p className="empty">No zones yet. Open the Floor plan tab, draw a zone and set its temperature limits.</p>
          ) : state ? (
            <main className={`grid ${conn !== "connected" ? "stale" : ""}`}>
              {state.zones.map((z) => (
                <ZoneCard key={z.id} zone={z} />
              ))}
            </main>
          ) : (
            <p className="empty">Waiting for the first reading from the server…</p>
          )}
          <AlertFeed alerts={alerts} soundOn={soundOn} onToggleSound={toggleSound} />
        </>
      )}
    </div>
  );
}
