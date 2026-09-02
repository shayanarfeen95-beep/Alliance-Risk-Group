# Alliance Risk Group — financial reporting platform

An AI-driven FP&A system replacing a hand-maintained 35-tab Excel workbook.
Built to `ARG_Developer_Build_Spec_v1.pdf` (Westport Financial).

ARG's analytics were already good. What made them late was the typing: someone
exported QuickBooks each month, keyed the numbers into a data tab, and everything
downstream recalculated — two to three weeks after close. This moves that logic
into a system that refreshes itself, and puts an agent on top of it.

```bash
pnpm install
pnpm db:migrate && pnpm db:seed     # PGlite — no Docker, no Postgres server
pnpm test
pnpm dev                            # http://localhost:3000
```

Sign in as `cfo@westportfinancial.com` / `westport2026` (development only).

## Deploying

Three env vars, in increasing order of seriousness:

| Want | Set |
|---|---|
| A live demo, no database | `DEMO_MODE=1` (already in `vercel.json`) |
| A real deployment | `DATABASE_URL` — a Neon pooled connection string |
| Connectable sources | `COMPOSIO_API_KEY` — and nothing else |

`DATABASE_URL` takes precedence over `DEMO_MODE`, so the same deployment starts
as a self-seeding demo and becomes real the moment a database is attached —
nothing to un-set. Migrations apply themselves on first request behind a
Postgres advisory lock, and the first visit offers a setup screen to create the
first administrator.

**Postgres specifically, not Redis.** The guarantees in the table below are
database objects — a trigger, CHECK constraints, plpgsql. A key-value store
cannot hold them, so it would not be the same system.

## Connecting QuickBooks, HubSpot and Sheets

Set `COMPOSIO_API_KEY`, then go to **Admin → Source connections** and press *Sign
in with QuickBooks*. That is the whole procedure. There is no Intuit developer
app to register, no HubSpot private app to create, no Google service-account key
file to download and share a spreadsheet with.

Composio holds the OAuth applications and the tokens. What this system stores is
a connection identifier that opens nothing on its own, and every request to
QuickBooks and HubSpot goes through Composio's proxy, which attaches the
credential server-side. No provider token exists in this process to be logged,
cached or leaked — and `CREDENTIAL_KEY` is not needed, because there is no secret
here to encrypt.

Google grants access to an *account*, not to a document, so a signed-in Sheets
connection asks once for the spreadsheet's link. That is a document identifier,
not a credential, and it is verified by actually reading the sheet before it is
saved.

Without `COMPOSIO_API_KEY` the older path still works — your own OAuth
applications, a pasted HubSpot private-app token, a Google service account, and
`CREDENTIAL_KEY` to encrypt them at rest. QuickBooks' rotating refresh token is
written back on every refresh there, which is the omission that kills a QBO
integration months after anyone last looked at it. See
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

**Connecting is not the same as loading.** A source supplies nothing until a pull
runs. **Admin → Data → Pull everything** fetches the last three months from every
connected source and writes it into the warehouse: QuickBooks into the profit and
loss, balance sheet and chart of accounts, HubSpot into deals, contacts and
meetings, Sheets into budget and headcount. Closed months are left untouched and
the reconciliation controls run immediately afterwards.

You can also ask the assistant to pull a specific month and confirm it. Both go
through the same code in `lib/etl/ingest.ts` and produce the same reversible
`load_run` — there is no second, weaker ingestion path.

## Demonstration data, and switching to live

The warehouse ships seeded so every dashboard, control and export can be
exercised before a source is connected. That is useful and dangerous in equal
measure: a plausible number does not announce itself as fabricated.

So the state is explicit, shown as a banner on every page, and switching is one
control in **Admin → Data**:

| Mode | What the dashboards read |
|---|---|
| `DEMONSTRATION` (default) | The seeded dataset, with a banner on every page saying so |
| `LIVE` | Only rows a source loaded. A month nothing has loaded reads *unavailable*, never zero |

Live is a filter, not a deletion — switching back is a click and nothing is
destroyed by a misclick. It is applied in `loadFactBundle`, the single point
where facts enter the system, so a view cannot forget it. Deleting the seeded
rows for good is offered separately, because *hidden* and *gone* are different
promises and the operator should choose which one they are making.

---

## The decision everything else follows from

**Every number comes from one function.** `resolveKpi`, in `lib/semantic/`.
Dashboards call it. Exports call it. The assistant's tools call it. There is no
second path — no raw-SQL tool, no export-time recalculation, no widget that works
out its own figure.

The spec puts the reason plainly: *"If a KPI is coded inside a dashboard widget,
the AI assistant will eventually compute it a second, slightly different way —
and ARG's CEO will see two numbers for the same metric in the same week."*

So the assistant cannot disagree with a dashboard. Not because it is instructed
not to — because there is no mechanism by which it could.

## What that buys, structurally

| Guarantee | How it holds |
|---|---|
| The assistant answers only from the semantic layer | It has no other tool. There is no SQL surface and no free-text number path. |
| Sources are never written to | No connector exposes a write operation. Read-only by absence, not by a flag someone could flip. |
| It refuses rather than estimates | Metrics return a typed `Unavailable` with a reason, never null and never zero. There is nothing to guess from. |
| Generated charts equal built charts | The model emits a view spec, validated against the registry and rendered by the same component the dashboards use. It never emits numbers or markup. |
| Nothing is written without a human | Ingestion plans and previews; a click confirms; one reversible `load_run` results. |
| A user never sees another division | Entitlements are applied when facts are loaded. The rows were never fetched. |
| Close commentary cannot contain a wrong figure | Every figure is resolved before the model is called, and the draft is verified against that list. A draft with an unsourced number is discarded for a deterministic one. |
| ARG Total cannot drift | It is computed as the sum of four divisions. A database constraint prevents an `ARG_TOTAL` row from ever being stored. |
| A locked forecast cannot be edited | A Postgres trigger raises on UPDATE and DELETE. Not a UI check. |

## The agent

Present on every page, already knowing the month, division, dashboard and the
reader's entitlements. Three things it does:

**Go get it.** *"Pull March out of QuickBooks and show me where Claims lost
money."* It picks the source and window, previews what it will pull, waits for
one confirm click, runs the reconciliation controls afterwards, and reports what
they said. On an unmapped division or account it stops and asks — it never
defaults to "other".

**Show me.** It emits a validated view spec, not chart code and not numbers. Every
filter in the spec is available on the generated view, which is pinnable and
shareable by URL and carries the same basis label, period chip and drill-through
as a built dashboard.

**Watch this for me.** Named standing goals evaluate on every refresh — in
TypeScript, against `resolveKpi`, not by re-reading an instruction string each
night. An exception that lands on the CEO's dashboard has to fire for the same
reason every time.

Without `OPENROUTER_API_KEY`, every dashboard, export and control still works.
Only the conversational layer is unavailable, and it says so.

## Layout

```
lib/semantic/     the KPI registry, period conventions, resolver — the heart
lib/db/           schema, migrations, the three DB-level guards
lib/connectors/   QBO, HubSpot, Sheets. Read-only adapters
lib/etl/          conform, rollup, load provenance
lib/recon/        the five standing controls
lib/forecast/     projection, scenarios, locking, accuracy scoring
lib/ai/           tools, view-spec compiler, goals, commentary
lib/export/       the audit pack
lib/seed/         deterministic dataset reproducing the spec's tie-out figures
app/(app)/        Executive, Finance, Sales, Marketing, Forecast, Admin
components/       one chart component, one tile component, the shell
docs/             RUNBOOK, OPEN_ITEMS, PHASE2_ASSESSMENT
```

## Verification

```bash
pnpm test           # tie-out, agent, goals, export — 109 tests
pnpm verify:visual  # every page, both themes, checks overflow and console errors
```

The tie-out suite asserts every published figure in §13.1 to the dollar, per
division and at ARG Total, and it asserts the **wrong** answers too:

- SHRC gross profit is **$71,451**, not $38,407 — the payroll memo double-count.
- ARG Total revenue run rate is **~$5,640,939**, not $6,538,128 — single-month
  annualisation.

Both wrong answers are plausible, both are what the Excel would give under a
common mistake, and both are asserted against by name.

## Open items

Seven questions this build cannot answer for itself — balance-sheet classing,
HubSpot division attribution, the marketing account sets, and four others. They
are carried as **data** with a confirmation flag, visible in Admin and in the
audit pack. Where one is unconfirmed, the dependent metrics render *"pending
definition"* rather than computing on a guess. See [`docs/OPEN_ITEMS.md`](docs/OPEN_ITEMS.md).

The one worth knowing up front: **if no reliable HubSpot division attribution
exists, sales and marketing metrics report at ARG Total only.** An invented
attribution rule moves revenue between divisional P&Ls and is invisible at ARG
Total, which is how that kind of error survives a year.

## Not built

TrackOps, ServeManager, Tazworks and iSolved integrations are **assessed, not
built** ([`docs/PHASE2_ASSESSMENT.md`](docs/PHASE2_ASSESSMENT.md)), along with the
operational metrics that depend on them. Customer Onboarding Time is deferred
with an explicit unavailable state rather than a proxy. QuickBooks and HubSpot
are never written to.
