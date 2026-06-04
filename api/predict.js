import {
  getRedis,
  K,
  getConfig,
  getGlobalResults,
  poolExists,
  validatePrediction,
  normName,
  buildBoard,
  buildStats,
  MAX_PLAYERS_PER_POOL,
  touchExpiry,
  isKilled,
  cors,
} from "../lib/store.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (isKilled()) return res.status(410).json({ error: "This contest has closed." });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const poolId = String(body.pool || "").trim();
    if (!poolId || !(await poolExists(poolId))) return res.status(404).json({ error: "Pool not found" });

    const cfg = await getConfig(poolId);
    const check = validatePrediction(body, cfg);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const redis = getRedis();
    const k = K(poolId);

    const count = await redis.scard(k.names);
    if (count >= MAX_PLAYERS_PER_POOL) return res.status(409).json({ error: "This pool is full." });

    const nameKey = normName(body.name);
    const added = await redis.sadd(k.names, nameKey);
    if (added === 0) return res.status(409).json({ error: "An entry with that name already exists" });

    const pred = {
      name: String(body.name).trim(),
      groups: body.groups,
      qf: body.qf,
      sf: body.sf,
      fn: body.fn,
      champion: body.champion,
      ts: Date.now(),
    };
    await redis.rpush(k.preds, JSON.stringify(pred));

    // Rebuild caches from all entries (pool capped at 250, so a full rebuild is cheap and always correct).
    const [results, predsRaw] = await Promise.all([getGlobalResults(), redis.lrange(k.preds, 0, -1)]);
    const preds = predsRaw.map((p) => (typeof p === "string" ? JSON.parse(p) : p));
    await Promise.all([
      redis.set(k.board, JSON.stringify(buildBoard(preds, results, cfg.points))),
      redis.set(k.stats, JSON.stringify(buildStats(preds))),
    ]);
    await touchExpiry(redis, poolId);

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Submit failed", detail: String(err.message || err) });
  }
}
