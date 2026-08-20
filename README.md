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
| Connectable sources | `CREDENTIAL_KEY`, plus each provider's client id/secret |

`DATABASE_URL` takes precedence over `DEMO_MODE`, so the same deployment starts
as a self-seeding demo and becomes real the moment a database is attached —
nothing to un-set. Migrations apply themselves on first request behind a
Postgres advisory lock, and the first visit offers a setup screen to create the
first administrator.

**Postgres specifically, not Redis.** The guarantees in the table below are
database objects — a trigger, CHECK constraints, plpgsql. A key-value store
cannot hold them, so it would not be the same system.

## Connecting QuickBooks, HubSpot and Sheets

From **Admin → Source connections**: OAuth for QuickBooks and HubSpot, a pasted
private-app token for HubSpot if you prefer, a service account for Sheets.
Credentials are AES-256-GCM encrypted before they reach the database, verified
against the provider before they are stored, and QuickBooks' rotating refresh
token is written back on every refresh — the omission that kills a QBO
integration months after anyone last looked at it.

A HubSpot token is checked **scope by scope**, against the endpoints the
connector will actually read. The obvious check — asking `/account-info` — needs
the `oauth` scope that a private app built for deals and contacts does not have,
so it answers 403 and reports a working token as rejected. A missing optional
scope is named and the connection is still made; a missing required one refuses
rather than saving a connection that half works.

Connecting is not the whole job, and **Sync now** is the other half: fetch,
land the payload verbatim, conform it to facts, run the reconciliation controls.
The Admin card reports what each entity did — rows read, rows written, closed
months left alone, controls failing. See
[`docs/DATA_INFRASTRUCTURE.md`](docs/DATA_INFRASTRUCTURE.md) for exactly which
credentials to ask ARG for, and [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for what to
do when a load stops.

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
| Every *metric* the assistant states comes from the semantic layer | No tool computes an aggregate that a KPI defines. It can list deals, GL accounts and sheet cells — records, to show its working — but there is nothing that sums a column, so a total can only come from `resolveKpi`. There is no SQL surface. |
| Sources are never written to | No connector exposes a write operation. Read-only by absence, not by a flag someone could flip. |
| It refuses rather than estimates | Metrics return a typed `Unavailable` with a reason, never null and never zero. There is nothing to guess from. |
| Generated charts equal built charts | The model emits a view spec, validated against the registry and rendered by the same component the dashboards use. It never emits numbers or markup. |
| Nothing is written without a human | Ingestion plans and previews; a click confirms; one reversible `load_run` results. |
| A user never sees another division | Entitlements are applied when facts are loaded. The rows were never fetched. |
| A load never guesses | An unmapped class, an unmapped account or unclassed dollars stop the load and are named. Nothing partial is written, and the raw payload is kept so a replay costs no API calls. |
| A closed month is never restated by a refresh | Conform skips it and says it did. Reopening is a deliberate act. |
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
lib/etl/          conform (raw → facts), sync (fetch → land → conform → reconcile), rollup
lib/recon/        the five standing controls
lib/forecast/     projection, scenarios, locking, accuracy scoring
lib/ai/           tools, view-spec compiler, goals, commentary
lib/export/       the audit pack
lib/seed/         deterministic dataset reproducing the spec's tie-out figures
app/(app)/        Executive, Finance, Sales, HubSpot Leadership, Marketing, Forecast, Admin
components/       one chart component, one tile component, the shell
docs/             DATA_INFRASTRUCTURE, RUNBOOK, OPEN_ITEMS, PHASE2_ASSESSMENT
```

## Verification

```bash
pnpm test           # tie-out, conform, agent, goals, export — 142 tests
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
