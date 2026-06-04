import {
  getRedis,
  POOLS_KEY,
  K,
  getConfig,
  setConfig,
  getGlobalResults,
  setGlobalResults,
  poolExists,
  scoreOf,
  buildBoard,
  buildStats,
  checkCode,
  checkPoolAuth,
  touchExpiry,
  isKilled,
  DEFAULT_POINTS,
  DEFAULT_GROUPS,
  cors,
} from "../lib/store.js";

const LOGO_MAX = 300 * 1024;

function sanitizeBrand(b = {}, current = {}) {
  const out = { ...current };
  if (typeof b.name === "string") out.name = b.name.trim().slice(0, 80);
  if (typeof b.tagline === "string") out.tagline = b.tagline.trim().slice(0, 160);
  if (typeof b.color === "string" && /^#?[0-9a-fA-F]{6}$/.test(b.color.trim()))
    out.color = b.color.trim().startsWith("#") ? b.color.trim() : "#" + b.color.trim();
  if (typeof b.logoUrl === "string") {
    const v = b.logoUrl.trim();
    if (v === "" || /^https?:\/\//i.test(v) || (v.startsWith("data:image/") && v.length <= LOGO_MAX))
      out.logoUrl = v;
  }
  return out;
}

function sanitizeGroups(groups) {
  if (!Array.isArray(groups) || groups.length !== 12) return null;
  const out = [];
  for (const g of groups) {
    if (!g || typeof g.id !== "string" || !Array.isArray(g.teams) || g.teams.length !== 4) return null;
    const teams = g.teams.map((t) => String(t).trim().slice(0, 40)).filter(Boolean);
    if (teams.length !== 4) return null;
    out.push({ id: String(g.id).trim().slice(0, 8), name: String(g.name || `Group ${g.id}`).trim().slice(0, 40), teams });
  }
  const ids = new Set(out.map((g) => g.id));
  if (ids.size !== out.length) return null;
  return out;
}

function sanitizePoints(p = {}) {
  const out = { ...DEFAULT_POINTS };
  for (const key of ["group", "qf", "sf", "fn", "champion", "wrong"]) {
    if (p[key] != null && Number.isFinite(Number(p[key]))) out[key] = Math.round(Number(p[key]));
  }
  return out;
}

// Global results are validated against the canonical real-draw teams (DEFAULT_GROUPS).
function sanitizeResults(r = {}) {
  const teamSet = new Set();
  for (const g of DEFAULT_GROUPS) for (const t of g.teams) teamSet.add(t);
  const groups = {};
  if (r.groups && typeof r.groups === "object") {
    for (const g of DEFAULT_GROUPS) {
      const v = r.groups[g.id];
      if (v && g.teams.includes(v)) groups[g.id] = v;
    }
  }
  const arr = (a) => (Array.isArray(a) ? [...new Set(a.filter((t) => teamSet.has(t)))] : []);
  return { groups, qf: arr(r.qf), sf: arr(r.sf), fn: arr(r.fn), champion: r.champion && teamSet.has(r.champion) ? r.champion : "" };
}

async function readPreds(redis, poolId) {
  const raw = await redis.lrange(K(poolId).preds, 0, -1);
  return (raw || []).map((p) => (typeof p === "string" ? JSON.parse(p) : p));
}

// Rebuild a pool's cached board + stats from its entries against the current global results.
async function rebuildCaches(redis, poolId) {
  const [cfg, results, preds] = await Promise.all([getConfig(poolId), getGlobalResults(), readPreds(redis, poolId)]);
  await Promise.all([
    redis.set(K(poolId).board, JSON.stringify(buildBoard(preds, results, cfg.points))),
    redis.set(K(poolId).stats, JSON.stringify(buildStats(preds))),
  ]);
}

// Rescore every pool (after global results change).
async function rebuildAll(redis) {
  const ids = await redis.smembers(POOLS_KEY);
  for (const id of ids) await rebuildCaches(redis, id);
  return ids.length;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "Bad JSON" });
  }

  const redis = getRedis();
  const { action, code, token } = body;

  // ---- Organizer-only actions (gated by ADMIN_CODE) ----
  if (action === "list" || action === "getResults" || action === "setResults") {
    if (!checkCode(code)) return res.status(401).json({ error: "Invalid owner code" });

    if (action === "list") {
      const ids = await redis.smembers(POOLS_KEY);
      const pools = [];
      for (const id of ids) {
        const [cfg, count] = await Promise.all([getConfig(id), redis.scard(K(id).names)]);
        pools.push({ poolId: id, name: cfg.brand.name, players: Number(count || 0), initialized: cfg.initialized });
      }
      return res.status(200).json({ ok: true, pools });
    }

    if (action === "getResults") {
      return res.status(200).json({ ok: true, results: await getGlobalResults(), groups: DEFAULT_GROUPS });
    }

    // setResults — global, then rescore every pool.
    if (isKilled()) return res.status(410).json({ error: "Closed." });
    const results = sanitizeResults(body.results);
    await setGlobalResults(results);
    const n = await rebuildAll(redis);
    return res.status(200).json({ ok: true, results, rescored: n });
  }

  // ---- Per-pool actions (gated by the pool's admin token, or the owner code as master) ----
  const poolId = String(body.pool || "").trim();
  if (!poolId || !(await poolExists(poolId))) return res.status(404).json({ error: "Pool not found" });
  if (!(await checkPoolAuth(poolId, token))) return res.status(401).json({ error: "Invalid admin link / code" });

  const killed = isKilled();
  const k = K(poolId);

  try {
    switch (action) {
      case "verify":
        return res.status(200).json({ ok: true });

      case "setBrand": {
        if (killed) return res.status(410).json({ error: "Closed." });
        const cfg = await getConfig(poolId);
        cfg.brand = sanitizeBrand(body.brand, cfg.brand);
        cfg.initialized = true;
        await setConfig(poolId, cfg);
        return res.status(200).json({ ok: true, brand: cfg.brand });
      }

      case "setGroups": {
        if (killed) return res.status(410).json({ error: "Closed." });
        const cfg = await getConfig(poolId);
        const groups = sanitizeGroups(body.groups);
        if (!groups) return res.status(400).json({ error: "Need 12 groups of 4 teams, unique ids" });
        cfg.groups = groups;
        await setConfig(poolId, cfg);
        await rebuildCaches(redis, poolId);
        return res.status(200).json({ ok: true, groups });
      }

      case "setPoints": {
        if (killed) return res.status(410).json({ error: "Closed." });
        const cfg = await getConfig(poolId);
        cfg.points = sanitizePoints(body.points);
        await setConfig(poolId, cfg);
        await rebuildCaches(redis, poolId);
        return res.status(200).json({ ok: true, points: cfg.points });
      }

      case "entries": {
        const [cfg, results, preds] = await Promise.all([getConfig(poolId), getGlobalResults(), readPreds(redis, poolId)]);
        const entries = preds
          .map((p) => ({ ...p, score: scoreOf(p, results, cfg.points) }))
          .sort((a, b) => b.score - a.score);
        return res.status(200).json({ ok: true, entries });
      }

      case "export": {
        const [cfg, results, preds] = await Promise.all([getConfig(poolId), getGlobalResults(), readPreds(redis, poolId)]);
        const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const head = ["name", ...cfg.groups.map((g) => `winner_${g.id}`), "qf", "sf", "fn", "champion", "score", "submitted"];
        const rows = preds.map((p) =>
          [
            esc(p.name),
            ...cfg.groups.map((g) => esc((p.groups || {})[g.id])),
            esc((p.qf || []).join(" | ")),
            esc((p.sf || []).join(" | ")),
            esc((p.fn || []).join(" | ")),
            esc(p.champion),
            esc(scoreOf(p, results, cfg.points)),
            esc(new Date(p.ts || Date.now()).toISOString()),
          ].join(",")
        );
        return res.status(200).json({ ok: true, csv: [head.join(","), ...rows].join("\n") });
      }

      case "reset": {
        await Promise.all([redis.del(k.preds), redis.del(k.names)]);
        await redis.set(k.board, JSON.stringify([]));
        await redis.set(k.stats, JSON.stringify({ champion: {}, fn: {}, sf: {}, qf: {}, groups: {} }));
        if (body.resetVisits) await redis.del(k.visits);
        return res.status(200).json({ ok: true });
      }

      case "delete": {
        await Promise.all([
          redis.del(k.config),
          redis.del(k.preds),
          redis.del(k.names),
          redis.del(k.board),
          redis.del(k.stats),
          redis.del(k.visits),
          redis.del(k.token),
        ]);
        await redis.srem(POOLS_KEY, poolId);
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    return res.status(500).json({ error: "Admin action failed", detail: String(err.message || err) });
  }
}
