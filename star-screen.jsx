import React, { useState, useMemo } from "react";

/*
  STAR Screen
  An athlete-facing implementation of the WEIGHTED Sport Training Assessment of
  Risk (Schley et al., "A Risk Tool for Evaluating Overuse Injury and
  Return-to-Play Time Periods in Youth and Collegiate Athletes: Preliminary
  Study," Sports Health 2025; doi 10.1177/19417381241285865).

  Four views:
  1) Screen       - single point-in-time risk profile (STAR Table 2, total 8-25)
  2) Load tracker - longitudinal acute:chronic workload monitoring (the STAR ACWR
                    component, which only works with a rolling history)
  3) Find care    - symptom triage + nearby providers (live NPI registry, with a
                    curated regional fallback)
  4) About        - citation, limitations, and what is original here

  Every cutoff and weight below is transcribed directly from the paper's Table 2.
  Scoring is isolated in pure functions so it ports to any backend unchanged.
*/

// ============================================================
// SCORING ENGINE  (faithful to Schley et al. 2025, Table 2)
// ============================================================
//
// Weighted points, verbatim from the published table:
//   Injury status        none=1     overuse=2      serious overuse=3
//   STR (org:freeplay)    <=2:1 =1   >2:1 =2
//   CTR (comp:training)   <1:3 =1    1:3 to <=1:1 =2    >1:1 =3
//   ACWR                  0.8-1.3=1  (<0.8 OR >1.3-1.5)=2   >1.5=3
//   PPAH (maturation)     >96% =1    <85% =2            85-96% =3
//   Female sex            No=1       Yes=3
//   Specialization        low(0-1)=1 moderate(2)=3     high(3)=5
//   Weekly hours vs age   <=age =1   >age =3
// Total 8-25. Bins as implemented: 8-12 low, 13-15 medium, >=16 high.
// (The study reported its high band as 16-22; this code treats any score >=16 as
// high, so theoretical maxima of 23-25 are also classified high.)

const scoreSex = (sex) => (sex === "F" ? 3 : 1);

const scoreSpecialization = (yes) => (yes >= 3 ? 5 : yes === 2 ? 3 : 1);

const scoreInjury = (s) => (s === "serious" ? 3 : s === "overuse" ? 2 : 1);

const scoreSTR = (org, free) =>
  !free || free <= 0 ? (org > 0 ? 2 : 1) : org / free > 2 ? 2 : 1;

function scoreCTR(comp, train) {
  if (!train || train <= 0) return comp > 0 ? 3 : 1;
  const r = comp / train;
  if (r > 1) return 3;
  if (r >= 1 / 3) return 2;
  return 1;
}

function scoreACWR(acwr) {
  if (acwr == null || isNaN(acwr)) return 1;
  if (acwr > 1.5) return 3;
  if (acwr < 0.8 || acwr > 1.3) return 2; // <0.8 OR (1.3, 1.5]
  return 1; // 0.8 - 1.3 inclusive
}

const scoreWorkloadVsAge = (hrs, age) => (hrs > age ? 3 : 1);

const scorePPAH = (stage) =>
  stage === "circa" ? 3 : stage === "pre" ? 2 : 1; // post/unknown = 1

const nf = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};

function computeRisk(input) {
  const yes = (input.spec1 ? 1 : 0) + (input.spec2 ? 1 : 0) + (input.spec3 ? 1 : 0);
  const organized = nf(input.trainHrs) + nf(input.compHrs);
  const acwr = nf(input.chronicHrs) > 0 ? nf(input.acuteHrs) / nf(input.chronicHrs) : null;

  const factors = [
    { key: "spec", label: "Sport specialization", points: scoreSpecialization(yes), max: 5, modifiable: true,
      entered: true, detail: yes >= 3 ? "High (3/3)" : yes === 2 ? "Moderate (2/3)" : "Low (0-1/3)" },
    { key: "sex", label: "Biological sex", points: scoreSex(input.sex), max: 3, modifiable: false,
      entered: true, detail: input.sex === "F" ? "Female" : "Male" },
    { key: "wla", label: "Weekly hours vs age", points: scoreWorkloadVsAge(organized, nf(input.age)), max: 3, modifiable: true,
      entered: organized > 0 && nf(input.age) > 0, detail: `${organized || 0} hrs vs age ${input.age || "?"}` },
    { key: "acwr", label: "Acute : chronic workload", points: scoreACWR(acwr), max: 3, modifiable: true,
      entered: acwr != null, detail: acwr ? `ratio ${acwr.toFixed(2)}` : "not entered" },
    { key: "ctr", label: "Competition : training", points: scoreCTR(nf(input.compHrs), nf(input.trainHrs)), max: 3, modifiable: true,
      entered: nf(input.trainHrs) > 0, detail: nf(input.trainHrs) > 0 ? `ratio ${(nf(input.compHrs) / nf(input.trainHrs)).toFixed(2)}` : "not entered" },
    { key: "ppah", label: "Growth / maturation", points: scorePPAH(input.maturity), max: 3, modifiable: false,
      entered: !!input.maturity, detail: input.maturity === "circa" ? "Around growth spurt" : input.maturity === "pre" ? "Before growth spurt" : input.maturity === "post" ? "After growth spurt" : "not assessed" },
    { key: "str", label: "Organized : free play", points: scoreSTR(organized, nf(input.freePlayHrs)), max: 2, modifiable: true,
      entered: nf(input.freePlayHrs) > 0, detail: nf(input.freePlayHrs) > 0 ? `ratio ${(organized / nf(input.freePlayHrs)).toFixed(1)}` : "not entered" },
    { key: "injury", label: "Current injury status", points: scoreInjury(input.injury), max: 3, modifiable: true,
      entered: true, detail: input.injury === "serious" ? "Serious overuse" : input.injury === "overuse" ? "Overuse" : "None" },
  ];

  // A factor with missing inputs must never inflate the score. Every STAR factor's
  // minimum weighted value is 1, so unentered factors are pinned to 1 point. This
  // also keeps the UI's "missing factors score lowest" statement literally true.
  for (const f of factors) {
    if (!f.entered) f.points = 1;
  }

  const total = factors.reduce((s, f) => s + f.points, 0);
  const band = total >= 16 ? "high" : total >= 13 ? "medium" : "low";
  const complete = factors.filter((f) => f.entered).length;
  return { factors, total, band, complete, of: factors.length };
}

// ============================================================
// LONGITUDINAL ACWR  (STAR ACWR component over a rolling history)
// ============================================================
// acute  = current week's load
// chronic= mean of the previous 4 weeks (paper: "week ... divided by a rolling
//          mean of volume over the previous 4 weeks"). Provisional when <4 exist.
function buildSeries(weeks) {
  return weeks.map((w, i) => {
    const prior = weeks.slice(Math.max(0, i - 4), i);
    const chronic = prior.length ? prior.reduce((s, x) => s + x.hours, 0) / prior.length : null;
    const acwr = chronic ? w.hours / chronic : null;
    return { ...w, chronic, acwr, priorCount: prior.length, points: scoreACWR(acwr) };
  });
}
function acwrStatus(acwr) {
  if (acwr == null) return { label: "Building baseline", color: "#8A93A0" };
  if (acwr > 1.5) return { label: "STAR higher-point range (>1.5)", color: "#D6484B" };
  if (acwr > 1.3) return { label: "STAR mid-point range (1.3-1.5)", color: "#E0A226" };
  if (acwr < 0.8) return { label: "STAR mid-point range (<0.8)", color: "#E0A226" };
  return { label: "STAR lower-point range (0.8-1.3)", color: "#1F9D6B" };
}

// ============================================================
// DESIGN SYSTEM
// ============================================================
const C = {
  ink: "#141C27", surface: "#F5F6F8", card: "#FFFFFF", line: "#E2E5EA",
  sub: "#5E6672", accent: "#2B5CE6", low: "#1F9D6B", medium: "#E0A226", high: "#D6484B",
};
const bandColor = (b) => (b === "high" ? C.high : b === "medium" ? C.medium : C.low);
const bandLabel = (b) => (b === "high" ? "Higher load profile" : b === "medium" ? "Moderate load profile" : "Lower load profile");
const ptColor = (p, max) => (p >= max ? C.high : p > 1 ? C.medium : C.low);

const GUIDANCE = {
  spec: "Keep a second sport in the mix and avoid training one sport more than 8 months a year.",
  wla: "Pull weekly organized hours down toward age in years; that threshold repeatedly tracks with overuse risk.",
  acwr: "Avoid load spikes. Ramp weekly volume gradually so this week is not far above the 4-week average.",
  ctr: "Ease competition volume relative to training when this climbs above 1:1.",
  str: "Protect unstructured free play; more organized load per hour of free play raises risk.",
  injury: "Follow a clinician's return-to-play progression before adding load.",
};

const SAMPLE_WEEKS = [
  { label: "W1", hours: 10 }, { label: "W2", hours: 11 }, { label: "W3", hours: 10 },
  { label: "W4", hours: 12 }, { label: "W5", hours: 13 }, { label: "W6", hours: 12 },
  { label: "W7", hours: 20 }, { label: "W8", hours: 15 },
];

// ============================================================
// APP
// ============================================================
export default function StarScreen() {
  const [tab, setTab] = useState("screen");
  const [started, setStarted] = useState(false);
  return (
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", background: C.surface, color: C.ink, minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        .display { font-family: 'Barlow Semi Condensed', Inter, sans-serif; }
        .wrap { max-width: 1080px; margin: 0 auto; padding: 26px 20px 80px; }
        .grid { display: grid; grid-template-columns: 1fr; gap: 24px; }
        @media (min-width: 900px){ .grid { grid-template-columns: 1.15fr 0.85fr; align-items: start; } }
        .card { background: ${C.card}; border: 1px solid ${C.line}; border-radius: 14px; padding: 22px; }
        .aside { position: static; }
        @media (min-width: 900px){ .aside { position: sticky; top: 20px; } }
        .tabs { display:inline-flex; background:#fff; border:1px solid ${C.line}; border-radius:10px; padding:3px; margin-top:14px; }
        .tabs button { border:none; background:none; padding:8px 16px; border-radius:7px; font-size:13.5px; font-family:inherit; cursor:pointer; color:${C.sub}; font-weight:500; }
        .tabs button.on { background:${C.ink}; color:#fff; }
        .qrow { display:flex; justify-content:space-between; gap:14px; align-items:center; padding:13px 0; border-top:1px solid ${C.line}; }
        .qrow:first-child { border-top:none; }
        .qlabel { font-size:14px; line-height:1.35; }
        .hint { color:${C.sub}; font-size:12.5px; margin-top:2px; }
        label.field { display:block; font-size:12.5px; color:${C.sub}; margin-bottom:5px; }
        input[type=number], select { width:100%; padding:9px 11px; border:1px solid ${C.line}; border-radius:9px; font-size:14px; font-family:inherit; background:#fff; color:${C.ink}; }
        input:focus, select:focus, button:focus-visible { outline:2px solid ${C.accent}; outline-offset:1px; }
        .seg { display:inline-flex; border:1px solid ${C.line}; border-radius:9px; overflow:hidden; }
        .seg button { border:none; background:#fff; padding:8px 14px; font-size:13px; font-family:inherit; cursor:pointer; color:${C.sub}; }
        .seg button.on { background:${C.ink}; color:#fff; }
        .seg.sm button { padding:6px 10px; font-size:12px; }
        .yn { display:inline-flex; gap:6px; }
        .yn button { border:1px solid ${C.line}; background:#fff; border-radius:8px; padding:6px 15px; font-size:13px; font-family:inherit; cursor:pointer; color:${C.sub}; }
        .yn button.on { border-color:${C.ink}; background:${C.ink}; color:#fff; }
        .sec-title { font-size:12px; letter-spacing:0.04em; color:${C.sub}; margin:26px 0 8px; font-weight:600; }
        .two { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        .primary { width:100%; margin-top:22px; background:${C.accent}; color:#fff; border:none; border-radius:10px; padding:13px; font-size:15px; font-weight:600; font-family:inherit; cursor:pointer; }
        .ghost { background:#fff; border:1px solid ${C.line}; color:${C.ink}; border-radius:9px; padding:9px 14px; font-size:13px; font-family:inherit; cursor:pointer; }
        .meter { position:relative; height:14px; border-radius:8px; margin:14px 0 6px;
          background: linear-gradient(90deg, ${C.low} 0%, ${C.low} 29.4%, ${C.medium} 29.4%, ${C.medium} 47%, ${C.high} 47%, ${C.high} 100%); }
        .marker { position:absolute; top:-6px; width:3px; height:26px; background:${C.ink}; border-radius:2px; transform:translateX(-1.5px); transition:left .35s cubic-bezier(.2,.7,.2,1); }
        .frow { display:flex; align-items:center; gap:10px; padding:9px 0; border-top:1px solid ${C.line}; font-size:13px; }
        .pill { font-family:'Barlow Semi Condensed',sans-serif; font-weight:700; min-width:26px; text-align:center; border-radius:6px; padding:1px 6px; font-size:14px; color:#fff; }
        .bar { flex:1; height:7px; background:${C.surface}; border-radius:4px; overflow:hidden; }
        .bar > i { display:block; height:100%; border-radius:4px; }
        .tag { font-size:10.5px; padding:1px 6px; border-radius:5px; border:1px solid ${C.line}; color:${C.sub}; }
        .disclaimer { font-size:11.5px; color:${C.sub}; line-height:1.5; margin-top:14px; }
        .results { display:grid; grid-template-columns:1fr; gap:14px; margin-top:16px; }
        @media (min-width:720px){ .results { grid-template-columns:1fr 1fr; } }
        .listing { background:#fff; border:1px solid ${C.line}; border-radius:14px; overflow:hidden; display:flex; flex-direction:column; }
        .listing .thumb { display:block; height:150px; background:${C.surface}; position:relative; overflow:hidden; }
        .listing .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
        .listing .thumb .ph { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:${C.sub}; font-size:12px; }
        .listing .body { padding:14px 16px 16px; }
        .listing h4 { margin:0; font-size:15.5px; font-weight:600; }
        .listing .meta { font-size:12.5px; color:${C.sub}; margin-top:4px; line-height:1.5; }
        .listing .acts { display:flex; gap:8px; margin-top:13px; }
        .listing .acts a { flex:1; text-align:center; text-decoration:none; font-size:13px; font-family:inherit; padding:8px 10px; border-radius:9px; }
        .listing .acts .g { background:${C.accent}; color:#fff; }
        .listing .acts .d { background:#fff; border:1px solid ${C.line}; color:${C.ink}; }
        @media (prefers-reduced-motion: reduce){ .marker{ transition:none; } }
      `}</style>

      <div className="wrap">
        {!started ? (
          <Intro onStart={() => setStarted(true)} />
        ) : (
          <>
            <header>
              <div className="display" style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.01em" }}>STAR Screen</div>
              <div style={{ color: C.sub, fontSize: 14, marginTop: 2, maxWidth: 640 }}>
                A load-and-growth check for youth athletes, built on the Sport Training Assessment of Risk. It flags the research-backed training habits you can change to lower overuse-injury risk.
              </div>
              <div className="tabs">
                <button className={tab === "screen" ? "on" : ""} onClick={() => setTab("screen")}>Screen</button>
                <button className={tab === "tracker" ? "on" : ""} onClick={() => setTab("tracker")}>Load tracker</button>
                <button className={tab === "care" ? "on" : ""} onClick={() => setTab("care")}>Find care</button>
                <button className={tab === "about" ? "on" : ""} onClick={() => setTab("about")}>About the science</button>
              </div>
            </header>

            {tab === "screen" && <ScreenView />}
            {tab === "tracker" && <TrackerView />}
            {tab === "care" && <FindCareView />}
            {tab === "about" && <AboutView />}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// INTRO  (cold-start explainer, trust, honest framing)
// ------------------------------------------------------------
function Intro({ onStart }) {
  const rows = [
    ["Screen", "Answer a few plain questions and see which risk factors are yours, and which ones you can actually change."],
    ["Load tracker", "Log your weekly hours and watch your acute-to-chronic workload, one of the workload measures STAR uses."],
    ["Find care", "Tell it what hurts and it points you to the right kind of provider nearby."],
  ];
  return (
    <div className="card" style={{ maxWidth: 640, margin: "10px auto" }}>
      <div className="display" style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.01em" }}>STAR Screen</div>
      <p style={{ color: C.sub, fontSize: 14.5, lineHeight: 1.55, marginTop: 8 }}>
        Overuse injuries in young athletes are associated with factors including training volume, specialization, growth, and rapid changes in workload. This is a quick check, about three minutes, that looks at those factors and shows the habits you can change to lower that risk.
      </p>
      <div style={{ display: "grid", gap: 10, marginTop: 8 }}>
        {rows.map(([t, d]) => (
          <div key={t} style={{ display: "flex", gap: 12 }}>
            <span style={{ fontWeight: 600, fontSize: 13.5, minWidth: 92 }}>{t}</span>
            <span style={{ color: C.sub, fontSize: 13, lineHeight: 1.45 }}>{d}</span>
          </div>
        ))}
      </div>
      <div style={{ background: C.surface, borderRadius: 10, padding: "12px 14px", marginTop: 16, fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>
        Everything you enter stays on your device. This is an education tool, not a diagnosis. It flags research-backed risk factors rather than predicting injuries. For pain or a suspected injury, see a clinician or athletic trainer.
      </div>
      <button className="primary" onClick={onStart}>Start</button>
    </div>
  );
}

// ------------------------------------------------------------
// ABOUT THE SCIENCE
// ------------------------------------------------------------
function AboutView() {
  return (
    <div className="card" style={{ maxWidth: 720, margin: "22px auto 0" }}>
      <div className="display" style={{ fontSize: 24, fontWeight: 700 }}>About the science</div>

      <div className="sec-title">The tool this is built on</div>
      <p style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.6, margin: 0 }}>
        STAR (Sport Training Assessment of Risk) is a point-based overuse-injury risk tool for youth and collegiate athletes. This app implements its weighted scoring model.
      </p>
      <div style={{ fontSize: 13, lineHeight: 1.6, marginTop: 12, padding: "12px 14px", background: C.surface, borderRadius: 10 }}>
        Schley S, Buser A, Render A, Ramirez ME, Truong C, Easley KA, Shenvi N, Jayanthi N.{" "}
        <em>A Risk Tool for Evaluating Overuse Injury and Return-to-Play Time Periods in Youth and Collegiate Athletes: Preliminary Study.</em> Sports Health. 2025 Jan-Feb.
        <br />
        <a href="https://doi.org/10.1177/19417381241285865" target="_blank" rel="noreferrer" style={{ color: C.accent }}>doi.org/10.1177/19417381241285865</a>
      </div>

      <div className="sec-title">What STAR is, and is not</div>
      <ul style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.6, margin: 0, paddingLeft: 18 }}>
        <li>STAR is preliminary. In the published study it reached an AUC of 0.66 for overuse injury, below the usual threshold for acceptable prediction, and the authors state it needs further development, calibration, and validation.</li>
        <li>It was built on a cohort of youth and collegiate athletes who presented to a clinic with an injury, not a healthy screening population.</li>
        <li>Several workload factors were not individually statistically significant in that study and are described as needing further investigation.</li>
        <li>It is a risk-factor screen, not a diagnosis, and does not predict whether any individual athlete will be injured.</li>
      </ul>

      <div className="sec-title">What I built</div>
      <p style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.6, margin: 0 }}>
        The STAR researchers developed the scientific framework and scoring system. This app is an independent student implementation of that published framework. My work is the translation into an athlete-facing tool: an interactive risk-factor screen, a longitudinal acute-to-chronic workload tracker, plain-language explanations of which factors are changeable, and a care-routing feature. The underlying medical model is theirs; the implementation and usability are mine.
      </p>
      <p style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6, marginTop: 12, fontWeight: 500 }}>
        Developed with permission to build on the published STAR framework.
      </p>

      <div className="disclaimer" style={{ marginTop: 16 }}>
        Permission to build on the framework is not an endorsement; the STAR authors have not endorsed this app. It is an educational student project. For pain or a suspected injury, see a clinician or athletic trainer.
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// SCREEN VIEW
// ------------------------------------------------------------
function ScreenView() {
  const [input, setInput] = useState({
    age: "", sex: "M", spec1: false, spec2: false, spec3: false,
    trainHrs: "", compHrs: "", freePlayHrs: "", acuteHrs: "", chronicHrs: "",
    maturity: "", injury: "none",
  });
  const [showResult, setShowResult] = useState(false);
  const set = (k, v) => setInput((s) => ({ ...s, [k]: v }));

  const risk = useMemo(() => computeRisk(input), [input]);
  const drivers = risk.factors
    .filter((f) => f.modifiable && f.points >= f.max && f.points > 1)
    .sort((a, b) => b.points - a.points);

  return (
    <div className="grid" style={{ marginTop: 22 }}>
      <div className="card">
        <div className="sec-title" style={{ marginTop: 0 }}>The athlete</div>
        <div className="two">
          <div>
            <label className="field">Age (years)</label>
            <input type="number" value={input.age} min="8" max="25" onChange={(e) => set("age", e.target.value)} />
          </div>
          <div>
            <label className="field">Biological sex</label>
            <div className="seg">
              <button className={input.sex === "M" ? "on" : ""} onClick={() => set("sex", "M")}>Male</button>
              <button className={input.sex === "F" ? "on" : ""} onClick={() => set("sex", "F")}>Female</button>
            </div>
          </div>
        </div>

        <div className="sec-title">Specialization</div>
        {[
          ["spec1", "Do you have one main sport?"],
          ["spec2", "Do you train your main sport more than 8 months a year?"],
          ["spec3", "Have you dropped other sports to focus on it (or only ever played one)?"],
        ].map(([k, q]) => (
          <div className="qrow" key={k}>
            <div className="qlabel">{q}</div>
            <div className="yn">
              <button className={input[k] ? "on" : ""} onClick={() => set(k, true)}>Yes</button>
              <button className={!input[k] ? "on" : ""} onClick={() => set(k, false)}>No</button>
            </div>
          </div>
        ))}

        <div className="sec-title">Training load (typical week)</div>
        <div className="two">
          <div><label className="field">Training hours / week</label>
            <input type="number" value={input.trainHrs} min="0" onChange={(e) => set("trainHrs", e.target.value)} /></div>
          <div><label className="field">Competition hours / week</label>
            <input type="number" value={input.compHrs} min="0" onChange={(e) => set("compHrs", e.target.value)} /></div>
          <div><label className="field">Free / unstructured play hours</label>
            <input type="number" value={input.freePlayHrs} min="0" onChange={(e) => set("freePlayHrs", e.target.value)} /></div>
        </div>

        <div className="sec-title">Recent load change (acute : chronic)</div>
        <div className="two">
          <div><label className="field">Total sport hours last week</label>
            <input type="number" value={input.acuteHrs} min="0" onChange={(e) => set("acuteHrs", e.target.value)} /></div>
          <div><label className="field">Avg weekly hours, past 4 weeks</label>
            <input type="number" value={input.chronicHrs} min="0" onChange={(e) => set("chronicHrs", e.target.value)} /></div>
        </div>
        <div className="hint">The Load tracker tab computes this automatically from a rolling history.</div>

        <div className="sec-title">Growth stage</div>
        <select value={input.maturity} onChange={(e) => set("maturity", e.target.value)}>
          <option value="">Not assessed</option>
          <option value="pre">Before growth spurt</option>
          <option value="circa">Around growth spurt</option>
          <option value="post">After growth spurt</option>
        </select>
        <div className="hint">STAR uses maturation (percentage of predicted adult height) via the Khamis-Roche method, best measured with a clinician. Pick a stage if you know it, or leave it unassessed.</div>

        <div className="sec-title">Current injury status</div>
        <select value={input.injury} onChange={(e) => set("injury", e.target.value)}>
          <option value="none">No current injury</option>
          <option value="overuse">Overuse injury (tendon pain, apophysitis)</option>
          <option value="serious">Serious overuse (stress fracture, needs a month off)</option>
        </select>

        <button className="primary" onClick={() => setShowResult(true)}>See risk profile</button>
      </div>

      <aside className="aside">
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div className="sec-title" style={{ margin: 0 }}>Weighted STAR score</div>
            <div className="tag">range 8-25</div>
          </div>
          {showResult ? (
            <>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginTop: 6 }}>
                <div className="display" style={{ fontSize: 58, fontWeight: 700, lineHeight: 0.9, color: bandColor(risk.band) }}>{risk.total}</div>
                <div style={{ paddingBottom: 8 }}>
                  <div className="display" style={{ fontSize: 18, fontWeight: 600, color: bandColor(risk.band) }}>{bandLabel(risk.band)}</div>
                  <div style={{ fontSize: 12.5, color: C.sub }}>
                    {risk.band === "high" ? "Several risk factors are stacking up." : risk.band === "medium" ? "Some risk factors are stacking up." : "Few risk factors are stacking up."}
                  </div>
                </div>
              </div>
              <div className="meter"><div className="marker" style={{ left: `${((risk.total - 8) / 17) * 100}%` }} /></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.sub }}>
                <span>low</span><span>moderate</span><span>high</span>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginTop: 6 }}>
              <div className="display" style={{ fontSize: 58, fontWeight: 700, lineHeight: 0.9, color: C.sub }}>--</div>
              <div style={{ paddingBottom: 10, fontSize: 13, color: C.sub, lineHeight: 1.4 }}>Complete the screen, then tap See risk profile.</div>
            </div>
          )}

          {showResult && (
            <>
              <div className="sec-title" style={{ marginTop: 22 }}>What is driving the score</div>
              {[...risk.factors].sort((a, b) => b.points - a.points).map((f) => (
                <div className="frow" key={f.key}>
                  <span className="pill" style={{ background: ptColor(f.points, f.max) }}>{f.points}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span>{f.label}</span>
                      <span className="tag">{f.modifiable ? "changeable" : "fixed"}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
                      <div className="bar"><i style={{ width: `${(f.points / f.max) * 100}%`, background: ptColor(f.points, f.max) }} /></div>
                      <span style={{ fontSize: 11.5, color: C.sub, minWidth: 96, textAlign: "right" }}>{f.detail}</span>
                    </div>
                  </div>
                </div>
              ))}

              {drivers.length > 0 && (
                <>
                  <div className="sec-title" style={{ marginTop: 20 }}>Where to focus</div>
                  {drivers.map((d) => (
                    <div key={d.key} style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 10 }}>
                      <strong style={{ fontWeight: 600 }}>{d.label}.</strong>{" "}
                      <span style={{ color: C.sub }}>{GUIDANCE[d.key]}</span>
                    </div>
                  ))}
                </>
              )}

              {risk.complete < risk.of && (
                <div style={{ fontSize: 12, color: C.medium, marginTop: 12 }}>
                  Profile {risk.complete}/{risk.of} complete. Missing factors are scored at their lowest value, so the total is a floor, not a final figure.
                </div>
              )}

              <div className="disclaimer">
                Not a diagnosis and not a validated predictor. It flags research-backed risk factors, drawn from a preliminary study built on already-injured athletes. Use it to spot and adjust training habits, and see a clinician or athletic trainer about pain or a suspected injury.
              </div>
            </>
          )}
          {!showResult && (
            <div className="disclaimer" style={{ marginTop: 18 }}>
              Fill in the athlete's week and growth, then see which factors carry the most weight and which ones you can actually move.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------
// LOAD TRACKER VIEW
// ------------------------------------------------------------
function TrackerView() {
  const [weeks, setWeeks] = useState(() => {
    try {
      const saved = localStorage.getItem("star_weeks");
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return SAMPLE_WEEKS;
  });
  const [entry, setEntry] = useState("");
  const [isSample, setIsSample] = useState(() => {
    try { return !localStorage.getItem("star_weeks"); } catch (e) { return true; }
  });

  const persist = (next) => {
    setWeeks(next);
    try { localStorage.setItem("star_weeks", JSON.stringify(next)); } catch (e) {}
  };

  const series = useMemo(() => buildSeries(weeks), [weeks]);
  const current = series[series.length - 1] || null;
  const status = current ? acwrStatus(current.acwr) : acwrStatus(null);

  const addWeek = () => {
    const h = nf(entry);
    if (h <= 0) return;
    const base = isSample ? [] : weeks; // first real entry clears the example data
    persist([...base, { label: `W${base.length + 1}`, hours: h }]);
    setIsSample(false);
    setEntry("");
  };
  const undo = () => !isSample && weeks.length > 1 && persist(weeks.slice(0, -1));
  const startMine = () => { persist([]); setIsSample(false); };
  const loadSample = () => { persist(SAMPLE_WEEKS); setIsSample(true); };

  // chart geometry
  const W = 640, padL = 34, padR = 14, top = 14;
  const barsH = 120, gap = 26, acwrH = 96;
  const acwrTop = top + barsH + gap;
  const maxHours = Math.max(10, ...weeks.map((w) => w.hours)) * 1.1;
  const n = series.length;
  const colW = (W - padL - padR) / Math.max(n, 1);
  const xC = (i) => padL + colW * i + colW / 2;
  const yBar = (h) => top + barsH - (h / maxHours) * barsH;
  const acwrMax = 2;
  const yA = (v) => acwrTop + acwrH - (Math.min(Math.max(v, 0), acwrMax) / acwrMax) * acwrH;

  const zoneGreenTop = yA(1.3), zoneGreenBot = yA(0.8);
  const line15 = yA(1.5);

  const pts = series.filter((s) => s.acwr != null);
  const path = pts.map((s, k) => `${k === 0 ? "M" : "L"} ${xC(series.indexOf(s))} ${yA(s.acwr)}`).join(" ");

  return (
    <div className="grid" style={{ marginTop: 22 }}>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="sec-title" style={{ marginTop: 0 }}>Weekly training load</div>
          {isSample && <span className="tag" style={{ borderColor: C.medium, color: C.medium }}>Example data</span>}
        </div>
        {series.length === 0 ? (
          <div className="hint" style={{ padding: "30px 0", textAlign: "center" }}>No weeks logged yet. Add your first week below to start tracking.</div>
        ) : (
        <svg viewBox={`0 0 ${W} ${acwrTop + acwrH + 24}`} width="100%" role="img" aria-label="Weekly load and acute to chronic workload ratio">
          {/* bar y-grid */}
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={padL} x2={W - padR} y1={top + barsH - f * barsH} y2={top + barsH - f * barsH} stroke={C.line} />
              <text x={padL - 6} y={top + barsH - f * barsH + 3} textAnchor="end" fontSize="9" fill={C.sub}>{Math.round(f * maxHours)}</text>
            </g>
          ))}
          {/* load bars */}
          {series.map((s, i) => (
            <rect key={i} x={xC(i) - colW * 0.3} width={colW * 0.6} y={yBar(s.hours)} height={top + barsH - yBar(s.hours)}
              rx="3" fill={s.acwr != null ? acwrStatus(s.acwr).color : "#C6CCD5"} opacity="0.9" />
          ))}
          <text x={padL} y={top - 2} fontSize="9.5" fill={C.sub}>hours / week</text>

          {/* ACWR panel */}
          <rect x={padL} y={zoneGreenTop} width={W - padL - padR} height={zoneGreenBot - zoneGreenTop} fill={C.low} opacity="0.12" />
          <line x1={padL} x2={W - padR} y1={line15} y2={line15} stroke={C.high} strokeDasharray="4 3" opacity="0.7" />
          {[0.8, 1.3, 1.5].map((v) => (
            <text key={v} x={W - padR} y={yA(v) - 2} textAnchor="end" fontSize="8.5" fill={C.sub}>{v}</text>
          ))}
          <text x={padL} y={acwrTop - 3} fontSize="9.5" fill={C.sub}>acute : chronic ratio</text>
          {path && <path d={path} fill="none" stroke={C.ink} strokeWidth="1.5" opacity="0.45" />}
          {series.map((s, i) => s.acwr != null && (
            <circle key={i} cx={xC(i)} cy={yA(s.acwr)} r="4" fill={acwrStatus(s.acwr).color}
              stroke="#fff" strokeWidth="1.5">
              <title>{`${s.label}: ACWR ${s.acwr.toFixed(2)}${s.priorCount < 4 ? " (provisional)" : ""}`}</title>
            </circle>
          ))}
          {/* week labels */}
          {series.map((s, i) => (
            <text key={i} x={xC(i)} y={acwrTop + acwrH + 15} textAnchor="middle" fontSize="9" fill={C.sub}>{s.label}</text>
          ))}
        </svg>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 14 }}>
          <div style={{ flex: 1 }}>
            <label className="field">Add this week's total sport hours</label>
            <input type="number" min="0" value={entry} onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addWeek()} />
          </div>
          <button className="primary" style={{ width: "auto", marginTop: 0, padding: "10px 18px" }} onClick={addWeek}>Add week</button>
          <button className="ghost" onClick={undo}>Undo</button>
          {isSample
            ? <button className="ghost" onClick={startMine}>Start mine</button>
            : <button className="ghost" onClick={loadSample}>Example</button>}
        </div>
        {isSample && <div className="hint" style={{ marginTop: 10 }}>Showing example data so the chart isn't empty. Adding a week, or tapping Start mine, clears it.</div>}
        <div className="hint">Load here is weekly hours to match the questionnaire. Session-RPE (perceived effort times minutes) is a more sensitive upgrade for production.</div>
      </div>

      <aside className="aside">
        <div className="card">
          <div className="sec-title" style={{ marginTop: 0 }}>This week</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
            <div className="display" style={{ fontSize: 54, fontWeight: 700, lineHeight: 0.9, color: status.color }}>
              {current && current.acwr != null ? current.acwr.toFixed(2) : "--"}
            </div>
            <div style={{ paddingBottom: 8 }}>
              <div className="display" style={{ fontSize: 17, fontWeight: 600, color: status.color }}>{status.label}</div>
              <div style={{ fontSize: 12.5, color: C.sub }}>
                {current ? `${current.hours} hrs vs ${current.chronic ? current.chronic.toFixed(1) : "--"} avg` : ""}
                {current && current.priorCount < 4 && current.acwr != null ? " · provisional" : ""}
              </div>
            </div>
          </div>

          {current && current.acwr != null && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <span className="pill" style={{ background: ptColor(current.points, 3) }}>{current.points}</span>
              <span style={{ fontSize: 12.5, color: C.sub }}>STAR ACWR points (of 3)</span>
            </div>
          )}

          {current && current.acwr != null && current.acwr > 1.5 && (
            <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 9, background: "#FCEBEB", color: C.high, fontSize: 12.5, lineHeight: 1.45 }}>
              This load falls into STAR's highest ACWR category. Consider avoiding further increases in load.
            </div>
          )}

          <div className="sec-title" style={{ marginTop: 20 }}>How the zones map to STAR</div>
          {[
            ["0.8 - 1.3", "Lower-point range", 1, C.low],
            ["Below 0.8, or 1.3 - 1.5", "Mid-point range", 2, C.medium],
            ["Above 1.5", "Higher-point range", 3, C.high],
          ].map(([range, name, pts_, col]) => (
            <div className="frow" key={name}>
              <span className="pill" style={{ background: col }}>{pts_}</span>
              <div style={{ flex: 1, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13 }}>{name}</span>
                <span style={{ fontSize: 11.5, color: C.sub }}>{range}</span>
              </div>
            </div>
          ))}

          <div className="disclaimer">
            Acute is this week's load; chronic is the average of the prior 4 weeks. The first weeks are provisional until 4 weeks of history exist. Zones use the STAR ACWR cutoffs; the model itself is preliminary (AUC 0.66) and not diagnostic.
          </div>
        </div>
      </aside>
    </div>
  );
}

// ============================================================
// FIND CARE VIEW  (zip -> triage -> nearby providers)
// ============================================================
//
// PRODUCTION DATA (all free, no scraping):
//  - Provider directory: NPPES NPI Registry API (public, no key).
//      https://npiregistry.cms.hhs.gov/api/?version=2.1&postal_code=19010
//        &taxonomy_description=Sports%20Medicine&limit=50
//    Useful taxonomy_description values: "Sports Medicine", "Orthopaedic Surgery
//    of the Spine"/"Orthopaedic Surgery", "Physical Therapist", "Athletic Trainer",
//    "Pediatrics", "Urgent Care". Filter/rank the results client-side.
//  - Zip -> coordinates for distance: api.zippopotam.us/us/{zip} (free, no key)
//    or a bundled Census ZCTA centroid file for offline use.
//  - Optional enrichment (hours, booking, ratings): Google Places / Healthgrades.
//
// The list below is a small SAMPLE of real regional institutions for the demo only,
// with approximate coordinates and no invented contact details. Swap in the live
// NPPES call for a real deployment.

const TYPE_LABEL = {
  pedsm: "Pediatric sports medicine", ortho: "Orthopedic sports care",
  sportsmed: "Sports medicine", pt: "Sports physical therapy",
  atc: "Athletic training", primary: "Primary care", urgent: "Urgent care / ED",
};

const REASONS = {
  check: { label: "Preseason or general check", types: ["pt", "atc", "sportsmed"], urgency: "low",
    text: "Routine. A sports physical therapist, athletic trainer, or sports medicine provider can screen you and set a load plan." },
  overuse: { label: "Nagging pain that builds with activity", types: ["sportsmed", "pt", "pedsm"], urgency: "medium",
    text: "See a sports medicine provider or sports PT in the next week or two, and ease off load until then." },
  serious: { label: "Pain at rest or at night, or a tender spot on the bone", types: ["pedsm", "ortho", "sportsmed"], urgency: "high",
    text: "Get seen within a few days. Bone stress injuries need imaging and a real rest plan, not push-through." },
  acute: { label: "Sudden injury from one moment", types: ["ortho", "sportsmed", "urgent"], urgency: "high",
    text: "If you can bear weight with no deformity, a sports medicine or orthopedic clinic is right. If not, use urgent care." },
};

const RED_FLAGS = [
  "Can't put weight on it or can't use it",
  "Visible deformity, or the joint looks out of place",
  "Numbness, tingling, or the limb looks pale or cold",
  "Severe swelling right after it happened",
  "Fever with a hot, swollen joint",
];

// SAMPLE regional providers. Approximate coordinates; no fabricated contact details.
const PROVIDERS = [
  { name: "CHOP Sports Medicine and Performance Center", city: "Philadelphia, PA", types: ["pedsm", "ortho", "pt"], ped: true, tele: true, lat: 39.9490, lng: -75.1938 },
  { name: "CHOP Specialty Care, King of Prussia", city: "King of Prussia, PA", types: ["pedsm", "pt"], ped: true, tele: true, lat: 40.0893, lng: -75.3960 },
  { name: "Main Line Health Orthopaedics, Bryn Mawr", city: "Bryn Mawr, PA", types: ["ortho", "pt", "sportsmed"], ped: false, tele: false, lat: 40.0206, lng: -75.3210 },
  { name: "Rothman Orthopaedics", city: "King of Prussia, PA", types: ["ortho", "sportsmed"], ped: false, tele: true, lat: 40.0893, lng: -75.3960 },
  { name: "Penn Sports Medicine", city: "Philadelphia, PA", types: ["sportsmed", "ortho", "pt"], ped: false, tele: true, lat: 39.9496, lng: -75.1932 },
  { name: "Jefferson Health Sports Medicine", city: "Philadelphia, PA", types: ["sportsmed", "ortho"], ped: false, tele: true, lat: 39.9490, lng: -75.1580 },
  { name: "ATI Physical Therapy", city: "Ardmore, PA", types: ["pt", "atc"], ped: false, tele: false, lat: 40.0068, lng: -75.2905 },
  { name: "Ivy Rehab Physical Therapy", city: "Wayne, PA", types: ["pt", "atc"], ped: false, tele: false, lat: 40.0446, lng: -75.4038 },
  { name: "Nemours Children's Health", city: "Wilmington, DE", types: ["pedsm", "pt"], ped: true, tele: true, lat: 39.7560, lng: -75.5500 },
  { name: "Patient First Urgent Care", city: "Wynnewood, PA", types: ["urgent"], ped: false, tele: false, lat: 40.0018, lng: -75.2779 },
];

const ZIPS = {
  "19010": [40.0218, -75.3157], "19087": [40.0446, -75.4038], "19096": [40.0018, -75.2779],
  "19004": [40.0068, -75.2338], "19003": [40.0068, -75.2905], "19103": [39.9520, -75.1720],
  "19104": [39.9550, -75.1980], "19406": [40.0893, -75.3960],
};
const FALLBACK = [40.0218, -75.3157]; // Bryn Mawr

function haversine(a, b) {
  const R = 3958.8, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b[0] - a[0]), dLng = toR(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
const mapsUrl = (p) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + " " + p.city)}`;
const dirUrl = (p) =>
  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.name + " " + p.city)}`;

// Card thumbnails use keyless OpenStreetMap tiles so a real map of each location
// renders with no API key. PRODUCTION UPGRADE: for a photo of the actual building,
// swap in the Google Street View Static API with your key:
//   `https://maps.googleapis.com/maps/api/streetview?size=600x300&location=${p.lat},${p.lng}&key=KEY`
function osmTile(lat, lng, z = 14) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latR = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}
function metaLine(p) {
  const type = p.specialty || (p.types ? p.types.map((t) => TYPE_LABEL[t]).join(" · ") : "");
  const distNum = p.distance_mi != null ? p.distance_mi
    : (typeof p.dist === "number" ? Number(p.dist.toFixed(1)) : null);
  let tags = [p.city, distNum != null ? distNum + " mi" : null].filter(Boolean).join(" · ");
  if (p.ped) tags += " · Pediatric";
  if (p.tele) tags += " · Telehealth";
  return { type, tags };
}

function ProviderThumb({ p }) {
  const [err, setErr] = useState(false);
  const ok = typeof p.lat === "number" && typeof p.lng === "number" && !err;
  return (
    <a className="thumb" href={mapsUrl(p)} target="_blank" rel="noreferrer" aria-label={"Open " + p.name + " on Google Maps"}>
      {ok ? (
        <img src={osmTile(p.lat, p.lng)} alt={"Map near " + p.name} loading="lazy" onError={() => setErr(true)} />
      ) : (
        <span className="ph">Map preview unavailable</span>
      )}
    </a>
  );
}

const urgencyColor = (u) => (u === "emergency" || u === "high" ? C.high : u === "medium" ? C.medium : C.low);

function FindCareView() {
  const [zip, setZip] = useState("");
  const [reason, setReason] = useState("overuse");
  const [flags, setFlags] = useState([]);
  const [radius, setRadius] = useState(25);
  const [pedOnly, setPedOnly] = useState(false);
  const [teleOnly, setTeleOnly] = useState(false);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(null); // live NPPES results, or null to use the regional list
  const [note, setNote] = useState("");

  const toggleFlag = (f) =>
    setFlags((s) => (s.includes(f) ? s.filter((x) => x !== f) : [...s, f]));

  const emergency = flags.length > 0;
  const plan = emergency
    ? { types: ["urgent"], urgency: "emergency",
        text: "One or more of these can signal an injury that needs same-day care. Go to urgent care or an emergency department now, not a routine clinic." }
    : REASONS[reason];

  const center = ZIPS[zip.trim()] || FALLBACK;

  // Curated Philadelphia-area fallback, used when the live search is unavailable.
  const results = useMemo(() => {
    let list = PROVIDERS
      .filter((p) => p.types.some((t) => plan.types.includes(t)))
      .filter((p) => (pedOnly ? p.ped : true))
      .filter((p) => (teleOnly ? p.tele : true))
      .map((p) => ({ ...p, dist: haversine(center, [p.lat, p.lng]) }))
      .sort((a, b) => a.dist - b.dist);
    const within = list.filter((p) => p.dist <= radius);
    return { shown: within.length ? within : list.slice(0, 3) };
  }, [plan, center, radius, pedOnly, teleOnly]);

  const runSearch = async () => {
    setSearched(true);
    setNote("");
    if (!/^\d{5}$/.test(zip.trim())) {
      setLive(null);
      setNote("Enter a 5-digit ZIP for a live search. Showing the regional list.");
      return;
    }
    setLoading(true);
    setLive(null);
    try {
      const url = `/.netlify/functions/providers?zip=${zip.trim()}&reason=${emergency ? "emergency" : reason}&radius=${radius}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.results && data.results.length) {
        setLive(data.results);
      } else {
        setNote(data.error || `No live matches within ${radius} mi. Showing the regional list.`);
      }
    } catch (e) {
      setNote("Live search runs once the site is deployed on Netlify. Showing the regional list.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop: 22 }}>
      <div className="card">
        <div className="sec-title" style={{ marginTop: 0 }}>Where does it hurt, and where are you?</div>
        <div className="hint" style={{ marginBottom: 12 }}>Uses a curated list of Philadelphia-area providers to show how the routing works.</div>
        <div className="two">
          <div>
            <label className="field">ZIP code</label>
            <input type="number" value={zip} placeholder="19010" onChange={(e) => setZip(e.target.value)} />
          </div>
          <div>
            <label className="field">Reason for the visit</label>
            <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={emergency}>
              {Object.entries(REASONS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="sec-title">Any of these right now? Check all that apply</div>
        {RED_FLAGS.map((f) => (
          <div className="qrow" key={f} style={{ padding: "10px 0" }}>
            <div className="qlabel" style={{ fontSize: 13.5 }}>{f}</div>
            <div className="yn">
              <button className={flags.includes(f) ? "on" : ""} onClick={() => toggleFlag(f)}>Yes</button>
              <button className={!flags.includes(f) ? "on" : ""} onClick={() => flags.includes(f) && toggleFlag(f)}>No</button>
            </div>
          </div>
        ))}

        <div className="two" style={{ marginTop: 16 }}>
          <div>
            <label className="field">Search radius</label>
            <div className="seg sm">
              {[10, 25, 50].map((r) => (
                <button key={r} className={radius === r ? "on" : ""} onClick={() => setRadius(r)}>{r} mi</button>
              ))}
            </div>
          </div>
          <div>
            <label className="field">Filters</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button className={"ghost" + (pedOnly ? " on" : "")} style={pedOnly ? { background: C.ink, color: "#fff", borderColor: C.ink } : {}} onClick={() => setPedOnly((v) => !v)}>Pediatric</button>
              <button className={"ghost"} style={teleOnly ? { background: C.ink, color: "#fff", borderColor: C.ink } : {}} onClick={() => setTeleOnly((v) => !v)}>Telehealth</button>
            </div>
          </div>
        </div>

        <button className="primary" onClick={runSearch}>Find care near me</button>
      </div>

      {searched && (
        <>
          <div className="card" style={{ marginTop: 16, borderLeft: `4px solid ${urgencyColor(plan.urgency)}` }}>
            <div className="display" style={{ fontSize: 18, fontWeight: 600, color: urgencyColor(plan.urgency) }}>
              {emergency ? "Get seen today" : plan.urgency === "high" ? "See someone within a few days" : plan.urgency === "medium" ? "Book a visit soon" : "Routine check"}
            </div>
            <div style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.5, marginTop: 4 }}>{plan.text}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              {plan.types.map((t) => (
                <span key={t} className="tag" style={{ borderColor: urgencyColor(plan.urgency), color: urgencyColor(plan.urgency) }}>{TYPE_LABEL[t]}</span>
              ))}
            </div>
          </div>

          {loading && (
            <div className="hint" style={{ marginTop: 12 }}>Searching the national provider registry...</div>
          )}
          {!loading && note && (
            <div className="hint" style={{ marginTop: 12 }}>{note}</div>
          )}

          {!loading && (() => {
            const usedLive = Array.isArray(live) && live.length > 0;
            let cards = usedLive ? live : results.shown;
            if (pedOnly) cards = cards.filter((p) => p.ped);
            if (teleOnly && !usedLive) cards = cards.filter((p) => p.tele);
            return (
              <>
                <div className="hint" style={{ marginTop: 12 }}>
                  {usedLive ? "Live results from the federal NPI registry." : "Curated Philadelphia-area list."}
                </div>
                <div className="results">
                  {cards.map((p) => {
                    const m = metaLine(p);
                    return (
                      <div className="listing" key={(p.name || "") + (p.city || "")}>
                        <ProviderThumb p={p} />
                        <div className="body">
                          <h4>{p.name}</h4>
                          <div className="meta">{m.type}<br />{m.tags}</div>
                          <div className="acts">
                            <a className="g" href={mapsUrl(p)} target="_blank" rel="noreferrer">View on Google</a>
                            <a className="d" href={dirUrl(p)} target="_blank" rel="noreferrer">Directions</a>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}

          <div className="disclaimer" style={{ marginTop: 8 }}>
            This routes you toward the right kind of provider. It does not diagnose the injury or guarantee a provider's availability, insurance network, or fit. Live results come from the federal NPI registry; the regional list is a curated fallback. Neither is an endorsement. In an emergency, call your local emergency number.
          </div>
        </>
      )}
    </div>
  );
}
