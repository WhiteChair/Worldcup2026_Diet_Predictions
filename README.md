# 🏆 Tournament Predictor

A self-hosted prediction game for the FIFA World Cup 2026 (or any 12-group knockout tournament). Players predict group winners, who reaches each knockout round, and the champion. Live stats, a leaderboard, and a one-screen admin panel for entering official results.

**One deploy, many self-serve pools.** Share one link; anyone can spin up their own pool — for an office, team, or friend group. Each pool holds up to **250 players**, has its own branding, and its own private admin link.

**No player logins. One entry per name. You own your data.** Deploy once, share the link, let people create their own pools.

![tabs: Predict / Live Stats / Leaderboard / Admin](#) <!-- drop a screenshot here -->

---

## Why this exists

Most office prediction games are spreadsheets that fall apart by the round of 16. This is a tiny, free, self-hosted alternative:

- **Brand it in the browser** — company name, logo, colors, teams and scoring are all editable from the Admin tab. No code edits, no redeploys.
- **Cheap to run** — static page + a handful of serverless functions + a free Upstash Redis tier. Comfortably free for an office.
- **Your data stays yours** — runs in *your* Vercel account against *your* Redis. We don't host anything for you.
- **Open source (MIT)** — fork it, theme it, ship it.

---

## One-click deploy

1. Click **Deploy**. Vercel clones the repo into your account.

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/WhiteChair/Worldcup2026_Diet_Predictions&env=ADMIN_CODE&envDescription=A%20long%20random%20admin%20password%20(server-side%20only)&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%7D%5D)

2. When prompted, set **`ADMIN_CODE`** to a long random string (your admin password). Generate one:
   ```bash
   openssl rand -hex 24
   ```
3. Add the **Upstash** storage integration when prompted (or from the project's **Storage** tab afterward). It auto-injects the Redis env vars. **Redeploy once** after adding storage so the vars take effect.
4. Open your site → **Create my pool** (no code needed — creation is open). You get two links:
   - a **play link** (`?pool=…`) to share with players, and
   - a private **admin link** (`?pool=…&admin=…`) to manage that pool. Save it like a password.

Share the site URL anywhere (LinkedIn, Slack, email) and people create their own pools.

Your `ADMIN_CODE` is still used for the **master view** — listing every pool from the home page — and as a master admin token for any pool.

---

## Manual deploy (CLI)

```bash
git clone https://github.com/WhiteChair/Worldcup2026_Diet_Predictions && cd Worldcup2026_Diet_Predictions
npm install
npx vercel link                         # link/create the Vercel project
# add the Upstash integration in the Vercel dashboard → Storage tab
npx vercel env add ADMIN_CODE production # paste your random secret
npx vercel deploy --prod --yes
```

---

## How to run a pool

| Step | Where | What |
|------|-------|------|
| 1. Create the pool | Home page | Name the pool → get play + admin links. No code needed. |
| 2. Brand it | Admin → Branding | Pool name, tagline, brand color, logo (URL or upload). |
| 3. Load the draw | Admin → Teams & groups | Edit the 12 groups / 4 teams to match the real draw. |
| 4. (Optional) tune scoring | Admin → Scoring | Points per stage + wrong-pick penalty. |
| 5. Share the play link | — | Players open it, enter a name, make picks, submit. One entry per name. |
| 6. Enter results | Admin → Official results | Fill in each stage as it completes. The leaderboard recalculates instantly. Leave blank to keep all scores at 0. |
| 7. Export | Admin → Entries & data | Download all entries as CSV any time. |

> **Admin access = the secret link.** Anyone with a pool's admin link can manage it, so keep it private. Lost it? List your pools from the home page using your `ADMIN_CODE`. Your `ADMIN_CODE` also works as a master admin token for any pool.

### Default scoring

| Correct pick | Points |
|---|---|
| Group winner | +3 |
| Quarter-finalist | +5 |
| Semi-finalist | +10 |
| Finalist | +20 |
| Champion | +30 |
| Any wrong pick (once that stage's results are in) | −1 |

All editable per pool in the Admin tab.

---

## Limits, cost & auto-shutdown

Built so a single free deployment **cannot run up a bill**:

- **100 pools max**, **250 players per pool** — enforced server-side (`MAX_POOLS`, `MAX_PLAYERS_PER_POOL`). Open creation is **rate-limited to 5 pools/IP/day** so one person can't spam-fill the slots.
- **Tiny storage footprint:** 100 full pools × 250 ≈ 25K entries ≈ **~17MB** (Upstash free = 256MB). Storage is never the constraint at this scale.
- **Cached leaderboard** — viewers read a precomputed, compact board (a couple of Redis ops per page), never raw entries. The real shared ceiling is monthly Redis commands (free = 500K ≈ ~160K page views/mo).
- **No-bill guarantee:** both Upstash's free plan and Vercel's Hobby tier **hard-stop at their limits instead of charging** — worst case the site pauses, it never bills. Set Vercel **Spend Management → $0** + an Upstash **budget cap** to make max cost provably $0.
- **Hard shutdown on 2026-08-01:** after the tournament, every deployment self-closes (APIs return `410`, the page shows a finished screen) and every pool's Redis keys carry an `EXPIREAT` ~2 weeks later, so **all data auto-deletes by mid-August**. Change `KILL_TS` (`lib/store.js`) for other tournaments.

> Want stronger guarantees? In Vercel set **Spend Management → $0**, and in Upstash set a **budget cap**. Then your maximum possible cost is provably $0.

---

## Architecture

```
worldcup-predictor/
├─ vercel.json          # no-store cache headers (beats stale corporate proxies)
├─ package.json         # type:module, dep @upstash/redis
├─ lib/store.js         # Redis client, per-pool keys, caps, kill switch, scoring, validation
├─ api/create.js        # POST create a pool (open, IP rate-limited, 100-pool cap) → returns play + admin tokens
├─ api/state.js         # GET ?pool= public state (config + results + cached board)
├─ api/predict.js       # POST one prediction (validate, dedupe, 250-player cap, board update)
├─ api/admin.js         # POST per-pool admin actions (token-gated) + list (ADMIN_CODE-gated)
├─ api/visit.js         # POST per-pool visit counter
└─ public/index.html    # entire UI: home (create/manage), predictor, kill screen
```

- **Storage:** Upstash Redis, namespaced per pool: `wc:{poolId}:config | results | preds | names | board | visits | token`, plus a global `wc:pools` set.
- **Auth:** pool *creation* is open (IP rate-limited). Each pool gets a random 32-hex **admin token** (the secret link) for management. The deployer's `ADMIN_CODE` (env var) gates the master "list all pools" view and works as a master token for any pool. Tokens/code are checked server-side, never in source — their entropy is the security boundary.
- **Scoring:** computed server-side in `scoreOf`; penalties for a stage apply only once that stage's results are entered. The cached board is rebuilt on every submit and whenever results/scoring change.

---

## Customizing / reusing

Everything contestants see is runtime-configurable from the Admin tab, so most "forks" need zero code. If you want to change the tournament *shape* (not 12 groups, different stages), edit:

- `STRUCTURE` and `validatePrediction` in `lib/store.js`
- `REQ` and the Predict-tab render in `public/index.html`

The storage, admin gate, dedupe, visit counter, and cache headers are all generic — leave them alone.

---

## Gotchas

- **Upstash env prefix:** the Marketplace integration injects `STORAGE_KV_REST_API_URL` / `STORAGE_KV_REST_API_TOKEN`, not bare `KV_*`. `getRedis()` reads every common variant — no action needed.
- **Env vars need a redeploy** to take effect.
- **Corporate proxies** sometimes block `*.vercel.app` or cache aggressively. The app sends `no-store` everywhere and cache-busts requests; if a whole office network is blocked, ask IT to whitelist the host or attach a custom domain (mobile data always works).

---

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, brand it, run it.
