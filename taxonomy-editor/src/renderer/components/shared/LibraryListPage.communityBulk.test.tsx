// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/49 (PI option A on t/44, TL design t/44#2/#3): admin multi-select + bulk admin-delete on the
// Community tab, plus the per-row admin-delete error path (TL p/10#15).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { LibraryListPage } from './LibraryListPage';
import type { LibraryListPageConfig } from './LibraryListPage.types';
import { summarizeBulkAdminDelete } from './LibraryCommunityBulkDelete';
import { __resetLastVariantForTest } from '../../navigation/lastVariant';

const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn() }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));
vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ anonymous: false }) }));
let mockIsAdmin = true;
vi.mock('../../hooks/useIsAdmin', () => ({ useIsAdmin: () => mockIsAdmin }));
let mockBreakpoint = 'desktop';
vi.mock('../../hooks/useBreakpoint', () => ({ useBreakpoint: () => mockBreakpoint }));
vi.mock('../../navigation/openInWindow', () => ({ canOpenInNewWindow: () => false, openPlaceInNewWindow: vi.fn() }));

interface Row { id: string; title: string; }
const MY_ROWS: Row[] = [{ id: 'm1', title: 'My item' }];
const COMMUNITY_ROWS: Row[] = [
  { id: 'c1', title: 'First community item' },
  { id: 'c2', title: 'Second community item' },
  { id: 'c3', title: 'Third community item' },
];

function config(overrides: Partial<LibraryListPageConfig<Row, Row>> = {}, editActive = true): LibraryListPageConfig<Row, Row> {
  return {
    title: 'Questions',
    newLabel: '+ New',
    showEdit: true,
    editMode: {
      active: editActive,
      onEnter: vi.fn(),
      onExit: vi.fn(),
      actions: [{ label: 'My Delete 0', onClick: vi.fn() }, { label: 'Done', onClick: vi.fn() }],
      selectedIds: new Set<string>(),
      onToggleSelect: vi.fn(),
    },
    anonymousHasMyContent: true,
    titleHeader: 'Title',
    columns: [],
    getTitle: (r: Row) => r.title,
    secondaryLine: () => null,
    searchPlaceholderMy: 'Search mine…',
    searchPlaceholderCommunity: 'Search community…',
    filter: (rows, q) => (rows as Row[]).filter(r => !q || r.title.toLowerCase().includes(q)),
    exportFormats: [{ key: 'markdown', label: 'Markdown' }],
    onExportMy: vi.fn(),
    onExportCommunity: vi.fn(),
    onShare: vi.fn(),
    onCopy: vi.fn(),
    adminDelete: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function renderPage(cfg: LibraryListPageConfig<Row, Row>) {
  const props = {
    myRows: MY_ROWS, myLoading: false, communityRows: COMMUNITY_ROWS, communityLoading: false,
    onOpenMy: vi.fn(), onOpenCommunity: vi.fn(),
  };
  const r = render(<LibraryListPage config={cfg} {...props} />);
  fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
  return { ...r, props, rerenderWith: (next: LibraryListPageConfig<Row, Row>) => r.rerender(<LibraryListPage config={next} {...props} />) };
}

const box = (title: string) => screen.getByRole('checkbox', { name: `Select ${title}` }) as HTMLInputElement;

beforeEach(() => {
  mockIsAdmin = true;
  mockBreakpoint = 'desktop';
  recordMock.mockClear();
  __resetLastVariantForTest();
});

describe('LibraryListPage — Community selection for admins (t/49)', () => {
  it('regression (t/44): clicking a Community checkbox changes the selection, without calling the page\'s My-only onToggleSelect', () => {
    const cfg = config();
    renderPage(cfg);
    expect(box('First community item').checked).toBe(false);
    fireEvent.click(box('First community item'));
    expect(box('First community item').checked).toBe(true);
    expect(cfg.editMode!.onToggleSelect).not.toHaveBeenCalled();
  });

  it('clicking a Community row toggles it instead of opening it', () => {
    const { props } = renderPage(config());
    fireEvent.click(screen.getByText('Second community item'));
    expect(box('Second community item').checked).toBe(true);
    fireEvent.click(screen.getByText('Second community item'));
    expect(box('Second community item').checked).toBe(false);
    expect(props.onOpenCommunity).not.toHaveBeenCalled();
  });

  it('All selects the visible Community rows (search-filtered), None clears them, and Remove N tracks the count (hidden at 0)', () => {
    renderPage(config());
    expect(screen.queryByRole('button', { name: /^Remove \d+$/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search community…'), { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('button', { name: 'Remove 1' })).toBeEnabled();
    fireEvent.change(screen.getByPlaceholderText('Search community…'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('button', { name: 'Remove 3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(screen.queryByRole('button', { name: /^Remove \d+$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'My Delete 0' })).not.toBeInTheDocument();
  });

  it('My-tab edit mode is unchanged: the page\'s own actions and onToggleSelect', () => {
    const cfg = config();
    renderPage(cfg);
    fireEvent.click(screen.getByRole('tab', { name: /My/ }));
    expect(screen.getByRole('button', { name: 'My Delete 0' })).toBeInTheDocument();
    fireEvent.click(box('My item'));
    expect(cfg.editMode!.onToggleSelect).toHaveBeenCalledWith('m1');
  });

  it('the selection clears on a tab switch', () => {
    renderPage(config());
    fireEvent.click(box('First community item'));
    fireEvent.click(screen.getByRole('tab', { name: /My/ }));
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(box('First community item').checked).toBe(false);
  });

  it('Done exits edit mode, and the selection is cleared when edit mode turns back on', () => {
    const cfg = config();
    const { rerenderWith } = renderPage(cfg);
    fireEvent.click(box('First community item'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(cfg.editMode!.onExit).toHaveBeenCalledTimes(1);
    rerenderWith(config({ editMode: { ...cfg.editMode!, active: false } }));
    rerenderWith(config({ editMode: { ...cfg.editMode!, active: true } }));
    expect(box('First community item').checked).toBe(false);
  });

  it('a page without adminDelete shows no checkboxes on Community, only Done', () => {
    renderPage(config({ adminDelete: undefined }));
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
  });

  it('phone layout: lib-phone-checkbox toggles Community rows the same way', () => {
    mockBreakpoint = 'phone';
    renderPage(config());
    fireEvent.click(box('Third community item'));
    expect(box('Third community item').checked).toBe(true);
    expect(box('Third community item')).toHaveClass('lib-phone-checkbox');
  });
});

describe('LibraryListPage — bulk admin-delete (t/49)', () => {
  it('Remove N opens one confirm listing the titles, and calls adminDelete once per row, in order, with the one reason', async () => {
    const order: string[] = [];
    let release!: () => void;
    const adminDelete = vi.fn((row: Row) => {
      order.push(`start ${row.id}`);
      // The first delete stays pending until released: the second must not start before it settles.
      const p = row.id === 'c1' ? new Promise<void>(r => { release = r; }) : Promise.resolve();
      return p.then(() => { order.push(`end ${row.id}`); });
    });
    renderPage(config({ adminDelete }));
    fireEvent.click(box('First community item'));
    fireEvent.click(box('Second community item'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 2' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('First community item')).toBeInTheDocument();
    expect(within(dialog).getByText('Second community item')).toBeInTheDocument();
    expect(adminDelete).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: '  spam  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 2' }));
    await waitFor(() => expect(adminDelete).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['start c1']);
    expect(within(dialog).getByRole('button', { name: 'Removing…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(order).toEqual(['start c1', 'end c1', 'start c2', 'end c2']);
    expect(adminDelete).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'c1' }), 'spam');
    expect(adminDelete).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'c2' }), 'spam');
    expect(screen.getByRole('status')).toHaveTextContent('Removed 2 from Community');
  });

  it('partial failure: reports "Removed 2 of 3; 1 failed", keeps only the failed row selected, and records it', async () => {
    const adminDelete = vi.fn((row: Row) => (row.id === 'c2' ? Promise.reject(new Error('server said no')) : Promise.resolve()));
    renderPage(config({ adminDelete }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 3' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove 3' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Removed 2 of 3; 1 failed');
    expect(alert).toHaveTextContent('still selected: choose Remove 1 to retry, or Close.');
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove 1' })).toBeEnabled();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(adminDelete).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(box('Second community item').checked).toBe(true);
    expect(box('First community item').checked).toBe(false);
    expect(box('Third community item').checked).toBe(false);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn', component: 'library-list-page', message: expect.stringContaining('c2'),
    }));
  });

  it('a page whose adminDelete returns void is reported as "Removal requested", never "Removed N of N" (TL t/44#3)', async () => {
    renderPage(config({ adminDelete: vi.fn(() => undefined) }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 3' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove 3' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Removal requested for 3');
    expect(screen.getByRole('status')).not.toHaveTextContent(/Removed \d/);
  });

  it('summary text covers mixed outcomes', () => {
    expect(summarizeBulkAdminDelete({ confirmedIds: ['a'], requestedIds: ['b', 'c'], failedIds: ['d'] }))
      .toBe('Removed 1 of 2; 1 failed. Removal requested for 2');
  });
});

describe('LibraryListPage — per-row admin-delete failure (t/49, TL p/10#15)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
  afterEach(() => { process.off('unhandledRejection', onUnhandled); });

  it('a rejecting adminDelete shows one error message and leaves no unhandled rejection', async () => {
    const adminDelete = vi.fn(() => Promise.reject(new Error('Forbidden')));
    renderPage(config({ adminDelete }, false));
    fireEvent.click(screen.getByRole('button', { name: 'Remove "First community item" from Community (admin)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Couldn\'t remove "First community item"');
    await new Promise(r => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ component: 'library-list-page', level: 'warn' }));
  });

  it('a 429 rejection shows operation-neutral text, not the AI model advice (t/108)', async () => {
    const adminDelete = vi.fn(() => Promise.reject(new Error('HTTP 429 Too Many Requests')));
    renderPage(config({ adminDelete }, false));
    fireEvent.click(screen.getByRole('button', { name: 'Remove "First community item" from Community (admin)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Couldn\'t remove "First community item": Too many requests. Wait a minute and try again.');
    expect(status).not.toHaveTextContent(/model/i);
  });
});
