import { Redis } from "@upstash/redis";

// ---- Redis client (handles bare KV_* and Upstash Marketplace STORAGE_* prefixes) ----
let _redis = null;
export function getRedis() {
  if (_redis) return _redis;
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.STORAGE_KV_REST_API_URL ||
    process.env.STORAGE_REDIS_REST_API_URL;
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.STORAGE_KV_REST_API_TOKEN ||
    process.env.STORAGE_REDIS_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Redis not configured: missing REST URL/TOKEN env vars");
  }
  _redis = new Redis({ url, token });
  return _redis;
}

// ---- Keys ----
export const KEYS = {
  config: "wc:config",
  results: "wc:results",
  preds: "wc:preds",
  names: "wc:names",
  visits: "wc:visits",
};

// ---- Tournament structure (World Cup focus: fixed stage shape) ----
export const STRUCTURE = {
  groupCount: 12, // group winners predicted
  qf: 8, // quarter-finalists
  sf: 4, // semi-finalists
  fn: 2, // finalists
};

// ---- Default scoring (admin can override at runtime) ----
export const DEFAULT_POINTS = {
  group: 3,
  qf: 5,
  sf: 10,
  fn: 20,
  champion: 30,
  wrong: 1, // subtracted per wrong pick once that stage's results are entered
};

// ---- Default groups: 48 teams, 12 groups (placeholder seed — admin edits in wizard) ----
export const DEFAULT_GROUPS = [
  { id: "A", name: "Group A", teams: ["Mexico", "Croatia", "Ecuador", "Saudi Arabia"] },
  { id: "B", name: "Group B", teams: ["Canada", "Belgium", "Morocco", "Uzbekistan"] },
  { id: "C", name: "Group C", teams: ["USA", "Senegal", "Australia", "Panama"] },
  { id: "D", name: "Group D", teams: ["Argentina", "Japan", "Nigeria", "Norway"] },
  { id: "E", name: "Group E", teams: ["France", "Mexico B", "Egypt", "New Zealand"] },
  { id: "F", name: "Group F", teams: ["Brazil", "Switzerland", "South Korea", "Jordan"] },
  { id: "G", name: "Group G", teams: ["England", "Uruguay", "Ivory Coast", "Qatar"] },
  { id: "H", name: "Group H", teams: ["Spain", "Colombia", "Ghana", "Costa Rica"] },
  { id: "I", name: "Group I", teams: ["Portugal", "Netherlands", "Cameroon", "Iran"] },
  { id: "J", name: "Group J", teams: ["Germany", "Denmark", "Tunisia", "Curaçao"] },
  { id: "K", name: "Group K", teams: ["Italy", "Mexico C", "Algeria", "Haiti"] },
  { id: "L", name: "Group L", teams: ["Netherlands B", "Austria", "Mali", "Jordan B"] },
];

export const DEFAULT_BRAND = {
  name: "World Cup 2026 Predictor",
  tagline: "Predict the bracket. Top the office leaderboard.",
  logoUrl: "", // company pastes a hosted URL, or wizard stores a small data URI
  color: "#003da5", // primary brand color
};

export function defaultConfig() {
  return {
    initialized: false,
    brand: { ...DEFAULT_BRAND },
    groups: DEFAULT_GROUPS.map((g) => ({ ...g, teams: [...g.teams] })),
    points: { ...DEFAULT_POINTS },
  };
}

export async function getConfig() {
  const raw = await getRedis().get(KEYS.config);
  if (!raw) return defaultConfig();
  const cfg = typeof raw === "string" ? JSON.parse(raw) : raw;
  // backfill any missing fields against defaults
  return {
    initialized: !!cfg.initialized,
    brand: { ...DEFAULT_BRAND, ...(cfg.brand || {}) },
    groups: Array.isArray(cfg.groups) && cfg.groups.length ? cfg.groups : defaultConfig().groups,
    points: { ...DEFAULT_POINTS, ...(cfg.points || {}) },
  };
}

export async function setConfig(cfg) {
  await getRedis().set(KEYS.config, JSON.stringify(cfg));
}

// ---- Validation ----
export function normName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Validate a submitted prediction against the live config. Returns {ok, error}.
export function validatePrediction(pred, cfg) {
  if (!pred || typeof pred !== "object") return { ok: false, error: "Bad payload" };
  const name = String(pred.name || "").trim();
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Name must be 2-60 characters" };

  const groups = pred.groups || {};
  const teamSet = new Set();
  for (const g of cfg.groups) for (const t of g.teams) teamSet.add(t);

  // group winners: one valid team per group, and that team must belong to its group
  for (const g of cfg.groups) {
    const pick = groups[g.id];
    if (!pick) return { ok: false, error: `Pick a winner for ${g.name}` };
    if (!g.teams.includes(pick)) return { ok: false, error: `Invalid winner for ${g.name}` };
  }

  const arrCheck = (arr, count, label) => {
    if (!Array.isArray(arr) || arr.length !== count)
      return `Select exactly ${count} ${label}`;
    const seen = new Set();
    for (const t of arr) {
      if (!teamSet.has(t)) return `Invalid ${label} pick: ${t}`;
      if (seen.has(t)) return `Duplicate ${label} pick: ${t}`;
      seen.add(t);
    }
    return null;
  };

  let e;
  if ((e = arrCheck(pred.qf, STRUCTURE.qf, "quarter-finalists"))) return { ok: false, error: e };
  if ((e = arrCheck(pred.sf, STRUCTURE.sf, "semi-finalists"))) return { ok: false, error: e };
  if ((e = arrCheck(pred.fn, STRUCTURE.fn, "finalists"))) return { ok: false, error: e };
  if (!pred.champion || !teamSet.has(pred.champion))
    return { ok: false, error: "Pick a valid champion" };

  return { ok: true };
}

// ---- Scoring (server-side) ----
// Penalty for a stage only applies once that stage's results have been entered.
export function scoreOf(pred, results, points) {
  const P = { ...DEFAULT_POINTS, ...(points || {}) };
  const R = results || {};
  let score = 0;

  // Group winners — scored per-group as each group's result lands.
  const rGroups = R.groups || {};
  for (const gid of Object.keys(rGroups)) {
    const actual = rGroups[gid];
    if (!actual) continue;
    const pick = (pred.groups || {})[gid];
    if (pick === actual) score += P.group;
    else score -= P.wrong;
  }

  // Array stages — scored once the stage's result array is non-empty.
  const stage = (predArr, resArr, pts) => {
    if (!Array.isArray(resArr) || resArr.length === 0) return;
    const actual = new Set(resArr);
    for (const t of predArr || []) {
      if (actual.has(t)) score += pts;
      else score -= P.wrong;
    }
  };
  stage(pred.qf, R.qf, P.qf);
  stage(pred.sf, R.sf, P.sf);
  stage(pred.fn, R.fn, P.fn);

  // Champion — single pick.
  if (R.champion) {
    if (pred.champion === R.champion) score += P.champion;
    else score -= P.wrong;
  }

  // Floor at zero — never show negative totals on the leaderboard.
  return Math.max(0, score);
}

// ---- Shared HTTP helpers ----
export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Vercel-CDN-Cache-Control", "no-store");
}

export function adminCode() {
  return process.env.ADMIN_CODE || "wc2026admin";
}

// Constant-time-ish compare to blunt trivial timing leaks on the code check.
export function checkCode(input) {
  const a = String(input || "");
  const b = adminCode();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
