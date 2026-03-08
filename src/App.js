import { useState, useEffect, useRef } from "react";
import { supabase } from "./supabase";

/* ─── Utilities ─── */
const hashPIN = async (pin) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
};

const playBeep = () => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine"; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(); osc.stop(ctx.currentTime + 0.6);
  } catch {}
};


/* ─── Room code system ─── */
const genCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "STR-";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
};

/* ─── Routine builder (2–6 days) ─── */
const buildRoutine = (profile, partnerProfile = null) => {
  const level = profile.level || "intermediate";
  const days  = parseInt(profile.daysPerWeek) || 3;
  const yw    = parseInt(profile.weight) || 80;
  const pw    = partnerProfile?.weight ? parseInt(partnerProfile.weight) : null;
  const wA    = (m) => `${Math.round(yw * m)}kg`;
  const wB    = (m) => pw ? `${Math.round(pw * m)}kg` : "— kg";
  const beg   = level === "beginner";

  const PUSH = {
    label: "DAY 1", name: "Push Day", tag: "CHEST · SHOULDERS · TRIS", color: "#C8F135",
    exercises: [
      { name: "Barbell Bench Press", muscles: "CHEST",        sets: beg?3:4, reps: beg?"8–10":"6–8",  rest:90,  wA:wA(0.70), wB:wB(0.70), rpe:7 },
      { name: "Incline DB Press",    muscles: "UPPER CHEST",  sets: 3,       reps: "10–12",            rest:75,  wA:wA(0.35), wB:wB(0.35), rpe:7 },
      { name: "Overhead Press",      muscles: "SHOULDERS",    sets: 3,       reps: "8–10",             rest:75,  wA:wA(0.63), wB:wB(0.63), rpe:7 },
      { name: "Lateral Raise",       muscles: "SIDE DELT",    sets: 3,       reps: "15–20",            rest:45,  wA:wA(0.15), wB:wB(0.15), rpe:6 },
      { name: "Tricep Pushdown",     muscles: "TRICEPS",      sets: 3,       reps: "12–15",            rest:60,  wA:wA(0.44), wB:wB(0.44), rpe:6 },
    ],
  };
  const PULL = {
    label: "DAY 2", name: "Pull Day", tag: "BACK · BICEPS · REAR DELT", color: "#0A84FF",
    exercises: [
      { name: "Deadlift",         muscles: "POSTERIOR CHAIN", sets: beg?3:4, reps: beg?"6–8":"5–6", rest:120, wA:wA(1.10), wB:wB(1.10), rpe:8 },
      { name: "Pull-Ups",         muscles: "LATS",            sets: 3,       reps: "6–10",           rest:90,  wA:"BW",     wB:"BW",     rpe:7 },
      { name: "Seated Cable Row", muscles: "MID BACK",        sets: 3,       reps: "10–12",          rest:75,  wA:wA(0.69), wB:wB(0.69), rpe:7 },
      { name: "Barbell Curl",     muscles: "BICEPS",          sets: 3,       reps: "10–12",          rest:60,  wA:wA(0.38), wB:wB(0.38), rpe:6 },
      { name: "Face Pull",        muscles: "REAR DELT",       sets: 3,       reps: "15–20",          rest:45,  wA:wA(0.30), wB:wB(0.30), rpe:6 },
    ],
  };
  const LEGS = {
    label: "DAY 3", name: "Leg Day", tag: "QUADS · HAMSTRINGS · GLUTES", color: "#FF9F0A",
    exercises: [
      { name: "Back Squat",        muscles: "QUADS",      sets: beg?3:4, reps: beg?"8–10":"6–8", rest:120, wA:wA(0.90), wB:wB(0.90), rpe:8 },
      { name: "Romanian Deadlift", muscles: "HAMSTRINGS", sets: 3,       reps: "10–12",          rest:90,  wA:wA(0.94), wB:wB(0.94), rpe:7 },
      { name: "Leg Press",         muscles: "QUADS",      sets: 3,       reps: "12–15",          rest:75,  wA:wA(1.75), wB:wB(1.75), rpe:7 },
      { name: "Leg Curl",          muscles: "HAMSTRINGS", sets: 3,       reps: "12–15",          rest:60,  wA:wA(0.50), wB:wB(0.50), rpe:6 },
      { name: "Calf Raise",        muscles: "CALVES",     sets: 3,       reps: "15–20",          rest:45,  wA:wA(1.00), wB:wB(1.00), rpe:6 },
    ],
  };
  const ARMS = {
    label: "DAY 4", name: "Arms & Core", tag: "BICEPS · TRICEPS · ABS", color: "#BF5AF2",
    exercises: [
      { name: "EZ Bar Curl",    muscles: "BICEPS",     sets: 4, reps: "10–12", rest:60, wA:wA(0.35), wB:wB(0.35), rpe:7 },
      { name: "Skull Crushers", muscles: "TRICEPS",    sets: 4, reps: "10–12", rest:60, wA:wA(0.30), wB:wB(0.30), rpe:7 },
      { name: "Hammer Curl",    muscles: "BRACHIALIS", sets: 3, reps: "12–15", rest:45, wA:wA(0.20), wB:wB(0.20), rpe:6 },
      { name: "Cable Crunch",   muscles: "ABS",        sets: 3, reps: "15–20", rest:45, wA:wA(0.44), wB:wB(0.44), rpe:6 },
    ],
  };
  const UPPER = {
    label: "DAY 4", name: "Upper Body", tag: "CHEST · BACK · SHOULDERS", color: "#FF375F",
    exercises: [
      { name: "DB Bench Press",      muscles: "CHEST",     sets: 3, reps: "10–12", rest:75, wA:wA(0.40), wB:wB(0.40), rpe:7 },
      { name: "Bent-Over Row",       muscles: "BACK",      sets: 3, reps: "10–12", rest:75, wA:wA(0.75), wB:wB(0.75), rpe:7 },
      { name: "DB Shoulder Press",   muscles: "SHOULDERS", sets: 3, reps: "10–12", rest:60, wA:wA(0.28), wB:wB(0.28), rpe:7 },
      { name: "Tricep Pushdown",     muscles: "TRICEPS",   sets: 3, reps: "12–15", rest:45, wA:wA(0.40), wB:wB(0.40), rpe:6 },
    ],
  };
  const LOWER2 = {
    label: "DAY 5", name: "Lower Focus", tag: "QUADS · GLUTES · CORE", color: "#FF9F0A",
    exercises: [
      { name: "Front Squat",     muscles: "QUADS",  sets: 3, reps: "8–10",  rest:90, wA:wA(0.75), wB:wB(0.75), rpe:7 },
      { name: "Hip Thrust",      muscles: "GLUTES", sets: 4, reps: "10–12", rest:75, wA:wA(1.10), wB:wB(1.10), rpe:7 },
      { name: "Walking Lunges",  muscles: "QUADS",  sets: 3, reps: "12–14", rest:60, wA:wA(0.25), wB:wB(0.25), rpe:6 },
      { name: "Plank",           muscles: "CORE",   sets: 3, reps: "45–60s",rest:45, wA:"BW",     wB:"BW",     rpe:5 },
    ],
  };
  const ACTIVE = {
    label: "DAY 6", name: "Active Recovery", tag: "MOBILITY · CORE · STRETCH", color: "#30d158",
    exercises: [
      { name: "Foam Rolling",        muscles: "FULL BODY", sets: 1, reps: "5–10 min", rest:0,  wA:"BW", wB:"BW", rpe:3 },
      { name: "Hip Flexor Stretch",  muscles: "HIPS",      sets: 3, reps: "30–45s",   rest:30, wA:"BW", wB:"BW", rpe:3 },
      { name: "Dead Bug",            muscles: "CORE",      sets: 3, reps: "10–12",    rest:30, wA:"BW", wB:"BW", rpe:4 },
      { name: "Band Pull-Apart",     muscles: "REAR DELT", sets: 3, reps: "20–25",    rest:30, wA:"BW", wB:"BW", rpe:4 },
    ],
  };
  const FULL_A = {
    label: "DAY 1", name: "Full Body A", tag: "SQUAT · PRESS · ROW", color: "#C8F135",
    exercises: [
      { name: "Back Squat",          muscles: "QUADS",     sets: beg?3:4, reps:"8–10", rest:90,  wA:wA(0.80), wB:wB(0.80), rpe:7 },
      { name: "Barbell Bench Press", muscles: "CHEST",     sets: 3,       reps:"8–10", rest:75,  wA:wA(0.65), wB:wB(0.65), rpe:7 },
      { name: "Bent-Over Row",       muscles: "BACK",      sets: 3,       reps:"8–10", rest:75,  wA:wA(0.65), wB:wB(0.65), rpe:7 },
      { name: "Overhead Press",      muscles: "SHOULDERS", sets: 3,       reps:"8–10", rest:60,  wA:wA(0.55), wB:wB(0.55), rpe:7 },
      { name: "Plank",               muscles: "CORE",      sets: 2,       reps:"45s",  rest:45,  wA:"BW",     wB:"BW",     rpe:5 },
    ],
  };
  const FULL_B = {
    label: "DAY 2", name: "Full Body B", tag: "HINGE · PRESS · PULL", color: "#0A84FF",
    exercises: [
      { name: "Deadlift",        muscles: "POSTERIOR CHAIN", sets: beg?3:4, reps:"6–8",  rest:120, wA:wA(1.00), wB:wB(1.00), rpe:8 },
      { name: "Incline DB Press",muscles: "UPPER CHEST",     sets: 3,       reps:"10–12",rest:75,  wA:wA(0.32), wB:wB(0.32), rpe:7 },
      { name: "Pull-Ups",        muscles: "LATS",             sets: 3,       reps:"6–8",  rest:75,  wA:"BW",     wB:"BW",     rpe:7 },
      { name: "Goblet Squat",    muscles: "QUADS",            sets: 3,       reps:"12–15",rest:60,  wA:wA(0.30), wB:wB(0.30), rpe:6 },
      { name: "Tricep Pushdown", muscles: "TRICEPS",          sets: 3,       reps:"12–15",rest:45,  wA:wA(0.40), wB:wB(0.40), rpe:6 },
    ],
  };

  if (days === 2) return [FULL_A, FULL_B];
  if (days === 3) return [PUSH, PULL, LEGS];
  if (days === 4) return [PUSH, PULL, LEGS, ARMS];
  if (days === 5) return [PUSH, PULL, LEGS, UPPER, LOWER2];
  return [PUSH, PULL, LEGS, UPPER, LOWER2, ACTIVE];
};

/* ─── Global styles ─── */
const GlobalStyles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@400;500;600;700;800;900&family=Barlow+Condensed:wght@400;600;700;800;900&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    :root {
      --black:#080808; --dark:#111; --card:#1a1a1a;
      --line:rgba(255,255,255,0.08); --line2:rgba(255,255,255,0.14);
      --lime:#C8F135; --white:#FAFAFA; --gray:#888; --gray2:#555;
      --red:#FF3B30; --blue:#0A84FF; --orange:#FF9F0A;
      --font-display:'Bebas Neue',sans-serif;
      --font-body:'Barlow',sans-serif;
      --font-cond:'Barlow Condensed',sans-serif;
    }
    body { background:var(--black); color:var(--white); font-family:var(--font-body); overflow-x:hidden; }
    @keyframes fadeUp  { from{opacity:0;transform:translateY(22px)} to{opacity:1;transform:translateY(0)} }
    @keyframes fadeIn  { from{opacity:0} to{opacity:1} }
    @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:.35} }
    @keyframes spin    { to{transform:rotate(360deg)} }
    @keyframes slideIn { from{transform:translateY(100%)} to{transform:translateY(0)} }
    @keyframes slideRight { from{transform:translateX(60px);opacity:0} to{transform:translateX(0);opacity:1} }
    @keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-10px)} 40%,80%{transform:translateX(10px)} }
    .fu  { animation:fadeUp 0.45s ease both; }
    .fu1 { animation:fadeUp 0.45s 0.08s ease both; }
    .fu2 { animation:fadeUp 0.45s 0.16s ease both; }
    .fu3 { animation:fadeUp 0.45s 0.24s ease both; }
    .fu4 { animation:fadeUp 0.45s 0.32s ease both; }
    .sr  { animation:slideRight 0.4s ease both; }
    input, select, textarea { outline:none; font-size:16px !important; }
    input::placeholder, textarea::placeholder { color:var(--gray2); }
    ::-webkit-scrollbar { display:none; }
    .chip-select { display:flex; flex-wrap:wrap; gap:8px; }
    .chip {
      padding:9px 18px; border-radius:99px;
      border:1.5px solid var(--line2);
      font-family:var(--font-cond); font-weight:700; font-size:13px; letter-spacing:1.5px;
      color:var(--gray); background:var(--card); cursor:pointer; transition:all 0.18s;
    }
    .chip.active { border-color:var(--lime); color:var(--black); background:var(--lime); }
    .nav-btn {
      flex:1; background:none; border:none; cursor:pointer;
      font-family:var(--font-cond); font-weight:700; font-size:12px; letter-spacing:2.5px;
      padding:14px 0 calc(14px + env(safe-area-inset-bottom)); transition:color 0.2s;
    }
  `}</style>
);

/* ─── UI helpers ─── */
const Btn = ({ children, onClick, full, style = {}, variant = "lime" }) => {
  const base = {
    border:"none", borderRadius:14, cursor:"pointer",
    fontFamily:"var(--font-cond)", fontWeight:900, fontSize:16,
    letterSpacing:2.5, textTransform:"uppercase", padding:"17px 0",
    width: full ? "100%" : "auto", transition:"opacity .15s",
    ...(variant==="lime"     ? {background:"var(--lime)",color:"var(--black)",boxShadow:"0 0 28px rgba(200,241,53,.25)"} : {}),
    ...(variant==="ghost"    ? {background:"transparent",color:"var(--gray)",border:"1px solid var(--line2)"} : {}),
    ...(variant==="red"      ? {background:"var(--red)",color:"#fff"} : {}),
    ...(variant==="red-soft" ? {background:"rgba(255,59,48,.1)",color:"var(--red)",border:"1px solid rgba(255,59,48,.25)"} : {}),
    ...(variant==="dark"     ? {background:"var(--card)",color:"var(--white)",border:"1px solid var(--line)"} : {}),
    ...style,
  };
  return <button style={base} onClick={onClick}>{children}</button>;
};

const Input = ({ label, placeholder, value, onChange, type="text", unit }) => (
  <div style={{marginBottom:18}}>
    {label && <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>{label}</div>}
    <div style={{position:"relative"}}>
      <input
        type={type} value={value} onChange={e=>onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width:"100%",background:"var(--card)",border:"1.5px solid var(--line2)",
          borderRadius:12,padding:unit?"14px 48px 14px 16px":"14px 16px",
          fontFamily:"var(--font-body)",fontSize:16,color:"var(--white)",
        }}
      />
      {unit && <span style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",fontFamily:"var(--font-cond)",fontSize:12,color:"var(--gray)",letterSpacing:1}}>{unit}</span>}
    </div>
  </div>
);

const Label = ({text}) => (
  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:6}}>{text}</div>
);

/* ─── PIN numpad ─── */
const PinDots = ({count, error, shake}) => (
  <div style={{display:"flex",gap:16,justifyContent:"center",margin:"32px 0",animation:shake?"shake 0.4s ease":undefined}}>
    {[0,1,2,3].map(i=>(
      <div key={i} style={{
        width:18,height:18,borderRadius:99,
        background: error
          ? (i<count ? "var(--red)" : "rgba(255,59,48,0.25)")
          : (i<count ? "var(--lime)" : "var(--line2)"),
        transition:"background .15s",
        boxShadow: i<count && !error ? "0 0 8px rgba(200,241,53,0.6)" : "none",
      }} />
    ))}
  </div>
);

const Numpad = ({onDigit, onDelete}) => {
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,maxWidth:280,margin:"0 auto"}}>
      {keys.map((k,i)=>(
        k===""
          ? <div key={i}/>
          : <button key={i} onClick={()=>k==="⌫"?onDelete():onDigit(k)}
              style={{
                background:k==="⌫"?"var(--card)":"var(--card)",
                border:"1.5px solid var(--line2)",borderRadius:99,
                width:"100%",aspectRatio:"1",
                fontFamily:"var(--font-cond)",fontWeight:700,fontSize:22,
                color:"var(--white)",cursor:"pointer",display:"flex",
                alignItems:"center",justifyContent:"center",
                transition:"background .15s",
              }}>{k}</button>
      ))}
    </div>
  );
};

/* ════════════════════════════════════════════
   MAIN APP
════════════════════════════════════════════ */
export default function App() {
  // ── localStorage helpers (defined first so lazy initialisers can use them) ──
  const getSaved = (key, fallback) => {
    try {
      const val = localStorage.getItem(key);
      return val ? JSON.parse(val) : fallback;
    } catch { return fallback; }
  };

  // ── Initial screen: determined from localStorage before first render ──
  const [screen, setScreen] = useState(() => {
    try {
      const prof = localStorage.getItem("str_profile");
      const pin  = localStorage.getItem("str_pin");
      if (prof && pin) return "pin";
      if (prof)        return "home"; // profile but no PIN (legacy / edge case)
      return "splash";
    } catch { return "splash"; }
  });

  const [onboardStep, setOnboardStep] = useState(0);

  // ── Persisted state — initialised directly from localStorage ──
  const [profile, setProfile]             = useState(() => getSaved("str_profile", null));
  const [routine, setRoutine]             = useState(() => getSaved("str_routine", null));
  const [aiSummary, setAiSummary]         = useState(() => getSaved("str_summary", ""));
  const [pinHash, setPinHash]             = useState(() => getSaved("str_pin", null));
  const [workoutHistory, setWorkoutHistory] = useState(() => getSaved("str_history", []));
  const [messages, setMessages]           = useState(() => getSaved("str_messages", []));

  // PIN auth (session-only state)
  const [pinEntry, setPinEntry]       = useState("");
  const [pinAttempts, setPinAttempts] = useState(0);
  const [pinError, setPinError]       = useState("");
  const [pinShake, setPinShake]       = useState(false);
  const [newPIN, setNewPIN]           = useState("");
  const [confirmPin, setConfirmPin]   = useState("");
  const [pinMatchError, setPinMatchError]   = useState("");
  const [splashLoginError, setSplashLoginError] = useState("");

  // Room / partner
  const [roomCode, setRoomCode]                 = useState("");
  const [roomRole, setRoomRole]                 = useState(""); // eslint-disable-line no-unused-vars
  const [partnerProfile, setPartnerProfile]     = useState(null);
  const [joinInput, setJoinInput]               = useState("");
  const [joinError, setJoinError]               = useState("");
  const [waitingForPartner, setWaitingForPartner] = useState(false);
  const [copied, setCopied]                     = useState(false);

  // Routine (non-persisted UI state)
  const [regenerating, setRegenerating] = useState(false);

  // Workout UI
  const [tab, setTab]                     = useState("today");
  const [dayIdx, setDayIdx]               = useState(0);
  const [exIdx, setExIdx]                 = useState(0);
  const [setNum, setSetNum]               = useState(1);
  const [resting, setResting]             = useState(false);
  const [restSec, setRestSec]             = useState(0);
  const [restMax, setRestMax]             = useState(90);
  const [sheet, setSheet]                 = useState(null);
  const [aiText, setAiText]               = useState("");
  const [aiLoading, setAiLoading]         = useState(false);
  const [completedSets, setCompletedSets] = useState({});
  const [showLogout, setShowLogout]       = useState(false);
  const workoutStartRef = useRef(null);
  const timerRef = useRef(null);
  const supaSubRef = useRef(null); // Supabase realtime subscription

  // Active workout session (persisted across navigation)
  const [activeSession, setActiveSession] = useState(() => getSaved("str_active_session", null));
  // Toast notification (e.g. auto-expire message)
  const [toast, setToast] = useState(null);
  // Conflict dialog: non-null when user taps a day card while a session exists
  const [conflictPendingDayIdx, setConflictPendingDayIdx] = useState(null);
  // Supabase room slot ("a" = host, "b" = partner)
  const [userSlot, setUserSlot] = useState(() => localStorage.getItem("str_user_slot") || "a");

  // null-safe profile updater (profile starts null before onboarding)
  const p = (k, v) => setProfile(prev => ({...(prev || {}), [k]: v}));

  /* ─── Restore session + auto-expire check on mount ─── */
  useEffect(() => {
    // 1. Auto-expire active workout session if > 60 min idle
    const session = getSaved("str_active_session", null);
    if (session?.isActive) {
      const minutesIdle = (Date.now() - session.lastActivityAt) / 60000;
      if (minutesIdle > 60) {
        // Save partial history entry before clearing
        const expiredDay = routine?.[session.dayIdx];
        if (expiredDay) {
          const entry = {
            date: new Date().toLocaleDateString("en-US", {month:"short", day:"numeric"}),
            dayName: expiredDay.name,
            totalSets: Object.keys(session.completedSets || {}).length,
            duration: Math.max(1, Math.round((session.lastActivityAt - session.startedAt) / 60000)),
            exercises: expiredDay.exercises.length,
          };
          setWorkoutHistory(prev => [entry, ...prev].slice(0, 20));
        }
        localStorage.removeItem("str_active_session");
        setActiveSession(null);
        setToast("Your workout from earlier was automatically ended after 60 minutes of inactivity.");
        setTimeout(() => setToast(null), 6000);
      }
    }

    // 2. Restore Supabase room if one was saved
    const savedCode = localStorage.getItem("str_room_code");
    const savedSlot = localStorage.getItem("str_user_slot") || "a";
    if (savedCode && profile) {
      setRoomCode(savedCode);
      setUserSlot(savedSlot);
      supabase.from("rooms").select("*").eq("room_code", savedCode).single()
        .then(({ data }) => {
          if (!data) return;
          const partner = savedSlot === "a" ? data.user_b : data.user_a;
          if (partner) {
            setPartnerProfile(partner);
            if (!routine) setRoutine(buildRoutine(profile, partner));
            // Restore messages
            if (data.messages?.length) setMessages(data.messages);
          } else if (savedSlot === "a") {
            setWaitingForPartner(true);
          }
          // Subscribe for live partner join + messages
          subscribeToRoom(savedCode, savedSlot);
        });
    }

    // 3. Ensure routine exists for returning users
    if (profile && !routine) setRoutine(buildRoutine(profile));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Persist state to localStorage whenever it changes (str_* keys) ─── */
  useEffect(() => { if (profile) localStorage.setItem("str_profile", JSON.stringify(profile)); }, [profile]);
  useEffect(() => { if (routine) localStorage.setItem("str_routine", JSON.stringify(routine)); }, [routine]);
  useEffect(() => { if (aiSummary) localStorage.setItem("str_summary", JSON.stringify(aiSummary)); }, [aiSummary]);
  useEffect(() => { if (pinHash)  localStorage.setItem("str_pin",     JSON.stringify(pinHash)); },  [pinHash]);
  useEffect(() => { localStorage.setItem("str_history",  JSON.stringify(workoutHistory)); }, [workoutHistory]);
  useEffect(() => { localStorage.setItem("str_messages", JSON.stringify(messages)); }, [messages]);

  /* ─── Auto-save active workout session whenever key state changes ─── */
  useEffect(() => {
    if (!workoutStartRef.current) return;
    const session = {
      isActive: true,
      dayIdx, exIdx, setNum, completedSets,
      startedAt: workoutStartRef.current,
      lastActivityAt: Date.now(),
      restMax,
    };
    localStorage.setItem("str_active_session", JSON.stringify(session));
    setActiveSession(session);
  }, [dayIdx, exIdx, setNum, completedSets]); // eslint-disable-line react-hooks/exhaustive-deps


  /* ─── Rest timer with beep ─── */
  useEffect(() => {
    if (resting) {
      timerRef.current = setInterval(() => {
        setRestSec(s => {
          if (s <= 1) {
            clearInterval(timerRef.current);
            setResting(false);
            playBeep();
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [resting]);

  const startRest = (s) => { setRestMax(s); setRestSec(s); setResting(true); };
  const skipRest  = () => { clearInterval(timerRef.current); setResting(false); setRestSec(0); };

  const day         = routine?.[dayIdx];
  const ex          = day?.exercises[exIdx];
  const accentColor = day?.color || "var(--lime)";

  const completeSet = () => {
    const key = `${exIdx}-${setNum}`;
    setCompletedSets(prev => ({...prev, [key]:true}));
    if (setNum < ex.sets) {
      setSetNum(s => s + 1);
      startRest(ex.rest);
    } else if (exIdx < day.exercises.length - 1) {
      setExIdx(i => i + 1);
      setSetNum(1);
      startRest(ex.rest);
    } else {
      // Workout complete — save history
      const durationMin = workoutStartRef.current
        ? Math.round((Date.now() - workoutStartRef.current) / 60000)
        : 45;
      const totalSets = day.exercises.reduce((a, e) => a + e.sets, 0);
      const entry = {
        date: new Date().toLocaleDateString("en-US", {month:"short", day:"numeric"}),
        dayName: day.name,
        totalSets,
        duration: durationMin,
        exercises: day.exercises.length,
      };
      setWorkoutHistory(prev => [entry, ...prev].slice(0, 20));
      setSheet("complete");
    }
  };

  const fetchAI = async (prompt) => {
    setAiLoading(true); setAiText("");
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1000,
          system:"You are an elite strength coach inside a couples gym app called Stronger. Give concise, direct, warm advice. 2–3 short paragraphs. No markdown. Real coach voice.",
          messages:[{role:"user", content:prompt}],
        }),
      });
      const d = await r.json();
      setAiText(d.content?.find(b=>b.type==="text")?.text || "Trust your body. If it hurts sharp, stop.");
    } catch { setAiText("Can't connect. If pain is sharp — stop. If it's a burn — keep going."); }
    setAiLoading(false);
  };

  const generateRoutine = async (resolvedPartner = null) => {
    setScreen("generating");
    let summary = "Your personalized routine is ready. Progressive overload built in — you'll be stronger every week.";
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1000,
          system:"You are an elite strength coach. Write a 2-sentence routine summary. Be encouraging, specific, reference goals and level. No markdown.",
          messages:[{
            role:"user",
            content:`Athlete: ${profile.name||"You"}, ${profile.age}y, ${profile.weight}kg, goal: ${profile.goal||"build muscle"}, level: ${profile.level||"intermediate"}, ${profile.daysPerWeek} days/week${resolvedPartner?`\nPartner: ${resolvedPartner.name||"Partner"}, ${resolvedPartner.weight}kg, goal: ${resolvedPartner.goal||"—"}, level: ${resolvedPartner.level||"—"}`:""}`,
          }],
        }),
      });
      const d = await r.json();
      summary = d.content?.find(b=>b.type==="text")?.text || summary;
    } catch {}
    const builtRoutine = buildRoutine(profile, resolvedPartner);
    setRoutine(builtRoutine);
    setAiSummary(summary);
    setTimeout(() => setScreen("home"), 600);
  };

  const regenerateRoutine = async () => {
    setRegenerating(true);
    let summary = "Your routine has been refreshed with updated targets. Keep pushing!";
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1000,
          system:"You are an elite strength coach. Write a 2-sentence routine summary. Be encouraging, specific. No markdown.",
          messages:[{role:"user", content:`Regenerate a new summary for: ${profile.name||"Athlete"}, goal: ${profile.goal||"build muscle"}, level: ${profile.level||"intermediate"}, ${profile.daysPerWeek} days/week.`}],
        }),
      });
      const d = await r.json();
      summary = d.content?.find(b=>b.type==="text")?.text || summary;
    } catch {}
    setRoutine(buildRoutine(profile, partnerProfile));
    setAiSummary(summary);
    setRegenerating(false);
  };

  const handleInvite = async () => {
    const code = genCode();
    try {
      await supabase.from("rooms").insert({ room_code: code, user_a: profile, user_b: null, messages: [] });
      localStorage.setItem("str_room_code", code);
      localStorage.setItem("str_user_slot", "a");
      setRoomCode(code);
      setUserSlot("a");
      setWaitingForPartner(true);
      subscribeToRoom(code, "a", profile);
    } catch (e) {
      console.error("Failed to create room:", e);
    }
  };

  const handleJoin = async () => {
    const code = joinInput.trim().toUpperCase();
    if (!code) { setJoinError("Please enter a room code."); return; }
    try {
      const { data } = await supabase.from("rooms").select("*").eq("room_code", code).single();
      if (!data) { setJoinError("Code not found. Check the code and try again."); return; }
      if (data.user_b) { setJoinError("Room is full. Ask your partner for a new code."); return; }
      await supabase.from("rooms").update({ user_b: profile }).eq("room_code", code);
      const hostProfile = data.user_a;
      localStorage.setItem("str_room_code", code);
      localStorage.setItem("str_user_slot", "b");
      setRoomCode(code);
      setUserSlot("b");
      setPartnerProfile(hostProfile);
      setJoinError("");
      subscribeToRoom(code, "b", profile);
      generateRoutine(hostProfile);
    } catch (e) {
      setJoinError("Could not join room. Check the code and try again.");
    }
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(`https://stronnger.netlify.app/join/${roomCode}`).then(()=>{
      setCopied(true);
      setTimeout(()=>setCopied(false), 2000);
    });
  };

  /* ─── Supabase realtime subscription ─── */
  const subscribeToRoom = (code, slot, userProfile) => {
    if (supaSubRef.current) supaSubRef.current.unsubscribe();
    supaSubRef.current = supabase
      .channel(`room:${code}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: `room_code=eq.${code}` }, (payload) => {
        const data = payload.new;
        const partner = slot === "a" ? data.user_b : data.user_a;
        if (partner) {
          setPartnerProfile(partner);
          setWaitingForPartner(false);
          setRoutine(prev => prev || buildRoutine(userProfile, partner));
        }
        if (data.messages?.length) setMessages(data.messages);
      })
      .subscribe();
  };

  /* ─── Active session helpers ─── */
  const clearActiveSession = () => {
    localStorage.removeItem("str_active_session");
    setActiveSession(null);
    workoutStartRef.current = null;
  };

  const startWorkout = (idx) => {
    const now = Date.now();
    setDayIdx(idx);
    setExIdx(0);
    setSetNum(1);
    setCompletedSets({});
    setResting(false);
    if (timerRef.current) clearInterval(timerRef.current);
    workoutStartRef.current = now;
    const session = { isActive:true, dayIdx:idx, exIdx:0, setNum:1, completedSets:{}, startedAt:now, lastActivityAt:now, restMax:90, resting:false, restSecondsLeft:0 };
    localStorage.setItem("str_active_session", JSON.stringify(session));
    setActiveSession(session);
    setScreen("workout");
  };

  const resumeWorkout = () => {
    if (!activeSession) return;
    const { dayIdx:dIdx, exIdx:eIdx, setNum:sNum, completedSets:cs, startedAt, restMax:rm, resting:wasResting, restSecondsLeft, lastActivityAt } = activeSession;
    setDayIdx(dIdx);
    setExIdx(eIdx);
    setSetNum(sNum);
    setCompletedSets(cs || {});
    workoutStartRef.current = startedAt;
    setRestMax(rm || 90);
    if (wasResting && restSecondsLeft > 0) {
      const elapsed = Math.round((Date.now() - lastActivityAt) / 1000);
      const remaining = Math.max(0, restSecondsLeft - elapsed);
      if (remaining > 0) { startRest(remaining); }
    }
    setConflictPendingDayIdx(null);
    setScreen("workout");
  };

  const navigateHomeFromWorkout = () => {
    if (workoutStartRef.current) {
      const session = { isActive:true, dayIdx, exIdx, setNum, completedSets, startedAt:workoutStartRef.current, lastActivityAt:Date.now(), restMax, resting, restSecondsLeft:resting?restSec:0 };
      localStorage.setItem("str_active_session", JSON.stringify(session));
      setActiveSession(session);
    }
    if (timerRef.current) clearInterval(timerRef.current);
    setResting(false);
    setSheet(null);
    setScreen("home");
  };

  const endWorkoutNow = () => {
    const currentDay = routine?.[dayIdx];
    if (currentDay && workoutStartRef.current) {
      const entry = {
        date: new Date().toLocaleDateString("en-US", {month:"short", day:"numeric"}),
        dayName: currentDay.name,
        totalSets: Object.keys(completedSets).length,
        duration: Math.max(1, Math.round((Date.now() - workoutStartRef.current) / 60000)),
        exercises: currentDay.exercises.length,
      };
      setWorkoutHistory(prev => [entry, ...prev].slice(0, 20));
    }
    if (timerRef.current) clearInterval(timerRef.current);
    setResting(false);
    setSheet(null);
    clearActiveSession();
    setScreen("home");
  };

  /* ─── PIN screen handlers ─── */
  const handlePinDigit = async (d) => {
    if (pinAttempts >= 3) return;
    const next = pinEntry + d;
    setPinEntry(next);
    if (next.length === 4) {
      const h = await hashPIN(next);
      if (h === pinHash) {
        setPinEntry(""); setPinError(""); setPinAttempts(0); setPinShake(false);
        setScreen("home");
      } else {
        const attempts = pinAttempts + 1;
        setPinAttempts(attempts);
        // Trigger shake animation
        setPinShake(true);
        setTimeout(() => setPinShake(false), 450);
        if (attempts >= 3) {
          setPinError("Too many attempts.");
        } else {
          setPinError(`Wrong PIN. ${3 - attempts} attempt${3-attempts===1?"":"s"} left.`);
        }
        setTimeout(() => setPinEntry(""), 500);
      }
    }
  };
  const handlePinDelete = () => {
    if (pinAttempts >= 3) return;
    setPinEntry(p => p.slice(0,-1));
  };

  /* ─── Keyboard support for PIN screen (desktop) ─── */
  useEffect(() => {
    if (screen !== "pin") return;
    const onKey = async (e) => {
      if (pinAttempts >= 3) return;
      if (e.key >= "0" && e.key <= "9") {
        const next = pinEntry + e.key;
        setPinEntry(next);
        if (next.length === 4) {
          const h = await hashPIN(next);
          if (h === pinHash) {
            setPinEntry(""); setPinError(""); setPinAttempts(0); setPinShake(false);
            setScreen("home");
          } else {
            const attempts = pinAttempts + 1;
            setPinAttempts(attempts);
            setPinShake(true);
            setTimeout(() => setPinShake(false), 450);
            if (attempts >= 3) {
              setPinError("Too many attempts.");
            } else {
              setPinError(`Wrong PIN. ${3 - attempts} attempt${3-attempts===1?"":"s"} left.`);
            }
            setTimeout(() => setPinEntry(""), 500);
          }
        }
      } else if (e.key === "Backspace") {
        setPinEntry(p => p.slice(0,-1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, pinEntry, pinAttempts, pinHash]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishOnboarding = async () => {
    if (newPIN.length === 4) {
      const h = await hashPIN(newPIN);
      setPinHash(h); // auto-saved to str_pin via useEffect
    }
    setConfirmPin("");
    generateRoutine();
  };

  const pct = day && ex ? ((exIdx + setNum / ex.sets) / day.exercises.length) * 100 : 0;

  /* ════════════════════════
     PIN SCREEN
  ════════════════════════ */
  const resetAndGoSplash = () => {
    localStorage.clear();
    setProfile(null); setPinHash(null); setRoutine(null); setAiSummary(""); setWorkoutHistory([]); setMessages([]);
    setPinEntry(""); setPinAttempts(0); setPinError(""); setPinShake(false);
    setRoomCode(""); setRoomRole(""); setPartnerProfile(null);
    setNewPIN(""); setConfirmPin("");
    setScreen("splash");
  };

  if (screen === "pin") return (
    <>
      <GlobalStyles />
      <div style={{background:"#000",minHeight:"100vh",maxWidth:430,margin:"0 auto",display:"flex",flexDirection:"column",padding:"0 28px",position:"relative"}}>
        {/* STRONGER logo — small, top center */}
        <div style={{paddingTop:"max(env(safe-area-inset-top),32px)",textAlign:"center"}}>
          <span style={{fontFamily:"var(--font-display)",fontSize:20,letterSpacing:6,color:"rgba(255,255,255,0.2)"}}>STRONGER</span>
        </div>

        {/* Main centered content */}
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center"}}>
          <div className="fu" style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:4,color:"var(--gray)",marginBottom:10}}>
            WELCOME BACK
          </div>
          <div className="fu1" style={{fontFamily:"var(--font-display)",fontSize:64,lineHeight:0.88,marginBottom:4}}>
            {(profile.name||"ATHLETE").toUpperCase()}
          </div>

          <PinDots count={pinEntry.length} error={pinAttempts >= 3} shake={pinShake} />

          <div style={{minHeight:22,marginBottom:20}}>
            {pinError && (
              <div style={{fontFamily:"var(--font-cond)",fontSize:12,letterSpacing:1,color:"var(--red)"}}>{pinError}</div>
            )}
          </div>

          {/* Numpad — always visible, disabled after 3 attempts */}
          <Numpad onDigit={handlePinDigit} onDelete={handlePinDelete} />

          {/* After 3 wrong attempts: show prominent reset button */}
          {pinAttempts >= 3 ? (
            <div style={{marginTop:32,width:"100%"}}>
              <Btn full variant="red-soft" onClick={resetAndGoSplash}>
                Forgot PIN? Reset Everything
              </Btn>
            </div>
          ) : (
            <button
              onClick={resetAndGoSplash}
              style={{background:"none",border:"none",fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray2)",marginTop:32,cursor:"pointer"}}
            >
              FORGOT PIN?
            </button>
          )}
        </div>
      </div>
    </>
  );

  /* ════════════════════════
     SPLASH
  ════════════════════════ */
  if (screen === "splash") return (
    <>
      <GlobalStyles />
      <div style={{background:"var(--black)",minHeight:"100vh",maxWidth:430,margin:"0 auto",display:"flex",flexDirection:"column",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:"5%",left:"-8px",fontFamily:"var(--font-display)",fontSize:190,color:"rgba(255,255,255,0.025)",lineHeight:0.88,pointerEvents:"none",userSelect:"none",letterSpacing:-4}}>
          STR<br/>ONG<br/>ER
        </div>
        <div style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"flex-end",padding:"0 28px 56px"}}>
          <div className="fu" style={{marginBottom:44}}>
            <div style={{display:"inline-flex",background:"var(--lime)",borderRadius:6,padding:"4px 12px",marginBottom:18}}>
              <span style={{fontFamily:"var(--font-cond)",fontWeight:800,fontSize:11,color:"var(--black)",letterSpacing:3}}>COUPLES TRAINING</span>
            </div>
            <div style={{fontFamily:"var(--font-display)",fontSize:92,lineHeight:0.86,color:"var(--white)",letterSpacing:1}}>STRON<br/>GER</div>
            <p style={{fontFamily:"var(--font-body)",fontSize:16,color:"var(--gray)",marginTop:18,lineHeight:1.55}}>AI-powered strength training<br/>built for two. Train together,<br/>get stronger together.</p>
          </div>
          <div className="fu1" style={{display:"flex",flexDirection:"column",gap:12}}>
            <Btn full onClick={()=>{
              setSplashLoginError("");
              // Initialize empty profile so onboarding forms aren't null-unsafe
              if (!profile) setProfile({name:"",age:"",weight:"",height:"",sex:"",goal:"",level:"",daysPerWeek:"3",equipment:[],injuries:""});
              setScreen("onboarding");
              setOnboardStep(0);
            }}>Create Account</Btn>
            <Btn full variant="ghost" onClick={()=>{
              // profile and pinHash are already in state (lazy-loaded from str_* keys on startup)
              if (profile && pinHash) {
                // Ensure routine exists (may have been cleared in state but not localStorage)
                if (!routine) setRoutine(buildRoutine(profile));
                setSplashLoginError("");
                setScreen("pin");
              } else {
                setSplashLoginError("No account found. Please create an account first.");
              }
            }}>Log In</Btn>
            {splashLoginError && (
              <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",textAlign:"center",marginTop:4}}>{splashLoginError}</div>
            )}
          </div>
          <p className="fu2" style={{fontFamily:"var(--font-body)",fontSize:11,color:"var(--gray2)",textAlign:"center",marginTop:20,lineHeight:1.7}}>
            Progress photos stored on-device only<br/>Never shared · Never AI-accessed
          </p>
        </div>
      </div>
    </>
  );

  /* ════════════════════════
     GENERATING
  ════════════════════════ */
  if (screen === "generating") return (
    <>
      <GlobalStyles />
      <div style={{background:"var(--black)",minHeight:"100vh",maxWidth:430,margin:"0 auto",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,textAlign:"center"}}>
        <div style={{marginBottom:32}}>
          <div style={{width:72,height:72,border:"3px solid var(--lime)",borderTopColor:"transparent",borderRadius:99,animation:"spin 0.9s linear infinite",margin:"0 auto 28px"}}/>
          <div style={{fontFamily:"var(--font-display)",fontSize:48,lineHeight:0.9,marginBottom:12}}>BUILDING<br/>YOUR<br/>ROUTINE</div>
          <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6}}>
            Analyzing {profile.name||"your"} profile.<br/>
            Calculating optimal loads and weekly structure.
          </p>
        </div>
        <div style={{display:"flex",gap:8}}>
          {["GOALS","LEVELS","VOLUME","RECOVERY"].map((l,i)=>(
            <div key={l} style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--lime)",background:"rgba(200,241,53,.08)",borderRadius:6,padding:"5px 8px",animation:`pulse 1.5s ${i*0.3}s infinite`}}>{l}</div>
          ))}
        </div>
      </div>
    </>
  );

  /* ════════════════════════
     ONBOARDING (6 steps)
  ════════════════════════ */
  if (screen === "onboarding") {
    const TOTAL_STEPS  = 6;
    const progress     = ((onboardStep+1)/TOTAL_STEPS)*100;
    const nextStep     = () => setOnboardStep(s=>s+1);
    const prevStep     = () => onboardStep>0 ? setOnboardStep(s=>s-1) : setScreen("splash");
    const isPartnerStep = onboardStep===5;

    /* ── Chip (fixed: case-insensitive comparison) ── */
    const Chip = ({value, current, onToggle, single, currentSingle, onSelect}) => {
      const active = single
        ? (currentSingle||"").toLowerCase()===(value||"").toLowerCase()
        : current?.includes(value);
      return (
        <button className={`chip${active?" active":""}`} onClick={()=>single?onSelect(value):onToggle(value)}>{value}</button>
      );
    };

    const toggleEquip = (v) => {
      const arr = profile.equipment||[];
      p("equipment", arr.includes(v)?arr.filter(x=>x!==v):[...arr,v]);
    };

    const GOALS  = ["Lose fat","Build muscle","Get stronger","Improve endurance","Stay active"];
    const LEVELS = ["Beginner","Intermediate","Advanced"];
    const EQUIP  = ["Full gym","Dumbbells only","Barbell + rack","Cables","Machines","Resistance bands"];
    const DAYS   = ["2","3","4","5","6"];

    const stepContent = [
      /* 0 — Name + PIN */
      <div key={0} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 1 OF {TOTAL_STEPS}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>WHO<br/>ARE<br/>YOU?</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>Just you here. Your partner creates their own profile separately.</p>
        <Input label="YOUR NAME" placeholder="Alex" value={profile.name} onChange={v=>p("name",v)} />
        <div style={{marginTop:16}}>
          <Label text="CREATE A 4-DIGIT PIN" />
          <p style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray2)",marginBottom:14,lineHeight:1.5}}>Protects your profile when you hand off your phone.</p>
          <div style={{marginBottom:14}}>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              placeholder="• • • •"
              value={newPIN}
              onChange={e=>{
                const v = e.target.value.replace(/\D/g,"").slice(0,4);
                setNewPIN(v);
                setPinMatchError("");
              }}
              style={{
                width:"100%",background:"var(--card)",border:"1.5px solid var(--line2)",
                borderRadius:12,padding:"14px 16px",fontFamily:"var(--font-body)",
                fontSize:24,letterSpacing:8,color:"var(--white)",textAlign:"center",
              }}
            />
          </div>
          <Label text="CONFIRM PIN" />
          <div style={{marginBottom:6}}>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              placeholder="• • • •"
              value={confirmPin}
              onChange={e=>{
                const v = e.target.value.replace(/\D/g,"").slice(0,4);
                setConfirmPin(v);
                setPinMatchError("");
              }}
              style={{
                width:"100%",background:"var(--card)",border:`1.5px solid ${pinMatchError?"var(--red)":"var(--line2)"}`,
                borderRadius:12,padding:"14px 16px",fontFamily:"var(--font-body)",
                fontSize:24,letterSpacing:8,color:"var(--white)",textAlign:"center",
              }}
            />
          </div>
          {pinMatchError && (
            <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginTop:6}}>{pinMatchError}</div>
          )}
        </div>
      </div>,

      /* 1 — Stats */
      <div key={1} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 2 OF {TOTAL_STEPS}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>YOUR<br/>STATS</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:32}}>Used to calibrate your weights and rest times.</p>
        <div style={{display:"flex",gap:12}}>
          <div style={{flex:1}}><Input label="AGE" placeholder="28" value={profile.age} onChange={v=>p("age",v)} type="number"/></div>
          <div style={{flex:1}}><Input label="WEIGHT" placeholder="80" value={profile.weight} onChange={v=>p("weight",v)} type="number" unit="kg"/></div>
          <div style={{flex:1}}><Input label="HEIGHT" placeholder="175" value={profile.height} onChange={v=>p("height",v)} type="number" unit="cm"/></div>
        </div>
        <Label text="BIOLOGICAL SEX"/>
        <div className="chip-select">
          {["Male","Female","Other"].map(v=><Chip key={v} value={v} single currentSingle={profile.sex} onSelect={v=>p("sex",v)}/>)}
        </div>
      </div>,

      /* 2 — Goals & level */
      <div key={2} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 3 OF {TOTAL_STEPS}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>YOUR<br/>GOALS</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:28}}>What are you training for, {profile.name||"you"}?</p>
        <Label text="PRIMARY GOAL"/>
        <div className="chip-select" style={{marginBottom:28}}>
          {GOALS.map(v=><Chip key={v} value={v} single currentSingle={profile.goal} onSelect={v=>p("goal",v)}/>)}
        </div>
        <Label text="TRAINING LEVEL"/>
        <div className="chip-select">
          {LEVELS.map(v=><Chip key={v} value={v} single currentSingle={profile.level} onSelect={v=>p("level",v.toLowerCase())}/>)}
        </div>
      </div>,

      /* 3 — Schedule + equipment */
      <div key={3} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 4 OF {TOTAL_STEPS}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>YOUR<br/>GYM</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:28}}>When and what do you train with?</p>
        <Label text="DAYS PER WEEK"/>
        <div className="chip-select" style={{marginBottom:28}}>
          {DAYS.map(v=><Chip key={v} value={v} single currentSingle={profile.daysPerWeek} onSelect={v=>p("daysPerWeek",v)}/>)}
        </div>
        <Label text="AVAILABLE EQUIPMENT (select all)"/>
        <div className="chip-select">
          {EQUIP.map(v=><Chip key={v} value={v} current={profile.equipment} onToggle={toggleEquip}/>)}
        </div>
      </div>,

      /* 4 — Injuries */
      <div key={4} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 5 OF {TOTAL_STEPS}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>ANY<br/>LIMITS?</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:28}}>Any injuries or areas to avoid? The AI will work around them.</p>
        <Label text="INJURIES / LIMITATIONS (optional)"/>
        <textarea
          value={profile.injuries} onChange={e=>p("injuries",e.target.value)}
          placeholder="e.g. left knee pain, lower back issues..." rows={4}
          style={{width:"100%",background:"var(--card)",border:"1.5px solid var(--line2)",borderRadius:12,padding:14,fontFamily:"var(--font-body)",fontSize:16,color:"var(--white)",resize:"none",marginBottom:24}}
        />
        <div style={{background:"var(--card)",borderRadius:16,border:"1px solid var(--line)",padding:18}}>
          <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:12}}>YOUR PROFILE SUMMARY</div>
          {[
            [profile.name||"You", `${profile.goal||"—"} · ${profile.level||"—"}`],
            ["Schedule", `${profile.daysPerWeek} days/week`],
            ["Equipment", profile.equipment.length?profile.equipment.join(", "):"Full gym"],
          ].map(([l,v])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid var(--line)"}}>
              <span style={{fontFamily:"var(--font-cond)",fontSize:12,color:"var(--gray)",letterSpacing:1}}>{l}</span>
              <span style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:12,color:"var(--white)",textAlign:"right",maxWidth:"55%"}}>{v}</span>
            </div>
          ))}
        </div>
      </div>,

      /* 5 — Partner connection */
      <div key={5} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 6 OF {TOTAL_STEPS}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>CONNECT<br/>PARTNER</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:28}}>
          Connect with your partner to sync routines and weights — or go solo and connect later.
        </p>
        {!roomCode ? (
          <>
            <Btn full onClick={handleInvite} style={{marginBottom:12}}>Invite My Partner</Btn>
            <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)",textAlign:"center",marginBottom:12}}>OR</div>
            <div style={{background:"var(--card)",border:"1.5px solid var(--line2)",borderRadius:14,padding:16,marginBottom:12}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:10}}>ENTER PARTNER'S CODE</div>
              <div style={{display:"flex",gap:8}}>
                <input
                  value={joinInput}
                  onChange={e=>{setJoinInput(e.target.value.toUpperCase());setJoinError("");}}
                  placeholder="STR-XXXX"
                  style={{flex:1,background:"var(--dark)",border:"1.5px solid var(--line2)",borderRadius:10,padding:"12px 14px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:16,letterSpacing:2,color:"var(--white)",outline:"none"}}
                />
                <button onClick={handleJoin} style={{background:"var(--lime)",border:"none",borderRadius:10,padding:"12px 18px",fontFamily:"var(--font-cond)",fontWeight:900,fontSize:13,letterSpacing:2,color:"var(--black)",cursor:"pointer"}}>JOIN</button>
              </div>
              {joinError && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginTop:8}}>{joinError}</div>}
            </div>
            <Btn full variant="ghost" onClick={finishOnboarding}>Skip — Go Solo</Btn>
          </>
        ) : waitingForPartner ? (
          <div style={{textAlign:"center"}}>
            <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--gray)",marginBottom:12}}>YOUR ROOM CODE</div>
            <div style={{fontFamily:"var(--font-display)",fontSize:72,color:"var(--lime)",letterSpacing:4,marginBottom:20,lineHeight:1}}>{roomCode}</div>
            <Btn full onClick={handleCopyLink} style={{marginBottom:20}}>{copied?"✓ Copied!":"Copy Invite Link"}</Btn>
            <div style={{display:"flex",alignItems:"center",gap:10,justifyContent:"center",marginBottom:24}}>
              <div style={{width:9,height:9,borderRadius:99,background:"var(--lime)",animation:"pulse 1.5s infinite"}}/>
              <span style={{fontFamily:"var(--font-cond)",fontSize:12,letterSpacing:2,color:"var(--gray)"}}>WAITING FOR PARTNER...</span>
            </div>
            <Btn full variant="ghost" onClick={finishOnboarding}>Continue Solo for Now</Btn>
          </div>
        ) : null}
      </div>,
    ];

    return (
      <>
        <GlobalStyles/>
        <div style={{background:"var(--black)",minHeight:"100vh",maxWidth:430,margin:"0 auto",display:"flex",flexDirection:"column"}}>
          <div style={{height:3,background:"var(--line)",position:"relative"}}>
            <div style={{position:"absolute",top:0,left:0,height:"100%",width:`${progress}%`,background:"var(--lime)",transition:"width 0.4s cubic-bezier(.4,0,.2,1)",borderRadius:"0 99px 99px 0"}}/>
          </div>
          <div style={{padding:"16px 24px 0"}}>
            <button onClick={prevStep} style={{background:"none",border:"none",color:"var(--gray)",fontFamily:"var(--font-cond)",fontSize:13,letterSpacing:2,cursor:"pointer",padding:0}}>
              ← {onboardStep===0?"BACK":"PREV"}
            </button>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"24px 24px 0"}}>
            {stepContent[onboardStep]}
          </div>
          {!isPartnerStep && (
            <div style={{padding:"20px 24px 40px"}}>
              {onboardStep===0
                ? <Btn full onClick={()=>{
                    if (!profile.name.trim()) return;
                    if (newPIN.length !== 4 || !/^\d{4}$/.test(newPIN)) {
                      setPinMatchError("PIN must be exactly 4 digits.");
                      return;
                    }
                    if (newPIN !== confirmPin) {
                      setPinMatchError("PINs don't match");
                      return;
                    }
                    setPinMatchError("");
                    nextStep();
                  }}>Continue</Btn>
                : <Btn full onClick={nextStep}>Continue</Btn>
              }
            </div>
          )}
          {isPartnerStep && <div style={{paddingBottom:40}}/>}
        </div>
      </>
    );
  }

  /* ════════════════════════
     WORKOUT
  ════════════════════════ */
  if (screen === "workout" && day && ex) {
    if (!workoutStartRef.current) workoutStartRef.current = Date.now();
    return (
      <>
        <GlobalStyles/>
        <div style={{background:"var(--black)",minHeight:"100vh",maxWidth:430,margin:"0 auto",display:"flex",flexDirection:"column"}}>
          <div style={{padding:"16px 20px 0",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <button onClick={navigateHomeFromWorkout} style={{background:"var(--card)",border:"none",borderRadius:10,width:38,height:38,color:"var(--white)",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>←</button>
            <div style={{textAlign:"center"}}>
              <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:3,color:accentColor}}>{day.name}</div>
              <div style={{fontFamily:"var(--font-cond)",fontWeight:600,fontSize:13,color:"var(--gray)"}}>{exIdx+1} / {day.exercises.length}</div>
            </div>
            <button onClick={()=>setSheet("emergency")} style={{background:"rgba(255,59,48,.12)",border:"none",borderRadius:10,padding:"8px 14px",color:"var(--red)",fontSize:12,fontWeight:700,fontFamily:"var(--font-cond)",letterSpacing:1,cursor:"pointer"}}>STOP</button>
          </div>
          <div style={{padding:"14px 20px 0"}}>
            <div style={{height:3,background:"var(--line)",borderRadius:99,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${pct}%`,background:accentColor,borderRadius:99,transition:"width 0.5s cubic-bezier(.4,0,.2,1)"}}/>
            </div>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"20px 20px 130px"}}>
            <div className="fu" style={{marginBottom:20}}>
              <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:3,color:"var(--gray)",marginBottom:6}}>{ex.muscles} · RPE {ex.rpe}</div>
              <div style={{fontFamily:"var(--font-display)",fontSize:52,lineHeight:0.92,color:"var(--white)",marginBottom:14}}>{ex.name.toUpperCase()}</div>
              <div style={{display:"flex",gap:8}}>
                {[{l:"SETS",v:ex.sets},{l:"REPS",v:ex.reps},{l:"REST",v:`${ex.rest}s`}].map(({l,v})=>(
                  <div key={l} style={{flex:1,background:"var(--card)",borderRadius:12,padding:"12px 0",textAlign:"center",border:"1px solid var(--line)"}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"var(--gray)",marginBottom:4}}>{l}</div>
                    <div style={{fontFamily:"var(--font-cond)",fontWeight:800,fontSize:22,color:"var(--white)"}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="fu1" style={{background:"var(--card)",borderRadius:16,border:"1px solid var(--line)",padding:16,marginBottom:16}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:12}}>WEIGHTS</div>
              <div style={{display:"flex",gap:12}}>
                <div style={{flex:1,background:"var(--black)",borderRadius:12,padding:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"var(--gray)",marginBottom:4}}>{profile.name?.toUpperCase()||"YOU"}</div>
                  <div style={{fontFamily:"var(--font-display)",fontSize:38,color:accentColor,lineHeight:1}}>{ex.wA}</div>
                </div>
                <div style={{width:1,background:"var(--line)"}}/>
                <div style={{flex:1,background:"var(--black)",borderRadius:12,padding:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"var(--gray)",marginBottom:4}}>{partnerProfile?.name?.toUpperCase()||"PARTNER"}</div>
                  <div style={{fontFamily:"var(--font-display)",fontSize:38,color:"var(--gray)",lineHeight:1}}>{ex.wB}</div>
                </div>
              </div>
            </div>
            <div className="fu2" style={{background:"var(--card)",borderRadius:16,border:"1px solid var(--line)",padding:16,marginBottom:16}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:12}}>SETS</div>
              <div style={{display:"flex",gap:8}}>
                {Array.from({length:ex.sets}).map((_,i)=>{
                  const done = completedSets[`${exIdx}-${i+1}`];
                  const cur  = i+1===setNum;
                  return (
                    <div key={i} style={{flex:1,height:48,borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",background:done?accentColor:cur?`${accentColor}22`:"var(--black)",border:cur?`1.5px solid ${accentColor}`:"1.5px solid var(--line)",fontFamily:"var(--font-cond)",fontWeight:800,fontSize:16,color:done?"var(--black)":cur?accentColor:"var(--gray2)",transition:"all .2s"}}>
                      {done?"✓":i+1}
                    </div>
                  );
                })}
              </div>
            </div>
            {resting && (
              <div className="fu" style={{background:"var(--card)",borderRadius:20,border:"1px solid var(--line)",padding:28,marginBottom:16,textAlign:"center"}}>
                <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:20}}>REST</div>
                <div style={{position:"relative",width:130,height:130,margin:"0 auto 20px"}}>
                  <svg width="130" height="130" style={{position:"absolute",top:0,left:0,transform:"rotate(-90deg)"}}>
                    <circle cx="65" cy="65" r="60" fill="none" stroke="var(--line)" strokeWidth="4"/>
                    <circle cx="65" cy="65" r="60" fill="none" stroke={accentColor} strokeWidth="4" strokeDasharray="377" strokeDashoffset={377-(restSec/restMax)*377} strokeLinecap="round" style={{transition:"stroke-dashoffset 1s linear"}}/>
                  </svg>
                  <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                    <div style={{fontFamily:"var(--font-display)",fontSize:48,color:"var(--white)",lineHeight:1}}>{restSec}</div>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:2}}>SEC</div>
                  </div>
                </div>
                <button onClick={skipRest} style={{background:"transparent",border:"1px solid var(--line2)",borderRadius:10,padding:"10px 28px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,color:"var(--gray)",cursor:"pointer"}}>SKIP REST</button>
              </div>
            )}
          </div>
          {!resting && (
            <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,padding:"12px 20px 34px",background:"linear-gradient(transparent,var(--black) 35%)"}}>
              <button onClick={completeSet} style={{width:"100%",background:accentColor,border:"none",borderRadius:16,padding:"18px 0",fontFamily:"var(--font-cond)",fontWeight:900,fontSize:18,letterSpacing:3,color:"var(--black)",cursor:"pointer",marginBottom:10,textTransform:"uppercase",boxShadow:`0 0 30px ${accentColor}44`}}>
                {setNum<ex.sets?`COMPLETE SET ${setNum}`:exIdx<day.exercises.length-1?"NEXT EXERCISE →":"FINISH WORKOUT"}
              </button>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>{setSheet("ai");fetchAI(`I'm doing ${ex.name}, ${ex.reps} reps at ${ex.wA}. Give me 3 form cues and tell me if I should adjust if I'm struggling.`);}} style={{flex:1,background:"var(--card)",border:"1px solid var(--line)",borderRadius:14,padding:"14px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,color:"var(--white)",cursor:"pointer"}}>AI COACH</button>
                <button onClick={()=>setSheet("partner")} style={{flex:1,background:"var(--card)",border:"1px solid var(--line)",borderRadius:14,padding:"14px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,color:"var(--white)",cursor:"pointer"}}>PARTNER</button>
              </div>
            </div>
          )}
          {sheet && (
            <div onClick={()=>setSheet(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,backdropFilter:"blur(4px)"}}>
              <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#181818",borderRadius:"24px 24px 0 0",padding:28,animation:"slideIn .3s cubic-bezier(.4,0,.2,1)",maxHeight:"85vh",overflowY:"auto"}}>
                {sheet==="ai" && <>
                  <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:4}}>AI COACH</div>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:accentColor,marginBottom:20}}>{ex.name.toUpperCase()}</div>
                  {aiLoading
                    ? <div style={{display:"flex",alignItems:"center",gap:12,color:"var(--gray)",padding:"20px 0"}}><div style={{width:16,height:16,border:`2px solid ${accentColor}`,borderTopColor:"transparent",borderRadius:99,animation:"spin .8s linear infinite"}}/><span style={{fontFamily:"var(--font-cond)",letterSpacing:1}}>ANALYZING...</span></div>
                    : <p style={{fontFamily:"var(--font-body)",fontSize:15,lineHeight:1.7,color:"#ccc",marginBottom:20}}>{aiText}</p>}
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <Btn variant="red-soft" full onClick={()=>fetchAI(`I feel discomfort doing ${ex.name}. Should I stop, modify, or push through?`)}>⚠️ I FEEL PAIN</Btn>
                    <Btn variant="ghost" full onClick={()=>setSheet(null)}>CLOSE</Btn>
                  </div>
                </>}
                {sheet==="partner" && (
                  partnerProfile ? (
                    <>
                      <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:20}}>
                        <div style={{width:50,height:50,borderRadius:99,background:accentColor,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-display)",fontSize:22,color:"var(--black)"}}>{(partnerProfile.name||"?").slice(0,2).toUpperCase()}</div>
                        <div>
                          <div style={{fontFamily:"var(--font-display)",fontSize:28}}>{(partnerProfile.name||"PARTNER").toUpperCase()}</div>
                          <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:7,height:7,borderRadius:99,background:"#30d158",animation:"pulse 2s infinite"}}/><span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"#30d158"}}>TRAINING NOW</span></div>
                        </div>
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
                        {messages.map((m,i)=>{
                          const isMe = m.slot ? m.slot===userSlot : m.from==="me";
                          return (
                            <div key={i} style={{alignSelf:isMe?"flex-end":"flex-start",background:isMe?accentColor:"var(--card)",borderRadius:isMe?"14px 4px 14px 14px":"4px 14px 14px 14px",padding:"10px 14px",maxWidth:"78%"}}>
                              <div style={{fontFamily:"var(--font-body)",fontSize:14,color:isMe?"var(--black)":"var(--white)"}}>{m.text}</div>
                            </div>
                          );
                        })}
                      </div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                        {["✅ Set done!","❓ Form check?","💪 Let's go!","⏸️ Break"].map(t=>(
                          <button key={t} onClick={async ()=>{
                            const newMsg = {slot:userSlot,text:t,ts:Date.now()};
                            const updated = [...messages, newMsg];
                            setMessages(updated);
                            if (roomCode) await supabase.from("rooms").update({messages:updated}).eq("room_code",roomCode);
                          }} style={{background:"var(--dark)",border:"1px solid var(--line)",borderRadius:99,padding:"8px 14px",fontFamily:"var(--font-body)",fontSize:12,color:"var(--white)",cursor:"pointer"}}>{t}</button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div style={{textAlign:"center",padding:"20px 0"}}>
                      <div style={{fontSize:40,marginBottom:12}}>🔗</div>
                      <div style={{fontFamily:"var(--font-display)",fontSize:32,marginBottom:8}}>NO PARTNER YET</div>
                      <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6,marginBottom:20}}>Share your room code from the Partner tab to connect.</p>
                      <Btn variant="ghost" full onClick={()=>setSheet(null)}>CLOSE</Btn>
                    </div>
                  )
                )}
                {sheet==="emergency" && <>
                  <div style={{fontFamily:"var(--font-display)",fontSize:42,color:"var(--red)",marginBottom:8}}>STOP?</div>
                  <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>Your progress is saved. You can always come back.</p>
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <Btn variant="dark" full onClick={navigateHomeFromWorkout}>Resume Later</Btn>
                    <Btn variant="red" full onClick={endWorkoutNow}>End Workout Now</Btn>
                    <Btn variant="ghost" full onClick={()=>setSheet(null)}>Keep Going</Btn>
                  </div>
                </>}
                {sheet==="complete" && (
                  <div style={{textAlign:"center",paddingTop:8}}>
                    <div style={{fontSize:56,marginBottom:12}}>🎉</div>
                    <div style={{fontFamily:"var(--font-display)",fontSize:52,color:accentColor,lineHeight:0.9,marginBottom:8}}>WORKOUT<br/>COMPLETE</div>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:13,color:"var(--gray)",letterSpacing:2,marginBottom:28}}>{day.name.toUpperCase()} · {day.exercises.length} EXERCISES</div>
                    <div style={{display:"flex",gap:12,marginBottom:28}}>
                      {[
                        ["SETS",`${day.exercises.reduce((a,e)=>a+e.sets,0)}`],
                        ["EXER.",`${day.exercises.length}`],
                        ["TIME",`${workoutStartRef.current?Math.max(1,Math.round((Date.now()-workoutStartRef.current)/60000)):45} min`],
                      ].map(([l,v])=>(
                        <div key={l} style={{flex:1,background:"var(--card)",borderRadius:14,padding:"14px 8px"}}>
                          <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--gray)",marginBottom:4}}>{l}</div>
                          <div style={{fontFamily:"var(--font-display)",fontSize:24,color:accentColor}}>{v}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:10}}>
                      <Btn full onClick={()=>{clearActiveSession();setSheet(null);setScreen("home");setExIdx(0);setSetNum(1);setCompletedSets({});}}>DONE</Btn>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  /* ════════════════════════
     HOME
  ════════════════════════ */
  return (
    <>
      <GlobalStyles/>
      <div style={{background:"var(--black)",minHeight:"100vh",maxWidth:430,margin:"0 auto",display:"flex",flexDirection:"column",paddingBottom:72}}>

        {/* Header */}
        <div style={{padding:"22px 22px 0",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)"}}>GOOD {new Date().getHours()<12?"MORNING":new Date().getHours()<17?"AFTERNOON":"EVENING"}</div>
            <div style={{fontFamily:"var(--font-display)",fontSize:28,lineHeight:1.05,marginTop:2}}>
              {(profile.name||"ATHLETE").toUpperCase()}
              {partnerProfile?` & ${(partnerProfile.name||"PARTNER").toUpperCase()}`:""}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {partnerProfile && (
              <div style={{display:"flex",alignItems:"center",gap:5,background:"rgba(48,209,88,.08)",borderRadius:99,padding:"5px 11px",border:"1px solid rgba(48,209,88,.18)"}}>
                <div style={{width:7,height:7,borderRadius:99,background:"#30d158",animation:"pulse 2s infinite"}}/>
                <span style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"#30d158"}}>{(partnerProfile.name||"PARTNER").toUpperCase()}</span>
              </div>
            )}
            <button onClick={()=>setShowLogout(true)} style={{background:"var(--card)",border:"none",borderRadius:10,width:34,height:34,color:"var(--gray)",fontSize:13,cursor:"pointer"}}>⏻</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{display:"flex",gap:8,padding:"18px 22px 0",overflowX:"auto"}}>
          {[["today","TODAY"],["routine","ROUTINE"],["partner","PARTNER"],["progress","PROGRESS"]].map(([k,l])=>(
            <button key={k} onClick={()=>setTab(k)} style={{flexShrink:0,background:tab===k?"var(--white)":"var(--card)",border:tab===k?"none":"1px solid var(--line)",borderRadius:99,padding:"9px 18px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:12,letterSpacing:2,color:tab===k?"var(--black)":"var(--gray)",cursor:"pointer",transition:"all .2s"}}>{l}</button>
          ))}
        </div>

        <div style={{flex:1,overflowY:"auto",padding:"20px 22px 0"}}>

          {/* TODAY */}
          {tab==="today" && (
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              {aiSummary && (
                <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid rgba(200,241,53,.2)",padding:20}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:8}}>AI COACH NOTE</div>
                  <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"#ccc",lineHeight:1.65}}>{aiSummary}</p>
                </div>
              )}
              <div className="fu1" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20}}>
                <div style={{display:"flex",gap:6,marginBottom:14}}>
                  {["M","T","W","T","F","S","S"].map((d,i)=>(
                    <div key={i} style={{flex:1,textAlign:"center"}}>
                      <div style={{height:4,borderRadius:99,background:i<5?"var(--lime)":"var(--line)",marginBottom:5}}/>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,fontWeight:700,color:i<5?"var(--lime)":"var(--gray2)"}}>{d}</div>
                    </div>
                  ))}
                </div>
                <div style={{fontFamily:"var(--font-display)",fontSize:40,lineHeight:0.9}}>
                  {workoutHistory.length>0?`${workoutHistory.length} WORKOUT${workoutHistory.length>1?"S":""} 🔥`:"START YOUR FIRST 💪"}
                </div>
                <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1,marginTop:6}}>WEEK 1 · {routine?.length||3} DAYS/WEEK PLAN</div>
              </div>
              {activeSession?.isActive && (
                <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid rgba(200,241,53,.25)",borderLeft:"4px solid var(--lime)",padding:18,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <div>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:4}}>ACTIVE SESSION</div>
                    <div style={{fontFamily:"var(--font-display)",fontSize:24,lineHeight:1}}>{(routine?.[activeSession.dayIdx]?.name||"WORKOUT").toUpperCase()}</div>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1,marginTop:2}}>{Object.keys(activeSession.completedSets||{}).length} SETS COMPLETED</div>
                  </div>
                  <button onClick={resumeWorkout} style={{background:"var(--lime)",border:"none",borderRadius:12,padding:"12px 18px",fontFamily:"var(--font-cond)",fontWeight:800,fontSize:13,letterSpacing:2,color:"var(--black)",cursor:"pointer"}}>RESUME</button>
                </div>
              )}
              {(routine||[]).map((d,i)=>(
                <div key={i} className="fu2" onClick={()=>{
                  if (activeSession?.isActive && activeSession.dayIdx !== i) {
                    setConflictPendingDayIdx(i);
                  } else if (activeSession?.isActive && activeSession.dayIdx === i) {
                    resumeWorkout();
                  } else {
                    startWorkout(i);
                  }
                }}
                  style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,cursor:"pointer",position:"relative",overflow:"hidden"}}>
                  <div style={{position:"absolute",top:0,left:0,width:4,height:"100%",background:d.color}}/>
                  <div style={{paddingLeft:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                      <div>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:d.color,marginBottom:4}}>{d.label}</div>
                        <div style={{fontFamily:"var(--font-display)",fontSize:30,lineHeight:0.95,marginBottom:5}}>{d.name.toUpperCase()}</div>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>{d.tag}</div>
                      </div>
                      <div style={{background:d.color,borderRadius:99,width:34,height:34,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>{["🏋️","💪","🦵","🔄","🏃","🧘"][i]||"🏋️"}</div>
                    </div>
                    <div style={{marginTop:12,display:"flex",gap:16}}>
                      <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{d.exercises.length} EXERCISES</span>
                      <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>~{40+d.exercises.length*3} MIN</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ROUTINE */}
          {tab==="routine" && (
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <div className="fu" style={{background:"var(--card)",borderRadius:18,padding:20,border:"1px solid var(--line)"}}>
                <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:6}}>AI GENERATED · MONTH 1</div>
                <div style={{fontFamily:"var(--font-display)",fontSize:36,lineHeight:0.9,marginBottom:8}}>YOUR ROUTINE</div>
                <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",lineHeight:1.6,marginBottom:16}}>
                  {profile.daysPerWeek}-day plan. Calibrated for {profile.name||"you"}{partnerProfile?` and ${partnerProfile.name||"your partner"}`:""}.
                </div>
                <button
                  onClick={regenerateRoutine}
                  disabled={regenerating}
                  style={{background:"rgba(200,241,53,.1)",border:"1.5px solid rgba(200,241,53,.3)",borderRadius:10,padding:"10px 20px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:12,letterSpacing:2,color:regenerating?"var(--gray)":"var(--lime)",cursor:regenerating?"not-allowed":"pointer",display:"flex",alignItems:"center",gap:8}}
                >
                  {regenerating
                    ? <><div style={{width:12,height:12,border:"2px solid var(--lime)",borderTopColor:"transparent",borderRadius:99,animation:"spin .8s linear infinite"}}/> REGENERATING...</>
                    : "↺ REGENERATE ROUTINE"}
                </button>
              </div>
              {(routine||[]).map((d,i)=>(
                <div key={i} className="fu1">
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:d.color,marginBottom:10,paddingLeft:4}}>{d.label} — {d.name.toUpperCase()}</div>
                  {d.exercises.map((e,j)=>(
                    <div key={j} style={{background:"var(--card)",borderRadius:12,padding:"13px 16px",border:"1px solid var(--line)",marginBottom:7,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <div>
                        <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:15}}>{e.name}</div>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1,marginTop:2}}>{e.sets} × {e.reps} · {e.muscles}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontFamily:"var(--font-display)",fontSize:18,color:d.color}}>{e.wA}</div>
                        <div style={{fontFamily:"var(--font-display)",fontSize:14,color:"var(--gray2)"}}>{e.wB}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* PARTNER */}
          {tab==="partner" && (
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              {!partnerProfile ? (
                <>
                  <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:28,textAlign:"center"}}>
                    <div style={{fontSize:44,marginBottom:14}}>🔗</div>
                    <div style={{fontFamily:"var(--font-display)",fontSize:36,lineHeight:0.9,marginBottom:10}}>PARTNER NOT<br/>CONNECTED</div>
                    <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>
                      Share your room code so your partner can join, or enter their code below.
                    </p>
                    {roomCode ? (
                      <>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>YOUR ROOM CODE</div>
                        <div style={{fontFamily:"var(--font-display)",fontSize:56,color:"var(--lime)",letterSpacing:4,marginBottom:16,lineHeight:1}}>{roomCode}</div>
                        <Btn full onClick={handleCopyLink} style={{marginBottom:10}}>{copied?"✓ Copied!":"Copy Invite Link"}</Btn>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:10,color:"var(--gray2)",letterSpacing:1,marginBottom:16}}>stronnger.netlify.app/join/{roomCode}</div>
                        <div style={{display:"flex",alignItems:"center",gap:8,justifyContent:"center"}}>
                          <div style={{width:8,height:8,borderRadius:99,background:"var(--lime)",animation:"pulse 1.5s infinite"}}/>
                          <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>WAITING FOR PARTNER...</span>
                        </div>
                      </>
                    ) : (
                      <Btn full onClick={handleInvite}>Generate My Room Code</Btn>
                    )}
                  </div>
                  <div className="fu1" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:12}}>JOIN A PARTNER</div>
                    <div style={{display:"flex",gap:8}}>
                      <input
                        value={joinInput}
                        onChange={e=>{setJoinInput(e.target.value.toUpperCase());setJoinError("");}}
                        placeholder="STR-XXXX"
                        style={{flex:1,background:"var(--dark)",border:"1.5px solid var(--line2)",borderRadius:10,padding:"12px 14px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:16,letterSpacing:2,color:"var(--white)",outline:"none"}}
                      />
                      <button onClick={handleJoin} style={{background:"var(--lime)",border:"none",borderRadius:10,padding:"12px 18px",fontFamily:"var(--font-cond)",fontWeight:900,fontSize:13,letterSpacing:2,color:"var(--black)",cursor:"pointer"}}>JOIN</button>
                    </div>
                    {joinError && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginTop:8}}>{joinError}</div>}
                  </div>
                </>
              ) : (
                <>
                  <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",overflow:"hidden"}}>
                    <div style={{padding:"20px 20px 0",display:"flex",alignItems:"center",gap:14}}>
                      <div style={{width:52,height:52,borderRadius:99,background:"var(--lime)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-display)",fontSize:24,color:"var(--black)"}}>{(partnerProfile.name||"?").slice(0,2).toUpperCase()}</div>
                      <div>
                        <div style={{fontFamily:"var(--font-display)",fontSize:28}}>{(partnerProfile.name||"PARTNER").toUpperCase()}</div>
                        <div style={{display:"flex",alignItems:"center",gap:6}}>
                          <div style={{width:7,height:7,borderRadius:99,background:"#30d158",animation:"pulse 2s infinite"}}/>
                          <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"#30d158"}}>CONNECTED</span>
                        </div>
                      </div>
                    </div>
                    <div style={{margin:"16px 20px 20px",background:"var(--black)",borderRadius:12,padding:16}}>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"var(--gray)",marginBottom:6}}>PARTNER PROFILE</div>
                      <div style={{fontFamily:"var(--font-display)",fontSize:22}}>{(partnerProfile.goal||"—").toUpperCase()}</div>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:12,color:"var(--gray)",marginTop:4}}>
                        {partnerProfile.level?.toUpperCase()||"—"} · {partnerProfile.weight?`${partnerProfile.weight}KG`:"—"}
                      </div>
                    </div>
                  </div>
                  <div className="fu1" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>MESSAGES</div>
                    <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
                      {messages.map((m,i)=>{
                        const isMe = m.slot ? m.slot===userSlot : m.from==="me";
                        return (
                          <div key={i} style={{alignSelf:isMe?"flex-end":"flex-start",background:isMe?"var(--lime)":"var(--dark)",borderRadius:isMe?"14px 4px 14px 14px":"4px 14px 14px 14px",padding:"10px 14px",maxWidth:"78%"}}>
                            <div style={{fontFamily:"var(--font-body)",fontSize:14,color:isMe?"var(--black)":"var(--white)"}}>{m.text}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                      {["✅ Done!","❓ Form check?","💪 Let's go!","⏸️ Break","🏁 Almost!"].map(t=>(
                        <button key={t} onClick={async ()=>{
                          const newMsg = {slot:userSlot,text:t,ts:Date.now()};
                          const updated = [...messages, newMsg];
                          setMessages(updated);
                          if (roomCode) await supabase.from("rooms").update({messages:updated}).eq("room_code",roomCode);
                        }} style={{background:"var(--dark)",border:"1px solid var(--line)",borderRadius:99,padding:"8px 14px",fontFamily:"var(--font-body)",fontSize:12,color:"var(--white)",cursor:"pointer"}}>{t}</button>
                      ))}
                    </div>
                  </div>
                  <div className="fu2" style={{background:"var(--lime)",borderRadius:18,padding:20}}>
                    <div style={{fontFamily:"var(--font-display)",fontSize:34,color:"var(--black)",lineHeight:0.9,marginBottom:8}}>JOINT<br/>TRAINING</div>
                    <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"rgba(0,0,0,.6)",marginBottom:16}}>Same exercises. Your weights. Synced.</div>
                    <button onClick={()=>{setDayIdx(0);setExIdx(0);setSetNum(1);workoutStartRef.current=null;setScreen("workout");}} style={{background:"var(--black)",border:"none",borderRadius:12,padding:"13px 22px",fontFamily:"var(--font-cond)",fontWeight:800,fontSize:13,letterSpacing:3,color:"var(--lime)",cursor:"pointer"}}>START SESSION</button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* PROGRESS */}
          {tab==="progress" && (
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,display:"flex",gap:14,alignItems:"flex-start"}}>
                <div style={{fontSize:26,flexShrink:0}}>🔒</div>
                <div>
                  <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:1,marginBottom:4}}>PRIVATE BY DESIGN</div>
                  <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",lineHeight:1.6}}>Photos on-device only. No cloud. No AI. Yours forever.</div>
                </div>
              </div>

              {/* Workout history */}
              {workoutHistory.length>0 ? (
                <div className="fu1" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>RECENT WORKOUTS</div>
                  {workoutHistory.slice(0,5).map((h,i)=>(
                    <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 0",borderBottom:i<Math.min(workoutHistory.length,5)-1?"1px solid var(--line)":"none"}}>
                      <div style={{display:"flex",alignItems:"center",gap:12}}>
                        <div style={{width:40,height:40,borderRadius:10,background:"var(--dark)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>
                          {["🏋️","💪","🦵","🔄","🏃","🧘"][i%6]}
                        </div>
                        <div>
                          <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:14}}>{h.dayName}</div>
                          <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{h.date} · {h.totalSets} sets</div>
                        </div>
                      </div>
                      <div style={{fontFamily:"var(--font-display)",fontSize:20,color:"var(--lime)"}}>{h.duration}m</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="fu1" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:28,textAlign:"center"}}>
                  <div style={{fontSize:40,marginBottom:12}}>📊</div>
                  <div style={{fontFamily:"var(--font-display)",fontSize:28,marginBottom:8}}>NO WORKOUTS YET</div>
                  <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6}}>Complete your first workout to see history here.</p>
                </div>
              )}

              <div className="fu2" style={{display:"flex",gap:10}}>
                {[["BEFORE","#FF9F0A"],["AFTER","var(--lime)"]].map(([l,c])=>(
                  <div key={l} style={{flex:1,background:"var(--card)",borderRadius:18,border:`1px dashed ${c}55`,padding:24,textAlign:"center",cursor:"pointer"}}>
                    <div style={{fontSize:30,marginBottom:8}}>📷</div>
                    <div style={{fontFamily:"var(--font-display)",fontSize:22,color:c}}>{l}</div>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,color:"var(--gray)",letterSpacing:1,marginTop:4}}>TAP TO ADD</div>
                  </div>
                ))}
              </div>

              {workoutHistory.length>0 && (
                <div className="fu3" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>WORKOUTS THIS MONTH</div>
                  <div style={{display:"flex",alignItems:"flex-end",gap:6,height:80}}>
                    {workoutHistory.slice(0,7).reverse().map((h,i,arr)=>{
                      const maxDur = Math.max(...arr.map(x=>x.duration));
                      return (
                        <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                          <div style={{width:"100%",height:`${Math.max(8,(h.duration/maxDur)*70)}px`,background:i===arr.length-1?"var(--lime)":"#2a2a2a",borderRadius:"4px 4px 0 0"}}/>
                          <div style={{fontFamily:"var(--font-cond)",fontSize:9,color:i===arr.length-1?"var(--lime)":"var(--gray2)",letterSpacing:1}}>{h.date.split(" ")[1]||h.date}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom nav — safe area aware */}
        <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"rgba(8,8,8,.94)",backdropFilter:"blur(20px)",borderTop:"1px solid var(--line)",display:"flex",paddingBottom:"env(safe-area-inset-bottom)"}}>
          {[["today","TODAY"],["routine","ROUTINE"],["partner","PARTNER"],["progress","PROGRESS"]].map(([k,l])=>(
            <button key={k} onClick={()=>setTab(k)} className="nav-btn" style={{color:tab===k?"var(--white)":"var(--gray2)"}}>
              {l}
              {tab===k && <div style={{width:20,height:2,background:"var(--lime)",borderRadius:99,margin:"4px auto 0"}}/>}
            </button>
          ))}
        </div>

        {/* Toast notification */}
        {toast && (
          <div style={{position:"fixed",bottom:90,left:"50%",transform:"translateX(-50%)",width:"calc(100% - 44px)",maxWidth:386,background:"#222",borderRadius:14,padding:"14px 18px",zIndex:100,boxShadow:"0 4px 24px rgba(0,0,0,.5)",border:"1px solid var(--line)"}}>
            <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--white)",lineHeight:1.5}}>{toast}</div>
          </div>
        )}

        {/* Conflict modal — tapped a different day while session active */}
        {conflictPendingDayIdx !== null && (
          <div onClick={()=>setConflictPendingDayIdx(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,backdropFilter:"blur(4px)"}}>
            <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#181818",borderRadius:"24px 24px 0 0",padding:28,animation:"slideIn .3s cubic-bezier(.4,0,.2,1)"}}>
              <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:8}}>ACTIVE SESSION</div>
              <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>
                You have an unfinished <strong style={{color:"var(--white)"}}>{(routine?.[activeSession?.dayIdx]?.name||"workout").toUpperCase()}</strong>. What do you want to do?
              </p>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <Btn full onClick={resumeWorkout}>Resume Current Session</Btn>
                <Btn variant="red-soft" full onClick={()=>{ endWorkoutNow(); startWorkout(conflictPendingDayIdx); }}>End It &amp; Start New</Btn>
                <Btn variant="ghost" full onClick={()=>setConflictPendingDayIdx(null)}>Cancel</Btn>
              </div>
            </div>
          </div>
        )}

        {/* Logout modal */}
        {showLogout && (
          <div onClick={()=>setShowLogout(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,backdropFilter:"blur(4px)"}}>
            <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#181818",borderRadius:"24px 24px 0 0",padding:28,animation:"slideIn .3s cubic-bezier(.4,0,.2,1)"}}>
              <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:8}}>SIGN OUT</div>
              <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>
                Your routine and partner connection are saved in this browser.
              </p>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {/* Regular logout: return to splash, keep all data so PIN login still works */}
                <Btn full onClick={()=>{setShowLogout(false);setScreen("splash");}}>Log Out</Btn>
                {/* Full erase: clear everything and restart from scratch */}
                <Btn variant="red-soft" full onClick={()=>{
                  localStorage.clear();
                  setProfile(null); setPinHash(null); setRoutine(null); setAiSummary(""); setWorkoutHistory([]); setMessages([]);
                  setNewPIN(""); setConfirmPin("");
                  setRoomCode(""); setRoomRole(""); setPartnerProfile(null); setWaitingForPartner(false);
                  setShowLogout(false); setScreen("splash");
                }}>Log Out &amp; Erase Everything</Btn>
                <Btn variant="ghost" full onClick={()=>setShowLogout(false)}>Cancel</Btn>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
