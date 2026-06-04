import { getRedis, K, getConfig, getGlobalResults, poolExists, isKilled, KILL_TS, cors } from "../lib/store.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const poolId = String(req.query.pool || "").trim();
  if (!poolId) return res.status(400).json({ error: "Missing pool" });

  try {
    if (!(await poolExists(poolId))) return res.status(404).json({ error: "Pool not found" });

    const redis = getRedis();
    const k = K(poolId);
    // Cheap read path: config + global results + cached board + cached stats + visits.
    const [cfg, results, boardRaw, statsRaw, visitsRaw] = await Promise.all([
      getConfig(poolId),
      getGlobalResults(),
      redis.get(k.board),
      redis.get(k.stats),
      redis.get(k.visits),
    ]);

    const board = boardRaw ? (typeof boardRaw === "string" ? JSON.parse(boardRaw) : boardRaw) : [];
    const stats = statsRaw
      ? typeof statsRaw === "string"
        ? JSON.parse(statsRaw)
        : statsRaw
      : { champion: {}, fn: {}, sf: {}, qf: {}, groups: {} };

    return res.status(200).json({
      killed: isKilled(),
      killDate: new Date(KILL_TS).toISOString(),
      initialized: cfg.initialized,
      brand: cfg.brand,
      groups: cfg.groups,
      points: cfg.points,
      structure: { qf: 8, sf: 4, fn: 2 },
      results, // global, same for every pool
      predictions: board,
      stats,
      visits: Number(visitsRaw || 0),
      total: board.length,
    });
  } catch (err) {
    return res.status(500).json({ error: "State unavailable", detail: String(err.message || err) });
  }
}
