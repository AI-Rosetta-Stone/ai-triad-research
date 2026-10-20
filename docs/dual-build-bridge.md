# Dual-Build Bridge Pattern (taxonomy-editor)

> Extracted from the root `AGENTS.md` for token efficiency (t/1730). Relevant only to taxonomy-editor renderer work; see also `taxonomy-editor/AGENTS.md` and the `/add-bridge-method` playbook.

The taxonomy-editor runs as both Electron desktop and hosted web app. The bridge abstraction (`taxonomy-editor/src/renderer/bridge/`) ensures renderer code is build-target agnostic:

| File | Role |
|------|------|
| `types.ts` | `AppAPI` interface — the contract both implementations satisfy |
| `web-bridge.ts` | Web: REST calls via `get`/`post`/`put`/`del` helpers with resilience (circuit breaker, retry, timeout) |
| `electron-bridge.ts` | Electron: delegates to `window.electronAPI` (IPC to main process) |

**Rules:** Always import from `@bridge` (tsconfig alias), never from specific bridge files (breaks the other build target). New methods follow the `/add-bridge-method` playbook. Electron-only features need web fallbacks. `openExternal` must validate `https?://` to prevent `javascript:` and other protocol injection.

## Cross-profile impact

When evaluating a change to the Taxonomy Editor, consider both build targets:
- New features must work in both Electron and web; check both bridge implementations.
- File-system operations in Electron become REST API calls on the web.
- Native dialogs (save, open) need browser equivalents: a Blob download, or `<input type="file">`.
- Electron-only features (for example `BrowserWindow.printToPDF`) need web fallbacks.

## Data-read parity (t/2648, t/2661; process fix t/2669)

> Moved here from the Tech Lead's `AGENTS.md` (t/4109 Phase 1).

**A dual-build feature isn't Done on "works locally".** The two builds read data through different backends: Electron reads the filesystem, and the web build uses the GitHub API. A feature can render correctly on one and return empty on the other, and ADR-001's graceful-empty behaviour makes that failure *silent*: no crash, no error. So:
- **Verify data-reading features on the hosted web profile,** through the GitHub-API path, against real deployed data, before sign-off. Checking only locally isn't sign-off for a dual-build feature.
- **A hosted or deploy smoke must assert that data is present** (a count above zero, or the expected shape), not just that the page renders without error. A smoke that only checks endpoints respond passed 26 of 26 while a feature was visibly broken: the entities-empty escape.
- **Silent-degradation paths must emit an observable signal.** Graceful-empty (ADR-001) and any swallow-and-continue (for example an analytics append) must log or count a "loaded 0" or "write failed", so a zero or failed result can be detected.

This is a recurring failure **class**, not a one-off: local versus web, staging versus prod, silent swallows that return success. **Single-context validation plus silent degradation means invisible failure.** The countermeasure is the same everywhere: verify in the deployed context, assert the positive outcome, and make degradation observable.
