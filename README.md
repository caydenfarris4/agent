# Under Construction — Launch System

A standalone Node.js multi-agent system that runs the marketing launch for
*Under Construction* (the book) and Foreman (the app). Eight Claude-powered
agents operate under a written constitution, a Telegram bot is the only
interface, and nothing publishes without explicit approval from your phone.

The three governing documents live in this repo and are loaded at runtime:

| File | Role |
|---|---|
| `prompts/01_AGENT_CONSTITUTION.md` | Appended in full to every agent's system prompt. Amend it and every agent updates on its next call — no code changes, no restart. |
| `prompts/02_SYSTEM_PROMPTS.md` | One section per agent; each agent's system prompt is its section + the full constitution. |
| `docs/03_BUILD_GUIDE_TELEGRAM.md` | The build guide this implementation follows. |

## Architecture

- **Agents** — each agent is a Claude API call (`claude-sonnet-4-6`). There is
  no shared agent state or trust: the hierarchy is enforced in code.
  Specialists (Content, Outreach, Book Growth, App Growth, Engagement) can only
  return drafts to the Chief of Staff. Only the approval pipeline can publish.
- **Pipeline** — specialist draft → Chief of Staff review → Critique Agent
  audit (PASS / FIX / ESCALATE) → Telegram approval queue (inline
  Approve/Reject buttons) → publish via Postiz.
- **Telegram** — the only interface. Owner-locked to a single account.
  Updates arrive by webhook on Cloudflare Workers (long polling in local
  dev), so there is no always-on process to babysit.
- **State** — SQLite: Cloudflare D1 in production, a local file (`DB_PATH`)
  in dev. Approval queue, outreach pipeline, metrics log, KDP entries,
  media library, background jobs, audit log.
- **Background jobs** — agent pipelines run minutes, longer than a webhook
  invocation should. Commands enqueue into the `jobs` table; the queue
  drains immediately after each update and on every cron tick.
- **DRY_RUN** — global env flag, defaults to `true`. Everything works
  end-to-end but the publish step logs instead of posting. Do not flip it
  until the dry-run week is explicitly complete.

## Build milestones

- [x] **M1** — Telegram bot skeleton: `/status`, `/pause`, `/resume`, owner lock, SQLite, prompt loading
- [x] **M2** — Full pipeline pass: `/draft` → Content draft → Chief of Staff review → Critique audit → approval buttons → dry-run publish, plus `/queue` and Chief of Staff chat
- [x] **M3** — Remaining specialists and commands: `/book`, `/app`, `/kdp`, `/idea`, `/outreach` (targets + pitches behind approval), `/amend` (Critique restates, you ratify), `/reply` (Engagement Agent), photo/video asset drops (photos go to the Content Agent as images)
- [x] **M4** — Schedulers (in `TZ`): daily Chief of Staff run 09:00 (assigns and drafts the day's posts, delivered as one approval bundle), weekly plan Mon 08:00, weekly analytics report Sun 18:00; `/plan` and `/report` on demand. `ENABLE_SCHEDULERS=false` turns the cron jobs off.
- [x] **M5** — Postiz integration, still behind `DRY_RUN`: `/channels` maps linkedin/instagram/x to connected Postiz channels; approving with `DRY_RUN=false` publishes for real, including photo/video posts (the asset is fetched from Telegram and uploaded to Postiz). Replies and email stay manual and say so honestly. Going live is a config flip, not a code change.
- [x] **Post-M5 polish** — `/links` approved-asset store injected into every agent context; outreach follow-ups auto-drafted by the daily run after 10+ quiet days (one per target, sending stays manual); `/outreach mark <id> replied|scheduled|aired|declined`; clean scheduler shutdown; verified end to end against the live Claude API.
- [x] **Peak-time scheduling** — Approve asks when to post: ⚡ now, or one of the next three peak engagement slots for that platform (sourced from Sprout Social / Buffer 2026 engagement studies, computed in `TZ`). Scheduled posts fire from a 5-minute due-check; `/pause` holds them and approved-but-unscheduled drafts never auto-post.
- [x] **Trends Agent** (8th agent) — weekly virality and trends research every Monday 07:30 via Anthropic's server-side web search: what's trending in the leadership/faith-and-work space, what's earning reach overall, concrete angles mapped to the Story Bank, and what to avoid. Feeds the Monday plan and every agent's context; `/trends` on demand (`/trends new` re-researches).

## Environment variables

See `.env.example` for the full list. The important ones:

| Var | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather. Required. |
| `TELEGRAM_OWNER_ID` | Optional. Locks the bot to this numeric Telegram user ID. |
| `ANTHROPIC_API_KEY` | Claude API key (needed from M2 on). |
| `AGENT_MODEL` | Defaults to `claude-sonnet-4-6`. |
| `DRY_RUN` | Defaults to `true`. Publish step logs instead of posting. |
| `POSTIZ_API_URL` / `POSTIZ_API_KEY` | Leave empty until the dry-run week is complete. |
| `DB_PATH` | SQLite file location. Defaults to `./data/launch.db`. |
| `TZ` | Timezone for the daily/weekly schedulers. |

## Deploying to Cloudflare Workers (primary)

Runs on the Workers paid plan you already have: webhook + D1 + Cron
Triggers, no server to keep alive. From your machine (or any shell with
this repo):

1. **Login and create the database** (one time):

   ```sh
   npm install
   npx wrangler login
   npx wrangler d1 create launch-system
   ```

   Put the returned `database_id` into `wrangler.toml`, then create the
   tables:

   ```sh
   npx wrangler d1 migrations apply launch-system --remote
   ```

2. **Set the secrets** (one time; `TELEGRAM_WEBHOOK_SECRET` is any long
   random string, e.g. `openssl rand -hex 32`):

   ```sh
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put POSTIZ_API_KEY
   ```

3. **Deploy and wire the webhook:**

   ```sh
   npx wrangler deploy
   curl "https://launch-system.<your-subdomain>.workers.dev/setup?key=<TELEGRAM_WEBHOOK_SECRET>"
   ```

   `/setup` registers the Telegram webhook and command menu and reports the
   Postiz connection. Rerun it any time; it's idempotent.

4. **Verify from your phone:** send `/start` (first account becomes the
   owner), then `/status` and `/channels`.

### Operations (Workers)

```sh
npx wrangler tail                 # live logs
npx wrangler deploy               # ship an update
npx wrangler d1 execute launch-system --remote \
  --command "SELECT type, created_at FROM events ORDER BY id DESC LIMIT 20"
```

- **Schedulers** run from a 5-minute Cron Trigger and fire by Denver wall
  clock (trends Mon 07:30, plan Mon 08:00, daily 09:00, report Sun 18:00),
  DST-safe. A missed window runs late, never twice.
- **Constitution amendments** via /amend are stored in D1 and override the
  bundled document immediately — no redeploy. Editing the file in the repo
  requires a deploy (and applies only until the next /amend, which builds
  on the stored copy).
- **DRY_RUN** is a var in `wrangler.toml`; flip it to "false" and redeploy
  only when the dry-run week is explicitly complete.

## Local development

```sh
npm install
cp .env.example .env    # fill in TELEGRAM_BOT_TOKEN
npm start               # long polling against a local SQLite file
```

Or run the actual Worker locally: put the same values in `.dev.vars`
(gitignored) and `npm run cf:dev`.

Send `/start` to your bot. The first account to do so becomes the owner and
everyone else is silently ignored (or pin it explicitly with
`TELEGRAM_OWNER_ID`).

## Fallback: small VPS with Docker

The Node entry point (`src/index.js`) still runs the whole system with
long polling, a local SQLite file, and an interval timer — same behavior,
no Cloudflare. Any $5–6/month VPS works; see `Dockerfile` /
`docker-compose.yml`, configure `.env`, then `docker compose up -d --build`.
`docker compose --profile postiz up` additionally starts a self-hosted
Postiz next to the bot (needs your own LinkedIn/X/Meta developer apps and
HTTPS on a real domain); with Postiz cloud you don't need it.


- **State** persists in `./data/` (mounted volume). Back it up with
  `cp data/launch.db backups/launch-$(date +%F).db` — a nightly cron line is
  plenty.
- **Constitution amendments** edit `./prompts/01_AGENT_CONSTITUTION.md`
  (mounted volume) and take effect on the next agent call — no rebuild.
- The container restarts automatically (`restart: unless-stopped`), including
  after a VPS reboot.

## Security notes

- All secrets live in `.env`, which is gitignored. Nothing secret is in code.
- The bot ignores every Telegram account except the owner.
- Publishing is triple-gated: the approval pipeline, `/pause`, and `DRY_RUN`.
