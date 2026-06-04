import {
  getRedis,
  KEYS,
  getConfig,
  setConfig,
  scoreOf,
  cors,
  checkCode,
  DEFAULT_POINTS,
} from "../lib/store.js";

const LOGO_MAX = 300 * 1024; // cap data-URI logos at ~300KB to keep Redis lean

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
    if (!g || typeof g.id !== "string" || !Array.isArray(g.teams) || g.teams.length !== 4)
      return null;
    const teams = g.teams.map((t) => String(t).trim().slice(0, 40)).filter(Boolean);
    if (teams.length !== 4) return null;
    out.push({
      id: String(g.id).trim().slice(0, 8),
      name: String(g.name || `Group ${g.id}`).trim().slice(0, 40),
      teams,
    });
  }
  const ids = new Set(out.map((g) => g.id));
  if (ids.size !== out.length) return null; // group ids must be unique
  return out;
}

function sanitizePoints(p = {}) {
  const out = { ...DEFAULT_POINTS };
  for (const k of ["group", "qf", "sf", "fn", "champion", "wrong"]) {
    if (p[k] != null && Number.isFinite(Number(p[k]))) out[k] = Math.round(Number(p[k]));
  }
  return out;
}

function sanitizeResults(r = {}, cfg) {
  const teamSet = new Set();
  for (const g of cfg.groups) for (const t of g.teams) teamSet.add(t);
  const groups = {};
  if (r.groups && typeof r.groups === "object") {
    for (const g of cfg.groups) {
      const v = r.groups[g.id];
      if (v && g.teams.includes(v)) groups[g.id] = v;
    }
  }
  const arr = (a) => (Array.isArray(a) ? [...new Set(a.filter((t) => teamSet.has(t)))] : []);
  return {
    groups,
    qf: arr(r.qf),
    sf: arr(r.sf),
    fn: arr(r.fn),
    champion: r.champion && teamSet.has(r.champion) ? r.champion : "",
  };
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

  const { code, action } = body;
  if (!checkCode(code)) return res.status(401).json({ error: "Invalid admin code" });

  const redis = getRedis();

  try {
    switch (action) {
      case "verify":
        return res.status(200).json({ ok: true });

      // First-run wizard: brand + groups + points in one shot, mark initialized.
      case "setup": {
        const cfg = await getConfig();
        const groups = sanitizeGroups(body.groups) || cfg.groups;
        const next = {
          initialized: true,
          brand: sanitizeBrand(body.brand, cfg.brand),
          groups,
          points: body.points ? sanitizePoints(body.points) : cfg.points,
        };
        await setConfig(next);
        return res.status(200).json({ ok: true, config: next });
      }

      case "setBrand": {
        const cfg = await getConfig();
        cfg.brand = sanitizeBrand(body.brand, cfg.brand);
        await setConfig(cfg);
        return res.status(200).json({ ok: true, brand: cfg.brand });
      }

      case "setGroups": {
        const cfg = await getConfig();
        const groups = sanitizeGroups(body.groups);
        if (!groups) return res.status(400).json({ error: "Need 12 groups of 4 teams, unique ids" });
        cfg.groups = groups;
        await setConfig(cfg);
        return res.status(200).json({ ok: true, groups });
      }

      case "setPoints": {
        const cfg = await getConfig();
        cfg.points = sanitizePoints(body.points);
        await setConfig(cfg);
        return res.status(200).json({ ok: true, points: cfg.points });
      }

      case "setResults": {
        const cfg = await getConfig();
        const results = sanitizeResults(body.results, cfg);
        await redis.set(KEYS.results, JSON.stringify(results));
        return res.status(200).json({ ok: true, results });
      }

      case "entries": {
        const [cfg, resultsRaw, predsRaw] = await Promise.all([
          getConfig(),
          redis.get(KEYS.results),
          redis.lrange(KEYS.preds, 0, -1),
        ]);
        const results = resultsRaw
          ? typeof resultsRaw === "string"
            ? JSON.parse(resultsRaw)
            : resultsRaw
          : {};
        const entries = (predsRaw || [])
          .map((p) => (typeof p === "string" ? JSON.parse(p) : p))
          .map((p) => ({ ...p, score: scoreOf(p, results, cfg.points) }))
          .sort((a, b) => b.score - a.score);
        return res.status(200).json({ ok: true, entries });
      }

      case "export": {
        const [cfg, resultsRaw, predsRaw] = await Promise.all([
          getConfig(),
          redis.get(KEYS.results),
          redis.lrange(KEYS.preds, 0, -1),
        ]);
        const results = resultsRaw
          ? typeof resultsRaw === "string"
            ? JSON.parse(resultsRaw)
            : resultsRaw
          : {};
        const preds = (predsRaw || []).map((p) => (typeof p === "string" ? JSON.parse(p) : p));
        const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const head = [
          "name",
          ...cfg.groups.map((g) => `winner_${g.id}`),
          "qf",
          "sf",
          "fn",
          "champion",
          "score",
          "submitted",
        ];
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
        const csv = [head.join(","), ...rows].join("\n");
        return res.status(200).json({ ok: true, csv });
      }

      // Clear entries/results/visits. Keeps branding + groups config so the contest can re-run.
      case "reset": {
        await Promise.all([
          redis.del(KEYS.preds),
          redis.del(KEYS.names),
          redis.del(KEYS.results),
        ]);
        if (body.resetVisits) await redis.del(KEYS.visits);
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    return res.status(500).json({ error: "Admin action failed", detail: String(err.message || err) });
  }
}
