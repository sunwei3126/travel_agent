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
- A DeepSeek API key for the research tools. Tests do not need one: server tests
  use a deterministic faux provider.

## Setup

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/pi-demo.git
cd pi-demo
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
npm run probe:thinking
npm run acceptance:live
npm run acceptance:crash
```

CI runs only the credential-free checks. Live acceptance is a manual step.

## Where things live

| Path | Responsibility |
| --- | --- |
| `apps/server/src/agent/` | System prompt, tools, extension registration |
| `apps/server/src/harness/service.ts` | Durable conversations, submissions, event watching |
| `apps/server/src/agui/mapper.ts` | Pi events → AG-UI reasoning/text/tool lifecycle |
| `apps/server/src/http/routes/` | `/agui` SSE and REST routes |
| `apps/web/app/api/copilotkit/` | Per-trip CopilotKit runtime bridge |
| `apps/web/components/chat/` | Chat panel, reasoning and tool-call blocks |
| `apps/web/lib/chat.ts` | Pure grouping/status/format helpers |
| `packages/shared/src/trip.ts` | Shared trip, plan, source, and transcript types |
| `scripts/` | Live and crash-resume acceptance scripts |

`docs/reports/2026-10-20-chat-trace-explainer.html` is a longer visual
walkthrough of the request lifecycle and failure modes.

## Adding a tool

1. Define it with `defineTool` under `apps/server/src/agent/tools/`.
2. Register it in `apps/server/src/agent/extension.ts`.
3. Update the system prompt so the model knows when to call it.
4. Keep durable reads/writes inside `api.commit()`; do not read a settled draft
   outside the commit.
5. Add a unit test, and a real Harness/SQLite integration test if the tool
   persists state or drives an event-visible flow.

## Changing event mapping

1. Start with a mapper test that uses the real pi-durable shape
   (`changes`, `block`, `message_end`, `tool_execution_*`).
2. If the lifecycle changes, update `mapper.protocol.test.ts` so the whole
   sequence passes `verifyEvents`.
3. Make sure `run_end` closes every open reasoning, text, and tool entity;
   otherwise `RUN_FINISHED` is rejected.

## Commit style

Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`). Keep commits
focused. Do not commit generated files (`apps/web/next-env.d.ts`,
`apps/web/AGENTS.md`, `.next/`, `data/`, `.superpowers/`); they are ignored.

## Pull requests

- Describe the problem and the chosen approach.
- List the commands you ran (tests, typecheck, build; live checks if relevant).
- Add or update tests for behavior changes.
- Do not include API keys, tokens, or personal data.
- Note any provider assumptions (magpie, remote endpoint, model IDs).

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
