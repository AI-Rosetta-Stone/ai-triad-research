# Node Detail: What / Why / How Tab Groups

**Ticket:** t/4826 (PI request) · **Author:** Design (Orca) · **Date:** 2026-11-04
**Amends:** `node-detail-redesign.md` (t/4574) §1, §2.2 and §2.5. Everything else in that spec still holds.

## Summary

The node detail panel's `[Simple | Advanced]` control becomes `[What | Why | How]`. The control no longer switches how much of the panel shows. Instead, it chooses which group of tabs the tab row shows. The **Analysis** tab is split into two tabs, **Steelman Vulnerability** and **Intellectual Lineage**.

## 1. The What / Why / How control

- **Position and look:** the same place and component as today's toggle, at the top right on the meta line. It's the same `nd-toggle-btn` segmented control, now with three segments: `[What | Why | How]`.
- **Accessibility:** keep today's pattern, a `role="radiogroup"` with `aria-label="Tab group"`. Each segment is `role="radio"` with `aria-checked`, and there's a roving `tabIndex`. ←/→ moves between segments and selects the one it lands on.
- **Independent of the rail's Simple/Advanced control.** It never reads or writes `usePreferencesStore.viewMode`, and the rail control never changes it.
- **Default:** What.
- **Persistence:** one remembered value for the whole panel, kept across sessions. It is **not** per node. The group chooses a way of reading, not a property of the node, so the reader's choice should follow them from node to node. The per-node `nodeDetailModes` override (t/4736) is retired along with the toggle.

## 2. Groups

| Group | Tabs, in this order |
|---|---|
| **What** | Steelman Vulnerability · Related · Attributes |
| **Why** | Intellectual Lineage · Sources · Conflicts · Cruxes |
| **How** | Sources · Facts · Phrases · History · Research |

- **Sources is in both Why and How, on purpose.** It's one tab with one piece of state, listed in both groups. If Sources is active when the reader switches between Why and How, it stays active.
- **Tab bar:** the tab row shows only the current group's tabs. The count pills (Conflicts, Cruxes, Facts, History) are unchanged.
- **Switching groups:** if the active tab is in the new group, it stays active. Otherwise the new group's **first** tab becomes active.
- **Opening a tab from elsewhere:** some entry points open a specific tab, such as the conflict badge, `navigateToLineage` and the attribute info links. When one of those targets a tab outside the current group, switch to the **first group, in What → Why → How order, that contains the tab**, then open it. Never open a tab the bar can't show.
- **Changing nodes:** the group stays the same. The active tab follows the rule above, so the first tab of the group opens unless the current tab exists for the new node too.
- **Overflow:** keep the t/4574 §2.5 horizontal scroll with no scrollbar and a right-edge fade. The longest group, How, has five tabs and fits on desktop. On phone, the row scrolls as it does today.

## 3. Splitting the Analysis tab

The Analysis tab (`'content'`) holds four things today. They move as follows:

| Content | New home |
|---|---|
| Steelman vulnerability section | The **Steelman Vulnerability** tab, What group |
| Intellectual lineage section | The **Intellectual Lineage** tab, Why group |
| Metrics row (`NodeMetricsRow`, e.g. Debate Tested) | The top of **Attributes**, What group |
| POV tags (`PovTagEditor`) | The top of **Attributes**, below the metrics row |

- **No collapse inside the new tabs.** Steelman and lineage are collapsed by default today (t/4532) because they were stacked in one tab. As their own tabs, they render **expanded**, without the disclosure header, and the `steelmanExpanded` / `lineageExpanded` state goes away. Keep the per-entry expand for lineage items (`expandedLineage`).
- **Empty states:** both tabs always show, even when the node has no data, so a group's tabs don't change from node to node. With no data, show the standard `EmptyState`:
  - Steelman Vulnerability: headline "No steelman analysis yet"; direction "This node hasn't been analysed for its strongest counter-case."
  - Intellectual Lineage: headline "No intellectual lineage recorded"; direction "No sources of this idea have been linked to this node."
- **Tab ids:** use `'steelman'` and `'lineage'`, and retire `'content'`.
- **Attributes** is unchanged below the two moved blocks.

## 4. What the old toggle also controlled (open question for the PI)

Simple/Advanced also gated the panel's tools:
- the header icons 📖 ↗ 📜;
- the description toolbar (`[Formal | Plain]` `✎ Edit` `↻ Regenerate`);
- the formal vs plain default for the description;
- Pin in the `⋯` menu.

With the toggle gone, those need a rule. **My recommendation, and the default until the PI says otherwise:** they follow the **rail's** Simple/Advanced control.
- **Simple:** plain description, no description toolbar, no header icons, no Pin. This matches today's Simple view.
- **Advanced:** the full t/4574 Advanced chrome.

The tab filter (What / Why / How) stays independent of the rail, as the PI asked. The rail control keeps a single job: show or hide the editing tools. Every tab is reachable in both rail modes.

## 5. Acceptance criteria

- AC1: `[What | Why | How]` replaces `[Simple | Advanced]` in the same spot. It's a radiogroup with arrow-key support, defaults to What, and is remembered panel-wide across sessions.
- AC2: changing the rail's Simple/Advanced does not change the selected group, and selecting a group does not change the rail.
- AC3: each group shows exactly the tabs in §2, in order. Sources is in Why and How and stays active when switching between them.
- AC4: switching groups keeps the active tab if the new group has it, and otherwise opens the group's first tab.
- AC5: an entry point that targets a tab outside the current group switches to the first group that has it.
- AC6: the Analysis tab is gone. Steelman Vulnerability and Intellectual Lineage render expanded, with the §3 empty states. The metrics row and POV tags appear at the top of Attributes.
- AC7: tools follow §4 (pending the PI's answer).
- AC8: Design review (`/design-review-workflow`) in both builds, all 4 themes and at 390px, before Done.

## 6. Implementation notes

- Files: `NodeDetail.tsx` (tab ids, `NodeDetailTabBar`, `NodeDetailViewToggle`, `NodeDetailContentTab`, `useSimpleViewTabReset`) and `preferencesStore.ts` (a new panel-level `nodeDetailTabGroup`; retire `nodeDetailModes`).
- Conflicts and Cruxes only change which group lists them; their content is untouched. The Conflict role doesn't need to change anything.
- Remove `useSimpleViewTabReset`; §2's group-switch rule replaces it.
