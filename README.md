# Actinno

Consumer actor marketplace for AI agents. Local MCP server exposing two tools—
`search_actors` and `call_actor`—mirroring Apify's own pattern, but aimed at
consumers instead of developers. First actor: end-to-end job application
automation.

## Architecture

- `mcp-server/` — the local stdio MCP server (Claude Desktop connects here)
- `inngest/` — durable execution layer for the apply-to-job actor's internal
  chain (account creation → email verification wait → form fill → submit)
- `lib/` — shared utilities used by both `mcp-server/` and `inngest/`
  (candidate intake, board password generation)

## Status

- [x] ACT-001: Repo scaffold
- [x] ACT-002: Bulk-search-job-listings wired to real Greenhouse actor
- [x] ACT-003: Candidate intake — resume upload + candidate row
- [x] ACT-004: Per-board unique password generator
- [x] ACT-005: Playwright account creation on job board
- [ ] ACT-006 through ACT-011: see GitHub Issues

## Infra already provisioned

- Supabase (**actinno** project, `oihpglvvzzmjigxrlmfz`): `resumes` storage
  bucket (private), `candidates` and `job_applications` tables. Currently
  locked to service_role only — tighten before any real (non-founder) users.
  Note: `hlaeqvuyapkvixwaqxcs` is the *meminno* project — a separate live
  product. Never point this repo at it.
- GitHub repo: this one.

## Explicitly out of scope for now

- Remote hosting (Vercel, Browserbase) — local demo only
- Claude Connector / ChatGPT App directory submission
- Gmail OAuth app verification — use test-user mode, not needed at this scale

See individual issues for API keys required per ticket.
