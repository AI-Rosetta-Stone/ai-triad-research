// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { readFileSync } from 'fs';
import { join } from 'path';
import type { OpEdParams } from './types.js';
import { loadOutletsData } from './loadOutlets.js';
import type { PovKey } from '../debate/types.js';
import type { OutletBandStyle } from './outletBands.js';

export interface SourceBrief {
  author?: string;
  actor_type?: string;
  thesis?: string;
  stance?: string;
  primary_recommendations?: string[];
  key_claims?: string[];
  readable?: boolean;
}

export interface PromptContext {
  topic: string;
  params: OpEdParams;
  pov: PovKey;
  povLabel: string;
  voiceBlock: string;
  groundingNodes: string;
  situations: string;
  sourceMaterial: string;
  sourceBrief?: SourceBrief;
  outletGuidance: string;
  targetWords: number;
  style?: OutletBandStyle;
}

export interface AssembledPrompt {
  system: string;
  user: string;
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

export function loadPromptTemplate(promptsDir: string, name: string): string {
  return readFileSync(join(promptsDir, `${name}.prompt`), 'utf-8');
}

export function loadAndAssemblePrompt(promptsDir: string, ctx: PromptContext): AssembledPrompt {
  const newsHookText = ctx.params.newsHook?.trim()
    ? ctx.params.newsHook
    : '(none supplied — do NOT invent or assert a specific dated news event, pending vote, ruling, '
    + 'report, milestone, or named regulation. Open on the enduring stakes of the issue itself — a '
    + 'trend, a structural tension, or a concrete illustrative scene — with no claim that any '
    + 'particular thing happened "this week" or is "currently pending." If SOURCE MATERIAL is '
    + 'provided above, anchor the opening in what THAT document argues or reports, not an external event.)';
  const thesisText = ctx.params.thesis?.trim()
    ? ctx.params.thesis
    : '(none supplied — derive a clear, arguable thesis that follows from your camp value hierarchy)';
  const authorBioText = ctx.params.authorBio?.trim()
    ? ctx.params.authorBio
    : '(none supplied — write a generic authority line the author can replace, e.g. "[Author], [affiliation]")';

  const sd = loadOutletsData().styleDefaults;
  const s = ctx.style;
  const styleAudience = s?.audience ?? sd.audience;
  const styleReadingLevel = s?.readingLevel ?? sd.readingLevel;
  const styleSentence = s?.sentenceMechanics ?? sd.sentenceMechanics;
  const styleParagraph = s?.paragraphMechanics ?? sd.paragraphMechanics;
  const styleJargon = s?.jargonGuidance ?? sd.jargonGuidance;
  const styleBodyFormat = s?.bodyFormat ?? sd.bodyFormat;

  const system = interpolate(loadPromptTemplate(promptsDir, 'op-ed-generation-system'), {
    POV_LABEL: ctx.povLabel,
    VOICE_BLOCK: ctx.voiceBlock,
    WORD_COUNT: String(ctx.targetWords),
    OUTLET_GUIDANCE: ctx.outletGuidance,
    STYLE_AUDIENCE: styleAudience,
    STYLE_READING_LEVEL: styleReadingLevel,
    STYLE_SENTENCE: styleSentence,
    STYLE_PARAGRAPH: styleParagraph,
    STYLE_JARGON: styleJargon,
  });

  const user = interpolate(loadPromptTemplate(promptsDir, 'op-ed-generation-user'), {
    TOPIC: ctx.topic,
    WORD_COUNT: String(ctx.targetWords),
    OUTLET_GUIDANCE: ctx.outletGuidance,
    NEWS_HOOK: newsHookText,
    THESIS: thesisText,
    AUTHOR_BIO: authorBioText,
    SOURCE_MATERIAL: ctx.sourceMaterial,
    GROUNDING_NODES: ctx.groundingNodes,
    SITUATIONS: ctx.situations,
    SOURCE_AUTHOR: ctx.sourceBrief?.author ?? '',
    SOURCE_ACTOR_TYPE: ctx.sourceBrief?.actor_type ?? '',
    SOURCE_THESIS: ctx.sourceBrief?.thesis ?? '',
    SOURCE_STANCE: ctx.sourceBrief?.stance ?? '',
    SOURCE_RECOMMENDATIONS: ctx.sourceBrief?.primary_recommendations?.join('; ') ?? '',
    STYLE_BODY_FORMAT: styleBodyFormat,
    SOURCE_KEY_CLAIMS: ctx.sourceBrief?.key_claims?.length
      ? ctx.sourceBrief.key_claims.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
      : '(none extracted)',
  });

  return { system, user };
}

export function assembleSourceBriefPrompt(promptsDir: string, sourceMaterial: string): string {
  return interpolate(loadPromptTemplate(promptsDir, 'op-ed-source-brief'), {
    SOURCE_MATERIAL: sourceMaterial,
  });
}

export function assembleReflectionPrompt(
  promptsDir: string,
  opedBody: string,
  groundingList: string,
  sourceClaims = '(none)',
): string {
  return interpolate(loadPromptTemplate(promptsDir, 'op-ed-grounding-reflection'), {
    OPED_BODY: opedBody,
    GROUNDING_LIST: groundingList,
    SOURCE_CLAIMS: sourceClaims,
  });
}

/**
 * The readability-edit prompt, with the rules taken from the SAME outlet targets that triggered the edit and
 * built its violations line (t/202). Before, the rules were fixed at grade 10, so a looser outlet (Tech
 * Policy Press: FK 16) got "no higher than 11" beside "target: no higher than 16".
 */
export function assembleReadabilityEditPrompt(
  promptsDir: string,
  body: string,
  violations: string,
  targets: { fkMax: number; maxSentWords: number; maxParaWords: number },
  style?: OutletBandStyle,
): string {
  const sd = loadOutletsData().styleDefaults;
  return interpolate(loadPromptTemplate(promptsDir, 'op-ed-readability-edit'), {
    BODY: body,
    VIOLATIONS: violations,
    FK_MAX: String(targets.fkMax),
    MAX_SENT_WORDS: String(targets.maxSentWords),
    MAX_PARA_WORDS: String(targets.maxParaWords),
    STYLE_SENTENCE: style?.sentenceMechanics ?? sd.sentenceMechanics,
    STYLE_PARAGRAPH: style?.paragraphMechanics ?? sd.paragraphMechanics,
    STYLE_JARGON: style?.jargonGuidance ?? sd.jargonGuidance,
  });
}

export function assembleCoherenceJudgePrompt(
  promptsDir: string,
  body: string,
  thesis: string,
  valueHierarchy: string,
): string {
  return interpolate(loadPromptTemplate(promptsDir, 'op-ed-coherence-judge'), {
    BODY: body,
    THESIS: thesis,
    VALUE_HIERARCHY: valueHierarchy,
  });
}

export function assembleCoherenceRewritePrompt(
  promptsDir: string,
  body: string,
  flaggedContradictions: string,
): string {
  return interpolate(loadPromptTemplate(promptsDir, 'op-ed-coherence-rewrite'), {
    BODY: body,
    FLAGGED_CONTRADICTIONS: flaggedContradictions,
  });
}
