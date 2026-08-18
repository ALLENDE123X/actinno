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
- [x] ACT-013: MCP `intake-candidate` actor + apply by email instead of UUID
- [x] ACT-014: attach the resume to the chat — presigned upload instead of a
      filesystem path
- [x] ACT-015: fill *every* field on a form, not a fixed list of eight — with an
      answering policy, and a stop-and-ask instead of a guess

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
the entry's `env` — `load-env.ts` resolves `.env.local` relative to itself, and
from `~/.actinno-mcp/server.mjs` that is `~/.env.local`, which does not exist.

Since ACT-013 there is a second way to feed it, and intake needs one: the
Supabase service-role key is not something to paste into a JSON config, and
`intake-candidate` cannot run without it. `load-env.ts` also reads
`~/.actinno-mcp/.env.local` — same directory as the bundle, so the same
sandbox that reads one reads the other:

```
cp .env.local ~/.actinno-mcp/.env.local && chmod 600 ~/.actinno-mcp/.env.local
```

Repo `.env.local` still wins when running from the checkout, and anything in
Claude Desktop's `env` block beats both. Re-copy after rotating a key — it is a
copy, not a link.

**The bundle is a snapshot.** Re-run `npm run bundle` after any change to
`mcp-server/` or the `lib/` modules it imports, or Claude Desktop keeps running
the old code.

Two tools, `search_actors` and `call_actor`, and five actors behind them.
`actinno/create-resume-upload` and `actinno/check-resume-upload` move a resume
PDF into the system without a terminal (ACT-014, below);
`actinno/intake-candidate` onboards a person once (see below).
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

Its input is one `listing` object passed straight through from
`bulk-search-job-listings`, plus **either** `applicationEmail` **or**
`candidateId` — exactly one; passing both is rejected rather than resolved in
some precedence order, because the two can disagree and the disagreement would
be a real application filed under the wrong person's resume. The email is
resolved to a `candidates.id` here in the MCP layer; the
`job-application/requested` event still carries `candidateId` and nothing else.
The resume and LinkedIn URL are **not** arguments — they are read from the
candidate's row.

### Onboarding through Claude Desktop (ACT-013/ACT-014)

`actinno/intake-candidate` is ACT-003's intake as an actor: resume PDF +
application email in, `candidateId` out, one row in `candidates` and one object
in the private `resumes` bucket. Run it **once per person** — a second run for
the same address creates a second candidate and makes that email ambiguous,
which `apply-to-job` then refuses to guess at.

The resume reaches it two ways, and exactly one of them may be used per call.

#### The normal route: attach the PDF to the conversation (ACT-014)

What the user does is attach their resume and say what they want. What Claude
does is:

1. `actinno/create-resume-upload` → `{ assetHandle, uploadUrl, token,
   expiresIn, instructions, snippets }`. The URL is a Supabase **presigned
   upload URL**: scoped to one object path, valid two hours, carrying no
   credential of ours. Nothing is written and no row is created.
2. **Claude's own execution environment** PUTs the attached file's raw bytes to
   that URL — `content-type: application/pdf`, no auth header, body is the
   bytes. It must be `PUT`; `POST` on that path is the *create-a-signed-URL*
   endpoint and answers `400 headers must have required property
   'authorization'`. The response's `instructions` field says all of this
   literally, because it is the only specification the uploader gets.
   `actinno/check-resume-upload` answers "did that land, and how many bytes?"
   cheaply, without downloading anything.
3. `actinno/intake-candidate` with `assetHandle` instead of `resumeFilePath`.
   It reads the staged object server-side with the service-role client and runs
   the ordinary intake on those bytes.

The bytes never pass through the model's context. A 120KB PDF is ~170k tokens
of base64 the model would have to emit without one character wrong — and a PDF
attached to a Claude conversation reaches the model as *extracted text*, so
there are no bytes there to re-emit in the first place. Going around the context
is the only version of this that works.

**Uploaded bytes are untrusted.** A presigned URL is a write capability handed
outside the trust boundary, so whatever lands at the staging path gets exactly
the checks a local file gets — non-empty, ≤25MB, `%PDF-` magic — via the same
`assertUsableResumeBytes()` both routes call. There is no laxer path for
uploads.

**Staging layout and cleanup.** Staged objects live at
`resumes/staging/{uuid}.pdf` — same private bucket, distinct prefix, no
possible collision with the real objects (`{candidateId}.pdf`, no slash). A
successful intake deletes the staging copy, so no duplicate is left behind.
Bytes that can never become a resume (empty, oversized, not a PDF) are deleted
on the spot. A *retryable* failure keeps them, so the fix is one more actor call
rather than another upload. Abandoned slots are swept after 24h by
`createResumeUploadSlot()` itself, which is the only moment anything is ever
added to the prefix — no cron, no edge function, no extra table.

Supabase needs no CORS setup for this: its gateway serves
`access-control-allow-origin: *` with all methods and reflected headers on the
storage endpoint, which is platform default and not per-project configuration.

#### The fallback: a file path (ACT-013)

Kept, unchanged, and still what to reach for when the upload leg is
unavailable — the environment holding the PDF may have no outbound network at
all, and that is not knowable in advance. When it fails, it fails loudly: an
`assetHandle` whose object is missing or zero bytes reports that the upload leg
did not land, that no candidate was created, and prints the `cp` to run instead.

Intake is the only thing in this server that reads a local file at runtime, and
it does so from inside the sandbox described above. `~/Desktop` is denied
outright — that is the observed failure, the one that forced the bundle — and
`~/Documents`, `~/Downloads` and iCloud Drive are TCC-protected on the same
terms and should be assumed denied too. The denial arrives as `EPERM`/`EACCES`,
which reads like a file-permission problem and is not one.

**The drop spot is `~/.actinno-mcp/resumes/`.** It is created on demand, it sits
next to the bundle the sandbox demonstrably reads, and a bare filename in
`resumeFilePath` is resolved against it:

```
mkdir -p ~/.actinno-mcp/resumes && cp ~/Desktop/resume.pdf ~/.actinno-mcp/resumes/
```

A readable absolute path anywhere else is used as given. An unreadable one fails
with the `cp` command to run, spelled out, plus a listing of the PDFs already in
the drop spot — and if the file turns out to be sitting in the drop spot under
the same name, that copy is used and the result says so.

### When an application needs the candidate (ACT-015)

`apply-to-job` returns a tracking id in a second and then runs for minutes, so
it cannot ask a question mid-run. ACT-015 gives it a third ending — "the form
asked something I will not guess at" — and `actinno/check-application-status` is
how that question reaches the person:

```
actinno/intake-candidate      once, with workAuthorizedUs / currentCountry / …
actinno/bulk-search-job-listings
actinno/apply-to-job          once per listing
actinno/check-application-status   a few minutes later
   ↳ a row comes back with needs_candidate_input and the exact questions
   ↳ Claude asks the user in chat, the user answers
actinno/apply-to-job          same listing, this time with additionalAnswers
```

Nothing is stored between the two `apply-to-job` calls. The keys are the form's
own labels, recomputed identically on the second run, which is what lets the
loop be stateless. Nothing is ever submitted while a required field is empty.

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

### Every field, not a list of eight (ACT-015)

ACT-007 filled the eight fields it had been told about in advance — name, email,
phone, LinkedIn, website, resume, cover letter — and was structurally blind to
everything else. A real Discord Greenhouse form came back with nine required
fields untouched: a country dropdown, a city, a required essay, three work-
authorization questions and four EEO selects. The board's own validation would
have rejected it.

The field layer is now three separate things instead of one:

- **Perception** (`lib/form-fields.ts`, no model) reads the DOM and reports
  every control: label, kind, required flag, current value, and the real option
  strings behind each dropdown.
- **Decision** (`decideFieldAnswers` in `lib/resume-parser.ts`) is one model
  call with **no tools attached**, behind the same `assertNoActionSurface()`
  guard the resume parse already uses. Untrusted form labels reach it; the worst
  they can do is produce a wrong string.
- **Action** (`lib/form-fields.ts`, no model) applies each value through a
  Playwright locator derived from the perception pass, and reads it back. No
  page text is ever concatenated into an instruction.

The answering policy, per field:

| kind of question | what happens |
| --- | --- |
| work authorization, sponsorship, country, city, relocation | answered from the `candidates` row, collected once at intake |
| free-text essays ("Why do you want to work at Discord?") | written from the *validated profile* by the same generator that writes cover letters |
| gender, race, ethnicity, veteran, disability | **always** "decline to self-identify" — a truthful answer; a demographic identity is never invented |
| anything factual with no backing data | **stops and asks.** Never guessed. |

That last row is the point. A required field the run cannot answer truthfully
comes back as `needsInput` — a structured list of `{ key, fieldLabel, question,
why, options }` — alongside everything it *did* fill, and the row is left at
`form_fill_blocked` so nothing downstream can submit a form the board would
reject anyway. Answer and re-run; nothing is stored in between:

```
npm run fill-form -- --application <uuid> \
  --answer "are you currently located in the us?=Yes" \
  --answer "country=United States +1"
```

The key is the form's own label, folded to lower case, exactly as the previous
run printed it.

Collect the reusable answers once at intake instead, and most forms never ask:

```
npm run intake -- --resume ./resume.pdf --email jane@example.com \
  --work-authorized-us yes --requires-sponsorship no \
  --country "United States" --city "Atlanta" --willing-to-relocate yes
```

Leave a flag out if the candidate has not told you. Omitted means "not stated",
and a form that asks will stop and ask them — which is the entire design.

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
  bucket (private; `{candidateId}.pdf` at the root, ACT-014's presigned uploads
  under `staging/`), `candidates` and `job_applications` tables. Currently
  locked to service_role only — tighten before any real (non-founder) users.
  Note: `hlaeqvuyapkvixwaqxcs` is the *meminno* project — a separate live
  product. Never point this repo at it.
- GitHub repo: this one.

## Explicitly out of scope for now

- Remote hosting (Vercel, Browserbase) — local demo only
- Claude Connector / ChatGPT App directory submission
- Gmail OAuth app verification — use test-user mode, not needed at this scale

See individual issues for API keys required per ticket.
