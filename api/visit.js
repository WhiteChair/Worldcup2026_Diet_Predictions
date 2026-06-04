import { getRedis, K, poolExists, isKilled, cors } from "../lib/store.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (isKilled()) return res.status(410).json({ error: "Closed." });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const poolId = String(body.pool || "").trim();
    if (!poolId || !(await poolExists(poolId))) return res.status(404).json({ error: "Pool not found" });

    const visits = await getRedis().incr(K(poolId).visits);
    return res.status(200).json({ visits });
  } catch (err) {
    return res.status(500).json({ error: "Visit failed", detail: String(err.message || err) });
  }
}
