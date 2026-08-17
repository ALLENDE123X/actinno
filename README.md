# Actinno

Consumer actor marketplace for AI agents. Local MCP server exposing two tools—
`search_actors` and `call_actor`—mirroring Apify's own pattern, but aimed at
consumers instead of developers. First actor: end-to-end job application
automation.

## Architecture

- `mcp-server/` — the local stdio MCP server (Claude Desktop connects here)
- `inngest/` — durable execution layer for the apply-to-job actor's internal
  chain (account creation → email verification wait → form fill → submit)

## Status

- [x] ACT-001: Repo scaffold
- [x] ACT-002: Bulk-search-job-listings wired to real Greenhouse actor
- [ ] ACT-003 through ACT-011: see GitHub Issues

## Infra already provisioned

- Supabase (meminno project, `hlaeqvuyapkvixwaqxcs`): `resumes` storage
  bucket, `candidates` and `job_applications` tables. Currently locked to
  service_role only — tighten before any real (non-founder) users.
- GitHub repo: this one.

## Explicitly out of scope for now

- Remote hosting (Vercel, Browserbase) — local demo only
- Claude Connector / ChatGPT App directory submission
- Gmail OAuth app verification — use test-user mode, not needed at this scale

See individual issues for API keys required per ticket.
