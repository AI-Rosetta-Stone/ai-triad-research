// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure-function inquiry-answer export converters (no platform dependencies).
 * Used by both Electron (main process) and web (browser) builds via the bridge
 * `exportInquiryToFile` (t/3624, epic t/3618). Mirrors `@lib/chat/chatExportFormatters`
 * and `@lib/debate/debateExport`: JSON/MD are downloaded as a Blob+anchor; PDF is the
 * browser's print-to-PDF from the styled HTML of `inquiryToPrintHtml` (window.open + print),
 * so NO PDF library is added.
 *
 * Input is the shared `InquiryResult` contract (self-describing — question, verdicts,
 * derivation receipt, etc. all live on it), so `opts` stays thin (Rosetta-confirmed, p/10#138).
 */

import type {
  InquiryResult,
  Camp,
  CampVerdict,
  CalibrationEntry,
} from './schema.js';
import { deriveTruncation } from './jobStatus.js';

export interface InquiryExportOptions {
  /** Display title; defaults to the inquiry question. */
  title?: string;
  /** ISO timestamp stamped into the export; defaults to now. Injectable for deterministic tests. */
  exportedAt?: string;
}

const CAMP_LABELS: Record<Camp, string> = {
  acc: 'Accelerationist',
  saf: 'Safetyist',
  skp: 'Skeptic',
  cc: 'Common Concerns',
};

const CAMP_COLORS: Record<Camp, string> = {
  acc: '#2e7d32',
  saf: '#dc2626',
  skp: '#6a1b9a',
  cc: '#424242',
};

function campLabel(camp: Camp): string {
  return CAMP_LABELS[camp] ?? String(camp);
}

function resolvedTitle(result: InquiryResult, opts?: InquiryExportOptions): string {
  return opts?.title || result.request?.question || 'Untitled Inquiry';
}

function resolvedDate(opts?: InquiryExportOptions): Date {
  const iso = opts?.exportedAt;
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function slugify(text: string, maxLen = 60): string {
  return (text || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, maxLen) || 'untitled';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Human calibration line, e.g. "claim acceptance: 72 / 84" — prefers displayValue when the bare
 *  number is lossy (schema note c), and appends the trust verdict + any truncation reason. */
function calibrationLine(entry: CalibrationEntry): string {
  const val = entry.displayValue ?? String(entry.value);
  const tr = entry.trust.terminationReason ? ` — ${entry.trust.terminationReason}` : '';
  return `${entry.metric}: ${val} (${entry.trust.verdict}${tr})`;
}

/** The POV-tag scope of the run, or undefined when untagged (t/3965, SO e/252). An exported tagged answer
 *  must say so: a Scope run grounds one camp on a single wing. Prefers what ran (`derivation.tag`, with
 *  counts) over what was asked (`request.tagSelection`). */
function tagScopeLine(result: InquiryResult): string | undefined {
  const applied = result.derivation.tag;
  if (applied) {
    const excluded = applied.mode === 'scope' ? `, ${applied.excludedUntagged} not tagged ${applied.tag} excluded` : '';
    return `Tag: ${applied.pov}/${applied.tag} (${applied.mode}) · ${applied.included} tagged included${excluded}`;
  }
  const asked = result.request.tagSelection;
  return asked ? `Tag requested: ${asked.pov}/${asked.tag} (${asked.mode}) · not recorded as applied` : undefined;
}

/** The scope line as Markdown lines (none when untagged). */
function tagScopeMarkdown(result: InquiryResult): string[] {
  const line = tagScopeLine(result);
  return line ? [`**${line}**`] : [];
}

/** The scope line as a print-HTML meta row ('' when untagged). */
function tagScopeHtml(result: InquiryResult): string {
  const line = tagScopeLine(result);
  return line ? `${escapeHtml(line)}<br>\n  ` : '';
}

// ── Markdown ────────────────────────────────────────────────────────────────

export function inquiryToMarkdown(result: InquiryResult, opts?: InquiryExportOptions): string {
  const title = resolvedTitle(result, opts);
  const date = resolvedDate(opts);
  const { truncated, terminationReason } = deriveTruncation(result);
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');
  const d = result.derivation;
  lines.push(`**Fidelity:** ${d.fidelity}  ·  **Rounds:** ${d.rounds}  ·  **Call budget:** ${d.callBudget}${d.callsUsed !== undefined ? ` (used ${d.callsUsed})` : ''}`);
  lines.push(...tagScopeMarkdown(result));
  lines.push(`**Exported:** ${date.toLocaleDateString()}${truncated ? `  ·  ⚠ truncated${terminationReason ? ` (${terminationReason})` : ''}` : ''}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (result.campVerdicts.length > 0) {
    lines.push('## Perspectives');
    lines.push('');
    for (const cv of result.campVerdicts) {
      lines.push(`### ${campLabel(cv.camp)}`);
      lines.push('');
      lines.push(cv.verdict);
      if (cv.nodes.length > 0) {
        lines.push('');
        lines.push(`> refs: ${cv.nodes.map(n => `${n.nodeId}${n.label ? ` "${n.label}"` : ''}`).join(', ')}`);
      }
      lines.push('');
    }
  }

  if (result.convergences.length > 0) {
    lines.push('## Convergences');
    lines.push('');
    for (const c of result.convergences) {
      lines.push(`- ${c.claim}${c.nodes.length > 0 ? ` _(${c.nodes.map(n => n.nodeId).join(', ')})_` : ''}`);
    }
    lines.push('');
  }

  if (result.evidenceLayers.length > 0) {
    lines.push('## Evidence');
    lines.push('');
    for (const e of result.evidenceLayers) {
      lines.push(`### ${e.title}`);
      lines.push(`- **Role:** ${e.role}`);
      lines.push(`- **Solves:** ${e.solves}`);
      if (e.sources.length > 0) lines.push(`- **Sources:** ${e.sources.join('; ')}`);
      lines.push('');
    }
  }

  if (result.unresolvedGaps.length > 0) {
    lines.push('## Unresolved gaps');
    lines.push('');
    for (const g of result.unresolvedGaps) {
      lines.push(`- ${g.description} _(${g.confidence})_`);
    }
    lines.push('');
  }

  if (result.calibration.length > 0) {
    lines.push('## Calibration');
    lines.push('');
    for (const entry of result.calibration) {
      lines.push(`- ${calibrationLine(entry)}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`_${result.singleRunCaveat}_`);
  lines.push('');
  lines.push(`*Exported from AI Triad Taxonomy Editor · ${date.toLocaleDateString()}*`);
  lines.push('');

  return lines.join('\n');
}

// ── Print HTML (browser print-to-PDF source) ─────────────────────────────────

const PRINT_STYLES = `
  @page { margin: 1in; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #222;
    max-width: 100%;
  }
  h1 { font-size: 18pt; margin-top: 0; border-bottom: 2px solid #333; padding-bottom: 6px; }
  h2 { font-size: 14pt; margin-top: 24px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .inquiry-export-meta { color: #666; font-size: 10pt; margin-bottom: 16px; }
  .inquiry-truncated { color: #b45309; font-weight: bold; }
  .inquiry-verdict { break-inside: avoid; margin-bottom: 16px; }
  .inquiry-verdict-camp { font-size: 12pt; font-weight: bold; margin-top: 18px; margin-bottom: 4px; }
  .inquiry-verdict-body { margin: 4px 0; white-space: pre-wrap; }
  .inquiry-refs { font-size: 9pt; color: #888; margin-top: 4px; }
  .inquiry-list { margin: 4px 0 12px 0; }
  .inquiry-caveat { margin-top: 20px; font-style: italic; color: #555; }
  .inquiry-export-footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 9pt; color: #888; }
`;

export function inquiryToPrintHtml(result: InquiryResult, opts?: InquiryExportOptions): string {
  const title = resolvedTitle(result, opts);
  const date = resolvedDate(opts);
  const d = result.derivation;
  const { truncated, terminationReason } = deriveTruncation(result);

  const sections: string[] = [];

  if (result.campVerdicts.length > 0) {
    sections.push('<h2>Perspectives</h2>');
    for (const cv of result.campVerdicts as CampVerdict[]) {
      const color = CAMP_COLORS[cv.camp] ?? '#222';
      const refs = cv.nodes.length > 0
        ? `<div class="inquiry-refs">refs: ${cv.nodes.map(n => `${escapeHtml(n.nodeId)}${n.label ? ` "${escapeHtml(n.label)}"` : ''}`).join(', ')}</div>`
        : '';
      sections.push(`<div class="inquiry-verdict">
  <div class="inquiry-verdict-camp" style="color: ${color}">${escapeHtml(campLabel(cv.camp))}</div>
  <div class="inquiry-verdict-body">${escapeHtml(cv.verdict)}</div>
  ${refs}
</div>`);
    }
  }

  if (result.convergences.length > 0) {
    sections.push('<h2>Convergences</h2><ul class="inquiry-list">');
    for (const c of result.convergences) {
      const nodes = c.nodes.length > 0 ? ` <em>(${escapeHtml(c.nodes.map(n => n.nodeId).join(', '))})</em>` : '';
      sections.push(`<li>${escapeHtml(c.claim)}${nodes}</li>`);
    }
    sections.push('</ul>');
  }

  if (result.evidenceLayers.length > 0) {
    sections.push('<h2>Evidence</h2>');
    for (const e of result.evidenceLayers) {
      const src = e.sources.length > 0 ? `<div class="inquiry-refs">Sources: ${escapeHtml(e.sources.join('; '))}</div>` : '';
      sections.push(`<div class="inquiry-verdict">
  <div class="inquiry-verdict-camp">${escapeHtml(e.title)}</div>
  <div class="inquiry-verdict-body"><strong>Role:</strong> ${escapeHtml(e.role)}<br><strong>Solves:</strong> ${escapeHtml(e.solves)}</div>
  ${src}
</div>`);
    }
  }

  if (result.unresolvedGaps.length > 0) {
    sections.push('<h2>Unresolved gaps</h2><ul class="inquiry-list">');
    for (const g of result.unresolvedGaps) {
      sections.push(`<li>${escapeHtml(g.description)} <em>(${escapeHtml(g.confidence)})</em></li>`);
    }
    sections.push('</ul>');
  }

  if (result.calibration.length > 0) {
    sections.push('<h2>Calibration</h2><ul class="inquiry-list">');
    for (const entry of result.calibration) {
      sections.push(`<li>${escapeHtml(calibrationLine(entry))}</li>`);
    }
    sections.push('</ul>');
  }

  const truncNote = truncated
    ? ` · <span class="inquiry-truncated">⚠ truncated${terminationReason ? ` (${escapeHtml(terminationReason)})` : ''}</span>`
    : '';
  const tagHtml = tagScopeHtml(result);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${PRINT_STYLES}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="inquiry-export-meta">
  Fidelity: ${escapeHtml(d.fidelity)} · Rounds: ${d.rounds} · Call budget: ${d.callBudget}${d.callsUsed !== undefined ? ` (used ${d.callsUsed})` : ''}<br>
  ${tagHtml}Exported: ${date.toLocaleDateString()}${truncNote}
</div>
${sections.join('\n')}
<div class="inquiry-caveat">${escapeHtml(result.singleRunCaveat)}</div>
<div class="inquiry-export-footer">
  Exported from AI Triad Taxonomy Editor · ${date.toLocaleDateString()}
</div>
</body>
</html>`;
}

// ── JSON ──────────────────────────────────────────────────────────────────────

export function inquiryToJson(result: InquiryResult, opts?: InquiryExportOptions): string {
  return JSON.stringify(
    {
      schema: 'ai-triad-inquiry-export/1',
      title: resolvedTitle(result, opts),
      question: result.request?.question,
      exportedAt: opts?.exportedAt ?? resolvedDate(opts).toISOString(),
      // Export is owner-initiated, owner-scoped, FULL FIDELITY — every field is classified `include` for
      // the `export` surface in fieldClassification.ts (t/3648), BY DECISION, not by pass-through luck.
      // The embed is safe precisely because the export column excludes nothing; `inquiryExport.test.ts`
      // asserts that invariant against the matrix and FAILS if a field is ever classified export-EXCLUDE
      // — the signal to replace this wholesale embed with a matrix-derived projection at that point.
      result,
    },
    null,
    2,
  );
}

// ── Filename ────────────────────────────────────────────────────────────────

export function inquiryExportFilename(title: string, ext: string): string {
  const slug = slugify(title);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `inquiry-${slug}-${date}.${ext}`;
}
