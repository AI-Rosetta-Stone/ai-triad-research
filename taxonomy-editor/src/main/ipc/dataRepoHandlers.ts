// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Data-repo handlers (t/1689 split of ipcHandlers.ts, ADR-007).
// Data-root availability/config, clone of the ai-triad-data sibling repo, and
// update detection (check/pull/changed-files/diff). Handler bodies moved
// verbatim; channel names unchanged.

import { app, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { isDataAvailable, getDataRootPath, setDataRootPath } from '../fileIO.js';
import { checkForDataUpdates, pullDataUpdates, getChangedFiles, getFileDiff } from '../dataUpdateChecker.js';
import { SafePath } from '../ipcSchemas.js';

export function registerDataRepoHandlers(): void {
  ipcMain.handle('is-data-available', () => {
    return isDataAvailable();
  });

  ipcMain.handle('get-data-root', () => {
    return getDataRootPath();
  });

  ipcMain.handle('set-data-root', (_event, newRoot: string) => {
    SafePath.parse(newRoot);
    setDataRootPath(path.resolve(newRoot));
    // Relaunch so module-level cached paths are re-derived from the updated config
    app.relaunch();
    app.quit();
  });

  ipcMain.handle('clone-data-repo', async (_event, targetPath: string) => {
    // Validate target path is within user's home directory
    const resolved = path.resolve(targetPath);
    const home = app.getPath('home');
    if (!resolved.startsWith(home + path.sep) && resolved !== home) {
      return { success: false, message: `Target path must be within ${home}` };
    }
    const repoUrl = 'https://github.com/AI-Rosetta-Stone/ai-triad-data.git';
    return new Promise<{ success: boolean; message: string }>((resolve) => {
      const parentDir = path.dirname(resolved);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      execFile('git', ['clone', repoUrl, resolved], { timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, message: stderr || err.message });
        } else {
          resolve({ success: true, message: stdout || 'Cloned successfully' });
        }
      });
    });
  });

  ipcMain.handle('check-data-updates', async () => {
    return checkForDataUpdates();
  });

  ipcMain.handle('pull-data-updates', async () => {
    return pullDataUpdates();
  });

  ipcMain.handle('get-changed-files', async () => {
    return getChangedFiles();
  });

  ipcMain.handle('get-file-diff', async (_event, filePath: string) => {
    return getFileDiff(filePath);
  });
}
