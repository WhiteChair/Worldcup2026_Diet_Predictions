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

// ---- Hard limits (cost containment) ----
export const MAX_POOLS = 100;
export const MAX_PLAYERS_PER_POOL = 250;
export const CREATE_PER_IP_PER_DAY = 5; // anti-spam on open pool creation

// ---- Hard kill: every deployment self-closes at this instant (tournament over) ----
export const KILL_TS = Date.parse("2026-08-01T00:00:00Z");
// Keep data ~2 weeks past the kill so storage auto-frees, then is gone.
export const DATA_EXPIRE_TS = KILL_TS + 14 * 24 * 60 * 60 * 1000;
export function isKilled() {
  return Date.now() >= KILL_TS;
}

// ---- Global keys ----
export const POOLS_KEY = "wc:pools"; // set of pool ids
export const GLOBAL_RESULTS_KEY = "wc:global:results"; // one official result set, shared by all pools
export const HOME_VISITS_KEY = "wc:global:homevisits"; // visits to the landing/create page
export const POOLS_MADE_KEY = "wc:global:poolsmade"; // cumulative count of pools ever created

// ---- Per-pool key builder ----
export function K(poolId) {
  const p = `wc:${poolId}:`;
  return {
    config: p + "config",
    preds: p + "preds", // full entries (admin/CSV/recompute only)
    names: p + "names", // dedupe set; SCARD = player count
    board: p + "board", // cached sorted leaderboard (compact)
    stats: p + "stats", // cached pick distributions (compact)
    visits: p + "visits",
    token: p + "token", // per-pool admin token
  };
}

// Apply the shared expiry to every key of a pool so storage frees itself after the kill.
export async function touchExpiry(redis, poolId) {
  const k = K(poolId);
  const at = Math.floor(DATA_EXPIRE_TS / 1000);
  await Promise.all(
    [k.config, k.preds, k.names, k.board, k.stats, k.visits, k.token].map((key) =>
      redis.expireat(key, at).catch(() => {})
    )
  );
}

// ---- Tournament structure (fixed World Cup shape) ----
export const STRUCTURE = { groupCount: 12, qf: 8, sf: 4, fn: 2 };

// ---- Default scoring (per-pool, admin can override) ----
export const DEFAULT_POINTS = { group: 3, qf: 5, sf: 10, fn: 20, champion: 30, wrong: 1 };

// ---- Default groups: official FIFA World Cup 2026 final draw (5 Dec 2025) ----
export const DEFAULT_GROUPS = [
  { id: "A", name: "Group A", teams: ["Mexico", "South Africa", "South Korea", "Czechia"] },
  { id: "B", name: "Group B", teams: ["Canada", "Bosnia and Herzegovina", "Qatar", "Switzerland"] },
  { id: "C", name: "Group C", teams: ["Brazil", "Morocco", "Haiti", "Scotland"] },
  { id: "D", name: "Group D", teams: ["United States", "Paraguay", "Australia", "Turkey"] },
  { id: "E", name: "Group E", teams: ["Germany", "Curaçao", "Ivory Coast", "Ecuador"] },
  { id: "F", name: "Group F", teams: ["Netherlands", "Japan", "Sweden", "Tunisia"] },
  { id: "G", name: "Group G", teams: ["Belgium", "Egypt", "Iran", "New Zealand"] },
  { id: "H", name: "Group H", teams: ["Spain", "Cape Verde", "Saudi Arabia", "Uruguay"] },
  { id: "I", name: "Group I", teams: ["France", "Senegal", "Iraq", "Norway"] },
  { id: "J", name: "Group J", teams: ["Argentina", "Algeria", "Austria", "Jordan"] },
  { id: "K", name: "Group K", teams: ["Portugal", "DR Congo", "Uzbekistan", "Colombia"] },
  { id: "L", name: "Group L", teams: ["England", "Croatia", "Ghana", "Panama"] },
];

export const DEFAULT_BRAND = {
  name: "World Cup 2026 Predictor",
  tagline: "Predict the bracket. Top the leaderboard.",
  logoUrl: "",
  color: "#003da5",
};

export function defaultConfig() {
  return {
    initialized: false,
    brand: { ...DEFAULT_BRAND },
    groups: DEFAULT_GROUPS.map((g) => ({ ...g, teams: [...g.teams] })),
    points: { ...DEFAULT_POINTS },
  };
}

export async function getConfig(poolId) {
  const raw = await getRedis().get(K(poolId).config);
  if (!raw) return defaultConfig();
  const cfg = typeof raw === "string" ? JSON.parse(raw) : raw;
  return {
    initialized: !!cfg.initialized,
    brand: { ...DEFAULT_BRAND, ...(cfg.brand || {}) },
    groups: Array.isArray(cfg.groups) && cfg.groups.length ? cfg.groups : defaultConfig().groups,
    points: { ...DEFAULT_POINTS, ...(cfg.points || {}) },
  };
}

export async function setConfig(poolId, cfg) {
  await getRedis().set(K(poolId).config, JSON.stringify(cfg));
}

// Official results are GLOBAL: one set, entered by the organizer, scored across every pool.
export async function getGlobalResults() {
  const raw = await getRedis().get(GLOBAL_RESULTS_KEY);
  const r = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
  return {
    groups: r.groups || {},
    qf: Array.isArray(r.qf) ? r.qf : [],
    sf: Array.isArray(r.sf) ? r.sf : [],
    fn: Array.isArray(r.fn) ? r.fn : [],
    champion: r.champion || "",
  };
}

export async function setGlobalResults(results) {
  const redis = getRedis();
  await redis.set(GLOBAL_RESULTS_KEY, JSON.stringify(results));
  await redis.expireat(GLOBAL_RESULTS_KEY, Math.floor(DATA_EXPIRE_TS / 1000)).catch(() => {});
}

export async function poolExists(poolId) {
  return (await getRedis().sismember(POOLS_KEY, poolId)) === 1;
}

// ---- ids / tokens ----
export function newPoolId() {
  // short, URL-safe, lowercase
  return Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4);
}
export function newToken() {
  // 32 hex chars of entropy for the secret admin link
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ---- Validation ----
export function normName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function validatePrediction(pred, cfg) {
  if (!pred || typeof pred !== "object") return { ok: false, error: "Bad payload" };
  const name = String(pred.name || "").trim();
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Name must be 2-60 characters" };

  const groups = pred.groups || {};
  const teamSet = new Set();
  for (const g of cfg.groups) for (const t of g.teams) teamSet.add(t);

  for (const g of cfg.groups) {
    const pick = groups[g.id];
    if (!pick) return { ok: false, error: `Pick a winner for ${g.name}` };
    if (!g.teams.includes(pick)) return { ok: false, error: `Invalid winner for ${g.name}` };
  }

  const arrCheck = (arr, count, label) => {
    if (!Array.isArray(arr) || arr.length !== count) return `Select exactly ${count} ${label}`;
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
  if (!pred.champion || !teamSet.has(pred.champion)) return { ok: false, error: "Pick a valid champion" };

  return { ok: true };
}

// ---- Scoring ----
export function scoreOf(pred, results, points) {
  const P = { ...DEFAULT_POINTS, ...(points || {}) };
  const R = results || {};
  let score = 0;

  const rGroups = R.groups || {};
  for (const gid of Object.keys(rGroups)) {
    const actual = rGroups[gid];
    if (!actual) continue;
    const pick = (pred.groups || {})[gid];
    if (pick === actual) score += P.group;
    else score -= P.wrong;
  }

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

  if (R.champion) {
    if (pred.champion === R.champion) score += P.champion;
    else score -= P.wrong;
  }

  return score;
}

// Build the compact cached leaderboard from full entries + current results.
export function buildBoard(preds, results, points) {
  return preds
    .map((p) => ({ name: p.name, champion: p.champion, score: scoreOf(p, results, points), ts: p.ts }))
    .sort((a, b) => b.score - a.score || a.ts - b.ts);
}

// Build cached pick distributions (what everyone predicted) from full entries.
export function buildStats(preds) {
  const s = { champion: {}, fn: {}, sf: {}, qf: {}, groups: {} };
  const inc = (o, k) => { if (k) o[k] = (o[k] || 0) + 1; };
  for (const p of preds) {
    inc(s.champion, p.champion);
    (p.fn || []).forEach((t) => inc(s.fn, t));
    (p.sf || []).forEach((t) => inc(s.sf, t));
    (p.qf || []).forEach((t) => inc(s.qf, t));
    const g = p.groups || {};
    for (const gid of Object.keys(g)) {
      s.groups[gid] = s.groups[gid] || {};
      inc(s.groups[gid], g[gid]);
    }
  }
  return s;
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

function constEq(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Deployer-level gate (pool creation/deletion).
export function checkCode(input) {
  return constEq(input, adminCode());
}

// Per-pool admin gate (results entry, branding). Accepts the pool token OR the deployer code.
export async function checkPoolAuth(poolId, token) {
  if (checkCode(token)) return true;
  const stored = await getRedis().get(K(poolId).token);
  return stored != null && constEq(token, stored);
}

// Best-effort client IP from Vercel's proxy headers.
export function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.headers["x-real-ip"] || "unknown";
}

// Per-IP daily counter. Returns true if the caller is over the limit.
export async function rateLimited(ip, bucket, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `wc:rl:${bucket}:${day}:${ip}`;
  const redis = getRedis();
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 86400);
  return n > limit;
}
