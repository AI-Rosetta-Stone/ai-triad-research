// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Dry-run analysis for chat batch regeneration.
 * Scans chats, estimates costs, and generates reports without making changes.
 */

import type { ChatSession, ChatRegenerationPlan, DryRunReport } from './types.js';

const COST_PER_CALL = 0.001; // Placeholder; actual cost depends on model and tokens
const AVG_TOKENS_PER_TURN = 500;

/**
 * Analyze a single chat for regeneration.
 * Estimates AI calls needed, cost, and checks for already-regenerated chats.
 */
export function analyzeChatSession(
  session: ChatSession,
  options: { force?: boolean } = {},
): ChatRegenerationPlan {
  // Count user turns (each triggers an assistant response)
  const userTurns = session.transcript.filter(e => e.speaker === 'user').length;
  const assistantTurns = session.transcript.filter(e => e.speaker !== 'user').length;

  // Check if already regenerated
  const regenerated = (session as Record<string, unknown>).regenerated_at !== undefined;
  if (regenerated && !options.force) {
    return {
      id: session.id,
      title: session.title,
      turns: session.transcript.length,
      userTurns,
      assistantTurns,
      model: session.chat_model || 'unknown',
      estimatedCalls: 0,
      estimatedCost: 0,
      alreadyRegenerated: true,
      reason: 'Already regenerated; use --force to re-run',
    };
  }

  // Estimate AI calls: one per user turn (each gets an assistant response)
  const estimatedCalls = userTurns;
  const estimatedCost = estimatedCalls * COST_PER_CALL;

  return {
    id: session.id,
    title: session.title,
    turns: session.transcript.length,
    userTurns,
    assistantTurns,
    model: session.chat_model || 'unknown',
    estimatedCalls,
    estimatedCost,
    alreadyRegenerated: false,
  };
}

/**
 * Generate a dry-run report for a batch of chats.
 */
export function generateDryRunReport(
  chats: ChatSession[],
  mode: 'community' | 'personal' | 'both' = 'both',
  options: { force?: boolean } = {},
): DryRunReport {
  const plans: ChatRegenerationPlan[] = [];
  const errors: Array<{ chatId: string; error: string }> = [];

  for (const chat of chats) {
    try {
      const plan = analyzeChatSession(chat, options);
      plans.push(plan);
    } catch (err) {
      errors.push({
        chatId: chat.id,
        error: String(err),
      });
    }
  }

  const toRegenerate = plans.filter(p => !p.alreadyRegenerated).length;
  const totalEstimatedCalls = plans.reduce((sum, p) => sum + p.estimatedCalls, 0);
  const totalEstimatedCost = plans.reduce((sum, p) => sum + p.estimatedCost, 0);

  return {
    timestamp: new Date().toISOString(),
    mode,
    chats: plans,
    totalChats: chats.length,
    toRegenerate,
    totalEstimatedCalls,
    totalEstimatedCost,
    errors,
  };
}

/**
 * Format a dry-run report as human-readable text.
 */
export function formatDryRunReport(report: DryRunReport): string {
  const lines: string[] = [
    `Batch Regeneration Dry Run (${report.mode} chats)`,
    `Generated: ${report.timestamp}`,
    '',
    `Total chats: ${report.totalChats}`,
    `To regenerate: ${report.toRegenerate}`,
    `Estimated AI calls: ${report.totalEstimatedCalls}`,
    `Estimated cost: $${report.totalEstimatedCost.toFixed(2)}`,
    '',
    'Chats:',
  ];

  for (const plan of report.chats) {
    if (plan.alreadyRegenerated) {
      lines.push(`  [SKIP] ${plan.id}: ${plan.title} (${plan.reason})`);
    } else {
      lines.push(
        `  [TODO] ${plan.id}: ${plan.title}`,
        `         Turns: ${plan.turns} (${plan.userTurns} user, ${plan.assistantTurns} assistant)`,
        `         Model: ${plan.model}`,
        `         Estimated calls: ${plan.estimatedCalls}, cost: $${plan.estimatedCost.toFixed(2)}`,
      );
    }
  }

  if (report.errors.length > 0) {
    lines.push('', 'Errors:');
    for (const err of report.errors) {
      lines.push(`  ${err.chatId}: ${err.error}`);
    }
  }

  return lines.join('\n');
}
