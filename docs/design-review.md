# Design Review: Checklist and Evidence Standard

**Status:** Canonical (shared) · **Owner:** Design (`main.engineering-design@…`) · **Ticket:** t/4783 (parent t/4781)
**Last updated:** 2026-11-05

This is what Design checks before passing a user-facing PR, what the author must provide, and how the verdict is recorded. The gate itself (what counts as user-facing, arming rules, the hold label) is defined in `docs/review-routing.md` § Design Gate; this doc doesn't repeat it.

## 1. What the author provides

Post it on the ticket (or the PR) and ping Design with the PR number.

- **Before and after screenshots, or a short recording, from the running app.** At least:
  - desktop width, in **dark theme** plus one light theme (`harvard` is the default);
  - **390px**, when the change touches anything a phone renders;
  - the **hosted view** (staging or prod) when the surface is web-only, or when web behaves differently from Electron.
- **Every state the change adds:** empty, loading, error, disabled, focused. If a state needs data you can't make cheaply (a paid AI run, published content), say so; don't skip it silently. Design will say whether tests are enough.
- **Label anything that isn't the live app.** A demo page built from the real stylesheet is acceptable evidence for simple CSS, *if it's labelled as one*. Unlabelled mock-ups are not.
- **For a behaviour fix:** the test that guards it, and a statement that it **fails with the fix removed**. A test that passes either way doesn't count.
- **The PR is held:** `no-auto-enqueue` applied at creation (see `review-routing.md`).

## 2. What Design checks

Design runs `/design-review-workflow` (the Design role's skill) for the procedure, and verifies on the **current head**, live where the change is visual.

| Area | Check | Pass bar |
|---|---|---|
| **Spec match** | Each acceptance criterion in the ticket or spec in `docs/ux/` | Every AC met, or a deviation agreed on the ticket |
| **Design system** | Tokens, type scale, spacing, button variants and component patterns in `docs/ux/design-system.md` | No new hard-coded colour or `px` font size where a token exists |
| **Themes** | All four: `light`, `harvard`, `dark`, `bkc` (there's no "auto" theme) | Renders correctly in each |
| **Contrast** | Every coloured text element and icon in the changed component, measured in each theme (the skill's script; disable transitions while measuring) | Text ≥ 4.5:1 (≥ 3:1 at ≥ 24px or ≥ 18.66px bold); icons, focus rings and control boundaries ≥ 3:1. `--text-muted` fails text AA in `harvard` and `bkc`, so don't use it for text that must be read |
| **Narrow widths** | 360, 390 and the 767px edge; **both** edges of every row the change touches | No overflow outside an intentional scroller; alignment and wrapping as specified |
| **Keyboard and focus** | Tab order; visible focus; arrow keys on composite widgets (radiogroups, separators, tabs) | Everything operable without a mouse |
| **Semantics** | Roles and names: icon-only buttons have `aria-label` (a `title` alone isn't enough); toggles have `aria-pressed` or `aria-checked`; live regions where something changes silently | A screen reader hears what a sighted user sees |
| **Copy and voice** | Wording, case, consistency with neighbouring UI, and build-specific copy (Electron "a separate window", web "a new tab") | Plain, specific, consistent |
| **States** | Empty, loading, error, disabled | Each one designed; **no silent failure**: an action that can fail shows an inline error (and logs a WARN, per `docs/error-handling.md`) |
| **Persistence and navigation** | Anything "remembered" survives a real reload or relaunch; Back, up-crumb and deep links behave per `navigation-location-bar.md` | Verified live, not inferred from the write side |

**Prefer measurements to screenshots.** Electron screenshots under emulation can come back cropped or scaled; base pass/fail on `getBoundingClientRect` and computed styles.

## 3. The verdict

Design posts exactly one of these **on the current head**, naming the head SHA and the ticket:

- **`Approved (Design): head <sha>, t/<N>.`** plus what was checked and the basis (live, code, or the author's evidence). Non-blocking follow-ups go below the verdict, never mixed into it.
- **`Changes requested (Design): head <sha>, t/<N>.`** plus numbered required items, each with a concrete fix. Measure the fix before recommending it where possible. Design re-applies `no-auto-enqueue`.
- **`Design-exempt (Design): head <sha>, <reason>.`** Only for **no visible change**: a refactor, a non-visual `.tsx` edit, a store-only fix. Not for a "small" visual change; that gets a quick approval instead.

**Re-reviews:**
- A new push needs Design again.
- If the new head only touches files with no UI effect (a store or test change), Design re-confirms from the diff since the approved head.
- A rebased replacement PR is re-confirmed by checking that its added and removed lines match the approved PR.

**Merged before review:** Design reviews it on `main` and files any finding as a follow-up ticket for the owning role. It doesn't reopen the PR.

## 4. How Design posts the verdict

Through the **reviewer App**, the same as Quality (`docs/agent-pr-approval.md`):

```powershell
Import-Module ./operations/devops/AgentAppToken.psm1
Invoke-AsAgentApp -Role reviewer -ScriptBlock {
  gh pr review <N> --approve --body 'Approved (Design): head <sha>, t/<N>. <one line>'
}
```

- For changes requested, use `gh pr review <N> --request-changes --body 'Changes requested (Design): …'`.
- For an exemption, use `gh pr review <N> --comment --body 'Design-exempt (Design): …'`.
- **If the token fails to mint, fail closed:** report it to the TL and Orca Support. Don't fall back to a plain comment from the shared account, because that's the unattributable path the reviewer App retires.
- The same verdict also goes on the ticket as a comment, so the record survives outside GitHub.

## 5. Turnaround

- **Target:** a verdict within **4 working hours** of the author's ping with complete evidence. Incomplete evidence (§1) gets a reply naming what's missing, and the clock starts when it arrives.
- **When Design is unavailable** (no response inside the target, or Design's tooling is down): the TL may grant a **time-boxed exemption**, recorded on the PR as `Design-exempt (TL, time-boxed): <reason>; Design to review on main by <date>`. Design then does a post-merge review and files follow-ups as needed.
