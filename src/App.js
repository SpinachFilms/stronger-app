import React, { useState, useEffect, useRef } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";

/* ─── Utilities ─── */
const hashPIN = async (pin) => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
};

/* ─── AES-GCM encryption helpers for sensitive localStorage data ─── */
const hexToBuffer = (hex) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
};
const bufferToHex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");

const encryptData = async (data, key) => {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    const cryptoKey = await crypto.subtle.importKey("raw", hexToBuffer(key.slice(0, 32)), { name: "AES-GCM" }, false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoded);
    return { iv: bufferToHex(iv), data: bufferToHex(encrypted) };
  } catch { return data; }
};

const decryptData = async (encryptedObj, key) => {
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", hexToBuffer(key.slice(0, 32)), { name: "AES-GCM" }, false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBuffer(encryptedObj.iv) }, cryptoKey, hexToBuffer(encryptedObj.data));
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch { return null; }
};

// Device encryption key — stored alongside encrypted data; protects against
// partial localStorage leaks (e.g. only one key being exfiltrated).
// Trade-off: does not protect against full localStorage dump by malicious code.
// Photos (str_photo_*) are NOT encrypted — they are large base64 blobs and
// encrypting them would be prohibitively slow. They remain local-only by design.
const getDeviceKey = () => {
  try {
    let key = localStorage.getItem("str_enc_key");
    if (!key) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      key = bufferToHex(bytes);
      localStorage.setItem("str_enc_key", key);
    }
    return key;
  } catch { return null; }
};

/* ─── Input sanitizer — strips special chars before Supabase queries ─── */
const sanitize = (str) => String(str || "").replace(/[^a-zA-Z0-9\s\-_]/g, "").slice(0, 100);

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

/* ─── Exercise DB for equipment filtering ─── */
const EXERCISE_DB = {
  "Barbell Bench Press":    { equipment: ["barbell"], muscles: ["chest"] },
  "Incline DB Press":       { equipment: ["dumbbells"], muscles: ["chest"] },
  "Overhead Press":         { equipment: ["barbell"], muscles: ["shoulders"] },
  "Lateral Raise":          { equipment: ["dumbbells"], muscles: ["shoulders"] },
  "Tricep Pushdown":        { equipment: ["cables"], muscles: ["triceps"] },
  "Deadlift":               { equipment: ["barbell"], muscles: ["back","hamstrings"] },
  "Pull-Ups":               { equipment: ["bodyweight"], muscles: ["back"] },
  "Seated Cable Row":       { equipment: ["cables"], muscles: ["back"] },
  "Barbell Curl":           { equipment: ["barbell"], muscles: ["biceps"] },
  "Face Pull":              { equipment: ["cables"], muscles: ["shoulders"] },
  "Back Squat":             { equipment: ["barbell"], muscles: ["quads"] },
  "Romanian Deadlift":      { equipment: ["barbell"], muscles: ["hamstrings","glutes"] },
  "Leg Press":              { equipment: ["machine"], muscles: ["quads"] },
  "Leg Curl":               { equipment: ["machine"], muscles: ["hamstrings"] },
  "Calf Raise":             { equipment: ["machine"], muscles: ["calves"] },
  "EZ Bar Curl":            { equipment: ["barbell"], muscles: ["biceps"] },
  "Skull Crushers":         { equipment: ["barbell"], muscles: ["triceps"] },
  "Hammer Curl":            { equipment: ["dumbbells"], muscles: ["biceps"] },
  "Cable Crunch":           { equipment: ["cables"], muscles: ["core"] },
  "DB Bench Press":         { equipment: ["dumbbells"], muscles: ["chest"] },
  "Bent-Over Row":          { equipment: ["barbell"], muscles: ["back"] },
  "DB Shoulder Press":      { equipment: ["dumbbells"], muscles: ["shoulders"] },
  "Front Squat":            { equipment: ["barbell"], muscles: ["quads"] },
  "Hip Thrust":             { equipment: ["barbell"], muscles: ["glutes"] },
  "Walking Lunges":         { equipment: ["dumbbells"], muscles: ["quads","glutes"] },
  "Plank":                  { equipment: ["bodyweight"], muscles: ["core"] },
  "Push-Ups":               { equipment: ["bodyweight"], muscles: ["chest"] },
  "Dumbbell Press":         { equipment: ["dumbbells"], muscles: ["chest"] },
  "Goblet Squat":           { equipment: ["dumbbells"], muscles: ["quads"] },
  "Bulgarian Split Squat":  { equipment: ["dumbbells"], muscles: ["glutes","quads"] },
  "Cable Fly":              { equipment: ["cables"], muscles: ["chest"] },
  "Foam Rolling":           { equipment: ["bodyweight"], muscles: ["recovery"] },
  "Hip Flexor Stretch":     { equipment: ["bodyweight"], muscles: ["recovery"] },
  "Dead Bug":               { equipment: ["bodyweight"], muscles: ["core"] },
  "Band Pull-Apart":        { equipment: ["bands"], muscles: ["shoulders"] },
};

const equipmentAllowed = (exerciseName, userEquipment) => {
  if (!userEquipment || userEquipment.length === 0) return true;
  if (userEquipment.includes("Full gym")) return true;
  const db = EXERCISE_DB[exerciseName];
  if (!db) return true;
  const eq = db.equipment[0];
  if (eq === "bodyweight") return true;
  if (eq === "barbell" && (userEquipment.includes("Barbell + rack") || userEquipment.includes("Full gym"))) return true;
  if (eq === "dumbbells" && (userEquipment.includes("Dumbbells only") || userEquipment.includes("Full gym"))) return true;
  if (eq === "cables" && (userEquipment.includes("Cables") || userEquipment.includes("Full gym"))) return true;
  if (eq === "machine" && (userEquipment.includes("Machines") || userEquipment.includes("Full gym"))) return true;
  if (eq === "bands" && (userEquipment.includes("Resistance bands") || userEquipment.includes("Full gym"))) return true;
  return false;
};

/* ─── Alternatives DB for exercise swap ─── */
const ALTERNATIVES_DB = {
  "Barbell Bench Press": ["Dumbbell Press","Push-Ups","Cable Chest Press"],
  "Incline DB Press": ["Incline Barbell Press","Cable Flyes","Machine Press"],
  "Overhead Press": ["DB Shoulder Press","Arnold Press","Machine Shoulder Press"],
  "Lateral Raise": ["Cable Lateral Raise","Machine Lateral Raise","Upright Row"],
  "Tricep Pushdown": ["Skull Crushers","Diamond Push-Ups","Overhead Tricep Extension"],
  "Deadlift": ["Romanian Deadlift","Trap Bar Deadlift","Good Mornings"],
  "Pull-Ups": ["Lat Pulldown","Assisted Pull-Ups","Band Pull-Ups"],
  "Seated Cable Row": ["DB Row","T-Bar Row","Machine Row"],
  "Barbell Curl": ["Dumbbell Curl","Cable Curl","Preacher Curl"],
  "Face Pull": ["Band Pull-Apart","Rear Delt Fly","Cable Rear Delt"],
  "Back Squat": ["Goblet Squat","Leg Press","Bulgarian Split Squat"],
  "Romanian Deadlift": ["Leg Curl","Good Mornings","Nordic Curl"],
  "Leg Press": ["Hack Squat","Belt Squat","Front Squat"],
  "Leg Curl": ["Romanian Deadlift","Nordic Curl","Good Mornings"],
  "Calf Raise": ["Seated Calf Raise","Single-Leg Calf Raise","Jump Rope"],
  "Hip Thrust": ["Glute Bridge","Cable Kickback","Bulgarian Split Squat"],
  "Walking Lunges": ["Reverse Lunges","Step-Ups","Split Squat"],
};

/* ─── Recovery tips for rest days ─── */
const RECOVERY_TIPS = [
  "Get 7–9 hours of sleep tonight — it's when your muscles actually grow.",
  "Drink at least 2–3L of water today. Hydration speeds up recovery.",
  "Eat enough protein (1.6–2.2g per kg bodyweight) even on rest days.",
  "A 10-minute walk improves blood flow and reduces soreness.",
  "Foam rolling for 5 minutes reduces muscle stiffness.",
  "Your muscles grow on rest days, not during training. Rest is training.",
  "Avoid alcohol — it significantly impairs muscle protein synthesis.",
  "Stretch your hip flexors for 2 minutes each side if you sit a lot.",
  "Magnesium before bed can improve sleep quality and recovery.",
  "Light activity (yoga, walking) is better than complete inactivity.",
];

/* ─── Routine builder (2–6 days) ─── */
const buildRoutine = (profile, partnerProfile = null) => {
  const level = profile.level || "intermediate";
  const days  = parseInt(profile.daysPerWeek) || 3;
  const yw    = parseInt(profile.weight) || 80;
  const pw    = partnerProfile?.weight ? parseInt(partnerProfile.weight) : null;
  const wA    = (m) => `${Math.round(yw * m)}kg`;
  const wB    = (m) => pw ? `${Math.round(pw * m)}kg` : "— kg";
  const beg   = level === "beginner";
  const equip = profile.equipment || [];
  const splitPref = profile.splitPreference || "Balanced";
  const prioMuscles = profile.priorityMuscles || [];
  const trainingDays = profile.trainingDays || null;

  const filterEx = (exercises) => exercises.filter(e => equipmentAllowed(e.name, equip));

  // Day label helper
  const dayLabel = (idx) => trainingDays && trainingDays[idx] ? trainingDays[idx] : `DAY ${idx + 1}`;

  // Priority muscle adjustments
  const prioritizeGlutesHams = prioMuscles.includes("Glutes") || prioMuscles.includes("Hamstrings");
  const prioritizeChestShoulders = prioMuscles.includes("Chest") || prioMuscles.includes("Shoulders");

  const PUSH_EXERCISES_BASE = [
    { name: "Barbell Bench Press", muscles: "CHEST",        sets: beg?3:4, reps: beg?"8–10":"6–8",  rest:90,  wA:wA(0.70), wB:wB(0.70), rpe:7 },
    { name: "Incline DB Press",    muscles: "UPPER CHEST",  sets: 3,       reps: "10–12",            rest:75,  wA:wA(0.35), wB:wB(0.35), rpe:7 },
    { name: "Overhead Press",      muscles: "SHOULDERS",    sets: 3,       reps: "8–10",             rest:75,  wA:wA(0.63), wB:wB(0.63), rpe:7 },
    { name: "Lateral Raise",       muscles: "SIDE DELT",    sets: 3,       reps: "15–20",            rest:45,  wA:wA(0.15), wB:wB(0.15), rpe:6 },
    { name: "Tricep Pushdown",     muscles: "TRICEPS",      sets: 3,       reps: "12–15",            rest:60,  wA:wA(0.44), wB:wB(0.44), rpe:6 },
    ...(prioritizeChestShoulders ? [{ name: "Cable Fly", muscles: "CHEST", sets: 3, reps: "12–15", rest:60, wA:wA(0.30), wB:wB(0.30), rpe:6 }] : []),
  ];

  const LEGS_EXERCISES_BASE = (() => {
    const priorityEx = prioritizeGlutesHams ? [
      { name: "Hip Thrust",           muscles: "GLUTES",     sets: 4, reps: "10–12",  rest:75,  wA:wA(1.10), wB:wB(1.10), rpe:7 },
      { name: "Romanian Deadlift",    muscles: "HAMSTRINGS", sets: 3, reps: "10–12",  rest:90,  wA:wA(0.94), wB:wB(0.94), rpe:7 },
      { name: "Bulgarian Split Squat",muscles: "GLUTES/QUADS",sets:3, reps: "10–12",  rest:75,  wA:wA(0.25), wB:wB(0.25), rpe:7 },
    ] : [];
    const standardEx = [
      { name: "Back Squat",        muscles: "QUADS",      sets: beg?3:4, reps: beg?"8–10":"6–8", rest:120, wA:wA(0.90), wB:wB(0.90), rpe:8 },
      { name: "Romanian Deadlift", muscles: "HAMSTRINGS", sets: 3,       reps: "10–12",          rest:90,  wA:wA(0.94), wB:wB(0.94), rpe:7 },
      { name: "Leg Press",         muscles: "QUADS",      sets: 3,       reps: "12–15",          rest:75,  wA:wA(1.75), wB:wB(1.75), rpe:7 },
      { name: "Leg Curl",          muscles: "HAMSTRINGS", sets: 3,       reps: "12–15",          rest:60,  wA:wA(0.50), wB:wB(0.50), rpe:6 },
      { name: "Calf Raise",        muscles: "CALVES",     sets: 3,       reps: "15–20",          rest:45,  wA:wA(1.00), wB:wB(1.00), rpe:6 },
    ];
    return prioritizeGlutesHams ? [...priorityEx, ...standardEx.filter(e => e.name !== "Romanian Deadlift")] : standardEx;
  })();

  const PUSH = {
    label: dayLabel(0), name: "Push Day", tag: "CHEST · SHOULDERS · TRIS", color: "#C8F135",
    exercises: filterEx(PUSH_EXERCISES_BASE),
  };
  const PULL = {
    label: dayLabel(1), name: "Pull Day", tag: "BACK · BICEPS · REAR DELT", color: "#0A84FF",
    exercises: filterEx([
      { name: "Deadlift",         muscles: "POSTERIOR CHAIN", sets: beg?3:4, reps: beg?"6–8":"5–6", rest:120, wA:wA(1.10), wB:wB(1.10), rpe:8 },
      { name: "Pull-Ups",         muscles: "LATS",            sets: 3,       reps: "6–10",           rest:90,  wA:"BW",     wB:"BW",     rpe:7 },
      { name: "Seated Cable Row", muscles: "MID BACK",        sets: 3,       reps: "10–12",          rest:75,  wA:wA(0.69), wB:wB(0.69), rpe:7 },
      { name: "Barbell Curl",     muscles: "BICEPS",          sets: 3,       reps: "10–12",          rest:60,  wA:wA(0.38), wB:wB(0.38), rpe:6 },
      { name: "Face Pull",        muscles: "REAR DELT",       sets: 3,       reps: "15–20",          rest:45,  wA:wA(0.30), wB:wB(0.30), rpe:6 },
    ]),
  };
  const LEGS = {
    label: dayLabel(2), name: "Leg Day", tag: "QUADS · HAMSTRINGS · GLUTES", color: "#FF9F0A",
    exercises: filterEx(LEGS_EXERCISES_BASE),
  };
  const ARMS = {
    label: dayLabel(3), name: "Arms & Core", tag: "BICEPS · TRICEPS · ABS", color: "#BF5AF2",
    exercises: filterEx([
      { name: "EZ Bar Curl",    muscles: "BICEPS",     sets: 4, reps: "10–12", rest:60, wA:wA(0.35), wB:wB(0.35), rpe:7 },
      { name: "Skull Crushers", muscles: "TRICEPS",    sets: 4, reps: "10–12", rest:60, wA:wA(0.30), wB:wB(0.30), rpe:7 },
      { name: "Hammer Curl",    muscles: "BRACHIALIS", sets: 3, reps: "12–15", rest:45, wA:wA(0.20), wB:wB(0.20), rpe:6 },
      { name: "Cable Crunch",   muscles: "ABS",        sets: 3, reps: "15–20", rest:45, wA:wA(0.44), wB:wB(0.44), rpe:6 },
    ]),
  };
  const UPPER = {
    label: dayLabel(3), name: "Upper Body", tag: "CHEST · BACK · SHOULDERS", color: "#FF375F",
    exercises: filterEx([
      { name: "DB Bench Press",      muscles: "CHEST",     sets: 3, reps: "10–12", rest:75, wA:wA(0.40), wB:wB(0.40), rpe:7 },
      { name: "Bent-Over Row",       muscles: "BACK",      sets: 3, reps: "10–12", rest:75, wA:wA(0.75), wB:wB(0.75), rpe:7 },
      { name: "DB Shoulder Press",   muscles: "SHOULDERS", sets: 3, reps: "10–12", rest:60, wA:wA(0.28), wB:wB(0.28), rpe:7 },
      { name: "Tricep Pushdown",     muscles: "TRICEPS",   sets: 3, reps: "12–15", rest:45, wA:wA(0.40), wB:wB(0.40), rpe:6 },
    ]),
  };
  const LOWER2 = {
    label: dayLabel(4), name: "Lower Focus", tag: "QUADS · GLUTES · CORE", color: "#FF9F0A",
    exercises: filterEx([
      { name: "Front Squat",     muscles: "QUADS",  sets: 3, reps: "8–10",  rest:90, wA:wA(0.75), wB:wB(0.75), rpe:7 },
      { name: "Hip Thrust",      muscles: "GLUTES", sets: 4, reps: "10–12", rest:75, wA:wA(1.10), wB:wB(1.10), rpe:7 },
      { name: "Walking Lunges",  muscles: "QUADS",  sets: 3, reps: "12–14", rest:60, wA:wA(0.25), wB:wB(0.25), rpe:6 },
      { name: "Plank",           muscles: "CORE",   sets: 3, reps: "45–60s",rest:45, wA:"BW",     wB:"BW",     rpe:5 },
    ]),
  };
  const ACTIVE = {
    label: dayLabel(5), name: "Active Recovery", tag: "MOBILITY · CORE · STRETCH", color: "#30d158",
    exercises: filterEx([
      { name: "Foam Rolling",        muscles: "FULL BODY", sets: 1, reps: "5–10 min", rest:0,  wA:"BW", wB:"BW", rpe:3 },
      { name: "Hip Flexor Stretch",  muscles: "HIPS",      sets: 3, reps: "30–45s",   rest:30, wA:"BW", wB:"BW", rpe:3 },
      { name: "Dead Bug",            muscles: "CORE",      sets: 3, reps: "10–12",    rest:30, wA:"BW", wB:"BW", rpe:4 },
      { name: "Band Pull-Apart",     muscles: "REAR DELT", sets: 3, reps: "20–25",    rest:30, wA:"BW", wB:"BW", rpe:4 },
    ]),
  };

  // Full Body days for "Full body" split preference or 2-day routines
  const FULL_A = {
    label: dayLabel(0), name: "Full Body A", tag: "SQUAT · PRESS · ROW", color: "#C8F135",
    exercises: filterEx([
      { name: "Back Squat",          muscles: "QUADS",     sets: beg?3:4, reps:"8–10", rest:90,  wA:wA(0.80), wB:wB(0.80), rpe:7 },
      { name: "Barbell Bench Press", muscles: "CHEST",     sets: 3,       reps:"8–10", rest:75,  wA:wA(0.65), wB:wB(0.65), rpe:7 },
      { name: "Bent-Over Row",       muscles: "BACK",      sets: 3,       reps:"8–10", rest:75,  wA:wA(0.65), wB:wB(0.65), rpe:7 },
      { name: "Overhead Press",      muscles: "SHOULDERS", sets: 3,       reps:"8–10", rest:60,  wA:wA(0.55), wB:wB(0.55), rpe:7 },
      { name: "Plank",               muscles: "CORE",      sets: 2,       reps:"45s",  rest:45,  wA:"BW",     wB:"BW",     rpe:5 },
    ]),
  };
  const FULL_B = {
    label: dayLabel(1), name: "Full Body B", tag: "HINGE · PRESS · PULL", color: "#0A84FF",
    exercises: filterEx([
      { name: "Deadlift",        muscles: "POSTERIOR CHAIN", sets: beg?3:4, reps:"6–8",  rest:120, wA:wA(1.00), wB:wB(1.00), rpe:8 },
      { name: "Incline DB Press",muscles: "UPPER CHEST",     sets: 3,       reps:"10–12",rest:75,  wA:wA(0.32), wB:wB(0.32), rpe:7 },
      { name: "Pull-Ups",        muscles: "LATS",             sets: 3,       reps:"6–8",  rest:75,  wA:"BW",     wB:"BW",     rpe:7 },
      { name: "Goblet Squat",    muscles: "QUADS",            sets: 3,       reps:"12–15",rest:60,  wA:wA(0.30), wB:wB(0.30), rpe:6 },
      { name: "Tricep Pushdown", muscles: "TRICEPS",          sets: 3,       reps:"12–15",rest:45,  wA:wA(0.40), wB:wB(0.40), rpe:6 },
    ]),
  };

  // Full body split generates FULL_A/FULL_B alternating
  if (splitPref === "Full body") {
    const fbDays = [];
    for (let i = 0; i < days; i++) {
      const base = i % 2 === 0 ? { ...FULL_A } : { ...FULL_B };
      fbDays.push({ ...base, label: dayLabel(i) });
    }
    return fbDays;
  }

  // "More lower body" split
  if (splitPref === "More lower body") {
    const LOWER2_relabeled = { ...LOWER2, label: dayLabel(3) };
    if (days === 4) return [PUSH, PULL, LEGS, LOWER2_relabeled];
    if (days === 5) return [PUSH, PULL, LEGS, LOWER2_relabeled, { ...ACTIVE, label: dayLabel(4) }];
  }

  // "More upper body" split
  if (splitPref === "More upper body") {
    if (days === 4) return [PUSH, PULL, { ...UPPER, label: dayLabel(2) }, { ...ARMS, label: dayLabel(3) }];
  }

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
    .chip:active { transform: scale(0.95); }
    button:active { transform: scale(0.98); }
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

const Input = ({ label, placeholder, value, onChange, type="text", unit, maxLength, autoComplete }) => (
  <div style={{marginBottom:18}}>
    {label && <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>{label}</div>}
    <div style={{position:"relative"}}>
      <input
        type={type} value={value} onChange={e=>onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
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
   ERROR BOUNDARY — catches React render errors gracefully
════════════════════════════════════════════ */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ background: "#080808", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center" }}>
          <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 52, color: "#FAFAFA", marginBottom: 16, lineHeight: 0.9 }}>SOMETHING<br />WENT WRONG</div>
          <p style={{ fontFamily: "'Barlow',sans-serif", fontSize: 15, color: "#888", lineHeight: 1.6, marginBottom: 28 }}>An unexpected error occurred. Your data is safe.</p>
          <button onClick={() => { this.setState({ hasError: false }); window.location.reload(); }} style={{ background: "#C8F135", border: "none", borderRadius: 14, padding: "16px 32px", fontFamily: "'Barlow Condensed',sans-serif", fontWeight: 900, fontSize: 16, letterSpacing: 2.5, color: "#080808", cursor: "pointer" }}>RESTART APP</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ════════════════════════════════════════════
   FLOATING CHAT WINDOW (defined outside App so hooks are stable)
════════════════════════════════════════════ */
function ChatWindow({ partnerProfile, messages, userSlot, roomCode, setMessages }) {
  const [kbOffset, setKbOffset] = useState(0);
  const lastChatMsgRef = useRef(0); // rate limiting: 1 msg/sec
  useEffect(() => {
    if (!window.visualViewport) return;
    const onResize = () => {
      const hidden = window.innerHeight - window.visualViewport.height;
      setKbOffset(Math.max(0, hidden));
    };
    window.visualViewport.addEventListener("resize", onResize);
    return () => window.visualViewport.removeEventListener("resize", onResize);
  }, []);
  const sendMsg = async (text) => {
    const now = Date.now();
    if (now - lastChatMsgRef.current < 1000) return; // rate limit
    lastChatMsgRef.current = now;
    const newMsg = { slot: userSlot, text: String(text).slice(0, 200), ts: now };
    // Cap message history at 500, trim oldest 50 when full
    const base = messages.length >= 500 ? messages.slice(50) : messages;
    const updated = [...base, newMsg];
    setMessages(updated);
    if (roomCode && supabase) await supabase.from("rooms").update({ messages: updated }).eq("room_code", roomCode).catch(() => {});
  };
  return (
    <div style={{position:"fixed",bottom:82+kbOffset,right:"calc(50% - 215px + 16px)",width:300,background:"#181818",borderRadius:18,border:"1px solid var(--line)",boxShadow:"0 8px 40px rgba(0,0,0,.6)",zIndex:59,display:"flex",flexDirection:"column",maxHeight:340,overflow:"hidden"}}>
      <div style={{padding:"12px 14px 8px",borderBottom:"1px solid var(--line)",display:"flex",alignItems:"center",gap:8}}>
        <div style={{width:8,height:8,borderRadius:99,background:"#30d158",animation:"pulse 2s infinite"}}/>
        <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--white)"}}>{(partnerProfile.name||"PARTNER").toUpperCase()}</span>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"10px 12px",display:"flex",flexDirection:"column",gap:6}}>
        {messages.length === 0 && (
          <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",textAlign:"center",padding:"12px 0"}}>No messages yet</div>
        )}
        {messages.map((m,i)=>{
          const isMe = m.slot ? m.slot===userSlot : m.from==="me";
          return (
            <div key={i} style={{alignSelf:isMe?"flex-end":"flex-start",background:isMe?"var(--lime)":"var(--dark)",borderRadius:isMe?"12px 3px 12px 12px":"3px 12px 12px 12px",padding:"8px 12px",maxWidth:"85%"}}>
              <div style={{fontFamily:"var(--font-body)",fontSize:13,color:isMe?"var(--black)":"var(--white)"}}>{m.text}</div>
            </div>
          );
        })}
      </div>
      <div style={{padding:"8px 10px",borderTop:"1px solid var(--line)",display:"flex",flexWrap:"wrap",gap:6}}>
        {["Done!","Form check?","Let's go!","Break","Almost!","You got this!"].map(t=>(
          <button key={t} onClick={()=>sendMsg(t)} style={{background:"var(--dark)",border:"1px solid var(--line)",borderRadius:99,padding:"7px 12px",fontFamily:"var(--font-body)",fontSize:11,color:"var(--white)",cursor:"pointer"}}>{t}</button>
        ))}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════
   MAIN APP
════════════════════════════════════════════ */
function AppInner() {
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
  const [prs, setPrs]                     = useState(() => getSaved("str_prs", {}));
  const [weightLog, setWeightLog]         = useState(() => getSaved("str_weight_log", []));

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
  // Invite-link deep link state
  const [joinCodeFromUrl, setJoinCodeFromUrl]   = useState("");
  const [joinCodePartnerName, setJoinCodePartnerName] = useState("");
  // Pending room join after auth (ref so it survives async flows)
  const postAuthJoinCode = useRef("");

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

  // Chat / messaging UI
  const [chatOpen, setChatOpen]           = useState(false);
  const [chatLastOpenedAt, setChatLastOpenedAt] = useState(() => Date.now());
  const [partnerElapsedSecs, setPartnerElapsedSecs] = useState(0);

  // Feature 2 — Goal conflict card
  const [goalConflict, setGoalConflict] = useState(null);
  const [goalConflictTimer, setGoalConflictTimer] = useState(null);

  // Feature 4A — PR notification
  const [prNotification, setPrNotification] = useState(null);

  // Feature 4B — Exercise swap
  const [swapExercise, setSwapExercise] = useState(null);

  // Feature 4E — Workout notes
  const [workoutNote, setWorkoutNote] = useState("");

  // Feature 4F — Weight modal
  const [showWeightModal, setShowWeightModal] = useState(false);
  const [weightInput, setWeightInput] = useState("");

  // Settings screen
  const [settingsName, setSettingsName] = useState("");
  const [settingsWeight, setSettingsWeight] = useState("");
  const [settingsAge, setSettingsAge] = useState("");
  const [settingsHeight, setSettingsHeight] = useState("");
  const [settingsInjuries, setSettingsInjuries] = useState("");

  // PIN brute-force protection
  const [pinLockedUntil, setPinLockedUntil] = useState(null);
  const [pinLockouts, setPinLockouts] = useState(0);
  const [pinLockCountdown, setPinLockCountdown] = useState(0);

  // Change PIN flow (Settings)
  const [showChangePinFlow, setShowChangePinFlow] = useState(false);
  const [cpStep, setCpStep] = useState("verify"); // "verify" | "new" | "confirm"
  const [cpEntry, setCpEntry] = useState("");
  const [cpNew, setCpNew] = useState("");
  const [cpConfirm, setCpConfirm] = useState("");
  const [cpError, setCpError] = useState("");

  // Rebuild Routine modal
  const [showRebuildModal, setShowRebuildModal] = useState(false);
  const [rebuildDraft, setRebuildDraft] = useState(null);
  const [rebuildPreview, setRebuildPreview] = useState(null);
  const [showRebuildPreview, setShowRebuildPreview] = useState(false);
  const [rebuildConflict, setRebuildConflict] = useState(null);
  const [rebuildConflictTimer, setRebuildConflictTimer] = useState(null);
  const [rebuildSuccess, setRebuildSuccess] = useState(false);

  // Rate limiting for Supabase messages
  const lastMsgTimeRef = useRef(0);

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
    if (savedCode && profile && supabase) {
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
          subscribeToRoom(savedCode, savedSlot, profile);
        });
    }

    // 3. Ensure routine exists for returning users
    if (profile && !routine) setRoutine(buildRoutine(profile));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Decrypt sensitive localStorage data on mount (migration: raw → encrypted) ─── */
  useEffect(() => {
    (async () => {
      const key = getDeviceKey();
      if (!key) return;
      const tryDecrypt = async (raw) => {
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.iv && parsed?.data) return await decryptData(parsed, key);
          return parsed; // plain JSON (legacy / not yet encrypted)
        } catch { return null; }
      };
      const [decProfile, decRoutine, decSummary, decHistory] = await Promise.all([
        tryDecrypt(localStorage.getItem("str_profile")),
        tryDecrypt(localStorage.getItem("str_routine")),
        tryDecrypt(localStorage.getItem("str_summary")),
        tryDecrypt(localStorage.getItem("str_history")),
      ]);
      if (decProfile && typeof decProfile === "object" && !Array.isArray(decProfile)) setProfile(decProfile);
      if (decRoutine && Array.isArray(decRoutine)) setRoutine(decRoutine);
      if (typeof decSummary === "string" && decSummary) setAiSummary(decSummary);
      if (decHistory && Array.isArray(decHistory)) setWorkoutHistory(decHistory);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Deep-link: detect /join/CODE in URL on app load ─── */
  useEffect(() => {
    const path = window.location.pathname;
    const match = path.match(/\/join\/([A-Z0-9-]+)/);
    if (!match) return;
    const code = match[1];
    window.history.replaceState({}, '', '/');
    setJoinCodeFromUrl(code);
    setScreen('join_room');
    // Try to fetch partner name from Supabase
    if (supabase) {
      supabase.from("rooms").select("user_a").eq("room_code", code).single()
        .then(({ data }) => {
          if (data?.user_a?.name) setJoinCodePartnerName(data.user_a.name);
        })
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Auto-join room after auth if user came via invite link ─── */
  useEffect(() => {
    if (screen !== "home" || !postAuthJoinCode.current) return;
    const code = postAuthJoinCode.current;
    postAuthJoinCode.current = "";
    handleJoinWithCode(code);
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Persist state to localStorage — sensitive keys AES-GCM encrypted ─── */
  // Encrypted: str_profile, str_routine, str_summary, str_history
  // Plain: str_pin (hash only, not raw PIN), str_messages, str_prs, str_weight_log
  useEffect(() => {
    if (!profile) return;
    (async () => {
      const key = getDeviceKey();
      try {
        const enc = key ? await encryptData(profile, key) : profile;
        localStorage.setItem("str_profile", JSON.stringify(enc));
      } catch { localStorage.setItem("str_profile", JSON.stringify(profile)); }
    })();
  }, [profile]);
  useEffect(() => {
    if (!routine) return;
    (async () => {
      const key = getDeviceKey();
      try {
        const enc = key ? await encryptData(routine, key) : routine;
        localStorage.setItem("str_routine", JSON.stringify(enc));
      } catch { localStorage.setItem("str_routine", JSON.stringify(routine)); }
    })();
  }, [routine]);
  useEffect(() => {
    if (!aiSummary) return;
    (async () => {
      const key = getDeviceKey();
      try {
        const enc = key ? await encryptData(aiSummary, key) : aiSummary;
        localStorage.setItem("str_summary", JSON.stringify(enc));
      } catch { localStorage.setItem("str_summary", JSON.stringify(aiSummary)); }
    })();
  }, [aiSummary]);
  useEffect(() => { if (pinHash) localStorage.setItem("str_pin", JSON.stringify(pinHash)); }, [pinHash]);
  useEffect(() => {
    (async () => {
      const key = getDeviceKey();
      try {
        const enc = key ? await encryptData(workoutHistory, key) : workoutHistory;
        localStorage.setItem("str_history", JSON.stringify(enc));
      } catch { localStorage.setItem("str_history", JSON.stringify(workoutHistory)); }
    })();
  }, [workoutHistory]);
  useEffect(() => { localStorage.setItem("str_messages", JSON.stringify(messages)); }, [messages]);
  useEffect(() => { localStorage.setItem("str_prs", JSON.stringify(prs)); }, [prs]);
  useEffect(() => { localStorage.setItem("str_weight_log", JSON.stringify(weightLog)); }, [weightLog]);

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

  /* ─── PIN lockout countdown timer ─── */
  useEffect(() => {
    if (!pinLockedUntil) { setPinLockCountdown(0); return; }
    const update = () => {
      const remaining = Math.ceil((pinLockedUntil - Date.now()) / 1000);
      if (remaining <= 0) { setPinLockedUntil(null); setPinLockCountdown(0); setPinAttempts(0); }
      else setPinLockCountdown(remaining);
    };
    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [pinLockedUntil]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Partner training elapsed timer ─── */
  const partnerActiveSession = partnerProfile?._activeSession || null;
  useEffect(() => {
    if (!partnerActiveSession?.startedAt) { setPartnerElapsedSecs(0); return; }
    const tick = () => setPartnerElapsedSecs(Math.floor((Date.now() - partnerActiveSession.startedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [partnerActiveSession?.startedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Vibrate + unread count when new message arrives ─── */
  const unreadCount = messages.filter(m => {
    const isPartner = m.slot ? m.slot !== userSlot : m.from !== "me";
    return isPartner && m.ts > chatLastOpenedAt;
  }).length;
  useEffect(() => {
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    const isPartner = last.slot ? last.slot !== userSlot : last.from !== "me";
    if (isPartner && !chatOpen) {
      navigator.vibrate && navigator.vibrate(100);
    }
  }, [messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Sync active workout session to Supabase room on every set ─── */
  useEffect(() => {
    if (!roomCode || !supabase || !workoutStartRef.current || screen !== "workout") return;
    // Only sync after at least one set has been completed — don't fire on initial startWorkout
    if (Object.keys(completedSets).length === 0 && exIdx === 0 && setNum === 1) return;
    const curDay = routine?.[dayIdx];
    if (!curDay) return;
    const sessionData = {
      dayIdx, exIdx, setNum, completedSets,
      startedAt: workoutStartRef.current,
      exerciseName: curDay.exercises[exIdx]?.name || "",
      dayName: curDay.name,
      totalExercises: curDay.exercises.length,
      currentWeight: curDay.exercises[exIdx]?.wA || "",
      color: curDay.color,
    };
    const col = userSlot === "a" ? "user_a" : "user_b";
    try {
      supabase.from("rooms")
        .update({ [col]: { ...(profile || {}), _activeSession: sessionData } })
        .eq("room_code", roomCode)
        .catch(() => {});
    } catch {}
  }, [completedSets, exIdx, setNum]); // eslint-disable-line react-hooks/exhaustive-deps

  const startRest = (s) => { setRestMax(s); setRestSec(s); setResting(true); };
  const skipRest  = () => { clearInterval(timerRef.current); setResting(false); setRestSec(0); };

  const day         = routine?.[dayIdx];
  const ex          = day?.exercises[exIdx];
  const accentColor = day?.color || "var(--lime)";

  const completeSet = () => {
    const key = `${exIdx}-${setNum}`;
    setCompletedSets(prev => ({...prev, [key]:true}));

    // Feature 4A — Check for PR
    const currentWeight = parseFloat(ex.wA) || 0;
    const currentReps = parseInt((ex.reps||"8").split("–")[0]) || 8;
    const existingPR = prs[ex.name];
    if (currentWeight > 0 && (!existingPR || currentWeight > existingPR.weight)) {
      const newPRs = { ...prs, [ex.name]: { weight: currentWeight, reps: currentReps, date: new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"}) }};
      setPrs(newPRs);
      setPrNotification({ exerciseName: ex.name, weight: ex.wA });
      setTimeout(() => setPrNotification(null), 3000);
    }

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
      const totalVolume = Math.round(day.exercises.reduce((sum, e) => {
        const w = parseFloat(e.wA) || 0;
        const reps = parseInt((e.reps||"8").split("–")[0]) || 8;
        return sum + e.sets * reps * w;
      }, 0));
      const maxWeight = Math.max(...day.exercises.map(e => parseFloat(e.wA) || 0));
      const entry = {
        id: Date.now(),
        date: new Date().toLocaleDateString("en-US", {month:"short", day:"numeric"}),
        dayOfWeek: new Date().toLocaleDateString("en-US", {weekday:"short"}),
        dayName: day.name,
        totalSets,
        duration: durationMin,
        exercises: day.exercises.length,
        totalVolume,
        maxWeight,
        color: day.color,
        note: workoutNote || "",
      };
      setWorkoutHistory(prev => [entry, ...prev].slice(0, 20));
      setWorkoutNote("");
      // Clear active session in Supabase
      if (roomCode && supabase) {
        const col = userSlot === "a" ? "user_a" : "user_b";
        supabase.from("rooms")
          .update({ [col]: { ...profile, _activeSession: null, _lastWorkout: entry } })
          .eq("room_code", roomCode)
          .catch(() => {});
      }
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
            content:`Athlete: ${profile.name||"You"}, ${profile.age}y, ${profile.weight}kg, goal: ${profile.goal||"build muscle"}, level: ${profile.level||"intermediate"}, ${profile.daysPerWeek} days/week${resolvedPartner?`\nPartner: ${resolvedPartner.name||"Partner"}, ${resolvedPartner.weight}kg, goal: ${resolvedPartner.goal||"—"}, level: ${resolvedPartner.level||"—"}`:""}${profile.priorityMuscles?.length?`\nUser wants to prioritize: ${profile.priorityMuscles.join(', ')}. Split preference: ${profile.splitPreference||"Balanced"}.`:""}`,
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

  /* ─── Rebuild Routine modal helpers ─── */
  const openRebuildModal = () => {
    setRebuildDraft({ ...(profile || {}) });
    setRebuildPreview(null);
    setShowRebuildPreview(false);
    setRebuildConflict(null);
    setShowRebuildModal(true);
  };

  const computePreview = (draftProfile) => {
    const newR = buildRoutine(draftProfile, partnerProfile);
    const currentNames = new Set((routine || []).flatMap(d => d.exercises.map(e => e.name)));
    const newNames = new Set(newR.flatMap(d => d.exercises.map(e => e.name)));
    return {
      added: [...newNames].filter(n => !currentNames.has(n)),
      removed: [...currentNames].filter(n => !newNames.has(n)),
      unchanged: [...newNames].filter(n => currentNames.has(n)),
      newRoutine: newR,
    };
  };

  const handleRebuildConfirm = async () => {
    if (!rebuildDraft) return;
    if (activeSession?.isActive) endWorkoutNow();
    setProfile(prev => ({ ...prev, ...rebuildDraft }));
    const newRoutine = buildRoutine(rebuildDraft, partnerProfile);
    setRoutine(newRoutine);
    setShowRebuildModal(false);
    setShowRebuildPreview(false);
    setRebuildPreview(null);
    setRebuildDraft(null);
    setRebuildSuccess(true);
    setTimeout(() => setRebuildSuccess(false), 3000);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1000,
          system:"You are an elite strength coach. Write a 2-sentence routine summary. Be encouraging, specific. No markdown.",
          messages:[{role:"user",content:`Routine rebuilt for: ${rebuildDraft.name||"Athlete"}, goal: ${rebuildDraft.goal||"build muscle"}, level: ${rebuildDraft.level||"intermediate"}, ${rebuildDraft.daysPerWeek} days/week.${rebuildDraft.priorityMuscles?.length?` Focus: ${rebuildDraft.priorityMuscles.join(", ")}.`:""}`}],
        }),
      });
      const d = await r.json();
      const txt = d.content?.find(b=>b.type==="text")?.text;
      if (txt) setAiSummary(txt);
    } catch {}
  };

  const handleInvite = async () => {
    const code = genCode();
    if (!supabase) { setRoomCode(code); setWaitingForPartner(true); return; }
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
      setJoinError("Could not create room. Check your connection and try again.");
    }
  };

  const handleJoin = async () => {
    const code = sanitize(joinInput.trim().toUpperCase());
    if (!code) { setJoinError("Please enter a room code."); return; }
    if (!supabase) { setJoinError("Live sync is offline. Share codes manually — your partner enters your code in the Partner tab."); return; }
    try {
      const { data } = await supabase.from("rooms").select("*").eq("room_code", code).single();
      if (!data) { setJoinError("Code not found. Check the code and try again."); return; }
      if (data.user_b) { setJoinError("Room is full. Ask your partner for a new code."); return; }
      // Session hijacking prevention: generate a join token and embed it in user_b
      const joinToken = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
      localStorage.setItem("str_join_token", joinToken);
      await supabase.from("rooms").update({ user_b: { ...profile, _joinToken: joinToken } }).eq("room_code", code);
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

  const handleJoinWithCode = async (code) => {
    if (!code) return;
    if (!supabase) {
      setJoinInput(code);
      setTab("partner");
      return;
    }
    try {
      const { data } = await supabase.from("rooms").select("*").eq("room_code", code).single();
      if (!data) { setJoinError("Code not found. Check the code and try again."); setTab("partner"); return; }
      if (data.user_b) { setJoinError("Room is full. Ask your partner for a new code."); setTab("partner"); return; }
      const currentProfile = JSON.parse(localStorage.getItem("str_profile") || "null") || profile;
      const joinToken2 = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
      localStorage.setItem("str_join_token", joinToken2);
      await supabase.from("rooms").update({ user_b: { ...currentProfile, _joinToken: joinToken2 } }).eq("room_code", code);
      const hostProfile = data.user_a;
      localStorage.setItem("str_room_code", code);
      localStorage.setItem("str_user_slot", "b");
      setRoomCode(code);
      setUserSlot("b");
      setPartnerProfile(hostProfile);
      setJoinError("");
      subscribeToRoom(code, "b", currentProfile);
      generateRoutine(hostProfile);
    } catch {
      setJoinError("Could not join room. Check the code and try again.");
      setTab("partner");
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
    if (!supabase) return;
    if (supaSubRef.current) supaSubRef.current.unsubscribe();
    supaSubRef.current = supabase
      .channel(`room:${code}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: `room_code=eq.${code}` }, (payload) => {
        const data = payload.new;
        const partner = slot === "a" ? data.user_b : data.user_a;
        if (partner) {
          setPartnerProfile(partner); // _activeSession and _lastWorkout embedded here
          setWaitingForPartner(false);
          // Don't rebuild routine during an active workout — it would replace the
          // current routine mid-session and can cause day/ex to become undefined.
          if (!workoutStartRef.current) {
            setRoutine(prev => prev || buildRoutine(userProfile || {}, partner));
          }
        }
        if (Array.isArray(data.messages) && data.messages.length) setMessages(data.messages);
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
      const durationMin = Math.max(1, Math.round((Date.now() - workoutStartRef.current) / 60000));
      const totalVolume = Math.round(currentDay.exercises.reduce((sum, e) => {
        const w = parseFloat(e.wA) || 0;
        const reps = parseInt((e.reps||"8").split("–")[0]) || 8;
        return sum + e.sets * reps * w;
      }, 0));
      const entry = {
        id: Date.now(),
        date: new Date().toLocaleDateString("en-US", {month:"short", day:"numeric"}),
        dayOfWeek: new Date().toLocaleDateString("en-US", {weekday:"short"}),
        dayName: currentDay.name,
        totalSets: Object.keys(completedSets).length,
        duration: durationMin,
        exercises: currentDay.exercises.length,
        totalVolume,
        maxWeight: Math.max(...currentDay.exercises.map(e => parseFloat(e.wA) || 0)),
        color: currentDay.color,
        note: workoutNote || "",
      };
      setWorkoutHistory(prev => [entry, ...prev].slice(0, 20));
      setWorkoutNote("");
      if (roomCode && supabase) {
        const col = userSlot === "a" ? "user_a" : "user_b";
        supabase.from("rooms")
          .update({ [col]: { ...profile, _activeSession: null, _lastWorkout: entry } })
          .eq("room_code", roomCode)
          .catch(() => {});
      }
    }
    if (timerRef.current) clearInterval(timerRef.current);
    setResting(false);
    setSheet(null);
    clearActiveSession();
    setScreen("home");
  };

  /* ─── PIN screen handlers ─── */
  const handlePinDigit = async (d) => {
    if (pinLockedUntil && Date.now() < pinLockedUntil) return;
    if (pinLockouts >= 3) return;
    const next = pinEntry + d;
    setPinEntry(next);
    if (next.length === 4) {
      const h = await hashPIN(next);
      if (h === pinHash) {
        setPinEntry(""); setPinError(""); setPinAttempts(0); setPinLockouts(0); setPinShake(false);
        setPinLockedUntil(null);
        if (joinCodeFromUrl) { postAuthJoinCode.current = joinCodeFromUrl; setJoinCodeFromUrl(""); }
        setScreen("home");
      } else {
        const attempts = pinAttempts + 1;
        setPinShake(true);
        setTimeout(() => setPinShake(false), 450);
        if (attempts >= 3) {
          const newLockouts = pinLockouts + 1;
          setPinLockouts(newLockouts);
          setPinAttempts(0);
          if (newLockouts >= 3) {
            setPinError("Account locked after too many failed attempts.");
          } else {
            setPinLockedUntil(Date.now() + 30000);
            setPinError(`Too many attempts. Locked for 30s. (${3 - newLockouts} lockout${3-newLockouts===1?"":"s"} before full reset)`);
          }
        } else {
          setPinAttempts(attempts);
          setPinError(`Wrong PIN. ${3 - attempts} attempt${3-attempts===1?"":"s"} left.`);
        }
        setTimeout(() => setPinEntry(""), 500);
      }
    }
  };
  const handlePinDelete = () => {
    if (pinLockedUntil && Date.now() < pinLockedUntil) return;
    if (pinLockouts >= 3) return;
    setPinEntry(p => p.slice(0,-1));
  };

  /* ─── Keyboard support for PIN screen (desktop) ─── */
  useEffect(() => {
    if (screen !== "pin") return;
    const onKey = async (e) => {
      if (pinLockedUntil && Date.now() < pinLockedUntil) return;
      if (pinLockouts >= 3) return;
      if (e.key >= "0" && e.key <= "9") {
        const next = pinEntry + e.key;
        setPinEntry(next);
        if (next.length === 4) {
          const h = await hashPIN(next);
          if (h === pinHash) {
            setPinEntry(""); setPinError(""); setPinAttempts(0); setPinLockouts(0); setPinShake(false);
            setPinLockedUntil(null);
            if (joinCodeFromUrl) { postAuthJoinCode.current = joinCodeFromUrl; setJoinCodeFromUrl(""); }
            setScreen("home");
          } else {
            const attempts = pinAttempts + 1;
            setPinShake(true);
            setTimeout(() => setPinShake(false), 450);
            if (attempts >= 3) {
              const newLockouts = pinLockouts + 1;
              setPinLockouts(newLockouts);
              setPinAttempts(0);
              if (newLockouts >= 3) {
                setPinError("Account locked after too many failed attempts.");
              } else {
                setPinLockedUntil(Date.now() + 30000);
                setPinError(`Too many attempts. Locked for 30s.`);
              }
            } else {
              setPinAttempts(attempts);
              setPinError(`Wrong PIN. ${3 - attempts} attempt${3-attempts===1?"":"s"} left.`);
            }
            setTimeout(() => setPinEntry(""), 500);
          }
        }
      } else if (e.key === "Backspace") {
        if (!(pinLockedUntil && Date.now() < pinLockedUntil)) setPinEntry(p => p.slice(0,-1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, pinEntry, pinAttempts, pinHash, pinLockedUntil, pinLockouts]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setPrs({}); setWeightLog([]);
    setScreen("splash");
  };

  /* ════════════════════════
     JOIN ROOM (invite link)
  ════════════════════════ */
  if (screen === "join_room") return (
    <>
      <GlobalStyles />
      <div style={{background:"#000",minHeight:"100vh",maxWidth:430,margin:"0 auto",display:"flex",flexDirection:"column",padding:"0 28px",paddingTop:"max(env(safe-area-inset-top),48px)",paddingBottom:"max(env(safe-area-inset-bottom),32px)"}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:4,color:"rgba(200,241,53,0.6)",marginBottom:32}}>STRONGER</div>

        <div style={{fontFamily:"var(--font-cond)",fontSize:12,letterSpacing:4,color:"var(--gray)",marginBottom:8}}>
          YOUR PARTNER INVITED YOU
        </div>
        <div style={{fontFamily:"var(--font-display)",fontSize:72,lineHeight:0.85,marginBottom:24}}>
          JOIN<br/>THE<br/>GYM.
        </div>

        <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:24,marginBottom:24,textAlign:"center"}}>
          {joinCodePartnerName ? (
            <div style={{fontFamily:"var(--font-cond)",fontSize:12,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>
              {joinCodePartnerName.toUpperCase()} SHARED THIS CODE WITH YOU
            </div>
          ) : (
            <div style={{fontFamily:"var(--font-cond)",fontSize:12,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>
              ROOM CODE
            </div>
          )}
          <div style={{fontFamily:"var(--font-display)",fontSize:52,color:"var(--lime)",letterSpacing:4,lineHeight:1}}>
            {joinCodeFromUrl}
          </div>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Btn full onClick={() => {
            postAuthJoinCode.current = joinCodeFromUrl;
            setJoinCodeFromUrl("");
            if (!profile) setProfile({name:"",age:"",weight:"",height:"",sex:"",goal:"",level:"",daysPerWeek:"3",equipment:[],injuries:""});
            setOnboardStep(0);
            setScreen("onboarding");
          }}>
            JOIN &amp; CREATE ACCOUNT
          </Btn>

          {profile && pinHash && (
            <Btn variant="ghost" full onClick={() => {
              setScreen("pin");
            }}>
              JOIN EXISTING ACCOUNT
            </Btn>
          )}

          <button
            onClick={() => { setJoinCodeFromUrl(""); setScreen(profile && pinHash ? "pin" : "splash"); }}
            style={{background:"none",border:"none",fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray2)",marginTop:4,cursor:"pointer",textAlign:"center"}}
          >
            SKIP FOR NOW
          </button>
        </div>
      </div>
    </>
  );

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
            {pinLockedUntil && pinLockCountdown > 0 ? (
              <div style={{fontFamily:"var(--font-cond)",fontSize:12,letterSpacing:1,color:"var(--red)",textAlign:"center"}}>
                LOCKED — {pinLockCountdown}s · {3 - pinLockouts} lockout{3-pinLockouts===1?"":"s"} before reset
              </div>
            ) : pinError ? (
              <div style={{fontFamily:"var(--font-cond)",fontSize:12,letterSpacing:1,color:"var(--red)"}}>{pinError}</div>
            ) : null}
          </div>

          {/* Numpad — dimmed and blocked during lockout */}
          <div style={{opacity:(pinLockedUntil || pinLockouts >= 3) ? 0.35 : 1, pointerEvents:(pinLockedUntil || pinLockouts >= 3) ? "none" : "auto", transition:"opacity .3s"}}>
            <Numpad onDigit={handlePinDigit} onDelete={handlePinDelete} />
          </div>

          {pinLockouts >= 3 ? (
            <div style={{marginTop:32,width:"100%"}}>
              <Btn full variant="red-soft" onClick={resetAndGoSplash}>
                Reset Account (Locked Out)
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
    const TOTAL_STEPS  = 7;
    const progress     = ((onboardStep+1)/TOTAL_STEPS)*100;
    const nextStep     = () => setOnboardStep(s=>s+1);
    const prevStep     = () => onboardStep>0 ? setOnboardStep(s=>s-1) : setScreen("splash");
    const isPartnerStep = onboardStep===6;

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

    const toggleMuscle = (v) => {
      const arr = profile.priorityMuscles||[];
      p("priorityMuscles", arr.includes(v)?arr.filter(x=>x!==v):[...arr,v]);
    };

    // Feature 3 — Day preset helper
    const getDayPreset = (n) => {
      const presets = {
        2: ["TUE","FRI"],
        3: ["MON","WED","FRI"],
        4: ["MON","TUE","THU","FRI"],
        5: ["MON","TUE","WED","THU","FRI"],
        6: ["MON","TUE","WED","THU","FRI","SAT"],
      };
      return presets[n] || ["MON","WED","FRI"];
    };

    const ALL_DAYS_LABELS = ["MON","TUE","WED","THU","FRI","SAT","SUN"];

    // Feature 2 — Goal conflict handler
    const GOAL_CONFLICT_EXPLANATIONS = {
      "Build muscle_Lose fat": "These goals require opposite nutrition strategies — building muscle needs a calorie surplus, losing fat needs a deficit. Most people get better results focusing on one. That said, beginners can do both at once ('body recomposition') — if that's you, select the goal that matters most right now.",
      "Lose fat_Build muscle": "These goals require opposite nutrition strategies — building muscle needs a calorie surplus, losing fat needs a deficit. Most people get better results focusing on one. That said, beginners can do both at once ('body recomposition') — if that's you, select the goal that matters most right now.",
      "Get stronger_Improve endurance": "Heavy strength training and endurance cardio can interfere with each other (interference effect). Picking one as your primary focus lets us build the right program. You can always add cardio on rest days.",
      "Improve endurance_Get stronger": "Heavy strength training and endurance cardio can interfere with each other (interference effect). Picking one as your primary focus lets us build the right program. You can always add cardio on rest days.",
      "Stay active_Build muscle": "Staying active is a great foundation — but muscle building requires progressive overload and specific volume targets. If you're ready to commit to that, switch to 'Build muscle' as your goal.",
      "Build muscle_Stay active": "Staying active is a great foundation — but muscle building requires progressive overload and specific volume targets. If you're ready to commit to that, switch to 'Build muscle' as your goal.",
    };

    const handleGoalSelect = (v) => {
      if (!profile.goal) {
        p("goal", v);
        return;
      }
      if (profile.goal === v) return;
      // Clear any existing timer
      if (goalConflictTimer) clearTimeout(goalConflictTimer);
      const key = `${profile.goal}_${v}`;
      const explanation = GOAL_CONFLICT_EXPLANATIONS[key] || "Each goal needs a different training stimulus and diet. Splitting focus usually means slower progress on both. Pick your priority for now — you can always update your goal later in settings.";
      setGoalConflict({ pending: v, explanation });
      const timer = setTimeout(() => {
        setGoalConflict(null);
      }, 6000);
      setGoalConflictTimer(timer);
    };

    const GOALS  = ["Lose fat","Build muscle","Get stronger","Improve endurance","Stay active"];
    const LEVELS = ["Beginner","Intermediate","Advanced"];
    const EQUIP  = ["Full gym","Dumbbells only","Barbell + rack","Cables","Machines","Resistance bands"];
    const DAYS   = ["2","3","4","5","6"];

    const stepContent = [
      /* 0 — Name + PIN */
      <div key={0} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 1 OF 7</div>
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
              autoComplete="new-password"
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
              autoComplete="new-password"
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
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 2 OF 7</div>
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
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 3 OF 7</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>YOUR<br/>GOALS</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:28}}>What are you training for, {profile.name||"you"}?</p>
        <Label text="PRIMARY GOAL"/>
        <div className="chip-select" style={{marginBottom:goalConflict?12:28}}>
          {GOALS.map(v=><Chip key={v} value={v} single currentSingle={profile.goal} onSelect={handleGoalSelect}/>)}
        </div>
        {goalConflict && (
          <div style={{background:"var(--card)",borderRadius:14,borderLeft:"3px solid var(--lime)",padding:"14px 16px",marginBottom:20,animation:"fadeIn 0.2s ease"}}>
            <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6,marginBottom:12}}>{goalConflict.explanation}</p>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{ p("goal", goalConflict.pending); setGoalConflict(null); if(goalConflictTimer) clearTimeout(goalConflictTimer); }}
                style={{flex:1,background:"var(--lime)",border:"none",borderRadius:10,padding:"10px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:12,letterSpacing:1,color:"var(--black)",cursor:"pointer"}}>
                Got it
              </button>
              <button onClick={()=>{ setGoalConflict(null); if(goalConflictTimer) clearTimeout(goalConflictTimer); }}
                style={{flex:1,background:"transparent",border:"1px solid var(--line2)",borderRadius:10,padding:"10px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:12,letterSpacing:1,color:"var(--gray)",cursor:"pointer"}}>
                Keep {profile.goal}
              </button>
            </div>
          </div>
        )}
        <Label text="TRAINING LEVEL"/>
        <div className="chip-select">
          {LEVELS.map(v=><Chip key={v} value={v} single currentSingle={profile.level} onSelect={v=>p("level",v.toLowerCase())}/>)}
        </div>
      </div>,

      /* 3 — Muscle priorities (NEW) */
      <div key={3} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 4 OF 7</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:52,lineHeight:0.88,marginBottom:16}}>WHAT DO<br/>YOU WANT<br/>TO BUILD?</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>Select the areas you want to focus on most.</p>
        <div style={{display:"flex",gap:16,marginBottom:24}}>
          <div style={{flex:1}}>
            <Label text="UPPER BODY"/>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {["Chest","Back","Shoulders","Arms","Core"].map(v=>(
                <button key={v} onClick={()=>toggleMuscle(v)}
                  className={(profile.priorityMuscles||[]).includes(v)?"chip active":"chip"}
                  style={{textAlign:"left"}}>{v}</button>
              ))}
            </div>
          </div>
          <div style={{flex:1}}>
            <Label text="LOWER BODY"/>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {["Glutes","Quads","Hamstrings","Calves","Full Lower Body"].map(v=>(
                <button key={v} onClick={()=>toggleMuscle(v)}
                  className={(profile.priorityMuscles||[]).includes(v)?"chip active":"chip"}
                  style={{textAlign:"left",fontSize:11}}>{v}</button>
              ))}
            </div>
          </div>
        </div>
        <Label text="SPLIT FOCUS"/>
        <div className="chip-select">
          {["Balanced","More lower body","More upper body","Full body"].map(v=>(
            <Chip key={v} value={v} single currentSingle={profile.splitPreference||"Balanced"} onSelect={v=>p("splitPreference",v)}/>
          ))}
        </div>
      </div>,

      /* 4 — Schedule + equipment (was 3) */
      <div key={4} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 5 OF 7</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>YOUR<br/>GYM</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:28}}>When and what do you train with?</p>
        <Label text="DAYS PER WEEK"/>
        <div className="chip-select" style={{marginBottom:20}}>
          {DAYS.map(v=><Chip key={v} value={v} single currentSingle={profile.daysPerWeek} onSelect={v=>{
            p("daysPerWeek",v);
            p("trainingDays", getDayPreset(parseInt(v)));
          }}/>)}
        </div>
        <Label text="TRAINING DAYS"/>
        <div style={{display:"flex",gap:6,marginBottom:24}}>
          {ALL_DAYS_LABELS.map(d => {
            const td = profile.trainingDays || getDayPreset(parseInt(profile.daysPerWeek)||3);
            const isSelected = td.includes(d);
            const n = parseInt(profile.daysPerWeek)||3;
            return (
              <button key={d} onClick={()=>{
                const current = profile.trainingDays || getDayPreset(n);
                if (isSelected) {
                  // Shake — don't allow deselect (must keep exactly N)
                  return;
                } else {
                  // Deselect first selected, then add new
                  const newDays = [...current.slice(1), d];
                  p("trainingDays", newDays);
                }
              }} style={{
                flex:1,padding:"8px 0",borderRadius:8,border:isSelected?"1.5px solid var(--lime)":"1.5px solid var(--line2)",
                background:isSelected?"var(--lime)":"var(--card)",
                fontFamily:"var(--font-cond)",fontWeight:700,fontSize:9,letterSpacing:0.5,
                color:isSelected?"var(--black)":"var(--gray)",cursor:"pointer",transition:"all .15s"
              }}>{d}</button>
            );
          })}
        </div>
        <Label text="AVAILABLE EQUIPMENT (select all)"/>
        <div className="chip-select">
          {EQUIP.map(v=><Chip key={v} value={v} current={profile.equipment} onToggle={toggleEquip}/>)}
        </div>
      </div>,

      /* 5 — Injuries (was 4) */
      <div key={5} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 6 OF 7</div>
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
            ["Equipment", (profile.equipment||[]).length?(profile.equipment||[]).join(", "):"Full gym"],
          ].map(([l,v])=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid var(--line)"}}>
              <span style={{fontFamily:"var(--font-cond)",fontSize:12,color:"var(--gray)",letterSpacing:1}}>{l}</span>
              <span style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:12,color:"var(--white)",textAlign:"right",maxWidth:"55%"}}>{v}</span>
            </div>
          ))}
        </div>
      </div>,

      /* 6 — Partner connection (was 5) */
      <div key={6} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>STEP 7 OF 7</div>
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
        {/* Feature 4A — PR notification banner */}
        {prNotification && (
          <div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",background:"var(--lime)",color:"var(--black)",borderRadius:12,padding:"10px 18px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,zIndex:100,animation:"slideIn 0.3s ease",display:"flex",alignItems:"center",gap:8,maxWidth:380,whiteSpace:"nowrap"}}>
            🏆 NEW PR — {prNotification.exerciseName.toUpperCase()} {prNotification.weight}
          </div>
        )}
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
              <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:14}}>
                <div style={{fontFamily:"var(--font-display)",fontSize:52,lineHeight:0.92,color:"var(--white)"}}>{ex.name.toUpperCase()}</div>
                <button onClick={()=>{setSwapExercise(ex);setSheet("swap");}} style={{background:"var(--card)",border:"1px solid var(--line2)",borderRadius:8,padding:"4px 10px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:10,letterSpacing:2,color:"var(--gray)",cursor:"pointer",flexShrink:0}}>SWAP</button>
              </div>
              <div style={{display:"flex",gap:8}}>
                {[{l:"SETS",v:ex.sets},{l:"REPS",v:ex.reps},{l:"REST",v:`${ex.rest}s`}].map(({l,v})=>(
                  <div key={l} style={{flex:1,background:"var(--card)",borderRadius:12,padding:"12px 0",textAlign:"center",border:"1px solid var(--line)"}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"var(--gray)",marginBottom:4}}>{l}</div>
                    <div style={{fontFamily:"var(--font-cond)",fontWeight:800,fontSize:22,color:"var(--white)"}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* Feature 4C — Weight progression suggestion */}
            <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1,marginBottom:8}}>
              {prs[ex.name]
                ? `Last time: ${prs[ex.name].weight}kg · Try ${Math.round(prs[ex.name].weight * 1.025 / 2.5) * 2.5}kg today`
                : "First time — start conservative"}
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
                        {["Set done!","Form check?","Let's go!","Break"].map(t=>(
                          <button key={t} onClick={async ()=>{
                            const now = Date.now();
                            if (now - lastMsgTimeRef.current < 1000) return;
                            lastMsgTimeRef.current = now;
                            const newMsg = {slot:userSlot, text:sanitize(t), ts:now};
                            const base = messages.length >= 500 ? messages.slice(50) : messages;
                            const updated = [...base, newMsg];
                            setMessages(updated);
                            if (roomCode && supabase) await supabase.from("rooms").update({messages:updated}).eq("room_code",roomCode).catch(()=>{});
                          }} style={{background:"var(--dark)",border:"1px solid var(--line)",borderRadius:99,padding:"8px 14px",fontFamily:"var(--font-body)",fontSize:12,color:"var(--white)",cursor:"pointer"}}>{t}</button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div style={{textAlign:"center",padding:"20px 0"}}>
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
                {/* Feature 4B — Swap sheet */}
                {sheet==="swap" && swapExercise && (
                  <div>
                    <div style={{fontFamily:"var(--font-display)",fontSize:32,marginBottom:4}}>SWAP EXERCISE</div>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)",marginBottom:20}}>FOR TODAY ONLY — YOUR ROUTINE STAYS UNCHANGED</div>
                    {(ALTERNATIVES_DB[swapExercise.name] || ["No alternatives"]).map(alt => (
                      <button key={alt} onClick={() => {
                        setRoutine(prev => {
                          const newRoutine = prev.map((d,di) => di !== dayIdx ? d : {
                            ...d,
                            exercises: d.exercises.map((e,ei) => ei !== exIdx ? e : { ...e, name: alt })
                          });
                          return newRoutine;
                        });
                        setSheet(null);
                        setSwapExercise(null);
                      }} style={{width:"100%",background:"var(--dark)",border:"1px solid var(--line2)",borderRadius:12,padding:"14px 16px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:15,letterSpacing:1,color:"var(--white)",cursor:"pointer",marginBottom:8,textAlign:"left"}}>
                        {alt}
                      </button>
                    ))}
                    <Btn variant="ghost" full onClick={()=>{setSheet(null);setSwapExercise(null);}}>CANCEL</Btn>
                  </div>
                )}
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
                    {/* Feature 4E — Workout notes */}
                    <div style={{marginBottom:16,textAlign:"left"}}>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>HOW DID IT FEEL? (OPTIONAL)</div>
                      <textarea
                        value={workoutNote}
                        onChange={e=>setWorkoutNote(e.target.value)}
                        placeholder="Add a note about this session..."
                        style={{width:"100%",background:"var(--dark)",border:"1px solid var(--line2)",borderRadius:10,padding:"10px 12px",fontFamily:"var(--font-body)",fontSize:14,color:"var(--white)",resize:"none",height:72,outline:"none",boxSizing:"border-box"}}
                      />
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
     SETTINGS
  ════════════════════════ */
  if (screen === "settings") {
    const ALL_DAYS_SETTINGS = ["MON","TUE","WED","THU","FRI","SAT","SUN"];
    const settingsTD = profile?.trainingDays || [];
    const settingsN = parseInt(profile?.daysPerWeek)||3;
    return (
      <>
        <GlobalStyles/>
        {/* Toast inside settings */}
        {toast && (
          <div style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",background:"var(--lime)",color:"var(--black)",borderRadius:12,padding:"10px 20px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,zIndex:200,whiteSpace:"nowrap"}}>
            {toast}
          </div>
        )}
        <div style={{background:"var(--black)",minHeight:"100vh",maxWidth:430,margin:"0 auto",display:"flex",flexDirection:"column"}}>
          <div style={{padding:"22px 22px 0",display:"flex",alignItems:"center",gap:12}}>
            <button onClick={()=>{setShowChangePinFlow(false);setScreen("home");}} style={{background:"none",border:"none",color:"var(--gray)",fontFamily:"var(--font-cond)",fontSize:13,letterSpacing:2,cursor:"pointer",padding:0}}>← BACK</button>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"24px 22px 40px"}}>
            <div style={{fontFamily:"var(--font-display)",fontSize:52,lineHeight:0.88,marginBottom:24}}>SETTINGS</div>

            {/* Profile */}
            <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>EDIT PROFILE</div>
              <Input label="NAME" placeholder="Your name" value={settingsName} onChange={v=>setSettingsName(v)} maxLength={50}/>
              <div style={{display:"flex",gap:10}}>
                <div style={{flex:1}}><Input label="WEIGHT" placeholder="80" value={settingsWeight} onChange={v=>setSettingsWeight(v)} type="number" unit="kg"/></div>
                <div style={{flex:1}}><Input label="AGE" placeholder="28" value={settingsAge} onChange={v=>setSettingsAge(v)} type="number"/></div>
                <div style={{flex:1}}><Input label="HEIGHT" placeholder="175" value={settingsHeight} onChange={v=>setSettingsHeight(v)} type="number" unit="cm"/></div>
              </div>
              <div style={{marginBottom:14}}>
                <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>INJURIES / LIMITATIONS</div>
                <textarea maxLength={300} value={settingsInjuries} onChange={e=>setSettingsInjuries(e.target.value)} placeholder="Any injuries or limitations..." rows={2} style={{width:"100%",background:"var(--dark)",border:"1.5px solid var(--line2)",borderRadius:12,padding:"12px 14px",fontFamily:"var(--font-body)",fontSize:14,color:"var(--white)",resize:"none",outline:"none",boxSizing:"border-box"}}/>
              </div>
              <Btn full onClick={()=>{
                if (settingsName.trim()) p("name", settingsName.trim());
                if (settingsWeight && parseFloat(settingsWeight) > 0) p("weight", settingsWeight);
                if (settingsAge && parseInt(settingsAge) > 0) p("age", settingsAge);
                if (settingsHeight && parseInt(settingsHeight) > 0) p("height", settingsHeight);
                p("injuries", settingsInjuries||"");
                setToast("Profile saved"); setTimeout(()=>setToast(null),2000);
              }}>SAVE PROFILE</Btn>
            </div>

            {/* Training Days */}
            <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>TRAINING DAYS</div>
              <div style={{display:"flex",gap:6,marginBottom:12}}>
                {ALL_DAYS_SETTINGS.map(d => {
                  const isSelected = settingsTD.includes(d);
                  return (
                    <button key={d} onClick={()=>{
                      if (isSelected) {
                        if (settingsTD.length > 1) p("trainingDays", settingsTD.filter(x=>x!==d));
                      } else {
                        const newDays = settingsTD.length >= settingsN ? [...settingsTD.slice(1), d] : [...settingsTD, d];
                        p("trainingDays", newDays);
                      }
                    }} style={{
                      flex:1,padding:"8px 0",borderRadius:8,border:isSelected?"1.5px solid var(--lime)":"1.5px solid var(--line2)",
                      background:isSelected?"var(--lime)":"var(--dark)",
                      fontFamily:"var(--font-cond)",fontWeight:700,fontSize:9,letterSpacing:0.5,
                      color:isSelected?"var(--black)":"var(--gray)",cursor:"pointer",transition:"all .15s"
                    }}>{d}</button>
                  );
                })}
              </div>
            </div>

            {/* Security — Change PIN */}
            <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>SECURITY</div>
              {!showChangePinFlow ? (
                <Btn full variant="ghost" onClick={()=>{setShowChangePinFlow(true);setCpStep("verify");setCpEntry("");setCpNew("");setCpConfirm("");setCpError("");}}>CHANGE PIN</Btn>
              ) : (
                <div>
                  {cpStep === "verify" && (
                    <>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:10}}>ENTER CURRENT PIN</div>
                      <input type="password" inputMode="numeric" maxLength={4} autoComplete="off" value={cpEntry} onChange={e=>{const v=e.target.value.replace(/\D/g,"").slice(0,4);setCpEntry(v);setCpError("");}} placeholder="• • • •" style={{width:"100%",background:"var(--dark)",border:`1.5px solid ${cpError?"var(--red)":"var(--line2)"}`,borderRadius:12,padding:"14px 16px",fontFamily:"var(--font-body)",fontSize:24,letterSpacing:8,color:"var(--white)",textAlign:"center",outline:"none",boxSizing:"border-box",marginBottom:8}}/>
                      {cpError && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginBottom:8}}>{cpError}</div>}
                      <div style={{display:"flex",gap:8}}>
                        <Btn full onClick={async()=>{
                          if(cpEntry.length!==4){setCpError("Enter your 4-digit PIN");return;}
                          const h=await hashPIN(cpEntry);
                          if(h===pinHash){setCpStep("new");setCpEntry("");setCpError("");}
                          else{setCpError("Wrong PIN. Try again.");}
                        }}>VERIFY</Btn>
                        <Btn full variant="ghost" onClick={()=>{setShowChangePinFlow(false);}}>CANCEL</Btn>
                      </div>
                    </>
                  )}
                  {cpStep === "new" && (
                    <>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:10}}>NEW PIN</div>
                      <input type="password" inputMode="numeric" maxLength={4} autoComplete="new-password" value={cpNew} onChange={e=>{const v=e.target.value.replace(/\D/g,"").slice(0,4);setCpNew(v);setCpError("");}} placeholder="• • • •" style={{width:"100%",background:"var(--dark)",border:`1.5px solid ${cpError?"var(--red)":"var(--line2)"}`,borderRadius:12,padding:"14px 16px",fontFamily:"var(--font-body)",fontSize:24,letterSpacing:8,color:"var(--white)",textAlign:"center",outline:"none",boxSizing:"border-box",marginBottom:8}}/>
                      {cpError && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginBottom:8}}>{cpError}</div>}
                      <div style={{display:"flex",gap:8}}>
                        <Btn full onClick={()=>{
                          if(cpNew.length!==4||!/^\d{4}$/.test(cpNew)){setCpError("PIN must be 4 digits");return;}
                          setCpStep("confirm");setCpError("");
                        }}>NEXT</Btn>
                        <Btn full variant="ghost" onClick={()=>setShowChangePinFlow(false)}>CANCEL</Btn>
                      </div>
                    </>
                  )}
                  {cpStep === "confirm" && (
                    <>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:10}}>CONFIRM NEW PIN</div>
                      <input type="password" inputMode="numeric" maxLength={4} autoComplete="new-password" value={cpConfirm} onChange={e=>{const v=e.target.value.replace(/\D/g,"").slice(0,4);setCpConfirm(v);setCpError("");}} placeholder="• • • •" style={{width:"100%",background:"var(--dark)",border:`1.5px solid ${cpError?"var(--red)":"var(--line2)"}`,borderRadius:12,padding:"14px 16px",fontFamily:"var(--font-body)",fontSize:24,letterSpacing:8,color:"var(--white)",textAlign:"center",outline:"none",boxSizing:"border-box",marginBottom:8}}/>
                      {cpError && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginBottom:8}}>{cpError}</div>}
                      <div style={{display:"flex",gap:8}}>
                        <Btn full onClick={async()=>{
                          if(cpConfirm!==cpNew){setCpError("PINs don't match");return;}
                          const h=await hashPIN(cpNew);
                          setPinHash(h);
                          setShowChangePinFlow(false);setCpEntry("");setCpNew("");setCpConfirm("");setCpError("");
                          setToast("PIN changed"); setTimeout(()=>setToast(null),2500);
                        }}>SAVE NEW PIN</Btn>
                        <Btn full variant="ghost" onClick={()=>setShowChangePinFlow(false)}>CANCEL</Btn>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Routine */}
            <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:40}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>ROUTINE</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <Btn full onClick={()=>{setScreen("home"); setTimeout(()=>openRebuildModal(),150);}}>CUSTOMIZE ROUTINE</Btn>
                <Btn full variant="ghost" onClick={()=>{setScreen("home"); setTimeout(()=>generateRoutine(),150);}}>QUICK REBUILD</Btn>
              </div>
            </div>
          </div>
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
              <button onClick={()=>setTab("partner")} style={{display:"flex",alignItems:"center",gap:5,background:"rgba(48,209,88,.08)",borderRadius:99,padding:"5px 11px",border:"1px solid rgba(48,209,88,.18)",cursor:"pointer"}}>
                <div style={{width:7,height:7,borderRadius:99,background:"#30d158",animation:"pulse 2s infinite"}}/>
                <span style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"#30d158"}}>{(partnerProfile.name||"PARTNER").toUpperCase()}</span>
              </button>
            )}
            <button onClick={()=>{ setSettingsName(profile?.name||""); setSettingsWeight(profile?.weight||""); setSettingsAge(profile?.age||""); setSettingsHeight(profile?.height||""); setSettingsInjuries(profile?.injuries||""); setShowChangePinFlow(false); setScreen("settings"); }} style={{background:"none",border:"none",fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)",cursor:"pointer",padding:"4px 8px"}}>SETTINGS</button>
            <button onClick={()=>setShowLogout(true)} style={{background:"var(--card)",border:"none",borderRadius:10,width:34,height:34,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gray)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
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
          {tab==="today" && (() => {
            // Feature 3 — week display
            const today = new Date();
            const todayDOW = today.getDay(); // 0=Sun
            const mondayOffset = todayDOW === 0 ? -6 : 1 - todayDOW;
            const monday = new Date(today);
            monday.setDate(today.getDate() + mondayOffset);
            monday.setHours(0,0,0,0);

            const WEEK_DAYS = ["MON","TUE","WED","THU","FRI","SAT","SUN"];
            const WEEK_DAYS_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

            const trainingDays = profile?.trainingDays || null;
            const todayLabel = WEEK_DAYS[todayDOW === 0 ? 6 : todayDOW - 1];

            const isTrainingDay = trainingDays ? trainingDays.includes(todayLabel) : true;

            // Check workout history for this week
            const weekStart = monday.getTime();
            const weekEnd = weekStart + 7 * 86400000;
            const thisWeekHistory = workoutHistory.filter(h => {
              if (!h.date) return false;
              try {
                const d = new Date(h.date + " 2025");
                return d.getTime() >= weekStart && d.getTime() < weekEnd;
              } catch { return false; }
            });

            const completedDayOfWeeks = thisWeekHistory.map(h => h.dayOfWeek); // ["Mon","Tue",...]

            return (
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              {aiSummary && (
                <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid rgba(200,241,53,.2)",padding:20}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:8}}>AI COACH NOTE</div>
                  <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"#ccc",lineHeight:1.65}}>{aiSummary}</p>
                </div>
              )}
              <div className="fu1" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20}}>
                <div style={{display:"flex",gap:4,marginBottom:14}}>
                  {WEEK_DAYS.map((d,i)=>{
                    const isTraining = trainingDays ? trainingDays.includes(d) : i < 5;
                    const isCompleted = completedDayOfWeeks.includes(WEEK_DAYS_SHORT[i]);
                    const isToday = d === todayLabel;
                    return (
                      <div key={i} style={{flex:1,textAlign:"center"}}>
                        {isTraining && isCompleted
                          ? <div style={{height:4,borderRadius:99,background:"var(--lime)",marginBottom:5}}/>
                          : isTraining
                            ? <div style={{height:4,borderRadius:99,border:"1px solid var(--lime)",background:"transparent",marginBottom:5}}/>
                            : <div style={{height:2,borderRadius:99,background:"var(--line)",marginBottom:7}}/>
                        }
                        <div style={{fontFamily:"var(--font-cond)",fontSize:9,fontWeight:700,color:isTraining?"var(--lime)":"var(--gray2)"}}>{d}</div>
                        {isToday && isTraining && <div style={{width:4,height:4,borderRadius:99,background:"var(--lime)",margin:"3px auto 0"}}/>}
                      </div>
                    );
                  })}
                </div>
                <div style={{fontFamily:"var(--font-display)",fontSize:40,lineHeight:0.9}}>
                  {workoutHistory.length>0?`${workoutHistory.length} WORKOUT${workoutHistory.length>1?"S":""}`:"START YOUR FIRST"}
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
              {/* Feature 4D — Rest day or training day content */}
              {!isTrainingDay ? (
                <div className="fu2" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:24}}>
                  <div style={{fontFamily:"var(--font-display)",fontSize:52,lineHeight:0.9,marginBottom:16}}>REST<br/>DAY</div>
                  <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.7,marginBottom:20}}>
                    {RECOVERY_TIPS[today.getDate() % 10]}
                  </p>
                  <button onClick={()=>setSheet("stretching")} style={{width:"100%",background:"rgba(200,241,53,0.1)",border:"1px solid rgba(200,241,53,0.3)",borderRadius:12,padding:"14px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,color:"var(--lime)",cursor:"pointer",marginBottom:12}}>
                    LIGHT STRETCHING ROUTINE
                  </button>
                  {partnerProfile?._lastWorkout && (
                    <div style={{background:"var(--dark)",borderRadius:12,padding:14}}>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:6}}>{(partnerProfile.name||"PARTNER").toUpperCase()}'S LAST WORKOUT</div>
                      <div style={{fontFamily:"var(--font-display)",fontSize:22,color:"var(--lime)",marginBottom:4}}>{(partnerProfile._lastWorkout.dayName||"").toUpperCase()}</div>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{partnerProfile._lastWorkout.date} · {partnerProfile._lastWorkout.duration}m · {partnerProfile._lastWorkout.totalSets} sets</div>
                    </div>
                  )}
                </div>
              ) : (
                <>
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
                          <div style={{background:d.color,borderRadius:99,width:34,height:34,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--black)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
                          </div>
                        </div>
                        <div style={{marginTop:12,display:"flex",gap:16}}>
                          <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{d.exercises.length} EXERCISES</span>
                          <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>~{40+d.exercises.length*3} MIN</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
            );
          })()}

          {/* ROUTINE */}
          {tab==="routine" && (
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <div className="fu" style={{background:"var(--card)",borderRadius:18,padding:20,border:"1px solid var(--line)"}}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:6}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)"}}>AI GENERATED · MONTH 1</div>
                  <button onClick={openRebuildModal} style={{background:"rgba(200,241,53,.12)",border:"1px solid rgba(200,241,53,.3)",borderRadius:8,padding:"5px 12px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:10,letterSpacing:2,color:"var(--lime)",cursor:"pointer"}}>CUSTOMIZE</button>
                </div>
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
                        {isSupabaseConfigured ? (
                          <div style={{display:"flex",alignItems:"center",gap:8,justifyContent:"center"}}>
                            <div style={{width:8,height:8,borderRadius:99,background:"var(--lime)",animation:"pulse 1.5s infinite"}}/>
                            <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>WAITING FOR PARTNER...</span>
                          </div>
                        ) : (
                          <div style={{background:"rgba(200,241,53,0.08)",border:"1px solid rgba(200,241,53,0.2)",borderRadius:12,padding:"14px 16px",textAlign:"left",marginTop:4}}>
                            <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:6}}>HOW TO CONNECT</div>
                            <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",lineHeight:1.6}}>
                              Share your code <span style={{color:"var(--lime)",fontWeight:700}}>{roomCode}</span> with your partner. They open the app, go to the Partner tab, and enter it manually.
                            </div>
                          </div>
                        )}
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
              ) : (() => {
                const pSession = partnerProfile._activeSession;
                const pLastWorkout = partnerProfile._lastWorkout;
                const fmtElapsed = (s) => {
                  const m = Math.floor(s / 60);
                  const sec = s % 60;
                  return `${m}:${String(sec).padStart(2,"0")}`;
                };
                const completedExCount = pSession
                  ? [...new Set(Object.keys(pSession.completedSets||{}).map(k=>k.split("-")[0]))].length
                  : 0;
                const sendQuickMsg = async (text) => {
                  const now = Date.now();
                  if (now - lastMsgTimeRef.current < 1000) return;
                  lastMsgTimeRef.current = now;
                  const newMsg = {slot:userSlot, text: sanitize(text), ts:now};
                  const base = messages.length >= 500 ? messages.slice(50) : messages;
                  const updated = [...base, newMsg];
                  setMessages(updated);
                  if (roomCode && supabase) await supabase.from("rooms").update({messages:updated}).eq("room_code",roomCode).catch(()=>{});
                };
                return (
                  <>
                    {/* Partner header */}
                    <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20}}>
                      <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
                        <div style={{width:52,height:52,borderRadius:99,background:"var(--lime)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-display)",fontSize:24,color:"var(--black)",flexShrink:0}}>{(partnerProfile.name||"?").slice(0,2).toUpperCase()}</div>
                        <div style={{flex:1}}>
                          <div style={{fontFamily:"var(--font-display)",fontSize:28,lineHeight:1}}>{(partnerProfile.name||"PARTNER").toUpperCase()}</div>
                          {pSession ? (
                            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
                              <div style={{width:7,height:7,borderRadius:99,background:"#30d158",animation:"pulse 1.5s infinite"}}/>
                              <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"#30d158"}}>TRAINING NOW</span>
                            </div>
                          ) : (
                            <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)",marginTop:4}}>NOT TRAINING RIGHT NOW</div>
                          )}
                        </div>
                      </div>

                      {pSession ? (
                        /* ── Active session view ── */
                        <div>
                          <div style={{fontFamily:"var(--font-display)",fontSize:42,lineHeight:0.9,marginBottom:8,color:pSession.color||"var(--lime)"}}>{(pSession.exerciseName||"TRAINING").toUpperCase()}</div>
                          {/* Exercise progress */}
                          <div style={{marginBottom:12}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                              <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>EXERCISES</span>
                              <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:1,color:"var(--white)"}}>{completedExCount} / {pSession.totalExercises}</span>
                            </div>
                            <div style={{height:4,background:"var(--line)",borderRadius:99}}>
                              <div style={{height:"100%",borderRadius:99,background:pSession.color||"var(--lime)",width:`${(completedExCount/(pSession.totalExercises||1))*100}%`,transition:"width .4s"}}/>
                            </div>
                          </div>
                          {/* Set progress dots */}
                          <div style={{marginBottom:12}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                              <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>CURRENT SET</span>
                              <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--white)"}}>{pSession.setNum} / {routine?.[pSession.dayIdx]?.exercises[pSession.exIdx]?.sets||"?"}</span>
                            </div>
                            <div style={{display:"flex",gap:5}}>
                              {Array.from({length: routine?.[pSession.dayIdx]?.exercises[pSession.exIdx]?.sets||4}).map((_,i)=>(
                                <div key={i} style={{width:10,height:10,borderRadius:99,background:i<pSession.setNum-1?"var(--lime)":"var(--line)",border:`1.5px solid ${i<pSession.setNum-1?"var(--lime)":"var(--line2)"}`}}/>
                              ))}
                            </div>
                          </div>
                          <div style={{display:"flex",gap:10,marginBottom:16}}>
                            <div style={{flex:1,background:"var(--dark)",borderRadius:12,padding:"10px 14px",textAlign:"center"}}>
                              <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--gray)",marginBottom:3}}>WEIGHT</div>
                              <div style={{fontFamily:"var(--font-display)",fontSize:22,color:"var(--white)"}}>{pSession.currentWeight||"—"}</div>
                            </div>
                            <div style={{flex:1,background:"var(--dark)",borderRadius:12,padding:"10px 14px",textAlign:"center"}}>
                              <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--gray)",marginBottom:3}}>ELAPSED</div>
                              <div style={{fontFamily:"var(--font-display)",fontSize:22,color:"var(--lime)"}}>{fmtElapsed(partnerElapsedSecs)}</div>
                            </div>
                          </div>
                          <Btn full onClick={()=>sendQuickMsg("You've got this!")}>Cheer them on</Btn>
                        </div>
                      ) : (
                        /* ── Idle view ── */
                        <div>
                          {pLastWorkout ? (
                            <div style={{background:"var(--dark)",borderRadius:12,padding:14,marginBottom:14}}>
                              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:6}}>LAST WORKOUT</div>
                              <div style={{fontFamily:"var(--font-display)",fontSize:24,marginBottom:4,color:pLastWorkout.color||"var(--lime)"}}>{(pLastWorkout.dayName||"").toUpperCase()}</div>
                              <div style={{display:"flex",gap:14}}>
                                <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{pLastWorkout.date}</span>
                                <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{pLastWorkout.duration}m</span>
                                <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{pLastWorkout.totalSets} sets</span>
                                {pLastWorkout.totalVolume ? <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{pLastWorkout.totalVolume?.toLocaleString()}kg vol</span> : null}
                              </div>
                            </div>
                          ) : (
                            <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",marginBottom:14}}>No workouts logged yet.</div>
                          )}
                          <Btn full onClick={()=>sendQuickMsg("Ready to train?")}>Train together?</Btn>
                        </div>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* PROGRESS — Strava-style feed */}
          {tab==="progress" && (() => {
            // Storage warning
            const storageBytes = JSON.stringify(localStorage).length * 2;
            const storageMB = storageBytes / (1024 * 1024);

            // Stats
            const totalWorkouts = workoutHistory.length;
            const totalVolume   = workoutHistory.reduce((s,h) => s + (h.totalVolume||0), 0);
            const streak = (() => {
              if (!workoutHistory.length) return 0;
              const dates = workoutHistory.map(h => new Date(h.date + " 2025").toDateString());
              let count = 0;
              const d = new Date();
              while (true) {
                if (dates.includes(d.toDateString())) { count++; d.setDate(d.getDate()-1); }
                else if (count === 0) { d.setDate(d.getDate()-1); if (count === 0 && new Date() - d > 86400000*2) break; break; }
                else break;
              }
              return count;
            })();

            const statCards = [
              { label:"WORKOUTS", value: totalWorkouts, unit:"" },
              { label:"TOTAL VOLUME", value: totalVolume >= 1000 ? `${(totalVolume/1000).toFixed(1)}k` : totalVolume, unit:"kg" },
              { label:"STREAK", value: streak, unit:" days" },
            ];

            // PRIVACY: photo data never leaves this device — stored as base64 in localStorage only
            const handlePhoto = (workoutId) => {
              const input = document.createElement("input");
              input.type = "file"; input.accept = "image/*"; input.capture = "environment";
              input.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                  try {
                    localStorage.setItem(`str_photo_${workoutId}`, ev.target.result);
                    // Force re-render by updating a dummy state
                    setWorkoutHistory(prev => [...prev]);
                  } catch { alert("Storage full — remove older photos first."); }
                };
                reader.readAsDataURL(file);
              };
              input.click();
            };

            // PRIVACY: Web Share API shares only text + URL — never image data
            const shareWorkout = (h) => {
              const text = `${h.dayName} — ${h.totalVolume ? (h.totalVolume/1000).toFixed(1)+"t total volume" : h.totalSets+" sets"}`;
              if (navigator.share) {
                navigator.share({ title:"Stronger", text, url:"https://stronnger.netlify.app" }).catch(()=>{});
              } else {
                navigator.clipboard.writeText(text).catch(()=>{});
              }
            };

            return (
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                {storageMB > 4 && (
                  <div style={{background:"rgba(255,159,10,.12)",border:"1px solid rgba(255,159,10,.3)",borderRadius:14,padding:"12px 16px"}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"#FF9F0A",marginBottom:3}}>STORAGE WARNING</div>
                    <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",lineHeight:1.5}}>Storage almost full — consider removing older photos.</div>
                  </div>
                )}

                {/* Summary stats */}
                <div className="fu" style={{display:"flex",gap:10}}>
                  {statCards.map(({label,value,unit})=>(
                    <div key={label} style={{flex:1,background:"var(--card)",borderRadius:14,border:"1px solid var(--line)",padding:"14px 10px",textAlign:"center"}}>
                      <div style={{fontFamily:"var(--font-display)",fontSize:26,color:"var(--lime)",lineHeight:1}}>{value}{unit}</div>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--gray)",marginTop:4}}>{label}</div>
                    </div>
                  ))}
                </div>

                {/* Feature 4F — Weight log section */}
                <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:2}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:weightLog.length>0?16:0}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--gray)"}}>BODY WEIGHT</div>
                    <button onClick={()=>{setWeightInput(profile?.weight||"");setShowWeightModal(true);}} style={{background:"rgba(200,241,53,0.1)",border:"1px solid rgba(200,241,53,0.3)",borderRadius:8,padding:"6px 12px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:2,color:"var(--lime)",cursor:"pointer"}}>+ LOG WEIGHT</button>
                  </div>
                  {weightLog.length >= 2 && (
                    (() => {
                      const entries = weightLog.slice(-8);
                      const weights = entries.map(e=>e.weight);
                      const min = Math.min(...weights) - 1;
                      const max = Math.max(...weights) + 1;
                      const w = 280, h = 60;
                      const pts = entries.map((e,i) => {
                        const x = (i/(entries.length-1))*w;
                        const y = h - ((e.weight-min)/(max-min))*h;
                        return `${x},${y}`;
                      }).join(" ");
                      return (
                        <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
                          <polyline points={pts} fill="none" stroke="var(--lime)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          {entries.map((e,i)=>{
                            const x = (i/(entries.length-1))*w;
                            const y = h - ((e.weight-min)/(max-min))*h;
                            return <circle key={i} cx={x} cy={y} r="3" fill="var(--lime)"/>;
                          })}
                        </svg>
                      );
                    })()
                  )}
                  {weightLog.length === 0 && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray2)",marginTop:8}}>Log your weight to track progress over time.</div>}
                  {weightLog.length > 0 && <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:1,color:"var(--gray)",marginTop:8}}>Latest: {weightLog[weightLog.length-1].weight}kg · {weightLog.length} entries</div>}
                </div>

                {/* Workout feed */}
                {workoutHistory.length === 0 ? (
                  <div className="fu1" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:28,textAlign:"center"}}>
                    <div style={{fontFamily:"var(--font-display)",fontSize:28,marginBottom:8}}>NO WORKOUTS YET</div>
                    <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6}}>Complete your first workout to see your journal here.</p>
                  </div>
                ) : workoutHistory.map((h, i) => {
                  const photoKey = `str_photo_${h.id||i}`;
                  const photo = localStorage.getItem(photoKey);
                  return (
                    <div key={h.id||i} className={`fu${i+1}`} style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",overflow:"hidden"}}>
                      {/* Card header */}
                      <div style={{padding:"16px 18px 12px",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                        <div>
                          <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"var(--gray)",marginBottom:2}}>
                            {h.dayOfWeek ? `${h.dayOfWeek} · ` : ""}{h.date}
                          </div>
                          <div style={{fontFamily:"var(--font-display)",fontSize:34,lineHeight:0.9,color:h.color||"var(--white)"}}>{(h.dayName||"WORKOUT").toUpperCase()}</div>
                        </div>
                        <div style={{fontFamily:"var(--font-display)",fontSize:28,color:"var(--lime)"}}>{h.duration}m</div>
                      </div>
                      {/* Stats row */}
                      <div style={{display:"flex",gap:0,borderTop:"1px solid var(--line)",borderBottom:photo?"1px solid var(--line)":"none"}}>
                        {[
                          ["SETS", h.totalSets],
                          ["EXERCISES", h.exercises],
                          ["MAX WT", h.maxWeight ? `${h.maxWeight}kg` : "—"],
                          ["VOLUME", h.totalVolume ? `${h.totalVolume>=1000?(h.totalVolume/1000).toFixed(1)+"k":h.totalVolume}kg` : "—"],
                        ].map(([l,v],si)=>(
                          <div key={l} style={{flex:1,padding:"10px 8px",textAlign:"center",borderRight:si<3?"1px solid var(--line)":"none"}}>
                            <div style={{fontFamily:"var(--font-display)",fontSize:16,color:"var(--white)"}}>{v}</div>
                            <div style={{fontFamily:"var(--font-cond)",fontSize:8,letterSpacing:1.5,color:"var(--gray)",marginTop:2}}>{l}</div>
                          </div>
                        ))}
                      </div>
                      {/* Feature 4E — Workout note display */}
                      {h.note && (
                        <div style={{padding:"8px 18px",borderTop:"1px solid var(--line)"}}>
                          <p style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",fontStyle:"italic",lineHeight:1.5,margin:0}}>{h.note}</p>
                        </div>
                      )}
                      {/* Photo section */}
                      {photo ? (
                        <div style={{position:"relative"}}>
                          <img src={photo} alt="workout" style={{width:"100%",aspectRatio:"16/9",objectFit:"cover",display:"block"}}/>
                          <div style={{position:"absolute",inset:0,background:"linear-gradient(to top,rgba(0,0,0,.75) 0%,transparent 50%)",display:"flex",flexDirection:"column",justifyContent:"flex-end",padding:"14px 16px"}}>
                            <div style={{fontFamily:"var(--font-display)",fontSize:22,color:"white"}}>{(h.dayName||"").toUpperCase()}</div>
                            <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"rgba(255,255,255,.7)"}}>
                              {h.date}{h.maxWeight?` · ${h.maxWeight}kg max`:""}
                            </div>
                          </div>
                          <div style={{position:"absolute",top:10,right:10,display:"flex",gap:8}}>
                            <button
                              onClick={()=>shareWorkout(h)}
                              style={{background:"rgba(0,0,0,.55)",border:"none",borderRadius:99,padding:"7px 14px",fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"white",cursor:"pointer",backdropFilter:"blur(8px)"}}
                            >SHARE</button>
                            <button
                              onClick={()=>{localStorage.removeItem(photoKey);setWorkoutHistory(p=>[...p]);}}
                              style={{background:"rgba(0,0,0,.55)",border:"none",borderRadius:99,padding:"7px 10px",fontFamily:"var(--font-cond)",fontSize:11,color:"rgba(255,255,255,.6)",cursor:"pointer",backdropFilter:"blur(8px)"}}
                            >✕</button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={()=>handlePhoto(h.id||i)}
                          style={{width:"100%",background:"transparent",border:"none",borderTop:"1px dashed var(--line2)",padding:"12px 18px",display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}
                        >
                          <div style={{width:32,height:32,borderRadius:99,background:"var(--dark)",border:"1px solid var(--line2)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gray)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>
                            </svg>
                          </div>
                          <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>ADD PHOTO</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
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
        {/* Feature 4D — Stretching sheet */}
        {sheet === "stretching" && (
          <div onClick={()=>setSheet(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,backdropFilter:"blur(4px)"}}>
            <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#181818",borderRadius:"24px 24px 0 0",padding:28,animation:"slideIn .3s cubic-bezier(.4,0,.2,1)",maxHeight:"85vh",overflowY:"auto"}}>
              <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:4}}>STRETCHING</div>
              <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)",marginBottom:20}}>LIGHT RECOVERY ROUTINE</div>
              {[
                {name:"Hip Flexor Stretch",duration:"60s each side"},
                {name:"Hamstring Stretch",duration:"45s each leg"},
                {name:"Chest Opener",duration:"45s"},
                {name:"Spinal Twist",duration:"30s each side"},
                {name:"Child's Pose",duration:"60s"},
              ].map((ex,i)=>(
                <div key={i} style={{background:"var(--dark)",borderRadius:12,padding:"14px 16px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:15,color:"var(--white)"}}>{ex.name}</div>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:12,color:"var(--lime)",letterSpacing:1}}>{ex.duration}</div>
                </div>
              ))}
              <Btn full variant="ghost" onClick={()=>setSheet(null)} style={{marginTop:8}}>CLOSE</Btn>
            </div>
          </div>
        )}

        {/* Feature 4F — Weight log modal */}
        {showWeightModal && (
          <div onClick={()=>setShowWeightModal(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:60,backdropFilter:"blur(4px)"}}>
            <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#181818",borderRadius:"24px 24px 0 0",padding:28}}>
              <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:16}}>LOG WEIGHT</div>
              <input type="number" value={weightInput} onChange={e=>setWeightInput(e.target.value)} placeholder="kg" step="0.1"
                style={{width:"100%",background:"var(--dark)",border:"1.5px solid var(--line2)",borderRadius:10,padding:"14px 16px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:24,color:"var(--white)",outline:"none",boxSizing:"border-box",marginBottom:16}}/>
              <Btn full onClick={()=>{
                const w = parseFloat(weightInput);
                if (!w || w<20||w>300) return;
                setWeightLog(prev=>[...prev,{date:new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"}),weight:w}]);
                setShowWeightModal(false);
              }}>SAVE</Btn>
            </div>
          </div>
        )}

        {/* Rebuild success toast */}
        {rebuildSuccess && (
          <div style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",background:"var(--lime)",color:"var(--black)",borderRadius:12,padding:"10px 20px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,zIndex:200,animation:"slideIn 0.3s ease",whiteSpace:"nowrap"}}>
            ✓ ROUTINE REBUILT
          </div>
        )}

        {/* ── REBUILD ROUTINE MODAL ── */}
        {showRebuildModal && rebuildDraft && (() => {
          const rd = rebuildDraft;
          const setRd = (k, v) => setRebuildDraft(prev => ({...prev, [k]: v}));
          const toggleRdArr = (k, v) => {
            const arr = rd[k] || [];
            setRd(k, arr.includes(v) ? arr.filter(x=>x!==v) : [...arr, v]);
          };
          const GOALS_RD  = ["Lose fat","Build muscle","Get stronger","Improve endurance","Stay active"];
          const LEVELS_RD = ["Beginner","Intermediate","Advanced"];
          const EQUIP_RD  = ["Full gym","Dumbbells only","Barbell + rack","Cables","Machines","Resistance bands"];
          const ALL_DAYS_RD = ["MON","TUE","WED","THU","FRI","SAT","SUN"];
          const DAYS_COUNT_RD = ["2","3","4","5","6"];
          const getDayPresetRd = (n) => ({2:["TUE","FRI"],3:["MON","WED","FRI"],4:["MON","TUE","THU","FRI"],5:["MON","TUE","WED","THU","FRI"],6:["MON","TUE","WED","THU","FRI","SAT"]}[n] || ["MON","WED","FRI"]);
          const GOAL_CONFLICT_RD = {
            "Build muscle_Lose fat":"These goals need opposite nutrition strategies. Pick the priority that matters most right now.",
            "Lose fat_Build muscle":"These goals need opposite nutrition strategies. Pick the priority that matters most right now.",
            "Get stronger_Improve endurance":"Strength training and endurance can interfere. Picking one as primary gets better results.",
            "Improve endurance_Get stronger":"Strength training and endurance can interfere. Picking one as primary gets better results.",
          };
          const handleRdGoal = (v) => {
            if (!rd.goal || rd.goal === v) { setRd("goal", v); return; }
            if (rebuildConflictTimer) clearTimeout(rebuildConflictTimer);
            const key = `${rd.goal}_${v}`;
            const explanation = GOAL_CONFLICT_RD[key] || "Each goal needs a different training stimulus. Pick your priority for now.";
            setRebuildConflict({ pending: v, explanation });
            const timer = setTimeout(() => setRebuildConflict(null), 6000);
            setRebuildConflictTimer(timer);
          };
          const removedEquip = (profile?.equipment || []).filter(e => !(rd.equipment||[]).includes(e));
          const equipWarning = removedEquip.length > 0 ? `Removing '${removedEquip[0]}' may replace some exercises with bodyweight or dumbbell alternatives.` : null;
          return (
            <div style={{position:"fixed",inset:0,background:"var(--black)",zIndex:150,overflowY:"auto",display:"flex",flexDirection:"column",alignItems:"center"}}>
              <div style={{width:"100%",maxWidth:430,padding:"max(env(safe-area-inset-top),22px) 22px 140px"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24}}>
                  <button onClick={()=>{setShowRebuildModal(false);setRebuildDraft(null);setRebuildPreview(null);setShowRebuildPreview(false);setRebuildConflict(null);}} style={{background:"none",border:"none",color:"var(--gray)",fontFamily:"var(--font-cond)",fontSize:13,letterSpacing:2,cursor:"pointer",padding:0}}>← CANCEL</button>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)"}}>CUSTOMIZE</div>
                </div>
                <div style={{fontFamily:"var(--font-display)",fontSize:48,lineHeight:0.88,marginBottom:24}}>REBUILD<br/>ROUTINE</div>

                {activeSession?.isActive && (
                  <div style={{background:"rgba(255,59,48,.1)",border:"1px solid rgba(255,59,48,.3)",borderRadius:14,padding:"12px 16px",marginBottom:20}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--red)",marginBottom:4}}>ACTIVE WORKOUT</div>
                    <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",lineHeight:1.5}}>You have a workout in progress. Rebuilding will end your current session.</div>
                  </div>
                )}

                {/* A — Training Days */}
                <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>A — TRAINING DAYS</div>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>DAYS PER WEEK</div>
                  <div className="chip-select" style={{marginBottom:16}}>
                    {DAYS_COUNT_RD.map(v=>(
                      <button key={v} className={`chip${rd.daysPerWeek===v?" active":""}`} onClick={()=>{setRd("daysPerWeek",v);setRd("trainingDays",getDayPresetRd(parseInt(v)));}}>{v}</button>
                    ))}
                  </div>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>TRAINING DAYS</div>
                  <div style={{display:"flex",gap:6}}>
                    {ALL_DAYS_RD.map(d => {
                      const td = rd.trainingDays || getDayPresetRd(parseInt(rd.daysPerWeek)||3);
                      const isSel = td.includes(d);
                      const n = parseInt(rd.daysPerWeek)||3;
                      return <button key={d} onClick={()=>{
                        if (isSel) { if(td.length>1) setRd("trainingDays",td.filter(x=>x!==d)); }
                        else { const nd = td.length>=n ? [...td.slice(1),d] : [...td,d]; setRd("trainingDays",nd); }
                      }} style={{flex:1,padding:"8px 0",borderRadius:8,border:isSel?"1.5px solid var(--lime)":"1.5px solid var(--line2)",background:isSel?"var(--lime)":"var(--dark)",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:9,letterSpacing:0.5,color:isSel?"var(--black)":"var(--gray)",cursor:"pointer",transition:"all .15s"}}>{d}</button>;
                    })}
                  </div>
                </div>

                {/* B — Muscle Focus */}
                <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>B — MUSCLE FOCUS</div>
                  <div style={{display:"flex",gap:14,marginBottom:16}}>
                    <div style={{flex:1}}>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>UPPER BODY</div>
                      <div style={{display:"flex",flexDirection:"column",gap:7}}>
                        {["Chest","Back","Shoulders","Arms","Core"].map(v=>(
                          <button key={v} onClick={()=>toggleRdArr("priorityMuscles",v)} className={(rd.priorityMuscles||[]).includes(v)?"chip active":"chip"} style={{textAlign:"left"}}>{v}</button>
                        ))}
                      </div>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>LOWER BODY</div>
                      <div style={{display:"flex",flexDirection:"column",gap:7}}>
                        {["Glutes","Quads","Hamstrings","Calves","Full Lower Body"].map(v=>(
                          <button key={v} onClick={()=>toggleRdArr("priorityMuscles",v)} className={(rd.priorityMuscles||[]).includes(v)?"chip active":"chip"} style={{textAlign:"left",fontSize:11}}>{v}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>SPLIT FOCUS</div>
                  <div className="chip-select">
                    {["Balanced","More lower body","More upper body","Full body"].map(v=>(
                      <button key={v} className={`chip${(rd.splitPreference||"Balanced")===v?" active":""}`} onClick={()=>setRd("splitPreference",v)}>{v}</button>
                    ))}
                  </div>
                </div>

                {/* C — Goal */}
                <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>C — PRIMARY GOAL</div>
                  <div className="chip-select" style={{marginBottom:rebuildConflict?12:0}}>
                    {GOALS_RD.map(v=>(
                      <button key={v} className={`chip${rd.goal===v?" active":""}`} onClick={()=>handleRdGoal(v)}>{v}</button>
                    ))}
                  </div>
                  {rebuildConflict && (
                    <div style={{background:"var(--dark)",borderRadius:12,borderLeft:"3px solid var(--lime)",padding:"12px 14px",marginTop:12,animation:"fadeIn 0.2s ease"}}>
                      <p style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",lineHeight:1.6,marginBottom:10}}>{rebuildConflict.explanation}</p>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>{setRd("goal",rebuildConflict.pending);setRebuildConflict(null);if(rebuildConflictTimer)clearTimeout(rebuildConflictTimer);}} style={{flex:1,background:"var(--lime)",border:"none",borderRadius:8,padding:"9px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:1,color:"var(--black)",cursor:"pointer"}}>Got it</button>
                        <button onClick={()=>{setRebuildConflict(null);if(rebuildConflictTimer)clearTimeout(rebuildConflictTimer);}} style={{flex:1,background:"transparent",border:"1px solid var(--line2)",borderRadius:8,padding:"9px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:1,color:"var(--gray)",cursor:"pointer"}}>Keep {rd.goal}</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* D — Level */}
                <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>D — TRAINING LEVEL</div>
                  <div className="chip-select" style={{marginBottom:12}}>
                    {LEVELS_RD.map(v=>(
                      <button key={v} className={`chip${(rd.level||"").toLowerCase()===v.toLowerCase()?" active":""}`} onClick={()=>setRd("level",v.toLowerCase())}>{v}</button>
                    ))}
                  </div>
                  <div style={{background:"var(--dark)",borderRadius:10,padding:"10px 12px"}}>
                    <div style={{fontFamily:"var(--font-body)",fontSize:12,color:"var(--gray)",lineHeight:1.5}}>Changing your level adjusts sets, reps, and weight recommendations.</div>
                  </div>
                </div>

                {/* E — Equipment */}
                <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>E — EQUIPMENT</div>
                  <div className="chip-select" style={{marginBottom:equipWarning?12:0}}>
                    {EQUIP_RD.map(v=>(
                      <button key={v} className={`chip${(rd.equipment||[]).includes(v)?" active":""}`} onClick={()=>toggleRdArr("equipment",v)}>{v}</button>
                    ))}
                  </div>
                  {equipWarning && (
                    <div style={{background:"rgba(255,159,10,.1)",border:"1px solid rgba(255,159,10,.25)",borderRadius:10,padding:"10px 12px",marginTop:12}}>
                      <div style={{fontFamily:"var(--font-body)",fontSize:12,color:"#FF9F0A",lineHeight:1.5}}>⚠ {equipWarning}</div>
                    </div>
                  )}
                </div>

                {/* Preview diff */}
                {showRebuildPreview && rebuildPreview && (
                  <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>ROUTINE PREVIEW</div>
                    {rebuildPreview.removed.length > 0 && (
                      <div style={{marginBottom:12}}>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--red)",marginBottom:6}}>REMOVED</div>
                        {rebuildPreview.removed.map(n=><div key={n} style={{fontFamily:"var(--font-cond)",fontSize:13,color:"var(--red)",padding:"5px 0",borderBottom:"1px solid var(--line)",opacity:0.8}}>− {n}</div>)}
                      </div>
                    )}
                    {rebuildPreview.added.length > 0 && (
                      <div style={{marginBottom:12}}>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--lime)",marginBottom:6}}>NEW</div>
                        {rebuildPreview.added.map(n=><div key={n} style={{fontFamily:"var(--font-cond)",fontSize:13,color:"var(--lime)",padding:"5px 0",borderBottom:"1px solid var(--line)"}}>+ {n}</div>)}
                      </div>
                    )}
                    {rebuildPreview.unchanged.length > 0 && (
                      <div>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--gray)",marginBottom:6}}>UNCHANGED ({rebuildPreview.unchanged.length})</div>
                        {rebuildPreview.unchanged.slice(0,4).map(n=><div key={n} style={{fontFamily:"var(--font-cond)",fontSize:13,color:"var(--gray2)",padding:"5px 0",borderBottom:"1px solid var(--line)"}}>{n}</div>)}
                        {rebuildPreview.unchanged.length > 4 && <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray2)",paddingTop:6}}>+{rebuildPreview.unchanged.length-4} more</div>}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Bottom actions */}
              <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"rgba(8,8,8,.97)",backdropFilter:"blur(20px)",borderTop:"1px solid var(--line)",padding:"16px 20px max(env(safe-area-inset-bottom),20px)",display:"flex",flexDirection:"column",gap:10,zIndex:151}}>
                <Btn full onClick={handleRebuildConfirm}>REBUILD MY ROUTINE</Btn>
                <button onClick={()=>{const prev=computePreview(rebuildDraft);setRebuildPreview(prev);setShowRebuildPreview(true);}} style={{width:"100%",background:"transparent",border:"1.5px solid rgba(200,241,53,.3)",borderRadius:14,padding:"14px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:14,letterSpacing:2,color:"var(--lime)",cursor:"pointer"}}>PREVIEW CHANGES</button>
              </div>
            </div>
          );
        })()}

        {/* ── Floating chat bubble (only when partner connected) ── */}
        {partnerProfile && (
          <button
            onClick={() => { setChatOpen(o => !o); if (!chatOpen) setChatLastOpenedAt(Date.now()); }}
            style={{
              position:"fixed",
              bottom:82, right:"calc(50% - 215px + 16px)",
              width:52, height:52,
              background:"var(--lime)", border:"none", borderRadius:99,
              display:"flex", alignItems:"center", justifyContent:"center",
              cursor:"pointer", zIndex:60,
              boxShadow:"0 4px 20px rgba(200,241,53,.35)",
              fontSize:22,
            }}
          >
            {chatOpen ? "×" : (
              <>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--black)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                {unreadCount > 0 && (
                  <div style={{
                    position:"absolute", top:-4, right:-4,
                    width:18, height:18, borderRadius:99,
                    background:"#ff3b30", border:"2px solid var(--black)",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontFamily:"var(--font-cond)", fontWeight:900, fontSize:10, color:"white",
                  }}>{unreadCount > 9 ? "9+" : unreadCount}</div>
                )}
              </>
            )}
          </button>
        )}

        {/* ── Floating chat window ── */}
        {chatOpen && partnerProfile && (
          <ChatWindow
            partnerProfile={partnerProfile}
            messages={messages}
            userSlot={userSlot}
            roomCode={roomCode}
            setMessages={setMessages}
          />
        )}

      </div>
    </>
  );
}

export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}
