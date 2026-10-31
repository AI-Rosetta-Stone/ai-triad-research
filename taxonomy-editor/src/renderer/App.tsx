// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useState, Suspense, type ReactNode } from 'react';
import './App.css';
import { api } from '@bridge';
import { nodePovFromId } from '@lib/debate/nodeIdUtils';
import ErrorBoundary from '../../../lib/electron-shared/components/ErrorBoundary';
import { useTaxonomyStore, initAIModels } from './hooks/useTaxonomyStore';
import { initDebateSessions, useDebateStore } from './hooks/useDebateStore';
import { useChatStore } from './hooks/useChatStore';
import { useOpEdStore } from './hooks/useOpEdStore';
import { useInquiryStore } from './hooks/useInquiryStore';
import { useAppRoute } from './routing/useAppRoute';
import { installNavSubscriber } from './navigation/subscriber';
import { navHistory } from './navigation';
import { Toolbar } from './components/shared/Toolbar';
import { TabBar } from './components/shared/TabBar';
import { SaveBar } from './components/sync/SaveBar';
import { SaveConflictBanner } from './components/sync/SaveConflictBanner';
import { PolicyRecountNotice } from './components/PolicyRecountNotice';
import { PovTab } from './components/taxonomy/PovTab';
import { FirstRunDialog } from './components/settings/FirstRunDialog';
import { WhatsNewToast } from './components/settings/WhatsNewToast';
import { HelpDialog } from './components/settings/HelpDialog';
import { RosettaStoneTab } from './components/RosettaStoneTab';
import { DeploymentErrorScreen } from './components/shared/DeploymentErrorScreen';

import { StartupProgressScreen } from './components/shared/StartupProgressScreen';

import { initClientConfig } from './lib/clientConfig';
import { initFlightRecorder } from './lib/flightRecorderInit';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { recordingLazy } from './utils/recordingLazy';
import { initAnalyticsSession } from './lib/initAnalyticsSession';
import { useBreakpoint } from './hooks/useBreakpoint';
import { useIsTouchDevice } from './hooks/useIsTouchDevice';
import { BottomNav } from './components/shared/BottomNav';
import { HamburgerMenu } from './components/shared/HamburgerMenu';
import { useNavigationShortcuts } from './hooks/useNavigationShortcuts';
import { GitProgressBanner } from './components/sync/GitProgressBanner';
import { AnonymousBanner } from './components/community/AnonymousBanner';
import { ResilienceBanner } from './components/shared/ResilienceBanner';
import { QuotaBanner } from './components/shared/QuotaBanner';
import { EmbeddingsStaleBanner } from './components/shared/EmbeddingsStaleBanner';
import { OrphanedTagsBanner } from './components/shared/OrphanedTagsBanner';
import { RetiredModelBanner } from './components/shared/RetiredModelBanner';
import { FreeTierDisclosure } from './components/shared/FreeTierDisclosure';
import { pullDataTracked } from './utils/syncApi';
import { useFeatureFlagStore, useFlag } from './hooks/useFeatureFlags';
import { useTheoryLinkHotkey } from './hooks/useTheoryLinkHotkey';
import { PrecacheToast } from './components/shared/PrecacheToast';
import { usePrecache } from './hooks/usePrecache';
import { DiagnosticsDrawer } from './components/shared/DiagnosticsDrawer';
import { GlobalDetailPaneHost } from './components/shared/GlobalDetailPaneHost';
import { ToolbarPaneRenderer, PhoneToolClose } from './components/shared/ToolbarPaneRenderer';

// Lazy-loaded tab components — only fetched when their tab is selected
const SituationsTab = recordingLazy(() => import('./components/debate/SituationsTab').then(m => ({ default: m.SituationsTab })));
const ConflictsTab = recordingLazy(() => import('./components/conflict/ConflictsTab').then(m => ({ default: m.ConflictsTab })));
const DebateTab = recordingLazy(() => import('./components/debate/DebateTab').then(m => ({ default: m.DebateTab })));
const ChatTab = recordingLazy(() => import('./components/chat/ChatTab').then(m => ({ default: m.ChatTab })));
const OpEdTab = recordingLazy(() => import('./components/opeds/OpEdTab').then(m => ({ default: m.OpEdTab })));
const SummariesTab = recordingLazy(() => import('./components/analysis/SummariesTab').then(m => ({ default: m.SummariesTab })));
const CruxesTab = recordingLazy(() => import('./components/debate/CruxesTab').then(m => ({ default: m.CruxesTab })));
const ValidationTab = recordingLazy(() => import('./components/taxonomy/ValidationTab').then(m => ({ default: m.ValidationTab })));
const OrganizationsTab = recordingLazy(() => import('./components/organizations/OrganizationsTab').then(m => ({ default: m.OrganizationsTab })));
const InquiryTab = recordingLazy(() => import('./components/inquiry/InquiryTab').then(m => ({ default: m.InquiryTab })));

// Lazy-loaded window/panel components — separate Electron windows or hash routes
const DiagnosticsWindow = recordingLazy(() => import('./components/debate-diagnostics').then(m => ({ default: m.DiagnosticsWindow })));
const PovProgressionWindow = recordingLazy(() => import('./components/PovProgression/PovProgressionWindow').then(m => ({ default: m.PovProgressionWindow })));
const DebatePopoutWindow = recordingLazy(() => import('./components/debate/DebatePopoutWindow').then(m => ({ default: m.DebatePopoutWindow })));
const ChatWindow = recordingLazy(() => import('./components/chat/ChatWindow').then(m => ({ default: m.ChatWindow })));
const PromptDiffWindow = recordingLazy(() => import('./components/chat/PromptDiffWindow').then(m => ({ default: m.PromptDiffWindow })));
const DiffWindow = recordingLazy(() => import('./components/shared/DiffWindow').then(m => ({ default: m.DiffWindow })));
const HarvestDialog = recordingLazy(() => import('./components/shared/HarvestDialog').then(m => ({ default: m.HarvestDialog })));
const AnalyticsDashboard = recordingLazy(() => import('./components/analysis/AnalyticsDashboard').then(m => ({ default: m.AnalyticsDashboard })));
const EngagementDashboard = recordingLazy(() => import('./components/analysis/EngagementDashboard').then(m => ({ default: m.EngagementDashboard })));
const YourActivityPanel = recordingLazy(() => import('./components/analysis/YourActivityPanel').then(m => ({ default: m.YourActivityPanel })));
const CommunityLibrary = recordingLazy(() => import('./components/community/CommunityLibrary').then(m => ({ default: m.CommunityLibrary })));
const AdminPanel = recordingLazy(() => import('./components/settings/AdminPanel').then(m => ({ default: m.AdminPanel })));
const AdminReviewPanel = recordingLazy(() => import('./components/settings/AdminReviewPanel').then(m => ({ default: m.AdminReviewPanel })));

const UpdatePrompt = import.meta.env.VITE_TARGET === 'web'
  ? recordingLazy(() => import('./components/shared/UpdatePrompt').then(m => ({ default: m.UpdatePrompt })))
  : null;

const THEME_COLORS: Record<string, string> = {
  light: '#ffffff',
  dark: '#111827',
  bkc: '#1f1f1f',
  harvard: '#A51C30',
};

// Build fingerprint — changes every build to verify deployment
const BUILD_FINGERPRINT = `build-${Date.now()}`;
console.log(`[App] BUILD_FINGERPRINT: ${BUILD_FINGERPRINT}`);

// Fetch runtime config before anything that depends on it (resilience, flight recorder)
void initClientConfig();

// Initialize flight recorder as early as possible
initFlightRecorder();

import { initSwEventListener } from './lib/swEventListener';
initSwEventListener();

interface DataUpdateInfo {
  available: boolean;
  behindCount: number;
  aheadCount: number;
  diverged: boolean;
  currentCommit?: string;
  remoteCommit?: string;
  error?: string;
}

function FileViewerApp() {
  const [fileArg, setFileArg] = useState<{ type: string; path: string; data?: unknown; error?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    console.log('[FileViewer] Requesting CLI file arg...');
    api.getCliFileArg().then((arg) => {
      console.log('[FileViewer] Got CLI arg:', arg ? { type: arg.type, path: arg.path, hasData: !!arg.data, dataKeys: arg.data ? Object.keys(arg.data as Record<string, unknown>) : [] } : null);
      setFileArg(arg as { type: string; path: string; data?: unknown; error?: string } | null);
      setLoading(false);
    }).catch(err => {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'FileViewer',
        level: 'error',
        message: 'getCliFileArg failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      setLoading(false);
    });
  }, []);

  console.log('[FileViewer] Render — loading:', loading, 'fileArg:', fileArg?.type, 'hasData:', !!fileArg?.data);

  if (loading) return <div className="app-viewer-padding">Loading file...</div>;

  if (fileArg?.error) {
    return <div className="app-viewer-error">Error loading file: {fileArg.error}<br/>Path: {fileArg.path}</div>;
  }

  if (fileArg?.type === 'diagnostics' && fileArg.data) {
    return <Suspense fallback={null}><DiagnosticsWindow initialData={fileArg.data as Record<string, unknown>} /></Suspense>;
  }

  if (fileArg?.type === 'harvest' && fileArg.data) {
    const harvestData = fileArg.data as Record<string, unknown>;
    console.log('[FileViewer] Rendering harvest with data:', {
      conflicts: (harvestData.conflicts as unknown[])?.length ?? 0,
      steelmans: (harvestData.steelmans as unknown[])?.length ?? 0,
      verdicts: (harvestData.verdicts as unknown[])?.length ?? 0,
      concepts: (harvestData.concepts as unknown[])?.length ?? 0,
    });
    return (
      <div className="app-harvest-wrap">
        <h2 className="app-harvest-title">Harvest Review</h2>
        <p className="app-harvest-path">File: {fileArg.path}</p>
        <p className="app-harvest-items">
          Items: {(harvestData.conflicts as unknown[])?.length ?? 0} conflicts,
          {' '}{(harvestData.steelmans as unknown[])?.length ?? 0} steelmans,
          {' '}{(harvestData.verdicts as unknown[])?.length ?? 0} verdicts,
          {' '}{(harvestData.concepts as unknown[])?.length ?? 0} concepts
        </p>
        <Suspense fallback={null}><HarvestDialog onClose={() => window.close()} fileData={harvestData} /></Suspense>
      </div>
    );
  }

  return <div className="app-viewer-padding">
    No file data found.
    <pre className="app-viewer-pre">{JSON.stringify(fileArg, null, 2)}</pre>
  </div>;
}

/** t/4628: runs once `initAIModels()` has resolved (so the anonymous-default target reflects the
 *  LIVE ai-models.json defaults, not the bundled pre-load snapshot), applies the anonymous-session
 *  model/backend override if needed, then proceeds with the rest of app bootstrap. Shared by all
 *  four `initAIModels().then(...)` call sites so none of them can drift from the others. */
async function bootstrapAfterModelsLoaded(loadAllFn: () => void | Promise<void>): Promise<void> {
  const isAnonymous = await api.checkAnonymousSession();
  useTaxonomyStore.getState().applyAnonymousSessionDefaults(isAnonymous);
  void loadAllFn();
  initAnalyticsSession();
  initDebateSessions();
  // t/4640: install navigation subscriber to maintain history stack (buttons/shortcuts)
  // The open item lives in each tool's own store, so the subscriber listens to all of them.
  installNavSubscriber({
    taxonomy: useTaxonomyStore,
    debate: useDebateStore,
    chat: useChatStore,
    opEd: useOpEdStore,
    inquiry: useInquiryStore,
  }, navHistory);
}

// t/4722: Chat, Conflicts, Cruxes, Debate, Situations and the POV tabs mount their own
// ToolbarPaneRenderer (list-pane layout, isFullWidthPanel()). Every other tab never did, so a
// Tools-menu pick there set toolbarPanel and highlighted the menu item but rendered nothing.
// MainApp's fallback is derived from this single set, instead of a mount per missing tab — the
// drift that caused the bug in the first place, and the next new tab would repeat it. Exported
// so the regression test can assert it covers every tab, not just the ones known at the time.
export const TABS_WITH_OWN_TOOLBAR_PANE = ['situations', 'conflicts', 'cruxes', 'debate', 'chat', 'accelerationist', 'safetyist', 'skeptic'];

export function tabNeedsToolbarFallback(activeTab: string, toolbarPanel: string | null): boolean {
  return toolbarPanel !== null && !TABS_WITH_OWN_TOOLBAR_PANE.includes(activeTab);
}

/** The main tab-content body: the t/4722 toolbar-pane fallback, the POV tab shell, or the tab
 *  itself. Kept out of MainApp so MainApp stays within its complexity budget. */
function TabBody({ activeTab, toolbarPanel, showPovHeader, children }: {
  activeTab: string;
  toolbarPanel: string | null;
  showPovHeader: boolean;
  children: ReactNode;
}) {
  if (tabNeedsToolbarFallback(activeTab, toolbarPanel)) {
    return (
      <div className="list-panel list-panel-full">
        <PhoneToolClose />
        <ToolbarPaneRenderer panel={toolbarPanel} />
      </div>
    );
  }
  if (showPovHeader) {
    return (
      <div className="pov-tab-shell">
        <TabBar />
        <div className="pov-tab-shell-body">{children}</div>
      </div>
    );
  }
  return <>{children}</>;
}

export function App() {
  const [hash, setHash] = useState(window.location.hash);
  const analyticsFlag = useFlag('env-web-analytics-dashboard');
  const isAdmin = useFlag('permission-admin-features');
  const communityFlag = useFlag('env-web-community-library');
  const adminLegacyFlag = useFlag('env-web-admin-legacy');

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => { void useFeatureFlagStore.getState().refresh(); }, []);

  // F1-to-nearest TheoryLink — registered before the popout early-returns so it
  // covers the main app and every window mode App renders (t/2343).
  useTheoryLinkHotkey();

  // t/2767: defer all child mounts until window.electronAPI is ready.
  // In web mode bridgeReady starts true (no preload exists), so the gate is transparent.
  // Inline polling (not imported waitForElectronAPI) to avoid bundling electron-bridge into
  // the web build. clearInterval in cleanup handles StrictMode's discarded first mount.
  const [bridgeReady, setBridgeReady] = useState(import.meta.env.VITE_TARGET === 'web');
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  useEffect(() => {
    if (import.meta.env.VITE_TARGET === 'web') return;
    if (window.electronAPI) { setBridgeReady(true); return; }
    const TIMEOUT_MS = 2000;
    const start = performance.now();
    let done = false;
    const id = setInterval(() => {
      if (window.electronAPI) {
        clearInterval(id);
        if (done) return; done = true;
        getGlobalRecorder()?.record({
          type: 'lifecycle', component: 'electron-bridge', level: 'info',
          message: `bridge-available after ${Math.round(performance.now() - start)}ms`,
          data: { preloadTimestamp: window.electronAPI.preloadTimestamp },
        });
        setBridgeReady(true);
      } else if (performance.now() - start > TIMEOUT_MS) {
        clearInterval(id);
        if (done) return; done = true;
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'electron-bridge', level: 'error',
          message: `window.electronAPI not available after ${TIMEOUT_MS}ms — preload may have failed`,
          error: { name: 'BridgeInitError', message: 'Preload did not run in time' },
        });
        setBridgeError('Desktop bridge unavailable — restart the app');
      }
    }, 5);
    return () => { clearInterval(id); done = true; };
  }, []);

  if (bridgeError) return <div className="app-bridge-error">{bridgeError}</div>;
  if (!bridgeReady) return null;

  // If this window was opened as a diagnostics popout, render only that
  if (hash.startsWith('#diagnostics-window')) {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><DiagnosticsWindow /></Suspense></ErrorBoundary>;
  }
  if (hash === '#pov-progression-window') {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><PovProgressionWindow /></Suspense></ErrorBoundary>;
  }
  if (hash.startsWith('#debate-window')) {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><DebatePopoutWindow /></Suspense></ErrorBoundary>;
  }
  if (hash.startsWith('#prompt-diff-window')) {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><PromptDiffWindow /></Suspense></ErrorBoundary>;
  }
  if (hash.startsWith('#diff-window')) {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><DiffWindow /></Suspense></ErrorBoundary>;
  }
  if (hash.startsWith('#chat-window')) {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><ChatWindow /></Suspense></ErrorBoundary>;
  }
  if (hash === '#analytics' && analyticsFlag) {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><AnalyticsDashboard /></Suspense></ErrorBoundary>;
  }
  // Admin-only engagement analytics (t/2468). Non-admins fall through to the main
  // app — the view is unreachable — and the server independently requireAdmin-gates
  // the per-user data it serves.
  if (hash === '#engagement' && isAdmin) {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><EngagementDashboard /></Suspense></ErrorBoundary>;
  }
  // Self-only "Your Activity" view (t/2469). No admin gate — the panel requests only the
  // caller's OWN engagement subtree, and the server (t/2467) never returns other users' rows
  // to a non-admin. Reached from the Help menu (Settings-owned HelpDialog entry).
  if (hash === '#your-activity') {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><YourActivityPanel /></Suspense></ErrorBoundary>;
  }
  if (hash === '#community' && communityFlag) {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><CommunityLibrary /></Suspense></ErrorBoundary>;
  }
  if (hash === '#admin') {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><AdminReviewPanel /></Suspense></ErrorBoundary>;
  }
  if (hash === '#admin-legacy' && adminLegacyFlag) {
    return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><Suspense fallback={null}><AdminPanel /></Suspense></ErrorBoundary>;
  }

  // Route between CLI file viewer and main app
  return <ErrorBoundary buildInfo={BUILD_FINGERPRINT}><AppRouter /></ErrorBoundary>;
}

/** Handles CLI-mode detection — hooks are always called in same order */
function AppRouter() {
  const [cliMode, setCliMode] = useState<boolean | null>(null);
  useEffect(() => {
    void api.getCliFileArg().then(arg => setCliMode(!!arg));
  }, []);

  if (cliMode === null) return null; // loading
  if (cliMode) return <FileViewerApp />;
  return <MainApp />;
}

/** Main taxonomy editor application */
function MainApp() {
  const { activeTab, loading, backgroundLoading, loadingProgress, loadAll, colorScheme, paneSpacing, zoomLevel, zoomIn, zoomOut, zoomReset, toolbarPanel } = useTaxonomyStore();
  useAppRoute(); // t/3486: restore a deep-linked in-app view (e.g. /opeds/:setId) at boot + popstate.
  useNavigationShortcuts(); // t/4640: Alt+←/→ (Cmd+[/] on macOS) and mouse buttons 4/5 for back/forward
  const summariesFlag = useFlag('env-electron-summaries');
  // OR both build flags — mirrors the navConfig Op-Eds gate (anyFlag: electron||web). Gates
  // BOTH the tab render below and must stay in sync with the nav gate, else the button shows
  // (via env-web-opeds) but the panel never mounts on web → blank content area (t/2646).
  const opedsElectronFlag = useFlag('env-electron-opeds');
  const opedsWebFlag = useFlag('env-web-opeds');
  const opedsFlag = opedsElectronFlag || opedsWebFlag;
  const breakpoint = useBreakpoint();
  const isTouch = useIsTouchDevice();
  const isMobile = breakpoint === 'phone' || breakpoint === 'phone-lg' || breakpoint === 'tablet';
  const [hamburgerOpen, setHamburgerOpen] = useState(false);
  const [dataUpdate, setDataUpdate] = useState<DataUpdateInfo | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<string | null>(null);
  const activePov = ['accelerationist', 'safetyist', 'skeptic'].includes(activeTab) ? activeTab : undefined;
  const { progress: precacheProgress, cancel: cancelPrecache, dismiss: dismissPrecache } = usePrecache(activePov);
  const [changedFiles, setChangedFiles] = useState<{ path: string; status: string }[] | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [showFirstRun, setShowFirstRun] = useState(false);
  const [dataRoot, setDataRoot] = useState('');
  const [copyStatus, setCopyStatus] = useState<{ state: string; dir?: string; copied?: number; total?: number } | null>(null);
  const [showChangelogHelp, setShowChangelogHelp] = useState(false);

  useEffect(() => {
    // Check if data is available before loading
    void Promise.all([
      api.isDataAvailable(),
      api.getDataRoot().catch((err) => {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'app', level: 'warn', message: 'getDataRoot failed (expected for non-admin users)', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        return '';
      }),
      useFeatureFlagStore.getState().refresh(),
    ]).then(([available, root]) => {
      setDataRoot(root);
      if (!available) {
        setShowFirstRun(true);
      } else {
        void initAIModels().then(() => bootstrapAfterModelsLoaded(() => useTaxonomyStore.getState().loadAll()));
      }
    });
  }, []);

  // Poll copy status while showFirstRun is true in web mode
  useEffect(() => {
    const isWeb = import.meta.env.VITE_TARGET === 'web';
    if (!showFirstRun || !isWeb || !dataRoot) return;

    let cancelled = false;
    const poll = () => {
      void api.getCopyStatus().then(status => {
        if (cancelled) return;
        setCopyStatus(status);
        if (status.state === 'complete') {
          // Copy finished — re-check data availability
          void api.isDataAvailable().then(available => {
            if (cancelled) return;
            if (available) {
              setShowFirstRun(false);
              setCopyStatus(null);
              void initAIModels().then(() => bootstrapAfterModelsLoaded(() => useTaxonomyStore.getState().loadAll()));
            }
            // If still not available after copy complete, DeploymentErrorScreen will show
          });
        }
      });
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [showFirstRun, dataRoot]);

  // Check for data updates after initial load
  useEffect(() => {
    if (loading) return;
    api.checkDataUpdates()
      .then((status: unknown) => {
        const s = status as DataUpdateInfo;
        if (s.available) {
          setDataUpdate(s);
        }
      })
      .catch((err) => {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'app', level: 'warn', message: 'Data update check failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      });
  }, [loading]);

  const handlePullUpdates = async () => {
    setPulling(true);
    setPullResult(null);
    try {
      const result = await pullDataTracked(
        () => api.pullDataUpdates() as Promise<{ success: boolean; message: string }>,
      );
      if (result.success) {
        setPullResult('Updated successfully. Reloading...');
        setDataUpdate(null);
        // Reload taxonomy data with new data
        setTimeout(() => {
          void useTaxonomyStore.getState().loadAll(true);
          setPullResult(null);
        }, 1000);
      } else {
        setPullResult(`Update failed: ${result.message}`);
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'app',
        level: 'error',
        message: 'data pull failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setPullResult(`Error: ${String(err)}`);
    } finally {
      setPulling(false);
    }
  };

  const handleShowFiles = async () => {
    if (showFiles) { setShowFiles(false); return; }
    setLoadingFiles(true);
    try {
      const files = await api.getChangedFiles();
      setChangedFiles(files);
      setShowFiles(true);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'app', level: 'error',
        message: 'failed to fetch changed files',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    } finally {
      setLoadingFiles(false);
    }
  };

  const handleViewDiff = (filePath: string) => {
    void api.openDiffWindow(filePath);
  };

  const dismissUpdate = () => { setDataUpdate(null); setShowFiles(false); setChangedFiles(null); };

  // Listen for menu-triggered taxonomy reload
  useEffect(() => {
    const unsub = api.onReloadTaxonomy(() => {
      void useTaxonomyStore.getState().loadAll(true);
    });
    return unsub;
  }, []);

  // Listen for external focus-node requests (e.g. from summary-viewer)
  useEffect(() => {
    const unsub = api.onFocusNode((nodeId: string) => {
      const store = useTaxonomyStore.getState();
      // Determine which tab to navigate to based on node ID prefix
      let tab: Parameters<typeof store.navigateToNode>[0];
      const pov = nodePovFromId(nodeId);
      if (pov) {
        tab = pov as typeof tab;
      } else if (nodeId.startsWith('conflict-')) {
        tab = 'conflicts';
      } else if (nodeId.startsWith('pol-')) {
        tab = 'situations';
      } else {
        return; // Unknown prefix
      }
      store.navigateToNode(tab, nodeId);
    });
    return unsub;
  }, []);

  // Apply theme on mount and listen for system preference changes
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      let resolved: string;
      if (colorScheme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        resolved = prefersDark ? 'dark' : 'light';
      } else {
        resolved = colorScheme;
      }
      root.setAttribute('data-theme', resolved);
      document.querySelector('meta[name="theme-color"]')?.setAttribute(
        'content', THEME_COLORS[resolved] || '#ffffff',
      );
    };
    apply();

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (colorScheme === 'system') apply(); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [colorScheme]);

  // Apply zoom level. 112.5% (18px root) is the comfortable web baseline (t/2416); the zoom
  // control multiplies against it, so "zoom 100%" == the baseline and taxonomy-editor-zoom still
  // round-trips as a percentage (default 100).
  useEffect(() => {
    const BASE_FONT_PCT = 112.5;
    document.documentElement.style.fontSize = `${(BASE_FONT_PCT * zoomLevel) / 100}%`;
  }, [zoomLevel]);

  // Apply pane spacing
  useEffect(() => {
    document.documentElement.setAttribute('data-pane-spacing', paneSpacing);
  }, [paneSpacing]);

  // Close hamburger when leaving mobile breakpoints
  useEffect(() => {
    if (!isMobile) setHamburgerOpen(false);
  }, [isMobile]);

  // Apply responsive breakpoint and touch attributes
  useEffect(() => {
    document.documentElement.setAttribute('data-breakpoint', breakpoint);
  }, [breakpoint]);
  useEffect(() => {
    document.documentElement.setAttribute('data-touch', String(isTouch));
  }, [isTouch]);

  // Zoom keyboard shortcuts: Ctrl+= / Ctrl+- / Ctrl+0
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomReset();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [zoomIn, zoomOut, zoomReset]);

  // Screenshot capture: Ctrl+Shift+S — resizes to 960x600, captures, saves via dialog
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        void api.captureScreenshot({ width: 960, height: 600 });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleFirstRunComplete = () => {
    setShowFirstRun(false);
    void initAIModels().then(() => bootstrapAfterModelsLoaded(loadAll));
  };

  const handleFirstRunSkip = () => {
    setShowFirstRun(false);
    void initAIModels().then(() => bootstrapAfterModelsLoaded(loadAll));
  };

  if (showFirstRun) {
    // Container mode with configured data root = deployment error, not first run
    const isWeb = import.meta.env.VITE_TARGET === 'web';
    if (isWeb && dataRoot) {
      // Show progress screen while copy is running, error screen only after copy completes
      if (copyStatus && copyStatus.state !== 'complete' && copyStatus.state !== 'unknown') {
        return <StartupProgressScreen status={copyStatus} />;
      }
      return <DeploymentErrorScreen dataRoot={dataRoot} />;
    }
    return <FirstRunDialog dataRoot={dataRoot} onComplete={handleFirstRunComplete} onSkip={handleFirstRunSkip} />;
  }

  if (loading) {
    const { completed, total } = loadingProgress;
    const pct = total > 0 ? Math.round((completed.length / total) * 100) : 0;
    return (
      <div className="loading">
        <div className="loading-title">Loading Accelerationist Perspective...</div>
        {total > 0 && (
          <>
            <div className="loading-bar-track">
              <div
                className="loading-bar-fill"
                // eslint-disable-next-line local/no-inline-style -- width reflects loading progress percentage
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="loading-detail">
              {completed.length < 1 ? 'Loading...' : 'Initializing...'}
            </div>
          </>
        )}
      </div>
    );
  }

  // POV/Taxonomy tab header (Accelerationist/Safetyist/Skeptic) renders inside the content
  // column (t/2857) so the left nav rail spans full window height, matching Debate/Chat/Op-Eds.
  // showPovHeader mirrors the original TabBar visibility condition exactly. Layout-only.
  const showPovHeader = toolbarPanel === null &&
    !['rosetta-stone', 'situations', 'conflicts', 'cruxes', 'debate', 'chat', 'opeds', 'summaries', 'validation', 'organizations', 'inquiry'].includes(activeTab);
  const tabContent = (
    <>
      {activeTab === 'rosetta-stone' && <RosettaStoneTab />}
      {activeTab === 'accelerationist' && <PovTab pov="accelerationist" />}
      {activeTab === 'safetyist' && <PovTab pov="safetyist" />}
      {activeTab === 'skeptic' && <PovTab pov="skeptic" />}
      <Suspense fallback={<div className="loading"><div className="loading-title">Loading...</div></div>}>
        {activeTab === 'situations' && <SituationsTab />}
        {activeTab === 'conflicts' && <ConflictsTab />}
        {activeTab === 'cruxes' && <CruxesTab />}
        {activeTab === 'debate' && <DebateTab />}
        {activeTab === 'chat' && <ChatTab />}
        {activeTab === 'opeds' && opedsFlag && <OpEdTab />}
        {activeTab === 'summaries' && summariesFlag && <SummariesTab />}
        {activeTab === 'validation' && <ValidationTab />}
        {activeTab === 'organizations' && <OrganizationsTab />}
        {activeTab === 'inquiry' && <InquiryTab />}
      </Suspense>
    </>
  );

  return (
    <div className="app">
      {/* Background loading indicator for remaining POVs */}
      {backgroundLoading && (
        <div className="background-loading-banner">
          <div className="background-loading-bar" />
          <span className="background-loading-text">
            Loading remaining Perspectives... ({loadingProgress.completed.length} of {loadingProgress.total})
          </span>
        </div>
      )}
      <GitProgressBanner />
      <AnonymousBanner />
      <ResilienceBanner />
      <QuotaBanner />
      <EmbeddingsStaleBanner />
      <OrphanedTagsBanner />
      <RetiredModelBanner />
      <FreeTierDisclosure />
      {/* Data update banner */}
      {dataUpdate && (
        <div
          className="data-update-banner"
          title="The taxonomy data is hosted in a public GitHub repository. This banner appears when new commits are available that your local copy doesn't have yet."
        >
          <span
            className="data-update-text"
            title={[
              dataUpdate.diverged
                ? `Data repo has diverged: ${dataUpdate.aheadCount} commit${dataUpdate.aheadCount !== 1 ? 's' : ''} ahead, ${dataUpdate.behindCount} commit${dataUpdate.behindCount !== 1 ? 's' : ''} behind.`
                : `${dataUpdate.behindCount} new commit${dataUpdate.behindCount !== 1 ? 's' : ''} on the remote repository.`,
              dataUpdate.currentCommit ? `Local:  ${dataUpdate.currentCommit.slice(0, 8)}` : '',
              dataUpdate.remoteCommit ? `Remote: ${dataUpdate.remoteCommit.slice(0, 8)}` : '',
            ].filter(Boolean).join('\n')}
          >
            {dataUpdate.diverged
              ? `Data repo diverged — ${dataUpdate.aheadCount} ahead, ${dataUpdate.behindCount} behind`
              : `${dataUpdate.behindCount} data update${dataUpdate.behindCount !== 1 ? 's' : ''} available`}
          </span>
          <button
            className="btn btn-sm data-update-btn"
            onClick={handleShowFiles}
            disabled={loadingFiles}
            title="Show which files have been changed in the available updates"
          >
            {loadingFiles ? 'Loading...' : showFiles ? 'Hide Files' : 'Show Files'}
          </button>
          <button
            className="btn btn-sm data-update-btn"
            onClick={handlePullUpdates}
            disabled={pulling}
            title={pulling
              ? 'Downloading updates from GitHub — this may take a minute. The connection is kept alive with periodic heartbeats to prevent timeouts.'
              : 'Download the latest taxonomy data from GitHub. The data repository is public — no GitHub account or credentials are required.'}
          >
            {pulling ? 'Updating...' : 'Download'}
          </button>
          <button
            className="data-update-dismiss"
            onClick={dismissUpdate}
            title="Dismiss this notification. Updates will be checked again next time the app loads."
          >
            &times;
          </button>
          {pullResult && (
            <span
              className={`data-update-result ${pullResult.startsWith('Updated successfully') ? 'success' : 'error'}`}
              title={pullResult.startsWith('Updated successfully')
                ? 'Data updated to the latest version. The taxonomy is being reloaded with the new data.'
                : `The update failed. This is typically caused by network issues or slow connections — not by missing credentials. The data repository is public.\n\nFull error: ${pullResult}`}
            >
              {pullResult}
            </span>
          )}
          {showFiles && changedFiles && (
            <div className="data-update-files">
              <div className="app-files-count">
                {changedFiles.length} file{changedFiles.length !== 1 ? 's' : ''} changed:
              </div>
              <div className="app-files-scroll">
                {changedFiles.map(f => (
                  <div key={f.path} className="data-update-file-row">
                    <span className={`data-update-file-status data-update-file-status-${f.status}`}>
                      {f.status === 'M' ? 'MOD' : f.status === 'A' ? 'ADD' : f.status === 'D' ? 'DEL' : f.status}
                    </span>
                    <span className="data-update-file-path">{f.path}</span>
                    <button
                      className="data-update-file-diff-btn"
                      onClick={() => handleViewDiff(f.path)}
                      title={`View changes in ${f.path}`}
                    >
                      View Diff
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mobile-header">
        <button className="mobile-header-hamburger" onClick={() => setHamburgerOpen(true)} aria-label="Open menu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span className="mobile-header-title">Taxonomy Editor</span>
      </div>
      <div className="app-body">
        <Toolbar />
        <div className="tab-content">
          <TabBody activeTab={activeTab} toolbarPanel={toolbarPanel} showPovHeader={showPovHeader}>
            {tabContent}
          </TabBody>
        </div>
        {/* One app-level ref → DetailPane host for every main tab in this shell (t/1987).
            A ref-link click in PovTab/Situations/Conflicts/Cruxes/Debate sets the global
            selectedRef; this single right-rail pane resolves it. Standalone Chat / debate
            popout / EntityBrowser keep their own panes (separate contexts). */}
        <GlobalDetailPaneHost />
      </div>
      <SaveBar />
      <SaveConflictBanner />
      <PolicyRecountNotice />
      <BottomNav onOpenMore={() => setHamburgerOpen(true)} />
      {isMobile && <HamburgerMenu isOpen={hamburgerOpen} onClose={() => setHamburgerOpen(false)} />}
      {UpdatePrompt && !loading && <Suspense fallback={null}><UpdatePrompt /></Suspense>}
      <PrecacheToast progress={precacheProgress} onCancel={cancelPrecache} onDismiss={dismissPrecache} />
      <WhatsNewToast onOpenChangelog={() => setShowChangelogHelp(true)} />
      {showChangelogHelp && <HelpDialog onClose={() => setShowChangelogHelp(false)} initialTab="changelog" />}
      {isMobile && <DiagnosticsDrawer />}
    </div>
  );
}
