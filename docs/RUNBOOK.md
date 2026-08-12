# Runbook

Who owns what, what refreshes when, and what to do when it doesn't.

This document assumes the reader is on call, not learning the system. For what
the metrics mean, read `/kpi-dictionary` in the running app — it is generated
from the code and cannot go stale.

---

## The one thing to understand first

Every number in this system comes from one function: `resolveKpi`, in
`lib/semantic/`. Dashboards call it. The audit pack calls it. The assistant's
tools call it. There is no second path — no raw SQL tool, no export-time
recalculation, no widget that works out its own figure.

This matters on call because it narrows diagnosis. If a figure looks wrong, it is
wrong in exactly one of three places:

1. **The data** — a load didn't run, or landed something unexpected.
2. **The definition** — the KPI is computing something other than what the reader
   expected. Check `/kpi-dictionary`, which publishes the formula.
3. **The period** — the month is open and still moving, or a restatement created
   a new version.

It is never "the dashboard and the assistant disagree." They cannot.

---

## Refresh schedule

| What | When | Source | Owner |
|---|---|---|---|
| HubSpot deals, contacts, meetings | Nightly | HubSpot private app | Automated |
| QBO — open month | Nightly | QuickBooks Online | Automated |
| QBO — closed months | On close only | QuickBooks Online | Westport closes |
| Marketing spend | Monthly | QBO accounts, per the tagged account set | Westport |
| Headcount | Monthly | Google Sheets import, or a file handed to the assistant | ARG ops |
| Chart of accounts + Class list | Weekly | QBO Accounting API | Automated, alerts on new codes |
| Reconciliation controls | Every refresh | — | Automated |
| Standing goals | Every refresh | — | Automated |

Every refresh writes a `load_run` row. Nothing writes facts without one, so
"when did this number last change and who changed it" is always answerable.

### An open month is not a closed month

The open month refreshes nightly and every view says so — the period chip in the
global control bar, the assistant's answers, the audit pack manifest. When
Westport closes a month, that month freezes: a database trigger rejects writes
to it. A restatement creates a **new version**, it does not overwrite history.

If someone needs to correct a closed month, that is the restatement path
(`arg.allow_restatement`), not a direct write. Using the escape hatch is
deliberate and logged.

---

## When a refresh fails

**The dashboards do not silently show stale data.** The last-refresh timestamp is
on every page and the reconciliation chip goes amber or red. A stale dashboard
that looks live is worse than no dashboard.

### Triage

1. **Admin → Load history.** The failed run is at the top with its error.
2. **Admin → Reconciliation.** If controls are failing, note which. A failing
   control means figures in that area may not tie to source, and the affected
   dashboards say so.
3. Decide whether to re-run or to roll back.

### The failure modes, and what each means

| Symptom | Cause | Action |
|---|---|---|
| `Unmapped division code: <X>` | QBO has a Class the dimension doesn't know | Add it to `dim_division`, or add it as a legacy alias of an existing division. **Do not** map it to "other" — the load failing loudly is the control working. |
| `Unmapped GL account: <X>` | A new account in QBO's chart | Map it in `dim_account` to one of the five reporting lines. The weekly account sync is meant to catch this before a load does. |
| `Connector not configured` | Missing or expired credentials | Re-authorise in Admin. QBO refresh tokens rotate; an expired one needs the OAuth flow again. |
| Load stuck in `RUNNING` | Process died mid-run | The run is not committed — facts are written in one transaction. Mark it failed and re-run. |
| `division sums do not tie to ARG Total` | A division row is missing for the period | Check the load covered all four divisions. ARG Total is computed, so a missing division silently shrinks it — this control is what catches that. |
| `balance sheet does not balance` | Equity moved without a matching entry | Equity is loaded from QBO and never plugged. This is a real accounting question for Westport, not a system fault. |

### Rolling back a load

Each `load_run` is reversible. Rolling back returns the affected facts to their
prior state, writes an audit event, and re-runs the reconciliation controls.

A failed load never half-applies — it commits as one transaction or not at all.
So a rollback is for a load that *succeeded* and shouldn't have.

---

## Month-end close

The order matters, and one step is easy to skip:

1. **Lock the forecast for the month before entering actuals.** The system blocks
   actuals on an unlocked month, and that block exists because a forecast written
   after the actuals are known cannot be scored honestly. If it genuinely must be
   waived, the waiver captures a reason and is visible in the audit trail.
2. Run the final QBO pull for the month.
3. Check reconciliation — all controls green before closing.
4. Close the period (Westport or an administrator). This freezes the month.
5. Draft the close narrative on the Executive dashboard, edit, and sign.

### About the narrative

The draft quotes only figures that were resolved before the model was called, and
every figure in the returned text is checked against that list. A draft
containing a number the system did not produce — invented, re-derived, or merely
rounded — is thrown away and the system's own draft ships instead. The panel says
which one you are reading.

That means the narrative can be dull. It cannot be wrong.

---

## The assistant

Present on every page. It knows the current month, division and dashboard, so
questions don't have to restate context.

**What it can do:** answer from the metrics layer, build charts and tables, plan
and preview a data pull, report reconciliation status and load history.

**What it cannot do, structurally rather than by instruction:**

- Write to QuickBooks or HubSpot. No connector exposes a write operation.
- Run arbitrary SQL. No such tool exists.
- Compute a metric a second way. It calls the same `resolveKpi` the dashboards do.
- See a division the asking user cannot. Entitlements are applied when facts are
  loaded, so the rows were never fetched.
- Write anything without a human clicking confirm.

**If it refuses:** that is usually correct behaviour. It declines rather than
estimating. Check whether the figure genuinely exists for that period and
division — an unavailable metric returns a typed reason, and the assistant will
repeat that reason rather than guessing.

**If `ANTHROPIC_API_KEY` is unset:** every dashboard, export and control still
works. Only the conversational layer is unavailable, and it says so.

---

## Deployment

| Environment | Database | Notes |
|---|---|---|
| Local / CI | PGlite (embedded WASM Postgres) | No Docker. Same schema, same triggers, same migrations. |
| Production | Neon Postgres | Set `DATABASE_URL`. |

```bash
pnpm install
pnpm db:migrate     # applies migrations including the triggers
pnpm db:seed        # deterministic dataset reproducing the spec's tie-out figures
pnpm test           # tie-out, agent, goals, export suites
pnpm dev
pnpm verify:visual  # Playwright: every page, both themes
```

### Environment variables

Nothing is required to run locally. In production:

- `DATABASE_URL` — Neon connection string. Without it the app uses PGlite.
- `AUTH_SECRET` — **required in production**; the app refuses to start without
  it. Development falls back to a fixed value.
- `ANTHROPIC_API_KEY` — enables the assistant. Everything else works without it.
- `QBO_*`, `HUBSPOT_*`, `GOOGLE_SHEETS_*` — connector credentials. Each connector
  reports its own configured/not-configured state in Admin, and an unconfigured
  connector refuses to pretend it pulled anything.

### The seed credentials are development-only

`westport2026`, on four seeded accounts. Replace them before any real deployment.
They exist so the app is explorable on a fresh clone.

---

## Things that will look like bugs and are not

**Gross profit doesn't subtract payroll.** Payroll–Direct and Payroll Expense are
memo columns — they are already inside COGS and Operating Expense. Subtracting
them again understates gross profit. For the tie-out month that is $71,451 versus
$38,407 on one division alone. The test suite asserts both figures.

**Revenue run rate isn't this month × 12.** It is year-to-date divided by months
elapsed, times twelve. For the tie-out month the two methods differ by roughly
$900,000.

**Cycle conversion cycle has no inventory term.** ARG is a services business.
`CCC = DSO − DPO`.

**Attainment above 100% is not always green.** Direction is a property of each
metric. Above budget is good on revenue and bad on operating expense.

**A missing figure shows a reason, not $0.** Anywhere a number could be absent,
the system reports why. There is no silent zero default anywhere in the codebase,
and that is deliberate — a zero that means "no data" is how a reporting system
starts lying quietly.

**ARG Total has no stored row.** It is the sum of the four divisions, computed at
read time. A database constraint prevents an `ARG_TOTAL` row from being written
to any fact table.

---

## Deploying to Vercel

The project is a stock Next.js app; Vercel needs no build configuration. What it
does need is the environment set, because two of the three variables change
whether the app starts at all.

### Fastest path — a demo instance, no database

Useful for showing ARG the system before QuickBooks credentials exist.

| Variable | Value |
|---|---|
| `AUTH_SECRET` | output of `openssl rand -base64 48` |
| `DEMO_MODE` | `1` |

That is the whole configuration. Each instance seeds itself in memory on first
request from the same deterministic dataset the tie-out suite asserts against,
so the figures on screen are the spec's published figures. Every page carries a
banner saying the warehouse is in memory and resets on recycle.

Two consequences to expect and not mistake for faults: the first request after
an instance starts is slow (it is applying migrations and loading the seed), and
a write made in one request may not be visible to the next, because the next
request may land on a different instance.

### Real path — a provisioned database

| Variable | Value |
|---|---|
| `AUTH_SECRET` | output of `openssl rand -base64 48` |
| `DATABASE_URL` | the Neon connection string |
| `ANTHROPIC_API_KEY` | optional — enables the assistant; everything else works without it |

Do **not** set `DEMO_MODE`. `DATABASE_URL` takes precedence over it anyway, so a
real deployment cannot end up seeded by accident, but leaving it unset keeps the
intent legible.

Then, once, against that database:

```bash
DATABASE_URL=<neon-url> pnpm db:migrate
DATABASE_URL=<neon-url> pnpm db:seed     # only if you want the demo dataset
```

Skip the seed for a real deployment — the warehouse fills from the connectors.

### Before handing the URL to anyone at ARG

Replace the seeded credentials. Four accounts ship with the password
`westport2026` so a fresh clone is explorable, and they are development
credentials in the plainest sense: a deployed instance with them still in place
is open to anyone who reads this file.

### If the deployment builds but every page 500s

Almost always one of three things, in this order of likelihood:

1. `AUTH_SECRET` is unset. The app refuses to start in production without it,
   deliberately — a signing key that silently defaults is worse than a crash.
2. `DATABASE_URL` is set but unreachable, or points at a database with no
   migrations applied.
3. Neither `DATABASE_URL` nor `DEMO_MODE` is set. The app then falls back to
   PGlite against a read-only serverless filesystem and cannot write its data
   directory.

The build logs will not distinguish these; the runtime logs will.

---

## Connecting the source systems

Sources are connected from **Admin → Source connections**. Nothing is typed into
a config file and no token passes through a developer.

Before anything can be connected, set `CREDENTIAL_KEY` (`openssl rand -base64 32`).
Credentials are encrypted with AES-256-GCM before they reach the database, and
without the key the app refuses to store them rather than writing a token in the
clear — a credential that *looks* protected and is not is worse than an obviously
unprotected one, because nobody goes back to check.

### QuickBooks Online — one-click

1. Create an app at developer.intuit.com.
2. Register `https://<your-domain>/api/connect/qbo/callback` as a redirect URI.
3. Set `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET`.
4. Admin → **Connect QuickBooks Online** → authorise → done.

The company name and realm id are captured on the callback and shown on the
card, so it is visible at a glance *which* set of books is connected.

**Intuit rotates the refresh token on every use** and expires the old one. The
new value is written back automatically on each refresh. Without that the
connection works for a while and then dies quietly, which is the single most
common way a QuickBooks integration fails months after anyone touched it.

### HubSpot — one-click, or a pasted token

Either register an OAuth app (`HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET`) and
click Connect, or create a private app in HubSpot with the deals, contacts and
companies **read** scopes and paste its token. For a single portal the private
app is simpler and there is no reason to prefer OAuth.

### Google Sheets — service account

1. Create a service account in Google Cloud, enable the Sheets API, download the
   JSON key.
2. **Share the spreadsheet with the service account's email address** (Viewer).
3. Admin → **Use a service account** → paste the JSON and the spreadsheet id.

Step 2 is the one that gets forgotten. The credential is therefore verified by
actually reading the sheet before it is stored — a connection that says
"connected" and 403s at 3am is worse than one that refuses while you are looking
at it.

A service account rather than a user grant because the spreadsheet belongs to
ARG: a service account keeps working when the person who authorised it leaves.

### What disconnecting does

Removes the credential and nothing else. Figures already loaded stay — they are
ARG's history, they reconciled when they landed, and deleting closed months over
an administrative action would be indefensible. The source simply stops
refreshing, and every view already states when it last did.

### Scopes

Read scopes only. Intuit offers no read-only accounting scope, so for QuickBooks
the guarantee is held where it can be: no connector in this codebase exposes a
write method (§2 Rule 7).
