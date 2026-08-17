# Actinno

Consumer actor marketplace for AI agents. Local MCP server exposing two tools—
`search_actors` and `call_actor`—mirroring Apify's own pattern, but aimed at
consumers instead of developers. First actor: end-to-end job application
automation.

## Architecture

- `mcp-server/` — the local stdio MCP server (Claude Desktop connects here)
- `inngest/` — durable execution layer: one `discover-listings` run fans out to
  one `apply-to-job` run per listing (account creation → email verification wait
  → form fill + submit), five at a time
- `lib/` — shared utilities used by both `mcp-server/` and `inngest/`
  (job-listing search, candidate intake, board password generation, job-board
  account creation, Gmail verification listener, form fill, submission)

## Status

- [x] ACT-001: Repo scaffold
- [x] ACT-002: Bulk-search-job-listings wired to real Greenhouse actor
- [x] ACT-003: Candidate intake — resume upload + candidate row
- [x] ACT-004: Per-board unique password generator
- [x] ACT-005: Playwright account creation on job board
- [x] ACT-006: Gmail verification listener
- [x] ACT-007: Application form-fill from resume (stops before submission)
- [x] ACT-008: Submit application + capture confirmation
- [x] ACT-009: Inngest orchestration — ACT-002…008 wired end to end
- [x] ACT-010: MCP `apply-to-job` fires Inngest async instead of blocking
- [ ] ACT-011: see GitHub Issues

## Running the whole pipeline (ACT-009)

Two processes, in either order:

```
cd inngest
npm install
npm run serve     # holds the functions, on http://localhost:3000/api/inngest
npm run dev       # the Inngest dev server + dashboard, on http://localhost:8288
```

No Inngest Cloud keys. `INNGEST_DEV=1` lives in the committed `.env` because the
v4 SDK does **not** infer dev mode from `NODE_ENV` — without it the SDK starts in
cloud mode and every request to the serve endpoint answers
`{"code":"internal_server_error"}` over a missing signing key.

Then trigger a search. Claude Desktop is the real front door (see below); this
CLI is the headless equivalent, and it is what to reach for when debugging the
pipeline without an MCP client in the loop:

```
cd inngest
npm run trigger -- --candidate <uuid> --companies stripe,airbnb \
                   --title "software engineer" --location Remote
```

`--candidate` is the `candidates.id` UUID from ACT-003 intake, and it has to be
exactly that — it is the same identity as `job_applications.candidate_id` and as
the `userId` ACT-006 puts on `email/verification-received`, which is what the
pipeline's verification wait matches on.

`--companies` is required. The Greenhouse actor lists jobs **per company board**;
it has no keyword-search mode, so `--title` is a narrowing filter applied to the
results rather than a query. `--title`, `--location` and `--pay-min` default to
the candidate's own `target_title` / `locations` / `pay_min`.

**`npm run trigger` starts real applications.** Discovery is one read-only Apify
call, but every listing it finds fans out into a run that opens a browser at a
real employer and submits. Add `--discover-only` to run just the search and print
what *would* have been dispatched — it sends nothing.

For the verification half of the chain to work, ACT-006's listener has to be
running in a third terminal (`cd lib && npm run verification-listener`). Without
it, any listing that turns out to need an account parks for ten minutes and then
gives up, leaving its row at `awaiting_verification` — which is re-runnable once
the mail is in hand.

## Running the MCP server (ACT-010)

```
cd mcp-server
npm install
npm start          # stdio — normally spawned by Claude Desktop, not by hand
```

### Registering it with Claude Desktop, and the ~/Desktop sandbox

Claude Desktop runs each MCP server inside a macOS Seatbelt sandbox that is
**separate from the app's own Full Disk Access grant**, and that sandbox denies
reads anywhere under `~/Desktop`. Pointing the config straight at
`mcp-server/node_modules/.bin/tsx` in this repo therefore dies immediately with
`EPERM: operation not permitted` on tsx's own entry file, before any of this
code runs. Granting Claude full disk access does not help; the subprocess is
sandboxed regardless.

The fix, so the repo can stay where it is:

```
cd mcp-server && npm run bundle    # -> ~/.actinno-mcp/server.mjs
```

esbuild inlines every import into one file outside `~/Desktop`, so the
subprocess never has to read this directory at all. Point the `actinno` entry in
`~/Library/Application Support/Claude/claude_desktop_config.json` at that file
with an absolute `node` path, and pass `APIFY_API_TOKEN` and `INNGEST_DEV=1` in
the entry's `env` — `load-env.ts` cannot reach `.env.local` from the bundle
either (it warns and carries on using the ambient environment, which is exactly
what those `env` values are for).

**The bundle is a snapshot.** Re-run `npm run bundle` after any change to
`mcp-server/` or the `lib/` modules it imports, or Claude Desktop keeps running
the old code.

Two tools, `search_actors` and `call_actor`, and two actors behind them.
`actinno/bulk-search-job-listings` is one read-only API call and answers inline.
`actinno/apply-to-job` does **not** run the application here: it sends
`job-application/requested` to Inngest and returns
`{ status: "started", trackingId }` in about a tenth of a second. The trackingId
is Inngest's own event id, so it is the id the run is listed under at
http://localhost:8288.

That asynchrony is the design, not a shortcut. The chain behind one listing runs
for minutes and can park for ten of them waiting on a verification email; no MCP
call survives that, and it does not need to, because the run is durable on the
Inngest side. **Nothing reports completion back into the chat** — the candidate
finds out from the employer's own confirmation email.

So the Inngest processes above have to be running before the tool is called;
with nothing on :8288 the tool fails in under two seconds saying exactly that.

Its input is `candidateId` (the `candidates.id` UUID) plus one `listing` object
passed straight through from `bulk-search-job-listings`. Resume, LinkedIn URL and
application email are **not** arguments — they are read from the candidate's row,
and a call that passes them instead of a `candidateId` is rejected on the spot.

## Running the Gmail verification listener (ACT-006)

One-time (and again every 7 days — Google expires refresh tokens issued to
test users while the OAuth app stays in Testing publishing status):

```
cd lib
npm run gmail-auth              # approve in the browser, paste the printed
                                # GOOGLE_OAUTH_REFRESH_TOKEN into .env.local
npm run verification-listener   # polls Gmail, sends email/verification-received
```

`npm run verification-listener -- --dry-run` makes every match/reject decision
and prints it without sending anything — use it to confirm the listener ignores
unrelated mail arriving in the same window.

## Filling an application form (ACT-007)

```
cd lib
npm run fill-form -- --candidate <uuid> --apply-url <listing url> --keep-browser
```

Needs a `job_applications` row from ACT-005. If that row is at
`awaiting_verification`, pass the code and/or link from ACT-006's
`email/verification-received` event — **this** is the step that completes the
verification; ACT-006 only detects it:

```
npm run fill-form -- --application <uuid> --verification-link <url>
```

Add `--requires-cover-letter` (ACT-002's `requiresCoverLetter` for the listing)
to have one written and pasted in. Without it, no cover letter is generated.

It fills the form and **stops**. Nothing is ever submitted — that is ACT-008.
The run prints every field with what was typed and what the browser reads back
out of the control afterwards, and writes a full-page screenshot of the filled,
unsubmitted form to `lib/.form-fill-screenshots/` (gitignored).

Resume text, job-description text and application-question text are treated as
hostile throughout. They are only ever read by `lib/resume-parser.ts`, which has
no browser and no tools; the browser module never sees them.

## Submitting an application (ACT-008)

**This one really sends it.** It fills the form (ACT-007, in the same browser —
a filled form cannot outlive its browser, so there is no separate fill step to
run first) and then presses submit, at a real employer, under the candidate's
real name. There is no undo. `--yes-really-submit` is required and is only a
guard on this CLI; the module itself is fully autonomous by design.

```
cd lib
npm run submit-application -- --application <uuid> --yes-really-submit
```

Takes the same `--requires-cover-letter`, `--job-description-file`,
`--verification-link`, `--verification-code` and `--keep-browser` flags as
`fill-form`, and resolves a row from `--candidate` + `--apply-url` the same way.

Exit codes are worth knowing: `0` submitted, `2` stopped before clicking
anything (safe, needs a human), `3` **the submit control was clicked and the
outcome is unknown — do not re-run that row**, `1` an unexpected failure before
anything was clicked.

Row statuses it writes: `submitted` (with `confirmation_ref` — a reference
number, the board's confirmation wording, or `email confirmation incoming`),
`submission_blocked` (nothing clicked, safe to re-run), and
`submission_unconfirmed` (clicked, outcome unknown, never retried
automatically). A row already at `submitted` or `submission_unconfirmed` is
refused before a browser is opened.

Full autonomy vs. a one-tap human review gate was decided in favour of autonomy
for the demo. The swap-in point is `AUTO_APPROVE_SUBMISSION` in
`lib/submit-application.ts` — one function, called from one place, immediately
before the click.

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
