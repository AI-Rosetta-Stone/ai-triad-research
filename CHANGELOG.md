# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- In-app support ticket filing with file attachments, clipboard paste for screenshots, and one-click flight recorder dump
- Support case bridge methods (CRUD, attachment upload/download, admin management)
- Gemini API key onboarding modal with live validation and adaptive headline
- API key validation bridge method and server endpoint (Gemini, Claude, Groq)
- CopyLinkButton with SVG icons, size prop, and deep-link URL generation
- `test:changed` npm script for fast incremental test feedback
- Admin error dashboard query and aggregation endpoints with bridge methods
- `maxModelId` config to cap failover chain escalation in debates
- `stopAfterStage` support in debate engine `resume()` for fault-injection isolation
- Fault-injection tests for community submit/approve GitHub API failures

### Fixed
- Debate markdown links now open in new tab instead of navigating away
- Free-tier exemption for `/api/embeddings/query` so anonymous semantic search completes
- Health probe false degradation alerts and stale THROTTLED state recovery
- Floating promise lint error in GeminiOnboardingModal
- Lineage panel deduplicates casing variants

### Changed
- **PowerShell module: `AI_API_KEY` now applies only to Gemini models.** For other providers, set the provider's own key variable (e.g. `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`); a set `AI_API_KEY` with no provider variable is refused with an error naming the variable to set (t/4102)
- Community chat detail metadata section collapsed by default
- Retired `USER_CONTENT_STORAGE` env var and migration workflow
- Debate CLI, taxonomy-editor server and desktop, and summary viewer: `AI_API_KEY` now applies only to Gemini models. If you relied on it for Claude, Groq, OpenAI, xAI, Z.AI, Moonshot, DeepSeek or Azure, set that provider's own variable (e.g. `ANTHROPIC_API_KEY`, `GROQ_API_KEY`). Until then, calls to that provider are refused with an error naming the variable, and key-status and model-discovery views show it as not configured. A key equal to another provider's variable is now refused before it is sent. Unknown model ids that are neither in `ai-models.json` nor carry a provider prefix now fail instead of defaulting to Gemini (t/4105, t/4101)

## [0.13.6] - 2026-06-19

### Added
- Clickable POV filter chips in Intellectual Lineage Referenced By section
- Chat resize handle between content pane and detail panel
- Admin error dashboard query and aggregation endpoints
- Topic structure extraction and complexity classification for debates
- Emotional appeal detection for Wachsmuth calibration
- Debate `stopAfterStage` for fault-injection isolation
- Pipeline fault injection test harness (Phase 3)
- `/llms.txt` public discovery file
- Token budget warning and reset headers on AI proxy
- Login-page service worker self-heal and state beacon
- Dev/staging-only `X-Test-Persona` Easy Auth short-circuit
- `CONVERGES_WITH` canonical edge type

### Fixed
- Two pre-existing test failures blocking CI
- Debate AbortSignal threading to prevent indefinite provider hangs
- WebSocket handshake timeout and reconnect backoff
- 60s synthesis timeout that caused Phase 2 failure on large debates
- Debate popout full-page error no longer hijacks active debates
- PWA `skipWaiting` so new service workers activate immediately
- Semantic search for anonymous free-tier users
- `computeEmbeddings` Gemini call bounded with 30s timeout
- Crash-safe `saveDebateSession` with safe-serialize and atomic write
- Immediate save after synthesis to prevent crash data loss

### Security
- Session termination on logout — expire `AppServiceAuthSession`
- Fail fast with 422 `missing_api_key` when no key for the backend
- Provider binding guard to prevent cross-provider account collision

## [0.13.5] - 2026-06-19

### Added
- Runtime config REST endpoints with schema validation and dirty tracking
- Feature flag engine with admin CRUD endpoints and `useFlag()` hook
- Free-tier server-proxied Gemini key with per-IP rate limits
- Multi-key round-robin for BYOK backends
- Client network resilience — circuit breaker, adaptive throttle, retry
- Resilience feedback banners and recovery toasts
- Analytics dashboard with debate health, AI cost, and funnel cards
- Period comparison on analytics summary cards
- Rich hover tooltips on SVG analytics charts
- Cross-domain System Overview row on analytics dashboard
- Correlated server flight-recorder dumps with paired retention
- Merged paired-dump download endpoint
- Flight recorder HMR lifecycle events and stale-module detection
- PII redaction layer in flight recorder serializer
- Per-stage model config in debate settings UI
- Debate incremental snapshot saves for crash recovery
- Config explainer modal in New Debate setup
- Background field threading and `improveDebateTopicPrompt`
- Exploration preset and `--explore-first` CLI flag
- ExplorationSummary seeding for debates
- Debate export consolidation into single dropdown
- `requestId` correlation and email PII stripping in logs

### Fixed
- BYOK Gemini stages fall back to free-tier pool for Claude-only users
- Free-tier maxPromptChars cap that blocked debates
- Stale Easy Auth cookies breaking sign-in loop
- CORS crash when `ALLOWED_ORIGINS` is empty
- Rate-limit `RESOURCE_EXHAUSTED` context-overflow misclassified as 429
- Moderator temperature restoration after `generateWithModel` switch
- Participation floor strengthened to proportional speaker balance
- Duplicate opening statements from double-click race
- Cross-respond error bar with Retry and Dismiss buttons

### Security
- Supply chain hardening from GitHub Security Lab review
- Path traversal and reflected XSS input validation
- CI/CD pipeline hardening — remove GHCR_PAT, pin Actions to SHA digests
- Restrict sync diagnostics/status and data-root to admin
- Content sanitization and CSP tightening
- Production error detail redaction and source map blocking
- Analytics authorization and userId sanitization
- Runtime GitHub credentials scoped per user
- SSRF/DNS-rebinding guard in `fetchUrlContent`

### Changed
- Lazy-load tabs and windows for faster initial render
- Slim Docker base image — removed PowerShell and build tools (~250 MB)
- Lazy-load Azure SDK via dynamic import
- Migrated renderer `fetch()` calls to resilient bridge helpers
- Migrated hardcoded constants to `runtimeConfig` `getConfig()`
- User content storage migrated to Azure Blob Storage
- Server modules relocated into security/storage/ai/community sub-role directories

[Unreleased]: https://github.com/AI-Rosetta-Stone/ai-triad-research/compare/v0.13.6...HEAD
[0.13.6]: https://github.com/AI-Rosetta-Stone/ai-triad-research/compare/v0.13.5...v0.13.6
[0.13.5]: https://github.com/AI-Rosetta-Stone/ai-triad-research/releases/tag/v0.13.5
