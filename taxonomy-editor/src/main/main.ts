// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

console.log('[main] === STARTUP BEGIN ===');
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from 'electron';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { FlightRecorder, setGlobalRecorder, getGlobalRecorder, RECORDER_CAPACITY_SECONDARY } from '../../../lib/flight-recorder/index.js';
import { migrateToSingleKey } from './apiKeyStore.js';
import { buildDebateHash } from './debateWindowUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log('[main] Core imports OK');
import { registerIpcHandlers } from './ipcHandlers.js';
console.log('[main] ipcHandlers import OK');
import { registerTerminalHandlers, cleanupTerminal } from './terminal.js';
console.log('[main] terminal import OK');
import { warmupEmbeddingModel } from './embeddings.js';
console.log('[main] embeddings import OK');
import { PROJECT_ROOT, validateDataRoot } from './fileIO.js';
console.log('[main] fileIO import OK');
import { registerChatWindowHandlers } from './ipc/chatWindowHandlers.js';

let mainWindow: BrowserWindow | null = null;
let diagWindow: BrowserWindow | null = null;
let povProgWindow: BrowserWindow | null = null;
const debateWindows = new Map<string, BrowserWindow>();
let promptDiffWindow: BrowserWindow | null = null;
let diffWindow: BrowserWindow | null = null;
let focusServer: http.Server | null = null;

const FOCUS_PORT = 17862;

function sendFocusNode(nodeId: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('focus-node', nodeId);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

/**
 * Start a tiny HTTP server on localhost that accepts focus-node requests
 * from other apps (e.g. summary-viewer). This is more reliable than
 * single-instance lock across separately-launched Electron dev instances.
 */
function startFocusServer(): void {
  focusServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/focus-node') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { nodeId } = JSON.parse(body);
          if (nodeId && typeof nodeId === 'string') {
            sendFocusNode(nodeId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing nodeId' }));
          }
        } catch {
          /* telemetry — silent by design */
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  focusServer.listen(FOCUS_PORT, '127.0.0.1', () => {
    console.log(`[main] Focus server listening on http://127.0.0.1:${FOCUS_PORT}`);
  });

  focusServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Another taxonomy-editor instance already owns this port — that's fine.
      console.log('[main] Focus server port already in use, skipping.');
      focusServer = null;
    } else {
      console.error('[main] Focus server error:', err);
    }
  });
}

function registerWindowHandlers(): void {
  ipcMain.handle('grow-window', (_event, deltaWidth: number) => {
    if (!mainWindow) return;
    const [w, h] = mainWindow.getSize();
    mainWindow.setSize(w + deltaWidth, h, true);
  });

  ipcMain.handle('shrink-window', (_event, deltaWidth: number) => {
    if (!mainWindow) return;
    const [w, h] = mainWindow.getSize();
    const newW = Math.max(900, w - deltaWidth);
    mainWindow.setSize(newW, h, true);
  });

  ipcMain.handle('is-maximized', () => {
    if (!mainWindow) return false;
    return mainWindow.isMaximized() || mainWindow.isFullScreen();
  });
}

/** Apply security hardening to every BrowserWindow (will-navigate + setWindowOpenHandler). */
function hardenWindow(win: BrowserWindow): void {
  // S1: Block navigation to untrusted origins — open external URLs in system browser
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = ['http://localhost:5173', 'file://'];
    if (!allowed.some(prefix => url.startsWith(prefix))) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  // S2: Deny new-window requests; open http(s) links externally
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createWindow(): void {
  // Fail loud if the data root is mis-provisioned so the user sees an actionable
  // error dialog instead of silent-empty panels (t/3296, prevention for t/3290).
  try {
    validateDataRoot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'main-process', level: 'error',
      message: 'data-root validation failed at startup',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    // console.error is load-bearing here: getGlobalRecorder() may be uninit this early
    // (t/3110 sink trap) and app.quit() drains the ring buffer — this is the real stdout signal.
    console.error('[main] Data root validation failed:', msg);
    dialog.showErrorBox('Data root not found', msg);
    app.quit();
    return;
  }

  const preloadPath = path.join(__dirname, 'preload.cjs');
  console.log('[main] preload path:', preloadPath);
  console.log('[main] app.isPackaged:', app.isPackaged);

  console.log('[main] Creating BrowserWindow...');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'AI Rosetta Stone',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });
  hardenWindow(mainWindow);

  // Use production build if launched with CLI file args (viewer mode) or if packaged.
  // --review-mode (or ELECTRON_REVIEW_MODE=1) forces the prod renderer path without registering
  // the get-cli-file-arg viewer-mode IPC, so cross-scope agents can attach via CDP for design review.
  const hasFileArg = process.argv.some(a => a.startsWith('--diagnostics-file=') || a.startsWith('--harvest-file='));
  const isReviewMode = process.argv.includes('--review-mode') || process.env['ELECTRON_REVIEW_MODE'] === '1';
  const isDev = !app.isPackaged && !hasFileArg && !isReviewMode;
  if (isDev) {
    console.log('[main] Loading dev URL: http://localhost:5173');
    void mainWindow.loadURL('http://localhost:5173');
  } else {
    const filePath = path.join(PROJECT_ROOT, 'taxonomy-editor/dist/renderer/index.html');
    console.log('[main] Loading production build:', filePath);
    void mainWindow.loadFile(filePath);
  }

  console.log('[main] BrowserWindow created, setting up event handlers...');

  // Preload failures are otherwise silent in the terminal — the renderer just
  // never gets window.electronAPI and shows "Desktop bridge unavailable".
  mainWindow.webContents.on('preload-error', (_event, _preloadPath, error) => {
    console.error('[main] PRELOAD ERROR (bridge will be unavailable):', error);
  });

  // Confirm bridge landed after the page finishes loading.
  mainWindow.webContents.on('did-finish-load', () => {
    void mainWindow?.webContents
      .executeJavaScript('typeof window.electronAPI')
      .then(type => { console.log('[main] window.electronAPI type after did-finish-load:', type); })
      .catch(err => { console.error('[main] bridge check executeJavaScript failed:', err); });
  });

  // S6: Restrict webview to HTTPS URLs only — prevent loading arbitrary content
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    // Strip dangerous preferences from webviews
    delete webPreferences.preload;
    (webPreferences as Record<string, unknown>).preloadURL = undefined;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;

    const src = params.src || '';
    if (src && !src.startsWith('https://') && !src.startsWith('http://localhost')) {
      console.warn(`[main] Blocked webview with disallowed src: ${src}`);
      _event.preventDefault();
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] RENDERER CRASHED:', JSON.stringify(details));
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('[main] Failed to load:', errorCode, errorDescription);
  });

  mainWindow.on('unresponsive', () => {
    console.error('[main] Window became unresponsive');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        {
          label: 'Refresh Taxonomy',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('reload-taxonomy');
            }
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => { if (mainWindow) mainWindow.webContents.zoomLevel += 0.5; },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => { if (mainWindow) mainWindow.webContents.zoomLevel -= 0.5; },
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => { if (mainWindow) mainWindow.webContents.zoomLevel = 0; },
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Source Licenses',
          click: () => {
            const noticesPath = app.isPackaged
              ? path.join(process.resourcesPath, 'THIRD-PARTY-NOTICES.txt')
              : path.join(__dirname, '../../THIRD-PARTY-NOTICES.txt');
            const licensesWindow = new BrowserWindow({
              width: 800,
              height: 600,
              title: 'Open Source Licenses',
              webPreferences: { sandbox: true },
            });
            hardenWindow(licensesWindow);
            try {
              const content = fs.readFileSync(noticesPath, 'utf-8');
              void licensesWindow.loadURL(`data:text/plain;charset=utf-8,${encodeURIComponent(content)}`);
            } catch {
              /* telemetry — silent by design */
              void licensesWindow.loadURL(`data:text/plain;charset=utf-8,${encodeURIComponent('License notices file not found. Run npm run licenses to generate.')}`);
            }
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

process.on('uncaughtException', (err) => {
  console.error('[main] UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] UNHANDLED REJECTION:', reason);
});

if (process.argv.includes('--debug-cdp') || process.env.DEBUG_CDP === '1') {
  // Port 9223 avoids conflict with VS Code/Orca which occupies 9222 by default.
  app.commandLine.appendSwitch('remote-debugging-port', '9223');
  console.log('[main] CDP enabled on port 9223 (--debug-cdp)');
}

void app.whenReady().then(() => {
  console.log('[main] app.whenReady fired');

  const mainRecorder = new FlightRecorder({ capacity: RECORDER_CAPACITY_SECONDARY, dumpOnError: true });
  setGlobalRecorder(mainRecorder);

  // Forward main-process recorder events to the main window's renderer recorder so the
  // unified flight-recorder timeline includes main-process events — notably errors from
  // the AI client / model resolution in embeddings.ts. Without this, those land only in
  // the separate main-process buffer and are invisible to a renderer dump (t/766).
  // Mirrors the popup-shim forwarding in flightRecorderInit.ts (channel 'flight-event-
  // from-popup', _origin tag); the original record() still buffers locally so the main
  // process keeps its own dump-on-error.
  const forwardMainRecord = mainRecorder.record.bind(mainRecorder);
  mainRecorder.record = (input: Parameters<typeof mainRecorder.record>[0]) => {
    forwardMainRecord(input);
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('flight-event-from-popup', {
          ...input,
          data: { ...input.data, _origin: 'main-process' },
        });
      }
    } catch {
      /* flight recorder forwarding — silent by design (main window may not exist yet) */
    }
  };

  mainRecorder.startPipeListener(process.pid);
  console.log(`[main] Flight recorder started, pipe listener on PID ${process.pid}`);

  // t/1425: one-time migration — truncate any backend holding >1 API key down to
  // its first key (BYOK round-robin reversal). Runs after the recorder is live so
  // each truncation is captured as a flight-recorder event (backend + counts, no keys).
  const migratedKeyBackends = migrateToSingleKey();
  if (migratedKeyBackends > 0) {
    console.log(`[main] apiKeyStore: truncated ${migratedKeyBackends} multi-key backend(s) to single key (t/1425)`);
  }

  registerIpcHandlers();
  console.log('[main] IPC handlers registered');
  registerTerminalHandlers(() => mainWindow);
  registerWindowHandlers();
  startFocusServer();
  warmupEmbeddingModel();
  console.log('[main] All handlers registered, creating window...');

  // Check for file-viewer command line args
  const diagFileArg = process.argv.find(a => a.startsWith('--diagnostics-file='));
  const harvestFileArg = process.argv.find(a => a.startsWith('--harvest-file='));

  if (diagFileArg) {
    const filePath = diagFileArg.split('=')[1];
    console.log('[main] Opening diagnostics file:', filePath);
    ipcMain.handle('get-cli-file-arg', () => {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return { type: 'diagnostics', path: filePath, data: JSON.parse(content) };
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'main-process',
          level: 'error',
          message: 'Operation failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        console.error('[main] Failed to read diagnostics file:', err);
        return { type: 'diagnostics', path: filePath, data: null, error: String(err) };
      }
    });
  } else if (harvestFileArg) {
    const filePath = harvestFileArg.split('=')[1];
    console.log('[main] Opening harvest file:', filePath);
    ipcMain.handle('get-cli-file-arg', () => {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return { type: 'harvest', path: filePath, data: JSON.parse(content) };
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'main-process',
          level: 'error',
          message: 'Operation failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        console.error('[main] Failed to read harvest file:', err);
        return { type: 'harvest', path: filePath, data: null, error: String(err) };
      }
    });
  } else {
    ipcMain.handle('get-cli-file-arg', () => null);
  }

  createWindow();

  // Buffer the last diagnostics state so popouts that reload (HMR) get it resent.
  let _lastDiagnosticsState: unknown = null;

  // Diagnostics popout window
  ipcMain.handle('open-diagnostics-window', () => {
    if (diagWindow && !diagWindow.isDestroyed()) {
      if (diagWindow.isMinimized()) diagWindow.restore();
      diagWindow.show();
      diagWindow.focus();
      return;
    }
    const preloadPath = path.join(__dirname, 'preload.cjs');
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    diagWindow = new BrowserWindow({
      width: Math.round(screenW * 0.8),
      height: Math.round(screenH * 0.75),
      minWidth: 400,
      minHeight: 300,
      title: 'Debate Diagnostics',
      alwaysOnTop: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    hardenWindow(diagWindow);
    const isDev = !app.isPackaged;
    if (isDev) {
      void diagWindow.loadURL('http://localhost:5173#diagnostics-window');
    } else {
      void diagWindow.loadFile(path.join(PROJECT_ROOT, 'taxonomy-editor/dist/renderer/index.html'), { hash: 'diagnostics-window' });
    }
    diagWindow.webContents.on('did-finish-load', () => {
      // t/2692: record whether the buffered state existed the moment the diag window
      // finished loading. This is the seam where an IPC-after-load race would strand the
      // popout (Issue 2): lastStateAvailable=false at load, with no later push, is the
      // failure signature — previously only assessable as PLAUSIBLE, now CONFIRMABLE.
      getGlobalRecorder()?.record({
        type: 'lifecycle',
        component: 'diagnostics-window',
        level: 'info',
        message: 'diagnostics-window did-finish-load',
        data: { lastStateAvailable: !!_lastDiagnosticsState },
      });
      if (_lastDiagnosticsState && diagWindow && !diagWindow.isDestroyed()) {
        diagWindow.webContents.send('diagnostics-state-update', _lastDiagnosticsState);
      }
    });
    diagWindow.on('closed', () => {
      diagWindow = null;
      // Notify main window that popout closed
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('diagnostics-popout-closed');
      }
    });
  });

  ipcMain.handle('close-diagnostics-window', () => {
    if (diagWindow && !diagWindow.isDestroyed()) {
      diagWindow.close();
    }
  });

  // t/4642/t/4663: bring an already-open diagnostics popout to the front on a repeat card
  // click (open-diagnostics-window's show/focus lines, without the create-if-absent branch —
  // the 'inline' arm for narrow windows is decided in electron-bridge.ts before this ever fires).
  ipcMain.handle('focus-diagnostics-window', (): 'focused' | 'not-open' => {
    if (diagWindow && !diagWindow.isDestroyed()) {
      if (diagWindow.isMinimized()) diagWindow.restore();
      diagWindow.show();
      diagWindow.focus();
      return 'focused';
    }
    return 'not-open';
  });

  registerChatWindowHandlers(path.join(__dirname, 'preload.cjs'), () => mainWindow, hardenWindow);

  // Prompt Diff popout window
  ipcMain.handle('open-prompt-diff-window', (_event, debateId: string, entryId: string) => {
    if (promptDiffWindow && !promptDiffWindow.isDestroyed()) {
      // Update context and refocus
      promptDiffWindow.webContents.send('prompt-diff-context', { debateId, entryId });
      if (promptDiffWindow.isMinimized()) promptDiffWindow.restore();
      promptDiffWindow.show();
      promptDiffWindow.focus();
      return;
    }
    const preloadPath = path.join(__dirname, 'preload.cjs');
    promptDiffWindow = new BrowserWindow({
      width: 1200,
      height: 700,
      minWidth: 900,
      minHeight: 600,
      title: 'Prompt Diff',
      alwaysOnTop: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    hardenWindow(promptDiffWindow);
    const hash = `prompt-diff-window?debateId=${encodeURIComponent(debateId)}&entryId=${encodeURIComponent(entryId)}`;
    const isDev = !app.isPackaged;
    if (isDev) {
      void promptDiffWindow.loadURL(`http://localhost:5173#${hash}`);
    } else {
      void promptDiffWindow.loadFile(path.join(PROJECT_ROOT, 'taxonomy-editor/dist/renderer/index.html'), { hash });
    }
    promptDiffWindow.on('closed', () => { promptDiffWindow = null; });
  });

  // Data file diff popout window
  ipcMain.handle('open-diff-window', (_event, filePath: string) => {
    if (diffWindow && !diffWindow.isDestroyed()) {
      const hash = `diff-window?file=${encodeURIComponent(filePath)}`;
      const isDev = !app.isPackaged;
      if (isDev) {
        void diffWindow.loadURL(`http://localhost:5173#${hash}`);
      } else {
        void diffWindow.loadFile(path.join(PROJECT_ROOT, 'taxonomy-editor/dist/renderer/index.html'), { hash });
      }
      if (diffWindow.isMinimized()) diffWindow.restore();
      diffWindow.show();
      diffWindow.focus();
      return;
    }
    const preloadPath = path.join(__dirname, 'preload.cjs');
    diffWindow = new BrowserWindow({
      width: 900,
      height: 650,
      minWidth: 500,
      minHeight: 400,
      title: `Diff: ${filePath}`,
      alwaysOnTop: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    hardenWindow(diffWindow);
    const hash = `diff-window?file=${encodeURIComponent(filePath)}`;
    const isDev = !app.isPackaged;
    if (isDev) {
      void diffWindow.loadURL(`http://localhost:5173#${hash}`);
    } else {
      void diffWindow.loadFile(path.join(PROJECT_ROOT, 'taxonomy-editor/dist/renderer/index.html'), { hash });
    }
    diffWindow.on('closed', () => { diffWindow = null; });
  });

  // Relay diagnostics state from main window to diag window AND pov-progression window
  ipcMain.on('diagnostics-state-update', (_event, state) => {
    _lastDiagnosticsState = state;
    if (diagWindow && !diagWindow.isDestroyed()) {
      diagWindow.webContents.send('diagnostics-state-update', state);
    }
    if (povProgWindow && !povProgWindow.isDestroyed()) {
      povProgWindow.webContents.send('diagnostics-state-update', state);
    }
  });

  // POV Progression popout window
  ipcMain.handle('open-pov-progression-window', () => {
    if (povProgWindow && !povProgWindow.isDestroyed()) {
      if (povProgWindow.isMinimized()) povProgWindow.restore();
      povProgWindow.show();
      povProgWindow.focus();
      return;
    }
    const preloadPath = path.join(__dirname, 'preload.cjs');
    povProgWindow = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 700,
      minHeight: 500,
      title: 'POV Progression',
      alwaysOnTop: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    hardenWindow(povProgWindow);
    const isDev = !app.isPackaged;
    if (isDev) {
      void povProgWindow.loadURL('http://localhost:5173#pov-progression-window');
    } else {
      void povProgWindow.loadFile(path.join(PROJECT_ROOT, 'taxonomy-editor/dist/renderer/index.html'), { hash: 'pov-progression-window' });
    }
    povProgWindow.webContents.on('did-finish-load', () => {
      if (_lastDiagnosticsState && povProgWindow && !povProgWindow.isDestroyed()) {
        povProgWindow.webContents.send('diagnostics-state-update', _lastDiagnosticsState);
      }
    });
    povProgWindow.on('closed', () => {
      povProgWindow = null;
    });
  });

  // Debate popout windows (Map-based, up to 5 simultaneous)
  ipcMain.handle('open-debate-window', (_event, debateId: string, source?: string) => {
    getGlobalRecorder()?.record({ type: 'user.action', component: 'openDebateWindow', level: 'info', message: 'open-debate-window', data: { debateId, source: source ?? 'personal' } });
    // Per-id dedup: focus existing window for this debateId (never counts against cap)
    const existing = debateWindows.get(debateId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    // Prune stale destroyed entries before cap check
    for (const [id, w] of debateWindows.entries()) {
      if (w.isDestroyed()) debateWindows.delete(id);
    }
    if (debateWindows.size >= 5) {
      return { atCap: true };
    }
    const offset = debateWindows.size * 30;
    const preloadPath = path.join(__dirname, 'preload.cjs');
    const win = new BrowserWindow({
      ...(offset > 0 ? { x: offset, y: offset } : {}),
      width: 1100,
      height: 800,
      minWidth: 700,
      minHeight: 500,
      title: 'Debate',
      alwaysOnTop: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    hardenWindow(win);
    debateWindows.set(debateId, win);
    const debateHash = buildDebateHash(debateId, source);
    const isDev = !app.isPackaged;
    if (isDev) {
      void win.loadURL(`http://localhost:5173#${debateHash}`);
    } else {
      void win.loadFile(path.join(PROJECT_ROOT, 'taxonomy-editor/dist/renderer/index.html'), { hash: debateHash });
    }
    // Send debate ID on every load (initial + HMR reload)
    win.webContents.on('did-finish-load', () => {
      console.log('[Main] debate-window did-finish-load, sending debate ID:', debateId);
      if (!win.isDestroyed()) win.webContents.send('debate-window-load', debateId);
    });
    win.on('closed', () => {
      debateWindows.delete(debateId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('debate-popout-closed', debateId);
      }
    });
  });

  // Navigate main window to a taxonomy node (called from popout windows)
  ipcMain.on('focus-node-in-main', (_event, nodeId: string) => {
    sendFocusNode(nodeId);
  });

  ipcMain.handle('close-debate-window', (_event, debateId: string) => {
    const win = debateWindows.get(debateId);
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  cleanupTerminal();
  if (focusServer) {
    focusServer.close();
    focusServer = null;
  }
});
