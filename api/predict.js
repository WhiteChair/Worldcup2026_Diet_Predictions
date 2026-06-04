import { getRedis, KEYS, getConfig, validatePrediction, normName, cors } from "../lib/store.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const cfg = await getConfig();

    const check = validatePrediction(body, cfg);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const redis = getRedis();
    const key = normName(body.name);

    // Dedupe by normalized name: SADD returns 0 when already present.
    const added = await redis.sadd(KEYS.names, key);
    if (added === 0) {
      return res.status(409).json({ error: "An entry with that name already exists" });
    }

    const pred = {
      name: String(body.name).trim(),
      groups: body.groups,
      qf: body.qf,
      sf: body.sf,
      fn: body.fn,
      champion: body.champion,
      ts: Date.now(),
    };
    await redis.rpush(KEYS.preds, JSON.stringify(pred));

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Submit failed", detail: String(err.message || err) });
  }
}
