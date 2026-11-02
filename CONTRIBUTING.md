# Contributing

Thanks for taking a look. This repository is a demo of a durable travel-planning
agent; it is not production software. Contributions that improve correctness,
clarity, or developer experience are welcome.

## Prerequisites

- Node.js 22.22 (see `.nvmrc`)
- npm 10+
- An Anthropic Messages-compatible model endpoint. The local development
  default is a magpie gateway at `http://127.0.0.1:3425`; any compatible
  endpoint works via the `MAGPIE_*` variables in `.env.example`.
- A DeepSeek API key for the research tools. Tests do not need one: they run
  against in-memory stores and scripted fakes.

## Setup

```bash
git clone https://github.com/sunwei3126/travel_agent.git
cd travel_agent
npm ci
```

The server reads `process.env` directly and does **not** auto-load a root
`.env` file. Export variables in your shell (or use a process manager):

```bash
export DEEPSEEK_API_KEY=...
export PI_THINKING_LEVEL=low
```

## Run

Use two terminals:

```bash
npm run dev:server   # Fastify on http://127.0.0.1:4000
npm run dev:web      # Next.js on http://localhost:3000
```

`npm run dev` is an alias for `dev:server` only.

## Verify

```bash
npm test             # server + web + shared unit/integration tests
npm run typecheck    # server, shared, and web (runs next typegen first)
npm run build        # production Next.js build
```

Optional live checks (require a model endpoint and `DEEPSEEK_API_KEY`):

```bash
npm run acceptance:live
npm run acceptance:crash
```

CI runs only the credential-free checks. Live acceptance is a manual step.

## Where things live

| Path | Responsibility |
| --- | --- |
| `apps/server/src/agent/travel-agent.ts` | `TravelAgent`: in-flight bookkeeping, session resume, fault recording, `RUN_ERROR`. |
| `apps/server/src/agent/claude-adapter.ts` | Adapter factory: gateway env, thinking budget, tool allow-list, clone fix. |
| `apps/server/src/agent/mcp.ts` | In-process MCP server exposing the six travel tools. |
| `apps/server/src/agent/tools/` | One file per tool (`update-brief`, `emit-day`, `search`, `fetch`, `sketch-day`, `finalize`). |
| `apps/server/src/agent/system-prompt.ts` | Trip-aware system prompt. |
| `apps/server/src/store/trip-store.ts` | `better-sqlite3` trip store: docs, sessions, in-flight runs. |
| `apps/server/src/recovery.ts` | Clears stale runner flags and re-sends interrupted runs at startup. |
| `apps/server/src/runtime.ts` | CopilotKit runtime with `SqliteAgentRunner` under `/api/copilotkit`. |
| `apps/server/src/http/routes/` | CopilotKit handler and the `/api/trips` REST routes. |
| `apps/web/components/chat/` | Chat panel, reasoning and tool-call blocks. |
| `apps/web/lib/chat.ts` | Pure grouping/status/format helpers. |
| `packages/shared/src/trip.ts` | Shared trip, brief, plan, and source types. |
| `scripts/` | Live and crash-resume acceptance scripts. |

`docs/reports/2026-10-20-chat-trace-explainer.html` is a longer visual
walkthrough of the request lifecycle. It is a historical record of the
pi-durable architecture; use this file and the README for current practice.

## Adding a tool

1. Define it with the SDK's `tool()` under `apps/server/src/agent/tools/`,
   taking a `ToolContext` (`tripId`, `store`, `deps`) and wrapping the body in
   `guarded(...)` so failures come back as `isError` tool results instead of
   killing the run.
2. Register it in `buildTravelTools` in `apps/server/src/agent/mcp.ts`; the
   model's allow-list is derived from the returned tools, so nothing else needs
   editing to grant it.
3. Update `apps/server/src/agent/system-prompt.ts` so the model knows when to
   call it.
4. Keep durable reads and writes inside `ctx.store` (use `store.transaction`
   when several documents change together) so a resumed run sees the same state.
5. Add a unit test next to the tool; `apps/server/src/agent/tools/test-support.ts`
   builds the fake store and deps.

## Changing run behaviour

1. AG-UI events come from `@ag-ui/claude-agent-sdk`; `TravelAgent` forwards them
   and only rewrites a failed result into `RUN_ERROR` plus a fault record. Keep
   that rewrite if you touch the stream handling.
2. Session resume and in-flight bookkeeping are pinned by
   `apps/server/src/agent/travel-agent.test.ts`.
3. Adapter options (gateway env, thinking budget, tool allow-list, the clone
   fix) are pinned by `apps/server/src/agent/claude-adapter.test.ts`;
   `apps/server/src/runtime.test.ts` covers the real runtime plus
   `SqliteAgentRunner` streaming and persisting a run.
4. `apps/server/src/recovery.test.ts` pins `RESUME_NOTE`, the text
   `scripts/crash-resume.sh` greps for. Change both together.

## Commit style

Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`). Keep commits
focused. Do not commit generated files (`apps/web/next-env.d.ts`,
`apps/web/AGENTS.md`, `.next/`, `data/`); they are ignored.

## Pull requests

- Describe the problem and the chosen approach.
- List the commands you ran (tests, typecheck, build; live checks if relevant).
- Add or update tests for behavior changes.
- Do not include API keys, tokens, or personal data.
- Note any provider assumptions (magpie, remote endpoint, model IDs).

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
