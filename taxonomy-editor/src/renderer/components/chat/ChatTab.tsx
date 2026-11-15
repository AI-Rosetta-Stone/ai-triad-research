// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { ExternalLink } from 'lucide-react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useChatStore } from '../../hooks/useChatStore';
import { expectReplace } from '../../navigation';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useCommunityStore } from '../../hooks/useCommunityStore';
import type { CommunityChat } from '../../hooks/useCommunityStore';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { NewChatDialog } from './NewChatDialog';
import { ChatGettingStarted } from './ChatGettingStarted';
import { buildChatLibraryListConfig, rowCampChip } from './chatLibraryListConfig';
import { ChatWorkspace } from './ChatWorkspace';
import { SearchPreview } from '../edge-browser/SearchPreview';
import { PromptDetailPanel } from './PromptsPanel';
import type { PromptCatalogEntry } from '../../data/promptCatalog';
import { PROMPT_CATALOG } from '../../data/promptCatalog';
import { ToolbarPaneRenderer, isFullWidthPanel, PhoneToolClose } from '../shared/ToolbarPaneRenderer';
import { CopyLinkButton } from '../shared/CopyLinkButton';
import { LineageDetailView } from '../shared/LineageDetailView';
import { LibraryListPage } from '../shared/LibraryListPage';
import type { LibraryEditModeAction } from '../shared/LibraryListPage.types';
import { useDialog } from '../shared/useDialog'; // t/4901
import { POVER_INFO } from '../../types/debate';
import type { ChatSessionSummary, ChatMode, ChatSession } from '../../types/chat';
import { api } from '@bridge';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkColorizePov } from '../../utils/colorizePovPlugin';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import './ChatTab.css';

const MODE_LABELS: Record<ChatMode, string> = {
  brainstorm: 'Brainstorm',
  inform: 'Inform',
  decide: 'Decide',
};

// t/4802 (Design): the hint's closing phrase differs by target, matching the ⧉ button's own label
// (LocationBarHost.tsx) — "a separate window" in Electron, "a new tab" on web.
const isElectron = import.meta.env.VITE_TARGET !== 'web';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// t/4690: one-time first-open hint (copy from Design's amended spec, t/4686#1), shown once per
// browser the first time a chat opens in place, never on phone. Read/write pattern matches
// FreeTierDisclosure.tsx — a storage failure shows the hint again next visit, the safe failure
// for a one-time disclosure (never a missing one).
export const CHAT_IN_PLACE_HINT_STORAGE_KEY = 'aitriad.chatInPlaceHint.v1';

function readHintAcknowledged(): boolean {
  try {
    return localStorage.getItem(CHAT_IN_PLACE_HINT_STORAGE_KEY) === 'ack';
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'chat-tab', level: 'warn',
      message: 'localStorage unreadable; showing the chat in-place hint (WARN: fallback to show)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return false;
  }
}

function writeHintAcknowledged(): void {
  try {
    localStorage.setItem(CHAT_IN_PLACE_HINT_STORAGE_KEY, 'ack');
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'chat-tab', level: 'warn',
      message: 'localStorage unwritable; the chat in-place hint will show again next visit (WARN: fallback)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

function ChatInPlaceHint() {
  const [acknowledged, setAcknowledged] = useState(readHintAcknowledged);
  const pendingUnmountWriteRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const dismiss = useCallback(() => {
    writeHintAcknowledged();
    setAcknowledged(true);
  }, []);

  // t/4802 (Design, matching DebateInPlaceHint/t/4801): dismiss on Esc, or on the first navigation
  // away from the item place. ChatDetailContent only renders while an item is open, so this
  // component's own unmount *is* "navigated away" — no separate navigation listener needed.
  //
  // t/4818: the unmount write is debounced through a ref-held timeout rather than fired straight
  // from the cleanup. React StrictMode's dev-only double-invoke (mount -> cleanup -> mount) runs
  // the re-mount synchronously, before a 0ms timeout fires, so it cancels the phantom write; a
  // genuine unmount has no following re-mount to cancel it, so the real write still lands.
  useEffect(() => {
    if (acknowledged) return;
    clearTimeout(pendingUnmountWriteRef.current);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      pendingUnmountWriteRef.current = setTimeout(writeHintAcknowledged, 0);
    };
  }, [acknowledged, dismiss]);

  if (acknowledged) return null;
  return (
    <div className="chat-in-place-hint" role="status">
      <span>
        <strong>Opens here now.</strong> Use <ExternalLink aria-hidden="true" className="chat-in-place-hint-icon" />{' '}
        to open it in {isElectron ? 'a separate window' : 'a new tab'}.
      </span>
      <button type="button" className="btn-xs btn-ghost chat-in-place-hint-dismiss" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}

type ToolbarPanel = ReturnType<typeof useTaxonomyStore.getState>['toolbarPanel'];
type RenameChat = ReturnType<typeof useChatStore.getState>['renameChat'];
type LoadSessions = ReturnType<typeof useChatStore.getState>['loadSessions'];
type CopyItem = ReturnType<typeof useCommunityStore.getState>['copyItem'];
type ResizeHandler = ReturnType<typeof useResizablePanel>['onMouseDown'];

// ── Left pane: toolbar panel variant ──

interface ToolbarLeftPanelProps {
  toolbarPanel: ToolbarPanel;
  promptInspectorActive: boolean;
  width: number;
  isPhone: boolean;
  setSearchPreviewId: Dispatch<SetStateAction<string | null>>;
  setLineagePreviewValue: Dispatch<SetStateAction<string | null>>;
  setSelectedPromptEntry: Dispatch<SetStateAction<PromptCatalogEntry | null>>;
  setPromptInspectorActive: Dispatch<SetStateAction<boolean>>;
}

function ToolbarLeftPanel({
  toolbarPanel, promptInspectorActive, width, isPhone,
  setSearchPreviewId, setLineagePreviewValue, setSelectedPromptEntry, setPromptInspectorActive,
}: ToolbarLeftPanelProps) {
  return (
    <div className={`list-panel${isFullWidthPanel(toolbarPanel, promptInspectorActive) ? ' list-panel-full' : ''}`}
         // eslint-disable-next-line local/no-inline-style -- dynamic resizable panel width
         style={isFullWidthPanel(toolbarPanel, promptInspectorActive) ? undefined : { width }}>
      {isPhone && <PhoneToolClose />}
      <ToolbarPaneRenderer
        panel={toolbarPanel}
        onSelectResult={setSearchPreviewId}
        onSelectLineageValue={setLineagePreviewValue}
        onSelectPrompt={setSelectedPromptEntry}
        onInspectorToggle={setPromptInspectorActive}
      />
    </div>
  );
}

// ── Left pane: "My" chats list ──

interface MyChatsListProps {
  sessions: ChatSessionSummary[];
  sessionsLoading: boolean;
  activeChatId: string | null;
  chatGenerating: boolean;
  chatActivity: string | null;
  renamingId: string | null;
  renameValue: string;
  setRenameValue: Dispatch<SetStateAction<string>>;
  renameChat: RenameChat;
  setRenamingId: Dispatch<SetStateAction<string | null>>;
  confirmDeleteId: string | null;
  handleDelete: (id: string) => Promise<void>;
  setConfirmDeleteId: Dispatch<SetStateAction<string | null>>;
  handleSelect: (session: ChatSessionSummary) => void;
}

function MyChatsList({
  sessions, sessionsLoading, activeChatId, chatGenerating, chatActivity,
  renamingId, renameValue, setRenameValue, renameChat, setRenamingId,
  confirmDeleteId, handleDelete, setConfirmDeleteId, handleSelect,
}: MyChatsListProps) {
  return (
    <div className="list-panel-items">
      {sessionsLoading && sessions.length === 0 && (
        <div className="chat-session-empty">Loading...</div>
      )}
      {!sessionsLoading && sessions.length === 0 && (
        <div className="chat-session-empty">
          Talk AI policy through with one of three perspectives.
          <br />
          Click <strong>+ New</strong> to start one.
        </div>
      )}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`chat-session-item ${s.id === activeChatId ? 'selected' : ''}`}
          onClick={() => handleSelect(s)}
        >
          {renamingId === s.id ? (
            <input
              className="chat-session-item-rename"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renameValue.trim()) {
                  e.stopPropagation();
                  void renameChat(s.id, renameValue.trim());
                  setRenamingId(null);
                } else if (e.key === 'Escape') {
                  setRenamingId(null);
                }
              }}
              onBlur={() => {
                if (renameValue.trim() && renameValue.trim() !== s.title) {
                  void renameChat(s.id, renameValue.trim());
                }
                setRenamingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <div
              className="chat-session-item-title"
              onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(s.id); setRenameValue(s.title); }}
              title="Double-click to rename"
            >
              {s.title}
            </div>
          )}
          <div className="chat-session-item-meta">
            <span className={`chat-mode-badge mode-${s.mode}`}>
              {MODE_LABELS[s.mode] || s.mode}
            </span>
            {rowCampChip(s, 'my')}
            {s.id === activeChatId && chatGenerating ? (
              <span className="chat-session-generating">
                <span className="dot-animation" />
                {chatActivity || 'Generating...'}
              </span>
            ) : (
              <span className="chat-session-item-date">{formatDate(s.updated_at)}</span>
            )}
          </div>
          {confirmDeleteId === s.id ? (
            <div className="chat-session-item-confirm">
              <span>Delete?</span>
              <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); void handleDelete(s.id); }}>Yes</button>
              <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}>No</button>
            </div>
          ) : (
            <div className="chat-session-item-actions" onClick={(e) => e.stopPropagation()}>
              <CopyLinkButton hash={`#chat-window?id=${s.id}`} title="Copy link to this chat" />
              <button
                className="chat-session-item-delete"
                title="Delete chat"
                onClick={() => setConfirmDeleteId(s.id)}
              >
                &times;
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Left pane: "Community" chats list ──

interface CommunityChatsListProps {
  communityChats: CommunityChat[];
  communityLoading: boolean;
  selectedCommunityChat: CommunityChat | null;
  setSelectedCommunityChat: (chat: CommunityChat | null) => void;
  copyingId: string | null;
  setCopyingId: Dispatch<SetStateAction<string | null>>;
  copyItem: CopyItem;
  loadSessions: LoadSessions;
}

function CommunityChatsList({
  communityChats, communityLoading, selectedCommunityChat, setSelectedCommunityChat,
  copyingId, setCopyingId, copyItem, loadSessions,
}: CommunityChatsListProps) {
  return (
    <div className="list-panel-items">
      {communityLoading && communityChats.length === 0 && (
        <div className="chat-session-empty">Loading community chats...</div>
      )}
      {!communityLoading && communityChats.length === 0 && (
        <div className="chat-session-empty">No community chats available yet.</div>
      )}
      {communityChats.map((cc) => (
        <div
          key={cc.id}
          className={`chat-session-item${selectedCommunityChat?.id === cc.id ? ' selected' : ''}`}
          onClick={() => setSelectedCommunityChat(cc)}
        >
          <div className="chat-session-item-title">{cc.title}</div>
          <div className="chat-session-item-meta">
            {cc.mode && (
              <span className={`chat-mode-badge mode-${cc.mode}`}>
                {MODE_LABELS[cc.mode as ChatMode] || cc.mode}
              </span>
            )}
            {rowCampChip(cc, 'community')}
            <span className="chat-session-item-date">{formatDate(cc.updated_at)}</span>
          </div>
          <div className="chat-community-copy-row">
            <button
              className="btn btn-sm chat-community-copy-btn"
              disabled={copyingId === cc.id}
              onClick={async (e) => {
                e.stopPropagation();
                setCopyingId(cc.id);
                try {
                  await copyItem('chats', cc.id);
                  void loadSessions();
                } catch (err) {
                  getGlobalRecorder()?.record({
                    type: 'system.error',
                    component: 'chat-tab',
                    level: 'error',
                    message: 'Failed to copy community chat',
                    error: { name: (err as Error).name ?? 'Error', message: String(err) },
                  });
                } finally {
                  setCopyingId(null);
                }
              }}
            >
              {copyingId === cc.id ? 'Copying...' : 'Copy to My'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Left pane: expanded session list ──

interface SessionListPanelProps extends MyChatsListProps, CommunityChatsListProps {
  width: number;
  listView: 'my' | 'community' | null;
  setListView: Dispatch<SetStateAction<'my' | 'community' | null>>;
  setListCollapsed: Dispatch<SetStateAction<boolean>>;
  chatError: string | null;
  isPhone: boolean;
  /** t/4536 round 3, point 8 — the same getting-started card as the desktop table-mode
   *  LibraryListPage `intro` slot, at the top of the phone list. */
  onPickStarter: (mode: ChatMode, topic: string) => void;
  /** Opens NewChatDialog unprefilled — distinct from onPickStarter so a stale chip-prefill
   *  from a previous click never leaks into a plain "+ New". */
  onNewChat: () => void;
}

function SessionListPanel({
  width, listView, setListView, setListCollapsed,
  sessions, sessionsLoading, activeChatId, chatError, isPhone, onPickStarter, onNewChat,
  chatGenerating, chatActivity, renamingId, renameValue, setRenameValue,
  renameChat, setRenamingId, confirmDeleteId, handleDelete, setConfirmDeleteId, handleSelect,
  communityChats, communityLoading, selectedCommunityChat, setSelectedCommunityChat,
  copyingId, setCopyingId, copyItem, loadSessions,
}: SessionListPanelProps) {
  return (
    <div
      className="list-panel chat-session-list"
      // eslint-disable-next-line local/no-inline-style -- dynamic resizable panel width
      style={{ width }}
    >
      <div className="list-panel-header">
        <h2>Chats</h2>
        <div className="list-panel-header-actions">
          <button className="btn btn-sm" onClick={() => { onNewChat(); setListView('my'); }}>
            + New
          </button>
          <button className="pane-collapse-btn" onClick={() => setListCollapsed(true)} title="Collapse" aria-label="Collapse panel">&lsaquo;</button>
        </div>
      </div>
      <ChatGettingStarted hasNoChats={sessions.length === 0} onPickStarter={onPickStarter} />
      <div className="list-view-tabs">
        <button className={`list-view-tab${listView === 'my' ? ' active' : ''}`} onClick={() => setListView('my')}>My ({sessions.length})</button>
        <button className={`list-view-tab${listView === 'community' ? ' active' : ''}`} onClick={() => setListView('community')}>Community ({communityChats.length})</button>
      </div>
      {chatError && isPhone && !activeChatId && (
        <div className="chat-error chat-tab-error-inline">{chatError}</div>
      )}
      {listView === 'my' ? (
        <MyChatsList
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          activeChatId={activeChatId}
          chatGenerating={chatGenerating}
          chatActivity={chatActivity}
          renamingId={renamingId}
          renameValue={renameValue}
          setRenameValue={setRenameValue}
          renameChat={renameChat}
          setRenamingId={setRenamingId}
          confirmDeleteId={confirmDeleteId}
          handleDelete={handleDelete}
          setConfirmDeleteId={setConfirmDeleteId}
          handleSelect={handleSelect}
        />
      ) : (
        <CommunityChatsList
          communityChats={communityChats}
          communityLoading={communityLoading}
          selectedCommunityChat={selectedCommunityChat}
          setSelectedCommunityChat={setSelectedCommunityChat}
          copyingId={copyingId}
          setCopyingId={setCopyingId}
          copyItem={copyItem}
          loadSessions={loadSessions}
        />
      )}
    </div>
  );
}

// ── Right pane: context-dependent detail ──

interface RightPaneProps {
  toolbarPanel: ToolbarPanel;
  promptInspectorActive: boolean;
  onMouseDown: ResizeHandler;
  searchPreviewId: string | null;
  setSearchPreviewId: Dispatch<SetStateAction<string | null>>;
  selectedPromptEntry: PromptCatalogEntry | null;
  lineagePreviewValue: string | null;
  setLineagePreviewValue: Dispatch<SetStateAction<string | null>>;
  isPhone: boolean;
  listView: 'my' | 'community' | null;
  selectedCommunityChat: CommunityChat | null;
}

// t/4690: the chat-vs-community-read-only detail, shared by the split-view RightPane and table
// mode's in-place detail branch — both show the same thing once an item is open, they just differ
// in what surrounds it (a resizable sidebar vs. the full-width table-mode shell). Carries the
// one-time first-open hint (never on phone, per t/4686#1) since every in-place open goes through here.
function ChatDetailContent({ listView, selectedCommunityChat, isPhone }: {
  listView: 'my' | 'community' | null;
  selectedCommunityChat: CommunityChat | null;
  isPhone: boolean;
}) {
  return (
    <div className="chat-detail-content">
      {!isPhone && <ChatInPlaceHint />}
      {listView === 'community' && selectedCommunityChat ? (
        <CommunityChatDetail chat={selectedCommunityChat} />
      ) : (
        <ChatWorkspace />
      )}
    </div>
  );
}

// t/4690: table mode's own branching (library vs. in-place detail), pulled out of ChatTab so
// ChatTab's own complexity doesn't absorb it (complexity-budget) — same reasoning as
// NewChatDialogHost below.
interface ChatTableModeProps {
  activeChatId: string | null;
  selectedCommunityChat: CommunityChat | null;
  listView: 'my' | 'community' | null;
  isPhone: boolean;
  chatLibraryConfig: ReturnType<typeof buildChatLibraryListConfig>;
  sessions: ChatSessionSummary[];
  sessionsLoading: boolean;
  communityChats: CommunityChat[];
  communityLoading: boolean;
  openChatInPlace: (id: string, source: 'my' | 'community') => void;
  onPickStarter: (mode: ChatMode, topic: string) => void;
}

function ChatTableMode({
  activeChatId, selectedCommunityChat, listView, isPhone, chatLibraryConfig,
  sessions, sessionsLoading, communityChats, communityLoading, openChatInPlace, onPickStarter,
}: ChatTableModeProps) {
  return (
    // eslint-disable-next-line local/no-inline-style -- table mode fills the tab width
    <div className="chat-tab-table-shell" style={{ flex: 1, width: '100%' }}>
      {(activeChatId || selectedCommunityChat) ? (
        <ChatDetailContent listView={listView} selectedCommunityChat={selectedCommunityChat} isPhone={isPhone} />
      ) : (
        <LibraryListPage
          config={chatLibraryConfig}
          myRows={sessions}
          myLoading={sessionsLoading}
          communityRows={communityChats}
          communityLoading={communityLoading}
          onOpenMy={id => openChatInPlace(id, 'my')}
          onOpenCommunity={id => openChatInPlace(id, 'community')}
          intro={<ChatGettingStarted hasNoChats={sessions.length === 0} onPickStarter={onPickStarter} />}
          defaultCommunityOnWeb={true}
          restoreKey="chat"
        />
      )}
    </div>
  );
}

function RightPane({
  toolbarPanel, promptInspectorActive, onMouseDown, searchPreviewId, setSearchPreviewId,
  selectedPromptEntry, lineagePreviewValue, setLineagePreviewValue, isPhone,
  listView, selectedCommunityChat,
}: RightPaneProps) {
  return (
    isFullWidthPanel(toolbarPanel, promptInspectorActive) ? null
      : toolbarPanel === 'search' ? (
      <>
        <div className="resize-handle" onMouseDown={onMouseDown} />
        <div className="detail-panel">
          <SearchPreview searchPreviewId={searchPreviewId} onClear={() => setSearchPreviewId(null)} />
        </div>
      </>
    ) : (toolbarPanel === 'prompts' && !promptInspectorActive) ? (
      <>
        <div className="resize-handle" onMouseDown={onMouseDown} />
        <div className="detail-panel">
          <PromptDetailPanel entry={selectedPromptEntry} />
        </div>
      </>
    ) : toolbarPanel === 'lineage' ? (
      <>
        <div className="resize-handle" onMouseDown={onMouseDown} />
        <div className="detail-panel">
          <LineageDetailView value={lineagePreviewValue} onSelectValue={setLineagePreviewValue} />
        </div>
      </>
    ) : toolbarPanel ? (
      <>
        <div className="resize-handle" onMouseDown={onMouseDown} />
        <div className="detail-panel">
          <div className="detail-panel-empty">Select an item in the {toolbarPanel} panel</div>
        </div>
      </>
    ) : (
      <>
        <div className="resize-handle" onMouseDown={onMouseDown} />
        <div className="detail-panel chat-workspace-container">
          <ChatDetailContent listView={listView} selectedCommunityChat={selectedCommunityChat} isPhone={isPhone} />
        </div>
      </>
    )
  );
}

// t/4536 round 3 — NewChatDialog's open/prefill state + handlers, extracted to its own hook so
// ChatTab's own complexity doesn't absorb the chip-prefill branching (complexity-budget).
// Starter chips prefill the dialog's mode + topic rather than a composer, since none exists
// before a chat is created.
function useNewChatDialog() {
  const [show, setShow] = useState(false);
  const [prefill, setPrefill] = useState<{ mode: ChatMode; topic: string } | null>(null);
  const pickStarter = useCallback((mode: ChatMode, topic: string) => {
    setPrefill({ mode, topic });
    setShow(true);
  }, []);
  const openUnprefilled = useCallback(() => {
    setPrefill(null);
    setShow(true);
  }, []);
  const close = useCallback(() => {
    setShow(false);
    setPrefill(null);
  }, []);
  return { show, prefill, pickStarter, openUnprefilled, close };
}

// t/4896: All/None/Delete N/Done — same set as Debate's editModeActions minus Reset Order.
// Pulled out of ChatTab (complexity-budget) rather than inlined, same reasoning as
// ChatTableMode/NewChatDialogHost elsewhere in this file.
function buildChatEditModeActions({ sessions, selectedIds, setSelectedIds, setShowBulkDeleteConfirm, exitEditMode }: {
  sessions: ChatSessionSummary[];
  selectedIds: Set<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setShowBulkDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  exitEditMode: () => void;
}): LibraryEditModeAction[] {
  return [
    { label: 'All', onClick: () => setSelectedIds(new Set(sessions.map(s => s.id))) },
    { label: 'None', onClick: () => setSelectedIds(new Set()) },
    ...(selectedIds.size > 0 ? [{ label: `Delete ${selectedIds.size}`, variant: 'danger' as const, onClick: () => setShowBulkDeleteConfirm(true) }] : []),
    { label: 'Done', onClick: exitEditMode },
  ];
}

export function ChatTab() {
  const {
    sessions, sessionsLoading, loadSessions,
    activeChatId, loadChat, deleteChat, renameChat,
    chatGenerating, chatActivity, chatError, chatLoading,
    activeCommunityChat: selectedCommunityChat, setActiveCommunityChat: setSelectedCommunityChat,
  } = useChatStore();
  const { toolbarPanel } = useTaxonomyStore();
  const { width, onMouseDown } = useResizablePanel();
  const breakpoint = useBreakpoint();
  const isPhone = breakpoint === 'phone' || breakpoint === 'phone-lg';
  const {
    show: showNewDialog, prefill: chatPrefill,
    pickStarter: handlePickStarter, openUnprefilled: handleNewChat, close: closeNewChatDialog,
  } = useNewChatDialog();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // t/4896: table-view edit mode (select + bulk delete), My rows only — mirrors DebateTab's
  // editMode/selectedIds/showBulkDeleteConfirm state, minus Reset Order (Chat has no custom
  // ordering).
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [selectedPromptEntry, setSelectedPromptEntry] = useState<PromptCatalogEntry | null>(PROMPT_CATALOG[0]);
  const [promptInspectorActive, setPromptInspectorActive] = useState(false);
  const [searchPreviewId, setSearchPreviewId] = useState<string | null>(null);
  const [lineagePreviewValue, setLineagePreviewValue] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [listCollapsed, setListCollapsed] = useState(false);
  const [listView, setListView] = useState<'my' | 'community' | null>(null);
  const { chats: communityChats, loading: communityLoading, fetchChats: fetchCommunityChats, copyItem, removeItem, renameItem } = useCommunityStore();
  // Used by the phone/split-view CommunityChatsList only — the table-mode Copy action goes
  // through LibraryListPage's shared actions column (handleCopyChat) instead.
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const isTableMode = !toolbarPanel && !isPhone;

  // t/4690: table mode's row click now opens in place (as a t/4640 place, /chat/:id), matching
  // split mode's handleSelect below — ⧉/Ctrl-click still goes through the shell's
  // openPlaceInNewWindow via chatLibraryListConfig's itemPlace, unaffected by this.
  // t/4888 (Design review): opening Community must NOT null activeChat/activeChatId — a reply
  // still generating in the user's own chat would silently drop (t/4687#1). placeOf.ts's chat
  // resolver instead gives activeCommunityChat precedence when set; only opening a My item
  // clears the community selection (below), not the other direction.
  const openChatInPlace = useCallback((id: string, source: 'my' | 'community') => {
    setListView(source);
    if (source === 'my') {
      if (id !== activeChatId) {
        setSelectedCommunityChat(null);
        void loadChat(id);
      }
      return;
    }
    const cc = communityChats.find(c => c.id === id);
    if (cc) setSelectedCommunityChat(cc);
  }, [activeChatId, loadChat, communityChats, setSelectedCommunityChat]);

  const handleExportChat = useCallback((id: string, format: string) => {
    void api.loadChatSession(id).then((raw) => {
      const session = raw as ChatSession;
      return api.exportChatToFile(
        session.transcript,
        format as 'markdown' | 'text' | 'pdf' | 'json',
        { title: session.topic, mode: session.mode, pov: session.pover },
      );
    }).catch((err: unknown) => {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-tab', level: 'error', message: 'Export failed', error: { name: (err as Error).name ?? 'Error', message: String(err) } });
    });
  }, []);

  const handleShareChat = useCallback((session: ChatSessionSummary) => {
    void api.loadChatSession(session.id).then((full) => {
      return api.submitToCommunity('chat', full as unknown);
    }).catch((err: unknown) => {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-tab', level: 'error', message: 'Share failed', error: { name: (err as Error).name ?? 'Error', message: String(err) } });
    });
  }, []);

  const handleCopyChat = useCallback((cc: CommunityChat) => {
    void copyItem('chats', cc.id).then(() => {
      void loadSessions();
    }).catch((err: unknown) => {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-tab', level: 'error', message: 'Failed to copy community chat', error: { name: (err as Error).name ?? 'Error', message: String(err) } });
    });
  }, [copyItem, loadSessions]);

  const exitEditMode = useCallback(() => {
    setEditMode(false);
    setSelectedIds(new Set());
  }, []);

  // t/4898 (Design t/4898#4): admin rename/delete on Community rows.
  const handleAdminRenameChat = useCallback((cc: CommunityChat, title: string) => {
    renameItem('chats', cc.id, title).catch((err: unknown) => {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-tab', level: 'error', message: 'Failed to admin-rename community chat', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    });
  }, [renameItem]);

  // t/51: returns the promise and rethrows after recording, so LibraryListPage's bulk admin-delete
  // (t/49) can tell which rows failed and keep them selected; LibraryListPage owns the user feedback.
  const handleAdminDeleteChat = useCallback((cc: CommunityChat, reason?: string) => {
    return removeItem('chats', cc.id, reason).catch((err: unknown) => {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-tab', level: 'error', message: 'Failed to admin-delete community chat', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      throw err;
    });
  }, [removeItem]);

  const editModeActions = buildChatEditModeActions({
    sessions, selectedIds, setSelectedIds, setShowBulkDeleteConfirm, exitEditMode,
  });

  const chatLibraryConfig = useMemo(() => buildChatLibraryListConfig({
    onRename: (id, newTitle) => { void renameChat(id, newTitle); },
    renamingId,
    setRenamingId,
    onNew: handleNewChat,
    onExportMy: handleExportChat,
    onExportCommunity: handleExportChat,
    onShare: handleShareChat,
    onCopy: handleCopyChat,
    adminRename: handleAdminRenameChat,
    adminDelete: handleAdminDeleteChat,
    editModeActive: editMode,
    onEditModeEnter: () => setEditMode(true),
    onEditModeExit: exitEditMode,
    editModeActions,
    selectedIds,
    onToggleSelect: (id) => setSelectedIds(prev => {
      if (!sessions.some(s => s.id === id)) return prev; // guard: stray id can't reach bulk delete
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    }),
  }), [renameChat, renamingId, handleExportChat, handleShareChat, handleCopyChat, handleAdminRenameChat, handleAdminDeleteChat, editMode, exitEditMode, editModeActions, selectedIds, sessions]);

  useEffect(() => {
    void loadSessions();
    void fetchCommunityChats();
  }, [loadSessions, fetchCommunityChats]);

  useEffect(() => {
    if (listView !== null) return;
    if (sessionsLoading) return;
    setListView(sessions.length > 0 ? 'my' : 'community');
  }, [listView, sessionsLoading, sessions.length]);

  // Auto-select the most-recent chat into pane 2 on first open (t/2760).
  // Suppressed on phone and in table mode: both are list-first (t/4690 — table mode now has a
  // real list-vs-detail state instead of always showing the library) and the user initiates
  // detail view by tapping/clicking a row.
  useEffect(() => {
    if (isPhone || isTableMode) return;
    // chatLoading: a chat is already on its way (e.g. a restored /chat/:id) — don't race it.
    if (activeChatId || selectedCommunityChat || chatLoading) return;
    if (sessionsLoading || communityLoading) return;
    if (sessions.length > 0) {
      const newest = [...sessions].sort((a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )[0];
      expectReplace(`chat:${newest.id}`); // t/4640#40: an auto-open is not a Back step
      void loadChat(newest.id);
    } else if (communityChats.length > 0) {
      const newest = [...communityChats].sort((a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )[0];
      setSelectedCommunityChat(newest);
    }
  }, [isPhone, activeChatId, selectedCommunityChat, chatLoading, sessionsLoading, communityLoading, sessions, communityChats, loadChat]);

  const handleSelect = (session: ChatSessionSummary) => {
    if (session.id !== activeChatId) {
      setSelectedCommunityChat(null);
      void loadChat(session.id);
    }
  };

  // t/89: caught here because deleteChat rethrows a failed delete once t/93 lands, and the
  // split-list "Yes" button fires this as `void handleDelete(id)`. The store records the error
  // and sets chatError, so this only keeps the rejection from going unhandled.
  const handleDelete = async (id: string) => {
    try {
      await deleteChat(id);
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'chat-tab', level: 'warn', message: `Failed to delete chat ${id} (WARN: the store reports it via chatError)`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
    setConfirmDeleteId(null);
  };

  return (
    <div className={`two-column${isPhone ? ' phone-mode' : ''}${(isPhone && activeChatId && !toolbarPanel) ? ' has-selection' : ''}${isTableMode ? ' chat-tab-table-mode' : ''}`}>
      {/* Left pane: Session list OR toolbar panel */}
      {toolbarPanel ? (
        <ToolbarLeftPanel
          toolbarPanel={toolbarPanel}
          promptInspectorActive={promptInspectorActive}
          width={width}
          isPhone={isPhone}
          setSearchPreviewId={setSearchPreviewId}
          setLineagePreviewValue={setLineagePreviewValue}
          setSelectedPromptEntry={setSelectedPromptEntry}
          setPromptInspectorActive={setPromptInspectorActive}
        />
      ) : isTableMode ? (
        <ChatTableMode
          activeChatId={activeChatId}
          selectedCommunityChat={selectedCommunityChat}
          listView={listView}
          isPhone={isPhone}
          chatLibraryConfig={chatLibraryConfig}
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          communityChats={communityChats}
          communityLoading={communityLoading}
          openChatInPlace={openChatInPlace}
          onPickStarter={handlePickStarter}
        />
      ) : listCollapsed ? (
        <div className="pane-collapsed pane-collapsed-list" onClick={() => setListCollapsed(false)} title="Expand list">
          <span className="pane-collapsed-label">Chats</span>
        </div>
      ) : (
        <SessionListPanel
          width={width}
          listView={listView}
          setListView={setListView}
          setListCollapsed={setListCollapsed}
          sessions={sessions}
          sessionsLoading={sessionsLoading}
          activeChatId={activeChatId}
          chatError={chatError}
          isPhone={isPhone}
          onPickStarter={handlePickStarter}
          onNewChat={handleNewChat}
          chatGenerating={chatGenerating}
          chatActivity={chatActivity}
          renamingId={renamingId}
          renameValue={renameValue}
          setRenameValue={setRenameValue}
          renameChat={renameChat}
          setRenamingId={setRenamingId}
          confirmDeleteId={confirmDeleteId}
          handleDelete={handleDelete}
          setConfirmDeleteId={setConfirmDeleteId}
          handleSelect={handleSelect}
          communityChats={communityChats}
          communityLoading={communityLoading}
          selectedCommunityChat={selectedCommunityChat}
          setSelectedCommunityChat={setSelectedCommunityChat}
          copyingId={copyingId}
          setCopyingId={setCopyingId}
          copyItem={copyItem}
          loadSessions={loadSessions}
        />
      )}

      {/* Right pane: split view only — table mode fills the tab with its own in-place detail branch */}
      {!toolbarPanel && !isTableMode && <RightPane
        toolbarPanel={toolbarPanel}
        promptInspectorActive={promptInspectorActive}
        onMouseDown={onMouseDown}
        searchPreviewId={searchPreviewId}
        setSearchPreviewId={setSearchPreviewId}
        selectedPromptEntry={selectedPromptEntry}
        lineagePreviewValue={lineagePreviewValue}
        setLineagePreviewValue={setLineagePreviewValue}
        isPhone={isPhone}
        listView={listView}
        selectedCommunityChat={selectedCommunityChat}
      />}

      {showNewDialog && (
        <NewChatDialogHost prefill={chatPrefill} onClose={closeNewChatDialog} />
      )}

      {showBulkDeleteConfirm && (
        <ChatBulkDeleteDialog
          sessions={sessions}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          setShowBulkDeleteConfirm={setShowBulkDeleteConfirm}
          exitEditMode={exitEditMode}
          deleteChat={deleteChat}
        />
      )}
    </div>
  );
}

// ── Table-view bulk delete confirmation (t/4896, mirrors DebateTab's BulkDeleteDialog) ──

function ChatBulkDeleteDialog({
  sessions, selectedIds, setSelectedIds, setShowBulkDeleteConfirm, exitEditMode, deleteChat,
}: {
  sessions: ChatSessionSummary[];
  selectedIds: Set<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setShowBulkDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  exitEditMode: () => void;
  deleteChat: (id: string) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  // t/4896 (Design): a failed delete must not strand the dialog on "Deleting…" or hide which
  // ones succeeded — track per-id outcome, keep the dialog open and the failed ids selected on
  // any failure so the user can see what happened and retry just those.
  const [partialError, setPartialError] = useState<{ deletedCount: number; total: number; failedTitles: string; message?: string } | null>(null);
  // t/4901: Esc mirrors the existing overlay-click guard below — disabled while deleting.
  const { dialogRef, titleId } = useDialog({ onCancel: () => setShowBulkDeleteConfirm(false), closeOnEscape: !deleting });

  const handleConfirm = async () => {
    setDeleting(true);
    setPartialError(null);
    const ids = Array.from(selectedIds);
    const failedIds: string[] = [];
    let lastErr: unknown = null;
    let deletedCount = 0;
    for (const id of ids) {
      try {
        await deleteChat(id);
        deletedCount++;
      } catch (err) {
        failedIds.push(id);
        lastErr = err;
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'chat-tab', level: 'warn',
          message: `Failed to delete chat ${id} during bulk delete (WARN: continuing with the remaining selected chats)`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      }
    }
    setDeleting(false);
    if (failedIds.length === 0) {
      setShowBulkDeleteConfirm(false);
      exitEditMode();
      return;
    }
    setSelectedIds(new Set(failedIds));
    const failedTitles = failedIds.map(id => sessions.find(s => s.id === id)?.title ?? id).join(', ');
    // t/89 (mirrors InquiryTab's BulkDeleteInquiryDialog): a single-item selection that fails gets
    // its own reason; a multi-item batch keeps the aggregate "Couldn't delete: X" message.
    // t/109: 'operation', so a 429 on a delete doesn't advise switching AI models (t/108).
    const message = ids.length === 1 ? mapErrorToUserMessage(lastErr, { kind: 'operation' }) : undefined;
    setPartialError({ deletedCount, total: ids.length, failedTitles, message });
  };

  return (
    <div className="dialog-overlay" onClick={() => !deleting && setShowBulkDeleteConfirm(false)}>
      <div ref={dialogRef} className="dialog chat-bulk-delete-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 id={titleId}>Delete {selectedIds.size} chat{selectedIds.size !== 1 ? 's' : ''}?</h3>
        <div className="chat-bulk-delete-list">
          {sessions.filter(s => selectedIds.has(s.id)).map(s => (
            <div key={s.id} className="chat-bulk-delete-item">
              <span className="chat-bulk-delete-item-title">{s.title}</span>
              <span className="chat-bulk-delete-item-meta">{MODE_LABELS[s.mode] || s.mode} &middot; {formatDate(s.updated_at)}</span>
            </div>
          ))}
        </div>
        {partialError ? (
          <div className="chat-bulk-delete-error" role="alert">
            {partialError.message
              ? `Deleted ${partialError.deletedCount} of ${partialError.total}. ${partialError.message}`
              : `Deleted ${partialError.deletedCount} of ${partialError.total}. Couldn't delete: ${partialError.failedTitles}.`}
          </div>
        ) : (
          <div className="chat-bulk-delete-note">This can't be undone.</div>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={() => setShowBulkDeleteConfirm(false)} disabled={deleting}>Cancel</button>
          <button
            className="btn btn-danger"
            disabled={deleting}
            onClick={() => void handleConfirm()}
          >
            {deleting ? 'Deleting…' : `Delete ${selectedIds.size} chat${selectedIds.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Thin host so the chatPrefill?.mode / chatPrefill?.topic optional-chains live in their own
// function scope, not ChatTab's own complexity count (local/complexity-budget).
function NewChatDialogHost({ prefill, onClose }: {
  prefill: { mode: ChatMode; topic: string } | null;
  onClose: () => void;
}) {
  return <NewChatDialog initialMode={prefill?.mode} initialTopic={prefill?.topic} onClose={onClose} />;
}

// ── Community Chat Detail ──

function speakerLabel(speaker: string): string {
  if (speaker === 'user') return 'You';
  if (speaker === 'system') return 'System';
  const info = POVER_INFO[speaker as keyof typeof POVER_INFO];
  return info?.label || speaker;
}

function speakerColor(speaker: string): string | undefined {
  if (speaker === 'user' || speaker === 'system') return undefined;
  return POVER_INFO[speaker as keyof typeof POVER_INFO]?.color;
}

function CommunityChatPoverRow({ full }: { full: ChatSession | null }) {
  const poverInfo = full?.pover ? POVER_INFO[full.pover as keyof typeof POVER_INFO] : null;
  if (!full || !poverInfo) return null;
  return (
    <div className="debate-detail-debaters-row">
      <h3>Talking to</h3>
      <div className="debate-detail-povers">
        <span
          className="debate-detail-pover"
          // eslint-disable-next-line local/no-inline-style -- dynamic POVer camp color
          style={{ borderColor: poverInfo.color }}
        >
          {poverInfo.label}
        </span>
      </div>
    </div>
  );
}

function CommunityChatTopicRow({ full }: { full: ChatSession | null }) {
  if (!full?.topic) return null;
  return (
    <div className="debate-detail-topic-row">
      <h3>Topic</h3>
      <div className="debate-detail-topic-scroll">
        <p className="debate-detail-topic">{full.topic}</p>
      </div>
    </div>
  );
}

function CommunityChatMetaGrid({ metadataExpanded, full, chat }: { metadataExpanded: boolean; full: ChatSession | null; chat: CommunityChat }) {
  if (!metadataExpanded) return null;
  const messageCount = full?.transcript?.length ?? 0;
  return (
    <div className="debate-detail-grid">
      {full && (
        <div className="debate-detail-section">
          <h3>Statistics</h3>
          <div className="debate-detail-stats">
            <div className="debate-detail-stat">
              <span className="debate-detail-stat-value">{messageCount}</span>
              <span className="debate-detail-stat-label">Messages</span>
            </div>
          </div>
        </div>
      )}
      {full?.chat_model && (
        <div className="debate-detail-section">
          <h3>Configuration</h3>
          <div className="debate-detail-meta-row">
            <span className="debate-detail-label">Model:</span>
            <span>{full.chat_model}</span>
          </div>
        </div>
      )}
      {chat.community_metadata && (
        <div className="debate-detail-section">
          <h3>Community Info</h3>

          <div className="debate-detail-meta-row">
            <span className="debate-detail-label">Submitted:</span>
            <span>{formatDate(chat.community_metadata.submitted_at)}</span>
          </div>
          <div className="debate-detail-meta-row">
            <span className="debate-detail-label">Approved:</span>
            <span>{formatDate(chat.community_metadata.approved_at)}</span>
          </div>
        </div>
      )}
      <div className="debate-detail-section">
        <h3>Timestamps</h3>
        <div className="debate-detail-meta-row">
          <span className="debate-detail-label">Created:</span>
          <span>{formatDate(chat.created_at)}</span>
        </div>
        <div className="debate-detail-meta-row">
          <span className="debate-detail-label">Updated:</span>
          <span>{formatDate(chat.updated_at)}</span>
        </div>
      </div>
    </div>
  );
}

function CommunityChatTranscript({ full }: { full: ChatSession | null }) {
  if (!full?.transcript || full.transcript.length === 0) return null;
  return (
    <div className="community-chat-transcript">
      <h3>Conversation</h3>
      <div className="chat-transcript community-chat-transcript-scroll">
        {full.transcript.map((entry) => {
          const color = speakerColor(entry.speaker);
          const isUser = entry.speaker === 'user';
          return (
            <div key={entry.id} className={`chat-message chat-speaker-${entry.speaker}${isUser ? ' chat-message-user' : ''}`}>
              <div className="chat-message-header">
                <span
                  className="chat-message-speaker"
                  // eslint-disable-next-line local/no-inline-style -- dynamic speaker color
                  style={color ? { color } : undefined}
                >
                  {speakerLabel(entry.speaker)}
                </span>
              </div>
              <div className="chat-message-content markdown-body">
                <Markdown remarkPlugins={[remarkGfm, remarkColorizePov]}>{entry.content}</Markdown>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Exported so the community chat deep-link popout (ChatWindow, t/2879) can render the same
// read-only detail view as the in-tab community browser — no duplicated transcript logic.
export function CommunityChatDetail({ chat }: { chat: CommunityChat }) {
  const [full, setFull] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metadataExpanded, setMetadataExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFull(null);
    setError(null);
    setLoading(true);
    api.loadCommunityChatSession(chat.id).then(raw => {
      if (cancelled) return;
      if (raw && typeof raw === 'object' && 'found' in (raw as Record<string, unknown>) && !(raw as Record<string, unknown>).found) {
        setError('Chat not found — it may have been removed.');
        return;
      }
      setFull(raw as ChatSession);
    }).catch(err => {
      if (cancelled) return;
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'community-chat-detail',
        level: 'error',
        message: 'Failed to load community chat detail',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      setError('Could not load chat details.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [chat.id]);

  return (
    <div className="community-chat-detail">
      {/* Header */}
      <div className="debate-detail-header">
        <div>
          <h2 className="debate-detail-title">{chat.title}</h2>
          <span className="community-chat-id">{chat.id}</span>
        </div>
        {chat.mode && (
          <span className={`chat-mode-badge mode-${chat.mode}`}>
            {MODE_LABELS[chat.mode as ChatMode] || chat.mode}
          </span>
        )}
      </div>

      {loading && <p className="community-chat-loading">Loading chat...</p>}
      {error && <p className="community-chat-error">{error}</p>}

      {/* POVer + Topic */}
      <CommunityChatPoverRow full={full} />
      <CommunityChatTopicRow full={full} />

      {/* Meta grid — collapsed by default */}
      <button
        className="btn-xs btn-ghost community-meta-toggle"
        onClick={() => setMetadataExpanded(v => !v)}
      >
        {metadataExpanded ? 'Details ▾' : 'Details ▸'}
      </button>
      <CommunityChatMetaGrid metadataExpanded={metadataExpanded} full={full} chat={chat} />

      {/* Transcript */}
      <CommunityChatTranscript full={full} />
    </div>
  );
}
