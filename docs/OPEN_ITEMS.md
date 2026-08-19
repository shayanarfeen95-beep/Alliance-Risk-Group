# Open items

Seven questions the build cannot answer for itself. Each is a Westport decision,
not a developer guess.

They are carried as **data**, not as assumptions in code: every one of them lives
in `app_config` with an `is_confirmed` flag, is visible in the app's Admin area,
and appears in the audit pack. Where an item is unconfirmed, the surfaces that
depend on it say so rather than computing on a guess.

The spec is explicit that inventing answers here is the failure mode. A CAC with
an unagreed denominator is not an approximate CAC — it is an unusable one that
looks usable.

---

## 1. Does ARG class its balance sheet in QuickBooks?

**Drives:** DSO, DPO, CCC, Cash Runway — whether they are available per division
or at ARG Total only.

**Config key:** `BALANCE_SHEET_CLASSED`

**Status:** Seeded `true` so the Finance dashboard is exercised end to end.
**Westport must confirm at kickoff.**

**If the answer is no:** those four metrics render at ARG Total only, labelled as
such on the face of the dashboard. The division rows read *"not available —
balance sheet not classed"*. They do **not** read $0. Flipping the flag is the
whole change; no code moves.

Classing the balance sheet in QBO is the recommended fix, and it is an
ARG-side task rather than a development one.

---

## 2. How is a HubSpot deal attributed to a division?

**Drives:** every Sales and Marketing metric's division breakdown.

**Config key:** `HUBSPOT_DIVISION_ATTRIBUTION` — one of `deal_property`,
`pipeline`, `owner`, `none`.

**Status:** Seeded `deal_property` so the dashboards are exercised by division.
**Westport confirms the real rule in week 1.**

**Where it is set:** Admin → HubSpot division mapping. Pick the field that
carries the division, then map each value HubSpot actually sent — shown with the
number of deals carrying it — to an ARG division. Saving re-applies the mapping
to every deal already landed, straight from the raw landing table, so a
correction never leaves the warehouse half on the old rule. A value nobody maps
stays unattributed and is counted on screen; it is never guessed into a division
and never dropped.

**If no reliable attribution exists:** set it to `none`. Sales and marketing
metrics then report at **ARG Total only** for Phase 1.

This is the item most likely to be answered with a plausible-sounding rule that
is wrong a quarter of the time. A deal attributed to the wrong division moves
revenue between two divisional P&Ls, and the error is invisible at ARG Total —
which is exactly the kind of error that survives for a year. Reporting at ARG
Total only is a real answer; inventing an attribution rule is not.

---

## 3. What is the Claims division's system of record?

**Drives:** whether Claims operational metrics are possible at all, and the
Phase 2 assessment for that division.

**Config key:** `CLAIMS_SYSTEM_OF_RECORD`

**Status:** Empty, unconfirmed. Not yet identified.

The other three divisions have identifiable operational systems (see
`PHASE2_ASSESSMENT.md`). Claims does not, and nothing in the spec names one.
Until it is identified, Claims contributes financial metrics only.

---

## 4. Which QuickBooks accounts constitute marketing spend — and which constitute sales *and* marketing?

**Drives:** Cost per Lead, ROAS, Marketing Efficiency Ratio (marketing-only set),
and Customer Acquisition Cost (the larger sales+marketing set).

**Config keys:** `MARKETING_SPEND_ACCOUNTS`, `SALES_AND_MARKETING_SPEND_ACCOUNTS`

**Status:** Both seeded with a plausible set, both **pending Westport sign-off.**

These are deliberately **two different account sets**, and conflating them is a
specific known error: CAC's numerator includes sales cost, CPL's and ROAS's do
not. A single "marketing spend" list would make one of the four metrics wrong,
and it would be wrong quietly.

**Until both are signed off**, clearing the confirmation flag withholds all four
metrics with a *"pending definition"* state. That is the correct behaviour: an
unagreed denominator makes every one of them unusable, and publishing them
anyway invites a decision to be made on a number nobody agreed to.

---

## 5. Who gets access to what?

**Status:** Roles are built. Assignment is data, not code.

Five roles ship — Admin, CFO, Executive, Division Manager, Viewer — with
per-user division entitlements. Entitlements are enforced **in the data layer**,
when facts are loaded, not in the UI. A division manager's request never fetches
the rows for another division, so there is nothing for a rendering bug to leak.
The assistant inherits the same entitlements, and the audit pack exports only
what its requester can see.

What remains is a Westport/ARG decision about who sits in which role and which
divisions each manager sees. That is administration, not development.

One consequence worth stating: a user who cannot see all four divisions cannot
see ARG Total either, because the consolidated figure would disclose the others
by subtraction.

---

## 6. General ledger at account level

**Recommendation:** yes. **Status:** built that way.

This one was decided rather than left open, because the alternative undermines a
deliverable. Without account-level GL, the close commentary can report that
operating expense rose and nothing more. With it, the commentary names the
accounts that moved — which is the question the CEO asks next, every time.

It also gives every P&L cell a drill-through to its underlying accounts.

---

## 7. Excel retirement sequencing

**Status:** Not scheduled. A Westport decision.

The recommended sequence:

1. Run both in parallel for one close. The audit pack exists for exactly this —
   hand it to whoever maintains the workbook and have them tie it out.
2. Resolve any differences. Note that **some differences are intentional**: the
   eight defects in the spec's Section 8 are fixed here, so the numbers should
   differ where a defect was corrected. Those are documented with their
   corrected values rather than reconciled away.
3. Retire the eleven dead tabs first — nothing reads them.
4. Retire the roll-up tabs once a second close has tied out.
5. Keep the workbook readable but unmaintained for a quarter.

The system is deliberately not a black box during this period: every figure
carries its formula in the KPI dictionary, and the audit pack lets a reviewer
check any number without access to the running app.

---

## How these surface in the app

- **Admin → Open decisions** lists all seven with their current value and
  confirmation state.
- Any dashboard depending on an unconfirmed item renders a *"pending
  definition"* state rather than a number.
- `08_open_items_and_config.csv` in the audit pack carries them, so a reviewer
  sees what was assumed and what was agreed.
