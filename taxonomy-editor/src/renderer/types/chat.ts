// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { SpeakerId, TaxonomyRef } from './debate.js';
import type { UrlContextMetadata } from '@lib/ai-client/index';
import type { TagMode } from '@lib/debate/types/session';

export type ChatMode = 'brainstorm' | 'inform' | 'decide';

export interface ChatEntry {
  id: string;
  timestamp: string;
  speaker: SpeakerId | 'system';
  content: string;
  taxonomy_refs: TaxonomyRef[];
  metadata?: Record<string, unknown>;
  url_context_metadata?: UrlContextMetadata;
  /** t/4848: the full prompt sent to the model for this turn, for the How panel's "Raw Prompt"
   *  section. Write-once at generation time, same as `content` — never retroactively edited.
   *  Optional: absent on entries from before this field existed, or any generation path that
   *  doesn't capture it. ServerAPI populates it in `server/routes/chat.ts`. */
  raw_prompt?: string;
  /** t/4848: the model's raw response before rendering/filtering, for the How panel's "Raw
   *  Response" section. Same write-once/optional contract as `raw_prompt`. */
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
  /** Chat-specific AI model override. If set, used instead of the global model. */
  chat_model?: string;
  /** t/4774: chosen at chat creation from the shared ModelPicker's temperature slider, 0-2.
   *  Absent means "not set" — the two useChatStore.ts call sites fall back to the mode's
   *  default (CHAT_MODE_TEMPERATURE), so an old chat created before this field existed behaves
   *  exactly as it did before (AC4). Never recomputed after creation. */
  temperature?: number;
  /** POV tag the chat is set to (t/3995, spec §2). Both fields are set together; absent = untagged. */
  pov_tag?: string;
  tag_mode?: TagMode;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  mode: ChatMode;
  pover: Exclude<SpeakerId, 'user'>;
  chat_model?: string;
}

export const CHAT_MODE_INFO: Record<ChatMode, {
  label: string;
  description: string;
  placeholder: string;
}> = {
  brainstorm: {
    label: 'Brainstorm',
    description: 'Explore ideas freely',
    placeholder: 'What do you want to explore?',
  },
  inform: {
    label: 'Inform',
    description: 'Learn about a topic',
    placeholder: 'What do you want to learn about?',
  },
  decide: {
    label: 'Decide',
    description: 'Work through a decision',
    placeholder: 'What decision are you facing?',
  },
};
