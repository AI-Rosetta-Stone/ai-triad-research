# UX Specs Index

**Last updated:** 2026-08-18
**Author:** Design (Orca)

Active UX specs in `docs/ux/`. Design owns these; coding agents reference them during implementation. Add a row when a new spec lands (this index replaces the inline inventory that used to live in the Design role AGENTS.md).

| Spec | Purpose |
|---|---|
| `onboarding.md` | *Superseded:* first-time user tour (t/664, t/665), replaced by the Rosetta Stone home page (t/4542) |
| `admin-community-removal.md` | Admin removal of community items (t/748) |
| `delete-api-keys.md` | Per-key deletion from Settings (t/774) |
| `share-review-notice.md` | Review/approval notice after sharing (t/775) |
| `sbom-help-tab.md` | SBOM tab in Help dialog (t/789) |
| `debate-diagnostics-redesign.md` | Debate Diagnostics review + 5-phase plan (t/1384–t/1389) |
| `de-engineering-pass.md` | Nine-item read-mode/chips/IDs/polish pass (t/1414) |
| `login-redesign.md` | "Specimen" front door: jacket/paper split, debate excerpt hero |
| `chat-export.md` | Export chat as PDF/Markdown/text, mirrors the debate export pattern (t/1477) |
| `conflict-detail-redesign.md` | Conflict page read-mode redesign; supersedes de-engineering-pass §2 |
| `org-detail-redesign.md` | Organization detail readability pass: key-figure rows, link/source rows, no raw JSON/URLs |
| `aitriad-help-redesign.md` | Show-AITriadHelp auto-gen page: sidebar nav + search for 158 cmdlets (t/1570) |
| `entity-mentions-detail.md` | Inline entity mentions + entity/term detail renderers + entity browser tool (rendering half of the entity ontology; t/1766/t/1767) |
| `debate-view-mode-controls.md` | Two-mode (Text / Analysis) redesign of the debate statement + global view-mode button row (p/351) |
| `debate-action-bar-redesign.md` | Debate window bottom bar → clean composer + `Tools ▾` menu consolidating secondary actions (t/2279) |
| `oped-claims-section.md` | Op-ed study view: "Claims" section (above Taxonomy grounding) + per-element claim linkage, mirroring the grounding `<details>` pattern (t/2890) |
| `debate-header-redesign.md` | Debate window header → title+source / status+metadata / per-POV DEBATERS strip; POV bars keep acc/saf/skp colors (t/2293) |
| `debate-list-tables.md` | My/Community debate tabs → full-width tables (Title/Status/Date/Turns/Model/Actions); Title wraps, per-row Open/Export/Share|Copy controls (t/2305) |
| `base-scale-calibration.md` | Raise base type baseline + tokenize icon sizes so 100% reads comfortably on web (fonts/icons tiny at 100%) |
| `regenerate-phrases-toggle.md` | Opt-in phrase regeneration on reflection edits (t/611, done) |
| `usage-analytics-instrumentation.md` | Hierarchical engagement tracking proposal — visit/dwell heuristic, tool→camp→category→node roll-up, admin + per-user dashboards (t/2463) |
| `usage-hierarchy-navigation.md` | Presentation UX for the roll-up: breadcrumb drill-down + tree + user/session scope filtering across all tools (Taxonomy/Chat/Lineage/Situations); KIND registry, leaf cross-axis, endpoint additions. Builds on `usage-analytics-instrumentation.md`, supersedes `analytics-dashboard.md` §3 |
| `oped-studio.md` | Op-Ed Studio — GUI for `New-OpEd`: My/Community library, multi-voice create (one topic → one op-ed per camp), tabbed multi-voice sets, clickable taxonomy grounding (t/2570) |
| `debate-setup-details.md` | Debate Setup drill-in — modal surfacing full topic, source URL/document pointer, background, and setup config; retires the situations-only `Details`/`CrossCuttingDialog` (t/2731) |
| `vocabulary-panel-readability.md` | Vocabulary panel (shared) readability fix — the panel ships with NO CSS (unstyled run-on rows); columns/spacing/tokens/a11y spec for Dictionary/Colloquial/Lint (t/3287) |
| `pov-tag-chip-tint.md` | Camp-tint the node-editor POV tag chips (`PovTagEditor`) so Skeptic tags read as camp-scoped, not neutral; 12% camp wash + camp border, primary text, `color-mix` off `--bg-secondary`; a11y checklist (p/351) |
| `node-detail-redesign.md` | Node detail panel redesign from PI mockups. Covers the panel-local Simple/Advanced toggle (separate from the global view mode), the meta line, moving the description out of the tabs, Formal Encompasses/Excludes rendering, Content→Analysis, and count pills (p/351#36) |
| `inquiry-options.md` | Ask a Question: collapse fidelity, model pickers and POV tag into an inline Options disclosure (t/4639 accordion pattern); summary line `Options · fidelity · model · tag`, live budget, blocked-tag auto-expand, why not New Debate's settings dialog, arrow-key rules (t/4667, p/351#51) |
| `design-system.md` | Design system reference (living document) |
