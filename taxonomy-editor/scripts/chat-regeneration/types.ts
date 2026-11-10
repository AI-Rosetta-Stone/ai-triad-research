// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Type definitions for chat batch regeneration.
 */

export type ChatMode = 'brainstorm' | 'inform' | 'decide';
export type SpeakerId = 'accelerationist' | 'safetyist' | 'skeptic' | 'user' | 'system';

export interface TaxonomyRef {
  node_id: string;
  label?: string;
  relevance: string;
}

export interface ChatEntry {
  id: string;
  timestamp: string;
  speaker: SpeakerId;
  content: string;
  taxonomy_refs: TaxonomyRef[];
  metadata?: Record<string, unknown>;
  raw_prompt?: string;
  raw_response?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  mode: ChatMode;
  topic: string;
  pover: Exclude<SpeakerId, 'user'>;
  transcript: ChatEntry[];
  chat_model?: string;
  temperature?: number;
  pov_tag?: string;
  tag_mode?: string;
}

/** Extended session with regeneration metadata. */
export interface RegeneratedChatSession extends ChatSession {
  regenerated_at: string;
  regenerated_from_version: string;
}

/** Dry-run analysis result per chat. */
export interface ChatRegenerationPlan {
  id: string;
  title: string;
  turns: number;
  userTurns: number;
  assistantTurns: number;
  model: string;
  estimatedCalls: number;
  estimatedCost: number;
  alreadyRegenerated: boolean;
  reason?: string; // why skipped (if applicable)
}

/** Overall dry-run report. */
export interface DryRunReport {
  timestamp: string;
  mode: 'community' | 'personal' | 'both';
  chats: ChatRegenerationPlan[];
  totalChats: number;
  toRegenerate: number;
  totalEstimatedCalls: number;
  totalEstimatedCost: number;
  errors: Array<{ chatId: string; error: string }>;
}

/** Archive metadata. */
export interface ArchiveInfo {
  originalId: string;
  archivedAt: string;
  archivePath: string;
  reason: string;
}
