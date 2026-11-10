// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Pure validation for the create-oped-set payload, extracted from opedHandlers so it
// can be unit-tested without the electron coupling of the IPC handler (t/2910).
// Root cause it guards against: a create needs a *source* — a topic, a web-page URL
// (FromUrl mode sends an empty topic), or an uploaded document (t/271 D)
// — plus at least one voice. The inline guard once checked topic only, which rejected
// every FromUrl create (t/2908 regression).

import { ActionableError } from '../../../../lib/debate/errors.js';

export interface CreateOpEdValidationInput {
  topic?: string;
  url?: string;
  documentSource?: { text: string; name: string };
  voices?: readonly unknown[];
}

/**
 * Validate a create-oped-set payload. Returns an {@link ActionableError} to throw when
 * invalid, or `null` when the payload is acceptable. Valid iff a non-blank source
 * (topic, url, or document) is present AND at least one voice is selected.
 */
export function validateCreateOpEdPayload(input: CreateOpEdValidationInput): ActionableError | null {
  const { topic, url, documentSource, voices } = input;
  
  // t/275: Validate document source if provided (check specifics before generic source check)
  if (documentSource) {
    if (!documentSource.text?.trim()) {
      return new ActionableError({
        goal: 'Create op-ed set',
        problem: 'uploaded document is empty',
        location: 'opedHandlers create-oped-set',
        nextSteps: ['Upload a document with content'],
      });
    }
    // t/273#4 item 3: enforce 500k char limit (renderer already applies, but re-validate at handler)
    if (documentSource.text.length > 500_000) {
      return new ActionableError({
        goal: 'Create op-ed set',
        problem: `extracted text exceeds 500k character limit (${documentSource.text.length} chars)`,
        location: 'opedHandlers create-oped-set',
        nextSteps: ['Use a smaller document or section'],
      });
    }
    if (!documentSource.name?.trim()) {
      return new ActionableError({
        goal: 'Create op-ed set',
        problem: 'uploaded document is missing a name',
        location: 'opedHandlers create-oped-set',
        nextSteps: ['Ensure the document has a valid file name'],
      });
    }
    // Validate bare file name (no path separators or parent refs per t/275 spec)
    if (documentSource.name.includes('/') || documentSource.name.includes('\\') || documentSource.name.includes('..')) {
      return new ActionableError({
        goal: 'Create op-ed set',
        problem: 'document name must be a file name, not a path',
        location: 'opedHandlers create-oped-set',
        nextSteps: ['Use only the file name (e.g., "document.pdf"), not the full path'],
      });
    }
  }
  
  // Check that a source is provided: topic OR url OR document
  const hasSource = (topic?.trim() || url?.trim() || (documentSource?.text?.trim()));
  
  if (!hasSource || !voices?.length) {
    return new ActionableError({
      goal: 'Create op-ed set',
      problem: 'a topic, a web-page URL, or an uploaded document, and at least one voice, are required',
      location: 'opedHandlers create-oped-set',
      nextSteps: ['Provide a topic, web-page URL, or upload a document', 'Select at least one voice'],
    });
  }

  return null;
}
