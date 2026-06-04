import { getRedis, KEYS, getConfig, scoreOf, cors } from "../lib/store.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const redis = getRedis();
    const [cfg, resultsRaw, predsRaw, visitsRaw] = await Promise.all([
      getConfig(),
      redis.get(KEYS.results),
      redis.lrange(KEYS.preds, 0, -1),
      redis.get(KEYS.visits),
    ]);

    const results = resultsRaw
      ? typeof resultsRaw === "string"
        ? JSON.parse(resultsRaw)
        : resultsRaw
      : { groups: {}, qf: [], sf: [], fn: [], champion: "" };

    // Strip PII: expose champion pick + computed score only, never raw entry identity beyond display name.
    const predictions = (predsRaw || [])
      .map((p) => (typeof p === "string" ? JSON.parse(p) : p))
      .map((p) => ({
        name: p.name,
        champion: p.champion,
        score: scoreOf(p, results, cfg.points),
        ts: p.ts,
      }))
      .sort((a, b) => b.score - a.score);

    return res.status(200).json({
      initialized: cfg.initialized,
      brand: cfg.brand,
      groups: cfg.groups,
      points: cfg.points,
      structure: { qf: 8, sf: 4, fn: 2 },
      results,
      predictions,
      visits: Number(visitsRaw || 0),
      total: predictions.length,
    });
  } catch (err) {
    return res.status(500).json({ error: "State unavailable", detail: String(err.message || err) });
  }
}
