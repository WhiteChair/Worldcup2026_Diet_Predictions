import { getRedis, K, HOME_VISITS_KEY, POOLS_MADE_KEY, DATA_EXPIRE_TS, poolExists, isKilled, cors } from "../lib/store.js";

async function homeStats(redis) {
  const [v, p] = await Promise.all([redis.get(HOME_VISITS_KEY), redis.get(POOLS_MADE_KEY)]);
  return { visits: Number(v || 0), pools: Number(p || 0) };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const redis = getRedis();

  // GET → read landing-page counters without incrementing (repeat views in a session).
  if (req.method === "GET") {
    try {
      return res.status(200).json(await homeStats(redis));
    } catch (err) {
      return res.status(500).json({ error: "Stats failed", detail: String(err.message || err) });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (isKilled()) return res.status(410).json({ error: "Closed." });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    // Landing-page visit.
    if (body.home) {
      await redis.incr(HOME_VISITS_KEY);
      await redis.expireat(HOME_VISITS_KEY, Math.floor(DATA_EXPIRE_TS / 1000)).catch(() => {});
      return res.status(200).json(await homeStats(redis));
    }

    // Per-pool visit.
    const poolId = String(body.pool || "").trim();
    if (!poolId || !(await poolExists(poolId))) return res.status(404).json({ error: "Pool not found" });
    const visits = await redis.incr(K(poolId).visits);
    return res.status(200).json({ visits });
  } catch (err) {
    return res.status(500).json({ error: "Visit failed", detail: String(err.message || err) });
  }
}
