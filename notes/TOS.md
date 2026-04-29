# Terms of Use — Plan & Implementation Notes

This document captures the planned Terms of Use ("TOS") flow for the app, the full TOS text to be displayed, the click-to-agree mechanics, and related obligations (data attribution).

> **Disclaimer:** This is not legal advice. The text below is a reasonable starting point for a non-commercial hobby project hosted in British Columbia, Canada. If the project ever becomes commercial, collects user data, or starts seeing real traffic, have a lawyer review it.

---

## 1. Overview of the flow

- On first visit, the app shows a **modal popup** containing the Terms of Use.
- The modal **blocks the app** behind it — the user cannot interact with the map or any controls until they agree. (This is what legally makes it a "clickwrap" rather than a dismissible notice.)
- The user clicks a single button: **"I have read and agree to the Terms of Use"**.
- Acceptance is recorded in `localStorage` under a versioned key (e.g. `tos-accepted-v1`).
- On subsequent visits, if the key is present, the modal does not appear.
- If the terms are ever materially revised, the version is bumped (`v2`, `v3`, …) so existing users are re-prompted.

### Why localStorage instead of a cookie

- Simpler — no cookie banner / cookie-consent concerns.
- Persists across sessions on the same browser, which is what we want.
- No data is sent to a server; the agreement is purely client-side state.

For a hobby project this is sufficient. The legal value of the agreement comes from the user clicking the button, not from how we store the fact afterward.

---

## 2. Click-to-agree mechanics

### 2.1 What makes a clickwrap binding (BC / Canada)

For a clickwrap to be enforceable, courts generally look for three things:

1. **Clear notice** of the terms.
2. **Unambiguous assent** by the user.
3. **Opportunity to review** the terms before agreeing.

The button label and the surrounding modal copy together need to satisfy all three.

### 2.2 Recommended button phrasing

> **I have read and agree to the Terms of Use**

This is standard, well-tested phrasing — courts in Canada and the US have repeatedly upheld clickwraps using almost exactly these words. The button text itself contains both "agree" and "Terms," which removes ambiguity about what the user is consenting to.

### 2.3 Recommended modal copy

The button should sit inside copy that re-states the most important warnings, so they're visible at the moment of consent and not only buried inside the full terms:

> By clicking **"I have read and agree to the Terms of Use"** below, you confirm that you have read, understood, and agree to be bound by the [Terms of Use](#), including the disclaimers of warranty, the limitation of liability, and the warning that this site **must not be used for navigation**.
>
> [ I have read and agree to the Terms of Use ]

The link to the Terms of Use inside the modal must actually open the full terms (either expanded inline or in a separate view) **before** the user clicks agree. If the user can't review the terms first, the agreement is much weaker.

### 2.4 Do we need an "I do not agree" button?

**Short answer: no — for this project's risk level, a single agree button is sufficient.**

Long answer:

- The user's effective decline is closing the tab or not clicking — courts have generally accepted that as a real choice.
- The *strongest* clickwraps do include an explicit decline option, because it forecloses any argument that the user was coerced ("I had to click agree just to see the site").
- That coercion argument is very weak here: the site is free, has no account, takes no payment, and collects no personal data. There is nothing the user is being forced to give up in exchange for access.

**Revisit this decision** if the project ever adds: user accounts, payments, personal data collection, or any commercial offering. At that point, add an explicit "I do not agree" button that closes/redirects away from the app.

### 2.5 Phrases to avoid

- **"OK" / "Got it" / "Continue"** as the only button — these have been struck down as ambiguous; the user may not understand they are forming a contract.
- **Pre-checked checkboxes** — an explicit weakness under Canadian consumer-protection norms; assent must be active.
- **Browsewrap** (auto-agreement on page load or scroll) — much weaker than clickwrap and routinely challenged.

### 2.6 What "blocks the app" means in practice

- Modal is rendered above all other UI, with a backdrop that intercepts clicks.
- Background interaction (map drag, sliders, station clicks) is disabled until acceptance is recorded.
- Keyboard focus is trapped inside the modal.
- The modal cannot be dismissed by clicking outside it or pressing Escape — only the agree button records consent.

---

## 3. Data attribution (separate from the TOS)

The app uses tide and current data from the **Canadian Hydrographic Service (CHS)**, published under the **Open Government Licence – Canada** (OGL-Canada). That licence requires visible attribution to anyone *viewing* the data.

This is a **licensing obligation owed to the data provider**, not part of the contract between us and the user. It is solved differently:

- **TOS** = the legal contract between us and the user (warranty disclaimers, liability, governing law, etc.). One-time consent.
- **Attribution** = an obligation we owe CHS / Government of Canada. Must be visible whenever the data is shown — not buried behind a one-time "I agree" click.

### 3.1 Where the attribution goes

In the **app UI**, not in the TOS modal. Recommended placement:

- A small footer line on the map view, e.g. alongside the existing MapLibre attribution control. Users already know to look there for data sources.
- Optionally, an "About" or "Data sources" link or modal accessible from the UI.

### 3.2 Attribution wording

Something along the lines of:

> Contains information licensed under the Open Government Licence – Canada. Tide and current data © Canadian Hydrographic Service, Fisheries and Oceans Canada.

The TOS may also briefly note the data source (e.g. "data sourced from CHS under OGL-Canada"), but that mention does not replace the visible in-app attribution.

---

## 4. Full Terms of Use — verbatim

The text below is what the user sees inside the modal (or via the "Terms of Use" link in the modal). It should be displayed **verbatim**.

---

### Terms of Use

**Last updated: April 28, 2026**

By using this site, you agree to the following terms. If you do not agree, please do not use the site.

#### 1. About this site

This is an **experimental hobby project**, provided free of charge with no commercial purpose. It is not affiliated with, endorsed by, or sponsored by the Canadian Hydrographic Service (CHS), Fisheries and Oceans Canada, or any government agency.

#### 2. Not for navigation

**This site must not be used for navigation, vessel routing, voyage planning, or any decision affecting the safety of life or property at sea.** Mariners must consult official, current CHS publications, charts, and tide and current tables, and must use properly maintained navigational equipment.

#### 3. No warranty

The site and all information it presents — including tide predictions, current predictions, station locations, timings, and derived values — are provided **"as is" and "as available," without warranties of any kind**, express or implied. We make no representations as to accuracy, completeness, timeliness, reliability, or fitness for any particular purpose. Data may be incorrect, out of date, or missing, and predictions may differ materially from actual conditions.

#### 4. Assumption of risk

**You use this site entirely at your own risk.** You are solely responsible for any decisions you make and any consequences that follow from using the information presented here. If you are on or near the water, you accept all risks associated with marine activity.

#### 5. Limitation of liability

To the fullest extent permitted by law, the operator of this site shall not be liable for any direct, indirect, incidental, consequential, special, exemplary, or punitive damages — including loss of life, personal injury, property damage, loss of use, or economic loss — arising out of or in connection with your use of, or inability to use, this site, even if advised of the possibility of such damages.

#### 6. Indemnification

You agree to indemnify and hold harmless the operator from any claim, demand, loss, or liability arising out of your use of the site or your breach of these terms.

#### 7. Changes

These terms may be updated at any time. Continued use of the site after changes constitutes acceptance of the revised terms.

#### 8. Governing law

These terms are governed by the laws of the Province of British Columbia and the federal laws of Canada applicable therein. Any dispute shall be subject to the exclusive jurisdiction of the courts of British Columbia.

---

**[ I have read and agree to the Terms of Use ]**

---

## 5. Implementation checklist

- [ ] Build a blocking modal component that renders above all app UI.
- [ ] Render the full TOS text (Section 4 above) inside the modal, or behind a clearly visible link inside the modal.
- [ ] Render the consent copy from §2.3 above the agree button.
- [ ] Single button: **"I have read and agree to the Terms of Use"**.
- [ ] On click, write `tos-accepted-v1` (or current version) to `localStorage` with a timestamp.
- [ ] On app boot, check `localStorage` for the current version key; show modal if missing.
- [ ] Trap keyboard focus inside the modal; do not allow Escape / outside-click to dismiss.
- [ ] Disable background interaction (map, controls) while modal is open.
- [ ] Add CHS / OGL-Canada attribution to the map UI footer (separate task, see §3).
- [ ] Bump the version key (`v2`, `v3`, …) any time the terms are materially revised so users are re-prompted.

## 6. Changes always require a new gate

**You always need a gate.** If the Terms of Use are revised in any material way, every user must click through and accept the new version — including users who already accepted a prior version. There is no path to binding the user to revised terms without a fresh, active click-through.

This is true even though Section 7 of the TOS itself says "continued use after changes constitutes acceptance." That clause is a baseline / backup; in practice, courts and Canadian consumer-protection norms treat passive "continued use" as weak evidence of assent to revised terms, especially for material changes. The defensible posture is **fresh active consent every time the terms change**.

Mechanically:

- Bump the version key (`tos-accepted-v1` → `tos-accepted-v2`, etc.).
- The boot-time check looks for the *current* version key only — older keys do not satisfy the gate.
- Existing users see the modal again on their next visit, with the revised terms.
- They click through again to record acceptance of the new version.

What counts as a "material" change is a judgment call, but err on the side of bumping the version. Examples that should bump:

- Any change to disclaimers, warranties, limitation of liability, indemnification, or governing law.
- Any change to the "not for navigation" wording or other safety language.
- Adding new categories of data collection, accounts, payments, or any new feature that changes the user's risk profile.

Cosmetic edits (typos, formatting, link fixes, dating) do not require a re-gate.

The point generalizes: **the gate is the mechanism that makes the terms binding.** Without a fresh click-through after a change, the user is only bound to the version they originally accepted — not to whatever is currently published on the site.

## 7. When to revisit

Revisit and likely strengthen this flow if any of the following becomes true:

- The site adds user accounts, login, or any form of identity.
- The site collects personal data (analytics beyond aggregate counts, contact forms, etc.).
- The site is monetized in any way (ads, donations with personal data, paid tier).
- Traffic grows beyond hobby scale.
- The terms are materially revised (bump the version, re-prompt all users).

At that point, add an explicit "I do not agree" decline button, consider a privacy policy as a separate document, and have a lawyer review.
