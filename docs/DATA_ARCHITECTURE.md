# Data infrastructure — what ARG needs, and what Westport hands over

The 13 Aug next-steps list asks for one document: *what apps does ARG need, and
what credentials does Westport need to pass along to ARG*. This is that
document. It is written to be actioned by whoever administers each system, not
read by a developer.

Nothing here is aspirational. Every credential listed is one the running
application reads today, under the exact environment-variable name it expects.

---

## The shape of it

```
QuickBooks Online ─┐
HubSpot ───────────┼──►  land raw  ──►  conform  ──►  warehouse  ──►  one resolver  ──►  dashboards
Google Sheets ─────┘     (raw_payload)   (facts)      (Postgres)      (resolveKpi)      exports
                                                                                        the assistant
```

Two properties of that diagram matter more than the boxes:

- **Every number on every surface comes out of `resolveKpi`.** Dashboards,
  exports and the assistant all call it. There is no second path, so the
  assistant cannot quote a figure the dashboard disagrees with.
- **Raw is kept.** Conform reads from the landing table, never from the API. A
  mapping corrected in week 6 re-attributes every deal already pulled without
  asking HubSpot for anything.

---

## 1. The database

**What it is:** one PostgreSQL database. Neon is the recommended host — it is
what the deployment configuration assumes and it costs nothing at this volume.

**Who creates it:** Westport, from a Neon account ARG can later be made owner of.

**What ARG receives:** nothing to install. A connection string is set in Vercel
and never leaves it.

| Variable | Value | Where it goes |
|---|---|---|
| `DATABASE_URL` | Neon **pooled** connection string | Vercel → Settings → Environment Variables |

Set it and the app stops being a demo and becomes a real deployment on the next
request: migrations apply themselves behind an advisory lock, and the first
visit offers a screen to create the first administrator.

### On Firebase

Firestore would not be a drop-in swap, and the reason is worth stating once so
the decision is made deliberately rather than discovered halfway.

Four of this system's guarantees are **database objects**, not application code:

- a trigger that refuses `UPDATE` and `DELETE` on a locked forecast;
- `CHECK` constraints that make an `ARG_TOTAL` row impossible to store, so the
  consolidated figure can only ever be the sum of the four divisions;
- foreign keys that stop a fact row referencing a division that does not exist;
- transactional multi-table writes, so a load either lands completely or not at
  all.

Firestore has none of those. Reproducing them means moving each into application
code, where the guarantee becomes "every future code path remembers", which is
exactly the class of promise this build was structured to avoid. The forecast
lock in particular is the one Westport signs against.

**Recommendation:** stay on Postgres. If the client's interest in Firebase is
about auth or hosting rather than the database, both can be adopted without
touching the warehouse — Firebase Auth can mint the session this app already
uses, and that is a small, contained change.

---

## 2. QuickBooks Online

**What ARG needs:** QuickBooks Online, classed by division. Already in place.

**Access model:** OAuth. There is no paste-a-token path, because Intuit access
tokens last one hour — a pasted one is dead before the first overnight refresh.
The refresh token also **rotates on every use**, and this application writes the
new one back each time; that omission is what kills most QuickBooks integrations
three months in.

**Who does what:**

| Step | Who | Detail |
|---|---|---|
| Create the Intuit app | Westport | developer.intuit.com → new app → scope `com.intuit.quickbooks.accounting` |
| Add the redirect URI | Westport | `https://<deployment>/api/connect/qbo/callback` — must match exactly |
| Authorise the app against ARG's company | **ARG** | Admin → Source connections → Connect. An ARG QuickBooks admin has to be the one who clicks it; Westport cannot authorise access to books it does not own. |

| Variable | Purpose |
|---|---|
| `QBO_CLIENT_ID` | Identifies the Intuit app |
| `QBO_CLIENT_SECRET` | Signs the token exchange |

**One decision ARG must make:** whether the balance sheet is classed by
division in QuickBooks. If it is not, DSO, DPO, CCC and Cash Runway are
available at ARG Total only, and the division rows say so on the face of the
dashboard rather than showing zero. Classing it in QBO is an ARG-side task and
the better fix.

---

## 3. HubSpot

**What ARG needs:** HubSpot with deals, contacts and meetings maintained. Already
in place.

**Access model:** a **private-app token** is the recommended route for a single
portal — one paste, no round trip, and the token does not expire.

**Who does what:**

| Step | Who | Detail |
|---|---|---|
| Create the private app | **ARG** | HubSpot → Settings → Integrations → Private Apps → Create |
| Grant scopes | ARG | `crm.objects.deals.read`, `crm.objects.contacts.read`, `crm.objects.meetings.read`. Read-only throughout — the token this system holds *cannot* write. |
| Paste the token | Either | Admin → Source connections → HubSpot → Use a private-app token |

**Two things that look like failures and are not:**

- A private-app token starts `pat-`. A value starting `Ci…` is an **OAuth access
  token**, which HubSpot expires after about thirty minutes. Pasting one
  produces a connection that works while you test it and is dead by morning. The
  app now says so when it sees one.
- `account-info.security.read` is **not** required. It only supplies the portal
  name shown on the card. The connection is verified by reading one deal —
  the same call the connector makes — so a token scoped for the actual work is
  never refused for lacking a cosmetic scope.

**The decision ARG must make:** how a deal is attributed to a division — a deal
property, the pipeline, or the owner. Set it in Admin → HubSpot division
mapping, where each value HubSpot actually sends is listed with the number of
deals carrying it. Anything unmapped stays unattributed and is counted on
screen; it is never guessed into a division. If no reliable rule exists, `none`
is a real answer and sales and marketing then report at ARG Total only.

---

## 4. Google Sheets

**What ARG needs:** the budget and headcount workbooks, wherever they live now.

**Access model:** a **service account** with Viewer access, rather than a
personal Google grant — so the connection keeps working when the person who set
it up leaves.

| Step | Who | Detail |
|---|---|---|
| Create the service account | Westport | Google Cloud → IAM → Service Accounts → new key (JSON) |
| Enable the Sheets API | Westport | Same project |
| Share each workbook with the service-account address | **ARG** | Viewer is enough |
| Paste the key file | Either | Admin → Source connections → Google Sheets |

---

## 5. Pulling data

Two ways to start a load, one way for a load to happen.

- **Admin → Source connections → Pull**, per entity. The click is the
  confirmation.
- **Ask the assistant.** It proposes; a confirm control appears; you decide.

Both go through the same path: land the raw payload, conform it into facts,
record the provenance, then run the five standing reconciliation controls and
report what they said. The assistant is optional — a deployment with no
`ANTHROPIC_API_KEY` still imports data.

---

## 6. The assistant

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | The conversational layer. Without it every dashboard, export and control still works and the assistant says it is unavailable. |

---

## 7. Application secrets

| Variable | Purpose | How to generate |
|---|---|---|
| `AUTH_SECRET` | Signs session cookies. **Required in production** — the app refuses to start without it. | `openssl rand -base64 48` |
| `CREDENTIAL_KEY` | AES-256-GCM key that encrypts every source credential before it reaches the database. **Connecting any source is refused until this is set** — a token that looks encrypted and is not is worse than an obvious plaintext one. | `openssl rand -base64 32` |

Admin → Source connections shows, per source, exactly which of these are present
in the running deployment. It reports presence only, never values.

---

## The complete list, in the order to set it

```
AUTH_SECRET          # required in production
CREDENTIAL_KEY       # required before any source can be connected
DATABASE_URL         # Neon pooled connection string
ANTHROPIC_API_KEY    # the assistant
QBO_CLIENT_ID        # QuickBooks OAuth
QBO_CLIENT_SECRET
```

HubSpot and Google Sheets need no environment variables at all when connected by
token or service account — those credentials are stored encrypted in the
database, where an administrator can change them without a redeploy.

---

## Who does what, in one line each

| Capability | Westport (super admin) | ARG administrator | Delegable |
|---|---|---|---|
| Connections and mappings | yes | mappings only | mappings |
| Lend access to somebody | yes | no | never |
| Manage ARG's people | yes | yes | yes |
| Pull data, close a period, lock a forecast | yes | yes | yes |

A grant is temporary by design: it carries a reason and usually an end date, and
it expires without anybody having to remember. Lending is not itself lendable.

---

## Who has to be in the room

Two steps genuinely cannot be done by Westport alone, and both are quick:

1. **An ARG QuickBooks administrator** clicks Connect and authorises the Intuit
   app against ARG's company file.
2. **An ARG HubSpot administrator** creates the private app, grants the three
   read scopes, and hands over the token once.

Everything else — the database, the deployment, the secrets, the mappings — is
Westport-side.

---

## Phase 2 systems

TrackOps, ServeManager, Tazworks and iSolved are assessed but not built; see
[`PHASE2_ASSESSMENT.md`](PHASE2_ASSESSMENT.md). Nothing about adding them moves
the architecture above: an operational metric enters the registry exactly the
way a financial one does, so each is a connector plus registry entries rather
than a rebuild.
