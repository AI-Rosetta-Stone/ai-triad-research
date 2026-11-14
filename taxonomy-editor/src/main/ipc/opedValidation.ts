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

const MAX_DOCUMENT_CHARS = 500_000; // t/273#4 item 3: the renderer applies it too; re-validated here

function invalid(problem: string, nextSteps: string[]): ActionableError {
  return new ActionableError({
    goal: 'Create op-ed set',
    problem,
    location: 'opedHandlers create-oped-set',
    nextSteps,
  });
}

/** t/275: validate an uploaded document source. Checks run in order: text, size, name, bare name. */
function validateDocumentSource(doc: { text: string; name: string }): ActionableError | null {
  if (!doc.text?.trim()) {
    return invalid('uploaded document is empty', ['Upload a document with content']);
  }
  if (doc.text.length > MAX_DOCUMENT_CHARS) {
    return invalid(`extracted text exceeds 500k character limit (${doc.text.length} chars)`, ['Use a smaller document or section']);
  }
  if (!doc.name?.trim()) {
    return invalid('uploaded document is missing a name', ['Ensure the document has a valid file name']);
  }
  // Bare file name only (no path separators or parent refs per the t/275 spec).
  if (doc.name.includes('/') || doc.name.includes('\\') || doc.name.includes('..')) {
    return invalid('document name must be a file name, not a path', ['Use only the file name (e.g., "document.pdf"), not the full path']);
  }
  return null;
}

/**
 * Validate a create-oped-set payload. Returns an {@link ActionableError} to throw when
 * invalid, or `null` when the payload is acceptable. Valid iff a non-blank source
 * (topic, url, or document) is present AND at least one voice is selected.
 */
export function validateCreateOpEdPayload(input: CreateOpEdValidationInput): ActionableError | null {
  const { topic, url, documentSource, voices } = input;

  // t/275: a document source is checked for specifics before the generic source check.
  if (documentSource) {
    const docError = validateDocumentSource(documentSource);
    if (docError) return docError;
  }

  // Check that a source is provided: topic OR url OR document
  const hasSource = (topic?.trim() || url?.trim() || (documentSource?.text?.trim()));

  if (!hasSource || !voices?.length) {
    return invalid(
      'a topic, a web-page URL, or an uploaded document, and at least one voice, are required',
      ['Provide a topic, web-page URL, or upload a document', 'Select at least one voice'],
    );
  }

  return null;
}

/** Throws the validation error for an invalid create-oped-set payload; otherwise returns. */
export function assertCreateOpEdPayload(input: CreateOpEdValidationInput): void {
  const error = validateCreateOpEdPayload(input);
  if (error) throw error;
}
