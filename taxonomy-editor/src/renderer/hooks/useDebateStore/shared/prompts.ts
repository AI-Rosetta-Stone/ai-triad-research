// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebateAudience, DocumentAnalysis, GapInjection } from '../../../types/debate';
import type { SeatSouls } from './seatSouls';
import type { TopicCritique } from '@lib/debate/topicCritique';
import {
  clarificationPrompt,
  concludingPrompt,
  debateResponsePrompt,
  probingQuestionsPrompt,
  factCheckPrompt,
  contextCompressionPrompt,
} from '../../../prompts/debate';
import { formatCritiqueForRefinement } from '@lib/debate/topicCritique';

export function buildClarificationPrompt(topic: string, sourceContent?: string, audience?: DebateAudience, lineageContext?: string): string {
  return clarificationPrompt(topic, sourceContent, audience, lineageContext);
}

export function buildSynthesisPrompt(
  originalTopic: string,
  clarifications: { speaker: string; questions: string[]; answers: string }[],
  audience?: DebateAudience,
  critique?: TopicCritique | null,
): string {
  let qaPairs = '';
  for (const c of clarifications) {
    qaPairs += `\n${c.speaker} asked:\n`;
    for (const q of c.questions) qaPairs += `  - ${q}\n`;
    qaPairs += `User answered: ${c.answers}\n`;
  }
  const critiqueContext = critique ? formatCritiqueForRefinement(critique) : undefined;
  return concludingPrompt(originalTopic, qaPairs, audience, critiqueContext);
}

/** `souls` is the seat's resolved souls (seatSouls, t/3975) and is required: the persona comes only from it,
 *  so a caller cannot fall back to the base soul by omitting it (SO e/256#9). */
export function buildDebateResponsePrompt(
  souls: SeatSouls,
  topic: string,
  taxonomyContext: string,
  recentTranscript: string,
  question: string,
  addressing: string,
  sourceContent?: string,
  length: string = 'medium',
  docAnalysis?: DocumentAnalysis,
  audience?: DebateAudience,
  lineageContext?: string,
): string {
  const { soul, opponentSouls } = souls;
  return debateResponsePrompt(soul.label, soul.pov, soul.personality, topic, taxonomyContext, recentTranscript, question, addressing, sourceContent, length, docAnalysis, audience, lineageContext, soul, opponentSouls);
}

export function formatGapHint(gapInjections?: GapInjection[]): string {
  const args = gapInjections?.[0]?.arguments;
  if (!args || args.length === 0) return '';
  const lines = args.map((g, i) =>
    `  ${i + 1}. [${g.gap_type}] ${g.argument} (Why missing: ${g.why_missing})`,
  );
  return `\n\n## Identified Debate Gaps (unaddressed)\nThe following gaps were identified mid-debate but have NOT yet been substantively addressed by any debater. Prioritize steering the conversation toward these:\n${lines.join('\n')}\n`;
}


export function buildProbingQuestionsPrompt(
  topic: string,
  transcript: string,
  unreferencedNodes: string[],
  hasSourceDocument: boolean = false,
  audience?: DebateAudience,
): string {
  return probingQuestionsPrompt(topic, transcript, unreferencedNodes, hasSourceDocument, undefined, audience);
}

export function buildFactCheckPrompt(
  selectedText: string,
  statementContext: string,
  taxonomyNodes: string,
  conflictData: string,
  audience?: DebateAudience,
  webSearchRan?: boolean,
): string {
  return factCheckPrompt(selectedText, statementContext, taxonomyNodes, conflictData, audience, webSearchRan);
}

export function buildContextCompressionPrompt(
  entries: string,
  audience?: DebateAudience,
): string {
  return contextCompressionPrompt(entries, audience);
}
