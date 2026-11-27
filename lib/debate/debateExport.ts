// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure-function debate export converters (no platform dependencies).
 * Used by both Electron (main process) and web (browser) builds.
 */

import { orderSynthesisLists } from './synthesisOrder.js';
import { synthesisBrief, hasStructuredSynthesis } from './synthesisBrief.js';
import { factCheckExportLines } from './factCheckExport.js';

// ── Minimal types (avoids importing full renderer types) ──

interface TaxonomyRef {
  node_id: string;
  relevance: string;
}

interface TranscriptEntry {
  id: string;
  timestamp: string;
  type: string;
  speaker: string;
  content: string;
  taxonomy_refs: TaxonomyRef[];
  metadata?: Record<string, unknown>;
  addressing?: string;
}

export interface ExportableDebateSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  phase: string;
  topic: { original: string; refined?: string | null; final?: string };
  active_povers: string[];
  user_is_pover: boolean;
  transcript: TranscriptEntry[];
  synthesis?: {
    areas_of_agreement?: unknown[];
    areas_of_disagreement?: unknown[];
    unresolved_questions?: string[];
    summary?: string;
  };
}

export type DebateExportFormat = 'json' | 'markdown' | 'text' | 'pdf' | 'package';

export interface DebateExportOptions {
  /** Include the per-turn taxonomy refs list. Default: true. */
  includeTaxonomyRefs?: boolean;
  /** Include the relevance/reasoning text alongside each taxonomy ref. Default: true.
   *  Has no effect when includeTaxonomyRefs is false. */
  includeReasoning?: boolean;
}

function resolveOptions(options?: DebateExportOptions): Required<DebateExportOptions> {
  return {
    includeTaxonomyRefs: options?.includeTaxonomyRefs ?? true,
    includeReasoning: options?.includeReasoning ?? true,
  };
}

// ── Speaker labels ──

const SPEAKER_LABELS: Record<string, string> = {
  accelerationist: 'Accelerationist',
  safetyist: 'Safetyist',
  skeptic: 'Skeptic',
  user: 'User',
  system: 'System',
};

function speakerName(speaker: string): string {
  return SPEAKER_LABELS[speaker] || speaker;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** One transcript entry's body in the text export. A fact check's verdict lives in metadata, not content (t/771). */
function textEntryBody(entry: TranscriptEntry, session: ExportableDebateSession): string[] {
  if (entry.type === 'fact-check') return factCheckExportLines(entry, 'text');
  return synthesisEntryBrief(entry, session, 'text') ?? [entry.content];
}

/**
 * t/810: a synthesis entry with structured data exports as the brief, in the synthesis panel's sections and
 * order. An older entry with no structured data, or none the brief can show, keeps its stored content.
 */
function synthesisEntryBrief(entry: TranscriptEntry, session: ExportableDebateSession, format: 'markdown' | 'text'): string[] | null {
  if (entry.type !== 'synthesis') return null;
  const raw = (entry.metadata as Record<string, unknown> | undefined)?.synthesis;
  if (!hasStructuredSynthesis(raw)) return null;
  const ordered = orderSynthesisLists(raw as Record<string, unknown>);
  return synthesisBrief(ordered, { debaters: session.active_povers, topic: session.topic.final }, { level: 4, format });
}

/** One transcript entry's body in the Markdown export. A fact check's verdict lives in metadata, not content (t/771). */
function markdownEntryBody(entry: TranscriptEntry, session: ExportableDebateSession): string[] {
  if (entry.type === 'fact-check') return factCheckExportLines(entry, 'markdown');
  const brief = synthesisEntryBrief(entry, session, 'markdown');
  if (brief) return brief;
  if (entry.speaker === 'system') return [`> *${entry.content}*`];
  return [`**${speakerName(entry.speaker)}:**`, '', entry.content];
}

function entryTypeLabel(type: string): string {
  const map: Record<string, string> = {
    opening: 'Opening Statement',
    statement: 'Statement',
    question: 'Question',
    answer: 'Answer',
    clarification: 'Clarification',
    synthesis: 'Synthesis',
    probing: 'Probing Questions',
    'fact-check': 'Fact Check',
    system: 'System',
  };
  return map[type] || type;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Plain Text
// ═══════════════════════════════════════════════════════════════════════════════

export function debateToText(session: ExportableDebateSession, options?: DebateExportOptions): string {
  const opts = resolveOptions(options);
  const lines: string[] = [];
  const sep = '='.repeat(72);
  const thinSep = '-'.repeat(72);

  lines.push(sep);
  lines.push(`  ${session.title}`);
  lines.push(sep);
  lines.push('');
  lines.push(`Topic: ${session.topic.final || session.topic.refined || session.topic.original}`);
  lines.push(`Date: ${formatTimestamp(session.created_at)}`);
  lines.push(`Phase: ${session.phase}`);
  lines.push(`Debaters: ${session.active_povers.map(speakerName).join(', ')}`);
  lines.push('');
  lines.push(thinSep);
  lines.push('  TRANSCRIPT');
  lines.push(thinSep);

  for (const entry of session.transcript) {
    lines.push('');
    lines.push(`[${speakerName(entry.speaker)} — ${entryTypeLabel(entry.type)}]`);
    lines.push('');
    lines.push(...textEntryBody(entry, session));

    if (opts.includeTaxonomyRefs && entry.taxonomy_refs && entry.taxonomy_refs.length > 0) {
      lines.push('');
      lines.push('  Taxonomy refs:');
      for (const ref of entry.taxonomy_refs) {
        const rel = opts.includeReasoning && ref.relevance ? ` — ${ref.relevance}` : '';
        lines.push(`    [${ref.node_id}]${rel}`);
      }
    }
  }

  if (session.synthesis) {
    // t/769: the same relevance order the synthesis card shows.
    const synth = orderSynthesisLists(session.synthesis as unknown as Record<string, unknown>) as unknown as typeof session.synthesis;
    lines.push('');
    lines.push(thinSep);
    lines.push('  SYNTHESIS');
    lines.push(thinSep);

    if (session.synthesis.summary) {
      lines.push('');
      lines.push(session.synthesis.summary);
    }

    if (synth.areas_of_agreement && synth.areas_of_agreement.length > 0) {
      lines.push('');
      lines.push('Areas of Agreement:');
      for (const item of synth.areas_of_agreement) {
        lines.push(`  - ${typeof item === 'string' ? item : JSON.stringify(item)}`);
      }
    }

    if (synth.areas_of_disagreement && synth.areas_of_disagreement.length > 0) {
      lines.push('');
      lines.push('Areas of Disagreement:');
      for (const item of synth.areas_of_disagreement) {
        lines.push(`  - ${typeof item === 'string' ? item : JSON.stringify(item)}`);
      }
    }

    if (session.synthesis.unresolved_questions && session.synthesis.unresolved_questions.length > 0) {
      lines.push('');
      lines.push('Unresolved Questions:');
      for (const q of session.synthesis.unresolved_questions) {
        lines.push(`  - ${q}`);
      }
    }
  }

  lines.push('');
  lines.push(sep);
  lines.push('');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Markdown
// ═══════════════════════════════════════════════════════════════════════════════

export function debateToMarkdown(session: ExportableDebateSession, options?: DebateExportOptions): string {
  const opts = resolveOptions(options);
  const lines: string[] = [];

  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`**Topic:** ${session.topic.final || session.topic.refined || session.topic.original}`);
  lines.push(`**Date:** ${formatTimestamp(session.created_at)}`);
  lines.push(`**Phase:** ${session.phase}`);
  lines.push(`**Debaters:** ${session.active_povers.map(speakerName).join(', ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Transcript');

  let currentType = '';
  for (const entry of session.transcript) {
    if (entry.type !== currentType && entry.type !== 'system') {
      currentType = entry.type;
      lines.push('');
      lines.push(`### ${entryTypeLabel(entry.type)}`);
    }

    lines.push('');
    lines.push(...markdownEntryBody(entry, session));

    if (opts.includeTaxonomyRefs && entry.taxonomy_refs && entry.taxonomy_refs.length > 0) {
      lines.push('');
      const refs = entry.taxonomy_refs.map(r => {
        const rel = opts.includeReasoning && r.relevance ? `: ${r.relevance}` : '';
        return `\`${r.node_id}\`${rel}`;
      });
      lines.push(`> **Taxonomy refs:** ${refs.join(' | ')}`);
    }
  }

  if (session.synthesis) {
    // t/769: the same relevance order the synthesis card shows.
    const synth = orderSynthesisLists(session.synthesis as unknown as Record<string, unknown>) as unknown as typeof session.synthesis;
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Synthesis');

    if (session.synthesis.summary) {
      lines.push('');
      lines.push(session.synthesis.summary);
    }

    if (synth.areas_of_agreement && synth.areas_of_agreement.length > 0) {
      lines.push('');
      lines.push('### Areas of Agreement');
      lines.push('');
      for (const item of synth.areas_of_agreement) {
        lines.push(`- ${typeof item === 'string' ? item : JSON.stringify(item)}`);
      }
    }

    if (synth.areas_of_disagreement && synth.areas_of_disagreement.length > 0) {
      lines.push('');
      lines.push('### Areas of Disagreement');
      lines.push('');
      for (const item of synth.areas_of_disagreement) {
        lines.push(`- ${typeof item === 'string' ? item : JSON.stringify(item)}`);
      }
    }

    if (session.synthesis.unresolved_questions && session.synthesis.unresolved_questions.length > 0) {
      lines.push('');
      lines.push('### Unresolved Questions');
      lines.push('');
      for (const q of session.synthesis.unresolved_questions) {
        lines.push(`- ${q}`);
      }
    }
  }

  lines.push('');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTML (for PDF rendering in both Electron and browser)
// ═══════════════════════════════════════════════════════════════════════════════

export function markdownToHtml(md: string): string {
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Restore markdown syntax that uses > and *
  html = html.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Paragraphs
  html = html.replace(/\n{2,}/g, '\n\n');
  const blocks = html.split('\n\n');
  html = blocks.map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^<(?:h[1-6]|ul|ol|li|blockquote|hr|table|div|p)/.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return html;
}

const PDF_STYLES = `
  @page { margin: 1in; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #222;
    max-width: 100%;
  }
  h1 { font-size: 18pt; margin-top: 0; border-bottom: 2px solid #333; padding-bottom: 6px; }
  h2 { font-size: 14pt; margin-top: 24px; color: #444; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  h3 { font-size: 12pt; margin-top: 18px; color: #555; }
  h4 { font-size: 11pt; margin-top: 14px; color: #555; }
  p { margin: 8px 0; }
  strong { color: #111; }
  code {
    background: #f0f0f0; padding: 1px 5px; border-radius: 3px;
    font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 0.9em;
  }
  blockquote {
    margin: 8px 0; padding: 6px 12px; border-left: 3px solid #ccc;
    background: #f9f9f9; color: #555; font-size: 0.95em;
  }
  hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; }
`;

/** Build a full HTML document from a debate session (for PDF rendering). */
export function debateToHtml(session: ExportableDebateSession, options?: DebateExportOptions): string {
  const md = debateToMarkdown(session, options);
  const bodyHtml = markdownToHtml(md);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>${PDF_STYLES}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/** Generate a safe filename slug from a debate title. */
export function debateExportFilename(title: string, ext: string): string {
  const slug = (title || 'debate')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
  return `${slug}.${ext}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Package (ZIP containing JSON + Markdown + PDF + Diagnostics)
// ═══════════════════════════════════════════════════════════════════════════════

export interface PackageOptions extends DebateExportOptions {
  /** Generate PDF buffer — platform-specific, provided by caller. */
  generatePdf?: (session: ExportableDebateSession) => Promise<Uint8Array>;
}

/**
 * Build a ZIP package containing the debate in multiple formats plus diagnostics.
 * Returns the zip as a Uint8Array suitable for saving to disk or triggering a download.
 */
export async function debateToPackage(
  session: ExportableDebateSession & { diagnostics?: unknown },
  options?: PackageOptions,
): Promise<Uint8Array> {
  // @ts-ignore — jszip types available at runtime via taxonomy-editor/node_modules
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  const slug = debateExportFilename(session.title, '').replace(/\.$/, '');

  // JSON — full session data
  zip.file(`${slug}.json`, JSON.stringify(session, null, 2) + '\n');

  // Markdown
  zip.file(`${slug}.md`, debateToMarkdown(session, options));

  // PDF (if platform provides a generator)
  if (options?.generatePdf) {
    try {
      const pdfBytes = await options.generatePdf(session);
      zip.file(`${slug}.pdf`, pdfBytes);
    } catch {
      // PDF generation failed — include HTML fallback instead
      zip.file(`${slug}.html`, debateToHtml(session, options));
    }
  } else {
    // No PDF generator available — include printable HTML
    zip.file(`${slug}.html`, debateToHtml(session, options));
  }

  // Diagnostics — comprehensive: merge all diagnostic-relevant session fields
  const fullSession = session as unknown as Record<string, unknown>;
  const fullDiagnostics: Record<string, unknown> = {};
  if (session.diagnostics) fullDiagnostics.diagnostics = session.diagnostics;
  if (fullSession.turn_validations) fullDiagnostics.turn_validations = fullSession.turn_validations;
  if (fullSession.extraction_summary) fullDiagnostics.extraction_summary = fullSession.extraction_summary;
  if (fullSession.argument_network) fullDiagnostics.argument_network = fullSession.argument_network;
  if (fullSession.commitments) fullDiagnostics.commitments = fullSession.commitments;
  if (fullSession.qbaf_timeline) fullDiagnostics.qbaf_timeline = fullSession.qbaf_timeline;
  if (fullSession.dialectic_traces) fullDiagnostics.dialectic_traces = fullSession.dialectic_traces;
  if (fullSession.convergence_radar) fullDiagnostics.convergence_radar = fullSession.convergence_radar;
  if (fullSession.convergence_signals) fullDiagnostics.convergence_signals = fullSession.convergence_signals;
  if (fullSession.process_rewards) fullDiagnostics.process_rewards = fullSession.process_rewards;
  if (Object.keys(fullDiagnostics).length > 0) {
    zip.file(`${slug}-diagnostics.json`, JSON.stringify(fullDiagnostics, null, 2) + '\n');
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
