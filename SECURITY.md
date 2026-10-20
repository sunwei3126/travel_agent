# Security Policy

## Supported versions

This is a pre-1.0 demo. Security fixes are applied to the `main` branch on a
best-effort basis; no long-term support window is promised.

## Reporting a vulnerability

Please report vulnerabilities privately through **GitHub Security Advisories**
on this repository (Security → Report a vulnerability). Do not open a public
issue for a suspected vulnerability.

Include the affected version/commit, a reproduction, and the impact. You can
expect an acknowledgement when the report is reviewed.

## Security model

- The API is a local demo. It binds to `127.0.0.1` by default and has **no
  authentication, authorization, or multi-tenant isolation**. Do not expose it
  to an untrusted network.
- The durable store is local SQLite via pi-durable. `data/` is not encrypted and
  is ignored by git; treat it as local state.
- Model and research credentials (`DEEPSEEK_API_KEY`, `MAGPIE_API_KEY`) are read
  from the environment. Never commit them or place real values in
  `.env.example`.
- The model endpoint is trusted to return tool calls. Tool arguments are
  validated by the tool implementations; generated SVG is sanitized before
  rendering.
- If a key is exposed, rotate it with the provider immediately. Removing it from
  the working tree is not sufficient if it reached git history.

## Dependency and supply-chain notes

- `package-lock.json` is generated against `registry.npmjs.org`; CI installs
  with `npm ci`.
- Dependabot is configured for weekly npm and GitHub Actions updates.
