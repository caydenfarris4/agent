# BUILD GUIDE
## Stack, Telegram Command Center, and Setup Path
### Under Construction Launch System

---

## 1. THE STACK (cheap, effective, fully autonomous)

| Layer | Tool | Cost | Why |
|---|---|---|---|
| Orchestration | **n8n** (self-hosted) | Free software, ~$5-6/mo VPS (Hetzner or DigitalOcean), or n8n Cloud at ~$24/mo if you want zero server management | Native Telegram nodes, scheduling, HTTP calls to the Claude API, and a visual workflow editor you can maintain yourself |
| Agent brains | **Claude API** | Pay per use. Estimate $15-40/mo at your cadence | Chief of Staff and Critique on Claude Sonnet 4.6. Specialists on Sonnet 4.6 as well, or Haiku 4.5 for the Engagement Agent's high-volume reply drafting to cut cost |
| Command center | **Telegram Bot** (via @BotFather) | Free | Approvals, status, uploads, weekly reports, all from your phone |
| Publishing | **Postiz** (open source, self-host on the same VPS) or **Buffer** (~$6/channel/mo) | Free or ~$18/mo | Postiz publishes to LinkedIn, Instagram, and X from one API. Buffer is the paid, zero-maintenance alternative |
| Link tracking | **Dub.co** free tier or **Bitly** free tier | Free | One tracked short link wrapping the Amazon URL gives you click counts per platform (make one link per platform: /book-li, /book-ig, /book-x) |
| Data store | **Google Sheets** (you already live in Google Workspace) | Free | Pipeline tracker for Outreach, weekly metrics log for both Growth agents, approval log |

Total realistic monthly cost, self-hosted path: **roughly $20-45/month** including API usage. Managed path (n8n Cloud + Buffer): roughly $50-70/month.

**On Amazon data, honestly.** Amazon gives authors no public sales API. Sales numbers come from your KDP Reports dashboard. The clean workflow: once a week you screenshot or type your KDP numbers into Telegram, the Book Growth Agent logs them and folds them into the weekly report. Clicks are tracked automatically via the short links. Review count can be checked by a scheduled n8n job fetching the product page, but Amazon may block scrapers, so treat the weekly manual check as the reliable source and automation as a bonus.

**On video, honestly.** The agents cannot creatively edit video. What the system CAN do with a clip you upload via Telegram: write the hook and caption, suggest on-screen text and a cut list with timestamps, and do mechanical operations through ffmpeg on the server (trim to a timestamp, crop to 9:16 or 1:1, burn in captions from a subtitle file). Creative editing stays with you or CapCut. The workflow: you upload a video with a voice note or text of context, the Content Agent returns the caption plus a cut list, you approve or edit, mechanical processing runs, the post enters the queue.

---

## 2. AGENT TOPOLOGY IN N8N

Each agent is a Claude API call with its own system prompt (from document 02) plus the full Constitution (document 01) appended. The hierarchy is enforced by workflow wiring, not by trust:

1. **Scheduler workflows** trigger the Chief of Staff daily (planning, assignment) and weekly (planning session, analytics report).
2. **Chief of Staff workflow** calls specialist workflows as sub-workflows, collects drafts, reviews, then passes the bundle to the Critique workflow.
3. **Critique workflow** returns PASS, FIX, or ESCALATE per item. FIX loops back to the specialist with the violation attached. ESCALATE sends both two-sentence positions to your Telegram.
4. **Approval workflow** sends passed drafts to Telegram as messages with inline Approve and Reject buttons. Approve routes to the Postiz or Buffer publish node with the scheduled time. Reject prompts you for a one-line reason, which routes back to the specialist.
5. **Inbound workflow** listens to your Telegram messages 24/7 and routes them: media uploads go to the Content pipeline, questions go to the Chief of Staff, commands (below) go to their handlers.
6. **Engagement workflow** runs on a schedule, pulls recent comments via the platform APIs or Postiz, drafts replies, and feeds them into the same approval queue.

The Constitution lives in one place (a file or n8n variable) so an amendment updates every agent at once.

---

## 3. TELEGRAM COMMAND CENTER

Your bot supports natural conversation with the Chief of Staff plus these commands:

- **/status**: under ten lines: queue depth, today's scheduled posts, anything waiting on you.
- **/queue**: resend anything awaiting your approval.
- **/plan**: trigger or review the weekly plan (also arrives automatically, pick your day, Monday morning suggested).
- **/report**: the two-vertical weekly analytics report on demand.
- **/book** and **/app**: quick metrics snapshot for one vertical.
- **/idea [text]**: throw a thought into the loop. Chief of Staff routes it and confirms in one line what will happen with it.
- **Send any photo or video with a caption**: treated as an asset drop. Content Agent builds around it and the draft comes back through the queue.
- **/outreach**: current podcast pipeline: pitched, replied, scheduled, plus targets awaiting your approval.
- **/kdp [numbers]**: log your weekly KDP sales figures.
- **/pause** and **/resume**: freeze or unfreeze all publishing instantly.
- **/amend [text]**: propose a Constitution change. The Critique Agent restates it formally, you confirm, the document updates.

Approvals are batched into one or two daily bundles so your phone is not buzzing all day. Time-sensitive items break through with a reason attached.

---

## 4. SETUP PATH (order of operations)

1. **Create the tracked links.** Dub.co or Bitly: one Amazon short link per platform. Ten minutes.
2. **Create the Telegram bot.** Message @BotFather, get the token. Five minutes.
3. **Stand up n8n.** Either n8n Cloud (fastest) or a $6 VPS with Docker. An hour, once.
4. **Connect publishing.** Postiz or Buffer, authorize LinkedIn, Instagram, X. Instagram requires a Business or Creator account connected to a Facebook page for API publishing. Thirty minutes.
5. **Load the prompts.** Constitution as a shared variable, each agent prompt into its Claude API node.
6. **Build the approval workflow first.** Telegram inline buttons to publish node. This is the spine. Everything else attaches to it.
7. **Dry run week.** Run the full pipeline with publishing pointed at a private test account or with the publish node disabled. You approve and reject real drafts on your phone and tune the voice with real feedback before anything goes live.
8. **Go live** at reduced cadence, then step up to the 4-5 per week target.

Given the August 11 launch, the dry run should be happening by mid-July, which means standing up the stack this week or next.

---

## 5. FIRST WEEKLY PLANNING SESSION AGENDA

When the system runs its first /plan, come ready to set these numbers, because the Growth agents need real targets, not vibes:

1. Review target by September 2 (a common healthy launch marker is 20-30 honest reviews; you set the number).
2. Launch-week sales goal.
3. Foreman metric that counts right now (waitlist signups, given the app is still in build).
4. Podcast bookings target before September 2.
5. The launch-week promotional price window dates.

---

## 6. WHAT TO WATCH IN THE FIRST TWO WEEKS

- Voice drift. The most likely early failure is copy that is compliant but generic. Reject those drafts with the reason "anyone could have written this" and the system learns your bar fast, because every rejection reason feeds back to the specialist.
- Over-batching or under-batching approvals. Tell the Chief of Staff to adjust bundle timing to your actual day.
- The Critique Agent being too soft or too aggressive. Both are tuned by telling it so once, plainly.
