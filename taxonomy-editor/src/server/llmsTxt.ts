// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1143: static /llms.txt body (llms.txt convention — https://llmstxt.org).
// Served by GET /llms.txt so IDE agents / AI tools get structured context about
// the app instead of parsing raw SPA HTML. Kept as a compiled module (not a
// loose .txt) so it's always present in the bundle regardless of deployment.
export const LLMS_TXT = `# AI Triad Research — Taxonomy Editor

> A multi-perspective research platform for AI policy and safety literature (Berkman Klein Center, 2026). It models four points-of-view camps as a Belief–Desire–Intention (BDI) taxonomy, runs a three-agent debate engine (Accelerationist, Safetyist, Skeptic), and surfaces conflicts, argument edges, and source lineage across AI-policy positions.

The Taxonomy Editor is an Electron + React application with an HTTP API that mirrors its desktop IPC bridge. Node IDs follow \`{pov}-{category}-{NNN}\`, where \`pov\` is one of \`acc\` (Accelerationist), \`saf\` (Safetyist), \`skp\` (Skeptic), or \`cc\` (Cross-cutting), and \`category\` is one of Beliefs, Desires, or Intentions.

## API

- [Health](/health): \`GET /health\` — liveness and data-root status (always public).
- [Taxonomy by POV](/api/taxonomy/acc): \`GET /api/taxonomy/{pov}\` — taxonomy nodes for a camp (\`pov\` = \`acc\` | \`saf\` | \`skp\` | \`cc\`).
- [Edges](/api/edges): \`GET /api/edges\` — AIF-aligned argument edges between nodes.
- [Debates](/api/debates): \`GET /api/debates\` — saved three-agent debate runs; \`GET /api/debates/{id}\` for a single run.
- AI proxy: \`POST /api/ai/generate\` — multi-backend AI generation (Gemini / Claude / Groq), tier-gated.

Most \`/api/*\` endpoints require authentication in multi-user deployments; \`/health\` and \`/llms.txt\` are always public.

## Documentation

- [Source repository](https://github.com/AI-Rosetta-Stone/ai-triad-research)
- [llms.txt convention](https://llmstxt.org)
`;
