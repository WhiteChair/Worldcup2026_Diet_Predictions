# 🏆 Tournament Predictor

A self-hosted office prediction game for the FIFA World Cup 2026 (or any 12-group knockout tournament). Staff predict group winners, who reaches each knockout round, and the champion. Live stats, a leaderboard, and a one-screen admin panel for entering official results.

**No player logins. One entry per person. You own your data.** Deploy it once, brand it as your own, run your office sweepstake.

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

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_GITHUB/worldcup-predictor&env=ADMIN_CODE&envDescription=A%20long%20random%20admin%20password%20(server-side%20only)&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%7D%5D)

   > Replace `YOUR_GITHUB/worldcup-predictor` in the button URL with your fork before publishing.

2. When prompted, set **`ADMIN_CODE`** to a long random string (your admin password). Generate one:
   ```bash
   openssl rand -hex 24
   ```
3. Add the **Upstash** storage integration when prompted (or from the project's **Storage** tab afterward). It auto-injects the Redis env vars. **Redeploy once** after adding storage so the vars take effect.
4. Open your site → **Admin** tab → enter your `ADMIN_CODE` → set your branding, real teams, and scoring.

That's it.

---

## Manual deploy (CLI)

```bash
git clone https://github.com/YOUR_GITHUB/worldcup-predictor && cd worldcup-predictor
npm install
npx vercel link                         # link/create the Vercel project
# add the Upstash integration in the Vercel dashboard → Storage tab
npx vercel env add ADMIN_CODE production # paste your random secret
npx vercel deploy --prod --yes
```

---

## How to run your contest

| Step | Where | What |
|------|-------|------|
| 1. Brand it | Admin → Branding | Company name, tagline, brand color, logo (URL or upload). |
| 2. Load the draw | Admin → Teams & groups | Edit the 12 groups / 4 teams to match the real draw. |
| 3. (Optional) tune scoring | Admin → Scoring | Points per stage + wrong-pick penalty. |
| 4. Share the link | — | Staff open it, enter a name, make picks, submit. One entry per name. |
| 5. Enter results | Admin → Official results | Fill in each stage as it completes. The leaderboard recalculates instantly. |
| 6. Export | Admin → Entries & data | Download all entries as CSV any time. |

### Default scoring

| Correct pick | Points |
|---|---|
| Group winner | +3 |
| Quarter-finalist | +5 |
| Semi-finalist | +10 |
| Finalist | +20 |
| Champion | +30 |
| Any wrong pick (once that stage's results are in) | −1 |

All editable in the Admin tab.

---

## Architecture

```
worldcup-predictor/
├─ vercel.json          # no-store cache headers (beats stale corporate proxies)
├─ package.json         # type:module, dep @upstash/redis
├─ lib/store.js         # Redis client, keys, scoring, validation, defaults
├─ api/state.js         # GET public state (config + results + leaderboard, PII stripped)
├─ api/predict.js       # POST one prediction (validate + dedupe by name)
├─ api/admin.js         # POST admin actions (code-gated)
├─ api/visit.js         # POST visit counter
└─ public/index.html    # entire UI (vanilla HTML/CSS/JS, no build step)
```

- **Storage:** Upstash Redis. Keys: `wc:config`, `wc:results`, `wc:preds`, `wc:names`, `wc:visits`.
- **Admin gate:** one shared secret in the `ADMIN_CODE` env var, checked server-side on every admin call. Never sent to the browser, never in source. Use a high-entropy value — there is no rate limiting, so the secret's randomness is the security boundary.
- **Scoring:** computed server-side in `scoreOf`; a stage's penalties only apply once that stage's results are entered.

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
