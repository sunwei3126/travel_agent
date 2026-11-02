# 泰山行程助手 · travel_agent

A durable travel-planning agent that shows its work. Chat with the assistant,
watch it reason and call tools, research cited sources, generate day cards with
SVG sketches, and keep the plan within budget. Conversations, research, and
plans survive refreshes and server restarts.

[![CI](https://github.com/sunwei3126/travel_agent/actions/workflows/ci.yml/badge.svg)](https://github.com/sunwei3126/travel_agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.22-3c873a.svg)](.nvmrc)

![Chat with reasoning and tool traces](docs/images/chat-traces.jpg)

![A day card with a generated sketch, plus the budget summary](docs/images/plan-board.jpg)

> Screenshots are illustrative; live model output and source availability vary.

## What it does

- **Clarify before planning.** The agent merges the trip brief through a tool
  and asks for missing fields instead of guessing.
- **Research with sources.** DeepSeek Search/Fetch results are stored with ids,
  titles, URLs, dates, and authority metadata. Every hard-fact claim cites a
  source or is explicitly marked unverified.
- **One card per day.** Each card contains timed blocks, scenery/food/transport
  claims, an estimated cost range, source chips, and a generated SVG sketch.
- **Visible traces.** Reasoning blocks and tool calls are collapsed by default
  in chat; expand one to see arguments, status, results, errors, and live tool
  progress.
- **Durable by construction.** Thread history lives in a CopilotKit runner
  (SQLite), trip state in the server's own SQLite, and the model session in
  Claude Agent SDK transcripts, all under `DATA_DIR`. A restarted server
  re-sends the run that was in flight; a refreshed browser replays the thread.
- **Budget-aware.** `plan_finalize` sums day-card ranges against the brief cap;
  over-budget plans are flagged and revised.

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI["ChatPanel · plan board"]
  end
  subgraph Next["Next.js :3000"]
    PX["/backend rewrite"]
  end
  subgraph Server["Fastify :4000"]
    RT["CopilotKit runtime<br/>/api/copilotkit"]
    RUN["SqliteAgentRunner<br/>threads.db"]
    AG["TravelAgent<br/>Claude Agent SDK adapter"]
    TOOLS["6 travel tools (in-process MCP)"]
    DB[("travel.sqlite")]
    REST["/api/trips REST"]
  end
  CC["Claude Code subprocess"]
  M["Model endpoint<br/>Anthropic Messages"]
  S["DeepSeek<br/>Search / Fetch"]

  UI --> PX --> RT --> RUN --> AG
  AG --> CC --> M
  CC --> TOOLS --> DB
  TOOLS --> S
  PX --> REST --> DB
```

The CopilotKit runtime owns thread history and reconnects; `TravelAgent`
builds one Claude Agent SDK run per message and keeps the trip state in
`travel.sqlite`. Plan cards and research counters are read from
`GET /api/trips/:id`, which the UI polls every two seconds while a run is active.

A longer, visual walkthrough of the request lifecycle and the three failure
modes fixed in this codebase is in
[`docs/reports/2026-10-20-chat-trace-explainer.html`](docs/reports/2026-10-20-chat-trace-explainer.html).
The original design record (Chinese) is in
[`docs/design/2026-10-19-taishan-travel-agent-design.md`](docs/design/2026-10-19-taishan-travel-agent-design.md).

## Requirements

- **Node.js 22.22** (see `.nvmrc`; npm 10+)
- **An Anthropic Messages-compatible model endpoint.** The development default
  is a local magpie gateway at `http://127.0.0.1:3425`; any compatible endpoint
  works through `MAGPIE_*`.
- **A platform with a prebuilt `better-sqlite3` binary** (Node 22.22 on
  Windows, macOS and Linux x64/arm64).
- **A DeepSeek API key** for the research tools. Unit tests do not need one:
  they run against in-memory stores and scripted fakes.

## Quick start

```bash
nvm use            # or install Node 22.22 yourself
npm ci

# Terminal 1: Fastify API
export DEEPSEEK_API_KEY=...
export PI_THINKING_LEVEL=low
npm run dev:server

# Terminal 2: Next.js web app
npm run dev:web
```

Open <http://localhost:3000>, create a trip, and send a request such as:

> 泰山玩三天，2026-10-26 从上海虹桥火车站出发，自己去，预算 3000，体力一般，在意风景和美食。

The server reads `process.env` directly and does **not** auto-load a root
`.env` file. Export variables in each terminal (or use a process manager).
`.env.example` documents every variable.

### Production-style run

```bash
npm run build
export DEEPSEEK_API_KEY=...
npm run start:server

# second terminal
API_URL=http://127.0.0.1:4000 npm run start:web
```

## Configuration

| Variable | Read by | Default | Notes |
| --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | server | — | **Required at startup.** Used by Search/Fetch. |
| `DEEPSEEK_BASE_URL` | server | `https://api.deepseek.com` | Research API base. |
| `PORT` | server | `4000` | Crash script defaults to `4100`. |
| `DATA_DIR` | server | `./data` | Holds `travel.sqlite`, `threads.db` and `claude/` (Claude session transcripts). Relative to the server process cwd. SQLite is single-process. |
| `MAGPIE_BASE_URL` | server | `http://127.0.0.1:3425` | Any Anthropic Messages-compatible endpoint. Mapped onto the `ANTHROPIC_*` variables Claude Code reads. |
| `MAGPIE_MODEL` | server | `deepseek/deepseek-flash` | Must match the endpoint’s model id. Mapped onto the `ANTHROPIC_*` variables Claude Code reads. |
| `MAGPIE_API_KEY` | server | `magpie` | Sent as `x-api-key`; a local magpie accepts any value. Mapped onto the `ANTHROPIC_*` variables Claude Code reads. |
| `MAGPIE_MAX_TOKENS` | server | `393216` | Lower it for providers with smaller output limits. Mapped onto the `ANTHROPIC_*` variables Claude Code reads. |
| `PI_THINKING_LEVEL` | server | `low` | `off`, `low`, `medium`, or `high`; mapped to the SDK thinking budget (`off` disables it). |
| `API_URL` | Next config, scripts | `http://127.0.0.1:4000` | Target of the `/backend` rewrite; acceptance API base. |
| `NEXT_PUBLIC_API_URL` | browser code | `/backend` | Inlined at build time; an absolute value may need CORS. |
| `MAGPIE_LIVE` | tests | unset | Set `1` to run the live provider test. |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev:server` | Fastify with watch mode (`tsx watch`). |
| `npm run dev:web` | Next.js dev server. |
| `npm run build` | Production Next.js build. |
| `npm run typecheck` | Server + shared + web (`next typegen` runs first). |
| `npm test` | Server, web, and shared tests. |
| `npm run acceptance:live` | End-to-end scenario against a running server. |
| `npm run acceptance:crash` | Start a server, `SIGKILL` it mid-research, restart, verify resume. |

## Testing and acceptance

Credential-free checks (what CI runs):

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Live checks (require a model endpoint and `DEEPSEEK_API_KEY`):

```bash
npm run acceptance:live
```

`acceptance:live` creates a trip, submits a brief whose start date defaults to
today + 14 days (override with `ACCEPTANCE_START_DATE=YYYY-MM-DD`), and polls
for up to 15 minutes. It fails unless the run ends with:

- exactly three day cards;
- a non-`pending` SVG status on every day;
- every fact claim either sourced or explicitly marked unverified;
- at least one fact backed by a **fetched** source;
- a budget summary with `withinBudget: true` and `high <= 3000`.

Research is capped at **40 searches / 30 fetches per trip**; repeated completed
calls are cached. `acceptance:crash` starts its own server on port `4100`,
kills it after research begins, restarts against the same `DATA_DIR`, and
verifies the run resumes without repeating completed work and that the chat
history still contains the original request plus the restart note.

Validation split: `plan_emit_day` checks brief completeness, source existence,
fetched status, and cost ranges. `plan_finalize` only sums the day-card ranges
and sets `withinBudget`.

## Project structure

| Path | Responsibility |
| --- | --- |
| `apps/web/` | Next.js UI: chat traces, trip list, plan board, budget. |
| `apps/web/components/chat/` | ChatPanel, ReasoningBlock, ToolCallBlock. |
| `apps/web/lib/chat.ts` | Pure grouping/status/format helpers. |
| `apps/server/` | Fastify API and the CopilotKit runtime host. |
| `apps/server/src/agent/` | `TravelAgent`, the Claude adapter factory, the six tools, system prompt. |
| `apps/server/src/store/` | `better-sqlite3` trip store: docs, sessions, in-flight runs. |
| `apps/server/src/recovery.ts` | Clears stale runner state and re-sends interrupted runs at startup. |
| `apps/server/src/runtime.ts` | CopilotKit runtime with `SqliteAgentRunner`. |
| `packages/shared/` | Trip, plan, source, and transcript types. |
| `scripts/` | Live and crash-resume acceptance scripts. |
| `docs/design/` | Original design record. |
| `docs/reports/` | Developer explainer (HTML). |

## Limitations and security

- This is a **local, single-user demo**, not production software.
- No authentication or multi-tenant isolation; the API binds `127.0.0.1` by
  default. Do not expose it to an untrusted network.
- SQLite is a single-process store; `DATA_DIR` is not encrypted.
- The run that was in flight when the server died loses its partial output from
  the chat history (completed tool results are kept); a short restart note is
  added to the chat.
- The UI is Chinese; the agent responds in the user’s language.
- Live model output varies, and research sources can be stale or unavailable.
- Provider usage may incur costs. Keep keys in the environment; never commit
  them. See [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Conventional commits, tests for
behavior changes, and no secrets in diffs.

## License

[MIT](LICENSE) © 2026 wei sun.
