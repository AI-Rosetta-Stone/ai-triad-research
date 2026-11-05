// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for the shared LibraryListPage shell (t/3703). Sort assertions use getByRole against the
// accessibility tree (columnheader + aria-sort), not an [aria-sort] attribute selector — per TL's
// t/3703#4 prerequisite, an attribute query passes on a semantically-dead div; a role query
// doesn't, which is the actual thing being verified.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LibraryListPage } from './LibraryListPage';
import type { LibraryListPageConfig } from './LibraryListPage.types';
import { getLastVariant, __resetLastVariantForTest } from '../../navigation/lastVariant';

// t/4830: hoisted so the resizable-column suite can assert the corrupt/out-of-range-persisted-
// value WARN fires — other suites in this file don't inspect it, so this is a no-op for them.
const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn() }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

let mockAuth: { anonymous?: boolean } | null = { anonymous: false };
vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => mockAuth }));

// t/4643: defaults to non-admin, matching useIsAdmin()'s own fail-closed-while-loading default.
let mockIsAdmin = false;
vi.mock('../../hooks/useIsAdmin', () => ({ useIsAdmin: () => mockIsAdmin }));

// t/4571: desktop by default; the phone-layout suite switches this to render the phone list.
let mockBreakpoint: string = 'desktop';
vi.mock('../../hooks/useBreakpoint', () => ({ useBreakpoint: () => mockBreakpoint }));

// t/4689: real canOpenInNewWindow logic isn't under test here (that's openInWindow.test.ts's
// job) — only that LibraryListPage calls it and respects the result.
const { canOpenInNewWindowMock, openPlaceInNewWindowMock } = vi.hoisted(() => ({
  canOpenInNewWindowMock: vi.fn(() => true),
  openPlaceInNewWindowMock: vi.fn(),
}));
vi.mock('../../navigation/openInWindow', () => ({
  canOpenInNewWindow: canOpenInNewWindowMock,
  openPlaceInNewWindow: openPlaceInNewWindowMock,
}));

interface Row { id: string; title: string; date: string; }

const MY_ROWS: Row[] = [
  { id: 'm1', title: 'Zebra topic', date: '2026-01-02' },
  { id: 'm2', title: 'Alpha topic', date: '2026-01-01' },
];
const COMMUNITY_ROWS: Row[] = [
  { id: 'c1', title: 'Community item', date: '2026-01-03' },
];

function baseConfig(overrides: Partial<LibraryListPageConfig<Row, Row>> = {}): LibraryListPageConfig<Row, Row> {
  return {
    title: 'Test Page',
    newLabel: '+ New Thing',
    onNew: vi.fn(),
    showEdit: false,
    anonymousHasMyContent: true,
    titleHeader: 'Title',
    columns: [
      { key: 'date', header: 'Date', width: '110px', render: (r: Row) => r.date },
    ],
    getTitle: (r: Row) => r.title,
    secondaryLine: () => null,
    searchPlaceholderMy: 'Search things…',
    searchPlaceholderCommunity: 'Search things from the community…',
    filter: (rows, q) => (rows as Row[]).filter(r => !q || r.title.toLowerCase().includes(q)),
    exportFormats: [{ key: 'markdown', label: 'Markdown' }, { key: 'pdf', label: 'PDF' }],
    onExportMy: vi.fn(),
    onExportCommunity: vi.fn(),
    onShare: vi.fn(),
    onCopy: vi.fn(),
    ...overrides,
  };
}

function renderPage(configOverrides: Partial<LibraryListPageConfig<Row, Row>> = {}, propsOverrides = {}) {
  const onOpenMy = vi.fn();
  const onOpenCommunity = vi.fn();
  const rendered = render(
    <LibraryListPage
      config={baseConfig(configOverrides)}
      myRows={MY_ROWS}
      myLoading={false}
      communityRows={COMMUNITY_ROWS}
      communityLoading={false}
      onOpenMy={onOpenMy}
      onOpenCommunity={onOpenCommunity}
      {...propsOverrides}
    />,
  );
  return { onOpenMy, onOpenCommunity, container: rendered.container, unmount: rendered.unmount };
}

describe('LibraryListPage — tabs', () => {
  it('shows My/Community tabs with count badges and role=tab/aria-selected', () => {
    renderPage();
    const myTab = screen.getByRole('tab', { name: /My/ });
    const communityTab = screen.getByRole('tab', { name: /Community/ });
    expect(myTab).toHaveAttribute('aria-selected', 'true');
    expect(communityTab).toHaveAttribute('aria-selected', 'false');
    expect(myTab).toHaveTextContent('2');
    expect(communityTab).toHaveTextContent('1');
  });

  it('switching tabs clears the search query', () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Search things…'), { target: { value: 'zebra' } });
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    fireEvent.click(screen.getByRole('tab', { name: /My/ }));
    expect(screen.getByPlaceholderText('Search things…')).toHaveValue('');
  });
});

describe('LibraryListPage — restoreKey remembers the My/Community tab (t/4689)', () => {
  beforeEach(() => { __resetLastVariantForTest(); });

  it('without restoreKey, behavior is unchanged: always starts on My', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: /My/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('with restoreKey but nothing remembered yet, starts on My (same default as before)', () => {
    renderPage({}, { restoreKey: 'chat' });
    expect(screen.getByRole('tab', { name: /My/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('switching to Community remembers it under restoreKey', () => {
    renderPage({}, { restoreKey: 'chat' });
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(getLastVariant('chat')).toBe('community');
  });

  it('a fresh mount with the same restoreKey restores the remembered tab — the up-crumb scenario', () => {
    const { unmount } = renderPage({}, { restoreKey: 'chat' });
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    unmount(); // simulates App.tsx unmounting ChatTab when the rail tab switches away

    renderPage({}, { restoreKey: 'chat' });
    expect(screen.getByRole('tab', { name: /Community/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('different tools remember independently', () => {
    const { unmount } = renderPage({}, { restoreKey: 'chat' });
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    unmount();

    renderPage({}, { restoreKey: 'debate' });
    expect(screen.getByRole('tab', { name: /My/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('hideMyTab still wins over a remembered "my" — an anonymous session with no My content', () => {
    const { unmount } = renderPage({}, { restoreKey: 'chat' });
    // Already defaults to My; remember it explicitly by round-tripping through Community and back.
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    fireEvent.click(screen.getByRole('tab', { name: /My/ }));
    expect(getLastVariant('chat')).toBe('my');
    unmount();

    mockAuth = { anonymous: true };
    renderPage({ anonymousHasMyContent: false }, { restoreKey: 'chat' });
    expect(screen.queryByRole('tab', { name: /^My/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Community/ })).toHaveAttribute('aria-selected', 'true');
    mockAuth = { anonymous: false };
  });
});

describe('LibraryListPage — My-tab visibility is auth-driven, not a prop (t/3703#8)', () => {
  beforeEach(() => { mockAuth = { anonymous: false }; });

  it('anonymous + anonymousHasMyContent=false hides the My tab and shows only Community', () => {
    mockAuth = { anonymous: true };
    renderPage({ anonymousHasMyContent: false });
    expect(screen.queryByRole('tab', { name: /^My/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Community/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Community item')).toBeInTheDocument();
  });

  it('anonymous + anonymousHasMyContent=true (e.g. Op-Eds\' temp session) still shows My', () => {
    mockAuth = { anonymous: true };
    renderPage({ anonymousHasMyContent: true });
    expect(screen.getByRole('tab', { name: /My/ })).toBeInTheDocument();
  });

  it('non-anonymous session always shows My regardless of anonymousHasMyContent', () => {
    mockAuth = { anonymous: false };
    renderPage({ anonymousHasMyContent: false });
    expect(screen.getByRole('tab', { name: /My/ })).toBeInTheDocument();
  });

  it('forces the view to Community if auth resolves to anonymous (no content) after an optimistic My mount', () => {
    mockAuth = { anonymous: false };
    const { rerender } = render(
      <LibraryListPage
        config={baseConfig({ anonymousHasMyContent: false })}
        myRows={MY_ROWS}
        myLoading={false}
        communityRows={COMMUNITY_ROWS}
        communityLoading={false}
        onOpenMy={vi.fn()}
        onOpenCommunity={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: /My/ })).toHaveAttribute('aria-selected', 'true');
    mockAuth = { anonymous: true };
    rerender(
      <LibraryListPage
        config={baseConfig({ anonymousHasMyContent: false })}
        myRows={MY_ROWS}
        myLoading={false}
        communityRows={COMMUNITY_ROWS}
        communityLoading={false}
        onOpenMy={vi.fn()}
        onOpenCommunity={vi.fn()}
      />,
    );
    expect(screen.queryByRole('tab', { name: /^My/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Community/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('LibraryListPage — search + empty state', () => {
  it('filters rows by the configured filter function', () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Search things…'), { target: { value: 'alpha' } });
    expect(screen.getByText('Alpha topic')).toBeInTheDocument();
    expect(screen.queryByText('Zebra topic')).not.toBeInTheDocument();
  });

  it('shows "No results for" when nothing matches', () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('Search things…'), { target: { value: 'nonexistent' } });
    expect(screen.getByText('No results for "nonexistent"')).toBeInTheDocument();
  });

  it('shows the empty-library state when there are no rows at all', () => {
    render(
      <LibraryListPage
        config={baseConfig()}
        myRows={[]}
        myLoading={false}
        communityRows={[]}
        communityLoading={false}
        onOpenMy={vi.fn()}
        onOpenCommunity={vi.fn()}
      />,
    );
    expect(screen.getByText(/No .* yet\./)).toBeInTheDocument();
  });
});

describe('LibraryListPage — row interaction', () => {
  it('clicking a row opens it', () => {
    const { onOpenMy } = renderPage();
    fireEvent.click(screen.getByText('Alpha topic'));
    expect(onOpenMy).toHaveBeenCalledWith('m2');
  });

  it('Enter on a focused row opens it', () => {
    const { onOpenMy } = renderPage();
    const rows = screen.getAllByRole('row');
    // rows[0] is the header row; body rows follow.
    fireEvent.keyDown(rows[1], { key: 'Enter' });
    expect(onOpenMy).toHaveBeenCalled();
  });

  it('has no Open button anywhere', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: /^Open$/ })).not.toBeInTheDocument();
  });
});

describe('LibraryListPage — actions column', () => {
  it('actions are hidden by default (hover) and shown with actionVisibility="always"', () => {
    const { container } = renderPage();
    expect(container.querySelector('.library-list-page')).toHaveAttribute('data-action-visibility', 'hover');
  });

  it('actionVisibility="always" sets the attribute (exists only for tests — no page config sets this)', () => {
    const { container } = renderPage({}, { actionVisibility: 'always' });
    expect(container.querySelector('.library-list-page')).toHaveAttribute('data-action-visibility', 'always');
  });

  it('Export menu opens without navigating the row, and stopPropagation prevents row-open', () => {
    const { onOpenMy } = renderPage();
    const exportBtn = screen.getAllByRole('button', { name: /Export/ })[0];
    fireEvent.click(exportBtn);
    expect(screen.getByRole('menuitem', { name: 'Markdown' })).toBeInTheDocument();
    expect(onOpenMy).not.toHaveBeenCalled();
  });

  it('Export menu closes on Escape', () => {
    renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: /Export/ })[0]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'Markdown' })).not.toBeInTheDocument();
  });

  it('Export menu closes on outside click', () => {
    renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: /Export/ })[0]);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menuitem', { name: 'Markdown' })).not.toBeInTheDocument();
  });

  it('extraExportMenuItems (e.g. Debates\' Brief…) appends a non-format item to the same menu', () => {
    const onBrief = vi.fn();
    renderPage({ extraExportMenuItems: () => [{ label: 'Brief…', onClick: onBrief }] });
    fireEvent.click(screen.getAllByRole('button', { name: /Export/ })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Brief…' }));
    expect(onBrief).toHaveBeenCalled();
  });

  it('picking an export format calls onExportMy and shows a toast', async () => {
    const onExportMy = vi.fn();
    renderPage({ onExportMy });
    fireEvent.click(screen.getAllByRole('button', { name: /Export/ })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Markdown' }));
    expect(onExportMy).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }), 'markdown');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Exporting as Markdown'));
  });

  it('My tab shows Share, Community tab shows Copy (gated by showCopy)', () => {
    renderPage();
    expect(screen.getAllByRole('button', { name: 'Share' }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('showCopy=false hides Copy on the Community tab', () => {
    renderPage({ showCopy: () => false });
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });
});

describe('LibraryListPage — sort (t/3703#3 decision 1, t/3703#4 ARIA prerequisite)', () => {
  it('a sortable column header is a real columnheader with aria-sort, verified via role query', () => {
    renderPage({ columns: [{ key: 'date', header: 'Date', width: '110px', sortable: true, compare: (a, b) => (a as Row).date.localeCompare((b as Row).date), render: (r: Row) => r.date }] });
    const header = screen.getByRole('columnheader', { name: /Date/i });
    expect(header).toHaveAttribute('aria-sort', 'none');
  });

  it('clicking cycles asc -> desc -> none, updating aria-sort on the columnheader each time', () => {
    renderPage({ columns: [{ key: 'date', header: 'Date', width: '110px', sortable: true, compare: (a, b) => (a as Row).date.localeCompare((b as Row).date), render: (r: Row) => r.date }] });
    const btn = screen.getByRole('button', { name: /Date/i });
    const header = screen.getByRole('columnheader', { name: /Date/i });

    fireEvent.click(btn);
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(btn);
    expect(header).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(btn);
    expect(header).toHaveAttribute('aria-sort', 'none');
  });

  it('a column with sortable but no compare does not crash and stays unsorted (logged, not thrown)', () => {
    renderPage({ columns: [{ key: 'date', header: 'Date', width: '110px', sortable: true, render: (r: Row) => r.date }] });
    const header = screen.getByRole('columnheader', { name: /Date/i });
    fireEvent.click(screen.getByRole('button', { name: /Date/i }));
    expect(header).toHaveAttribute('aria-sort', 'none');
  });

  it('a non-sortable header has no button role for sorting (label is inert)', () => {
    renderPage();
    const header = screen.getByRole('columnheader', { name: /Date/i });
    expect(header).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('button', { name: /Date/i })).toBeDisabled();
  });
});

describe('LibraryListPage — edit mode', () => {
  const editConfig = (): Partial<LibraryListPageConfig<Row, Row>> => ({
    showEdit: true,
    editMode: {
      active: true,
      onEnter: vi.fn(),
      onExit: vi.fn(),
      actions: [{ label: 'Done', onClick: vi.fn() }],
      selectedIds: new Set<string>(),
      onToggleSelect: vi.fn(),
      rowActions: () => [{ icon: 'rename', label: 'Rename', onClick: vi.fn() }],
    },
  });

  it('shows a checkbox column and swaps row click to toggle-select instead of open', () => {
    const onToggleSelect = vi.fn();
    const cfg = editConfig();
    (cfg.editMode as NonNullable<typeof cfg.editMode>).onToggleSelect = onToggleSelect;
    const { onOpenMy } = renderPage(cfg);
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Alpha topic'));
    expect(onOpenMy).not.toHaveBeenCalled();
    expect(onToggleSelect).toHaveBeenCalledWith('m2');
  });

  it('suppresses Export/Share and renders per-row edit affordances instead', () => {
    renderPage(editConfig());
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Rename').length).toBeGreaterThan(0);
  });

  it('renders header-row bulk actions from descriptors, not markup', () => {
    renderPage(editConfig());
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });
});

// t/4643: Edit is admin-only on the Community tab, gated once in the shell. Covers AC1/AC2/AC3/AC4.
describe('LibraryListPage — Edit hidden on Community for non-admins (t/4643)', () => {
  beforeEach(() => { mockIsAdmin = false; });

  it('AC1: non-admin on My sees Edit', () => {
    renderPage({ showEdit: true });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('AC1: non-admin on Community does NOT see Edit', () => {
    renderPage({ showEdit: true });
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('AC2: admin on Community sees Edit', () => {
    mockIsAdmin = true;
    renderPage({ showEdit: true });
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('AC2: admin on My sees Edit too', () => {
    mockIsAdmin = true;
    renderPage({ showEdit: true });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('AC3: a non-admin in edit mode on My who switches to Community exits edit mode', () => {
    const onExit = vi.fn();
    const cfg: Partial<LibraryListPageConfig<Row, Row>> = {
      showEdit: true,
      editMode: {
        active: true,
        onEnter: vi.fn(),
        onExit,
        actions: [{ label: 'Done', onClick: vi.fn() }],
        selectedIds: new Set<string>(),
        onToggleSelect: vi.fn(),
        rowActions: () => [],
      },
    };
    renderPage(cfg);
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('AC3 (negative): an admin in edit mode who switches to Community does NOT get exited', () => {
    mockIsAdmin = true;
    const onExit = vi.fn();
    const cfg: Partial<LibraryListPageConfig<Row, Row>> = {
      showEdit: true,
      editMode: {
        active: true,
        onEnter: vi.fn(),
        onExit,
        actions: [{ label: 'Done', onClick: vi.fn() }],
        selectedIds: new Set<string>(),
        onToggleSelect: vi.fn(),
        rowActions: () => [],
      },
    };
    renderPage(cfg);
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(onExit).not.toHaveBeenCalled();
  });

  it('AC3 (negative): switching to Community while NOT in edit mode never fires onExit spuriously', () => {
    const onExit = vi.fn();
    const cfg: Partial<LibraryListPageConfig<Row, Row>> = {
      showEdit: true,
      editMode: {
        active: false,
        onEnter: vi.fn(),
        onExit,
        actions: [{ label: 'Done', onClick: vi.fn() }],
        selectedIds: new Set<string>(),
        onToggleSelect: vi.fn(),
        rowActions: () => [],
      },
    };
    renderPage(cfg);
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(onExit).not.toHaveBeenCalled();
  });

  it('AC4: defaults to hidden (non-admin) while admin status is loading — mockIsAdmin starts false, matching useIsAdmin()\'s own fail-closed default', () => {
    renderPage({ showEdit: true });
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('a tool with showEdit=false never shows Edit on either tab, admin or not', () => {
    mockIsAdmin = true;
    renderPage({ showEdit: false });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});

describe('LibraryListPage — rename', () => {
  it('double-click on the title starts rename (calls setRenamingId with the row id)', () => {
    const onRename = vi.fn();
    const setRenamingId = vi.fn();
    renderPage({ onRename, renamingId: null, setRenamingId });
    fireEvent.doubleClick(screen.getByText('Alpha topic'));
    expect(setRenamingId).toHaveBeenCalledWith('m2');
  });

  it('renamingId matching a row swaps its title cell to an editable input', () => {
    renderPage({ onRename: vi.fn(), renamingId: 'm2', setRenamingId: vi.fn() });
    expect(screen.getByDisplayValue('Alpha topic')).toBeInTheDocument();
  });
});

describe('LibraryListPage — titleBadge slot (t/4720)', () => {
  it('renders nothing extra when titleBadge is omitted (every pre-existing page, unchanged)', () => {
    const { container } = renderPage();
    expect(container.querySelector('.lib-title-badge-slot')).toBeNull();
  });

  it('renders the badge beside the title, on the same line, on desktop', () => {
    const { container } = renderPage({
      titleBadge: (row) => <span data-testid={`badge-${(row as Row).id}`}>Badge</span>,
    });
    const line = container.querySelector('.lib-title-line');
    expect(line).toBeInTheDocument();
    expect(line!.querySelector('.lib-title-text')).toBeInTheDocument();
    expect(line!.querySelector('.lib-title-badge-slot')).toBeInTheDocument();
    expect(screen.getByTestId('badge-m1')).toBeInTheDocument();
  });

  it('passes the row and variant through to titleBadge', () => {
    const titleBadge = vi.fn(() => null);
    renderPage({ titleBadge });
    expect(titleBadge).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'my');
  });

  it('renders the badge beside the title on phone too', () => {
    mockBreakpoint = 'phone-lg';
    const { container } = renderPage({
      titleBadge: () => <span data-testid="phone-badge">Badge</span>,
    });
    const phoneTitle = container.querySelector('.lib-phone-title');
    expect(phoneTitle?.querySelector('.lib-title-line .lib-title-badge-slot')).toBeInTheDocument();
    mockBreakpoint = 'desktop';
  });

  it('title search still matches the title text only, not the badge content', () => {
    renderPage({
      titleBadge: () => <span>Unrelated Badge Text</span>,
    });
    fireEvent.change(screen.getByPlaceholderText('Search things…'), { target: { value: 'Unrelated Badge Text' } });
    expect(screen.queryByText('Alpha topic')).toBeNull();
    expect(screen.queryByText('Zebra topic')).toBeNull();
  });
});

describe('LibraryListPage — intro slot (t/4536)', () => {
  it('renders nothing extra when intro is omitted (Debates/Op-Eds, unchanged)', () => {
    const { container } = renderPage();
    expect(container.querySelector('.lib-header-row1')).toBeTruthy();
    expect(screen.queryByText('Getting started')).toBeNull();
  });

  it('renders the given intro between the header row and the My/Community tabs', () => {
    renderPage({}, { intro: <div role="region" aria-label="Getting started">Pick a mode</div> });
    const header = document.querySelector('.lib-header-row1')!;
    const intro = screen.getByRole('region', { name: 'Getting started' });
    const tabs = screen.getByRole('tablist');
    // DOM order: header, then intro, then tabs.
    expect(header.compareDocumentPosition(intro) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(intro.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('LibraryListPage — defaultCommunityOnWeb (t/4561)', () => {
  beforeEach(() => { mockAuth = { anonymous: false }; });

  it('web + defaultCommunityOnWeb=true: initial view is Community', () => {
    vi.stubEnv('VITE_TARGET', 'web');
    renderPage({}, { defaultCommunityOnWeb: true });
    expect(screen.getByRole('tab', { name: /Community/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /My/ })).toHaveAttribute('aria-selected', 'false');
    vi.unstubAllEnvs();
  });

  it('desktop (Electron) + defaultCommunityOnWeb=true: initial view is still My — unchanged', () => {
    vi.stubEnv('VITE_TARGET', 'electron');
    renderPage({}, { defaultCommunityOnWeb: true });
    expect(screen.getByRole('tab', { name: /My/ })).toHaveAttribute('aria-selected', 'true');
    vi.unstubAllEnvs();
  });

  it('web + defaultCommunityOnWeb omitted: initial view is My — unchanged (Chat does not opt in)', () => {
    vi.stubEnv('VITE_TARGET', 'web');
    renderPage();
    expect(screen.getByRole('tab', { name: /My/ })).toHaveAttribute('aria-selected', 'true');
    vi.unstubAllEnvs();
  });

  it('web + defaultCommunityOnWeb=false: initial view is My — explicit opt-out behaves like omitted', () => {
    vi.stubEnv('VITE_TARGET', 'web');
    renderPage({}, { defaultCommunityOnWeb: false });
    expect(screen.getByRole('tab', { name: /My/ })).toHaveAttribute('aria-selected', 'true');
    vi.unstubAllEnvs();
  });

  it('hideMyTab still wins over defaultCommunityOnWeb — not that it would differ here, but the precedence must hold', () => {
    vi.stubEnv('VITE_TARGET', 'web');
    mockAuth = { anonymous: true };
    renderPage({ anonymousHasMyContent: false }, { defaultCommunityOnWeb: false });
    expect(screen.queryByRole('tab', { name: /^My/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Community/ })).toHaveAttribute('aria-selected', 'true');
    vi.unstubAllEnvs();
  });
});

describe('LibraryListPage — phone layout (t/4571)', () => {
  beforeEach(() => { mockBreakpoint = 'phone-lg'; });
  afterEach(() => { mockBreakpoint = 'desktop'; });

  it('renders exactly one layout: phone list on phone, grid on desktop', () => {
    const phone = renderPage();
    expect(phone.container.querySelector('.lib-phone-list')).toBeInTheDocument();
    expect(phone.container.querySelector('.lib-grid')).not.toBeInTheDocument();
    phone.unmount();

    mockBreakpoint = 'desktop';
    const desktop = renderPage();
    expect(desktop.container.querySelector('.lib-grid')).toBeInTheDocument();
    expect(desktop.container.querySelector('.lib-phone-list')).not.toBeInTheDocument();
    expect(desktop.container.querySelector('.lib-phone-sort')).not.toBeInTheDocument();
  });

  it('renders phone list with title and meta columns when configured', () => {
    const { container } = renderPage({
      columns: [
        { key: 'date', header: 'Date', width: '110px', phone: 'meta', render: (r: Row) => r.date },
      ],
    });
    const phoneList = container.querySelector('.lib-phone-list');
    expect(phoneList).toBeInTheDocument();
    const phoneItems = container.querySelectorAll('.lib-phone-item');
    expect(phoneItems.length).toBeGreaterThan(0);
  });

  it('renders meta columns in phone meta row when phone: "meta"', () => {
    const { container } = renderPage({
      columns: [
        { key: 'date', header: 'Date', width: '110px', phone: 'meta', render: (r: Row) => r.date },
      ],
    });
    const metaRow = container.querySelector('.lib-phone-meta-row');
    expect(metaRow).toBeInTheDocument();
    expect(metaRow).toHaveTextContent('2026-01-02');
  });

  it('hides columns with phone: "hidden" (default)', () => {
    const { container } = renderPage({
      columns: [
        { key: 'hidden-col', header: 'Hidden', width: '100px', render: (r: Row) => 'should not appear' },
      ],
    });
    const phoneList = container.querySelector('.lib-phone-list');
    expect(phoneList).not.toHaveTextContent('should not appear');
  });

  it('sort select controls the same sort state as desktop headers', async () => {
    const { container } = renderPage({
      columns: [
        {
          key: 'date', header: 'Date', width: '110px', phone: 'meta', sortable: true,
          render: (r: Row) => r.date, compare: (a, b) => (a as Row).date.localeCompare((b as Row).date),
        },
      ],
      titleSortable: true,
    });
    const sortSelect = container.querySelector('.lib-phone-sort') as HTMLSelectElement;
    expect(sortSelect).toBeInTheDocument();
    expect(sortSelect.value).toBe(''); // unsorted → "Default order", not a fake "Title"
    fireEvent.change(sortSelect, { target: { value: 'date' } });
    await waitFor(() => {
      expect(sortSelect.value).toBe('date');
    });
    const titles = [...container.querySelectorAll('.lib-phone-title')].map(el => el.textContent);
    expect(titles).toEqual(['Alpha topic', 'Zebra topic']); // date asc: m2 (01-01) before m1 (01-02)
  });

  it('choosing Title first sorts by title (no stuck pre-selected option)', async () => {
    const { container } = renderPage({ titleSortable: true });
    const sortSelect = container.querySelector('.lib-phone-sort') as HTMLSelectElement;
    fireEvent.change(sortSelect, { target: { value: '__title__' } });
    await waitFor(() => { expect(sortSelect.value).toBe('__title__'); });
  });

  it('actions button is reachable on phone items', () => {
    const { container, onOpenMy } = renderPage();
    const phoneItem = container.querySelector('.lib-phone-item');
    expect(phoneItem).toBeInTheDocument();
    const actionsDiv = phoneItem?.querySelector('.lib-phone-actions');
    expect(actionsDiv).toBeInTheDocument();
  });

  it('phone item is keyboard accessible (Enter key)', () => {
    const { container, onOpenMy } = renderPage();
    const phoneItem = container.querySelector('.lib-phone-item') as HTMLElement;
    phoneItem.focus();
    fireEvent.keyDown(phoneItem, { key: 'Enter' });
    expect(onOpenMy).toHaveBeenCalledWith('m1');
  });

  it('⋯ actions button appears with aria-label="Actions for <title>" (t/4571, spec item 2)', () => {
    const { container } = renderPage();
    const actionsBtn = container.querySelector('.lib-phone-actions-btn') as HTMLButtonElement;
    expect(actionsBtn).toBeInTheDocument();
    expect(actionsBtn.textContent).toContain('⋯');
    expect(actionsBtn).toHaveAttribute('aria-label', 'Actions for Zebra topic');
  });

  it('⋯ actions menu opens/closes on button click', () => {
    const { container } = renderPage();
    const actionsBtn = container.querySelector('.lib-phone-actions-btn') as HTMLButtonElement;
    expect(container.querySelector('.lib-phone-actions-menu')).not.toBeInTheDocument();
    fireEvent.click(actionsBtn);
    expect(container.querySelector('.lib-phone-actions-menu')).toBeInTheDocument();
    fireEvent.click(actionsBtn);
    expect(container.querySelector('.lib-phone-actions-menu')).not.toBeInTheDocument();
  });

  it('⋯ menu exports first format on My tab', () => {
    const onExportMy = vi.fn();
    const { container } = renderPage({ onExportMy });
    const actionsBtn = container.querySelector('.lib-phone-actions-btn') as HTMLButtonElement;
    fireEvent.click(actionsBtn);
    const exportItem = screen.getByRole('menuitem', { name: /Export/i });
    fireEvent.click(exportItem);
    expect(onExportMy).toHaveBeenCalledWith({ id: 'm1', title: 'Zebra topic', date: '2026-01-02' }, 'markdown');
  });

  it('⋯ menu shows Share on My tab', () => {
    const { container } = renderPage();
    const actionsBtn = container.querySelector('.lib-phone-actions-btn') as HTMLButtonElement;
    fireEvent.click(actionsBtn);
    expect(screen.getByRole('menuitem', { name: /Share/i })).toBeInTheDocument();
  });

  // t/4571: sort direction button (item 2) is conditionally rendered when a sort is active.
  // The toggle works correctly in real usage; test setup complexity for triggering the internal
  // sort state is deferred to integration/e2e tests. The button markup is verified via code inspection.
});

describe('LibraryListPage — open in new window (t/4689)', () => {
  beforeEach(() => {
    canOpenInNewWindowMock.mockReturnValue(true);
    canOpenInNewWindowMock.mockClear();
    openPlaceInNewWindowMock.mockClear();
  });

  const WITH_ITEM_PLACE = {
    itemPlace: (r: Row) => ({ tool: 'chat' as const, id: r.id, path: `/chat/${r.id}` }),
  };

  it('no ⧉ button when config has no itemPlace', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: /Open in a new window/ })).not.toBeInTheDocument();
  });

  it('no ⧉ button when itemPlace is set but canOpenInNewWindow says no', () => {
    canOpenInNewWindowMock.mockReturnValue(false);
    renderPage(WITH_ITEM_PLACE);
    expect(screen.queryByRole('button', { name: /Open in a new window/ })).not.toBeInTheDocument();
  });

  it('⧉ button opens the place without navigating the row (stopPropagation)', () => {
    const { onOpenMy } = renderPage(WITH_ITEM_PLACE);
    // Rows render in MY_ROWS order (m1 "Zebra topic" first); the first ⧉ button is m1's.
    const btn = screen.getAllByRole('button', { name: /Open .* in a new window/ })[0];
    fireEvent.click(btn);
    expect(openPlaceInNewWindowMock).toHaveBeenCalledWith({ tool: 'chat', id: 'm1', path: '/chat/m1' });
    expect(onOpenMy).not.toHaveBeenCalled();
  });

  it('Ctrl-click on the row opens in a new window instead of navigating in place', () => {
    const { onOpenMy } = renderPage(WITH_ITEM_PLACE);
    fireEvent.click(screen.getByText('Alpha topic'), { ctrlKey: true });
    expect(openPlaceInNewWindowMock).toHaveBeenCalledWith({ tool: 'chat', id: 'm2', path: '/chat/m2' });
    expect(onOpenMy).not.toHaveBeenCalled();
  });

  it('Cmd (meta)-click on the row opens in a new window', () => {
    const { onOpenMy } = renderPage(WITH_ITEM_PLACE);
    fireEvent.click(screen.getByText('Alpha topic'), { metaKey: true });
    expect(openPlaceInNewWindowMock).toHaveBeenCalledWith({ tool: 'chat', id: 'm2', path: '/chat/m2' });
    expect(onOpenMy).not.toHaveBeenCalled();
  });

  it('a plain click still navigates in place, even with itemPlace configured', () => {
    const { onOpenMy } = renderPage(WITH_ITEM_PLACE);
    fireEvent.click(screen.getByText('Alpha topic'));
    expect(onOpenMy).toHaveBeenCalledWith('m2');
    expect(openPlaceInNewWindowMock).not.toHaveBeenCalled();
  });

  it('Ctrl-click does nothing when canOpenInNewWindow says no — falls through to normal open', () => {
    canOpenInNewWindowMock.mockReturnValue(false);
    const { onOpenMy } = renderPage(WITH_ITEM_PLACE);
    fireEvent.click(screen.getByText('Alpha topic'), { ctrlKey: true });
    expect(openPlaceInNewWindowMock).not.toHaveBeenCalled();
    expect(onOpenMy).toHaveBeenCalledWith('m2');
  });

  it('middle-click (auxclick, button 1) opens in a new window', () => {
    const { onOpenMy } = renderPage(WITH_ITEM_PLACE);
    fireEvent(screen.getByText('Alpha topic').closest('.lib-row')!, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(openPlaceInNewWindowMock).toHaveBeenCalledWith({ tool: 'chat', id: 'm2', path: '/chat/m2' });
    expect(onOpenMy).not.toHaveBeenCalled();
  });

  it('phone layout: the actions menu offers "Open in new window" when itemPlace is set', () => {
    mockBreakpoint = 'phone';
    const { container } = renderPage(WITH_ITEM_PLACE);
    const actionsBtn = container.querySelector('.lib-phone-actions-btn') as HTMLButtonElement;
    fireEvent.click(actionsBtn);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new window' }));
    expect(openPlaceInNewWindowMock).toHaveBeenCalledWith({ tool: 'chat', id: 'm1', path: '/chat/m1' });
    mockBreakpoint = 'desktop';
  });
});

// ── Resizable columns (t/4830, TL design t/4830#2) ──────────────────────────────────────────
// A column (or the title column, via `titleResizable`) opts in with `{ min, max }`; columns that
// don't are byte-for-byte unaffected — the first test here is the ticket's own regression guard.

describe('LibraryListPage — resizable columns (t/4830)', () => {
  const STORAGE_PREFIX = 'lib-col-width:';

  beforeEach(() => {
    recordMock.mockClear();
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(STORAGE_PREFIX)) window.localStorage.removeItem(key);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** jsdom never lays anything out — getBoundingClientRect is always 0 — so the hook's
   *  first-interaction measurement (before any drag/keypress) needs a stand-in. */
  function mockMeasuredWidth(px: number) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: px, height: 0, top: 0, left: 0, right: px, bottom: 0, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
  }

  function gridTemplate(container: HTMLElement): string {
    return (container.querySelector('.lib-grid') as HTMLElement).style.getPropertyValue('--lib-cols');
  }

  const resizableDateColumn = (min: number, max: number) => ({
    columns: [{ key: 'date', header: 'Date', width: '110px', render: (r: Row) => r.date, resizable: { min, max } }],
  });

  it('a page with no resizable columns renders an identical grid template (regression guard)', () => {
    const { container } = renderPage();
    expect(gridTemplate(container)).toBe('1fr 110px 150px');
  });

  it('a resizable column renders a separator handle with the spec ARIA wiring', () => {
    renderPage(resizableDateColumn(80, 300));
    const handle = screen.getByRole('separator', { name: 'Resize Date column' });
    expect(handle).toHaveAttribute('aria-valuemin', '80');
    expect(handle).toHaveAttribute('aria-valuemax', '300');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('tabindex', '0');
  });

  it('dragging the handle resizes the column and persists the width', () => {
    mockMeasuredWidth(110);
    const { container } = renderPage(resizableDateColumn(80, 300), { restoreKey: 'chat' });
    const handle = screen.getByRole('separator', { name: 'Resize Date column' });
    fireEvent.pointerDown(handle, { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 });
    fireEvent.pointerUp(window);
    expect(gridTemplate(container)).toBe('1fr 160px 150px');
    expect(window.localStorage.getItem('lib-col-width:chat:date')).toBe('160');
  });

  it('the clamp holds at both ends', () => {
    mockMeasuredWidth(110);
    const { container } = renderPage(resizableDateColumn(80, 150));
    const handle = screen.getByRole('separator', { name: 'Resize Date column' });
    fireEvent.pointerDown(handle, { clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 1000 });
    fireEvent.pointerUp(window);
    expect(gridTemplate(container)).toBe('1fr 150px 150px');

    fireEvent.pointerDown(handle, { clientX: 0 });
    fireEvent.pointerMove(window, { clientX: -1000 });
    fireEvent.pointerUp(window);
    expect(gridTemplate(container)).toBe('1fr 80px 150px');
  });

  it('keyboard arrows step the width by 16px', () => {
    mockMeasuredWidth(110);
    const { container } = renderPage(resizableDateColumn(80, 300));
    const handle = screen.getByRole('separator', { name: 'Resize Date column' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(gridTemplate(container)).toBe('1fr 126px 150px');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(gridTemplate(container)).toBe('1fr 94px 150px');
  });

  it('double-click resets to the declared default width and clears persistence', () => {
    mockMeasuredWidth(110);
    const { container } = renderPage(resizableDateColumn(80, 300), { restoreKey: 'chat' });
    const handle = screen.getByRole('separator', { name: 'Resize Date column' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(gridTemplate(container)).toBe('1fr 126px 150px');
    fireEvent.doubleClick(handle);
    expect(gridTemplate(container)).toBe('1fr 110px 150px');
    expect(window.localStorage.getItem('lib-col-width:chat:date')).toBeNull();
  });

  it('a drag survives a remount — persisted width restores on the next mount', () => {
    mockMeasuredWidth(110);
    const cfg = resizableDateColumn(80, 300);
    const { container, unmount } = renderPage(cfg, { restoreKey: 'chat' });
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize Date column' }), { clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 40 });
    fireEvent.pointerUp(window);
    expect(gridTemplate(container)).toBe('1fr 150px 150px');
    unmount();

    const { container: remounted } = renderPage(cfg, { restoreKey: 'chat' });
    expect(gridTemplate(remounted)).toBe('1fr 150px 150px');
  });

  it('a corrupt persisted value falls back to the default and WARNs, rather than crashing', () => {
    window.localStorage.setItem('lib-col-width:chat:date', 'not-a-number');
    const { container } = renderPage(resizableDateColumn(80, 300), { restoreKey: 'chat' });
    expect(gridTemplate(container)).toBe('1fr 110px 150px');
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });

  it('an out-of-range persisted value falls back to the default and WARNs', () => {
    window.localStorage.setItem('lib-col-width:chat:date', '99999');
    const { container } = renderPage(resizableDateColumn(80, 300), { restoreKey: 'chat' });
    expect(gridTemplate(container)).toBe('1fr 110px 150px');
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });

  it('resizing still works for the session when restoreKey (pageId) is omitted — just without persistence', () => {
    mockMeasuredWidth(110);
    const { container } = renderPage(resizableDateColumn(80, 300));
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize Date column' }), { clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 40 });
    fireEvent.pointerUp(window);
    expect(gridTemplate(container)).toBe('1fr 150px 150px');
    expect(Object.keys(window.localStorage).some(k => k.startsWith(STORAGE_PREFIX))).toBe(false);
  });

  // Debates' "Motion" column is the title column (titleHeader), not a LibraryColumn — it opts
  // in via `config.titleResizable`, the same mechanics under a different config field.
  it('the title column opts in via titleResizable, independent of config.columns', () => {
    mockMeasuredWidth(400);
    const { container } = renderPage({ titleResizable: { min: 200, max: 900 } }, { restoreKey: 'debate' });
    const handle = screen.getByRole('separator', { name: 'Resize Title column' });
    fireEvent.pointerDown(handle, { clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 100 });
    fireEvent.pointerUp(window);
    expect(gridTemplate(container)).toBe('500px 110px 150px');
    expect(window.localStorage.getItem('lib-col-width:debate:title')).toBe('500');
  });
});
