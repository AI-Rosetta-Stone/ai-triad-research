// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Fixture data for testing batch regeneration.
 */

import type { ChatSession } from '../types.js';

/** Old chat fixture (no raw_prompt/raw_response, no ref labels). */
export const oldChatFixture: ChatSession = {
  id: 'chat-old-001',
  title: 'Old Chat Example',
  created_at: '2026-06-08T10:00:00Z',
  updated_at: '2026-06-08T10:30:00Z',
  mode: 'brainstorm',
  topic: 'AI safety approaches',
  pover: 'accelerationist',
  temperature: 0.7,
  transcript: [
    {
      id: 'turn-1-user',
      timestamp: '2026-06-08T10:00:00Z',
      speaker: 'user',
      content: 'What are the main approaches to AI safety?',
      taxonomy_refs: [],
    },
    {
      id: 'turn-1-assistant',
      timestamp: '2026-06-08T10:05:00Z',
      speaker: 'accelerationist',
      content: 'There are several key approaches: capability control, interpretability, and alignment research.',
      taxonomy_refs: [
        {
          node_id: 'saf-grounding-001',
          relevance: 'Core safety research methodology',
        },
        {
          node_id: 'acc-beliefs-050',
          relevance: 'Accelerationist perspective on safety',
        },
      ],
    },
    {
      id: 'turn-2-user',
      timestamp: '2026-06-08T10:10:00Z',
      speaker: 'user',
      content: 'Can you elaborate on capability control?',
      taxonomy_refs: [],
    },
    {
      id: 'turn-2-assistant',
      timestamp: '2026-06-08T10:15:00Z',
      speaker: 'accelerationist',
      content: 'Capability control involves limiting what an AI system can do through architectural constraints and access restrictions.',
      taxonomy_refs: [
        {
          node_id: 'saf-grounding-015',
          relevance: 'Technical constraint mechanisms',
        },
      ],
    },
  ],
};

/** New chat fixture (has raw_prompt/raw_response, has ref labels). */
export const newChatFixture: ChatSession = {
  id: 'chat-new-001',
  title: 'New Chat Example',
  created_at: '2026-11-10T14:00:00Z',
  updated_at: '2026-11-10T14:30:00Z',
  mode: 'inform',
  topic: 'Paradise Engineering',
  pover: 'skeptic',
  temperature: 0.8,
  transcript: [
    {
      id: 'turn-1-user',
      timestamp: '2026-11-10T14:00:00Z',
      speaker: 'user',
      content: 'What is Paradise Engineering?',
      taxonomy_refs: [],
    },
    {
      id: 'turn-1-assistant',
      timestamp: '2026-11-10T14:05:00Z',
      speaker: 'skeptic',
      content: 'Paradise Engineering is the proposal to use advanced technology to redesign ecosystems and eliminate suffering [acc-desires-033].',
      taxonomy_refs: [
        {
          node_id: 'acc-desires-033',
          label: 'Paradise Engineering',
          relevance: 'Central concept in accelerationist thought',
        },
      ],
      raw_prompt: 'You are a skeptic POV. Answer about Paradise Engineering...',
      raw_response: 'Paradise Engineering is the proposal to use advanced technology to redesign ecosystems and eliminate suffering [acc-desires-033].',
    },
  ],
};
