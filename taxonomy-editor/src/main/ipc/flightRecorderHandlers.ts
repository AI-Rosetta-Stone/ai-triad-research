// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Flight-recorder handlers (t/1689 split of ipcHandlers.ts, ADR-007).
// Cross-window event forwarding, popup→main dump coordination, dump-to-disk with
// retention, and the standalone viewer launcher. Handler bodies moved verbatim;
// channel names unchanged.

import { app, ipcMain, BrowserWindow, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../fileIO.js';
import { redactDumpText } from '../../renderer/lib/flightRecorderRedact.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

export function registerFlightRecorderHandlers(): void {
  // ── Flight recorder: forward events from popup windows to main ──
  ipcMain.on('forward-flight-event', (event, payload: unknown) => {
    // Forward to the main window's renderer (which owns the real recorder)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents !== event.sender) {
        win.webContents.send('flight-event-from-popup', payload);
      }
    }
  });

  // Forward re-extract-claims request from popout to main window (t/226)
  ipcMain.on('request-re-extract-claims', (event, entryId: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents !== event.sender) {
        win.webContents.send('re-extract-claims', entryId);
      }
    }
  });

  // ── Flight recorder: popup requests main window to dump ──
  ipcMain.handle('trigger-main-dump', (event) => {
    return new Promise<{ filePath: string }>((resolve, reject) => {
      // Find the main window (any window that isn't the sender)
      const mainWin = BrowserWindow.getAllWindows().find(w => w.webContents !== event.sender);
      if (!mainWin || mainWin.isDestroyed()) {
        reject(new Error('Main window not available'));
        return;
      }
      // One-time listener for the dump result from the main window
      let timeout: ReturnType<typeof setTimeout>;
      const handler = (_e: Electron.IpcMainEvent, result: { filePath: string }) => {
        clearTimeout(timeout);
        resolve(result);
      };
      timeout = setTimeout(() => {
        ipcMain.removeListener('dump-result', handler);
        reject(new Error('Dump request timed out'));
      }, 10_000);
      ipcMain.once('dump-result', handler);
      mainWin.webContents.send('trigger-dump');
    });
  });

  // ── Flight recorder dump ──
  ipcMain.handle('dump-flight-recorder', (_event, ndjson: string) => {
    const dumpDir = path.join(app.getPath('userData'), 'flight-recorder');
    fs.mkdirSync(dumpDir, { recursive: true });

    // Filesystem-safe ISO timestamp
    const ts = new Date().toISOString().replace(/:/g, '-');
    const filePath = path.join(dumpDir, `flight-recorder-${ts}.jsonl`);
    // t/418: main-process stack traces reach the written dump too, so redact the whole text here
    // (the renderer redacts before sending; this covers any caller that does not).
    fs.writeFileSync(filePath, redactDumpText(ndjson, process.env.USERPROFILE ?? null), 'utf-8');

    // Retention: keep last 20 files, max 50 MB
    const MAX_FILES = 20;
    const MAX_BYTES = 50 * 1024 * 1024;
    try {
      const files = fs.readdirSync(dumpDir)
        .filter(f => f.startsWith('flight-recorder-') && f.endsWith('.jsonl'))
        .map(f => ({ name: f, path: path.join(dumpDir, f), mtime: fs.statSync(path.join(dumpDir, f)).mtimeMs, size: fs.statSync(path.join(dumpDir, f)).size }))
        .sort((a, b) => b.mtime - a.mtime);  // newest first

      // Delete beyond file count limit
      for (const f of files.slice(MAX_FILES)) {
        fs.unlinkSync(f.path);
      }
      // Delete oldest until within disk budget
      const remaining = files.slice(0, MAX_FILES);
      let totalSize = remaining.reduce((s, f) => s + f.size, 0);
      for (let i = remaining.length - 1; i >= 0 && totalSize > MAX_BYTES; i--) {
        fs.unlinkSync(remaining[i].path);
        totalSize -= remaining[i].size;
      }
    } catch (err) {
      // Retention pruning is best-effort — its failure does NOT fail the dump write — but a
      // failed prune is a real operational fact (old dumps not reclaimed, disk budget can creep),
      // so record it at warn level rather than swallowing it silently (t/2026). This isn't
      // telemetry, so it doesn't qualify for the silent-by-design exception.
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-flight-recorder',
        level: 'warn',
        message: 'Flight-recorder dump retention cleanup failed — old dumps may not be pruned',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }

    const filename = path.basename(filePath);
    console.log(`[flight-recorder] Dump written: ${filePath}`);
    return { filePath, filename };
  });

  ipcMain.handle('open-flight-recorder-viewer', (_event, dumpPath: string) => {
    // IPC input surface (t/2022, security-reviewer): confine the renderer-supplied path to the
    // flight-recorder dump dir — mirror resolveResearchPath so a compromised renderer can't turn
    // this into an arbitrary local-file-read primitive (read any file → embed in the generated
    // viewer HTML → open it). basename() strips any directory; the only legitimate caller passes
    // a path already inside this dir (the value dump-flight-recorder returned).
    const dumpDir = path.join(app.getPath('userData'), 'flight-recorder');
    const resolvedDump = path.resolve(dumpDir, path.basename(dumpPath));
    if (!resolvedDump.startsWith(dumpDir + path.sep)) return;

    const viewerPath = path.join(PROJECT_ROOT, 'tools', 'flight-recorder-viewer.html');
    let dumpContent: string;
    let viewerHtml: string;
    try {
      // Read directly rather than existsSync-then-read (js/file-system-race TOCTOU, t/2022). A
      // missing dump or viewer template (ENOENT) falls back to opening the raw dump; any other
      // read fault is recorded.
      dumpContent = fs.readFileSync(resolvedDump, 'utf-8');
      viewerHtml = fs.readFileSync(viewerPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'ipc-flight-recorder-viewer', level: 'error',
          message: 'Failed to read flight-recorder dump or viewer template',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      }
      void shell.openPath(resolvedDump);
      return;
    }

    // Escape dump content for a JS template literal AND neutralize an HTML `</script>` breakout:
    // backtick/$ escaping does NOT stop an HTML parser from closing the <script> on a literal
    // "</script>" in the content, so also escape '<' (t/2022, security-reviewer). Same for the
    // filename below — JSON.stringify is a complete JS-string encoder but does not escape '<'.
    const escaped = dumpContent
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$')
      .replace(/</g, '\\u003c');
    const safeFilename = JSON.stringify(path.basename(resolvedDump)).replace(/</g, '\\u003c');

    const autoLoadScript = `<script>
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('fileName').textContent = ${safeFilename};
  parseNdjson(\`${escaped}\`);
});
</script>`;

    const outputHtml = viewerHtml.replace('</body>', `${autoLoadScript}\n</body>`);

    const tempDir = path.join(app.getPath('temp'), 'flight-recorder-viewer');
    fs.mkdirSync(tempDir, { recursive: true });
    const ts = new Date().toISOString().replace(/:/g, '-');
    const tempFile = path.join(tempDir, `viewer-${ts}.html`);
    fs.writeFileSync(tempFile, outputHtml, 'utf-8');

    void shell.openPath(tempFile);
  });
}
