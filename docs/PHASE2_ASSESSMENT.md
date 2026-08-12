# Phase 2 assessment — operational systems

Four systems, each with a green / yellow / red recommendation: integrate now in
Phase 2, integrate with workarounds, or defer until the vendor adds support.

**This is an assessment, not an integration.** Nothing here is built. §15.1 puts
these explicitly out of Phase 1 scope, and the operational metrics that depend on
them — turnaround time, SLA %, throughput, backlog, utilization by division —
are correspondingly absent from the dashboards rather than approximated.

One thing has already been done for them: the KPI framework treats every metric
identically, so an operational metric drops into the registry the same way a
financial one does. Adding TAT is a connector plus a registry entry. It is not a
rebuild, and nothing in the Phase 1 architecture has to move.

| System | Division | Access path | Recommendation |
|---|---|---|---|
| TrackOps | TP | REST API, confirmed available | 🟢 **Green** — integrate in Phase 2 |
| ServeManager | LITS | REST API, available | 🟢 **Green** — integrate in Phase 2 |
| Tazworks | SHRC | TazAPI only, no Zapier | 🟡 **Yellow** — integrate with a staging layer |
| iSolved | All | API access historically limited | 🔴 **Red** for API; 🟢 green for the monthly export that is already the plan |

---

## TrackOps (Trial Prep) — 🟢 Green

**Recommendation: integrate first.** It is the cleanest path of the four and the
division it covers has the most operationally interesting metrics.

**Authentication.** REST API with token authentication. Needs an API credential
issued from ARG's TrackOps account, stored the same way the QBO and HubSpot
credentials are — in environment configuration, never in the database, never in
the repository. The existing connector interface takes it without modification.

**Objects needed.**

| Metric | Objects | Notes |
|---|---|---|
| Turnaround time | Job/order with created and completed timestamps | Needs a defined start event. "Created" and "assigned" are not the same clock, and the difference is the whole metric. **Westport and TP operations must agree which one starts it.** |
| SLA % | Job, its due date, its completion date | Requires the SLA target to be present on the record or derivable from job type. If it lives in someone's head, this metric is not available. |
| Throughput | Jobs completed per period | Straightforward. |
| Backlog | Open jobs at period end | Needs a point-in-time snapshot, or a status-history object to reconstruct one. Reconstructing from current state gives you today's backlog for every month, which is worse than no backlog metric. **Confirm history is available before committing to this one.** |

**Extraction.** Nightly, same cadence and same `load_run` provenance as HubSpot.
Incremental by modified-date if the API supports it; a full pull of the open
period otherwise. Volume is small.

**Estimated setup:** 20–28 hours. Connector, conform-to-division mapping,
four metric definitions, tie-out tests against a known month, dashboard section.

**Estimated ongoing cost:** none beyond the existing TrackOps subscription.

**The risk worth naming:** backlog and SLA both depend on data ARG may not
currently capture consistently. That is discoverable in an afternoon and should
be checked before the work is scheduled, not during it.

---

## ServeManager (Litigation Support) — 🟢 Green

**Recommendation: integrate alongside TrackOps.** Same shape of work, and doing
the two together is cheaper than doing them apart — the operational metric
definitions are shared, only the connectors differ.

**Authentication.** REST API. ServeManager issues an API key per account.

**Objects needed.** Same four metrics, same objects: jobs with created,
attempted, served and completed timestamps. Service-of-process work has a
richer event trail than most, which makes turnaround time genuinely meaningful
here — attempts are recorded, so "time to serve" can be separated from "time to
first attempt".

**Extraction.** Nightly, incremental by modified-date.

**Estimated setup:** 16–22 hours if it follows TrackOps, because the metric
definitions already exist by then. 24–30 hours if it goes first.

**Estimated ongoing cost:** none beyond the existing subscription.

**Worth noting:** ServeManager and TrackOps will not define "completed"
identically. Two divisions reporting a metric called "turnaround time" that
measures two different things is precisely the failure the semantic layer exists
to prevent. Either define one shared event mapping across both systems, or give
the metrics different names. **Do not** let them share a name and a dashboard
row without sharing a definition.

---

## Tazworks (Background Screening) — 🟡 Yellow

**Recommendation: integrate, but budget for a staging layer.**

**Access.** TazAPI is the only path — there is no Zapier connector and no
alternative export. That is workable but it means every integration concern
lands on one interface with no fallback.

**Why yellow rather than green.** Three reasons, in order of how much they cost:

1. **No fallback.** If TazAPI is unavailable or rate-limited, there is no manual
   export to fall back on. A nightly refresh that can fail with no alternative
   needs to fail *visibly*, which the existing load-run and reconciliation
   machinery already handles — but it will fail more often than the REST APIs.
2. **Rate limits and pagination are undocumented in what we have seen.** A
   staging layer that pulls on its own schedule and holds raw responses
   decouples the dashboard refresh from the API's behaviour. The warehouse
   already lands raw payloads (`raw_payload`) before conforming, so this is an
   extension of an existing pattern rather than a new one.
3. **Screening data is personal data.** Background screening records carry
   PII of a kind the rest of this system does not touch. The integration should
   pull **aggregates and status counts, not subject records** — the metrics
   (turnaround, throughput, backlog) do not require individual-level data, and
   pulling it anyway creates an obligation nobody asked for. This is worth
   deciding deliberately before the connector is written, because it is much
   harder to unpull data than not to pull it.

**Estimated setup:** 30–40 hours including the staging layer. The range is wide
because it depends on what TazAPI's pagination and rate limits turn out to be,
which cannot be established from documentation alone.

**Estimated ongoing cost:** none beyond the existing subscription, assuming no
per-call pricing.

**Recommended first step:** a two-hour spike against a sandbox credential to
establish rate limits, pagination, and whether aggregate endpoints exist. That
spike converts this from a range to an estimate.

---

## iSolved (all divisions, headcount and payroll) — 🔴 Red for API, 🟢 Green for the existing plan

**Recommendation: do not pursue API integration. Keep the monthly export.**

This one splits, and the split matters.

**The API is red.** iSolved API access has historically been limited, and the
spec says so directly. Pursuing it means vendor negotiation with an uncertain
outcome, for data that arrives perfectly well by another route. That is the
definition of work that should wait until the vendor changes something.

**The monthly export is green, and it is already the Phase 1 plan.** Headcount
arrives as a monthly upload — via the Google Sheets importer, or by handing a
file to the assistant, which maps the columns against `dim_division`, shows a
diff, and commits only after confirmation. Nobody types it.

**Is Revenue per Employee feasible on a monthly manual basis?** Yes, and it is
already built and live. The metric is monthly by nature; a monthly input is not a
compromise for it. The one caveat is that headcount is a point-in-time figure
while revenue is a period figure, so a division that hires mid-month shows a
slightly pessimistic ratio. That is a definitional footnote, not a data problem,
and it is published in the KPI dictionary.

**What else becomes possible with monthly HR data:**

| Metric | Feasible monthly? | Notes |
|---|---|---|
| Revenue per employee | ✅ Built | Live today. |
| Gross profit per employee | ✅ Easy | Registry entry only, no new data. |
| Payroll as % of revenue | ✅ Already available | Comes from QBO, not iSolved. |
| Headcount trend by division | ✅ Easy | Needs no new data, only a chart. |
| Cost per employee | ✅ With payroll detail | Needs the payroll export, not just the headcount. |
| Utilization | ❌ No | Needs hours worked against hours billable — that is the operational systems, not HR. |
| Turnover / retention | ⚠️ Only with joiners and leavers | A headcount total cannot distinguish a stable team from complete turnover. If ARG wants this, the monthly export needs two more columns. Cheap to add at source, impossible to derive after the fact. |

**Estimated setup:** 0 hours for what exists. 4–6 hours to add joiners/leavers
columns and the two retention metrics, **if** ARG can produce them in the export.

**Estimated ongoing cost:** none.

---

## Sequencing, if all of it is approved

1. **TrackOps and ServeManager together.** Shared metric definitions, two
   connectors. This is where the operational library actually gets built, and
   doing them as one piece of work is materially cheaper than as two.
2. **The Tazworks spike.** Two hours, before committing to the estimate.
3. **Tazworks with its staging layer**, if the spike comes back clean.
4. **iSolved: nothing.** Add the two export columns if retention metrics are
   wanted. Revisit the API only if the vendor announces something.

## What is deliberately still absent after all of this

**Customer Onboarding Time** stays deferred until the operational system for the
relevant division is live. §6 is explicit: defer it, **do not substitute a
proxy**. Close-date-to-first-invoice is not onboarding time; it is a different
thing wearing the same label, and once it is on a dashboard nobody will remember
the difference.

The Claims division has no identified system of record (open item 3), so it
contributes financial metrics only regardless of which of the above are built.
