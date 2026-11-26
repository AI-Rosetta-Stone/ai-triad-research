#!/usr/bin/env npx tsx
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Repairs debate transcript JSON files where LLM responses contain raw JSON
 * instead of clean text. Regenerates the markdown file.
 */

import fs from 'fs';
import { parsePoverResponse, parseJsonRobust, stripCodeFences } from './helpers.js';
import { POVER_INFO } from './types.js';
import { orderSynthesisLists } from './synthesisOrder.js';
import type { SpeakerId } from './types.js';
import { formatDebateMarkdown } from './formatters.js';
import { DebateSessionSchema } from './schemas.js';

function log(msg: string): void {
  process.stderr.write(`[repair] ${msg}\n`);
}

const debatePath = process.argv[2];
if (!debatePath) {
  console.error('Usage: npx tsx lib/debate/repairTranscript.ts <debate.json>');
  process.exit(1);
}

const raw: unknown = JSON.parse(fs.readFileSync(debatePath, 'utf8'));
const parseResult = DebateSessionSchema.safeParse(raw);
if (!parseResult.success) {
  log(`WARN: schema validation failed (${parseResult.error.issues.map(i => i.message).join('; ')}) — proceeding with raw session`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const session = (parseResult.success ? parseResult.data : raw) as any;
let fixed = 0;

for (const entry of session.transcript) {
  if (entry.type === 'concluding') continue; // handled separately

  const content: string = entry.content;
  const hasRawJson = content.includes('"statement"') || content.trim().startsWith('```json');

  if (!hasRawJson) continue;

  // Try parsePoverResponse first — it handles most patterns
  const { statement, taxonomyRefs, meta } = parsePoverResponse(content);
  if (statement !== content.trim() && statement.length > 50) {
    entry.content = statement;
    if (taxonomyRefs.length > entry.taxonomy_refs.length) entry.taxonomy_refs = taxonomyRefs;
    if (meta.policy_refs && !entry.policy_refs?.length) entry.policy_refs = meta.policy_refs;
    fixed++;
    log(`Fixed [${entry.type}] ${entry.speaker}: ${statement.slice(0, 60)}...`);
    continue;
  }

  // Fallback: regex extraction of the "statement" field value
  const stmtMatch = content.match(/"statement"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
  if (stmtMatch && stmtMatch[1].length > 50) {
    const extracted = stmtMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    entry.content = extracted;
    fixed++;
    log(`Fixed [${entry.type}] ${entry.speaker} (regex): ${extracted.slice(0, 60)}...`);
    continue;
  }

  // Last resort: find "statement": " and extract until the next unescaped " followed by structural JSON
  const stmtIdx = content.indexOf('"statement"');
  if (stmtIdx >= 0) {
    const colonIdx = content.indexOf(':', stmtIdx + 11);
    const quoteIdx = content.indexOf('"', colonIdx + 1);
    if (quoteIdx >= 0) {
      // Walk forward looking for the closing quote (heuristic: quote followed by , or \n  ")
      let end = -1;
      for (let i = quoteIdx + 1; i < content.length; i++) {
        if (content[i] === '\\') { i++; continue; }
        if (content[i] === '"') {
          const after = content.slice(i + 1, i + 20).trimStart();
          if (after.startsWith(',') || after.startsWith('}') || after.startsWith('\n')) {
            end = i;
            break;
          }
        }
      }
      if (end > quoteIdx) {
        const raw = content.slice(quoteIdx + 1, end);
        const extracted = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (extracted.length > 50) {
          entry.content = extracted;
          fixed++;
          log(`Fixed [${entry.type}] ${entry.speaker} (walk): ${extracted.slice(0, 60)}...`);
          continue;
        }
      }
    }
  }
}

// Fix synthesis entry
const synthEntry = session.transcript.find((e: any) => e.type === 'concluding');
if (synthEntry) {
  const hasRawJson = synthEntry.content.includes('"areas_of_') || synthEntry.content.trim().startsWith('{') || synthEntry.content.trim().startsWith('```');

  if (hasRawJson) {
    let synthData = synthEntry.metadata?.synthesis;
    const hasData = synthData && Object.keys(synthData).length > 0;

    if (!hasData) {
      // Extract complete arrays from possibly-truncated JSON
      const raw: string = stripCodeFences(synthEntry.content);

      function extractArray(json: string, key: string): any[] {
        const searchStr = `"${key}": [`;
        const searchStr2 = `"${key}":[`;
        let idx = json.indexOf(searchStr);
        if (idx < 0) idx = json.indexOf(searchStr2);
        if (idx < 0) return [];

        const bracketStart = json.indexOf('[', idx);
        if (bracketStart < 0) return [];

        let depth = 0;
        for (let i = bracketStart; i < json.length; i++) {
          if (json[i] === '[') depth++;
          else if (json[i] === ']') {
            depth--;
            if (depth === 0) {
              try { return JSON.parse(json.slice(bracketStart, i + 1)); }
              catch { return []; }
            }
          }
        }
        return [];
      }

      synthData = {
        areas_of_agreement: extractArray(raw, 'areas_of_agreement'),
        areas_of_disagreement: extractArray(raw, 'areas_of_disagreement'),
        cruxes: extractArray(raw, 'cruxes'),
        unresolved_questions: extractArray(raw, 'unresolved_questions'),
        taxonomy_coverage: extractArray(raw, 'taxonomy_coverage'),
        argument_map: extractArray(raw, 'argument_map'),
        preferences: extractArray(raw, 'preferences'),
        policy_implications: extractArray(raw, 'policy_implications'),
      };
      synthEntry.metadata = { ...synthEntry.metadata, synthesis: synthData };
      log(`Extracted: ${synthData.areas_of_agreement.length} agree, ${synthData.areas_of_disagreement.length} disagree, ${synthData.cruxes.length} cruxes`);
    }

    // t/769: the same relevance order the synthesis card shows.
    if (synthData) {
      synthData = orderSynthesisLists(synthData as Record<string, unknown>) as typeof synthData;
      synthEntry.metadata = { ...synthEntry.metadata, synthesis: synthData };
    }

    // Format readable content
    if (synthData) {
      const lines: string[] = [];
      if (synthData.areas_of_agreement?.length) {
        lines.push('**Areas of Agreement:**');
        for (const a of synthData.areas_of_agreement) {
          const povers = (a.povers || []).map((p: string) => POVER_INFO[p as Exclude<SpeakerId, 'user'>]?.label ?? p).join(', ');
          lines.push(`- ${a.point} (${povers})`);
        }
        lines.push('');
      }
      if (synthData.areas_of_disagreement?.length) {
        lines.push('**Areas of Disagreement:**');
        for (const d of synthData.areas_of_disagreement) {
          lines.push(`- ${d.point}`);
          for (const pos of d.positions || []) {
            const label = POVER_INFO[pos.pover as Exclude<SpeakerId, 'user'>]?.label ?? pos.pover;
            lines.push(`  - ${label}: ${pos.stance}`);
          }
        }
        lines.push('');
      }
      if (synthData.cruxes?.length) {
        lines.push('**Cruxes:**');
        for (const c of synthData.cruxes) lines.push(`- ${c.question}`);
        lines.push('');
      }
      if (synthData.unresolved_questions?.length) {
        lines.push('**Unresolved Questions:**');
        for (const q of synthData.unresolved_questions) lines.push(`- ${q}`);
      }

      if (lines.length > 0) {
        synthEntry.content = lines.join('\n');
        fixed++;
        log('Fixed synthesis content');
      }
    }
  }
}

if (fixed === 0) {
  log('No entries needed repair');
} else {
  fs.writeFileSync(debatePath, JSON.stringify(session, null, 2), 'utf8');

  const mdPath = debatePath.replace(/\.json$/, '.md');
  fs.writeFileSync(mdPath, formatDebateMarkdown(session), 'utf8');

  log(`Repaired ${fixed} entries → ${debatePath} + ${mdPath}`);
}

console.log(JSON.stringify({ repaired: fixed, path: debatePath }));
