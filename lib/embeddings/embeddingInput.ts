// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Input check for the embedding entry points (t/716).
//
// A prod 500 came from a body whose single `texts` element was itself an array. Nothing checked the
// elements, so it reached the tokenizer, which threw `text.toLowerCase is not a function`, and the caller
// saw an opaque "all fallbacks failed". The check here runs before any worker or session is touched and
// says which element is wrong.

import { ActionableError } from '../debate/errors.js';

/** Stable code on the error for a text that is not a string, so a route can answer 400 without matching text. */
export const INVALID_EMBEDDING_INPUT_CODE = 'INVALID_EMBEDDING_INPUT';

function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Throw an ActionableError (code {@link INVALID_EMBEDDING_INPUT_CODE}) unless `texts` is an array of strings.
 * An empty array and an empty string are valid. `location` names the entry point for the error.
 */
export function assertEmbeddingTexts(texts: unknown, location: string): asserts texts is string[] {
  const bad = (problem: string): ActionableError => new ActionableError({
    goal: 'Compute embeddings for a list of texts',
    problem,
    location,
    nextSteps: [
      'Send `texts` as a flat array of strings, one string per text',
      'A common cause is a JSON serializer that wraps an array twice, giving [["a","b"]] instead of ["a","b"]',
    ],
    code: INVALID_EMBEDDING_INPUT_CODE,
  });
  if (!Array.isArray(texts)) throw bad(`texts must be an array of strings, got ${typeName(texts)}`);
  const index = texts.findIndex(t => typeof t !== 'string');
  if (index !== -1) {
    throw bad(`texts[${index}] must be a string, got ${typeName(texts[index])} (${texts.length} element(s) in the batch)`);
  }
}
