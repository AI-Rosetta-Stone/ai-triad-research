// Architecture boundary rules enforced by dependency-cruiser.
// Run: npx depcruise --config .dependency-cruiser.cjs src/ ../lib/
// See docs/architecture-boundaries.md for rationale.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── lib → app: shared libraries must not import application code ──
    // Matches only the top-level shared lib/ (../lib/), not src/renderer/lib/.
    {
      name: 'lib-not-to-app',
      comment: 'Shared lib/ must not import from the taxonomy-editor app (src/).',
      severity: 'error',
      from: { path: '^\\.\\.[\\\\/]lib[\\\\/]' },
      to: { path: '(^|/)src/' },
    },

    // ── renderer → server: renderer must go through bridge, never import server directly ──
    {
      name: 'renderer-not-to-server',
      comment: 'Renderer code must access the server through @bridge, not import server modules directly.',
      severity: 'error',
      from: { path: '(^|/)src/renderer/' },
      to: { path: '(^|/)src/server/' },
    },

    // ── renderer → main: renderer must not import Electron main process modules ──
    {
      name: 'renderer-not-to-main',
      comment: 'Renderer must not import main process modules — use IPC via @bridge.',
      severity: 'error',
      from: { path: '(^|/)src/renderer/' },
      to: { path: '(^|/)src/main/' },
    },

    // ── server → renderer: server must not import renderer/UI code ──
    {
      name: 'server-not-to-renderer',
      comment: 'Server must not depend on renderer (UI) code.',
      severity: 'error',
      from: { path: '(^|/)src/server/' },
      to: { path: '(^|/)src/renderer/' },
    },

    // ── main → renderer: main process must not import renderer code — use IPC ──
    // Exception: preloadElectronApiContract.ts (t/3529) is a compile-time-only, never
    // imported-or-bundled conformance check that deliberately imports electron.d.ts's
    // ElectronAPI type to catch preload/renderer drift at build time (TL-approved design,
    // e/179#2). Scoped out by path rather than loosening the boundary for all of
    // src/main/ (t/3542) — every other main-process file still hits this rule.
    {
      name: 'main-not-to-renderer',
      comment: 'Main process must not import renderer code — use IPC.',
      severity: 'error',
      from: {
        path: '(^|/)src/main/',
        pathNot: '(^|/)src/main/__typecheck__/preloadElectronApiContract\\.ts$',
      },
      to: { path: '(^|/)src/renderer/' },
    },

    // ── shared → slices: shared helpers must not import slice modules (prevents cycles) ──
    {
      name: 'debate-shared-not-to-slices',
      comment: 'useDebateStore/shared/ must not import from useDebateStore/slices/ — shared modules are leaves.',
      severity: 'error',
      from: { path: '(^|/)hooks/useDebateStore/shared/' },
      to: { path: '(^|/)hooks/useDebateStore/slices/' },
    },

    // ── soul loaders: one Node-only, one Vite-only, same resolvePoverInfo signature (t/3975) ──
    // soulDocLoader reads souls with fs/node:crypto; in the renderer bundle those are stubbed and the
    // first tagged lookup throws at runtime (tsc can't see it). tagSoulRegistry uses import.meta.glob,
    // which exists only under Vite, so it throws in tsx/tsc-built Node. Importing the wrong one compiles.
    // `reachable: true`: the hazardous edge is TRANSITIVE. A shared lib/debate module that every runtime
    // imports carries its loader into all of them, so a direct-edge rule would stay silent (SO e/250#3).
    {
      name: 'renderer-not-to-soulDocLoader',
      comment: 'Nothing the renderer reaches, at any depth, may import lib/debate/soulDocLoader (fs/node:crypto); use tagSoulRegistry — t/3975.',
      severity: 'error',
      from: { path: '(^|/)src/renderer/' },
      to: { path: '(^|[\\\\/])lib[\\\\/]debate[\\\\/]soulDocLoader\\.(ts|js)$', reachable: true },
    },
    {
      name: 'main-not-to-tagSoulRegistry',
      comment: 'Nothing Electron main reaches may import lib/debate/tagSoulRegistry: import.meta.glob does not exist under Node — t/3975.',
      severity: 'error',
      from: { path: '(^|/)src/main/' },
      to: { path: '(^|[\\\\/])lib[\\\\/]debate[\\\\/]tagSoulRegistry\\.(ts|js)$', reachable: true },
    },
    {
      name: 'server-not-to-tagSoulRegistry',
      comment: 'Nothing the server reaches may import lib/debate/tagSoulRegistry: import.meta.glob does not exist under Node — t/3975.',
      severity: 'error',
      from: { path: '(^|/)src/server/' },
      to: { path: '(^|[\\\\/])lib[\\\\/]debate[\\\\/]tagSoulRegistry\\.(ts|js)$', reachable: true },
    },
    {
      // The edge itself (SO e/250#3 condition 1): shared debate code is imported by every runtime, so it must
      // not pick a loader. It takes the resolver from its caller; each runtime's entry point chooses. Exempt:
      // the two loaders, tests, and Node-only entry points (cli, cli.helpers, mcp-server).
      name: 'lib-debate-not-to-soul-loaders',
      comment: 'Shared lib/debate code must not import soulDocLoader or tagSoulRegistry; the runtime entry point injects the resolver — t/3975.',
      severity: 'error',
      from: {
        path: '(^|[\\\\/])lib[\\\\/]debate[\\\\/]',
        pathNot: '(^|[\\\\/])lib[\\\\/]debate[\\\\/](soulDocLoader|tagSoulRegistry|cli|cli\\.helpers|mcp-server)\\.(ts|js)$|\\.test\\.(ts|tsx)$|[\\\\/]__tests__[\\\\/]',
      },
      to: { path: '(^|[\\\\/])lib[\\\\/]debate[\\\\/](soulDocLoader|tagSoulRegistry)\\.(ts|js)$' },
    },
    {
      // t/4306: the companion to the rule above. Its exempt Node-only entry modules import the loaders, so shared
      // code importing one of THEM would pull the fs loader into every runtime (the renderer included) without the
      // direct-edge rule firing. Shared code may not depend on an entry module; entry modules may import each other.
      name: 'lib-debate-not-to-node-entry-modules',
      comment: 'Shared lib/debate code must not import the Node-only entry modules (cli, cli.helpers, mcp-server); they import the soul loaders — t/4306.',
      severity: 'error',
      from: {
        path: '(^|[\\\\/])lib[\\\\/]debate[\\\\/]',
        pathNot: '(^|[\\\\/])lib[\\\\/]debate[\\\\/](cli|cli\\.helpers|mcp-server)\\.(ts|js)$|\\.test\\.(ts|tsx)$|[\\\\/]__tests__[\\\\/]',
      },
      to: { path: '(^|[\\\\/])lib[\\\\/]debate[\\\\/](cli|cli\\.helpers|mcp-server)\\.(ts|js)$' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
