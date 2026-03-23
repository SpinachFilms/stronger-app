import React, { useState, useEffect, useRef, useMemo } from "react";
import { supabase, isSupabaseConfigured } from "./supabase";

/*
 * MANUAL STEP REQUIRED — run once in your Supabase SQL Editor:
 *   alter publication supabase_realtime add table rooms;
 *   alter table rooms replica identity full;
 */

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

/* ─── Exercise DB for equipment filtering (80+ exercises) ─── */
const EXERCISE_DB = {
  // Chest
  "Barbell Bench Press":    { equipment: ["barbell"], muscles: ["chest"] },
  "Incline DB Press":       { equipment: ["dumbbells"], muscles: ["chest"] },
  "DB Bench Press":         { equipment: ["dumbbells"], muscles: ["chest"] },
  "Dumbbell Press":         { equipment: ["dumbbells"], muscles: ["chest"] },
  "Cable Fly":              { equipment: ["cables"], muscles: ["chest"] },
  "Low Cable Fly":          { equipment: ["cables"], muscles: ["chest"] },
  "DB Fly":                 { equipment: ["dumbbells"], muscles: ["chest"] },
  "Pec Deck":               { equipment: ["machine"], muscles: ["chest"] },
  "Machine Chest Press":    { equipment: ["machine"], muscles: ["chest"] },
  "Chest Dip":              { equipment: ["bodyweight"], muscles: ["chest","triceps"] },
  "Push-Ups":               { equipment: ["bodyweight"], muscles: ["chest"] },
  "Incline Push-Ups":       { equipment: ["bodyweight"], muscles: ["chest"] },
  "Diamond Push-Ups":       { equipment: ["bodyweight"], muscles: ["triceps","chest"] },
  // Shoulders
  "Overhead Press":         { equipment: ["barbell"], muscles: ["shoulders"] },
  "DB Shoulder Press":      { equipment: ["dumbbells"], muscles: ["shoulders"] },
  "Arnold Press":           { equipment: ["dumbbells"], muscles: ["shoulders"] },
  "Machine Shoulder Press": { equipment: ["machine"], muscles: ["shoulders"] },
  "Lateral Raise":          { equipment: ["dumbbells"], muscles: ["shoulders"] },
  "Cable Lateral Raise":    { equipment: ["cables"], muscles: ["shoulders"] },
  "Machine Lateral Raise":  { equipment: ["machine"], muscles: ["shoulders"] },
  "Front Raise":            { equipment: ["dumbbells"], muscles: ["shoulders"] },
  "Cable Front Raise":      { equipment: ["cables"], muscles: ["shoulders"] },
  "Upright Row":            { equipment: ["barbell"], muscles: ["shoulders","traps"] },
  "Face Pull":              { equipment: ["cables"], muscles: ["shoulders"] },
  "Rear Delt Fly":          { equipment: ["dumbbells"], muscles: ["shoulders"] },
  "Cable Rear Delt":        { equipment: ["cables"], muscles: ["shoulders"] },
  "Band Pull-Apart":        { equipment: ["bands"], muscles: ["shoulders"] },
  "Pike Push-Up":           { equipment: ["bodyweight"], muscles: ["shoulders"] },
  // Back
  "Deadlift":               { equipment: ["barbell"], muscles: ["back","hamstrings"] },
  "Pull-Ups":               { equipment: ["bodyweight"], muscles: ["back"] },
  "Chin-Up":                { equipment: ["bodyweight"], muscles: ["back","biceps"] },
  "Lat Pulldown":           { equipment: ["cables"], muscles: ["back"] },
  "Seated Cable Row":       { equipment: ["cables"], muscles: ["back"] },
  "Bent-Over Row":          { equipment: ["barbell"], muscles: ["back"] },
  "Single Arm Row":         { equipment: ["dumbbells"], muscles: ["back"] },
  "T-Bar Row":              { equipment: ["barbell"], muscles: ["back"] },
  "Chest-Supported Row":    { equipment: ["dumbbells"], muscles: ["back"] },
  "Machine Row":            { equipment: ["machine"], muscles: ["back"] },
  "Cable Pullover":         { equipment: ["cables"], muscles: ["back"] },
  "Trap Bar Deadlift":      { equipment: ["barbell"], muscles: ["back","quads"] },
  // Biceps
  "Barbell Curl":           { equipment: ["barbell"], muscles: ["biceps"] },
  "EZ Bar Curl":            { equipment: ["barbell"], muscles: ["biceps"] },
  "Hammer Curl":            { equipment: ["dumbbells"], muscles: ["biceps"] },
  "Dumbbell Curl":          { equipment: ["dumbbells"], muscles: ["biceps"] },
  "Cable Curl":             { equipment: ["cables"], muscles: ["biceps"] },
  "Preacher Curl":          { equipment: ["barbell"], muscles: ["biceps"] },
  "Concentration Curl":     { equipment: ["dumbbells"], muscles: ["biceps"] },
  "Reverse Curl":           { equipment: ["barbell"], muscles: ["biceps","forearms"] },
  // Triceps
  "Tricep Pushdown":        { equipment: ["cables"], muscles: ["triceps"] },
  "Skull Crushers":         { equipment: ["barbell"], muscles: ["triceps"] },
  "Overhead Tricep Extension": { equipment: ["dumbbells"], muscles: ["triceps"] },
  "Cable Overhead Tricep":  { equipment: ["cables"], muscles: ["triceps"] },
  "Tricep Dip":             { equipment: ["bodyweight"], muscles: ["triceps","chest"] },
  "Close-Grip Bench Press": { equipment: ["barbell"], muscles: ["triceps","chest"] },
  // Legs
  "Back Squat":             { equipment: ["barbell"], muscles: ["quads"] },
  "Front Squat":            { equipment: ["barbell"], muscles: ["quads"] },
  "Romanian Deadlift":      { equipment: ["barbell"], muscles: ["hamstrings","glutes"] },
  "Leg Press":              { equipment: ["machine"], muscles: ["quads"] },
  "Hack Squat":             { equipment: ["machine"], muscles: ["quads"] },
  "Leg Curl":               { equipment: ["machine"], muscles: ["hamstrings"] },
  "Leg Extension":          { equipment: ["machine"], muscles: ["quads"] },
  "Calf Raise":             { equipment: ["machine"], muscles: ["calves"] },
  "Seated Calf Raise":      { equipment: ["machine"], muscles: ["calves"] },
  "Single-Leg Calf Raise":  { equipment: ["bodyweight"], muscles: ["calves"] },
  "Hip Thrust":             { equipment: ["barbell"], muscles: ["glutes"] },
  "Glute Bridge":           { equipment: ["bodyweight"], muscles: ["glutes"] },
  "Bulgarian Split Squat":  { equipment: ["dumbbells"], muscles: ["glutes","quads"] },
  "Walking Lunges":         { equipment: ["dumbbells"], muscles: ["quads","glutes"] },
  "Reverse Lunges":         { equipment: ["dumbbells"], muscles: ["quads","glutes"] },
  "Step-Ups":               { equipment: ["dumbbells"], muscles: ["quads","glutes"] },
  "Goblet Squat":           { equipment: ["dumbbells"], muscles: ["quads"] },
  "Nordic Curl":            { equipment: ["bodyweight"], muscles: ["hamstrings"] },
  "Good Mornings":          { equipment: ["barbell"], muscles: ["hamstrings","glutes"] },
  "Box Jump":               { equipment: ["bodyweight"], muscles: ["quads","glutes"] },
  "Sumo Deadlift":          { equipment: ["barbell"], muscles: ["glutes","hamstrings"] },
  // Core
  "Plank":                  { equipment: ["bodyweight"], muscles: ["core"] },
  "Side Plank":             { equipment: ["bodyweight"], muscles: ["core"] },
  "Cable Crunch":           { equipment: ["cables"], muscles: ["core"] },
  "Ab Wheel Rollout":       { equipment: ["bodyweight"], muscles: ["core"] },
  "Hanging Leg Raise":      { equipment: ["bodyweight"], muscles: ["core"] },
  "Russian Twist":          { equipment: ["bodyweight"], muscles: ["core"] },
  "V-Up":                   { equipment: ["bodyweight"], muscles: ["core"] },
  "Dead Bug":               { equipment: ["bodyweight"], muscles: ["core"] },
  "Mountain Climber":       { equipment: ["bodyweight"], muscles: ["core"] },
  // Recovery / mobility
  "Foam Rolling":           { equipment: ["bodyweight"], muscles: ["recovery"] },
  "Hip Flexor Stretch":     { equipment: ["bodyweight"], muscles: ["recovery"] },
  "Pigeon Stretch":         { equipment: ["bodyweight"], muscles: ["recovery"] },
  "Thoracic Rotation":      { equipment: ["bodyweight"], muscles: ["recovery"] },
  // Bodyweight — compound & full-body
  "Burpee":                 { equipment: ["bodyweight"], muscles: ["full_body"] },
  "Jump Squat":             { equipment: ["bodyweight"], muscles: ["quads","glutes"] },
  "Pistol Squat":           { equipment: ["bodyweight"], muscles: ["quads","glutes"] },
  "Bodyweight Squat":       { equipment: ["bodyweight"], muscles: ["quads"] },
  "Lateral Lunge":          { equipment: ["bodyweight"], muscles: ["quads","glutes"] },
  "Reverse Lunge":          { equipment: ["bodyweight"], muscles: ["quads","glutes"] },
  "Wall Sit":               { equipment: ["bodyweight"], muscles: ["quads"] },
  "Single-Leg Glute Bridge":{ equipment: ["bodyweight"], muscles: ["glutes"] },
  "Skater Jump":            { equipment: ["bodyweight"], muscles: ["glutes","quads"] },
  "Plyo Push-Up":           { equipment: ["bodyweight"], muscles: ["chest","triceps"] },
  "Tuck Jump":              { equipment: ["bodyweight"], muscles: ["quads","calves"] },
  "Inchworm":               { equipment: ["bodyweight"], muscles: ["core","hamstrings"] },
  "Superman":               { equipment: ["bodyweight"], muscles: ["back","glutes"] },
  "Bird Dog":               { equipment: ["bodyweight"], muscles: ["core","back"] },
  "Hollow Body Hold":       { equipment: ["bodyweight"], muscles: ["core"] },
  "Jumping Jacks":          { equipment: ["bodyweight"], muscles: ["full_body"] },
  "High Knees":             { equipment: ["bodyweight"], muscles: ["full_body"] },
  "Inverted Row":           { equipment: ["bodyweight"], muscles: ["back"] },
  "Step-Up":                { equipment: ["bodyweight"], muscles: ["quads","glutes"] },
  "Hip Circle":             { equipment: ["bodyweight"], muscles: ["glutes"] },
  "Bear Crawl":             { equipment: ["bodyweight"], muscles: ["core","shoulders"] },
  "Crab Walk":              { equipment: ["bodyweight"], muscles: ["triceps","core"] },
  "L-Sit":                  { equipment: ["bodyweight"], muscles: ["core"] },
  "Broad Jump":             { equipment: ["bodyweight"], muscles: ["quads","glutes"] },
  // Resistance bands
  "Band Squat":             { equipment: ["bands"], muscles: ["quads","glutes"] },
  "Band Deadlift":          { equipment: ["bands"], muscles: ["hamstrings","glutes"] },
  "Band Bicep Curl":        { equipment: ["bands"], muscles: ["biceps"] },
  "Band Tricep Extension":  { equipment: ["bands"], muscles: ["triceps"] },
  "Band Row":               { equipment: ["bands"], muscles: ["back"] },
  "Band Chest Press":       { equipment: ["bands"], muscles: ["chest"] },
  "Band Shoulder Press":    { equipment: ["bands"], muscles: ["shoulders"] },
  "Band Lateral Walk":      { equipment: ["bands"], muscles: ["glutes"] },
  "Band Hip Thrust":        { equipment: ["bands"], muscles: ["glutes"] },
  "Band Good Morning":      { equipment: ["bands"], muscles: ["hamstrings","glutes"] },
  "Band Lat Pulldown":      { equipment: ["bands"], muscles: ["back"] },
  "Band Kickback":          { equipment: ["bands"], muscles: ["glutes"] },
  "Band Overhead Press":    { equipment: ["bands"], muscles: ["shoulders"] },
  "Band Clamshell":         { equipment: ["bands"], muscles: ["glutes"] },
  "Band Face Pull":         { equipment: ["bands"], muscles: ["shoulders"] },
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

/* ─── Goal definitions with training parameters ─── */
const GOAL_CONFIGS = [
  {
    id: 'muscle_mass', label: 'Gain Muscle Mass',
    description: 'Hypertrophy focus — moderate weight, higher volume',
    reps: { beginner:'10-12', intermediate:'8-12', advanced:'6-12' },
    sets: { beginner:3, intermediate:4, advanced:5 },
    rest: { beginner:75, intermediate:90, advanced:90 },
    exercises: { beginner:5, intermediate:7, advanced:9 },
  },
  {
    id: 'strength', label: 'Increase Strength',
    description: 'Heavy compound lifts — low reps, high intensity',
    reps: { beginner:'6-8', intermediate:'4-6', advanced:'3-5' },
    sets: { beginner:3, intermediate:4, advanced:6 },
    rest: { beginner:120, intermediate:150, advanced:180 },
    exercises: { beginner:5, intermediate:6, advanced:7 },
  },
  {
    id: 'fitness', label: 'Improve Physical Fitness',
    description: 'Balanced training — strength and conditioning',
    reps: { beginner:'10-15', intermediate:'10-12', advanced:'8-12' },
    sets: { beginner:3, intermediate:3, advanced:4 },
    rest: { beginner:60, intermediate:60, advanced:75 },
    exercises: { beginner:6, intermediate:7, advanced:8 },
  },
  {
    id: 'definition', label: 'Definition',
    description: 'Sculpt and define — moderate weight, high reps',
    reps: { beginner:'12-15', intermediate:'12-15', advanced:'12-20' },
    sets: { beginner:3, intermediate:4, advanced:4 },
    rest: { beginner:45, intermediate:45, advanced:30 },
    exercises: { beginner:6, intermediate:8, advanced:9 },
  },
  {
    id: 'toning', label: 'Body Toning',
    description: 'Light resistance, high reps — firm and tone',
    reps: { beginner:'15-20', intermediate:'15-20', advanced:'15-20' },
    sets: { beginner:2, intermediate:3, advanced:4 },
    rest: { beginner:30, intermediate:30, advanced:30 },
    exercises: { beginner:6, intermediate:7, advanced:8 },
  },
  {
    id: 'cardio', label: 'Cardiovascular',
    description: 'Circuit style — keep heart rate elevated',
    reps: { beginner:'15-20', intermediate:'20', advanced:'20+' },
    sets: { beginner:2, intermediate:3, advanced:4 },
    rest: { beginner:30, intermediate:20, advanced:15 },
    exercises: { beginner:6, intermediate:8, advanced:10 },
  },
  {
    id: 'fat_loss', label: 'Weight / Fat Loss',
    description: 'High volume circuits — maximize calorie burn',
    reps: { beginner:'12-15', intermediate:'15', advanced:'15-20' },
    sets: { beginner:3, intermediate:4, advanced:4 },
    rest: { beginner:45, intermediate:30, advanced:20 },
    exercises: { beginner:6, intermediate:8, advanced:9 },
  },
  {
    id: 'active', label: 'Stay Active',
    description: 'Enjoyable movement — health and wellbeing',
    reps: { beginner:'10-15', intermediate:'10-15', advanced:'12-15' },
    sets: { beginner:2, intermediate:3, advanced:3 },
    rest: { beginner:60, intermediate:60, advanced:60 },
    exercises: { beginner:5, intermediate:6, advanced:7 },
  },
];
// Helper: look up goal config by id or label (supports both legacy label and new id)
const getGoalConfig = (goalIdOrLabel) => {
  if (!goalIdOrLabel) return GOAL_CONFIGS[0];
  return GOAL_CONFIGS.find(g => g.id === goalIdOrLabel || g.label === goalIdOrLabel) || GOAL_CONFIGS[0];
};

/* ─── Routine builder (2–6 days) ─── */
const buildRoutine = (profile, partnerProfile = null) => {
  const level   = (profile.level || "intermediate").toLowerCase();
  const levelKey = level === "advanced" ? "advanced" : level === "beginner" ? "beginner" : "intermediate";
  const goalCfg  = getGoalConfig(profile.goal);
  const goalSets = goalCfg.sets[levelKey] || 3;
  const goalReps = goalCfg.reps[levelKey] || "8-12";
  const goalRest = goalCfg.rest[levelKey] || 75;
  const days  = parseInt(profile.daysPerWeek) || 3;
  const yw    = parseInt(profile.weight) || 80;
  const pw    = partnerProfile?.weight ? parseInt(partnerProfile.weight) : null;
  const wA    = (m) => `${Math.round(yw * m)}kg`;
  const wB    = (m) => pw ? `${Math.round(pw * m)}kg` : "— kg";
  const beg   = levelKey === "beginner";
  // Apply goal-aware set/rep overrides to an exercise definition
  const applyGoal = (ex) => ({ ...ex, sets: goalSets, reps: goalReps, rest: goalRest });
  const equip = profile.equipment || [];
  const splitPref = profile.splitPreference || "Balanced";
  const prioMuscles = profile.priorityMuscles || [];
  const trainingDays = profile.trainingDays || null;

  // Bodyweight fallback pool — used to pad days when equipment filter removes too many exercises
  const BW_FALLBACK_POOL = [
    { name:"Push-Ups",          muscles:"CHEST",     sets:3, reps:"10–15", rest:60, wA:"BW", wB:"BW", rpe:5 },
    { name:"Bodyweight Squat",  muscles:"QUADS",     sets:3, reps:"15–20", rest:45, wA:"BW", wB:"BW", rpe:4 },
    { name:"Inverted Row",      muscles:"BACK",      sets:3, reps:"8–12",  rest:60, wA:"BW", wB:"BW", rpe:6 },
    { name:"Glute Bridge",      muscles:"GLUTES",    sets:3, reps:"12–15", rest:45, wA:"BW", wB:"BW", rpe:5 },
    { name:"Plank",             muscles:"CORE",      sets:3, reps:"30–60s",rest:45, wA:"BW", wB:"BW", rpe:5 },
    { name:"Burpee",            muscles:"FULL BODY", sets:3, reps:"8–12",  rest:60, wA:"BW", wB:"BW", rpe:7 },
    { name:"Jump Squat",        muscles:"QUADS",     sets:3, reps:"10–15", rest:60, wA:"BW", wB:"BW", rpe:6 },
    { name:"Tricep Dip",        muscles:"TRICEPS",   sets:3, reps:"10–12", rest:60, wA:"BW", wB:"BW", rpe:6 },
    { name:"Dead Bug",          muscles:"CORE",      sets:3, reps:"10–12", rest:45, wA:"BW", wB:"BW", rpe:4 },
    { name:"Mountain Climber",  muscles:"CORE",      sets:3, reps:"20–30", rest:45, wA:"BW", wB:"BW", rpe:6 },
  ];
  const filterEx = (exercises) => {
    const filtered = exercises.filter(e => equipmentAllowed(e.name, equip)).map(applyGoal);
    if (filtered.length >= 3) return filtered;
    const existing = new Set(filtered.map(e => e.name));
    const extras = BW_FALLBACK_POOL.filter(e => !existing.has(e.name)).slice(0, 3 - filtered.length);
    return [...filtered, ...extras.map(applyGoal)];
  };

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

/* ─── FIX 2 — Week schedule builder ─── */
const buildWeekSchedule = (trainingDays, routineLength) => {
  const ALL = ["MON","TUE","WED","THU","FRI","SAT","SUN"];
  const schedule = {};
  ALL.forEach(d => { schedule[d] = null; });
  (trainingDays || []).forEach((d, i) => {
    schedule[d] = i % routineLength;
  });
  return schedule;
};

/* ─── FIX 5 — Cool-down buffer options ─── */
const BUFFER_OPTIONS = [
  { id:'stretching', titleKey:'buffer_stretch_title', descKey:'buffer_stretch_desc', duration:'10 MIN',
    exercises:[
      {name:'Hip Flexor Stretch',duration:60,side:true},{name:'Hamstring Stretch',duration:60,side:true},
      {name:'Chest Doorway Stretch',duration:45},{name:'Lat Stretch',duration:45,side:true},
      {name:'Quad Stretch',duration:45,side:true},{name:'Shoulder Cross-Body Stretch',duration:45,side:true},
      {name:"Child's Pose",duration:60},{name:'Pigeon Pose',duration:60,side:true},
      {name:'Thoracic Rotation',duration:45,side:true},{name:'Standing Calf Stretch',duration:30,side:true},
    ]},
  { id:'abs', titleKey:'buffer_abs_title', descKey:'buffer_abs_desc', duration:'12 MIN',
    exercises:[
      {name:'Plank',sets:3,duration:45},{name:'Bicycle Crunch',sets:3,reps:20},
      {name:'Leg Raises',sets:3,reps:15},{name:'Russian Twist',sets:3,reps:20},
      {name:'Dead Bug',sets:3,reps:12},{name:'Side Plank',sets:2,duration:30,side:true},
      {name:'Mountain Climber',sets:3,duration:30},{name:'Hollow Body Hold',sets:3,duration:20},
    ]},
  { id:'cardio', titleKey:'buffer_cardio_title', descKey:'buffer_cardio_desc', duration:'15 MIN',
    exercises:[
      {name:'Jump Rope / Running in place',duration:180},{name:'Burpees',sets:3,reps:10},
      {name:'High Knees',duration:60},{name:'Jump Squats',sets:3,reps:12},
      {name:'Mountain Climbers',duration:45},{name:'Jumping Jacks',duration:60},
    ]},
];

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

/* ─── Sheet wrapper for bottom sheets on home screen ─── */
const SheetWrapper = ({ children, onClose }) => (
  <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,backdropFilter:"blur(4px)"}}>
    <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#181818",borderRadius:"24px 24px 0 0",padding:28,animation:"slideIn .3s cubic-bezier(.4,0,.2,1)",maxHeight:"85vh",overflowY:"auto"}}>
      {children}
    </div>
  </div>
);

/* ════════════════════════════════════════════
   ERROR BOUNDARY — catches React render errors gracefully
════════════════════════════════════════════ */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error, info) { console.warn('App error caught:', error.message); }

  handleRestart = () => {
    // Keep profile, PIN, routine, history — only clear volatile session state
    const keysToKeep = ['str_profile','str_pin','str_routine','str_summary',
                        'str_room_code','str_user_slot','str_join_token',
                        'str_history','str_weight_log','str_prs','str_enc_key',
                        'str_messages'];
    const saved = {};
    keysToKeep.forEach(k => { const v = localStorage.getItem(k); if (v) saved[k] = v; });
    localStorage.clear();
    Object.entries(saved).forEach(([k, v]) => localStorage.setItem(k, v));
    // Always remove volatile crash-causing session keys
    localStorage.removeItem('str_active_session');
    localStorage.removeItem('str_current_session_id');
    window.location.reload();
  };

  handleNuclear = () => {
    localStorage.clear();
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ background:'#080808', minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:32, fontFamily:"'Barlow Condensed',sans-serif", textAlign:'center' }}>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:52, color:'#FAFAFA', lineHeight:0.9, marginBottom:16 }}>
            SOMETHING<br/>WENT WRONG
          </div>
          <p style={{ color:'#888', fontSize:15, marginBottom:40, lineHeight:1.6, fontFamily:"'Barlow',sans-serif" }}>
            An error occurred. Your profile and workout history are safe.
          </p>
          <button onClick={this.handleRestart}
            style={{ background:'#C8F135', border:'none', borderRadius:14, padding:'16px 0',
                     width:'100%', maxWidth:320, fontFamily:"'Barlow Condensed',sans-serif",
                     fontWeight:900, fontSize:16, letterSpacing:2, color:'#080808',
                     cursor:'pointer', marginBottom:12 }}>
            RESTART APP
          </button>
          <button onClick={this.handleNuclear}
            style={{ background:'transparent', border:'1px solid #333', borderRadius:14,
                     padding:'14px 0', width:'100%', maxWidth:320,
                     fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700,
                     fontSize:14, letterSpacing:2, color:'#555', cursor:'pointer' }}>
            CLEAR ALL DATA &amp; START OVER
          </button>
          <p style={{ color:'#333', fontSize:11, marginTop:20 }}>
            "Clear all data" only if Restart doesn't work
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const STRINGS = {
  en: {
    welcome: "Welcome to Stronger",
    create_account: "Create Account",
    log_in: "Log In",
    good_morning: "Good Morning",
    good_afternoon: "Good Afternoon",
    good_evening: "Good Evening",
    today: "TODAY",
    routine: "ROUTINE",
    partner: "PARTNER",
    progress: "PROGRESS",
    rest_day: "REST DAY",
    start_workout: "START WORKOUT",
    complete_set: "COMPLETE SET",
    next_exercise: "NEXT EXERCISE →",
    finish_workout: "FINISH WORKOUT",
    stop: "STOP",
    swap: "SWAP",
    sets: "SETS",
    reps: "REPS",
    weight: "WEIGHT",
    rest: "REST",
    ai_coach: "AI COACH",
    settings: "SETTINGS",
    name: "Name",
    age: "Age",
    your_goal: "Your Goal",
    your_level: "Training Level",
    equipment: "Equipment",
    training_days: "Training Days",
    invite_partner: "Invite My Partner",
    join_partner: "Join a Partner",
    room_code: "Room Code",
    train_together: "TRAIN TOGETHER?",
    leave: "LEAVE",
    not_training: "NOT TRAINING",
    training_now: "TRAINING NOW",
    last_seen_today: "LAST SEEN TODAY",
    no_workouts_yet: "No workouts logged yet.",
    rebuild_routine: "REBUILD ROUTINE",
    regenerate: "REGENERATE ROUTINE",
    save: "SAVE",
    cancel: "CANCEL",
    confirm: "CONFIRM",
    back: "Back",
    week: "WEEK",
    streak: "STREAK",
    workouts: "WORKOUTS",
    volume: "VOLUME",
    first_time: "First time — start conservative",
    last_time: "Last time",
    try_today: "Try",
    days_per_week: "days/week plan",
    send: "Send",
    type_message: "Type a message...",
    quick_replies: ["Set done ✓", "Need help", "On my way", "Rest", "Good job!"],
    enter_pin: "Enter PIN",
    wrong_pin: "Wrong PIN",
    create_pin: "Create PIN",
    confirm_pin: "Confirm PIN",
    pins_dont_match: "PINs don't match",
    logout: "Log Out",
    logout_erase: "Log Out & Erase Everything",
    workout_complete: "WORKOUT COMPLETE",
    personal_record: "NEW PR",
    something_went_wrong: "SOMETHING WENT WRONG",
    restart_app: "RESTART APP",
    clear_data: "CLEAR ALL DATA & START OVER",
    whats_your_name: "What's your name?",
    how_old: "How old are you?",
    your_weight: "Your weight",
    your_height: "Your height",
    biological_sex: "Biological sex",
    male: "Male",
    female: "Female",
    beginner: "Beginner",
    intermediate: "Intermediate",
    advanced: "Advanced",
    next: "NEXT",
    generating_routine: "Building your personalized routine...",
    routine_ready: "Your routine is ready",
    // Goals
    muscle_mass: "Gain Muscle Mass",
    increase_strength: "Increase Strength",
    improve_fitness: "Improve Physical Fitness",
    definition: "Definition",
    toning: "Body Toning",
    cardio: "Cardiovascular",
    fat_loss: "Weight / Fat Loss",
    stay_active: "Stay Active",
    // Equipment
    dumbbells: "Dumbbells only",
    resistance_bands: "Resistance bands",
    barbell_rack: "Barbell + rack",
    cables: "Cables",
    machines: "Machines",
    bodyweight: "Bodyweight",
    full_gym: "Full gym",
    // Day type labels
    push_day: "Push Day",
    pull_day: "Pull Day",
    legs_day: "Legs Day",
    full_body_a: "Full Body A",
    full_body_b: "Full Body B",
    upper_body: "Upper Body",
    lower_body: "Lower Body",
    // Workout end/pause sheet
    resume_later: "Resume Later",
    end_workout_now: "End Workout Now",
    keep_going: "Keep Going",
    // Gender options
    prefer_not_to_say: "Prefer not to say",
    // Partner tab
    close_room: "CLOSE ROOM",
    leave_room: "Leave Room",
    copy_code: "Copy Invite Link",
    copied: "✓ Copied!",
    no_partner_yet: "NO PARTNER YET",
    // Today/Rest day
    light_stretching: "LIGHT STRETCHING ROUTINE",
    log_weight: "+ LOG WEIGHT",
    // Days of week
    days_of_week: ["MON","TUE","WED","THU","FRI","SAT","SUN"],
    days_of_week_short: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],
    // Month abbreviations
    month_abbr: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
    // Settings labels
    units: "Units",
    kg: "KG",
    lbs: "LBS",
    notifications: "Notifications",
    language: "Language",
    account: "Account",
    theme: "Theme",
    // Onboarding
    skip: "Skip",
    name_placeholder: "Your name...",
    age_placeholder: "Age",
    weight_placeholder: "Weight",
    height_placeholder: "Height",
    // Progress tab
    total_workouts: "Total Workouts",
    current_streak: "Current Streak",
    best_streak: "Best Streak",
    total_volume: "Total Volume",
    month: "Month",
    all_time: "All Time",
    // Error/toast messages
    error_saving: "Error saving",
    saved: "Saved!",
    profile_saved: "Profile saved",
    pin_changed: "PIN changed",
    room_closed: "Room closed",
    left_the_room: "Left the room",
    error_loading: "Error loading data",
    network_error: "Network error",
    // Misc
    are_you_sure: "Are you sure?",
    yes: "Yes",
    no: "No",
    done: "DONE",
    edit: "Edit",
    delete: "Delete",
    add: "Add",
    ok: "OK",
    // Workout UI
    skip_rest: "SKIP REST",
    sec: "SEC",
    analyzing: "ANALYZING...",
    partner_label: "PARTNER",
    close: "CLOSE",
    not_training_yet: "Not training yet",
    pain_btn: "⚠️ I FEEL PAIN",
    swap_exercise: "SWAP EXERCISE",
    how_did_it_feel: "HOW DID IT FEEL? (OPTIONAL)",
    // Home screen
    ai_coach_note: "AI COACH NOTE",
    active_session: "ACTIVE SESSION",
    resume: "RESUME",
    week_plan: "DAYS/WEEK PLAN",
    // Settings screen
    edit_profile: "EDIT PROFILE",
    training_days_label: "TRAINING DAYS",
    security: "SECURITY",
    change_pin: "CHANGE PIN",
    enter_current_pin: "ENTER CURRENT PIN",
    new_pin: "NEW PIN",
    confirm_new_pin: "CONFIRM NEW PIN",
    verify: "VERIFY",
    save_new_pin: "SAVE NEW PIN",
    routine_section: "ROUTINE",
    customize_routine: "CUSTOMIZE ROUTINE",
    quick_rebuild: "QUICK REBUILD",
    save_profile: "SAVE PROFILE",
    injuries_label: "INJURIES / LIMITATIONS",
    // Partner screen
    generate_room_code: "Generate My Room Code",
    partner_not_connected: "PARTNER NOT\nCONNECTED",
    waiting_for_partner: "WAITING FOR PARTNER...",
    join_a_partner: "JOIN A PARTNER",
    your_room_code: "YOUR ROOM CODE",
    // Onboarding steps
    step_1_of_7: "STEP 1 OF 7",
    step_2_of_7: "STEP 2 OF 7",
    step_3_of_7: "STEP 3 OF 7",
    step_4_of_7: "STEP 4 OF 7",
    step_5_of_7: "STEP 5 OF 7",
    step_6_of_7: "STEP 6 OF 7",
    step_7_of_7: "STEP 7 OF 7",
    continue_btn: "Continue",
    skip_go_solo: "Skip — Go Solo",
    continue_solo: "Continue Solo for Now",
    // Rebuild modal
    rebuild_routine_title: "REBUILD\nROUTINE",
    rebuild_my_routine: "REBUILD MY ROUTINE",
    preview_changes: "PREVIEW CHANGES",
    // Sign out
    sign_out: "SIGN OUT",
    // No messages
    no_messages_yet: "No messages yet",
    // Onboarding hardcoded
    join_btn: "JOIN",
    or_label: "OR",
    enter_partners_code: "ENTER PARTNER'S CODE",
    your_profile_summary: "YOUR PROFILE SUMMARY",
    who_are_you_title: "WHO\nARE\nYOU?",
    just_you_here: "Just you here. Your partner creates their own profile separately.",
    create_4_digit_pin: "CREATE A 4-DIGIT PIN",
    protects_profile: "Protects your profile when you hand off your phone.",
    confirm_pin_label: "CONFIRM PIN",
    your_stats_title: "YOUR\nSTATS",
    calibrate_desc: "Used to calibrate your weights and rest times.",
    age_label: "AGE",
    weight_label_upper: "WEIGHT",
    height_label_upper: "HEIGHT",
    biological_sex_label: "BIOLOGICAL SEX",
    your_goals_title: "YOUR\nGOALS",
    what_training_for: "What are you training for",
    primary_goal_label: "PRIMARY GOAL",
    training_level_label: "TRAINING LEVEL",
    what_to_build_title: "WHAT DO\nYOU WANT\nTO BUILD?",
    select_focus_areas: "Select the areas you want to focus on most.",
    upper_body_label: "UPPER BODY",
    lower_body_label: "LOWER BODY",
    split_focus_label: "SPLIT FOCUS",
    your_gym_title: "YOUR\nGYM",
    when_what_train: "When and what do you train with?",
    days_per_week_label: "DAYS PER WEEK",
    training_days_upper: "TRAINING DAYS",
    available_equipment_label: "AVAILABLE EQUIPMENT (select all)",
    any_limits_title: "ANY\nLIMITS?",
    injuries_desc: "Any injuries or areas to avoid? The AI will work around them.",
    injuries_optional_label: "INJURIES / LIMITATIONS (optional)",
    schedule_label: "Schedule",
    equipment_label: "Equipment",
    connect_partner_title: "CONNECT\nPARTNER",
    connect_partner_desc: "Connect with your partner to sync routines and weights — or go solo and connect later.",
    your_room_code_label: "YOUR ROOM CODE",
    waiting_for_partner_label: "WAITING FOR PARTNER...",
    back_label: "← BACK",
    prev_label: "← PREV",
    continue_btn_label: "Continue",
    // Workout UI hardcoded
    sec_label: "SEC",
    skip_rest_btn: "SKIP REST",
    partner_btn: "PARTNER",
    analyzing_label: "ANALYZING...",
    close_btn: "CLOSE",
    no_partner_yet_label: "NO PARTNER YET",
    share_room_from_partner: "Share your room code from the Partner tab to connect.",
    stop_label: "STOP?",
    progress_saved: "Your progress is saved. You can always come back.",
    swap_exercise_title: "SWAP EXERCISE",
    for_today_only: "FOR TODAY ONLY — YOUR ROUTINE STAYS UNCHANGED",
    how_did_feel_label: "HOW DID IT FEEL? (OPTIONAL)",
    done_btn: "DONE",
    // Home screen hardcoded
    ai_coach_note_label: "AI COACH NOTE",
    active_session_label: "ACTIVE SESSION",
    sets_completed_label: "SETS COMPLETED",
    resume_btn: "RESUME",
    week1_label: "WEEK 1",
    days_week_plan: "DAYS/WEEK PLAN",
    start_first: "START YOUR FIRST",
    workouts_label: "WORKOUTS",
    // Rest day
    light_stretching_btn: "LIGHT STRETCHING ROUTINE",
    partners_last_workout: "S LAST WORKOUT",
    // Routine tab
    ai_generated_month1: "AI GENERATED · MONTH 1",
    customize_btn: "CUSTOMIZE",
    your_routine_title: "YOUR ROUTINE",
    exercises_count_label: "EXERCISES",
    min_label: "MIN",
    // Partner tab
    close_room_btn: "CLOSE ROOM",
    partner_not_connected_title: "PARTNER NOT\nCONNECTED",
    share_code_desc: "Share your room code so your partner can join, or enter their code below.",
    how_to_connect_label: "HOW TO CONNECT",
    how_to_connect_desc: "Share your code with your partner. They open the app, go to the Partner tab, and enter it manually.",
    join_a_partner_label: "JOIN A PARTNER",
    training_now_label: "TRAINING NOW",
    not_training_label: "NOT TRAINING",
    exercises_label: "EXERCISES",
    sets_done_label: "SETS DONE",
    weight_label: "WEIGHT",
    elapsed_label: "ELAPSED",
    cheer_on_btn: "Cheer them on",
    last_workout_label: "LAST WORKOUT",
    train_together_btn: "Train together?",
    // Progress tab
    body_weight_label: "BODY WEIGHT",
    log_weight_btn: "+ LOG WEIGHT",
    storage_warning_label: "STORAGE WARNING",
    storage_full_desc: "Storage almost full — consider removing older photos.",
    log_weight_title: "LOG WEIGHT",
    save_btn: "SAVE",
    add_photo_label: "ADD PHOTO",
    share_btn: "SHARE",
    sets_stat: "SETS",
    exer_stat: "EXER.",
    time_stat: "TIME",
    max_wt_stat: "MAX WT",
    volume_stat: "VOLUME",
    // Settings hardcoded
    back_settings: "← BACK",
    edit_profile_label: "EDIT PROFILE",
    name_label_upper: "NAME",
    weight_upper: "WEIGHT",
    age_upper: "AGE",
    height_upper: "HEIGHT",
    injuries_limitations_label: "INJURIES / LIMITATIONS",
    save_profile_btn: "SAVE PROFILE",
    training_days_settings: "TRAINING DAYS",
    security_label: "SECURITY",
    change_pin_btn: "CHANGE PIN",
    enter_current_pin_label: "ENTER CURRENT PIN",
    new_pin_label: "NEW PIN",
    confirm_new_pin_label: "CONFIRM NEW PIN",
    verify_btn: "VERIFY",
    next_btn: "NEXT",
    cancel_btn: "CANCEL",
    save_new_pin_btn: "SAVE NEW PIN",
    routine_settings_label: "ROUTINE",
    customize_routine_btn: "CUSTOMIZE ROUTINE",
    quick_rebuild_btn: "QUICK REBUILD",
    // Conflict modal
    active_session_title: "ACTIVE SESSION",
    resume_current: "Resume Current Session",
    end_start_new: "End It & Start New",
    // Rebuild modal
    rebuild_routine_title_upper: "REBUILD\nROUTINE",
    active_workout_label: "ACTIVE WORKOUT",
    active_workout_desc: "You have a workout in progress. Rebuilding will end your current session.",
    section_training_days: "A — TRAINING DAYS",
    section_muscle_focus: "B — MUSCLE FOCUS",
    section_primary_goal: "C — PRIMARY GOAL",
    section_training_level: "D — TRAINING LEVEL",
    section_equipment: "E — EQUIPMENT",
    days_per_week_upper: "DAYS PER WEEK",
    training_days_upper2: "TRAINING DAYS",
    upper_body_upper: "UPPER BODY",
    lower_body_upper: "LOWER BODY",
    split_focus_upper: "SPLIT FOCUS",
    routine_preview_label: "ROUTINE PREVIEW",
    removed_label: "REMOVED",
    new_label: "NEW",
    rebuild_my_routine_btn: "REBUILD MY ROUTINE",
    preview_changes_btn: "PREVIEW CHANGES",
    customize_label: "CUSTOMIZE",
    cancel_arrow: "← CANCEL",
    // Rebuild success
    routine_rebuilt: "✓ ROUTINE REBUILT",
    // Stretching sheet
    stretching_title: "STRETCHING",
    light_recovery_routine: "LIGHT RECOVERY ROUTINE",
    // Logout modal
    sign_out_title: "SIGN OUT",
    sign_out_desc: "Your routine and partner connection are saved in this browser.",
    // Workout complete
    exercises_upper: "EXERCISES",
    time_upper: "TIME",
    // Onboarding continue buttons
    got_it: "Got it",
    keep_goal: "Keep",
    // Onboarding screen titles
    who_are_you: "WHO ARE YOU?",
    your_stats: "YOUR STATS",
    your_goals: "YOUR GOALS",
    what_to_build: "WHAT DO YOU WANT TO BUILD?",
    your_gym: "YOUR GYM",
    any_limits: "ANY LIMITS?",
    connect_partner: "CONNECT PARTNER",
    // Field labels
    your_name_label: "YOUR NAME",
    create_pin_label: "CREATE A 4-DIGIT PIN",
    confirm_pin_label2: "CONFIRM PIN",
    age_label2: "AGE",
    weight_label2: "WEIGHT",
    height_label2: "HEIGHT",
    height_label: "HEIGHT",
    biological_sex_label2: "BIOLOGICAL SEX",
    training_level_label2: "TRAINING LEVEL",
    training_days_label2: "TRAINING DAYS",
    injuries_label2: "INJURIES / LIMITATIONS (optional)",
    injuries_placeholder: "e.g. left knee pain, lower back issues...",
    // Sex options
    male_opt: "Male",
    female_opt: "Female",
    other_opt: "Other",
    // Goal names
    goal_muscle_mass: "Gain Muscle Mass",
    goal_strength: "Increase Strength",
    goal_fitness: "Improve Physical Fitness",
    goal_definition: "Definition",
    goal_toning: "Body Toning",
    goal_cardio: "Cardiovascular",
    goal_fat_loss: "Weight / Fat Loss",
    goal_active: "Stay Active",
    // Level names
    level_beginner: "Beginner",
    level_intermediate: "Intermediate",
    level_advanced: "Advanced",
    // Muscle groups
    muscle_chest: "Chest",
    muscle_back: "Back",
    muscle_shoulders: "Shoulders",
    muscle_arms: "Arms",
    muscle_core: "Core",
    muscle_glutes: "Glutes",
    muscle_quads: "Quads",
    muscle_hamstrings: "Hamstrings",
    muscle_calves: "Calves",
    muscle_full_lower: "Full Lower Body",
    // Split options
    split_balanced: "Balanced",
    split_more_lower: "More lower body",
    split_more_upper: "More upper body",
    split_full_body: "Full body",
    // Equipment options
    equip_full_gym: "Full gym",
    equip_dumbbells: "Dumbbells only",
    equip_barbell: "Barbell + rack",
    equip_cables: "Cables",
    equip_machines: "Machines",
    equip_bands: "Resistance bands",
    // Workout day type names
    day_push: "Push Day",
    day_pull: "Pull Day",
    day_legs: "Legs Day",
    day_upper: "Upper Body",
    day_lower: "Lower Body",
    day_full_body_a: "Full Body A",
    day_full_body_b: "Full Body B",
    day_full_body_c: "Full Body C",
    // Muscle label abbreviations
    muscle_tris: "TRIS",
    muscle_bis: "BICEPS",
    muscle_rear_delt: "REAR DELT",
    muscle_lats: "LATS",
    muscle_posterior: "POSTERIOR CHAIN",
    muscle_upper_chest: "UPPER CHEST",
    muscle_side_delt: "SIDE DELT",
    muscle_triceps: "TRICEPS",
    // Summary card
    schedule_label2: "Schedule",
    equipment_label2: "Equipment",
    days_week_suffix: "days/week",
    // AI Coach note
    ai_coach_default: "Your personalized routine is ready. Progressive overload built in — you'll be stronger every week.",
    // Count labels
    exercises_count: "EXERCISES",
    approx_min: "MIN",
    // FIX 2
    edit_schedule: "EDIT SCHEDULE",
    assign_workouts: "ASSIGN YOUR WORKOUTS",
    // FIX 3
    can_you_lift: "Can you lift",
    yes_i_can: "Yes, I can",
    no_adjust: "No, adjust",
    adjust_weight: "ADJUST WEIGHT",
    use_this_weight: "USE THIS WEIGHT",
    // FIX 4
    train_invite_sent: "Invite sent to {name}! Go to Today to start.",
    wants_to_train: "WANTS TO TRAIN TOGETHER!",
    // FIX 5
    while_you_wait: "WHILE YOU WAIT",
    partner_still_training: "STILL TRAINING",
    sets_left: "sets left",
    buffer_stretch_title: "Full Body Stretching",
    buffer_stretch_desc: "Recover and stay loose",
    buffer_abs_title: "Core & Abs Blast",
    buffer_abs_desc: "10 min ab finisher",
    buffer_cardio_title: "Cardio Finisher",
    buffer_cardio_desc: "Keep the heart rate up",
    // Day abbreviations for FIX 8
    day_mon: "MON",
    day_tue: "TUE",
    day_wed: "WED",
    day_thu: "THU",
    day_fri: "FRI",
    day_sat: "SAT",
    day_sun: "SUN",
  },
  es: {
    welcome: "Bienvenido a Stronger",
    create_account: "Crear Cuenta",
    log_in: "Iniciar Sesión",
    good_morning: "Buenos Días",
    good_afternoon: "Buenas Tardes",
    good_evening: "Buenas Noches",
    today: "HOY",
    routine: "RUTINA",
    partner: "PAREJA",
    progress: "PROGRESO",
    rest_day: "DÍA DE DESCANSO",
    start_workout: "INICIAR ENTRENAMIENTO",
    complete_set: "COMPLETAR SERIE",
    next_exercise: "SIGUIENTE EJERCICIO →",
    finish_workout: "FINALIZAR ENTRENAMIENTO",
    stop: "PARAR",
    swap: "CAMBIAR",
    sets: "SERIES",
    reps: "REPS",
    weight: "PESO",
    rest: "DESCANSO",
    ai_coach: "ENTRENADOR IA",
    settings: "AJUSTES",
    name: "Nombre",
    age: "Edad",
    your_goal: "Tu Objetivo",
    your_level: "Nivel de Entrenamiento",
    equipment: "Equipamiento",
    training_days: "Días de Entrenamiento",
    invite_partner: "Invitar a Mi Pareja",
    join_partner: "Unirse a una Pareja",
    room_code: "Código de Sala",
    train_together: "¿ENTRENAR JUNTOS?",
    leave: "SALIR",
    not_training: "SIN ENTRENAR",
    training_now: "ENTRENANDO AHORA",
    last_seen_today: "VISTO HOY",
    no_workouts_yet: "Aún no hay entrenamientos.",
    rebuild_routine: "RECONSTRUIR RUTINA",
    regenerate: "REGENERAR RUTINA",
    save: "GUARDAR",
    cancel: "CANCELAR",
    confirm: "CONFIRMAR",
    back: "Atrás",
    week: "SEMANA",
    streak: "RACHA",
    workouts: "ENTRENOS",
    volume: "VOLUMEN",
    first_time: "Primera vez — empieza con poco peso",
    last_time: "Última vez",
    try_today: "Prueba",
    days_per_week: "días/semana",
    send: "Enviar",
    type_message: "Escribe un mensaje...",
    quick_replies: ["Serie lista ✓", "Necesito ayuda", "Ya voy", "Descanso", "¡Buen trabajo!"],
    enter_pin: "Ingresa tu PIN",
    wrong_pin: "PIN incorrecto",
    create_pin: "Crear PIN",
    confirm_pin: "Confirmar PIN",
    pins_dont_match: "Los PINs no coinciden",
    logout: "Cerrar Sesión",
    logout_erase: "Cerrar Sesión y Borrar Todo",
    workout_complete: "ENTRENAMIENTO COMPLETADO",
    personal_record: "NUEVO RÉCORD",
    something_went_wrong: "ALGO SALIÓ MAL",
    restart_app: "REINICIAR APP",
    clear_data: "BORRAR TODO Y EMPEZAR DE NUEVO",
    whats_your_name: "¿Cómo te llamas?",
    how_old: "¿Cuántos años tienes?",
    your_weight: "Tu peso",
    your_height: "Tu altura",
    biological_sex: "Sexo biológico",
    male: "Hombre",
    female: "Mujer",
    beginner: "Principiante",
    intermediate: "Intermedio",
    advanced: "Avanzado",
    next: "SIGUIENTE",
    generating_routine: "Creando tu rutina personalizada...",
    routine_ready: "Tu rutina está lista",
    // Goals
    muscle_mass: "Ganar Masa Muscular",
    increase_strength: "Aumentar Fuerza",
    improve_fitness: "Mejorar Condición Física",
    definition: "Definición",
    toning: "Tonificación",
    cardio: "Cardiovascular",
    fat_loss: "Pérdida de Peso / Grasa",
    stay_active: "Mantenerse Activo",
    // Equipment
    dumbbells: "Mancuernas",
    resistance_bands: "Bandas Elásticas",
    barbell_rack: "Barra + Rack",
    cables: "Poleas",
    machines: "Máquinas",
    bodyweight: "Peso Corporal",
    full_gym: "Gimnasio Completo",
    // Day type labels
    push_day: "Día de Empuje",
    pull_day: "Día de Jalón",
    legs_day: "Día de Piernas",
    full_body_a: "Cuerpo Completo A",
    full_body_b: "Cuerpo Completo B",
    upper_body: "Tren Superior",
    lower_body: "Tren Inferior",
    // Workout end/pause sheet
    resume_later: "Continuar después",
    end_workout_now: "Terminar entrenamiento",
    keep_going: "Seguir entrenando",
    // Gender options
    prefer_not_to_say: "Prefiero no decir",
    // Partner tab
    close_room: "CERRAR SALA",
    leave_room: "Salir de la Sala",
    copy_code: "Copiar Enlace de Invitación",
    copied: "✓ ¡Copiado!",
    no_partner_yet: "AÚN SIN PAREJA",
    // Today/Rest day
    light_stretching: "RUTINA DE ESTIRAMIENTOS",
    log_weight: "+ REGISTRAR PESO",
    // Days of week
    days_of_week: ["LUN","MAR","MIÉ","JUE","VIE","SÁB","DOM"],
    days_of_week_short: ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"],
    // Month abbreviations
    month_abbr: ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"],
    // Settings labels
    units: "Unidades",
    kg: "KG",
    lbs: "LBS",
    notifications: "Notificaciones",
    language: "Idioma",
    account: "Cuenta",
    theme: "Tema",
    // Onboarding
    skip: "Omitir",
    name_placeholder: "Tu nombre...",
    age_placeholder: "Edad",
    weight_placeholder: "Peso",
    height_placeholder: "Altura",
    // Progress tab
    total_workouts: "Entrenamientos totales",
    current_streak: "Racha actual",
    best_streak: "Mejor racha",
    total_volume: "Volumen total",
    month: "Mes",
    all_time: "Todo el tiempo",
    // Error/toast messages
    error_saving: "Error al guardar",
    saved: "¡Guardado!",
    profile_saved: "Perfil guardado",
    pin_changed: "PIN cambiado",
    room_closed: "Sala cerrada",
    left_the_room: "Saliste de la sala",
    error_loading: "Error al cargar datos",
    network_error: "Error de red",
    // Misc
    are_you_sure: "¿Estás seguro?",
    yes: "Sí",
    no: "No",
    done: "LISTO",
    edit: "Editar",
    delete: "Eliminar",
    add: "Añadir",
    ok: "OK",
    // Workout UI
    skip_rest: "SALTAR DESCANSO",
    sec: "SEG",
    analyzing: "ANALIZANDO...",
    partner_label: "PAREJA",
    close: "CERRAR",
    not_training_yet: "Sin entrenar aún",
    pain_btn: "⚠️ SIENTO DOLOR",
    swap_exercise: "CAMBIAR EJERCICIO",
    how_did_it_feel: "¿CÓMO FUE? (OPCIONAL)",
    // Home screen
    ai_coach_note: "NOTA DEL ENTRENADOR IA",
    active_session: "SESIÓN ACTIVA",
    resume: "REANUDAR",
    week_plan: "DÍAS/SEMANA",
    // Settings screen
    edit_profile: "EDITAR PERFIL",
    training_days_label: "DÍAS DE ENTRENAMIENTO",
    security: "SEGURIDAD",
    change_pin: "CAMBIAR PIN",
    enter_current_pin: "INGRESA TU PIN ACTUAL",
    new_pin: "NUEVO PIN",
    confirm_new_pin: "CONFIRMAR NUEVO PIN",
    verify: "VERIFICAR",
    save_new_pin: "GUARDAR NUEVO PIN",
    routine_section: "RUTINA",
    customize_routine: "PERSONALIZAR RUTINA",
    quick_rebuild: "RECONSTRUIR RÁPIDO",
    save_profile: "GUARDAR PERFIL",
    injuries_label: "LESIONES / LIMITACIONES",
    // Partner screen
    generate_room_code: "Generar Mi Código de Sala",
    partner_not_connected: "PAREJA NO\nCONECTADA",
    waiting_for_partner: "ESPERANDO A LA PAREJA...",
    join_a_partner: "UNIRSE A UNA PAREJA",
    your_room_code: "TU CÓDIGO DE SALA",
    // Onboarding steps
    step_1_of_7: "PASO 1 DE 7",
    step_2_of_7: "PASO 2 DE 7",
    step_3_of_7: "PASO 3 DE 7",
    step_4_of_7: "PASO 4 DE 7",
    step_5_of_7: "PASO 5 DE 7",
    step_6_of_7: "PASO 6 DE 7",
    step_7_of_7: "PASO 7 DE 7",
    continue_btn: "Continuar",
    skip_go_solo: "Omitir — Ir Solo",
    continue_solo: "Continuar Solo por Ahora",
    // Rebuild modal
    rebuild_routine_title: "RECONSTRUIR\nRUTINA",
    rebuild_my_routine: "RECONSTRUIR MI RUTINA",
    preview_changes: "VISTA PREVIA DE CAMBIOS",
    // Sign out
    sign_out: "CERRAR SESIÓN",
    // No messages
    no_messages_yet: "Aún no hay mensajes",
    // Onboarding hardcoded
    join_btn: "UNIRSE",
    or_label: "O",
    enter_partners_code: "INGRESA EL CÓDIGO DE TU PAREJA",
    your_profile_summary: "RESUMEN DE TU PERFIL",
    who_are_you_title: "¿QUIÉN\nERES\nTÚ?",
    just_you_here: "Solo tú aquí. Tu pareja crea su propio perfil por separado.",
    create_4_digit_pin: "CREA UN PIN DE 4 DÍGITOS",
    protects_profile: "Protege tu perfil cuando le das el teléfono a otra persona.",
    confirm_pin_label: "CONFIRMAR PIN",
    your_stats_title: "TUS\nESTADÍSTICAS",
    calibrate_desc: "Usado para calibrar tus pesos y tiempos de descanso.",
    age_label: "EDAD",
    weight_label_upper: "PESO",
    height_label_upper: "ALTURA",
    biological_sex_label: "SEXO BIOLÓGICO",
    your_goals_title: "TUS\nOBJETIVOS",
    what_training_for: "¿Para qué entrenas",
    primary_goal_label: "OBJETIVO PRINCIPAL",
    training_level_label: "NIVEL DE ENTRENAMIENTO",
    what_to_build_title: "¿QUÉ QUIERES\nDESARROLLAR?",
    select_focus_areas: "Selecciona las áreas en las que quieres enfocarte.",
    upper_body_label: "TREN SUPERIOR",
    lower_body_label: "TREN INFERIOR",
    split_focus_label: "ENFOQUE DE RUTINA",
    your_gym_title: "TU\nGIMNASIO",
    when_what_train: "¿Cuándo y con qué entrenas?",
    days_per_week_label: "DÍAS POR SEMANA",
    training_days_upper: "DÍAS DE ENTRENAMIENTO",
    available_equipment_label: "EQUIPAMIENTO DISPONIBLE (selecciona todo)",
    any_limits_title: "¿ALGÚN\nLÍMITE?",
    injuries_desc: "¿Alguna lesión o área a evitar? La IA trabajará a tu alrededor.",
    injuries_optional_label: "LESIONES / LIMITACIONES (opcional)",
    schedule_label: "Horario",
    equipment_label: "Equipamiento",
    connect_partner_title: "CONECTAR\nPAREJA",
    connect_partner_desc: "Conéctate con tu pareja para sincronizar rutinas y pesos — o continúa solo y conéctate más tarde.",
    your_room_code_label: "TU CÓDIGO DE SALA",
    waiting_for_partner_label: "ESPERANDO A LA PAREJA...",
    back_label: "← ATRÁS",
    prev_label: "← ANTERIOR",
    continue_btn_label: "Continuar",
    // Workout UI hardcoded
    sec_label: "SEG",
    skip_rest_btn: "SALTAR DESCANSO",
    partner_btn: "PAREJA",
    analyzing_label: "ANALIZANDO...",
    close_btn: "CERRAR",
    no_partner_yet_label: "AÚN SIN PAREJA",
    share_room_from_partner: "Comparte tu código de sala desde la pestaña Pareja para conectarte.",
    stop_label: "¿PARAR?",
    progress_saved: "Tu progreso está guardado. Siempre puedes volver.",
    swap_exercise_title: "CAMBIAR EJERCICIO",
    for_today_only: "SOLO POR HOY — TU RUTINA NO CAMBIA",
    how_did_feel_label: "¿CÓMO FUE? (OPCIONAL)",
    done_btn: "LISTO",
    // Home screen hardcoded
    ai_coach_note_label: "NOTA DEL ENTRENADOR IA",
    active_session_label: "SESIÓN ACTIVA",
    sets_completed_label: "SERIES COMPLETADAS",
    resume_btn: "REANUDAR",
    week1_label: "SEMANA 1",
    days_week_plan: "DÍAS/SEMANA",
    start_first: "EMPIEZA TU PRIMERO",
    workouts_label: "ENTRENAMIENTOS",
    // Rest day
    light_stretching_btn: "RUTINA DE ESTIRAMIENTOS",
    partners_last_workout: "S ÚLTIMO ENTRENO",
    // Routine tab
    ai_generated_month1: "IA GENERADA · MES 1",
    customize_btn: "PERSONALIZAR",
    your_routine_title: "TU RUTINA",
    exercises_count_label: "EJERCICIOS",
    min_label: "MIN",
    // Partner tab
    close_room_btn: "CERRAR SALA",
    partner_not_connected_title: "PAREJA NO\nCONECTADA",
    share_code_desc: "Comparte tu código de sala para que tu pareja pueda unirse, o ingresa su código abajo.",
    how_to_connect_label: "CÓMO CONECTARSE",
    how_to_connect_desc: "Comparte tu código con tu pareja. Abren la app, van a la pestaña Pareja e ingresan el código manualmente.",
    join_a_partner_label: "UNIRSE A UNA PAREJA",
    training_now_label: "ENTRENANDO AHORA",
    not_training_label: "SIN ENTRENAR",
    exercises_label: "EJERCICIOS",
    sets_done_label: "SERIES HECHAS",
    weight_label: "PESO",
    elapsed_label: "TIEMPO",
    cheer_on_btn: "¡Anímalos!",
    last_workout_label: "ÚLTIMO ENTRENO",
    train_together_btn: "¿Entrenamos juntos?",
    // Progress tab
    body_weight_label: "PESO CORPORAL",
    log_weight_btn: "+ REGISTRAR PESO",
    storage_warning_label: "ADVERTENCIA DE ALMACENAMIENTO",
    storage_full_desc: "Almacenamiento casi lleno — considera eliminar fotos antiguas.",
    log_weight_title: "REGISTRAR PESO",
    save_btn: "GUARDAR",
    add_photo_label: "AÑADIR FOTO",
    share_btn: "COMPARTIR",
    sets_stat: "SERIES",
    exer_stat: "EJERC.",
    time_stat: "TIEMPO",
    max_wt_stat: "PESO MÁX",
    volume_stat: "VOLUMEN",
    // Settings hardcoded
    back_settings: "← ATRÁS",
    edit_profile_label: "EDITAR PERFIL",
    name_label_upper: "NOMBRE",
    weight_upper: "PESO",
    age_upper: "EDAD",
    height_upper: "ALTURA",
    injuries_limitations_label: "LESIONES / LIMITACIONES",
    save_profile_btn: "GUARDAR PERFIL",
    training_days_settings: "DÍAS DE ENTRENAMIENTO",
    security_label: "SEGURIDAD",
    change_pin_btn: "CAMBIAR PIN",
    enter_current_pin_label: "INGRESA TU PIN ACTUAL",
    new_pin_label: "NUEVO PIN",
    confirm_new_pin_label: "CONFIRMAR NUEVO PIN",
    verify_btn: "VERIFICAR",
    next_btn: "SIGUIENTE",
    cancel_btn: "CANCELAR",
    save_new_pin_btn: "GUARDAR NUEVO PIN",
    routine_settings_label: "RUTINA",
    customize_routine_btn: "PERSONALIZAR RUTINA",
    quick_rebuild_btn: "RECONSTRUIR RÁPIDO",
    // Conflict modal
    active_session_title: "SESIÓN ACTIVA",
    resume_current: "Reanudar Sesión Actual",
    end_start_new: "Terminarla e Iniciar Nueva",
    // Rebuild modal
    rebuild_routine_title_upper: "RECONSTRUIR\nRUTINA",
    active_workout_label: "ENTRENO ACTIVO",
    active_workout_desc: "Tienes un entrenamiento en progreso. Reconstruir terminará tu sesión actual.",
    section_training_days: "A — DÍAS DE ENTRENAMIENTO",
    section_muscle_focus: "B — ENFOQUE MUSCULAR",
    section_primary_goal: "C — OBJETIVO PRINCIPAL",
    section_training_level: "D — NIVEL DE ENTRENAMIENTO",
    section_equipment: "E — EQUIPAMIENTO",
    days_per_week_upper: "DÍAS POR SEMANA",
    training_days_upper2: "DÍAS DE ENTRENAMIENTO",
    upper_body_upper: "TREN SUPERIOR",
    lower_body_upper: "TREN INFERIOR",
    split_focus_upper: "ENFOQUE DE RUTINA",
    routine_preview_label: "VISTA PREVIA DE RUTINA",
    removed_label: "ELIMINADOS",
    new_label: "NUEVOS",
    rebuild_my_routine_btn: "RECONSTRUIR MI RUTINA",
    preview_changes_btn: "VISTA PREVIA DE CAMBIOS",
    customize_label: "PERSONALIZAR",
    cancel_arrow: "← CANCELAR",
    // Rebuild success
    routine_rebuilt: "✓ RUTINA RECONSTRUIDA",
    // Stretching sheet
    stretching_title: "ESTIRAMIENTOS",
    light_recovery_routine: "RUTINA DE RECUPERACIÓN LIGERA",
    // Logout modal
    sign_out_title: "CERRAR SESIÓN",
    sign_out_desc: "Tu rutina y conexión con tu pareja están guardadas en este navegador.",
    // Workout complete
    exercises_upper: "EJERCICIOS",
    time_upper: "TIEMPO",
    // Onboarding continue buttons
    got_it: "Entendido",
    keep_goal: "Mantener",
    // Onboarding screen titles
    who_are_you: "¿QUIÉN ERES?",
    your_stats: "TUS STATS",
    your_goals: "TUS OBJETIVOS",
    what_to_build: "¿QUÉ QUIERES TRABAJAR?",
    your_gym: "TU GIMNASIO",
    any_limits: "¿ALGÚN LÍMITE?",
    connect_partner: "CONECTAR PAREJA",
    // Field labels
    your_name_label: "TU NOMBRE",
    create_pin_label: "CREA UN PIN DE 4 DÍGITOS",
    confirm_pin_label2: "CONFIRMAR PIN",
    age_label2: "EDAD",
    weight_label2: "PESO",
    height_label2: "ALTURA",
    height_label: "ALTURA",
    biological_sex_label2: "SEXO BIOLÓGICO",
    training_level_label2: "NIVEL DE ENTRENAMIENTO",
    training_days_label2: "DÍAS DE ENTRENAMIENTO",
    injuries_label2: "LESIONES / LIMITACIONES (opcional)",
    injuries_placeholder: "ej. dolor de rodilla, problemas de espalda...",
    // Sex options
    male_opt: "Hombre",
    female_opt: "Mujer",
    other_opt: "Otro",
    // Goal names
    goal_muscle_mass: "Ganar Masa Muscular",
    goal_strength: "Aumentar Fuerza",
    goal_fitness: "Mejorar Condición Física",
    goal_definition: "Definición",
    goal_toning: "Tonificación",
    goal_cardio: "Cardiovascular",
    goal_fat_loss: "Pérdida de Peso / Grasa",
    goal_active: "Mantenerse Activo",
    // Level names
    level_beginner: "Principiante",
    level_intermediate: "Intermedio",
    level_advanced: "Avanzado",
    // Muscle groups
    muscle_chest: "Pecho",
    muscle_back: "Espalda",
    muscle_shoulders: "Hombros",
    muscle_arms: "Brazos",
    muscle_core: "Core",
    muscle_glutes: "Glúteos",
    muscle_quads: "Cuádriceps",
    muscle_hamstrings: "Isquiotibiales",
    muscle_calves: "Pantorrillas",
    muscle_full_lower: "Tren Inferior Completo",
    // Split options
    split_balanced: "Equilibrado",
    split_more_lower: "Más tren inferior",
    split_more_upper: "Más tren superior",
    split_full_body: "Cuerpo completo",
    // Equipment options
    equip_full_gym: "Gimnasio completo",
    equip_dumbbells: "Solo mancuernas",
    equip_barbell: "Barra + rack",
    equip_cables: "Poleas",
    equip_machines: "Máquinas",
    equip_bands: "Bandas elásticas",
    // Workout day type names
    day_push: "Día de Empuje",
    day_pull: "Día de Jalón",
    day_legs: "Día de Piernas",
    day_upper: "Tren Superior",
    day_lower: "Tren Inferior",
    day_full_body_a: "Cuerpo Completo A",
    day_full_body_b: "Cuerpo Completo B",
    day_full_body_c: "Cuerpo Completo C",
    // Muscle label abbreviations
    muscle_tris: "TRÍCEPS",
    muscle_bis: "BÍCEPS",
    muscle_rear_delt: "DELTOIDES POST.",
    muscle_lats: "DORSALES",
    muscle_posterior: "CADENA POSTERIOR",
    muscle_upper_chest: "PECHO SUPERIOR",
    muscle_side_delt: "DELTOIDES LAT.",
    muscle_triceps: "TRÍCEPS",
    // Summary card
    schedule_label2: "Horario",
    equipment_label2: "Equipamiento",
    days_week_suffix: "días/semana",
    // AI Coach note
    ai_coach_default: "Tu rutina personalizada está lista. Sobrecarga progresiva integrada — serás más fuerte cada semana.",
    // Count labels
    exercises_count: "EJERCICIOS",
    approx_min: "MIN",
    // FIX 2
    edit_schedule: "EDITAR HORARIO",
    assign_workouts: "ASIGNA TUS ENTRENAMIENTOS",
    // FIX 3
    can_you_lift: "¿Puedes levantar",
    yes_i_can: "Sí, puedo",
    no_adjust: "No, ajustar",
    adjust_weight: "AJUSTAR PESO",
    use_this_weight: "USAR ESTE PESO",
    // FIX 4
    train_invite_sent: "¡Invitación enviada a {name}! Ve a Hoy para empezar.",
    wants_to_train: "¡QUIERE ENTRENAR JUNTOS!",
    // FIX 5
    while_you_wait: "MIENTRAS ESPERAS",
    partner_still_training: "AÚN ENTRENANDO",
    sets_left: "series restantes",
    buffer_stretch_title: "Estiramientos Completos",
    buffer_stretch_desc: "Recupera y mantente flexible",
    buffer_abs_title: "Rutina de Core y Abdomen",
    buffer_abs_desc: "Finisher de abdominales",
    buffer_cardio_title: "Finisher Cardiovascular",
    buffer_cardio_desc: "Mantén el ritmo cardíaco",
    // Day abbreviations for FIX 8
    day_mon: "LUN",
    day_tue: "MAR",
    day_wed: "MIÉ",
    day_thu: "JUE",
    day_fri: "VIE",
    day_sat: "SÁB",
    day_sun: "DOM",
  }
};

/* ─── Translation lookup maps ─── */
const MUSCLE_KEYS = {
  'Chest':'muscle_chest', 'Back':'muscle_back', 'Shoulders':'muscle_shoulders',
  'Arms':'muscle_arms', 'Core':'muscle_core', 'Glutes':'muscle_glutes',
  'Quads':'muscle_quads', 'Hamstrings':'muscle_hamstrings', 'Calves':'muscle_calves',
  'Full Lower Body':'muscle_full_lower'
};

const EQUIP_KEYS = {
  'Full gym':'equip_full_gym', 'Dumbbells only':'equip_dumbbells',
  'Barbell + rack':'equip_barbell', 'Cables':'equip_cables',
  'Machines':'equip_machines', 'Resistance bands':'equip_bands'
};

const DAY_KEYS = {
  'Push Day':'day_push', 'Pull Day':'day_pull', 'Legs Day':'day_legs',
  'Leg Day':'day_legs',
  'Upper Body':'day_upper', 'Lower Body':'day_lower',
  'Full Body A':'day_full_body_a', 'Full Body B':'day_full_body_b',
  'Full Body C':'day_full_body_c'
};

const MUSCLE_LABEL_KEYS = {
  'chest':'muscle_chest', 'back':'muscle_back', 'shoulders':'muscle_shoulders',
  'lats':'muscle_lats', 'triceps':'muscle_triceps', 'biceps':'muscle_bis',
  'upper chest':'muscle_upper_chest', 'side delt':'muscle_side_delt',
  'rear delt':'muscle_rear_delt', 'posterior chain':'muscle_posterior',
  'quads':'muscle_quads', 'hamstrings':'muscle_hamstrings',
  'glutes':'muscle_glutes', 'core':'muscle_core', 'calves':'muscle_calves'
};

const GOAL_KEYS = {
  'Gain Muscle Mass':'goal_muscle_mass', 'Increase Strength':'goal_strength',
  'Improve Physical Fitness':'goal_fitness', 'Definition':'goal_definition',
  'Body Toning':'goal_toning', 'Cardiovascular':'goal_cardio',
  'Weight / Fat Loss':'goal_fat_loss', 'Stay Active':'goal_active'
};

const LEVEL_KEYS = {
  'Beginner':'level_beginner', 'Intermediate':'level_intermediate', 'Advanced':'level_advanced'
};

const SPLIT_KEYS = {
  'Balanced':'split_balanced', 'More lower body':'split_more_lower',
  'More upper body':'split_more_upper', 'Full body':'split_full_body'
};

/* ════════════════════════════════════════════
   FLOATING CHAT WINDOW (defined outside App so hooks are stable)
════════════════════════════════════════════ */
function ChatWindow({ partnerProfile, messages, userSlot, onSend, lang }) {
  const [kbOffset, setKbOffset] = useState(0);
  useEffect(() => {
    if (!window.visualViewport) return;
    const onResize = () => {
      const hidden = window.innerHeight - window.visualViewport.height;
      setKbOffset(Math.max(0, hidden));
    };
    window.visualViewport.addEventListener("resize", onResize);
    return () => window.visualViewport.removeEventListener("resize", onResize);
  }, []);
  return (
    <div style={{position:"fixed",bottom:82+kbOffset,right:"calc(50% - 215px + 16px)",width:300,background:"#181818",borderRadius:18,border:"1px solid var(--line)",boxShadow:"0 8px 40px rgba(0,0,0,.6)",zIndex:59,display:"flex",flexDirection:"column",maxHeight:340,overflow:"hidden"}}>
      <div style={{padding:"12px 14px 8px",borderBottom:"1px solid var(--line)",display:"flex",alignItems:"center",gap:8}}>
        <div style={{width:8,height:8,borderRadius:99,background:"#30d158",animation:"pulse 2s infinite"}}/>
        <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--white)"}}>{(partnerProfile.name||"PARTNER").toUpperCase()}</span>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"10px 12px",display:"flex",flexDirection:"column",gap:6}}>
        {messages.length === 0 && (
          <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",textAlign:"center",padding:"12px 0"}}>{STRINGS[lang]?.no_messages_yet || STRINGS.en.no_messages_yet}</div>
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
        {(STRINGS[lang]?.quick_replies || STRINGS.en.quick_replies).map(qr=>(
          <button key={qr} onClick={()=>onSend(qr)} style={{background:"var(--dark)",border:"1px solid var(--line)",borderRadius:99,padding:"7px 12px",fontFamily:"var(--font-body)",fontSize:11,color:"var(--white)",cursor:"pointer"}}>{qr}</button>
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

  const [lang, setLang] = useState(localStorage.getItem('str_lang') || 'en');
  const t = (key) => STRINGS[lang]?.[key] || STRINGS.en[key] || key;

  const weightUnit = profile?.weightUnit || 'lbs';
  const KG_TO_LBS = 2.20462;
  const LBS_TO_KG = 0.453592;

  const toDisplay = (kg) => {
    if (!kg || kg === 0) return 0;
    return weightUnit === 'lbs' ? Math.round(kg * KG_TO_LBS * 10) / 10 : kg;
  };

  const fromDisplay = (val) => {
    if (!val || val === 0) return 0;
    return weightUnit === 'lbs' ? Math.round(val * LBS_TO_KG * 100) / 100 : val;
  };

  const unitLabel = weightUnit === 'lbs' ? 'LBS' : 'KG';

  const displayWeight = (wStr) => {
    if (!wStr || wStr === 'BW' || wStr === '— kg') return wStr === '— kg' ? `— ${unitLabel}` : wStr;
    const num = parseFloat(wStr);
    if (isNaN(num)) return wStr;
    const displayed = weightUnit === 'lbs' ? Math.round(num * KG_TO_LBS * 2) / 2 : num;
    return `${displayed}${unitLabel}`;
  };

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
  const restingRef = useRef(false);
  const supaSubRef = useRef(null); // legacy — kept for cleanup only
  const roomChannelRef = useRef(null); // shared Broadcast channel for the room
  const profileRef = useRef(null); // always-fresh profile for async callbacks

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

  // Routine version counter — increments on rebuild to force Today tab re-key
  const [routineVersion, setRoutineVersion] = useState(0);

  // Rate limiting for Supabase messages
  const lastMsgTimeRef = useRef(0);

  // Real-time partner workout session (from active_session_a/b columns)
  const [partnerSession, setPartnerSession] = useState(null);
  // Live room data for partner tab status
  const [roomData, setRoomData] = useState(null);

  // FIX 1 — iOS WebSocket reconnect
  const [channelVersion, setChannelVersion] = useState(0);

  // FIX 3 — Editable weight with first-set confirmation
  const [editingWeight, setEditingWeight] = useState(false);
  const [tempWeight, setTempWeight] = useState("");
  const [weightCheckState, setWeightCheckState] = useState({});
  const [postExerciseCheck, setPostExerciseCheck] = useState(null);

  // FIX 4 — Train Together banner
  const [trainTogetherBanner, setTrainTogetherBanner] = useState(null);

  // FIX 5 — Cool-down buffer
  const [bufferActivity, setBufferActivity] = useState(null);
  const [bufferExIdx, setBufferExIdx] = useState(0);
  const [bufferTimer, setBufferTimer] = useState(0);
  const [bufferRunning, setBufferRunning] = useState(false);
  const bufferTimerRef = useRef(null);

  // Keep profileRef current for use inside async channel callbacks
  useEffect(() => { profileRef.current = profile; }, [profile]);

  // null-safe profile updater (profile starts null before onboarding)
  const p = (k, v) => setProfile(prev => ({...(prev || {}), [k]: v}));

  /* ─── FIX 7 — parseHistoryDate handles timestamp field and year-boundary edge case ─── */
  const parseHistoryDate = (h) => {
    if (h.timestamp) return new Date(h.timestamp);
    try {
      const d = new Date(`${h.date} ${new Date().getFullYear()}`);
      if (d > new Date() && (d - new Date()) > 180 * 86400000) d.setFullYear(d.getFullYear()-1);
      return d;
    } catch { return null; }
  };

  /* ─── Week progress: recalculates whenever workoutHistory or routine changes ─── */
  const weekProgress = useMemo(() => {
    try {
      const today = new Date();
      const todayDOW = today.getDay();
      const mondayOffset = todayDOW === 0 ? -6 : 1 - todayDOW;
      const monday = new Date(today);
      monday.setDate(today.getDate() + mondayOffset);
      monday.setHours(0,0,0,0);
      const weekStart = monday.getTime();
      const weekEnd = weekStart + 7 * 86400000;
      // Read fresh from state (also mirrors localStorage via persistence effect)
      const hist = workoutHistory.length
        ? workoutHistory
        : (() => { try { return JSON.parse(localStorage.getItem("str_history") || "[]"); } catch { return []; } })();
      const thisWeek = hist.filter(h => {
        if (!h.date && !h.timestamp) return false;
        try {
          const d = parseHistoryDate(h);
          if (!d) return false;
          return d.getTime() >= weekStart && d.getTime() < weekEnd;
        } catch { return false; }
      });
      const map = {};
      thisWeek.forEach(h => { if (h.dayOfWeek) map[h.dayOfWeek] = h; });
      return map;
    } catch { return {}; }
  }, [workoutHistory, routine]); // eslint-disable-line react-hooks/exhaustive-deps

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
          // Channel subscription is handled by the roomCode useEffect
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


  /* ─── Keep restingRef in sync with resting state ─── */
  useEffect(() => { restingRef.current = resting; }, [resting]);

  /* ─── Rest timer with beep ─── */
  useEffect(() => {
    clearInterval(timerRef.current);
    if (!resting) return;
    timerRef.current = setInterval(() => {
      setRestSec(s => {
        if (s <= 1) {
          clearInterval(timerRef.current);
          restingRef.current = false;
          setResting(false);
          playBeep();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [resting]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Buffer exercise timer — start/reset on exercise change ─── */
  useEffect(() => {
    if (!bufferActivity) return;
    const ex = bufferActivity.exercises[bufferExIdx];
    if (!ex) return;
    clearInterval(bufferTimerRef.current);
    if (ex.duration) {
      setBufferTimer(ex.duration);
      setBufferRunning(true);
    } else {
      setBufferTimer(0);
      setBufferRunning(false);
    }
  }, [bufferActivity, bufferExIdx]);

  /* ─── Buffer exercise timer — countdown interval ─── */
  useEffect(() => {
    if (!bufferRunning) return;
    bufferTimerRef.current = setInterval(() => {
      setBufferTimer(s => {
        if (s <= 1) {
          clearInterval(bufferTimerRef.current);
          setBufferRunning(false);
          playBeep();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(bufferTimerRef.current);
  }, [bufferRunning]);

  /* ─── Buffer timer — auto-advance timed exercises after 1.5s ─── */
  useEffect(() => {
    if (bufferTimer === 0 && !bufferRunning && bufferActivity &&
        bufferExIdx < bufferActivity.exercises.length) {
      const bEx = bufferActivity.exercises[bufferExIdx];
      if (bEx?.duration) {
        const t = setTimeout(() => setBufferExIdx(i => i + 1), 1500);
        return () => clearTimeout(t);
      }
    }
  }, [bufferTimer, bufferRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Weight check state — set 'pending' when exercise changes ─── */
  useEffect(() => {
    const key = `${dayIdx}-${exIdx}`;
    if (!weightCheckState[key] && ex?.wA && ex.wA !== 'BW' && ex.wA !== '— kg') {
      setWeightCheckState(prev => ({...prev, [key]: 'pending'}));
    }
  }, [dayIdx, exIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Post-exercise check banner — auto-dismiss after 8s ─── */
  useEffect(() => {
    if (!postExerciseCheck) return;
    const t = setTimeout(() => setPostExerciseCheck(null), 8000);
    return () => clearTimeout(t);
  }, [postExerciseCheck]);

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
  // Prefer live Broadcast session state; fall back to persisted _activeSession
  const partnerActiveSession = partnerSession || partnerProfile?._activeSession || null;
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

  // Session sync is now handled synchronously inside completeSet via
  // broadcastSessionUpdate (Broadcast) + persistSessionToSupabase (REST fire-and-forget)

  const saveRestPreference = (secs) => {
    setProfile(prev => ({
      ...prev,
      restPreferences: { ...(prev?.restPreferences || {}), [prev?.goal || 'default']: secs }
    }));
  };
  const changeRest = (secs, savePreference = false) => {
    clearInterval(timerRef.current);
    setRestMax(secs);
    setRestSec(secs);
    setResting(true);
    if (savePreference) saveRestPreference(secs);
  };
  const startRest = (s, savePreference = false) => {
    setRestMax(s); setRestSec(s); setResting(true);
    if (savePreference) saveRestPreference(s);
  };
  const skipRest  = () => { clearInterval(timerRef.current); setResting(false); setRestSec(0); };

  const day         = routine?.[dayIdx];
  const ex          = day?.exercises[exIdx];
  const accentColor = day?.color || "var(--lime)";

  const completeSet = () => {
    const key = `${exIdx}-${setNum}`;
    const newCompletedSets = { ...completedSets, [key]: true };
    setCompletedSets(newCompletedSets);

    // Push to Supabase immediately with fresh (non-stale) data
    if (roomCode && supabase && workoutStartRef.current && day) {
      const totalSetsInRoutine = day.exercises.reduce((s, e) => s + e.sets, 0);
      const sessionUpdate = {
        isActive: true,
        dayIdx, exIdx, setNum,
        completedSets: newCompletedSets,
        totalSetsInRoutine,
        lastActivityAt: Date.now(),
        startedAt: workoutStartRef.current,
        dayName: day.name,
        dayColor: day.color,
        userName: profile?.name || "",
        exerciseName: ex?.name || "",
        currentWeight: ex?.wA || "",
        totalExercises: day.exercises.length,
      };
      localStorage.setItem('str_active_session', JSON.stringify(sessionUpdate));
      broadcastSessionUpdate(sessionUpdate);   // real-time delivery to partner
      persistSessionToSupabase(sessionUpdate); // persisted for Partner tab / reconnect
    }

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

    const getRestDuration = () => {
      const saved = profile?.restPreferences?.[profile?.goal || 'default'];
      return saved || ex.rest || 90;
    };

    if (setNum < ex.sets) {
      setSetNum(s => s + 1);
      startRest(getRestDuration());
    } else if (exIdx < day.exercises.length - 1) {
      setExIdx(i => i + 1);
      setSetNum(1);
      startRest(getRestDuration());
      // Ask post-exercise weight check
      const currentKey = `${dayIdx}-${exIdx}`;
      if (weightCheckState[currentKey] === 'confirmed') {
        setPostExerciseCheck({ dayIdx, exIdx, exerciseName: ex.name, weight: ex.wA });
      }
    } else {
      // Workout complete — show completion sheet IMMEDIATELY, then persist async
      setSheet("complete");

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
        timestamp: Date.now(),
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
      // Save locally immediately — never block on Supabase
      setWorkoutHistory(prev => [entry, ...prev].slice(0, 20));
      setWorkoutNote("");
      localStorage.removeItem("str_active_session");
      // Background Supabase sync — failure does not affect UX
      if (roomCode && supabase) {
        const col = userSlot === "a" ? "user_a" : "user_b";
        supabase.from("rooms")
          .update({ [col]: { ...(profile || {}), _activeSession: null, _lastWorkout: entry } })
          .eq("room_code", roomCode)
          .then(() => {}).catch(e => console.warn("Could not sync workout end:", e));
      }
    }
  };

  const fetchAI = async (prompt) => {
    setAiLoading(true);
    setAiText("");
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: "You are an elite strength coach inside a couples gym app called Stronger. Give concise, direct, warm advice. 2–3 short paragraphs maximum. No markdown, no bullet points. Real coach voice, not clinical." + (lang === 'es' ? ' Respond in Spanish.' : ''),
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) throw new Error(`API error ${response.status}`);
      const data = await response.json();
      const text = data.content?.find(b => b.type === "text")?.text;
      setAiText(text || (lang === 'es' ? "Confía en tu cuerpo. Si duele con intensidad, para. Si es quemazón muscular, sigue." : "Trust your body. If pain is sharp — stop. If it's a burn — keep going."));
    } catch (e) {
      console.warn("AI Coach error:", e);
      setAiText(lang === 'es'
        ? "Sin conexión al entrenador. Si el dolor es agudo, detente. Si es quemazón muscular, continúa."
        : "Can't reach coach right now. If pain is sharp — stop. If it's a burn — keep going.");
    }
    setAiLoading(false);
  };

  const generateRoutine = async (resolvedPartner = null, profileOverride = null) => {
    const _profile = profileOverride || profile;
    setScreen("generating");
    let summary = t('ai_coach_default');
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: "You are an elite strength coach. Write a 2-sentence routine summary. Be encouraging, specific, reference goals and level. No markdown." + (lang === 'es' ? ' Respond in Spanish.' : ''),
          messages: [{
            role: "user",
            content: `Athlete: ${_profile.name||"You"}, ${_profile.age}y, ${_profile.weight}kg, goal: ${_profile.goal||"build muscle"}, level: ${_profile.level||"intermediate"}, ${_profile.daysPerWeek} days/week${resolvedPartner?`\nPartner: ${resolvedPartner.name||"Partner"}, ${resolvedPartner.weight}kg, goal: ${resolvedPartner.goal||"—"}, level: ${resolvedPartner.level||"—"}`:""}${_profile.priorityMuscles?.length?`\nUser wants to prioritize: ${_profile.priorityMuscles.join(', ')}. Split preference: ${_profile.splitPreference||"Balanced"}.`:""}`,
          }],
        }),
      });
      if (!response.ok) throw new Error(`API error ${response.status}`);
      const data = await response.json();
      summary = data.content?.find(b => b.type === "text")?.text || summary;
    } catch (e) { console.warn("generateRoutine AI error:", e); }
    const builtRoutine = buildRoutine(_profile, resolvedPartner);
    setRoutine(builtRoutine);
    // FIX 2 — Save week schedule
    const ws = buildWeekSchedule(_profile.trainingDays || [], builtRoutine.length);
    p("weekSchedule", ws);
    setAiSummary(summary);
    setTimeout(() => setScreen("home"), 600);
  };

  const regenerateRoutine = async () => {
    setRegenerating(true);
    let summary = "Your routine has been refreshed with updated targets. Keep pushing!";
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: "You are an elite strength coach. Write a 2-sentence routine summary. Be encouraging, specific. No markdown." + (lang === 'es' ? ' Respond in Spanish.' : ''),
          messages: [{ role: "user", content: `Regenerate a new summary for: ${profile.name||"Athlete"}, goal: ${profile.goal||"build muscle"}, level: ${profile.level||"intermediate"}, ${profile.daysPerWeek} days/week.` }],
        }),
      });
      if (!response.ok) throw new Error(`API error ${response.status}`);
      const data = await response.json();
      summary = data.content?.find(b => b.type === "text")?.text || summary;
    } catch (e) { console.warn("regenerateRoutine AI error:", e); }
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
    // End active session before rebuilding (routine change mid-session is unsafe)
    if (activeSession?.isActive) {
      clearActiveSession();
    }
    setProfile(prev => ({ ...prev, ...rebuildDraft }));
    const newRoutine = buildRoutine(rebuildDraft, partnerProfile);
    setRoutine(newRoutine);
    // FIX 2 — Save week schedule
    const wsr = buildWeekSchedule(rebuildDraft.trainingDays || [], newRoutine.length);
    setProfile(prev => ({...(prev||{}), ...rebuildDraft, weekSchedule: wsr}));
    // Synchronously write to localStorage so Today tab sees it on next render
    try { localStorage.setItem("str_routine", JSON.stringify(newRoutine)); } catch {}
    // Increment version to force Today tab to re-key and re-render
    setRoutineVersion(v => v + 1);
    setShowRebuildModal(false);
    setShowRebuildPreview(false);
    setRebuildPreview(null);
    setRebuildDraft(null);
    setRebuildSuccess(true);
    setTimeout(() => setRebuildSuccess(false), 3000);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: "You are an elite strength coach. Write a 2-sentence routine summary. Be encouraging, specific. No markdown." + (lang === 'es' ? ' Respond in Spanish.' : ''),
          messages: [{ role: "user", content: `Routine rebuilt for: ${rebuildDraft.name||"Athlete"}, goal: ${rebuildDraft.goal||"build muscle"}, level: ${rebuildDraft.level||"intermediate"}, ${rebuildDraft.daysPerWeek} days/week.${rebuildDraft.priorityMuscles?.length?` Focus: ${rebuildDraft.priorityMuscles.join(", ")}.`:""}` }],
        }),
      });
      if (!response.ok) throw new Error(`API error ${response.status}`);
      const data = await response.json();
      const txt = data.content?.find(b => b.type === "text")?.text;
      if (txt) setAiSummary(txt);
    } catch (e) { console.warn("handleRebuildConfirm AI error:", e); }
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
      // Channel subscription fires automatically via roomCode useEffect
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
      // Channel subscription fires automatically via roomCode useEffect
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
      // Channel subscription fires automatically via roomCode useEffect
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

  /* ─── Broadcast helpers — called from completeSet on every set ─── */
  const broadcastSessionUpdate = (sessionData) => {
    if (!roomCode || !roomChannelRef.current) return;
    const event = userSlot === 'a' ? 'session_a' : 'session_b';
    roomChannelRef.current
      .send({ type: 'broadcast', event, payload: sessionData })
      .catch(e => console.warn('Broadcast failed:', e));
  };

  const persistSessionToSupabase = (sessionData) => {
    if (!roomCode || !supabase) return;
    const slot = userSlot === 'a' ? 'active_session_a' : 'active_session_b';
    supabase.from('rooms')
      .update({ [slot]: sessionData })
      .eq('room_code', roomCode)
      .then(({ error }) => { if (error) console.warn('Persist failed:', error.message); });
  };

  /* ─── Shared Broadcast channel — ONE channel for the whole room ─── */
  useEffect(() => {
    if (!roomCode || !supabase) return;
    const partnerEvent = userSlot === 'a' ? 'session_b' : 'session_a';
    const partnerDataSlot = userSlot === 'a' ? 'active_session_b' : 'active_session_a';

    const channel = supabase
      .channel(`room:${roomCode}`)
      // Partner profile updates (when partner joins/leaves)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'rooms', filter: `room_code=eq.${roomCode}`
      }, (payload) => {
        try {
          const data = payload.new;
          const partner = userSlot === 'a' ? data.user_b : data.user_a;
          if (partner) {
            setPartnerProfile(partner);
            setWaitingForPartner(false);
            if (!workoutStartRef.current) {
              setRoutine(prev => prev || buildRoutine(profileRef.current || {}, partner));
            }
          }
          setRoomData(data);
        } catch (e) { console.warn('Realtime handler error:', e); }
      })
      // Partner workout session — Broadcast (low-latency, peer-to-peer)
      .on('broadcast', { event: partnerEvent }, ({ payload }) => {
        if (payload) {
          setPartnerSession(payload);
          setRoomData(prev => prev ? { ...prev, [partnerDataSlot]: payload } : prev);
        }
      })
      // Chat messages — Broadcast (low-latency)
      .on('broadcast', { event: 'chat_message' }, ({ payload }) => {
        if (payload?.from_slot !== userSlot) {
          setMessages(prev => {
            const base = prev.length >= 500 ? prev.slice(50) : prev;
            return [...base, { slot: payload.from_slot, text: payload.text, ts: payload.ts || Date.now() }];
          });
          navigator.vibrate?.(100);
        }
      })
      // FIX 4 — Train Together invite broadcast
      .on('broadcast', { event: 'train_together_invite' }, ({ payload }) => {
        setTrainTogetherBanner(payload?.fromName || 'Your partner');
        setTimeout(() => setTrainTogetherBanner(null), 8000);
      })
      .subscribe((status) => {
        console.log('Room broadcast channel:', status);
      });

    roomChannelRef.current = channel;

    // Fetch initial persisted state so UI is populated before first broadcast
    supabase.from('rooms').select('*').eq('room_code', roomCode).single()
      .then(({ data }) => {
        if (!data) return;
        setRoomData(data);
        const ps = data[partnerDataSlot];
        if (ps?.isActive) setPartnerSession(ps);
      });

    return () => {
      supabase.removeChannel(channel);
      roomChannelRef.current = null;
    };
  }, [roomCode, userSlot, channelVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── FIX 1 — iOS WebSocket reconnect on app resume ─── */
  useEffect(() => {
    const handleResume = async () => {
      if (document.visibilityState !== 'visible' || !roomCode || !supabase) return;
      const state = roomChannelRef.current?.state;
      if (state === 'joined') return;
      console.log('Reconnecting room channel after background...');
      if (roomChannelRef.current) {
        try { await supabase.removeChannel(roomChannelRef.current); } catch {}
        roomChannelRef.current = null;
      }
      setChannelVersion(v => v + 1);
      // Fetch latest partner session snapshot
      const partnerDataSlot = userSlot === 'a' ? 'active_session_b' : 'active_session_a';
      supabase.from('rooms').select('active_session_a,active_session_b')
        .eq('room_code', roomCode).single()
        .then(({ data }) => {
          if (data?.[partnerDataSlot]?.isActive) setPartnerSession(data[partnerDataSlot]);
        });
    };
    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('online', handleResume);
    return () => {
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('online', handleResume);
    };
  }, [roomCode, userSlot]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Cleanup on unmount (supaSubRef legacy) ─── */
  useEffect(() => {
    return () => {
      if (supaSubRef.current) {
        try { supaSubRef.current.unsubscribe(); } catch {}
        supaSubRef.current = null;
      }
      if (roomChannelRef.current) {
        try { supabase?.removeChannel(roomChannelRef.current); } catch {}
        roomChannelRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Fetch partner snapshot when workout screen mounts ─── */
  useEffect(() => {
    if (!roomCode || !supabase || screen !== 'workout') return;
    const partnerDataSlot = userSlot === 'a' ? 'active_session_b' : 'active_session_a';
    supabase.from('rooms')
      .select('active_session_a, active_session_b')
      .eq('room_code', roomCode).single()
      .then(({ data }) => {
        if (!data) return;
        const ps = data[partnerDataSlot];
        if (ps?.isActive) setPartnerSession(ps);
      });
  }, [roomCode, userSlot, screen]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Active session helpers ─── */
  const clearActiveSession = () => {
    localStorage.removeItem("str_active_session");
    setActiveSession(null);
    workoutStartRef.current = null;
  };

  /* ─── Shared chat send — Broadcast + fire-and-forget persist ─── */
  const sendChatMsg = (text) => {
    const now = Date.now();
    if (now - lastMsgTimeRef.current < 1000) return; // rate limit
    lastMsgTimeRef.current = now;
    const msg = { slot: userSlot, text: sanitize(String(text).slice(0, 200)), ts: now };
    // Broadcast to partner immediately
    if (roomChannelRef.current) {
      roomChannelRef.current
        .send({ type: 'broadcast', event: 'chat_message', payload: { from_slot: userSlot, text: msg.text, ts: now } })
        .catch(e => console.warn('Chat broadcast failed:', e));
    }
    // Optimistic local update
    setMessages(prev => {
      const base = prev.length >= 500 ? prev.slice(50) : prev;
      return [...base, msg];
    });
    // Persist to Supabase for history (fire-and-forget)
    if (roomCode && supabase) {
      supabase.from('rooms').select('messages').eq('room_code', roomCode).single()
        .then(({ data }) => {
          const existing = data?.messages || [];
          const updated = [...existing, msg].slice(-200);
          return supabase.from('rooms').update({ messages: updated }).eq('room_code', roomCode);
        })
        .catch(e => console.warn('Chat persist failed:', e));
    }
  };

  const startWorkout = (idx) => {
    const now = Date.now();
    setDayIdx(idx);
    setExIdx(0);
    setSetNum(1);
    setCompletedSets({});
    setResting(false);
    setWeightCheckState({});
    setPostExerciseCheck(null);
    setBufferActivity(null);
    setBufferExIdx(0);
    clearInterval(bufferTimerRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    workoutStartRef.current = now;
    const session = { isActive:true, dayIdx:idx, exIdx:0, setNum:1, completedSets:{}, startedAt:now, lastActivityAt:now, restMax:90, resting:false, restSecondsLeft:0 };
    localStorage.setItem("str_active_session", JSON.stringify(session));
    setActiveSession(session);
    // Apply saved rest preference to all exercises for this session
    const savedRest = profile?.restPreferences?.[profile?.goal] || null;
    if (savedRest) {
      setRoutine(prev => prev.map((d, di) => di !== idx ? d : {
        ...d, exercises: d.exercises.map(e => ({ ...e, rest: savedRest }))
      }));
    }
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

  const endWorkoutNow = async () => {
    try {
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
          timestamp: Date.now(),
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
          await supabase.from("rooms")
            .update({ [col]: { ...profile, _activeSession: null, _lastWorkout: entry } })
            .eq("room_code", roomCode);
        }
      }
    } catch (e) {
      console.warn("Could not sync session end:", e);
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      setResting(false);
      setSheet(null);
      clearActiveSession();
      setScreen("home");
    }
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
    // Convert weight from display unit (lbs) to kg for storage
    const rawWeight = parseFloat(profile.weight || '0');
    const weightInKg = weightUnit === 'lbs' && rawWeight > 0
      ? Math.round(rawWeight * LBS_TO_KG * 10) / 10
      : rawWeight;
    const profileForGenerate = rawWeight > 0 ? {...profile, weight: String(weightInKg)} : {...profile};
    if (rawWeight > 0 && weightInKg !== rawWeight) {
      p("weight", String(weightInKg));
    }
    generateRoutine(null, profileForGenerate);
  };

  const pct = day && ex ? ((exIdx + setNum / ex.sets) / day.exercises.length) * 100 : 0;

  /* ─── FIX 8 — Translate day label abbreviations ─── */
  const tDayLabel = (label) => {
    const WEEK_EN = ["MON","TUE","WED","THU","FRI","SAT","SUN"];
    const display = STRINGS[lang]?.days_of_week || STRINGS.en.days_of_week;
    const idx = WEEK_EN.indexOf(label?.toUpperCase());
    return idx >= 0 ? display[idx] : (label || "");
  };

  /* ─── FIX 2 — Translate muscle group tags ─── */
  const tTag = (tag) => {
    if (!tag) return tag;
    const TAG_MAP = {
      'CHEST': t('muscle_chest'), 'BACK': t('muscle_back'),
      'SHOULDERS': t('muscle_shoulders'), 'TRIS': t('muscle_tris'),
      'TRICEPS': t('muscle_triceps'), 'BICEPS': t('muscle_bis'),
      'REAR DELT': t('muscle_rear_delt'), 'LATS': t('muscle_lats'),
      'QUADS': t('muscle_quads'), 'HAMSTRINGS': t('muscle_hamstrings'),
      'GLUTES': t('muscle_glutes'), 'CALVES': t('muscle_calves'),
      'ABS': t('muscle_core'), 'CORE': t('muscle_core'),
      'BRACHIALIS': 'BRACHIALIS',
    };
    return tag.split(' · ').map(part => TAG_MAP[part.trim()] || part).join(' · ');
  };

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
        <div style={{ position:'absolute', top:20, right:20, display:'flex', gap:8, zIndex:10 }}>
          <button
            onClick={() => { setLang('en'); localStorage.setItem('str_lang','en'); }}
            style={{
              background: lang === 'en' ? '#C8F135' : 'transparent',
              color: lang === 'en' ? '#080808' : '#888',
              border: '1px solid',
              borderColor: lang === 'en' ? '#C8F135' : '#333',
              borderRadius: 20, padding:'6px 14px',
              fontFamily:"'Barlow Condensed',sans-serif",
              fontWeight:700, fontSize:13, letterSpacing:1, cursor:'pointer'
            }}>
            EN
          </button>
          <button
            onClick={() => { setLang('es'); localStorage.setItem('str_lang','es'); }}
            style={{
              background: lang === 'es' ? '#C8F135' : 'transparent',
              color: lang === 'es' ? '#080808' : '#888',
              border: '1px solid',
              borderColor: lang === 'es' ? '#C8F135' : '#333',
              borderRadius: 20, padding:'6px 14px',
              fontFamily:"'Barlow Condensed',sans-serif",
              fontWeight:700, fontSize:13, letterSpacing:1, cursor:'pointer'
            }}>
            ES
          </button>
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
            }}>{t('create_account')}</Btn>
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
            }}>{t('log_in')}</Btn>
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
    const Chip = ({value, label, current, onToggle, single, currentSingle, onSelect}) => {
      const active = single
        ? (currentSingle||"").toLowerCase()===(value||"").toLowerCase()
        : current?.includes(value);
      return (
        <button className={`chip${active?" active":""}`} onClick={()=>single?onSelect(value):onToggle(value)}>{label || value}</button>
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
      "Gain Muscle Mass_Weight / Fat Loss": "Building muscle needs a calorie surplus; fat loss needs a deficit — these goals pull in opposite directions nutritionally. Beginners can sometimes do both ('body recomposition'), but for best results pick your priority now. You can always update it later.",
      "Weight / Fat Loss_Gain Muscle Mass": "Building muscle needs a calorie surplus; fat loss needs a deficit — these goals pull in opposite directions nutritionally. Beginners can sometimes do both ('body recomposition'), but for best results pick your priority now. You can always update it later.",
      "Increase Strength_Cardiovascular": "Heavy strength training and high-volume cardio interfere with each other — your body can't fully adapt to both simultaneously. Pick your primary focus and add the other as supplementary work on rest days.",
      "Cardiovascular_Increase Strength": "Heavy strength training and high-volume cardio interfere with each other — your body can't fully adapt to both simultaneously. Pick your primary focus and add the other as supplementary work on rest days.",
      "Body Toning_Increase Strength": "Toning uses light weight and high reps; strength training uses heavy weight and low reps. They're fundamentally different training stimuli. Choose the one that matches your priority right now.",
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

    const GOALS  = ["Gain Muscle Mass","Increase Strength","Improve Physical Fitness","Definition","Body Toning","Cardiovascular","Weight / Fat Loss","Stay Active"];
    const LEVELS = ["Beginner","Intermediate","Advanced"];
    const EQUIP  = ["Full gym","Dumbbells only","Barbell + rack","Cables","Machines","Resistance bands"];
    const DAYS   = ["2","3","4","5","6"];

    const stepContent = [
      /* 0 — Name + PIN */
      <div key={0} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>{t('step_1_of_7')}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>{t('who_are_you')}</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>{t('just_you_here')}</p>
        <Input label={t('your_name_label')} placeholder="Alex" value={profile.name} onChange={v=>p("name",v)} />
        <div style={{marginTop:16}}>
          <Label text={t('create_pin_label')} />
          <p style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray2)",marginBottom:14,lineHeight:1.5}}>{t('protects_profile')}</p>
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
          <Label text={t('confirm_pin_label')} />
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
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>{t('step_2_of_7')}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>{t('your_stats')}</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:32}}>{t('calibrate_desc')}</p>
        <div style={{display:"flex",gap:12}}>
          <div style={{flex:1}}><Input label={t('age_label')} placeholder="28" value={profile.age} onChange={v=>p("age",v)} type="number"/></div>
          <div style={{flex:1}}><Input label={t('weight_label')} placeholder={weightUnit === 'lbs' ? '176' : '80'} value={profile.weight} onChange={v=>p("weight",v)} type="number" unit={weightUnit === 'lbs' ? 'lbs' : 'kg'}/></div>
          <div style={{flex:1}}><Input label={t('height_label')} placeholder="175" value={profile.height} onChange={v=>p("height",v)} type="number" unit="cm"/></div>
        </div>
        <Label text={t('biological_sex_label')}/>
        <div className="chip-select">
          {["Male","Female","Other"].map(v=><Chip key={v} value={v} label={t(v==="Male"?'male_opt':v==="Female"?'female_opt':'other_opt')} single currentSingle={profile.sex} onSelect={v=>p("sex",v)}/>)}
        </div>
      </div>,

      /* 2 — Goals & level */
      <div key={2} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>{t('step_3_of_7')}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>{t('your_goals')}</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:28}}>{t('what_training_for')}, {profile.name||"you"}?</p>
        <Label text={t('primary_goal_label')}/>
        <div className="chip-select" style={{marginBottom:goalConflict?12:28}}>
          {GOALS.map(v=><Chip key={v} value={v} label={t(GOAL_KEYS[v])||v} single currentSingle={profile.goal} onSelect={handleGoalSelect}/>)}
        </div>
        {goalConflict && (
          <div style={{background:"var(--card)",borderRadius:14,borderLeft:"3px solid var(--lime)",padding:"14px 16px",marginBottom:20,animation:"fadeIn 0.2s ease"}}>
            <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6,marginBottom:12}}>{goalConflict.explanation}</p>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{ p("goal", goalConflict.pending); setGoalConflict(null); if(goalConflictTimer) clearTimeout(goalConflictTimer); }}
                style={{flex:1,background:"var(--lime)",border:"none",borderRadius:10,padding:"10px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:12,letterSpacing:1,color:"var(--black)",cursor:"pointer"}}>
                {t('got_it')}
              </button>
              <button onClick={()=>{ setGoalConflict(null); if(goalConflictTimer) clearTimeout(goalConflictTimer); }}
                style={{flex:1,background:"transparent",border:"1px solid var(--line2)",borderRadius:10,padding:"10px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:12,letterSpacing:1,color:"var(--gray)",cursor:"pointer"}}>
                {t('keep_goal')} {profile.goal}
              </button>
            </div>
          </div>
        )}
        <Label text={t('training_level_label')}/>
        <div className="chip-select">
          {LEVELS.map(v=><Chip key={v} value={v} label={t(LEVEL_KEYS[v])||v} single currentSingle={profile.level} onSelect={v=>p("level",v.toLowerCase())}/>)}
        </div>
      </div>,

      /* 3 — Muscle priorities (NEW) */
      <div key={3} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>{t('step_4_of_7')}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:52,lineHeight:0.88,marginBottom:16}}>{t('what_to_build')}</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>{t('select_focus_areas')}</p>
        <div style={{display:"flex",gap:16,marginBottom:24}}>
          <div style={{flex:1}}>
            <Label text={t('upper_body_label')}/>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {["Chest","Back","Shoulders","Arms","Core"].map(v=>(
                <button key={v} onClick={()=>toggleMuscle(v)}
                  className={(profile.priorityMuscles||[]).includes(v)?"chip active":"chip"}
                  style={{textAlign:"left"}}>{t(MUSCLE_KEYS[v])||v}</button>
              ))}
            </div>
          </div>
          <div style={{flex:1}}>
            <Label text={t('lower_body_label')}/>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {["Glutes","Quads","Hamstrings","Calves","Full Lower Body"].map(v=>(
                <button key={v} onClick={()=>toggleMuscle(v)}
                  className={(profile.priorityMuscles||[]).includes(v)?"chip active":"chip"}
                  style={{textAlign:"left",fontSize:11}}>{t(MUSCLE_KEYS[v])||v}</button>
              ))}
            </div>
          </div>
        </div>
        <Label text={t('split_focus_label')}/>
        <div className="chip-select">
          {["Balanced","More lower body","More upper body","Full body"].map(v=>(
            <Chip key={v} value={v} label={t(SPLIT_KEYS[v])||v} single currentSingle={profile.splitPreference||"Balanced"} onSelect={v=>p("splitPreference",v)}/>
          ))}
        </div>
      </div>,

      /* 4 — Schedule + equipment (was 3) */
      <div key={4} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>{t('step_5_of_7')}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>{t('your_gym')}</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:28}}>{t('when_what_train')}</p>
        <Label text={t('days_per_week_label')}/>
        <div className="chip-select" style={{marginBottom:20}}>
          {DAYS.map(v=><Chip key={v} value={v} single currentSingle={profile.daysPerWeek} onSelect={v=>{
            p("daysPerWeek",v);
            p("trainingDays", getDayPreset(parseInt(v)));
          }}/>)}
        </div>
        <Label text={t('training_days_label')}/>
        <div style={{display:"flex",gap:6,marginBottom:24}}>
          {ALL_DAYS_LABELS.map(d => {
            const td = profile.trainingDays || getDayPreset(parseInt(profile.daysPerWeek)||3);
            const isSelected = td.includes(d);
            const n = parseInt(profile.daysPerWeek)||3;
            return (
              <button key={d} onClick={() => {
                const current = profile.trainingDays || getDayPreset(parseInt(profile.daysPerWeek)||3);
                if (isSelected) {
                  if (current.length <= n) {
                    setToast(`Select exactly ${n} training days`);
                    setTimeout(()=>setToast(null),2000);
                    return;
                  }
                  p("trainingDays", current.filter(x=>x!==d));
                } else {
                  const newDays = current.length >= n
                    ? [...current.slice(0,-1), d].sort((a,b)=>ALL_DAYS_LABELS.indexOf(a)-ALL_DAYS_LABELS.indexOf(b))
                    : [...current, d].sort((a,b)=>ALL_DAYS_LABELS.indexOf(a)-ALL_DAYS_LABELS.indexOf(b));
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
        <Label text={t('available_equipment_label')}/>
        <div className="chip-select">
          {EQUIP.map(v=><Chip key={v} value={v} label={t(EQUIP_KEYS[v])||v} current={profile.equipment} onToggle={toggleEquip}/>)}
        </div>
      </div>,

      /* 5 — Injuries (was 4) */
      <div key={5} className="sr" style={{display:"flex",flexDirection:"column",flex:1}}>
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>{t('step_6_of_7')}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>{t('any_limits')}</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:28}}>{t('injuries_desc')}</p>
        <Label text={t('injuries_label2')}/>
        <textarea
          value={profile.injuries} onChange={e=>p("injuries",e.target.value)}
          placeholder={t('injuries_placeholder')} rows={4}
          style={{width:"100%",background:"var(--card)",border:"1.5px solid var(--line2)",borderRadius:12,padding:14,fontFamily:"var(--font-body)",fontSize:16,color:"var(--white)",resize:"none",marginBottom:24}}
        />
        <div style={{background:"var(--card)",borderRadius:16,border:"1px solid var(--line)",padding:18}}>
          <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:12}}>{t('your_profile_summary')}</div>
          {[
            [profile.name||"You", `${profile.goal||"—"} · ${profile.level||"—"}`],
            [t('schedule_label'), `${profile.daysPerWeek} ${t('days_week_suffix')}`],
            [t('equipment_label'), (profile.equipment||[]).length?(profile.equipment||[]).join(", "):t('full_gym')],
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
        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--lime)",marginBottom:10}}>{t('step_7_of_7')}</div>
        <div style={{fontFamily:"var(--font-display)",fontSize:58,lineHeight:0.88,marginBottom:16}}>{t('connect_partner')}</div>
        <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:28}}>
          {t('connect_partner_desc')}
        </p>
        {!roomCode ? (
          <>
            <Btn full onClick={handleInvite} style={{marginBottom:12}}>{t('invite_partner')}</Btn>
            <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)",textAlign:"center",marginBottom:12}}>{t('or_label')}</div>
            <div style={{background:"var(--card)",border:"1.5px solid var(--line2)",borderRadius:14,padding:16,marginBottom:12}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:10}}>{t('enter_partners_code')}</div>
              <div style={{display:"flex",gap:8}}>
                <input
                  value={joinInput}
                  onChange={e=>{setJoinInput(e.target.value.toUpperCase());setJoinError("");}}
                  placeholder="STR-XXXX"
                  style={{flex:1,background:"var(--dark)",border:"1.5px solid var(--line2)",borderRadius:10,padding:"12px 14px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:16,letterSpacing:2,color:"var(--white)",outline:"none"}}
                />
                <button onClick={handleJoin} style={{background:"var(--lime)",border:"none",borderRadius:10,padding:"12px 18px",fontFamily:"var(--font-cond)",fontWeight:900,fontSize:13,letterSpacing:2,color:"var(--black)",cursor:"pointer"}}>{t('join_btn')}</button>
              </div>
              {joinError && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginTop:8}}>{joinError}</div>}
            </div>
            <Btn full variant="ghost" onClick={finishOnboarding}>{t('skip_go_solo')}</Btn>
          </>
        ) : waitingForPartner ? (
          <div style={{textAlign:"center"}}>
            <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--gray)",marginBottom:12}}>{t('your_room_code_label')}</div>
            <div style={{fontFamily:"var(--font-display)",fontSize:72,color:"var(--lime)",letterSpacing:4,marginBottom:20,lineHeight:1}}>{roomCode}</div>
            <Btn full onClick={handleCopyLink} style={{marginBottom:20}}>{copied?t('copied'):t('copy_code')}</Btn>
            <div style={{display:"flex",alignItems:"center",gap:10,justifyContent:"center",marginBottom:24}}>
              <div style={{width:9,height:9,borderRadius:99,background:"var(--lime)",animation:"pulse 1.5s infinite"}}/>
              <span style={{fontFamily:"var(--font-cond)",fontSize:12,letterSpacing:2,color:"var(--gray)"}}>{t('waiting_for_partner_label')}</span>
            </div>
            <Btn full variant="ghost" onClick={finishOnboarding}>{t('continue_solo')}</Btn>
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
              {onboardStep===0?t('back_label'):t('prev_label')}
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
                  }}>{t('continue_btn_label')}</Btn>
                : <Btn full onClick={nextStep}>{t('continue_btn_label')}</Btn>
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
            🏆 {t('personal_record')} — {prNotification.exerciseName.toUpperCase()} {displayWeight(prNotification.weight)}
          </div>
        )}
        {/* Post-exercise weight check banner */}
        {postExerciseCheck && (
          <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",
            width:"100%",maxWidth:430,zIndex:150,
            background:"#181818",borderTop:`3px solid ${day?.color||"var(--lime)"}`,
            padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",
            boxShadow:"0 4px 24px rgba(0,0,0,0.6)"}}>
            <div>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"var(--gray)",marginBottom:2}}>
                {postExerciseCheck.exerciseName.toUpperCase()} · {displayWeight(postExerciseCheck.weight)}
              </div>
              <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,color:"var(--white)"}}>
                {lang==='es'?'¿Lograste completar todas las series?':'Did you complete all sets at this weight?'}
              </div>
            </div>
            <div style={{display:"flex",gap:8,flexShrink:0,marginLeft:12}}>
              <button onClick={()=>setPostExerciseCheck(null)}
                style={{background:"rgba(200,241,53,0.15)",border:`1px solid ${day?.color||"var(--lime)"}`,
                  borderRadius:8,padding:"8px 12px",fontFamily:"var(--font-cond)",fontWeight:700,
                  fontSize:12,color:day?.color||"var(--lime)",cursor:"pointer"}}>
                ✓ {lang==='es'?'SÍ':'YES'}
              </button>
              <button onClick={()=>{
                const _rawKgPEC = parseFloat((postExerciseCheck.weight||'').replace(/kg|lbs/gi,'').trim());
                setTempWeight(String(isNaN(_rawKgPEC) ? '' : (weightUnit === 'lbs' ? Math.round(_rawKgPEC * KG_TO_LBS * 2) / 2 : _rawKgPEC)));
                setEditingWeight(true);
                setPostExerciseCheck(null);
              }} style={{background:"rgba(255,59,48,0.1)",border:"1px solid rgba(255,59,48,0.3)",
                borderRadius:8,padding:"8px 12px",fontFamily:"var(--font-cond)",fontWeight:700,
                fontSize:12,color:"var(--red)",cursor:"pointer"}}>
                ✗ {lang==='es'?'NO':'NO'}
              </button>
            </div>
          </div>
        )}
        <div style={{background:"var(--black)",minHeight:"100vh",maxWidth:430,margin:"0 auto",display:"flex",flexDirection:"column"}}>
          <div style={{padding:"16px 20px 0",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <button onClick={navigateHomeFromWorkout} style={{background:"var(--card)",border:"none",borderRadius:10,width:38,height:38,color:"var(--white)",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>←</button>
            <div style={{textAlign:"center"}}>
              <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:3,color:accentColor}}>{t(DAY_KEYS[day.name])||day.name}</div>
              <div style={{fontFamily:"var(--font-cond)",fontWeight:600,fontSize:13,color:"var(--gray)"}}>{exIdx+1} / {day.exercises.length}</div>
            </div>
            <button onClick={()=>setSheet("emergency")} style={{background:"rgba(255,59,48,.12)",border:"none",borderRadius:10,padding:"8px 14px",color:"var(--red)",fontSize:12,fontWeight:700,fontFamily:"var(--font-cond)",letterSpacing:1,cursor:"pointer"}}>{t('stop')}</button>
          </div>
          <div style={{padding:"14px 20px 0"}}>
            <div style={{height:3,background:"var(--line)",borderRadius:99,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${pct}%`,background:accentColor,borderRadius:99,transition:"width 0.5s cubic-bezier(.4,0,.2,1)"}}/>
            </div>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"20px 20px 130px"}}>
            <div className="fu" style={{marginBottom:20}}>
              <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:3,color:"var(--gray)",marginBottom:6}}>{(t(MUSCLE_LABEL_KEYS[ex.muscles?.toLowerCase()])||ex.muscles||"").toUpperCase()} · RPE {ex.rpe}</div>
              <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:14}}>
                <div style={{fontFamily:"var(--font-display)",fontSize:52,lineHeight:0.92,color:"var(--white)"}}>{ex.name.toUpperCase()}</div>
                <button onClick={()=>{setSwapExercise(ex);setSheet("swap");}} style={{background:"var(--card)",border:"1px solid var(--line2)",borderRadius:8,padding:"4px 10px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:10,letterSpacing:2,color:"var(--gray)",cursor:"pointer",flexShrink:0}}>{t('swap')}</button>
              </div>
              <div style={{display:"flex",gap:8}}>
                {[{l:t('sets'),v:ex.sets},{l:t('reps'),v:ex.reps}].map(({l,v})=>(
                  <div key={l} style={{flex:1,background:"var(--card)",borderRadius:12,padding:"12px 0",textAlign:"center",border:"1px solid var(--line)"}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"var(--gray)",marginBottom:4}}>{l}</div>
                    <div style={{fontFamily:"var(--font-cond)",fontWeight:800,fontSize:22,color:"var(--white)"}}>{v}</div>
                  </div>
                ))}
                <div onClick={()=>{
                    const _rawKg = parseFloat((ex.wA||'').replace(/kg|lbs/gi,'').trim());
                    setTempWeight(String(isNaN(_rawKg) ? '' : (weightUnit === 'lbs' ? Math.round(_rawKg * KG_TO_LBS * 2) / 2 : _rawKg)));
                    setEditingWeight(true);
                  }}
                  style={{flex:1,background:"var(--card)",borderRadius:12,padding:"12px 0",textAlign:"center",
                    border:`1px solid ${day.color}33`,cursor:"pointer",userSelect:"none"}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--gray)",marginBottom:4}}>
                    {t('weight')}
                  </div>
                  <div style={{fontFamily:"var(--font-display)",fontSize:24,color:day.color||"var(--lime)"}}>
                    {ex.wA === "BW" || !ex.wA ? (ex.wA || "—") : displayWeight(ex.wA)}
                  </div>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:8,color:"var(--gray2)",letterSpacing:1,marginTop:2}}>
                    {lang==='es'?'TOCAR PARA EDITAR':'TAP TO EDIT'}
                  </div>
                </div>
              </div>
              <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray2)",letterSpacing:1,marginTop:6}}>
                {t('rest')} · {ex.rest}s
              </div>
            </div>
            {/* Feature 4C — Weight progression suggestion */}
            <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1,marginBottom:8}}>
              {prs[ex.name]
                ? `${t('last_time')}: ${displayWeight(prs[ex.name].weight+'kg')} · ${t('try_today')} ${displayWeight((Math.round(prs[ex.name].weight * 1.025 / 2.5) * 2.5)+'kg')}`
                : t('first_time')}
            </div>
            {weightCheckState[`${dayIdx}-${exIdx}`] === 'pending' && ex?.wA && ex.wA !== 'BW' && (
              <div style={{background:"rgba(200,241,53,0.06)",borderRadius:14,
                border:`1px dashed ${day.color}66`,padding:16,marginBottom:14}}>
                <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,
                  color:"var(--gray)",marginBottom:4,textAlign:"center"}}>
                  {lang==='es'?'PESO SUGERIDO':'SUGGESTED WEIGHT'}
                </div>
                <div style={{fontFamily:"var(--font-display)",fontSize:48,color:day.color,
                  textAlign:"center",lineHeight:1,marginBottom:12}}>
                  {displayWeight(ex.wA)}
                </div>
                <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",
                  textAlign:"center",letterSpacing:1,marginBottom:14}}>
                  {prs[ex.name]
                    ? (lang==='es'?`Última vez: ${displayWeight(prs[ex.name].weight+'kg')}`:`Last time: ${displayWeight(prs[ex.name].weight+'kg')}`)
                    : (lang==='es'?'Primera vez — empieza conservador':'First time — start conservative')}
                </div>
                <div style={{display:"flex",gap:10}}>
                  <button onClick={()=>{
                    setWeightCheckState(prev=>({...prev,[`${dayIdx}-${exIdx}`]:'confirmed'}));
                  }} style={{flex:1,background:"rgba(200,241,53,0.15)",border:`1px solid ${day.color}`,
                    borderRadius:12,padding:"13px 0",fontFamily:"var(--font-cond)",fontWeight:700,
                    fontSize:13,letterSpacing:1,color:day.color,cursor:"pointer"}}>
                    ✓ {lang==='es'?'SÍ, PUEDO':'YES, I CAN'}
                  </button>
                  <button onClick={()=>{
                    const _rawKgWC = parseFloat((ex.wA||'').replace(/kg|lbs/gi,'').trim());
                    setTempWeight(String(isNaN(_rawKgWC) ? '' : (weightUnit === 'lbs' ? Math.round(_rawKgWC * KG_TO_LBS * 2) / 2 : _rawKgWC)));
                    setWeightCheckState(prev=>({...prev,[`${dayIdx}-${exIdx}`]:'adjusting'}));
                    setEditingWeight(true);
                  }} style={{flex:1,background:"rgba(255,59,48,0.08)",border:"1px solid rgba(255,59,48,0.3)",
                    borderRadius:12,padding:"13px 0",fontFamily:"var(--font-cond)",fontWeight:700,
                    fontSize:13,letterSpacing:1,color:"var(--red)",cursor:"pointer"}}>
                    ✗ {lang==='es'?'AJUSTAR':'ADJUST'}
                  </button>
                </div>
              </div>
            )}
            <div className="fu1" style={{background:"var(--card)",borderRadius:16,border:"1px solid var(--line)",padding:16,marginBottom:16}}>
              {/* ── MY all-sets progress ── */}
              {(() => {
                const totalSetsInRoutine = day.exercises.reduce((s, e) => s + e.sets, 0);
                const totalCompletedSets = Object.keys(completedSets).length;
                const allDots = [];
                day.exercises.forEach((exercise, eIdx) => {
                  for (let s = 1; s <= exercise.sets; s++) {
                    allDots.push({
                      key: `${eIdx}-${s}`,
                      done: !!completedSets[`${eIdx}-${s}`],
                      current: eIdx === exIdx && s === setNum,
                    });
                  }
                });
                return (
                  <div style={{marginBottom:14}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <div style={{width:6,height:6,borderRadius:99,background:accentColor}}/>
                        <span style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:2,color:"var(--white)"}}>{profile.name?.toUpperCase()||"YOU"}</span>
                      </div>
                      <span style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:1,color:"var(--gray)"}}>{totalCompletedSets} / {totalSetsInRoutine} SETS</span>
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {allDots.map(dot => (
                        <div key={dot.key} style={{
                          width:10, height:10, borderRadius:"50%",
                          background: dot.done ? accentColor : dot.current ? `${accentColor}66` : "#2a2a2a",
                          border: dot.current ? `1.5px solid ${accentColor}` : "none",
                          transition:"background 0.3s",
                        }}/>
                      ))}
                    </div>
                  </div>
                );
              })()}
              {/* ── PARTNER all-sets progress ── */}
              {(() => {
                const ps = partnerSession;
                const isActive = ps?.isActive && (Date.now() - (ps.startedAt || 0)) < 7_200_000;
                const pColor = ps?.dayColor || "#444";
                const pName = (ps?.userName || partnerProfile?.name || "PARTNER").toUpperCase();
                // Use partner's OWN totalSetsInRoutine — never the local user's routine
                const pTotal = isActive ? (ps.totalSetsInRoutine || 0) : 10;
                const pCompleted = isActive ? Object.keys(ps.completedSets || {}).length : 0;
                const pDots = Array.from({ length: pTotal || 10 }, (_, i) => ({ done: i < pCompleted }));
                return (
                  <div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <div style={{width:6,height:6,borderRadius:99,background:isActive?"#30d158":"#333"}}/>
                        <span style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:2,color:"var(--gray)"}}>{pName}</span>
                      </div>
                      {isActive
                        ? <span style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:1,color:"var(--gray2)"}}>{pCompleted} / {pTotal} SETS</span>
                        : <span style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:1,color:"var(--gray2)"}}>{t('not_training_yet')}</span>
                      }
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {pDots.map((dot, i) => (
                        <div key={i} style={{
                          width:10, height:10, borderRadius:"50%",
                          background: dot.done ? pColor : "#2a2a2a",
                          transition:"background 0.3s",
                        }}/>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="fu2" style={{background:"var(--card)",borderRadius:16,border:"1px solid var(--line)",padding:16,marginBottom:16}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:12}}>{t('sets')}</div>
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
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:2}}>{t('sec')}</div>
                  </div>
                </div>
                <div style={{fontFamily:"var(--font-cond)",fontSize:10,color:"var(--gray2)",
                  letterSpacing:2,marginTop:8,marginBottom:4}}>
                  {lang==='es'?'DESCANSO SUGERIDO':'SUGGESTED REST'}
                </div>
                <div style={{display:"flex",gap:8,justifyContent:"center",marginBottom:16}}>
                  {[30,60,90,120,180].map(secs => (
                    <button key={secs} onClick={()=>changeRest(secs, true)}
                      style={{background:restMax===secs?"var(--card)":"transparent",
                        border:`1px solid ${restMax===secs?"var(--line2)":"var(--line)"}`,
                        borderRadius:8,padding:"5px 10px",fontFamily:"var(--font-cond)",
                        fontWeight:700,fontSize:11,letterSpacing:1,
                        color:restMax===secs?"var(--white)":"var(--gray2)",cursor:"pointer"}}>
                      {secs}s
                    </button>
                  ))}
                </div>
                <button onClick={skipRest} style={{
                  background:"var(--card)",border:`1.5px solid ${accentColor}`,borderRadius:12,
                  padding:"12px 32px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:14,
                  letterSpacing:2,color:accentColor,cursor:"pointer",marginTop:8
                }}>{t('skip_rest')}</button>
              </div>
            )}
          </div>
          {!resting && (
            <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,padding:"12px 20px 34px",background:"linear-gradient(transparent,var(--black) 35%)"}}>
              <button onClick={completeSet} style={{width:"100%",background:accentColor,border:"none",borderRadius:16,padding:"18px 0",fontFamily:"var(--font-cond)",fontWeight:900,fontSize:18,letterSpacing:3,color:"var(--black)",cursor:"pointer",marginBottom:10,textTransform:"uppercase",boxShadow:`0 0 30px ${accentColor}44`}}>
                {setNum<ex.sets?`${t('complete_set')} ${setNum}`:exIdx<day.exercises.length-1?t('next_exercise'):t('finish_workout')}
              </button>
              <div style={{display:"flex",gap:10}}>
                <button onClick={()=>{setSheet("ai");fetchAI(`I'm doing ${ex.name}, ${ex.reps} reps at ${ex.wA}. Give me 3 form cues and tell me if I should adjust if I'm struggling.`);}} style={{flex:1,background:"var(--card)",border:"1px solid var(--line)",borderRadius:14,padding:"14px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,color:"var(--white)",cursor:"pointer"}}>{t('ai_coach')}</button>
                <button onClick={()=>setSheet("partner")} style={{flex:1,background:"var(--card)",border:"1px solid var(--line)",borderRadius:14,padding:"14px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,color:"var(--white)",cursor:"pointer"}}>{t('partner_label')}</button>
              </div>
            </div>
          )}
          {sheet && (
            <div onClick={()=>{setSheet(null); clearInterval(bufferTimerRef.current);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,backdropFilter:"blur(4px)"}}>
              <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#181818",borderRadius:"24px 24px 0 0",padding:28,animation:"slideIn .3s cubic-bezier(.4,0,.2,1)",maxHeight:"85vh",overflowY:"auto"}}>
                {sheet==="ai" && <>
                  <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:4}}>{t('ai_coach')}</div>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:accentColor,marginBottom:20}}>{ex.name.toUpperCase()}</div>
                  {aiLoading
                    ? <div style={{display:"flex",alignItems:"center",gap:12,color:"var(--gray)",padding:"20px 0"}}><div style={{width:16,height:16,border:`2px solid ${accentColor}`,borderTopColor:"transparent",borderRadius:99,animation:"spin .8s linear infinite"}}/><span style={{fontFamily:"var(--font-cond)",letterSpacing:1}}>{t('analyzing')}</span></div>
                    : <p style={{fontFamily:"var(--font-body)",fontSize:15,lineHeight:1.7,color:"#ccc",marginBottom:20}}>{aiText}</p>}
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <Btn variant="red-soft" full onClick={()=>fetchAI(`I feel discomfort doing ${ex.name}. Should I stop, modify, or push through?`)}>{t('pain_btn')}</Btn>
                    <Btn variant="ghost" full onClick={()=>setSheet(null)}>{t('close')}</Btn>
                  </div>
                </>}
                {sheet==="partner" && (
                  partnerProfile ? (
                    <>
                      <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:20}}>
                        <div style={{width:50,height:50,borderRadius:99,background:accentColor,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-display)",fontSize:22,color:"var(--black)"}}>{(partnerProfile.name||"?").slice(0,2).toUpperCase()}</div>
                        <div>
                          <div style={{fontFamily:"var(--font-display)",fontSize:28}}>{(partnerProfile.name||"PARTNER").toUpperCase()}</div>
                          {partnerProfile._activeSession && (Date.now() - (partnerProfile._activeSession.startedAt || 0)) < 7_200_000
                            ? <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:7,height:7,borderRadius:99,background:"#30d158",animation:"pulse 2s infinite"}}/><span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"#30d158"}}>{t('training_now')}</span></div>
                            : <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>{t('not_training')}</div>
                          }
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
                          <button key={t} onClick={()=>sendChatMsg(t)} style={{background:"var(--dark)",border:"1px solid var(--line)",borderRadius:99,padding:"8px 14px",fontFamily:"var(--font-body)",fontSize:12,color:"var(--white)",cursor:"pointer"}}>{t}</button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div style={{textAlign:"center",padding:"20px 0"}}>
                      <div style={{fontFamily:"var(--font-display)",fontSize:32,marginBottom:8}}>{t('no_partner_yet')}</div>
                      <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6,marginBottom:20}}>{t('share_room_from_partner')}</p>
                      <Btn variant="ghost" full onClick={()=>setSheet(null)}>{t('close')}</Btn>
                    </div>
                  )
                )}
                {sheet==="emergency" && <>
                  <div style={{fontFamily:"var(--font-display)",fontSize:42,color:"var(--red)",marginBottom:8}}>{t('stop_label')}</div>
                  <p style={{fontFamily:"var(--font-body)",fontSize:15,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>{t('progress_saved')}</p>
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <Btn variant="dark" full onClick={navigateHomeFromWorkout}>{t('resume_later')}</Btn>
                    <Btn variant="red" full onClick={endWorkoutNow}>{t('end_workout_now')}</Btn>
                    <Btn variant="ghost" full onClick={()=>setSheet(null)}>{t('keep_going')}</Btn>
                  </div>
                </>}
                {/* Feature 4B — Swap sheet */}
                {sheet==="swap" && swapExercise && (
                  <div>
                    <div style={{fontFamily:"var(--font-display)",fontSize:32,marginBottom:4}}>{t('swap_exercise')}</div>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)",marginBottom:20}}>{t('for_today_only')}</div>
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
                    <Btn variant="ghost" full onClick={()=>{setSheet(null);setSwapExercise(null);}}>{t('cancel')}</Btn>
                  </div>
                )}
                {sheet==="complete" && (
                  <div style={{textAlign:"center",paddingTop:8}}>
                    <div style={{fontSize:56,marginBottom:12}}>🎉</div>
                    <div style={{fontFamily:"var(--font-display)",fontSize:52,color:accentColor,lineHeight:0.9,marginBottom:8}}>{t('workout_complete')}</div>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:13,color:"var(--gray)",letterSpacing:2,marginBottom:28}}>{(t(DAY_KEYS[day.name])||day.name).toUpperCase()} · {day.exercises.length} {t('exercises_upper')}</div>
                    <div style={{display:"flex",gap:12,marginBottom:28}}>
                      {[
                        [t('sets'),`${day.exercises.reduce((a,e)=>a+e.sets,0)}`],
                        [t('exercises_upper'),`${day.exercises.length}`],
                        [t('time_upper'),`${workoutStartRef.current?Math.max(1,Math.round((Date.now()-workoutStartRef.current)/60000)):45} min`],
                      ].map(([l,v])=>(
                        <div key={l} style={{flex:1,background:"var(--card)",borderRadius:14,padding:"14px 8px"}}>
                          <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--gray)",marginBottom:4}}>{l}</div>
                          <div style={{fontFamily:"var(--font-display)",fontSize:24,color:accentColor}}>{v}</div>
                        </div>
                      ))}
                    </div>
                    {/* FIX 5 — Cool-down buffer when partner is still training */}
                    {partnerSession?.isActive && !bufferActivity && (
                      <div style={{background:"#111",borderRadius:16,padding:18,marginBottom:18,border:"1px solid var(--line)",textAlign:"left"}}>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:10,color:accentColor,letterSpacing:2,marginBottom:4}}>
                          {(partnerProfile?.name||'PARTNER').toUpperCase()} {t('partner_still_training')||'STILL TRAINING'}
                        </div>
                        <div style={{fontFamily:"var(--font-display)",fontSize:28,marginBottom:14}}>{t('while_you_wait')||'WHILE YOU WAIT'}</div>
                        {BUFFER_OPTIONS.map(opt=>(
                          <button key={opt.id} onClick={()=>{setBufferActivity(opt);setBufferExIdx(0);}}
                            style={{width:"100%",background:"var(--card)",border:"1px solid var(--line)",borderRadius:12,
                              padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",
                              cursor:"pointer",marginBottom:8,textAlign:"left"}}>
                            <div>
                              <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:14,color:"var(--white)"}}>{t(opt.titleKey)||opt.titleKey}</div>
                              <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",marginTop:2}}>{t(opt.descKey)||opt.descKey}</div>
                            </div>
                            <div style={{fontFamily:"var(--font-display)",fontSize:18,color:accentColor,flexShrink:0,marginLeft:12}}>{opt.duration}</div>
                          </button>
                        ))}
                      </div>
                    )}
                    {bufferActivity && (
                      <div style={{marginBottom:18,textAlign:"left"}}>
                        <button onClick={()=>{clearInterval(bufferTimerRef.current);setBufferActivity(null);}} style={{background:"none",border:"none",color:"var(--gray)",fontFamily:"var(--font-cond)",fontSize:12,letterSpacing:2,cursor:"pointer",padding:"0 0 12px"}}>← BACK</button>
                        <div style={{fontFamily:"var(--font-display)",fontSize:28,marginBottom:4}}>{t(bufferActivity.titleKey)||bufferActivity.titleKey}</div>
                        {bufferExIdx < bufferActivity.exercises.length && (() => {
                          const bEx = bufferActivity.exercises[bufferExIdx];
                          const isTimedEx = !!bEx.duration;
                          const totalDuration = bEx.duration || 0;
                          const progress = totalDuration > 0 ? (bufferTimer / totalDuration) : 0;
                          const circumference = 2 * Math.PI * 54;
                          return (
                            <div style={{background:"var(--card)",borderRadius:16,padding:24,textAlign:"center"}}>
                              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:4}}>
                                {bufferExIdx + 1} / {bufferActivity.exercises.length}
                              </div>
                              <div style={{fontFamily:"var(--font-display)",fontSize:30,lineHeight:0.95,marginBottom:4}}>
                                {bEx.name.toUpperCase()}
                              </div>
                              {bEx.side && (
                                <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:2,marginBottom:12}}>
                                  {lang==='es'?'CADA LADO':'EACH SIDE'}
                                </div>
                              )}
                              {isTimedEx ? (
                                <div style={{margin:"16px auto",position:"relative",width:120,height:120}}>
                                  <svg width="120" height="120" style={{position:"absolute",top:0,left:0,transform:"rotate(-90deg)"}}>
                                    <circle cx="60" cy="60" r="54" fill="none" stroke="var(--line)" strokeWidth="4"/>
                                    <circle cx="60" cy="60" r="54" fill="none" stroke={day?.color||"var(--lime)"} strokeWidth="4"
                                      strokeDasharray={circumference}
                                      strokeDashoffset={circumference * (1 - progress)}
                                      strokeLinecap="round"
                                      style={{transition:"stroke-dashoffset 1s linear"}}/>
                                  </svg>
                                  <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",
                                    alignItems:"center",justifyContent:"center"}}>
                                    <div style={{fontFamily:"var(--font-display)",fontSize:40,lineHeight:1,color:"var(--white)"}}>
                                      {bufferTimer}
                                    </div>
                                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,color:"var(--gray)",letterSpacing:2}}>
                                      {lang==='es'?'SEG':'SEC'}
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div style={{margin:"16px 0"}}>
                                  <div style={{fontFamily:"var(--font-display)",fontSize:56,color:day?.color||"var(--lime)"}}>
                                    {bEx.sets} × {bEx.reps}
                                  </div>
                                  <div style={{fontFamily:"var(--font-cond)",fontSize:12,color:"var(--gray)",letterSpacing:2}}>
                                    {lang==='es'?'SERIES × REPS':'SETS × REPS'}
                                  </div>
                                </div>
                              )}
                              <div style={{display:"flex",gap:10,marginTop:16}}>
                                {isTimedEx && bufferRunning && (
                                  <button onClick={()=>{ clearInterval(bufferTimerRef.current); setBufferRunning(false); }}
                                    style={{flex:1,background:"var(--dark)",border:"1px solid var(--line)",borderRadius:12,
                                      padding:"12px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,
                                      letterSpacing:2,color:"var(--gray)",cursor:"pointer"}}>
                                    ⏸ {lang==='es'?'PAUSA':'PAUSE'}
                                  </button>
                                )}
                                {isTimedEx && !bufferRunning && bufferTimer > 0 && (
                                  <button onClick={()=>setBufferRunning(true)}
                                    style={{flex:1,background:"var(--dark)",border:"1px solid var(--line)",borderRadius:12,
                                      padding:"12px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,
                                      letterSpacing:2,color:"var(--lime)",cursor:"pointer"}}>
                                    ▶ {lang==='es'?'REANUDAR':'RESUME'}
                                  </button>
                                )}
                                <button onClick={()=>{ clearInterval(bufferTimerRef.current); setBufferRunning(false); setBufferExIdx(i=>i+1); }}
                                  style={{flex:1,background:day?.color||"var(--lime)",border:"none",borderRadius:12,
                                    padding:"12px 0",fontFamily:"var(--font-cond)",fontWeight:900,fontSize:13,
                                    letterSpacing:2,color:"var(--black)",cursor:"pointer"}}>
                                  {bufferExIdx < bufferActivity.exercises.length - 1
                                    ? (lang==='es'?'SIGUIENTE →':'NEXT →')
                                    : (lang==='es'?'TERMINAR':'FINISH')}
                                </button>
                              </div>
                            </div>
                          );
                        })()}
                        {bufferExIdx >= bufferActivity.exercises.length && (
                          <div style={{background:"var(--card)",borderRadius:16,padding:24,textAlign:"center"}}>
                            <div style={{fontSize:40,marginBottom:8}}>🙌</div>
                            <div style={{fontFamily:"var(--font-display)",fontSize:28,marginBottom:8}}>GREAT WORK!</div>
                            <div style={{fontFamily:"var(--font-cond)",fontSize:12,color:"var(--gray)",letterSpacing:1}}>Your partner is almost done</div>
                          </div>
                        )}
                      </div>
                    )}
                    {/* Feature 4E — Workout notes */}
                    <div style={{marginBottom:16,textAlign:"left"}}>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>{t('how_did_it_feel')}</div>
                      <textarea
                        value={workoutNote}
                        onChange={e=>setWorkoutNote(e.target.value)}
                        placeholder="Add a note about this session..."
                        style={{width:"100%",background:"var(--dark)",border:"1px solid var(--line2)",borderRadius:10,padding:"10px 12px",fontFamily:"var(--font-body)",fontSize:14,color:"var(--white)",resize:"none",height:72,outline:"none",boxSizing:"border-box"}}
                      />
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:10}}>
                      <Btn full onClick={()=>{clearActiveSession();clearInterval(bufferTimerRef.current);setSheet(null);setScreen("home");setExIdx(0);setSetNum(1);setCompletedSets({});setBufferActivity(null);setBufferExIdx(0);}}>{t('done')}</Btn>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* FIX 4 — Weight edit modal */}
        {editingWeight && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",zIndex:200,
            display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
            <div style={{background:"#111",borderRadius:"20px 20px 0 0",padding:24,
              width:"100%",maxWidth:430,paddingBottom:"max(24px,env(safe-area-inset-bottom))"}}>
              <div style={{fontFamily:"var(--font-display)",fontSize:32,marginBottom:6}}>
                {lang==='es'?'AJUSTAR PESO':'ADJUST WEIGHT'}
              </div>
              <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:2,marginBottom:16}}>
                {ex.name.toUpperCase()}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                <input type="number" inputMode="decimal" step="0.5" value={tempWeight}
                  onChange={e=>setTempWeight(e.target.value)}
                  style={{flex:1,background:"var(--card)",border:`1px solid ${day.color}`,borderRadius:12,
                    padding:"16px 0",fontSize:32,color:"var(--white)",textAlign:"center",
                    fontFamily:"var(--font-display)",outline:"none",boxSizing:"border-box"}}/>
                <span style={{fontFamily:"var(--font-cond)",fontSize:16,color:"var(--gray)"}}>{unitLabel}</span>
              </div>
              <div style={{display:"flex",gap:8,marginBottom:16}}>
                {(weightUnit === 'lbs' ? [-10, -5, 5, 10] : [-5, -2.5, 2.5, 5]).map(delta=>(
                  <button key={delta} onClick={()=>setTempWeight(w=>String(Math.max(0,Math.round((parseFloat(w||0)+delta)*10)/10)))}
                    style={{flex:1,background:"var(--card)",border:"1px solid var(--line)",borderRadius:10,
                      padding:12,color:"var(--white)",fontFamily:"var(--font-cond)",fontWeight:700,
                      fontSize:14,cursor:"pointer",letterSpacing:1}}>
                    {delta>0?`+${delta}`:delta}
                  </button>
                ))}
              </div>
              <button onClick={()=>{
                const displayVal = parseFloat(tempWeight);
                const kgVal = weightUnit === 'lbs' ? Math.round(displayVal * LBS_TO_KG * 100) / 100 : displayVal;
                if (kgVal > 0) {
                  const newWStr = `${kgVal}kg`;
                  setRoutine(prev => prev.map((d,di) => di !== dayIdx ? d : {
                    ...d, exercises: d.exercises.map((e,ei) => ei !== exIdx ? e : { ...e, wA: newWStr })
                  }));
                  setPrs(prev => ({...prev, [ex.name]: { weight: kgVal, date: new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"}) }}));
                  setWeightCheckState(prev=>({...prev,[`${dayIdx}-${exIdx}`]:'done'}));
                }
                setEditingWeight(false);
              }} style={{width:"100%",background:day.color,border:"none",borderRadius:14,padding:"17px 0",
                fontFamily:"var(--font-cond)",fontWeight:900,fontSize:16,letterSpacing:2,
                color:"var(--black)",cursor:"pointer",marginBottom:10}}>
                {lang==='es'?'USAR ESTE PESO':'USE THIS WEIGHT'}
              </button>
              <button onClick={()=>setEditingWeight(false)}
                style={{width:"100%",background:"transparent",border:"none",padding:"12px 0",
                  color:"var(--gray)",fontFamily:"var(--font-cond)",fontSize:14,letterSpacing:2,cursor:"pointer"}}>
                {t('cancel')}
              </button>
            </div>
          </div>
        )}

        {/* ── Floating chat bubble during workout ── */}
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
        {chatOpen && partnerProfile && (
          <ChatWindow
            partnerProfile={partnerProfile}
            messages={messages}
            userSlot={userSlot}
            onSend={sendChatMsg}
            lang={lang}
          />
        )}
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
            <button onClick={()=>{setShowChangePinFlow(false);setScreen("home");}} style={{background:"none",border:"none",color:"var(--gray)",fontFamily:"var(--font-cond)",fontSize:13,letterSpacing:2,cursor:"pointer",padding:0}}>{t('back_settings')}</button>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"24px 22px 40px"}}>
            <div style={{fontFamily:"var(--font-display)",fontSize:52,lineHeight:0.88,marginBottom:24}}>{t('settings')}</div>
            <div style={{ display:'flex', gap:8, marginBottom:20 }}>
              <button
                onClick={() => { setLang('en'); localStorage.setItem('str_lang','en'); }}
                style={{
                  background: lang === 'en' ? '#C8F135' : 'transparent',
                  color: lang === 'en' ? '#080808' : '#888',
                  border: '1px solid',
                  borderColor: lang === 'en' ? '#C8F135' : '#333',
                  borderRadius: 20, padding:'6px 14px',
                  fontFamily:"'Barlow Condensed',sans-serif",
                  fontWeight:700, fontSize:13, letterSpacing:1, cursor:'pointer'
                }}>
                EN
              </button>
              <button
                onClick={() => { setLang('es'); localStorage.setItem('str_lang','es'); }}
                style={{
                  background: lang === 'es' ? '#C8F135' : 'transparent',
                  color: lang === 'es' ? '#080808' : '#888',
                  border: '1px solid',
                  borderColor: lang === 'es' ? '#C8F135' : '#333',
                  borderRadius: 20, padding:'6px 14px',
                  fontFamily:"'Barlow Condensed',sans-serif",
                  fontWeight:700, fontSize:13, letterSpacing:1, cursor:'pointer'
                }}>
                ES
              </button>
            </div>
            <div style={{display:"flex",gap:8,marginBottom:20,alignItems:"center"}}>
              <span style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginRight:4}}>
                {lang==='es'?'UNIDADES':'UNITS'}
              </span>
              {['kg','lbs'].map(unit => (
                <button key={unit} onClick={()=>p("weightUnit", unit)}
                  style={{
                    background: weightUnit === unit ? '#C8F135' : 'transparent',
                    color: weightUnit === unit ? '#080808' : '#888',
                    border: '1px solid',
                    borderColor: weightUnit === unit ? '#C8F135' : '#333',
                    borderRadius: 20, padding:'6px 14px',
                    fontFamily:"'Barlow Condensed',sans-serif",
                    fontWeight:700, fontSize:13, letterSpacing:1, cursor:'pointer',
                    textTransform:'uppercase'
                  }}>
                  {t(unit)}
                </button>
              ))}
            </div>

            {/* Profile */}
            <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>{t('edit_profile')}</div>
              <Input label="NAME" placeholder="Your name" value={settingsName} onChange={v=>setSettingsName(v)} maxLength={50}/>
              <div style={{display:"flex",gap:10}}>
                <div style={{flex:1}}><Input label="WEIGHT" placeholder={weightUnit === 'lbs' ? '176' : '80'} value={settingsWeight} onChange={v=>setSettingsWeight(v)} type="number" unit={weightUnit === 'lbs' ? 'lbs' : 'kg'}/></div>
                <div style={{flex:1}}><Input label="AGE" placeholder="28" value={settingsAge} onChange={v=>setSettingsAge(v)} type="number"/></div>
                <div style={{flex:1}}><Input label="HEIGHT" placeholder="175" value={settingsHeight} onChange={v=>setSettingsHeight(v)} type="number" unit="cm"/></div>
              </div>
              <div style={{marginBottom:14}}>
                <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>{t('injuries_label')}</div>
                <textarea maxLength={300} value={settingsInjuries} onChange={e=>setSettingsInjuries(e.target.value)} placeholder="Any injuries or limitations..." rows={2} style={{width:"100%",background:"var(--dark)",border:"1.5px solid var(--line2)",borderRadius:12,padding:"12px 14px",fontFamily:"var(--font-body)",fontSize:14,color:"var(--white)",resize:"none",outline:"none",boxSizing:"border-box"}}/>
              </div>
              <Btn full onClick={()=>{
                if (settingsName.trim()) p("name", settingsName.trim());
                if (settingsWeight && parseFloat(settingsWeight) > 0) { const _rawSW=parseFloat(settingsWeight); const _kgSW=weightUnit==='lbs'?Math.round(_rawSW*LBS_TO_KG*10)/10:_rawSW; p("weight",String(_kgSW)); }
                if (settingsAge && parseInt(settingsAge) > 0) p("age", settingsAge);
                if (settingsHeight && parseInt(settingsHeight) > 0) p("height", settingsHeight);
                p("injuries", settingsInjuries||"");
                setToast(t('profile_saved')); setTimeout(()=>setToast(null),2000);
              }}>{t('save_profile')}</Btn>
            </div>

            {/* Training Days */}
            <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>{t('training_days_label')}</div>
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
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>{t('security')}</div>
              {!showChangePinFlow ? (
                <Btn full variant="ghost" onClick={()=>{setShowChangePinFlow(true);setCpStep("verify");setCpEntry("");setCpNew("");setCpConfirm("");setCpError("");}}>{t('change_pin')}</Btn>
              ) : (
                <div>
                  {cpStep === "verify" && (
                    <>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:10}}>{t('enter_current_pin')}</div>
                      <input type="password" inputMode="numeric" maxLength={4} autoComplete="off" value={cpEntry} onChange={e=>{const v=e.target.value.replace(/\D/g,"").slice(0,4);setCpEntry(v);setCpError("");}} placeholder="• • • •" style={{width:"100%",background:"var(--dark)",border:`1.5px solid ${cpError?"var(--red)":"var(--line2)"}`,borderRadius:12,padding:"14px 16px",fontFamily:"var(--font-body)",fontSize:24,letterSpacing:8,color:"var(--white)",textAlign:"center",outline:"none",boxSizing:"border-box",marginBottom:8}}/>
                      {cpError && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginBottom:8}}>{cpError}</div>}
                      <div style={{display:"flex",gap:8}}>
                        <Btn full onClick={async()=>{
                          if(cpEntry.length!==4){setCpError("Enter your 4-digit PIN");return;}
                          const h=await hashPIN(cpEntry);
                          if(h===pinHash){setCpStep("new");setCpEntry("");setCpError("");}
                          else{setCpError("Wrong PIN. Try again.");}
                        }}>{t('verify')}</Btn>
                        <Btn full variant="ghost" onClick={()=>{setShowChangePinFlow(false);}}>{t('cancel')}</Btn>
                      </div>
                    </>
                  )}
                  {cpStep === "new" && (
                    <>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:10}}>{t('new_pin')}</div>
                      <input type="password" inputMode="numeric" maxLength={4} autoComplete="new-password" value={cpNew} onChange={e=>{const v=e.target.value.replace(/\D/g,"").slice(0,4);setCpNew(v);setCpError("");}} placeholder="• • • •" style={{width:"100%",background:"var(--dark)",border:`1.5px solid ${cpError?"var(--red)":"var(--line2)"}`,borderRadius:12,padding:"14px 16px",fontFamily:"var(--font-body)",fontSize:24,letterSpacing:8,color:"var(--white)",textAlign:"center",outline:"none",boxSizing:"border-box",marginBottom:8}}/>
                      {cpError && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginBottom:8}}>{cpError}</div>}
                      <div style={{display:"flex",gap:8}}>
                        <Btn full onClick={()=>{
                          if(cpNew.length!==4||!/^\d{4}$/.test(cpNew)){setCpError("PIN must be 4 digits");return;}
                          setCpStep("confirm");setCpError("");
                        }}>{t('next')}</Btn>
                        <Btn full variant="ghost" onClick={()=>setShowChangePinFlow(false)}>{t('cancel')}</Btn>
                      </div>
                    </>
                  )}
                  {cpStep === "confirm" && (
                    <>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:10}}>{t('confirm_new_pin')}</div>
                      <input type="password" inputMode="numeric" maxLength={4} autoComplete="new-password" value={cpConfirm} onChange={e=>{const v=e.target.value.replace(/\D/g,"").slice(0,4);setCpConfirm(v);setCpError("");}} placeholder="• • • •" style={{width:"100%",background:"var(--dark)",border:`1.5px solid ${cpError?"var(--red)":"var(--line2)"}`,borderRadius:12,padding:"14px 16px",fontFamily:"var(--font-body)",fontSize:24,letterSpacing:8,color:"var(--white)",textAlign:"center",outline:"none",boxSizing:"border-box",marginBottom:8}}/>
                      {cpError && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginBottom:8}}>{cpError}</div>}
                      <div style={{display:"flex",gap:8}}>
                        <Btn full onClick={async()=>{
                          if(cpConfirm!==cpNew){setCpError("PINs don't match");return;}
                          const h=await hashPIN(cpNew);
                          setPinHash(h);
                          setShowChangePinFlow(false);setCpEntry("");setCpNew("");setCpConfirm("");setCpError("");
                          setToast(t('pin_changed')); setTimeout(()=>setToast(null),2500);
                        }}>{t('save_new_pin')}</Btn>
                        <Btn full variant="ghost" onClick={()=>setShowChangePinFlow(false)}>{t('cancel')}</Btn>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Routine */}
            <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:40}}>
              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:14}}>{t('routine_section')}</div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <Btn full onClick={()=>{setScreen("home"); setTimeout(()=>openRebuildModal(),150);}}>{t('customize_routine')}</Btn>
                <Btn full variant="ghost" onClick={()=>{setScreen("home"); setTimeout(()=>generateRoutine(),150);}}>{t('quick_rebuild')}</Btn>
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

        {/* FIX 4 — Train Together invite banner */}
        {trainTogetherBanner && (
          <div onClick={()=>{ setTab('today'); setTrainTogetherBanner(null); }}
            style={{position:'fixed',top:0,left:'50%',transform:'translateX(-50%)',
              width:'100%',maxWidth:430,zIndex:500,background:'#C8F135',
              padding:'14px 20px',cursor:'pointer',
              fontFamily:"var(--font-cond)",fontWeight:700,fontSize:14,
              color:'#080808',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <span>💪 {(trainTogetherBanner).toUpperCase()} {t('wants_to_train')||'WANTS TO TRAIN TOGETHER!'}</span>
            <span>→ {t('today')||'TODAY'}</span>
          </div>
        )}

        {/* Header */}
        <div style={{padding:"22px 22px 0",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)"}}>{new Date().getHours()<12?t('good_morning').toUpperCase():new Date().getHours()<17?t('good_afternoon').toUpperCase():t('good_evening').toUpperCase()}</div>
            <div style={{fontFamily:"var(--font-display)",fontSize:28,lineHeight:1.05,marginTop:2}}>
              {(profile.name||"ATHLETE").toUpperCase()}
              {partnerProfile && partnerProfile.name && partnerProfile.name.toLowerCase() !== (profile.name||"").toLowerCase() ? ` & ${partnerProfile.name.toUpperCase()}` : ""}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {partnerProfile && (
              <button onClick={()=>setTab("partner")} style={{display:"flex",alignItems:"center",gap:5,background:"rgba(48,209,88,.08)",borderRadius:99,padding:"5px 11px",border:"1px solid rgba(48,209,88,.18)",cursor:"pointer"}}>
                <div style={{width:7,height:7,borderRadius:99,background:"#30d158",animation:"pulse 2s infinite"}}/>
                <span style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:2,color:"#30d158"}}>{(partnerProfile.name||"PARTNER").toUpperCase()}</span>
              </button>
            )}
            <button onClick={()=>{ setSettingsName(profile?.name||""); const _rawW=parseFloat(profile?.weight||'0'); setSettingsWeight(_rawW>0?String(toDisplay(_rawW)):""); setSettingsAge(profile?.age||""); setSettingsHeight(profile?.height||""); setSettingsInjuries(profile?.injuries||""); setShowChangePinFlow(false); setScreen("settings"); }} style={{background:"none",border:"none",fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)",cursor:"pointer",padding:"4px 8px"}}>{t('settings')}</button>
            <button onClick={()=>setShowLogout(true)} style={{background:"var(--card)",border:"none",borderRadius:10,width:34,height:34,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gray)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{display:"flex",gap:8,padding:"18px 22px 0",overflowX:"auto"}}>
          {[["today",t('today')],["routine",t('routine')],["partner",t('partner')],["progress",t('progress')]].map(([k,l])=>(
            <button key={k} onClick={()=>setTab(k)} style={{flexShrink:0,background:tab===k?"var(--white)":"var(--card)",border:tab===k?"none":"1px solid var(--line)",borderRadius:99,padding:"9px 18px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:12,letterSpacing:2,color:tab===k?"var(--black)":"var(--gray)",cursor:"pointer",transition:"all .2s"}}>{l}</button>
          ))}
        </div>

        <div style={{flex:1,overflowY:"auto",padding:"20px 22px 0"}}>

          {/* TODAY — keyed on routineVersion so rebuilds force re-render */}
          {tab==="today" && (() => {
            // Feature 3 — week display
            // routineVersion is read here to create a dependency (React key trick via IIFE)
            void routineVersion;
            const today = new Date();
            const todayDOW = today.getDay(); // 0=Sun
            const mondayOffset = todayDOW === 0 ? -6 : 1 - todayDOW;
            const monday = new Date(today);
            monday.setDate(today.getDate() + mondayOffset);
            monday.setHours(0,0,0,0);

            const WEEK_DAYS = ["MON","TUE","WED","THU","FRI","SAT","SUN"];
            const WEEK_DAYS_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
            const WEEK_DAYS_DISPLAY = STRINGS[lang]?.days_of_week || STRINGS.en.days_of_week;

            const trainingDays = profile?.trainingDays || null;
            const todayLabel = WEEK_DAYS[todayDOW === 0 ? 6 : todayDOW - 1];

            // FIX 2 — weekSchedule-based today workout
            const WEEK_KEYS = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
            const todayKey = WEEK_KEYS[new Date().getDay()];
            const weekSchedule = profile?.weekSchedule || {};
            const todayWorkoutIdx = weekSchedule[todayKey] ?? null; // eslint-disable-line no-unused-vars

            // Use the weekProgress memo (updates whenever workoutHistory or routine changes)
            const completedDayMap = weekProgress; // { "Mon": historyEntry, ... }
            const completedDayOfWeeks = Object.keys(completedDayMap);

            return (
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              {aiSummary && (
                <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid rgba(200,241,53,.2)",padding:20}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:8}}>{t('ai_coach_note')}</div>
                  <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"#ccc",lineHeight:1.65}}>{aiSummary}</p>
                </div>
              )}
              <div className="fu1" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20}}>
                <div style={{display:"flex",gap:4,marginBottom:14}}>
                  {WEEK_DAYS.map((d,i)=>{
                    const isTraining = trainingDays ? trainingDays.includes(d) : i < 5;
                    const isCompleted = completedDayOfWeeks.includes(WEEK_DAYS_SHORT[i]);
                    const isToday = d === todayLabel;
                    const completedEntry = completedDayMap[WEEK_DAYS_SHORT[i]];
                    const barColor = completedEntry?.color || "var(--lime)";
                    return (
                      <div key={i} style={{flex:1,textAlign:"center"}}>
                        {isTraining && isCompleted
                          ? <div style={{height:4,borderRadius:99,background:barColor,marginBottom:5}}/>
                          : isTraining && isToday
                            ? <div style={{height:4,borderRadius:99,background:"var(--lime)",marginBottom:5,animation:"pulse 1.5s infinite"}}/>
                            : isTraining
                              ? <div style={{height:4,borderRadius:99,border:"1px solid rgba(200,241,53,0.4)",background:"transparent",marginBottom:5}}/>
                              : <div style={{height:2,borderRadius:99,background:"var(--line)",marginBottom:7}}/>
                        }
                        <div style={{fontFamily:"var(--font-cond)",fontSize:9,fontWeight:700,color:isTraining?"var(--lime)":"var(--gray2)"}}>{WEEK_DAYS_DISPLAY[i]}</div>
                        {isToday && isTraining && <div style={{width:4,height:4,borderRadius:99,background:"var(--lime)",margin:"3px auto 0"}}/>}
                      </div>
                    );
                  })}
                </div>
                <div style={{fontFamily:"var(--font-display)",fontSize:40,lineHeight:0.9}}>
                  {workoutHistory.length>0?`${workoutHistory.length} ${t('workouts').toUpperCase()}`:`${t('start_first').toUpperCase()}`}
                </div>
                <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1,marginTop:6}}>{t('week1_label')} · {routine?.length||3} {t('days_week_plan')}</div>
              </div>
              {activeSession?.isActive && (
                <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid rgba(200,241,53,.25)",borderLeft:"4px solid var(--lime)",padding:18,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <div>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:4}}>{t('active_session')}</div>
                    <div style={{fontFamily:"var(--font-display)",fontSize:24,lineHeight:1}}>{(t(DAY_KEYS[routine?.[activeSession.dayIdx]?.name])||routine?.[activeSession.dayIdx]?.name||"WORKOUT").toUpperCase()}</div>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1,marginTop:2}}>{Object.keys(activeSession.completedSets||{}).length} {t('sets_completed_label')}</div>
                  </div>
                  <button onClick={resumeWorkout} style={{background:"var(--lime)",border:"none",borderRadius:12,padding:"12px 18px",fontFamily:"var(--font-cond)",fontWeight:800,fontSize:13,letterSpacing:2,color:"var(--black)",cursor:"pointer"}}>{t('resume')}</button>
                </div>
              )}
              {/* FIX 3 — Today-first schedule display */}
              {(() => {
                const WEEK_KEYS = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
                const todayKey = WEEK_KEYS[new Date().getDay()];
                const effectiveSchedule = (() => {
                  if (profile?.weekSchedule) return profile.weekSchedule;
                  const sched = {};
                  ["MON","TUE","WED","THU","FRI","SAT","SUN"].forEach(dk => { sched[dk] = null; });
                  (profile?.trainingDays || []).forEach((dk, i) => { sched[dk] = i % (routine?.length || 1); });
                  return sched;
                })();
                const todayWorkoutIdx2 = effectiveSchedule[todayKey];
                const todayDay2 = (todayWorkoutIdx2 !== null && todayWorkoutIdx2 !== undefined) ? routine?.[todayWorkoutIdx2] : null;
                const isTrainingDay2 = todayDay2 !== null && todayDay2 !== undefined;
                return (
                  <>
                    {isTrainingDay2 && todayDay2 ? (
                      <div onClick={() => {
                        if (activeSession?.isActive && activeSession.dayIdx !== todayWorkoutIdx2) {
                          setConflictPendingDayIdx(todayWorkoutIdx2);
                        } else if (activeSession?.isActive && activeSession.dayIdx === todayWorkoutIdx2) {
                          resumeWorkout();
                        } else {
                          startWorkout(todayWorkoutIdx2);
                        }
                      }} style={{background:"var(--card)",borderRadius:18,border:`1px solid ${todayDay2.color}44`,padding:24,cursor:"pointer",position:"relative",overflow:"hidden",marginBottom:8}}>
                        <div style={{position:"absolute",top:0,left:0,width:4,height:"100%",background:todayDay2.color}}/>
                        <div style={{paddingLeft:14}}>
                          <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:todayDay2.color,marginBottom:4}}>
                            {t('today').toUpperCase()} · {tDayLabel(todayDay2.label)}
                          </div>
                          <div style={{fontFamily:"var(--font-display)",fontSize:44,lineHeight:0.9,marginBottom:8}}>
                            {(t(DAY_KEYS[todayDay2.name])||todayDay2.name).toUpperCase()}
                          </div>
                          <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)",marginBottom:14}}>{tTag(todayDay2.tag)}</div>
                          <div style={{display:"flex",gap:16,alignItems:"center"}}>
                            <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{todayDay2.exercises.length} {t('exercises_count_label')}</span>
                            <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>~{40+todayDay2.exercises.length*3} {t('min_label')}</span>
                            <span style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,color:todayDay2.color,letterSpacing:1,marginLeft:"auto"}}>▶ {t('start_workout')}</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:24,marginBottom:8}}>
                        <div style={{fontFamily:"var(--font-display)",fontSize:52,lineHeight:0.9,marginBottom:12}}>{t('rest_day')}</div>
                        <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.7,marginBottom:16}}>
                          {RECOVERY_TIPS[new Date().getDate() % 10]}
                        </p>
                        <button onClick={()=>setSheet("stretching")} style={{width:"100%",background:"rgba(200,241,53,0.1)",border:"1px solid rgba(200,241,53,0.3)",borderRadius:12,padding:"14px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,color:"var(--lime)",cursor:"pointer"}}>
                          {t('light_stretching')}
                        </button>
                      </div>
                    )}
                    <div style={{marginTop:4,marginBottom:4}}>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:3,color:"var(--gray)",marginBottom:10}}>
                        {lang === 'es' ? 'ESTA SEMANA' : 'THIS WEEK'}
                      </div>
                      <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:6}}>
                        {(routine||[]).map((d, i) => {
                          const assignedDays = Object.entries(effectiveSchedule)
                            .filter(([,v]) => v === i).map(([k]) => k);
                          const completedToday = assignedDays.some(dayKey => {
                            const shortDays = ["MON","TUE","WED","THU","FRI","SAT","SUN"];
                            const shortLabels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
                            const di = shortDays.indexOf(dayKey);
                            const entry = weekProgress[di >= 0 ? shortLabels[di] : dayKey];
                            return !!entry;
                          });
                          return (
                            <div key={i} onClick={() => {
                              if (activeSession?.isActive && activeSession.dayIdx !== i) setConflictPendingDayIdx(i);
                              else if (activeSession?.isActive && activeSession.dayIdx === i) resumeWorkout();
                              else startWorkout(i);
                            }} style={{flexShrink:0,width:130,background:"var(--card)",borderRadius:14,
                              border:`1px solid ${i === todayWorkoutIdx2 ? d.color+'66' : 'var(--line)'}`,
                              padding:"12px 14px",cursor:"pointer",position:"relative",overflow:"hidden"}}>
                              <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:completedToday?d.color:"transparent"}}/>
                              <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:d.color,marginBottom:4}}>
                                {assignedDays.map(dayKey => tDayLabel(dayKey)).join(' · ') || (lang==='es'?'SIN ASIGNAR':'UNASSIGNED')}
                              </div>
                              <div style={{fontFamily:"var(--font-display)",fontSize:16,lineHeight:1,marginBottom:4}}>
                                {(t(DAY_KEYS[d.name])||d.name).toUpperCase()}
                              </div>
                              <div style={{fontFamily:"var(--font-cond)",fontSize:10,color:"var(--gray)",letterSpacing:1}}>
                                {d.exercises.length} {t('exercises_count_label')}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <button onClick={()=>setSheet("schedule")}
                      style={{width:"100%",background:"transparent",border:"1px dashed var(--line2)",borderRadius:12,
                        padding:"10px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,
                        letterSpacing:2,color:"var(--gray2)",cursor:"pointer"}}>
                      {lang==='es'?'✦ EDITAR HORARIO':'✦ EDIT SCHEDULE'}
                    </button>
                  </>
                );
              })()}
            </div>
            );
          })()}

          {/* ROUTINE */}
          {tab==="routine" && (
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <div className="fu" style={{background:"var(--card)",borderRadius:18,padding:20,border:"1px solid var(--line)"}}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:6}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)"}}>{t('ai_generated_month1')}</div>
                  <button onClick={openRebuildModal} style={{background:"rgba(200,241,53,.12)",border:"1px solid rgba(200,241,53,.3)",borderRadius:8,padding:"5px 12px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:10,letterSpacing:2,color:"var(--lime)",cursor:"pointer"}}>{t('customize_btn')}</button>
                </div>
                <div style={{fontFamily:"var(--font-display)",fontSize:36,lineHeight:0.9,marginBottom:8}}>{t('your_routine_title')}</div>
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
                    : `↺ ${t('regenerate')}`}
                </button>
              </div>
              {(routine||[]).map((d,i)=>(
                <div key={i} className="fu1">
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:d.color,marginBottom:10,paddingLeft:4}}>{tDayLabel(d.label)} — {(t(DAY_KEYS[d.name])||d.name).toUpperCase()}</div>
                  {d.exercises.map((e,j)=>(
                    <div key={j} style={{background:"var(--card)",borderRadius:12,padding:"13px 16px",border:"1px solid var(--line)",marginBottom:7,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <div>
                        <div style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:15}}>{e.name}</div>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1,marginTop:2}}>{e.sets} × {e.reps} · {e.muscles}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontFamily:"var(--font-display)",fontSize:18,color:d.color}}>{displayWeight(e.wA)}</div>
                        <div style={{fontFamily:"var(--font-display)",fontSize:14,color:"var(--gray2)"}}>{displayWeight(e.wB)}</div>
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
              {/* Close Room button — host only, no partner yet */}
              {!partnerProfile && roomCode && userSlot === "a" && (
                <div style={{display:"flex",justifyContent:"flex-end",marginBottom:4}}>
                  <button onClick={async () => {
                    if (!supabase || !roomCode) return;
                    try {
                      await supabase.from("rooms").delete().eq("room_code", roomCode);
                    } catch {}
                    localStorage.removeItem("str_room_code");
                    localStorage.removeItem("str_user_slot");
                    setRoomCode("");
                    setWaitingForPartner(false);
                    if (supaSubRef.current) { try { supaSubRef.current.unsubscribe(); } catch {} supaSubRef.current = null; }
                    setToast(t('room_closed')); setTimeout(() => setToast(null), 2000);
                  }} style={{background:"rgba(255,59,48,.1)",border:"1px solid rgba(255,59,48,.25)",borderRadius:8,padding:"6px 14px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:2,color:"var(--red)",cursor:"pointer"}}>{t('close_room')}</button>
                </div>
              )}
              {!partnerProfile ? (
                <>
                  <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:28,textAlign:"center"}}>
                    <div style={{fontFamily:"var(--font-display)",fontSize:36,lineHeight:0.9,marginBottom:10}}>{t('partner_not_connected')}</div>
                    <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>
                      {t('share_code_desc')}
                    </p>
                    {roomCode ? (
                      <>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>{t('your_room_code')}</div>
                        <div style={{fontFamily:"var(--font-display)",fontSize:56,color:"var(--lime)",letterSpacing:4,marginBottom:16,lineHeight:1}}>{roomCode}</div>
                        <Btn full onClick={handleCopyLink} style={{marginBottom:10}}>{copied?t('copied'):t('copy_code')}</Btn>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:10,color:"var(--gray2)",letterSpacing:1,marginBottom:16}}>stronnger.netlify.app/join/{roomCode}</div>
                        {isSupabaseConfigured ? (
                          <div style={{display:"flex",alignItems:"center",gap:8,justifyContent:"center"}}>
                            <div style={{width:8,height:8,borderRadius:99,background:"var(--lime)",animation:"pulse 1.5s infinite"}}/>
                            <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>{t('waiting_for_partner')}</span>
                          </div>
                        ) : (
                          <div style={{background:"rgba(200,241,53,0.08)",border:"1px solid rgba(200,241,53,0.2)",borderRadius:12,padding:"14px 16px",textAlign:"left",marginTop:4}}>
                            <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:6}}>{t('how_to_connect_label')}</div>
                            <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",lineHeight:1.6}}>
                              {t('how_to_connect_desc')}
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <Btn full onClick={handleInvite}>{t('generate_room_code')}</Btn>
                    )}
                  </div>
                  <div className="fu1" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:12}}>{t('join_a_partner')}</div>
                    <div style={{display:"flex",gap:8}}>
                      <input
                        value={joinInput}
                        onChange={e=>{setJoinInput(e.target.value.toUpperCase());setJoinError("");}}
                        placeholder="STR-XXXX"
                        style={{flex:1,background:"var(--dark)",border:"1.5px solid var(--line2)",borderRadius:10,padding:"12px 14px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:16,letterSpacing:2,color:"var(--white)",outline:"none"}}
                      />
                      <button onClick={handleJoin} style={{background:"var(--lime)",border:"none",borderRadius:10,padding:"12px 18px",fontFamily:"var(--font-cond)",fontWeight:900,fontSize:13,letterSpacing:2,color:"var(--black)",cursor:"pointer"}}>{t('join_btn')}</button>
                    </div>
                    {joinError && <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--red)",marginTop:8}}>{joinError}</div>}
                  </div>
                </>
              ) : (() => {
                // Derive live partner session from roomData (updated via subscription)
                const partnerRoomSlot = userSlot === 'a' ? 'active_session_b' : 'active_session_a';
                const pSession = roomData?.[partnerRoomSlot] || partnerProfile._activeSession;
                const pLastWorkout = partnerProfile._lastWorkout;
                const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
                const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
                const isPartnerActive = pSession?.isActive && (pSession.lastActivityAt || pSession.startedAt || 0) > twoHoursAgo;
                const partnerStatus =
                  isPartnerActive
                    ? t('training_now')
                    : (pSession?.lastActivityAt || 0) > oneDayAgo || pLastWorkout?.date === new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})
                      ? t('last_seen_today')
                      : t('not_training');
                const statusColor = partnerStatus === 'TRAINING NOW' ? '#C8F135' : partnerStatus === 'LAST SEEN TODAY' ? '#FF9F0A' : '#555';
                const fmtElapsed = (s) => {
                  const m = Math.floor(s / 60);
                  const sec = s % 60;
                  return `${m}:${String(sec).padStart(2,"0")}`;
                };
                const completedExCount = isPartnerActive
                  ? [...new Set(Object.keys(pSession.completedSets||{}).map(k=>k.split("-")[0]))].length
                  : 0;
                const sendQuickMsg = (text) => sendChatMsg(text);
                const handleLeaveRoom = async () => {
                  try {
                    if (supabase && roomCode) {
                      const col = userSlot === "a" ? "user_a" : "user_b";
                      await supabase.from("rooms").update({ [col]: null }).eq("room_code", roomCode);
                    }
                  } catch {}
                  localStorage.removeItem("str_room_code");
                  localStorage.removeItem("str_user_slot");
                  setRoomCode("");
                  setPartnerProfile(null);
                  setWaitingForPartner(false);
                  if (roomChannelRef.current) { try { supabase?.removeChannel(roomChannelRef.current); } catch {} roomChannelRef.current = null; }
                  setToast(t('left_the_room')); setTimeout(() => setToast(null), 2000);
                };
                return (
                  <>
                    {/* Partner header */}
                    <div className="fu" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20}}>
                      <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
                        <div style={{width:52,height:52,borderRadius:99,background:"var(--lime)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-display)",fontSize:24,color:"var(--black)",flexShrink:0}}>{(partnerProfile.name||"?").slice(0,2).toUpperCase()}</div>
                        <div style={{flex:1}}>
                          <div style={{fontFamily:"var(--font-display)",fontSize:28,lineHeight:1}}>{(partnerProfile.name||"PARTNER").toUpperCase()}</div>
                          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
                            <div style={{width:7,height:7,borderRadius:99,background:statusColor,animation:partnerStatus==='TRAINING NOW'?"pulse 1.5s infinite":undefined}}/>
                            <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:statusColor}}>{partnerStatus}</span>
                          </div>
                          {partnerStatus === 'TRAINING NOW' && pSession && (
                            <div style={{fontSize:13,color:"#888",fontFamily:"var(--font-cond)",marginTop:4}}>
                              NOW: <span style={{color:"var(--white)"}}>{pSession.dayName?.toUpperCase()}</span>
                              {' · '}{Object.keys(pSession.completedSets||{}).length} / {pSession.totalSetsInRoutine} SETS
                            </div>
                          )}
                        </div>
                        <button onClick={handleLeaveRoom} style={{background:"rgba(255,59,48,.1)",border:"1px solid rgba(255,59,48,.25)",borderRadius:8,padding:"6px 12px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:10,letterSpacing:2,color:"var(--red)",cursor:"pointer",flexShrink:0}}>{t('leave')}</button>
                      </div>

                      {isPartnerActive ? (
                        /* ── Active session view ── */
                        <div>
                          <div style={{fontFamily:"var(--font-display)",fontSize:42,lineHeight:0.9,marginBottom:8,color:pSession.dayColor||pSession.color||"var(--lime)"}}>{(pSession.exerciseName||"TRAINING").toUpperCase()}</div>
                          {/* Exercise progress */}
                          <div style={{marginBottom:12}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                              <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>{t('exercises_label')}</span>
                              <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:1,color:"var(--white)"}}>{completedExCount} / {pSession.totalExercises}</span>
                            </div>
                            <div style={{height:4,background:"var(--line)",borderRadius:99}}>
                              <div style={{height:"100%",borderRadius:99,background:pSession.dayColor||pSession.color||"var(--lime)",width:`${(completedExCount/(pSession.totalExercises||1))*100}%`,transition:"width .4s"}}/>
                            </div>
                          </div>
                          {/* Set progress — total sets from partner's own session data */}
                          <div style={{marginBottom:12}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                              <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>{t('sets_done_label')}</span>
                              <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--white)"}}>{Object.keys(pSession.completedSets||{}).length} / {pSession.totalSetsInRoutine||"?"}</span>
                            </div>
                            <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                              {Array.from({length: pSession.totalSetsInRoutine||0}).map((_,i)=>{
                                const done = i < Object.keys(pSession.completedSets||{}).length;
                                const c = pSession.dayColor||pSession.color||"var(--lime)";
                                return <div key={i} style={{width:10,height:10,borderRadius:99,background:done?c:"var(--line)",border:`1.5px solid ${done?c:"var(--line2)"}`}}/>;
                              })}
                            </div>
                          </div>
                          <div style={{display:"flex",gap:10,marginBottom:16}}>
                            <div style={{flex:1,background:"var(--dark)",borderRadius:12,padding:"10px 14px",textAlign:"center"}}>
                              <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--gray)",marginBottom:3}}>{t('weight_label')}</div>
                              <div style={{fontFamily:"var(--font-display)",fontSize:22,color:"var(--white)"}}>{pSession.currentWeight ? displayWeight(pSession.currentWeight) : "—"}</div>
                            </div>
                            <div style={{flex:1,background:"var(--dark)",borderRadius:12,padding:"10px 14px",textAlign:"center"}}>
                              <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--gray)",marginBottom:3}}>{t('elapsed_label')}</div>
                              <div style={{fontFamily:"var(--font-display)",fontSize:22,color:"var(--lime)"}}>{fmtElapsed(partnerElapsedSecs)}</div>
                            </div>
                          </div>
                          <Btn full onClick={()=>sendQuickMsg("You've got this!")}>{t('cheer_on_btn')}</Btn>
                        </div>
                      ) : (
                        /* ── Idle view ── */
                        <div>
                          {pLastWorkout ? (
                            <div style={{background:"var(--dark)",borderRadius:12,padding:14,marginBottom:14}}>
                              <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:6}}>{t('last_workout_label')}</div>
                              <div style={{fontFamily:"var(--font-display)",fontSize:24,marginBottom:4,color:pLastWorkout.color||"var(--lime)"}}>{(pLastWorkout.dayName||"").toUpperCase()}</div>
                              <div style={{display:"flex",gap:14}}>
                                <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{pLastWorkout.date}</span>
                                <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{pLastWorkout.duration}m</span>
                                <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{pLastWorkout.totalSets} sets</span>
                                {pLastWorkout.totalVolume ? <span style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:1}}>{pLastWorkout.totalVolume?.toLocaleString()}kg vol</span> : null}
                              </div>
                            </div>
                          ) : (
                            <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",marginBottom:14}}>{t('no_workouts_yet')}</div>
                          )}
                          <Btn full onClick={()=>{
                            if (roomChannelRef.current) {
                              roomChannelRef.current.send({
                                type:'broadcast', event:'train_together_invite',
                                payload:{ fromName: profile.name, ts: Date.now() }
                              }).catch(()=>{});
                            }
                            setTab('today');
                            setToast((t('train_invite_sent')||'Invite sent! Go to Today to start.').replace('{name}', partnerProfile?.name||'partner'));
                            setTimeout(()=>setToast(null), 4000);
                          }}>{t('train_together_btn')||'TRAIN TOGETHER?'}</Btn>
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
              const dates = workoutHistory.map(h => new Date(h.date + ` ${new Date().getFullYear()}`).toDateString());
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
              { label:t('workouts'), value: totalWorkouts, unit:"" },
              { label:t('volume'), value: totalVolume >= 1000 ? `${(totalVolume/1000).toFixed(1)}k` : totalVolume, unit:"kg" },
              { label:t('streak'), value: streak, unit:" days" },
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
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"#FF9F0A",marginBottom:3}}>{t('storage_warning_label')}</div>
                    <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",lineHeight:1.5}}>{t('storage_full_desc')}</div>
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
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:3,color:"var(--gray)"}}>{t('body_weight_label')}</div>
                    <button onClick={()=>{const _rawWL=parseFloat(profile?.weight||'0');setWeightInput(_rawWL>0?String(toDisplay(_rawWL)):"");setShowWeightModal(true);}} style={{background:"rgba(200,241,53,0.1)",border:"1px solid rgba(200,241,53,0.3)",borderRadius:8,padding:"6px 12px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:2,color:"var(--lime)",cursor:"pointer"}}>{t('log_weight')}</button>
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
                  {weightLog.length > 0 && <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:1,color:"var(--gray)",marginTop:8}}>Latest: {toDisplay(weightLog[weightLog.length-1].weight)}{unitLabel} · {weightLog.length} entries</div>}
                </div>

                {/* Workout feed */}
                {workoutHistory.length === 0 ? (
                  <div className="fu1" style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:28,textAlign:"center"}}>
                    <div style={{fontFamily:"var(--font-display)",fontSize:28,marginBottom:8}}>{t('no_workouts_yet')}</div>
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
                          [t('sets_stat'), h.totalSets],
                          [t('exercises_count_label'), h.exercises],
                          [t('max_wt_stat'), h.maxWeight ? displayWeight(`${h.maxWeight}kg`) : "—"],
                          [t('volume_stat'), h.totalVolume ? `${h.totalVolume>=1000?(h.totalVolume/1000).toFixed(1)+"k":h.totalVolume}kg` : "—"],
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
                            >{t('share_btn')}</button>
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
                          <span style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)"}}>{t('add_photo_label')}</span>
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
          {[["today",t('today')],["routine",t('routine')],["partner",t('partner')],["progress",t('progress')]].map(([k,l])=>(
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
              <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:8}}>{t('active_session')}</div>
              <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>
                You have an unfinished <strong style={{color:"var(--white)"}}>{(routine?.[activeSession?.dayIdx]?.name||"workout").toUpperCase()}</strong>. What do you want to do?
              </p>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <Btn full onClick={resumeWorkout}>{t('resume_current')}</Btn>
                <Btn variant="red-soft" full onClick={()=>{ endWorkoutNow(); startWorkout(conflictPendingDayIdx); }}>{t('end_start_new')}</Btn>
                <Btn variant="ghost" full onClick={()=>setConflictPendingDayIdx(null)}>{t('cancel')}</Btn>
              </div>
            </div>
          </div>
        )}

        {/* Logout modal */}
        {showLogout && (
          <div onClick={()=>setShowLogout(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,backdropFilter:"blur(4px)"}}>
            <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#181818",borderRadius:"24px 24px 0 0",padding:28,animation:"slideIn .3s cubic-bezier(.4,0,.2,1)"}}>
              <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:8}}>{t('sign_out')}</div>
              <p style={{fontFamily:"var(--font-body)",fontSize:14,color:"var(--gray)",lineHeight:1.6,marginBottom:24}}>
                {t('sign_out_desc')}
              </p>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {/* Regular logout: return to splash, keep all data so PIN login still works */}
                <Btn full onClick={()=>{setShowLogout(false);setScreen("splash");}}>{t('logout')}</Btn>
                {/* Full erase: clear everything and restart from scratch */}
                <Btn variant="red-soft" full onClick={()=>{
                  localStorage.clear();
                  setProfile(null); setPinHash(null); setRoutine(null); setAiSummary(""); setWorkoutHistory([]); setMessages([]);
                  setNewPIN(""); setConfirmPin("");
                  setRoomCode(""); setRoomRole(""); setPartnerProfile(null); setWaitingForPartner(false);
                  setShowLogout(false); setScreen("splash");
                }}>{t('logout_erase')}</Btn>
                <Btn variant="ghost" full onClick={()=>setShowLogout(false)}>{t('cancel')}</Btn>
              </div>
            </div>
          </div>
        )}
        {/* FIX 2 — Schedule sheet */}
        {sheet === "schedule" && (
          <SheetWrapper onClose={()=>setSheet(null)}>
            <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:4}}>{t('edit_schedule')||'EDIT SCHEDULE'}</div>
            <div style={{fontFamily:"var(--font-cond)",fontSize:11,color:"var(--gray)",letterSpacing:2,marginBottom:20}}>ASSIGN YOUR WORKOUTS</div>
            {["MON","TUE","WED","THU","FRI","SAT","SUN"].map(day => (
              <div key={day} style={{display:"flex",alignItems:"center",gap:8,padding:"10px 0",borderBottom:"1px solid var(--line)"}}>
                <span style={{fontFamily:"var(--font-cond)",fontWeight:700,fontSize:14,color:"var(--gray)",width:36}}>{day}</span>
                <div style={{display:"flex",gap:6,flex:1,flexWrap:"wrap"}}>
                  <button onClick={()=>p("weekSchedule",{...profile.weekSchedule,[day]:null})}
                    style={{padding:"5px 10px",borderRadius:99,fontSize:11,fontFamily:"var(--font-cond)",
                      background:profile.weekSchedule?.[day]==null?"#333":"transparent",
                      color:profile.weekSchedule?.[day]==null?"#fff":"#555",
                      border:"1px solid #333",cursor:"pointer"}}>REST</button>
                  {(routine||[]).map((rd,i)=>(
                    <button key={i} onClick={()=>p("weekSchedule",{...profile.weekSchedule,[day]:i})}
                      style={{padding:"5px 10px",borderRadius:99,fontSize:11,fontFamily:"var(--font-cond)",
                        background:profile.weekSchedule?.[day]===i?rd.color:"transparent",
                        color:profile.weekSchedule?.[day]===i?"#080808":"#555",
                        border:`1px solid ${profile.weekSchedule?.[day]===i?rd.color:"#333"}`,cursor:"pointer"}}>
                      {(t(DAY_KEYS[rd.name])||rd.name).split(" ")[0]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div style={{marginTop:20}}>
              <Btn full onClick={()=>setSheet(null)}>{t('save')||'SAVE'}</Btn>
            </div>
          </SheetWrapper>
        )}

        {/* Feature 4D — Stretching sheet */}
        {sheet === "stretching" && (
          <div onClick={()=>setSheet(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:50,backdropFilter:"blur(4px)"}}>
            <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#181818",borderRadius:"24px 24px 0 0",padding:28,animation:"slideIn .3s cubic-bezier(.4,0,.2,1)",maxHeight:"85vh",overflowY:"auto"}}>
              <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:4}}>{t('stretching_title')}</div>
              <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--gray)",marginBottom:20}}>{t('light_recovery_routine')}</div>
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
              <Btn full variant="ghost" onClick={()=>setSheet(null)} style={{marginTop:8}}>{t('close')}</Btn>
            </div>
          </div>
        )}

        {/* Feature 4F — Weight log modal */}
        {showWeightModal && (
          <div onClick={()=>setShowWeightModal(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.75)",zIndex:60,backdropFilter:"blur(4px)"}}>
            <div onClick={e=>e.stopPropagation()} style={{position:"absolute",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:"#181818",borderRadius:"24px 24px 0 0",padding:28}}>
              <div style={{fontFamily:"var(--font-display)",fontSize:36,marginBottom:16}}>{t('log_weight_title')}</div>
              <input type="number" value={weightInput} onChange={e=>setWeightInput(e.target.value)} placeholder={weightUnit === 'lbs' ? 'lbs' : 'kg'} step="0.1"
                style={{width:"100%",background:"var(--dark)",border:"1.5px solid var(--line2)",borderRadius:10,padding:"14px 16px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:24,color:"var(--white)",outline:"none",boxSizing:"border-box",marginBottom:16}}/>
              <Btn full onClick={()=>{
                const w = parseFloat(weightInput);
                const minW = weightUnit === 'lbs' ? 44 : 20;
                const maxW = weightUnit === 'lbs' ? 660 : 300;
                if (!w || w < minW || w > maxW) return;
                setWeightLog(prev=>[...prev,{date:new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"}),weight:fromDisplay(w)}]);
                setShowWeightModal(false);
              }}>{t('save_btn')}</Btn>
            </div>
          </div>
        )}

        {/* Rebuild success toast */}
        {rebuildSuccess && (
          <div style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",background:"var(--lime)",color:"var(--black)",borderRadius:12,padding:"10px 20px",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:13,letterSpacing:2,zIndex:200,animation:"slideIn 0.3s ease",whiteSpace:"nowrap"}}>
            {t('routine_rebuilt')}
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
          const GOALS_RD  = ["Gain Muscle Mass","Increase Strength","Improve Physical Fitness","Definition","Body Toning","Cardiovascular","Weight / Fat Loss","Stay Active"];
          const LEVELS_RD = ["Beginner","Intermediate","Advanced"];
          const EQUIP_RD  = ["Full gym","Dumbbells only","Barbell + rack","Cables","Machines","Resistance bands"];
          const ALL_DAYS_RD = ["MON","TUE","WED","THU","FRI","SAT","SUN"];
          const DAYS_COUNT_RD = ["2","3","4","5","6"];
          const getDayPresetRd = (n) => ({2:["TUE","FRI"],3:["MON","WED","FRI"],4:["MON","TUE","THU","FRI"],5:["MON","TUE","WED","THU","FRI"],6:["MON","TUE","WED","THU","FRI","SAT"]}[n] || ["MON","WED","FRI"]);
          const GOAL_CONFLICT_RD = {
            "Gain Muscle Mass_Weight / Fat Loss":"Building muscle needs a surplus; fat loss needs a deficit. Pick the priority that matters most right now.",
            "Weight / Fat Loss_Gain Muscle Mass":"Building muscle needs a surplus; fat loss needs a deficit. Pick the priority that matters most right now.",
            "Increase Strength_Cardiovascular":"Strength training and cardio interfere with each other. Pick one as primary for best results.",
            "Cardiovascular_Increase Strength":"Strength training and cardio interfere with each other. Pick one as primary for best results.",
            "Body Toning_Increase Strength":"Toning and strength use opposite rep schemes. Pick the one that matches your goal.",
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
                  <button onClick={()=>{setShowRebuildModal(false);setRebuildDraft(null);setRebuildPreview(null);setShowRebuildPreview(false);setRebuildConflict(null);}} style={{background:"none",border:"none",color:"var(--gray)",fontFamily:"var(--font-cond)",fontSize:13,letterSpacing:2,cursor:"pointer",padding:0}}>{t('cancel_arrow')}</button>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)"}}>{t('customize_label')}</div>
                </div>
                <div style={{fontFamily:"var(--font-display)",fontSize:48,lineHeight:0.88,marginBottom:24}}>REBUILD<br/>ROUTINE</div>

                {activeSession?.isActive && (
                  <div style={{background:"rgba(255,59,48,.1)",border:"1px solid rgba(255,59,48,.3)",borderRadius:14,padding:"12px 16px",marginBottom:20}}>
                    <div style={{fontFamily:"var(--font-cond)",fontSize:11,letterSpacing:2,color:"var(--red)",marginBottom:4}}>{t('active_workout_label')}</div>
                    <div style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",lineHeight:1.5}}>{t('active_workout_desc')}</div>
                  </div>
                )}

                {/* A — Training Days */}
                <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>{t('section_training_days')}</div>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>{t('days_per_week_upper')}</div>
                  <div className="chip-select" style={{marginBottom:16}}>
                    {DAYS_COUNT_RD.map(v=>(
                      <button key={v} className={`chip${rd.daysPerWeek===v?" active":""}`} onClick={()=>{setRd("daysPerWeek",v);setRd("trainingDays",getDayPresetRd(parseInt(v)));}}>{v}</button>
                    ))}
                  </div>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>{t('training_days_upper2')}</div>
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
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>{t('section_muscle_focus')}</div>
                  <div style={{display:"flex",gap:14,marginBottom:16}}>
                    <div style={{flex:1}}>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>{t('upper_body_upper')}</div>
                      <div style={{display:"flex",flexDirection:"column",gap:7}}>
                        {["Chest","Back","Shoulders","Arms","Core"].map(v=>(
                          <button key={v} onClick={()=>toggleRdArr("priorityMuscles",v)} className={(rd.priorityMuscles||[]).includes(v)?"chip active":"chip"} style={{textAlign:"left"}}>{t(MUSCLE_KEYS[v])||v}</button>
                        ))}
                      </div>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>{t('lower_body_upper')}</div>
                      <div style={{display:"flex",flexDirection:"column",gap:7}}>
                        {["Glutes","Quads","Hamstrings","Calves","Full Lower Body"].map(v=>(
                          <button key={v} onClick={()=>toggleRdArr("priorityMuscles",v)} className={(rd.priorityMuscles||[]).includes(v)?"chip active":"chip"} style={{textAlign:"left",fontSize:11}}>{t(MUSCLE_KEYS[v])||v}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:3,color:"var(--gray)",marginBottom:8}}>{t('split_focus_upper')}</div>
                  <div className="chip-select">
                    {["Balanced","More lower body","More upper body","Full body"].map(v=>(
                      <button key={v} className={`chip${(rd.splitPreference||"Balanced")===v?" active":""}`} onClick={()=>setRd("splitPreference",v)}>{t(SPLIT_KEYS[v])||v}</button>
                    ))}
                  </div>
                </div>

                {/* C — Goal */}
                <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>{t('section_primary_goal')}</div>
                  <div className="chip-select" style={{marginBottom:rebuildConflict?12:0}}>
                    {GOALS_RD.map(v=>(
                      <button key={v} className={`chip${rd.goal===v?" active":""}`} onClick={()=>handleRdGoal(v)}>{t(GOAL_KEYS[v])||v}</button>
                    ))}
                  </div>
                  {rebuildConflict && (
                    <div style={{background:"var(--dark)",borderRadius:12,borderLeft:"3px solid var(--lime)",padding:"12px 14px",marginTop:12,animation:"fadeIn 0.2s ease"}}>
                      <p style={{fontFamily:"var(--font-body)",fontSize:13,color:"var(--gray)",lineHeight:1.6,marginBottom:10}}>{rebuildConflict.explanation}</p>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>{setRd("goal",rebuildConflict.pending);setRebuildConflict(null);if(rebuildConflictTimer)clearTimeout(rebuildConflictTimer);}} style={{flex:1,background:"var(--lime)",border:"none",borderRadius:8,padding:"9px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:1,color:"var(--black)",cursor:"pointer"}}>{t('got_it')}</button>
                        <button onClick={()=>{setRebuildConflict(null);if(rebuildConflictTimer)clearTimeout(rebuildConflictTimer);}} style={{flex:1,background:"transparent",border:"1px solid var(--line2)",borderRadius:8,padding:"9px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:11,letterSpacing:1,color:"var(--gray)",cursor:"pointer"}}>{t('keep_goal')} {rd.goal}</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* D — Level */}
                <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>{t('section_training_level')}</div>
                  <div className="chip-select" style={{marginBottom:12}}>
                    {LEVELS_RD.map(v=>(
                      <button key={v} className={`chip${(rd.level||"").toLowerCase()===v.toLowerCase()?" active":""}`} onClick={()=>setRd("level",v.toLowerCase())}>{t(LEVEL_KEYS[v])||v}</button>
                    ))}
                  </div>
                  <div style={{background:"var(--dark)",borderRadius:10,padding:"10px 12px"}}>
                    <div style={{fontFamily:"var(--font-body)",fontSize:12,color:"var(--gray)",lineHeight:1.5}}>Changing your level adjusts sets, reps, and weight recommendations.</div>
                  </div>
                </div>

                {/* E — Equipment */}
                <div style={{background:"var(--card)",borderRadius:18,border:"1px solid var(--line)",padding:20,marginBottom:14}}>
                  <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>{t('section_equipment')}</div>
                  <div className="chip-select" style={{marginBottom:equipWarning?12:0}}>
                    {EQUIP_RD.map(v=>(
                      <button key={v} className={`chip${(rd.equipment||[]).includes(v)?" active":""}`} onClick={()=>toggleRdArr("equipment",v)}>{t(EQUIP_KEYS[v])||v}</button>
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
                    <div style={{fontFamily:"var(--font-cond)",fontSize:10,letterSpacing:3,color:"var(--lime)",marginBottom:14}}>{t('routine_preview_label')}</div>
                    {rebuildPreview.removed.length > 0 && (
                      <div style={{marginBottom:12}}>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--red)",marginBottom:6}}>{t('removed_label')}</div>
                        {rebuildPreview.removed.map(n=><div key={n} style={{fontFamily:"var(--font-cond)",fontSize:13,color:"var(--red)",padding:"5px 0",borderBottom:"1px solid var(--line)",opacity:0.8}}>− {n}</div>)}
                      </div>
                    )}
                    {rebuildPreview.added.length > 0 && (
                      <div style={{marginBottom:12}}>
                        <div style={{fontFamily:"var(--font-cond)",fontSize:9,letterSpacing:2,color:"var(--lime)",marginBottom:6}}>{t('new_label')}</div>
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
                <Btn full onClick={handleRebuildConfirm}>{t('rebuild_my_routine')}</Btn>
                <button onClick={()=>{const prev=computePreview(rebuildDraft);setRebuildPreview(prev);setShowRebuildPreview(true);}} style={{width:"100%",background:"transparent",border:"1.5px solid rgba(200,241,53,.3)",borderRadius:14,padding:"14px 0",fontFamily:"var(--font-cond)",fontWeight:700,fontSize:14,letterSpacing:2,color:"var(--lime)",cursor:"pointer"}}>{t('preview_changes')}</button>
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
            onSend={sendChatMsg}
            lang={lang}
          />
        )}

      </div>
    </>
  );
}

export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}
