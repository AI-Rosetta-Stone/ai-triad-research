// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { defineConfig, transformWithEsbuild } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const isWeb = process.env.VITE_TARGET === 'web';

// ── Renderer Node-builtin externalization gate (t/2551) ──────────────────────
// lib/debate/ (and other lib/*) is shared between Node (server/CLI/main) and the
// renderer. When a renderer-reachable module imports a Node built-in, Vite/rolldown
// externalizes it ("Module X has been externalized for browser compatibility") and
// emits a *warning* — the build stays green. But the shim is a stub: a NAMED import
// of an externalized builtin throws at module link (t/2550: `import { execFileSync }
// from 'child_process'` in persistence.ts crashed the Debate tab on load), while
// default/namespace imports only throw on lazy property access (why fs/path/crypto
// were tolerated). vitest/tsc don't catch it — the crash only manifests at renderer
// bundle eval. This gate promotes rolldown's own externalization signal to a hard
// error for any builtin outside the allowlist, so the next child_process-class import
// fails the build instead of prod (TL design t/2551#1).
//
// ALLOWLIST = the exact builtins a clean build currently externalizes, enumerated
// from the real build log (t/2551). This is a latent-hazard REGISTER (these are all
// externalized today and would throw on eager use), NOT a safe-list — burn-down is
// welcome but out of scope. `child_process` is deliberately absent → any re-introduction
// errors the build. `node:` and bare specifiers are normalized to the same key.
const RENDERER_BUILTIN_ALLOWLIST = new Set<string>([
  'crypto', // lib/debate/comments.ts, talmudicReferences.ts — shimmed, lazy access (t/2551)
  'fs',     // lib/debate/*, lib/flight-recorder, lib/ai-client — shimmed, lazy access (t/2551)
  'net',    // lib/flight-recorder/flightRecorder.ts — shimmed, lazy access (t/2551)
  'os',     // lib/flight-recorder/flightRecorder.ts — shimmed, lazy access (t/2551)
  'path',   // lib/debate/*, lib/flight-recorder, lib/ai-client — shimmed, lazy access (t/2551)
]);

const EXTERNALIZED_RE = /Module "([^"]+)" has been externalized for browser compatibility/;

// Rolldown/Rollup plugin: intercept every externalization log; collect any builtin
// outside the allowlist; fail the build at buildEnd (this.error → non-zero exit).
// Collecting-then-failing (rather than throwing inside onLog) aggregates ALL offenders
// into one actionable message and guarantees the build aborts.
function rendererNodeBuiltinGate() {
  const violations = new Map<string, string>(); // normalized builtin -> first log line
  return {
    name: 't2551-renderer-node-builtin-gate',
    onLog(_level: string, log: { message?: string } | string) {
      const message = typeof log === 'string' ? log : (log?.message ?? '');
      const match = EXTERNALIZED_RE.exec(message);
      if (!match) return;
      const builtin = match[1].replace(/^node:/, '');
      if (!RENDERER_BUILTIN_ALLOWLIST.has(builtin) && !violations.has(builtin)) {
        violations.set(builtin, message);
      }
    },
    buildEnd(this: { error: (msg: string) => never }) {
      if (violations.size === 0) return;
      const detail = [...violations.values()].map((m) => `    ${m}`).join('\n');
      this.error(
        `[t/2551 renderer node-builtin gate] ${violations.size} renderer-reachable module(s) import a Node built-in that Vite externalized for the browser and is NOT on the allowlist: ${[...violations.keys()].join(', ')}.\n` +
        `A named import of an externalized builtin throws at renderer bundle eval (crashes the tab). Fix by moving the importing code into a Node-only module that is NOT reachable from the renderer import graph. ` +
        `If the builtin is genuinely renderer-safe and shimmed, add it to RENDERER_BUILTIN_ALLOWLIST in taxonomy-editor/vite.config.ts with a one-line why + burn-down ref.\n${detail}`
      );
    },
  };
}

function getGitVersion(): string {
  try {
    return execSync('git describe --tags --always', { encoding: 'utf8' }).trim();
  } catch {
    return require('./package.json').version;
  }
}

function getGitSha(): string {
  // Container builds (Docker) inject the commit as BUILD_SHA — the build context has no
  // .git, so git exec would fall through to 'unknown' (t/2434). Prefer it when set; local
  // and Electron builds leave it unset and keep using git exec unchanged (t/2439).
  const fromEnv = process.env.BUILD_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  plugins: [
    // t/2698: vite classifies `.cts` as CommonJS and routes it through a script
    // transform that rejects TypeScript syntax, so a typed `.cts` (e.g. a preload
    // helper) throws a parse error when imported by vitest. Run esbuild's TS
    // transform on `.cts` first so such modules are importable + unit-testable.
    // Renderer bundle imports no `.cts`, so this only affects test/dev resolution.
    {
      name: 'transform-cts-as-ts',
      enforce: 'pre' as const,
      async transform(code: string, id: string) {
        if (id.split('?')[0].endsWith('.cts')) {
          return transformWithEsbuild(code, id, { loader: 'ts', format: 'esm' });
        }
        return null;
      },
    },
    rendererNodeBuiltinGate(),
    react(),
    ...(isWeb ? [VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/.auth\//],
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/api\/.*$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 86400 },
              networkTimeoutSeconds: 5,
            },
          },
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'image-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 604800 },
            },
          },
        ],
      },
      manifest: {
        name: 'AI Rosetta Stone',
        short_name: 'Rosetta Stone',
        description: 'Multi-perspective research platform for AI policy taxonomy',
        start_url: '/',
        display: 'standalone',
        background_color: '#FAF8F5',
        theme_color: '#A51C30',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    })] : []),
  ],
  root: 'src/renderer',
  base: isWeb ? '/' : './',
  define: {
    // Expose build target to renderer code
    'import.meta.env.VITE_TARGET': JSON.stringify(process.env.VITE_TARGET || 'electron'),
    __APP_VERSION__: JSON.stringify(getGitVersion()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __BUILD_SHA__: JSON.stringify(getGitSha()),
    __CHANGELOG_MD__: JSON.stringify(
      fs.readFileSync(path.resolve(import.meta.dirname, '../CHANGELOG.md'), 'utf-8')
    ),
    __COMPONENT_VERSIONS__: JSON.stringify({
      react: require('react/package.json').version,
      zustand: require('zustand/package.json').version,
      vite: require('vite/package.json').version,
      typescript: require('typescript/package.json').version,
    }),
  },
  resolve: {
    alias: {
      // Electron build omits vite-plugin-pwa (web-only), so the plugin never
      // provides `virtual:pwa-register/react`. UpdatePrompt.tsx imports it, and
      // rolldown intermittently fails to resolve the unprovided virtual module
      // during the electron build (t/2356). Alias it to a deterministic stub so
      // resolution never races. Web build keeps the real plugin-provided module.
      ...(isWeb ? {} : { 'virtual:pwa-register/react': path.resolve(import.meta.dirname, 'src/renderer/lib/pwaRegisterStub.ts') }),
      '@bridge': isWeb
        ? path.resolve(import.meta.dirname, 'src/renderer/bridge/web-bridge.ts')
        : path.resolve(import.meta.dirname, 'src/renderer/bridge/index.ts'),
      '@renderer': path.resolve(import.meta.dirname, 'src/renderer'),
      '@lib/debate': path.resolve(import.meta.dirname, '../lib/debate'),
      '@lib/dictionary': path.resolve(import.meta.dirname, '../lib/dictionary'),
      '@lib/translation': path.resolve(import.meta.dirname, '../lib/translation'),
      '@lib/flight-recorder': path.resolve(import.meta.dirname, '../lib/flight-recorder'),
      '@lib/diff': path.resolve(import.meta.dirname, '../lib/diff'),
      '@lib/ai-client': path.resolve(import.meta.dirname, '../lib/ai-client'),
      '@lib/electron-shared': path.resolve(import.meta.dirname, '../lib/electron-shared'),
      '@lib/embeddings': path.resolve(import.meta.dirname, '../lib/embeddings'),
      '@lib/chat': path.resolve(import.meta.dirname, '../lib/chat'),
      '@lib/organizations': path.resolve(import.meta.dirname, '../lib/organizations'),
      '@lib/inquiry': path.resolve(import.meta.dirname, '../lib/inquiry'),
      '@lib/entities': path.resolve(import.meta.dirname, '../lib/entities'),
      '@lib/policy': path.resolve(import.meta.dirname, '../lib/policy'),
      '@lib/sourceIndex': path.resolve(import.meta.dirname, '../lib/sourceIndex'),
      '@lib/oped': path.resolve(import.meta.dirname, '../lib/oped'),
      '@lib/schema': path.resolve(import.meta.dirname, '../lib/schema'), // t/3955: validatePovTags for the renderer save schema
      '@lib/userPreferencesSchema': path.resolve(import.meta.dirname, '../lib/userPreferencesSchema.ts'),
      // Allow lib/ files to resolve packages from taxonomy-editor's node_modules
      'zod': path.resolve(import.meta.dirname, 'node_modules/zod'),
      'jszip': path.resolve(import.meta.dirname, 'node_modules/jszip'),
    },
    // Ensure shared lib files (lib/electron-shared/) resolve React from this project
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    minify: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react-dom/') || id.includes('node_modules/react/')) return 'react';
          if (id.includes('node_modules/zustand/')) return 'zustand';
          if (id.includes('node_modules/zod/')) return 'zod';
          if (id.includes('node_modules/react-markdown/') || id.includes('node_modules/remark-gfm/')) return 'markdown';
          if (id.includes('node_modules/@xterm/')) return 'xterm';
          if (id.includes('node_modules/jszip/')) return 'jszip';
        },
      },
    },
  },
  test: {
    include: [
      '**/*.test.{ts,tsx}',
      '../main/**/*.test.ts',
      '../server/__tests__/**/*.test.ts',
      '../../../taxonomy-editor/scripts/__tests__/**/*.test.ts', // t/2973 — generate-notices guard unit tests
      '../../../taxonomy-editor/eslint-rules/__tests__/**/*.test.ts', // t/3093 — custom ESLint rule RuleTester specs
      '../../../lib/ai-client/**/*.test.ts',
      '../../../lib/chat/**/*.test.ts',
      '../../../lib/electron-shared/**/*.test.ts',
      '../../../lib/debate/**/*.test.ts',
      '../../../lib/oped/**/*.test.ts',
      // dictionary lint tests excluded — data consistency checks owned by data team
      '../../../lib/diff/**/*.test.ts',
      '../../../lib/edges/**/*.test.ts',
      '../../../lib/flight-recorder/**/*.test.ts',
      '../../../lib/search/**/*.test.ts',
      '../../../lib/entities/**/*.test.ts',
      '../../../lib/sanitize/**/*.test.ts',
      // t/720 consolidation: the shared SSRF-guarded fetcher backs POST /api/fetch-url,
      // so its suite must gate CI. It was absent from this list since t/2482 landed.
      '../../../lib/url-fetch/**/*.test.ts',
      '../../../lib/ai-config/**/*.test.ts',
      '../../../lib/embeddings/**/*.test.ts', // t/2060 — mock-based (fake onnxruntime-node), no native addon/model needed
      '../../../lib/brief/**/*.test.ts',     // t/2800 — brief export pipeline (extract + schema utils)
      '../../../lib/schema/**/*.test.ts',    // t/3453 — schema-of-record drift comparator + extractors (fixture-based, no ai-triad-data)
      '../../../lib/inquiry/**/*.test.ts',   // t/3574 — inquiry result contract (Zod schemas + parseInquiryResult), fixture-based, no ai-triad-data
      '../../../lib/policy/**/*.test.ts',    // t/4034 — policy registry recount (pure, fixture-based, no ai-triad-data)
      '../../../lib/sourceIndex/**/*.test.ts', // t/4334 — canonical-doc-id algorithm (pure, fixture-based, Electron/web parity)
      '../../../lib/data-formats/**/*.test.ts', // t/4353 — file-writers registry shape + every writer path exists
      '../../../lib/*.test.ts',
      // translation tests excluded — depend on ai-triad-data dictionary not available in CI
    ],
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov'],
      reportOnFailure: true,
      thresholds: {
        statements: 17,
        branches: 11,
        functions: 23,
        lines: 18,
      },
    },
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers', 'onnxruntime-web', 'virtual:pwa-register/react'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      allow: [path.resolve(import.meta.dirname, '..')],
    },
    // In web mode, proxy API + WebSocket traffic to the local server (port 7862)
    // so the web bridge's /api/* and /ws/* calls resolve. Ignored in electron mode.
    proxy: isWeb ? {
      '/api': { target: 'http://localhost:7862', changeOrigin: true },
      '/ws':  { target: 'ws://localhost:7862',   ws: true, changeOrigin: true },
      '/health': { target: 'http://localhost:7862', changeOrigin: true },
    } : undefined,
  },
});
