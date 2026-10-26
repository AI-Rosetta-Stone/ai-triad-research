// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for the shared LibraryListPage shell (t/3703). Sort assertions use getByRole against the
// accessibility tree (columnheader + aria-sort), not an [aria-sort] attribute selector — per TL's
// t/3703#4 prerequisite, an attribute query passes on a semantically-dead div; a role query
// doesn't, which is the actual thing being verified.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LibraryListPage } from './LibraryListPage';
import type { LibraryListPageConfig } from './LibraryListPage.types';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

let mockAuth: { anonymous?: boolean } | null = { anonymous: false };
vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => mockAuth }));

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
  return { onOpenMy, onOpenCommunity, container: rendered.container };
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
