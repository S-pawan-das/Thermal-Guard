import { useState } from "react";
import Icon from "./icons";

// First-visit intro, three swipe-able slides in the style of a mobile onboarding. Skippable; remembered in localStorage.
function ArtHeat() {
  return (
    <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="h1"><stop offset="0" stopColor="#e5381a" /><stop offset=".45" stopColor="#f6a623" stopOpacity=".85" /><stop offset="1" stopColor="#f6a623" stopOpacity="0" /></radialGradient>
        <radialGradient id="h2"><stop offset="0" stopColor="#f6a623" /><stop offset="1" stopColor="#3ab98a" stopOpacity="0" /></radialGradient>
        <radialGradient id="h3"><stop offset="0" stopColor="#2f7be8" /><stop offset="1" stopColor="#2f7be8" stopOpacity="0" /></radialGradient>
      </defs>
      <rect width="400" height="300" fill="#e6f5ee" />
      <circle cx="120" cy="190" r="120" fill="url(#h3)" />
      <circle cx="290" cy="120" r="130" fill="url(#h1)" />
      <circle cx="230" cy="220" r="80" fill="url(#h2)" />
      <g fill="none" stroke="#fff" strokeWidth="5" strokeLinejoin="round">
        <rect x="34" y="60" width="130" height="90" rx="10" /><rect x="180" y="60" width="190" height="100" rx="10" />
        <rect x="34" y="166" width="100" height="94" rx="10" /><rect x="150" y="178" width="220" height="82" rx="10" />
      </g>
      <g fill="#fff"><rect x="214" y="96" width="30" height="22" rx="6" /><rect x="262" y="96" width="30" height="22" rx="6" /><rect x="310" y="96" width="30" height="22" rx="6" /></g>
    </svg>
  );
}
function ArtCube() {
  return (
    <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs><linearGradient id="f1" x1="0" x2="1"><stop offset="0" stopColor="#3ab98a" /><stop offset=".5" stopColor="#f6c445" /><stop offset="1" stopColor="#e5381a" /></linearGradient></defs>
      <rect width="400" height="300" fill="#eef0f6" />
      <polygon points="50,175 200,95 350,175 200,255" fill="url(#f1)" />
      <g fill="none" stroke="#fff" strokeWidth="4" strokeLinejoin="round" opacity=".95">
        <polygon points="120,172 200,130 250,157 170,199" /><polygon points="228,176 280,148 318,168 266,196" />
      </g>
      <g strokeLinejoin="round">
        <polygon points="190,150 214,138 238,150 214,162" fill="#fff" /><polygon points="190,150 214,162 214,186 190,174" fill="#d7dade" /><polygon points="214,162 238,150 238,174 214,186" fill="#bfc3c9" />
        <polygon points="262,174 282,164 302,174 282,184" fill="#fff" /><polygon points="262,174 282,184 282,204 262,194" fill="#d7dade" /><polygon points="282,184 302,174 302,194 282,204" fill="#bfc3c9" />
        <polygon points="130,178 150,168 170,178 150,188" fill="#fff" /><polygon points="130,178 150,188 150,208 130,198" fill="#d7dade" /><polygon points="150,188 170,178 170,198 150,208" fill="#bfc3c9" />
      </g>
    </svg>
  );
}
function ArtAi() {
  return (
    <svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="400" height="300" fill="#fff2ec" />
      <line x1="30" y1="96" x2="372" y2="96" stroke="#d6264a" strokeWidth="3" strokeDasharray="8 7" />
      <text x="34" y="86" fontSize="13" fontWeight="700" fill="#d6264a">limit</text>
      <path d="M30 230 C120 228 170 224 215 190 S300 110 372 60" fill="none" stroke="#111214" strokeWidth="6" strokeLinecap="round" />
      <line x1="200" y1="60" x2="200" y2="250" stroke="#d93b0a" strokeWidth="3" />
      <rect x="150" y="40" width="100" height="30" rx="15" fill="#d93b0a" /><text x="200" y="60" textAnchor="middle" fontSize="14" fontWeight="800" fill="#fff">AI warns</text>
      <line x1="330" y1="96" x2="330" y2="250" stroke="#8a8d93" strokeWidth="3" />
      <rect x="262" y="214" width="136" height="30" rx="15" fill="#8a8d93" /><text x="330" y="234" textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff">plain alarm</text>
      <circle cx="330" cy="96" r="9" fill="#fff" stroke="#d6264a" strokeWidth="5" />
    </svg>
  );
}

const SLIDES = [
  { art: <ArtHeat />, a: "Smarter factories", b: "start here", text: "Every zone's temperature, live, on one floor plan, with limits you set." },
  { art: <ArtCube />, a: "Heat you can", b: "walk around", text: "A live 3D model of your plant. Red means trouble, green means in range." },
  { art: <ArtAi />, a: "Warned before", b: "it goes wrong", text: "A trained AI model flags zones heading out of range, ahead of a plain alarm. All data here is simulated." },
];

export default function Onboarding({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const s = SLIDES[i];
  const last = i === SLIDES.length - 1;
  return (
    <div className="intro" role="dialog" aria-modal="true" aria-label="Welcome to Thermal Guard">
      <div className="intro-art">
        <button className="skip" onClick={onDone}>Skip</button>
        {s.art}
      </div>
      <div className="intro-body">
        <h1>{s.a}<span>{s.b}</span></h1>
        <p>{s.text}</p>
        <div className="intro-foot">
          <div className="dots" aria-hidden="true">{SLIDES.map((_, k) => <i key={k} className={k === i ? "on" : ""} />)}</div>
          <div className="pager">
            <button aria-label="Previous" disabled={i === 0} onClick={() => setI(i - 1)}><Icon name="arrow" size={22} className="flip" /></button>
            <button className="go" aria-label={last ? "Get started" : "Next"} onClick={() => (last ? onDone() : setI(i + 1))}><Icon name={last ? "check" : "arrow"} size={22} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
