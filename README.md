# tab-automation

Always-on Discord agent + scheduled workflow automation. Built fresh (Harness was judged substandard) for the Samsung Tab (SM-T595) running Termux.

## What it does

1. **Always-on Discord listener** (`src/discord.js`)
   - Responds when mentioned, in DMs, or in allowlisted channels (`DISCORD_LISTEN_CHANNELS`)
   - `!review <text>` triggers the `ask-review` workflow (coder agent -> Discord post -> conditional escalation)
   - `!finance india|us` runs a pre-market briefing on demand
   - `!remember <text>` stores a memory, `!recall <query>` searches it, `!memory` shows stats
   - Every mention/DM is auto-saved to memory; relevant past context is injected into replies
   - Agent calls web tools live: `web_search`, `web_news`, `web_fetch`
   - Uses your existing bot token/app/guild from `Harness/.env.local`
2. **Scheduled + configurable workflows** (`config/workflows.json`, `src/workflow.js`, `src/scheduler.js`)
   - Step types: `agent` (Azure OpenAI, with tools + memory by default), `discord_send`, `condition`, `delay`, `http`, `log`, `finance`, `web` (search/fetch/news), `remember`, `recall`
   - Templates: `{{steps.<id>}}`, `{{trigger.text}}`, `{{now}}`, `{{date}}`
   - Cron: 5-field `m h dom mon dow`, checked every 30s
3. **Finance briefings** (`src/finance*.js`, `config/watchlists.json`)
   - 30 NSE + 30 US stocks, Yahoo closes, Google News RSS, Reddit pulse
   - `premarket-india` 08:45 IST weekdays, `premarket-us` 18:30 IST weekdays
   - History in `data/finance/YYYY-MM-DD-<market>.json`
4. **Memory** (`src/memory.js`, `data/memory/memory.jsonl`)
   - Zero-cost keyword retrieval (token overlap + recency), no embeddings/API spend
   - Auto-saves chats + replies; `!remember`/`!recall` for manual control
5. **Configurable agents** (`config/agents.json`) — each maps to an Azure OpenAI deployment + system prompt. JSON now, UX later.

## Quick start (PC side)

```sh
cd tab-automation
npm install
npm start        # builds dashboard if missing, then Discord + scheduler + Control Room
node src/index.js --list
node src/index.js --run ping-test   # manual workflow smoke test (no Discord login)
```

`npm start` = `node src/index.js` (Discord + scheduler + Control Room at `/dashboard`).
Dashboard UI source is `dashboard-app/`; build with `npm run dashboard:build` (output `dist-dashboard/`, gitignored).

## Coding with agents (dashboard → PR)

Pick the `coding` task type in the dashboard (New task, Repo = this repo path). It runs `dash-coder` → `dash-tester` → `critic` → `dash-pr`: code lands on an isolated `agent/*` worktree branch (never main), tests run with evidence, then a PR opens against `main`. First connect GitHub once: Configuration → MCP servers → github card → Sign in with GitHub.

## Deploy to the Tab (Termux)

Prereqs on the Tab: **Termux** (installed ✓), plus **Termux:Boot** from F-Droid for autostart. Enable Developer Mode in Discord app to copy channel IDs. In the Discord Developer Portal, enable the **Message Content Intent** (Bot -> Privileged Gateway Intents), otherwise the listener cannot read message text.

```sh
# 1) On PC: push project to the Tab
adb push tab-automation /sdcard/tab-automation

# 2) Inside Termux on the Tab:
bash /sdcard/tab-automation/termux-setup.sh
nano ~/tab-automation/.env   # fill DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, AZURE_OPENAI_*
node ~/tab-automation/src/validate.js
bash ~/tab-automation/termux/run.sh
```

Keepalive: `run.sh` holds a wake lock and restarts the bot on crash. Leave the Tab on WiFi + charging. `~/.termux/boot/` entry autostarts after reboot (needs Termux:Boot app).

## Config reference

- `config/providers.json` — providers (`azure-foundry` | `openrouter` | `meta`) + default. Keys stay in `.env`.
- `config/agents.json` — add agents: `{ id, systemPrompt, provider?, model?, tools?, output?, outputSchema?, temperature?, maxTokens? }`. `model: "env:VAR"` allows per-agent overrides.
- `config/tools.json` — MCP servers (`stdio` | `http`). Per-agent allowlists live in `agents[].tools`, setup-wizard-only.
- `config/discord.json` — main channel, extras, owner id (written by setup picker).
- `config/workflows.json` — add workflows with `trigger` (`schedule`+`cron` | `discord`+`command` | `manual`) and `steps[]`. Agent steps support `output: json` + `outputSchema` (max 8 vars bool|int|string); templates use `{{steps.<id>}}` / `{{steps.<id>.<field>}}`; conditions support `is_true`/`is_false`; new step types `subflow`, `transform`.
- Runs persist to SQLite `data/tab-automation.db` — `!history`, `!run <id>` in Discord.
- `.env` — `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID` (notify target), `DISCORD_LISTEN_CHANNELS` (optional), `AZURE_OPENAI_ENDPOINT/KEY/DEPLOYMENT`.

## Discord setup reuse

Bot token / app ID / guild from `Harness/.env.local` are reused. Only new value needed: `DISCORD_CHANNEL_ID` for notifications. `DISCORD_LISTEN_CHANNELS` empty = mention/DM only (safest).
