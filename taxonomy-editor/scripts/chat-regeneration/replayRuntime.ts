// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Node runtime for the headless chat replay (t/287).
 *
 * Loads the renderer's chat store and web bridge in Node through Vite's SSR loader (the renderer
 * needs Vite: import.meta.env, CSS imports, path aliases), with a jsdom window and a guarded
 * fetch aimed at a running taxonomy-editor server. See replayFetchGuard.ts for what reaches the
 * server, and replayHarness.ts for the replay itself.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { createServer, loadConfigFromFile } from 'vite';
import { createReplayFetchGuard, type ReplayFetchGuard } from './replayFetchGuard.js';
import type { ReplayOptions, ReplayedChatSession } from './replayHarness.js';
import type { ChatSession } from './types.js';
import { ActionableError } from '../../../lib/debate/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const editorRoot = path.resolve(here, '../..');

const BROWSER_GLOBALS = ['window', 'document', 'localStorage', 'sessionStorage', 'location', 'CustomEvent', 'Event', 'HTMLElement'];

export interface ReplayRuntime {
  replay: (session: ChatSession, options?: ReplayOptions) => Promise<ReplayedChatSession>;
  readonly guard: ReplayFetchGuard;
  close: () => Promise<void>;
}

/** Start the runtime against the taxonomy-editor server at `serverUrl`. Call close() when done. */
export interface ReplayRuntimeOptions {
  /** The operator's own API key for the replay's model. Sent the way the web app sends a bring-your-own key
   *  (sessionStorage 'byok-api-key' -> the chat-stream request body). Held in memory only. */
  byokKey?: string;
}

export async function startReplayRuntime(serverUrl: string, options: ReplayRuntimeOptions = {}): Promise<ReplayRuntime> {
  const guard = createReplayFetchGuard({ baseUrl: serverUrl });

  // @ts-expect-error -- jsdom ships no types and @types/jsdom is not a dependency of this package
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: new URL('/', serverUrl).href });
  const domWindow = dom.window as unknown as Record<string, unknown>;
  const globals = globalThis as Record<string, unknown>;
  for (const key of BROWSER_GLOBALS) globals[key] = domWindow[key];
  if (options.byokKey) (domWindow.sessionStorage as Storage).setItem('byok-api-key', options.byokKey);
  globals.fetch = guard.fetch;
  domWindow.fetch = guard.fetch;

  const configPath = path.join(editorRoot, 'vite.config.ts');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configPath, editorRoot);
  const alias = loaded?.config.resolve?.alias;
  if (!alias || Array.isArray(alias)) {
    throw new ActionableError({
      goal: 'Start the chat replay runtime',
      problem: `Could not read resolve.alias as a plain object from ${configPath}.`,
      location: 'scripts/chat-regeneration/replayRuntime.ts -> startReplayRuntime',
      nextSteps: ['Check that vite.config.ts still exports resolve.alias as an object.'],
    });
  }

  const vite = await createServer({
    root: editorRoot,
    configFile: false,
    logLevel: 'warn',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    // The web bridge is the one that talks HTTP to a server; the default alias is the Electron one.
    resolve: { alias: { ...alias, '@bridge': path.join(editorRoot, 'src/renderer/bridge/web-bridge.ts') } },
    define: { 'import.meta.env.VITE_TARGET': JSON.stringify('web') },
  });

  const harness = await vite.ssrLoadModule('/scripts/chat-regeneration/replayHarness.ts') as typeof import('./replayHarness.js');

  return {
    guard,
    replay: (session, options) => harness.replaySessionThroughStore(session as never, options),
    close: async () => {
      await vite.close();
      dom.window.close();
    },
  };
}
