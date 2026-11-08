// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

export type Phase2Flag =
  | 'AI_CLIENT_V2'
  | 'AI_CLIENT_V2_ENABLED'
  | 'DEBATE_NEW_ENGINE'
  | 'TAXONOMY_CACHE_V2';

export function getFlagValue(flag: Phase2Flag): boolean {
  return typeof process !== 'undefined' && process.env[flag]?.toLowerCase() === 'true';
}
