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
integration months after anyone last looked at it. See
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

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

## Filters

The bar at the top sets the reporting month, the division and a date range for
the whole page — §7's single global parameter, which everything else hangs off.

Every box also has its own. The small control in a tile, chart or table's
top-right corner scopes **that box alone** to another division or month, which is
what reading a dashboard actually requires: this tile for LITS beside that one
for SHRC, this month's cash beside last month's. A box that has been moved says
so on its face and clears in one click, and all of it lives in the URL, so an
arrangement of twelve boxes on six divisions is a link you can send.

Entitlements are applied once, when the page context is built. An override
naming a division the reader may not see is dropped and the box falls back to
the page filter — a hand-edited URL cannot widen what anyone can look at.

## The agent

Present on every page, already knowing the month, division, dashboard and the
reader's entitlements. The conversation persists across navigation, because
moving between dashboards is most of what anyone does here. Five things it
does:

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

**Build it onto the dashboard.** *"Put cash runway for Claims on the executive
page."* It saves a specification — never numbers, never markup — pinned to that
dashboard for that reader, rendered by the same components and carrying the same
per-box filter as everything else. Still there tomorrow; removable in one click.

**Map the source.** *"Deals tagged 'Litigation Support' are LITS."* It reads the
values HubSpot actually sent with their deal counts, proposes the mapping, and
waits for a click. Applying it re-attributes every deal already landed. It will
not propose a mapping because a value resembles a division name — that is the
error the whole open-items apparatus exists to prevent.

It also guides. For "how do I", "where is" or "why is this blank" it reads the
app's current state — what is connected, what is unconfirmed, what this reader
is permitted to do — rather than describing the app from memory.

Without `ANTHROPIC_API_KEY`, every dashboard, export and control still works.
Only the conversational layer is unavailable, and it says so.

## Layout

```
lib/semantic/     the KPI registry, period conventions, resolver — the heart
lib/db/           schema, migrations, the three DB-level guards
lib/connectors/   QBO, HubSpot, Sheets. Read-only adapters, and the division mapping
lib/etl/          conform (QBO, HubSpot, Sheets raw -> facts), rollup, provenance
lib/recon/        the five standing controls
lib/forecast/     projection, scenarios, locking, accuracy scoring
lib/ai/           tools, view specs, pinned boxes, goals, commentary, the guide
lib/export/       the audit pack
lib/seed/         deterministic dataset reproducing the spec's tie-out figures
app/(app)/        Executive, Finance, Sales, Pipeline, Marketing, Forecast, Admin
components/       one chart component, one tile component, the shell
docs/             RUNBOOK, OPEN_ITEMS, PHASE2_ASSESSMENT
```

## Verification

```bash
pnpm test           # tie-out, agent, boxes, connectors, access, goals, export — 157 tests
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
