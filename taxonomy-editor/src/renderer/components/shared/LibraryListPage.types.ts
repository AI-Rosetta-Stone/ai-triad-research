// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Shared config/prop contract for LibraryListPage (t/3703, parent t/3702). One shared list-page
// component for Op-Ed Studies / Chats / Debates — spec at C:\tmp\HANDOFF-library-pages.md.
//
// Shared vs per-page split (TL ruling, t/3702#1 + t/3703#3): header layout, tab row, search +
// empty state, grid mechanics, row interaction, the ENTIRE actions column (Export/Share/Copy/
// toast/visibility), sort mechanics, and colour/type tokens live INSIDE LibraryListPage. Per-page
// config supplies only: title/button label, whether Edit renders, column set/widths, cell
// renderers, the second-line rule, sort *intent* (not mechanics), and the data source. General
// form (t/3703#3): any rule the spec states once generically is shared, even if only one page
// hits it today — title-cell clamping/web-address rendering and inline-rename both fall out of
// this even though only Op-Eds/Chats exercise them respectively.

import type { ReactNode } from 'react';

export type LibraryVariant = 'my' | 'community';

export interface LibraryColumn<TMy, TCommunity> {
  key: string;
  /** Header label — 11px/600/uppercase/#8a8079 per spec. Empty string for a column with no
   *  header label (the actions column never gets one; it's not declared here at all). */
  header: string;
  /** e.g. '150px' or '90px'. The title column is NEVER declared here — it is always first,
   *  always `minmax(0,1fr)`, and rendered by LibraryListPage itself (see getTitle below). */
  width: string;
  align?: 'left' | 'right';
  /** Collapsed per TL ruling (t/3703#3): one function branching on variant, not renderMy/
   *  renderCommunity — two functions per column meant Model/Date/Mode got the same reference
   *  passed twice, a copy-paste that drifts the moment one side is edited without the other. */
  render: (row: TMy | TCommunity, variant: LibraryVariant) => ReactNode;
  /** Declares SORT INTENT only — LibraryListPage owns all mechanics (tri-state cycle, the
   *  indicator, `aria-sort`, keyboard activation, which column is active). Default false, so a
   *  page opts in rather than inherits. Comparator, not header markup or cycle logic. */
  sortable?: boolean;
  /** Only consulted when `sortable` is true. Defaults to a case-insensitive locale compare on
   *  the column's rendered text if omitted — supply this when the column needs numeric/date
   *  ordering (e.g. Debates' Turns, right-aligned numeric). */
  compare?: (a: TMy | TCommunity, b: TMy | TCommunity, variant: LibraryVariant) => number;
}

export interface LibraryExportFormat {
  key: string;
  label: string; // e.g. 'Markdown', 'PDF', 'Word (.docx)'
}

/** Bulk-action button descriptor for edit mode — descriptors, not markup (TL contract change 1,
 *  t/3703#3): two pages independently building Delete/None/Reset/Done as ReactNode is the
 *  actions-column divergence failure mode reappearing in the header. LibraryListPage renders
 *  these with the spec's §3/§4 button tokens; pages own labels, handlers, and enablement only. */
export interface LibraryEditModeAction {
  label: string; // e.g. 'Delete 3', 'None', 'Reset Order', 'Done'
  onClick: () => void;
  variant?: 'default' | 'danger';
  disabled?: boolean;
}

/** Per-row edit-mode affordance — icon-only, so `label` is the `aria-label`, not visible text.
 *  `icon` is a closed enum (not a ReactNode) for the same reason `LibraryEditModeAction` uses
 *  descriptors: LibraryListPage owns icon/sizing/spacing/stopPropagation, pages own which
 *  affordances exist and what they do (t/3705#2, folded into t/3703 before types landed). */
export interface LibraryRowEditAction {
  icon: 'rename' | 'moveUp' | 'moveDown';
  onClick: () => void;
  label: string; // aria-label
  disabled?: boolean;
}

export interface LibraryEditModeConfig<TMy> {
  active: boolean;
  onEnter: () => void;
  onExit: () => void;
  actions: LibraryEditModeAction[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  /** Edit mode is a MODE, not a variant (t/3705#2): while active, LibraryListPage suppresses
   *  Export/Share/Copy in the actions-column slot (meaningless while selecting) and renders these
   *  per-row descriptors there instead. Omit for a page with no per-row edit affordances (Chats
   *  has none since it has no edit mode at all; Op-Eds supplies today's rename-only set; Debates
   *  supplies rename + moveUp + moveDown). Only meaningful for My rows — edit mode never applies
   *  to Community. */
  rowActions?: (row: TMy) => LibraryRowEditAction[];
}

export interface LibraryListPageConfig<TMy extends { id: string }, TCommunity extends { id: string }> {
  /** Page title — "Op-Ed Studies", "Chats", "Debates". Sentence case, rendered at 22px/600. */
  title: string;
  /** "+ New Op-Ed" / "+ New Chat" / "+ New Debate". Omit `onNew` to hide the button entirely. */
  newLabel: string;
  onNew?: () => void;
  /** Edit is a secondary header button, Op-Eds/Debates only (unchanged from today) — Chats
   *  passes false. When true, `editMode` must be supplied. */
  showEdit: boolean;
  editMode?: LibraryEditModeConfig<TMy>;

  /**
   * Whether an anonymous session has real content in My on this page (t/3703#8, reversing an
   * earlier ruling that assumed the answer was uniformly false). It isn't: Debates has nothing
   * for anonymous users, but Op-Eds' temp anon session does. So this is genuinely per-page, not
   * a mechanism LibraryListPage can decide on its own — but it's REQUIRED, not optional, so a
   * page can't silently inherit a wrong default the way `actionVisibility` could have. When
   * `false` and the session is anonymous, LibraryListPage hides the My tab entirely (no
   * single-item tablist), defaults to the Community view, and uses the Community search
   * placeholder — never a dead tab showing an empty list. Named for the semantic (does anon have
   * content here), not the mechanism (auth read).
   */
  anonymousHasMyContent: boolean;

  columns: LibraryColumn<TMy, TCommunity>[];

  /** Header label for the title column — "Headline" / "Title" / "Motion". The title column
   *  itself (always first, always flex) is not in `columns`, so this is its own field. */
  titleHeader: string;
  /** Whether the title column participates in sort — same intent-only contract as
   *  `LibraryColumn.sortable`. Comparator defaults to a locale compare on `getTitle`'s result. */
  titleSortable?: boolean;
  /** Raw title/headline text for the shared title cell. LibraryListPage owns clamping (2-line,
   *  text-wrap:pretty) and web-address detection/rendering (protocol + www. stripped, site name
   *  weight 600, remainder #8a8079, one line + ellipsis) — this is spec-generic logic, not
   *  per-page, even though only Op-Eds hits the web-address branch today. */
  getTitle: (row: TMy | TCommunity, variant: LibraryVariant) => string;
  /** Default: `/^https?:\/\//i.test(title)`. Override only if a page's "title" needs different
   *  web-address detection than the default regex. */
  isWebAddressTitle?: (row: TMy | TCommunity, variant: LibraryVariant) => boolean;

  /** Inline rename via the shared title cell (double-click to start, Enter/blur to commit, Esc
   *  to cancel, stopPropagation on click) — shared per the same "spec states it once generically"
   *  rule; Op-Eds (edit mode) and Chats (list, no edit mode) both need it. Omit `onRename` and the
   *  title cell is never editable. */
  onRename?: (id: string, newTitle: string) => void;
  renamingId?: string | null;
  setRenamingId?: (id: string | null) => void;

  /** Page-owned: joins its own parts with ' · ' and returns the full second line, or null for
   *  none. LibraryListPage does NOT append "by <author>" itself — the spec's per-page rule
   *  (Op-Eds: "N voices" + community authorship) is genuinely page-specific content, unlike the
   *  shared title-cell mechanics above. */
  secondaryLine: (row: TMy | TCommunity, variant: LibraryVariant) => string | null;

  searchPlaceholderMy: string;
  searchPlaceholderCommunity: string;
  /** Same collapse as `render` — one function, variant-branching inside. */
  filter: (rows: (TMy | TCommunity)[], query: string, variant: LibraryVariant) => (TMy | TCommunity)[];

  exportFormats: LibraryExportFormat[];
  onExportMy: (row: TMy, format: string) => void;
  onExportCommunity: (row: TCommunity, format: string) => void;
  /** Extra items appended to the Export dropdown after the format list, for an action that isn't
   *  a format variant (e.g. Debates' "Brief…", t/3705#6) — same menu, same positioning/Esc/
   *  outside-click/stopPropagation, so it stays "looks the same on every page" while letting a
   *  page attach one unrelated action to the shared menu rather than inventing a second menu.
   *  Return [] (not omit-and-branch) to gate an item off for a given row/variant — e.g. Debates'
   *  existing web-only Brief gating becomes `variant === 'my' && !isElectron ? [...] : []`. */
  extraExportMenuItems?: (row: TMy | TCommunity, variant: LibraryVariant) => Array<{ label: string; onClick: () => void; disabled?: boolean }>;
  /** My-tab action — mirrors submitToCommunity; the page owns the actual call. */
  onShare: (row: TMy) => void;
  /** Community-tab action — copies the item into My; the page owns the actual call. */
  onCopy: (row: TCommunity) => void;
  /** Default true. Op-Eds hides Copy for anonymous auth today — pages needing an equivalent
   *  gate pass this. (LibraryListPage does read auth for the My-tab-visibility rule below, but
   *  that's the one deliberate exception — see `anonymousHasMyContent`; it still has no general
   *  auth-driven per-row logic of its own, which is what this predicate is for.) */
  showCopy?: (row: TCommunity) => boolean;
}

export interface LibraryListPageProps<TMy extends { id: string }, TCommunity extends { id: string }> {
  config: LibraryListPageConfig<TMy, TCommunity>;
  myRows: TMy[];
  myLoading: boolean;
  communityRows: TCommunity[];
  communityLoading: boolean;
  onOpenMy: (id: string) => void;
  onOpenCommunity: (id: string) => void;
  /**
   * Spec §3 wants this user-configurable (always/hover). No preference store exists; deliberate
   * scope cut (t/3703, approved t/3703#3). NO page config sets this — all three pages run the
   * default, because divergent values would silently break the "actions look the same on all
   * pages" AC while each page still renders fine in isolation. This prop exists for
   * LibraryListPage's own tests (the `always` arm), not as a per-page knob.
   * THE EXEMPTION LAPSES the moment a page passes a non-default value, or a preferences surface
   * exists — at which point this becomes a real setting, not a prop. File the follow-up ticket
   * for the settings-store wiring before either happens.
   */
  actionVisibility?: 'always' | 'hover'; // default 'hover'
  /**
   * t/4536: an optional block rendered between the header row and the My/Community tabs — e.g.
   * Chat's getting-started card. Additive: Debates and Op-Eds pass nothing and are unchanged.
   */
  intro?: ReactNode;
  /**
   * t/4561: on the web build only, default the initial view to Community instead of My, on
   * every mount. Electron is unchanged regardless of this prop. Additive and omit-safe — Chat
   * does not set it and keeps today's 'my' default; Op-Eds, Ask a Question and Debates
   * (t/4562/t/4563) opt in. `hideMyTab` still wins: an anonymous session with no My content
   * never lands on a tab it can't see, same as before this prop existed.
   */
  defaultCommunityOnWeb?: boolean;
}
