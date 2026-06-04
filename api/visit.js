import { getRedis, KEYS, cors } from "../lib/store.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const visits = await getRedis().incr(KEYS.visits);
    return res.status(200).json({ visits });
  } catch (err) {
    return res.status(500).json({ error: "Visit failed", detail: String(err.message || err) });
  }
}
