# Data infrastructure and credentials

**What ARG needs to provision, and what Westport needs to be given.**

Written for the 13 August punch-list item: *"Data infrastructure/architecture
document — what apps does ARG need and what credentials does Westport need to
pass along to ARG."* It is a checklist, not a design paper. Hand the relevant
section to whoever holds each system.

---

## The shape of it

```
QuickBooks Online ─┐
HubSpot ───────────┼─→  connector  →  raw_payload  →  conform  →  fact tables
Google Sheets ─────┘     (read-only)   (verbatim)     (mapped)    (the warehouse)
                                                                        │
                                              reconciliation controls ──┤
                                                                        ↓
                                                          resolveKpi — one definition
                                                                        ↓
                                            dashboards · exports · the assistant
```

Two properties of that diagram are load-bearing:

**The arrows only point one way.** No connector in this codebase has a write
method. That is not a setting — there is no code that could modify QuickBooks or
HubSpot, so no credential ARG issues can be used to change anything in them,
whatever it is scoped for.

**Everything downstream of `resolveKpi` shares one definition.** A dashboard, an
export and the assistant cannot disagree about a figure, because there is only
one function that produces figures.

---

## What ARG needs to provision

| System | What ARG needs | Who creates it | Cost |
|---|---|---|---|
| QuickBooks Online | Existing subscription; classes on every transaction | ARG's bookkeeper | Already owned |
| HubSpot | Existing portal; a Private App | ARG's HubSpot admin | Free — private apps are on every tier |
| Google Sheets | The budget/headcount workbook, shared to a service account | ARG ops | Free |
| Google Cloud project | A service account for Sheets | Westport can create this | Free |
| Postgres (Neon) | One database | Westport | Free tier is sufficient at ARG's volume |
| Vercel | Hosting | Westport | Existing |
| Anthropic API key | For the assistant only | Westport | Usage-based |

Nothing else. The four Phase 2 systems — TrackOps, ServeManager, Tazworks,
iSolved — are assessed in `PHASE2_ASSESSMENT.md` and are not connected.

---

## Credentials, one by one

### 1. QuickBooks Online

**What Westport needs from ARG:** nothing to type. One click, by someone who can
sign in to QuickBooks as an admin.

**Setup, once, by Westport:**

1. Create an app at `developer.intuit.com`.
2. Register the redirect URI: `https://<deployment>/api/connect/qbo/callback`
3. Set `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, and `QBO_ENVIRONMENT=production`.

**Then, by ARG:** Admin → Source connections → *Connect QuickBooks Online*, sign
in, approve. The company name appears on the card — check it is ARG's books and
not a test company.

**Scope requested:** `com.intuit.quickbooks.accounting`. Intuit does not publish
a read-only variant of this scope; it is read/write or nothing. The read-only
guarantee is therefore held in the code rather than in the grant, by the absence
of any write method on the connector.

**The thing that breaks QBO integrations months later:** Intuit rotates the
refresh token on every use and expires the old one, and the connection dies
silently around day 100 if the new token is not stored. This build writes it back
on every refresh — see `lib/connectors/qbo.ts`. Worth knowing because it is the
first thing to suspect if QuickBooks stops updating without anyone touching it.

**What ARG must do in QuickBooks itself:** class every transaction. A P&L with
unclassed dollars stops the load and names the amount rather than distributing
it — see *When a load stops*, below.

---

### 2. HubSpot

**What Westport needs from ARG:** one private-app token, pasted once.

**Created by ARG's HubSpot admin:**

1. Settings → Integrations → **Private Apps** → *Create a private app*.
2. Name it something like "Westport Reporting (read-only)".
3. Under **Scopes**, tick exactly these:

   | Scope | What stops working without it |
   |---|---|
   | `crm.objects.deals.read` | **Required.** Dollars Booked, Pipeline Value, Booking Rate, Average Close Time |
   | `crm.objects.contacts.read` | **Required.** New Leads, Cost per Lead, Lead-to-Customer Rate |
   | `crm.objects.owners.read` | The salesperson filter and the owner leaderboard show ids instead of names |
   | `crm.objects.meetings.read` | Meetings Completed reads as unavailable |

4. Create it, then copy the token from the **Auth** tab.

**Then:** Admin → Source connections → HubSpot → *Paste a token*.

Each scope is checked against HubSpot before anything is stored, and a missing
one is named. A token that is genuinely valid but missing an optional scope is
accepted and the limitation is stated on the card — you get a working
connection and an honest note, rather than a silent gap.

> **Note on token formats.** HubSpot issues both the older `pat-na1-…` tokens and
> a newer opaque base64 form. Both are accepted; the token is verified by using
> it, not by its shape.

**Treat the token as a password.** It grants read access to ARG's entire CRM. If
it is ever pasted into an email, a chat message, or a support ticket, rotate it
in HubSpot immediately — Private Apps → the app → Auth → *Rotate*. Rotation
invalidates the old value instantly, so a leaked token stops being useful the
moment you rotate. Then reconnect in Admin.

**Open item 2 — division attribution.** If ARG has no reliable division property
on a deal, sales and marketing metrics report at ARG Total only. That is
deliberate: an invented attribution rule moves revenue between divisional P&Ls
and nets to zero at the consolidated level, which is how that class of error
survives a year unnoticed. If such a property does exist, set
`HUBSPOT_DIVISION_PROPERTY` to its internal name and the division breakdown
turns on.

---

### 3. Google Sheets

**What Westport needs from ARG:** the spreadsheet ID, and the sheet shared with
a service account.

**Created by Westport:**

1. In Google Cloud, create a project and a **service account**.
2. Enable the **Google Sheets API** on the project.
3. Create a JSON key for the service account and download it.

**Then, by ARG:** share the budget workbook with the service account's email
address. **Viewer is enough** — do not grant edit.

**Then:** Admin → Source connections → Google Sheets → paste the JSON key and the
spreadsheet ID. The credential is verified by actually opening the sheet, so a
forgotten share fails here, on screen, rather than at 3am.

**Why a service account rather than a Google login:** a user grant breaks when
that person leaves ARG. A service account does not.

**Tab names:** the ranges are configurable — `SHEETS_RANGE_MONTHLY_BUDGET`,
`SHEETS_RANGE_TENX_BUDGET`, `SHEETS_RANGE_HEADCOUNT` — so renaming a tab is a
settings change, not a deploy.

---

### 4. Composio — an alternative to 1 and 2

Composio hosts the OAuth dance for QuickBooks and HubSpot. Set
`COMPOSIO_API_KEY` plus an auth-config id per toolkit, and a **Connect with
Composio** button appears on those two cards. Connecting QuickBooks then costs
one click instead of registering an app at developer.intuit.com — which is the
only real friction in the direct path.

Its toolkits cover every entity this system reads, verified rather than assumed:
`QUICKBOOKS_GET_PROFIT_AND_LOSS_REPORT` takes `summarize_column_by: "Classes"`
and `accounting_method: "Accrual"`, which is exactly the call the direct
connector makes, and `HUBSPOT_LIST_DEALS` takes `propertiesWithHistory`, which
is what the deal funnel needs.

**Two costs, both ARG's to weigh rather than ours:**

1. **The connection is write-capable.** `HUBSPOT_UPDATE_DEALS` sits in the same
   toolkit. This codebase never names a write slug — Rule 7 holds the way it
   holds everywhere else, by there being no code that could call one, and a
   test asserts it — but the credential at Composio's end could. A direct
   HubSpot private-app token ticked for four read scopes *cannot*, and that is
   a stronger promise.
2. **ARG's financial data passes through a third party.** A decision for ARG
   and Westport, not a default.

**The recommendation:** connect HubSpot directly — a private-app token is
already a paste, so Composio saves nothing there and costs the read-only
guarantee. Use Composio for QuickBooks if nobody wants to register an Intuit
app. Both can be true at once; the choice is stored per source, and the conform
layer, the reconciliation controls and every KPI are identical either way.

---

## Environment variables

Grouped by what stops working without each.

| Variable | Without it |
|---|---|
| `DATABASE_URL` | Runs on embedded PGlite, or in demo mode. No persistence. |
| `AUTH_SECRET` | Sessions cannot be signed. Required. |
| `CREDENTIAL_KEY` | **No source can be connected at all.** Credentials are AES-256-GCM encrypted before they reach the database, and the app refuses to store one in the clear. Generate: `openssl rand -base64 32` |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` | The QuickBooks *Connect* button cannot start. |
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` | Only the pasted-token path is available — which is the simpler one for a single portal, so this is optional. |
| `HUBSPOT_DIVISION_PROPERTY` | Sales and marketing report at ARG Total only (open item 2). |
| `ANTHROPIC_API_KEY` | Dashboards, exports and controls all work; only the assistant's conversation is unavailable, and it says so. |
| `CRON_SECRET` | The nightly refresh is **disabled** rather than left open to the internet. |
| `OAUTH_REDIRECT_BASE` | Only needed behind a proxy or custom domain the request does not reveal. |

---

## The database — and Firebase

**Today: PostgreSQL.** Neon on the free tier is sufficient at ARG's volume; the
whole warehouse is a few hundred thousand rows.

**This is not an arbitrary choice, and it is worth understanding before
switching.** Four of the guarantees this system makes are enforced by the
database itself, not by application code:

| Guarantee | Enforced by |
|---|---|
| A locked forecast can never be edited or deleted | A plpgsql trigger that raises on UPDATE and DELETE |
| ARG Total can never be stored as a row, so it cannot drift from its parts | A CHECK constraint on every fact table |
| A fact cannot reference a period or division that does not exist | Foreign keys |
| Two concurrent cold starts cannot both run the migrations | A Postgres advisory lock |

Those are guarantees rather than intentions precisely because no application
bug, no rushed patch and no future developer can bypass them.

**On moving to Firebase.** Firestore is a document store. It has no triggers of
this kind, no CHECK constraints, no foreign keys, and no advisory locks. Each of
the four guarantees above would have to be reimplemented as application code —
which means each becomes a thing that holds until someone writes a code path
that forgets it. The forecast-lock guarantee is the one that matters most: §10.3
treats a locked forecast as an accountability record, and "the UI does not offer
an edit button" is a materially weaker promise than "the database refuses the
write."

If the client wants Firebase for other reasons — an existing contract, a mobile
app, a team that already knows it — that is a legitimate decision and the
migration is not especially hard: the schema is small and the data layer is
behind Drizzle. **Our recommendation is to keep Postgres**, and if Firebase is
required, to use it for auth and any mobile surface while leaving the financial
warehouse in Postgres. That is a common and comfortable split, and it costs
nothing to keep both.

Nothing about the current build blocks the switch. It can be made after the
client approves, without redoing the work above.

---

## When a load stops

A load that stops has found something nobody has decided yet. It is not a bug,
and the fix is nearly always a mapping. Nothing partial is ever written — the
warehouse is exactly as it was.

| What it says | What to do |
|---|---|
| *QuickBooks class "X" is not mapped to a division* | Add the class id to that division's `qbo_class_ids` in Admin |
| *Account "X" is not in the chart of accounts* | Pull the Chart of Accounts entity, then give the account a reporting line |
| *$N on transactions with no class* | Class those transactions in QuickBooks. They are neither dropped nor assigned |
| *HubSpot `<property>` = "X" matches no division* | Fix the value in HubSpot, or add it to that division's legacy codes |
| *The report came back with no class columns* | ARG does not class this report in QuickBooks — open item 1 |

Raw payloads are retained under the load run, so once the mapping exists the load
replays without calling the provider again.

---

## Refresh cadence

| What | When |
|---|---|
| Everything connected, open months | Nightly at 06:00 UTC, via `/api/cron/refresh` |
| On demand, three months | Admin → *Sync now* |
| On demand, thirteen months | Admin → *Backfill 13 months*, walked in six-month windows |
| Anything, any window | Ask the assistant — it previews, and a human confirms |

Closed months are never touched by any of these. Reopening a month is a
deliberate act with an audit record.

---

## Access

Roles are `ADMIN`, `CFO`, `CEO`, `DIVISION_MANAGER` and `VIEWER`. Division
managers see their own divisions only, and this is applied when facts are
loaded — the rows for other divisions are never fetched, so no view, export or
assistant answer can leak one.

Connecting a source and running a sync require ADMIN or CFO.
