// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// System / shell handlers (t/1689 split of ipcHandlers.ts, ADR-007).
// External open, clipboard, PowerShell prompt-file reads, native file/dir
// pickers, path-validated research-file I/O, feedback + error reporting, and
// window screenshot capture. Handler bodies moved verbatim; channels unchanged.

import { ipcMain, shell, clipboard, BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, getDataRootPath, writeJsonFileAtomic } from '../fileIO.js';
import { ActionableError, errorMessage } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

// Extensions that execute on open — blocked regardless of directory (M13, t/2531).
const BLOCKED_OPEN_EXTS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.ps1', '.vbs', '.lnk', '.msi', '.scr', '.pif',
  '.sh', '.py', '.rb', '.jar',
]);

export function registerSystemHandlers(): void {
  ipcMain.handle('open-external', (_event, url: string) => {
    // Only allow http/https URLs
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });

  ipcMain.handle('open-file', (_event, filePath: string) => {
    // S-M13: Containment + extension denylist before shell.openPath.
    // shell.openPath executes .exe/.bat/.ps1/.lnk etc. — restrict to known safe
    // directories and non-executable extensions to prevent renderer-bug RCE.
    const resolved = path.resolve(filePath);
    const dataRoot = getDataRootPath();
    const inDataRoot = resolved.startsWith(dataRoot + path.sep);
    const inProjectRoot = resolved.startsWith(PROJECT_ROOT + path.sep);
    if (!inDataRoot && !inProjectRoot) return;
    if (BLOCKED_OPEN_EXTS.has(path.extname(resolved).toLowerCase())) return;
    if (fs.existsSync(resolved)) void shell.openPath(resolved);
  });

  // Clipboard (Electron 40: renderer clipboard API deprecated → use main process)
  ipcMain.handle('clipboard-write-text', (_event, text: string) => {
    // Fire-and-forget: Electron 44 types clipboard.writeText as a Promise; a copy-to-clipboard
    // has no meaningful completion value for the caller, so void it (mirrors `void shell.openPath`
    // above). Handler contract stays void — no behavioural change (t/electron-44 bump #1652).
    void clipboard.writeText(text);
  });

  // PowerShell prompt file reader (for Prompt Inspector)
  const PROMPT_DIR_SEGMENTS: Record<string, string[]> = {
    ps: ['scripts', 'AITriad', 'Prompts'],
    oped: ['lib', 'oped', 'prompts'],
  };
  ipcMain.handle('read-ps-prompt', (_event, promptName: string, dir = 'ps') => {
    // Sanitize: only allow alphanumeric, hyphens, no path traversal
    if (!/^[a-z0-9-]+$/.test(promptName)) {
      return { text: null, error: 'Invalid prompt name' };
    }
    const segments = PROMPT_DIR_SEGMENTS[dir];
    if (!segments) return { text: null, error: `Unknown prompt directory: ${dir}` };
    const promptPath = path.join(PROJECT_ROOT, ...segments, `${promptName}.prompt`);
    if (!fs.existsSync(promptPath)) {
      return { text: null, error: `Prompt file not found: ${promptName}.prompt` };
    }
    try {
      const text = fs.readFileSync(promptPath, 'utf-8');
      return { text };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { text: null, error: String(err) };
    }
  });

  // List all available PS prompt files
  ipcMain.handle('list-ps-prompts', () => {
    const promptDir = path.join(PROJECT_ROOT, 'scripts', 'AITriad', 'Prompts');
    if (!fs.existsSync(promptDir)) return [];
    return fs.readdirSync(promptDir)
      .filter(f => f.endsWith('.prompt'))
      .map(f => f.replace('.prompt', ''));
  });

  ipcMain.handle('pick-document-file', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { cancelled: true };
    const result = await dialog.showOpenDialog(win, {
      title: 'Select a document for debate',
      filters: [
        { name: 'Documents', extensions: ['md', 'txt', 'pdf', 'docx', 'html'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    
    try {
      const filePath = result.filePaths[0];
      const fileName = path.basename(filePath);
      
      // t/275: read as bytes, not UTF-8 — PDF/DOCX need binary extraction.
      // Pass to lib's extractDocumentText (t/273) for format-aware text extraction.
      // TODO: confirm path once t/273 PR is available.
      const bytes = fs.readFileSync(filePath);
      const { extractDocumentText } = await import('../../../../lib/debate/documentExtractor.js');
      const extracted = await extractDocumentText(new Uint8Array(bytes), fileName);
      
      // Return filePath for debate mode (used by NewDebateDialog.tsx:1076), plus extracted content.
      return { cancelled: false, filePath, fileName, content: extracted.text, format: extracted.format };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'systemHandlers', level: 'error',
        message: `Document extraction failed in pick-document-file: ${(err as Error).message}`,
        error: { name: (err as Error).name ?? 'Error', message: String((err as Error).message ?? err), stack: (err as Error).stack },
      });
      if (err instanceof ActionableError) throw err;
      throw new ActionableError({
        goal: 'Extract text from document',
        problem: errorMessage(err),
        location: 'systemHandlers pick-document-file',
        nextSteps: ['Check that the file is a valid PDF, DOCX, TXT, MD or HTML document'],
      });
    }
  });

  ipcMain.handle('pick-directory', async (_event, defaultPath?: string) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { cancelled: true };
    const result = await dialog.showOpenDialog(win, {
      title: 'Select research data directory',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    return { cancelled: false, path: result.filePaths[0] };
  });

  // ── Research file access (path-validated) ───────────────────────────────────
  const RESEARCH_DIR = path.join(PROJECT_ROOT, 'research');
  const MAX_RESEARCH_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

  function resolveResearchPath(relativePath: string): string {
    const resolved = path.resolve(RESEARCH_DIR, relativePath);
    if (!resolved.startsWith(RESEARCH_DIR + path.sep) && resolved !== RESEARCH_DIR) {
      throw new ActionableError({
        goal: 'Access research file',
        problem: `Path traversal blocked: "${relativePath}" resolves outside research/`,
        location: 'ipcHandlers:resolveResearchPath',
        nextSteps: ['Use a relative path within the research/ directory'],
      });
    }
    return resolved;
  }

  ipcMain.handle('read-research-file', (_event, relativePath: string) => {
    const filePath = resolveResearchPath(relativePath);
    let fd: number | undefined;
    try {
      // Open ONE descriptor and fstat+read through it (js/file-system-race, t/2022): statting a
      // path then reading the same path is a TOCTOU; a single fd is race-free. Dropping the
      // existsSync guard alone was insufficient — the residual statSync→readFileSync kept the
      // alert open (#5401), so this mirrors the embeddings fd fix. A missing file (openSync
      // ENOENT) is treated as null in the catch.
      fd = fs.openSync(filePath, 'r');
      const stat = fs.fstatSync(fd);
      if (stat.size > MAX_RESEARCH_FILE_SIZE) {
        throw new ActionableError({
          goal: 'Read research file',
          problem: `File exceeds 10 MB size limit (${(stat.size / 1024 / 1024).toFixed(1)} MB)`,
          location: `ipcHandlers:read-research-file(${relativePath})`,
          nextSteps: ['Use a smaller file or process it in chunks'],
        });
      }
      const raw = fs.readFileSync(fd, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err instanceof ActionableError) throw err;
      // Missing file → null quietly (matches the pre-fix existsSync behavior), no error noise.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-research-file',
        level: 'error',
        message: `Failed to read research file: ${relativePath}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });

  ipcMain.handle('write-research-file', (_event, relativePath: string, data: unknown) => {
    const filePath = resolveResearchPath(relativePath);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    writeJsonFileAtomic(filePath, data);
  });

  ipcMain.handle('submit-feedback', (_event, rating: string, text?: string, category?: string, context?: Record<string, unknown>) => {
    if (rating !== 'up' && rating !== 'down') return { ok: false };
    const feedbackDir = path.join(getDataRootPath(), 'admin', 'feedback');
    fs.mkdirSync(feedbackDir, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ts = new Date().toISOString().replace(/:/g, '-');
    const entry = { id, timestamp: new Date().toISOString(), rating, text: text?.trim() || null, category: category || 'general', context: context || null };
    fs.writeFileSync(path.join(feedbackDir, `feedback-${ts}-${id.slice(0, 8)}.json`), JSON.stringify(entry, null, 2));
    return { ok: true, id };
  });

  ipcMain.handle('capture-screenshot', async (_event, opts?: { width?: number; height?: number; defaultName?: string }) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { cancelled: true };

    const width = opts?.width ?? 960;
    const height = opts?.height ?? 600;
    const originalBounds = win.getBounds();

    // Resize, wait for paint, capture, restore
    win.setContentSize(width, height);
    await new Promise(r => setTimeout(r, 500));
    const image = await win.webContents.capturePage();
    win.setBounds(originalBounds);

    const result = await dialog.showSaveDialog(win, {
      title: 'Save Screenshot',
      defaultPath: opts?.defaultName ?? 'screenshot.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return { cancelled: true };

    fs.writeFileSync(result.filePath, image.toPNG());
    return { cancelled: false, filePath: result.filePath };
  });

  ipcMain.handle('report-error', (_event, error: Record<string, unknown>, context?: Record<string, unknown>) => {
    const errorsDir = path.join(getDataRootPath(), 'admin', 'errors');
    fs.mkdirSync(errorsDir, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const ts = new Date().toISOString().replace(/:/g, '-');
    const entry = { id, timestamp: new Date().toISOString(), error, context: context ?? {} };
    fs.writeFileSync(path.join(errorsDir, `error-${ts}-${id.slice(0, 8)}.json`), JSON.stringify(entry, null, 2));
    return { ok: true };
  });
}
