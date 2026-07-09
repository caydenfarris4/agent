# Under Construction — Launch System

A standalone Node.js multi-agent system that runs the marketing launch for
*Under Construction* (the book) and Foreman (the app). Seven Claude-powered
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
- **State** — SQLite (approval queue, outreach pipeline, metrics log, KDP
  entries, audit log) at `DB_PATH`.
- **DRY_RUN** — global env flag, defaults to `true`. Everything works
  end-to-end but the publish step logs instead of posting. Do not flip it
  until the dry-run week is explicitly complete.

## Build milestones

- [x] **M1** — Telegram bot skeleton: `/status`, `/pause`, `/resume`, owner lock, SQLite, prompt loading
- [x] **M2** — Full pipeline pass: `/draft` → Content draft → Chief of Staff review → Critique audit → approval buttons → dry-run publish, plus `/queue` and Chief of Staff chat
- [x] **M3** — Remaining specialists and commands: `/book`, `/app`, `/kdp`, `/idea`, `/outreach` (targets + pitches behind approval), `/amend` (Critique restates, you ratify), `/reply` (Engagement Agent), photo/video asset drops (photos go to the Content Agent as images)
- [x] **M4** — Schedulers (in `TZ`): daily Chief of Staff run 09:00 (assigns and drafts the day's posts, delivered as one approval bundle), weekly plan Mon 08:00, weekly analytics report Sun 18:00; `/plan` and `/report` on demand. `ENABLE_SCHEDULERS=false` turns the cron jobs off.
- [x] **M5** — Postiz integration, still behind `DRY_RUN`: `/channels` maps linkedin/instagram/x to connected Postiz channels; approving with `DRY_RUN=false` publishes for real. Replies, email, and media posts stay manual and say so honestly. Going live is a config flip, not a code change.

## Local setup

```sh
npm install
cp .env.example .env    # fill in TELEGRAM_BOT_TOKEN (and later ANTHROPIC_API_KEY)
npm start
```

Send `/start` to your bot. The first account to do so becomes the owner and
everyone else is silently ignored (or pin it explicitly with
`TELEGRAM_OWNER_ID`).

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

## Deploying to a small VPS with Docker

Any $5–6/month VPS (Hetzner CX22, DigitalOcean basic droplet) is plenty. The
bot uses Telegram long polling, so **no inbound ports, domains, or TLS are
needed** — outbound HTTPS is enough.

1. **Provision the VPS** (Ubuntu 24.04 or similar) and install Docker:

   ```sh
   curl -fsSL https://get.docker.com | sh
   ```

2. **Get the code onto the box:**

   ```sh
   git clone <your-repo-url> launch-system
   cd launch-system
   ```

3. **Configure secrets** (never committed — `.env` is gitignored):

   ```sh
   cp .env.example .env
   nano .env   # bot token, API key, DRY_RUN=true
   ```

4. **Start it:**

   ```sh
   docker compose up -d --build
   docker compose logs -f    # watch for "Bot online as @..."
   ```

5. **Verify from your phone:** send `/start`, then `/status`.

### Operations

```sh
docker compose logs -f            # tail logs
docker compose restart            # restart
git pull && docker compose up -d --build   # deploy an update
```

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
