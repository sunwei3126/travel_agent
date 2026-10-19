# 泰山行程助手

A durable travel-planning agent for a three-day Tai Shan trip. Chat with the
assistant, research sources, generate day cards with cited claims, sketch
each day, and keep the plan within budget.

## Prerequisites

- Node.js 22.22
- A local magpie gateway on `http://127.0.0.1:3425` exposing the Anthropic
  Messages API with the model
  `deepseek/deepseek-flash` (1,000,000 token context).
- A DeepSeek API key for research:

  ```bash
  export DEEPSEEK_API_KEY=...
  ```

  Never commit the key or put it in this file.

## Setup

```bash
npm install
```

## Run

```bash
export DEEPSEEK_API_KEY=...
npm run dev
```

This starts the Fastify API at `http://127.0.0.1:4000`. In a second terminal,
start the Next.js app:

```bash
npm run dev --workspace @pi-demo/web
```

Open `http://localhost:3000`, choose a trip, and chat with the assistant while
the plan fills in.

The server reads these optional environment variables:

- `PORT` – API port (default `4000`)
- `DATA_DIR` – durable SQLite/doc directory (default `./data`)
- `MAGPIE_BASE_URL` – magpie gateway (default `http://127.0.0.1:3425`)
- `MAGPIE_MODEL` – model id (default `deepseek/deepseek-flash`)
- `DEEPSEEK_BASE_URL` – DeepSeek research API base URL
- `API_URL` – acceptance scripts' API URL (default `http://127.0.0.1:4000`)

## Acceptance checks

With magpie running and `DEEPSEEK_API_KEY` exported, start the app and run the
live Tai Shan scenario:

```bash
npm run acceptance:live
```

It creates a trip, submits the brief
`泰山玩三天，2026-10-26 从上海虹桥火车站出发，自己去，预算 3000，体力一般，在意风景和美食`,
and polls for up to 15 minutes. It fails unless the run ends with three day
cards, a budget summary, a non-`pending` SVG status on every day, and every
fact claim either sourced or explicitly marked unverified.

The crash-resume check starts its own server on port `4100`, kills it with
`SIGKILL` after research begins, restarts it against the same durable store,
and verifies the run resumes and finishes:

```bash
npm run acceptance:crash
```

It also asserts `research.searchCount <= 40` and leaves no data behind.

## Architecture

The browser talks to a per-trip CopilotKit runtime route, which bridges the
AG-UI protocol to the Fastify server. Each trip is a pi-durable conversation;
brief, plan, sources, and research counters are durable docs, so a restarted
server resumes an in-flight run. Research tools call DeepSeek and record
source ids on every claim; `finalize` validates the plan, computes the budget
summary, and the sketch tool produces a sanitized SVG per day (or a
placeholder with `svgStatus: "failed"`). The UI combines the durable snapshot
polled from `GET /api/trips/:id` with live CopilotKit state, preferring the
newer state.
