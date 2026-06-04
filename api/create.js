import {
  getRedis,
  POOLS_KEY,
  K,
  MAX_POOLS,
  checkCode,
  newPoolId,
  newToken,
  defaultConfig,
  setConfig,
  touchExpiry,
  isKilled,
  cors,
} from "../lib/store.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (isKilled()) return res.status(410).json({ error: "This service has closed." });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "Bad JSON" });
  }

  if (!checkCode(body.code)) return res.status(401).json({ error: "Invalid admin code" });

  const redis = getRedis();
  try {
    const count = await redis.scard(POOLS_KEY);
    if (count >= MAX_POOLS) {
      return res.status(409).json({ error: `Pool limit reached (${MAX_POOLS}). Delete one to create another.` });
    }

    // generate a unique pool id
    let poolId = newPoolId();
    for (let i = 0; i < 5 && (await redis.sismember(POOLS_KEY, poolId)) === 1; i++) poolId = newPoolId();

    const token = newToken();
    const cfg = defaultConfig();
    if (body.name && typeof body.name === "string") cfg.brand.name = body.name.trim().slice(0, 80);

    await redis.sadd(POOLS_KEY, poolId);
    await Promise.all([
      setConfig(poolId, cfg),
      redis.set(K(poolId).token, token),
      redis.set(K(poolId).board, JSON.stringify([])),
      redis.set(K(poolId).results, JSON.stringify({ groups: {}, qf: [], sf: [], fn: [], champion: "" })),
    ]);
    await touchExpiry(redis, poolId);

    return res.status(200).json({ ok: true, poolId, token });
  } catch (err) {
    return res.status(500).json({ error: "Create failed", detail: String(err.message || err) });
  }
}
