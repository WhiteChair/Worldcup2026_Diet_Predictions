import { getRedis, K, getConfig, getResults, poolExists, isKilled, KILL_TS, cors } from "../lib/store.js";

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
    // Cheap read path: config + results + cached board + visits. Never scans 6000 raw entries.
    const [cfg, results, boardRaw, visitsRaw] = await Promise.all([
      getConfig(poolId),
      getResults(poolId),
      redis.get(k.board),
      redis.get(k.visits),
    ]);

    const board = boardRaw ? (typeof boardRaw === "string" ? JSON.parse(boardRaw) : boardRaw) : [];

    // Champion distribution computed in-memory from the compact board (no extra Redis).
    const champCounts = {};
    for (const p of board) if (p.champion) champCounts[p.champion] = (champCounts[p.champion] || 0) + 1;

    return res.status(200).json({
      killed: isKilled(),
      killDate: new Date(KILL_TS).toISOString(),
      initialized: cfg.initialized,
      brand: cfg.brand,
      groups: cfg.groups,
      points: cfg.points,
      structure: { qf: 8, sf: 4, fn: 2 },
      results,
      predictions: board,
      champCounts,
      visits: Number(visitsRaw || 0),
      total: board.length,
    });
  } catch (err) {
    return res.status(500).json({ error: "State unavailable", detail: String(err.message || err) });
  }
}
