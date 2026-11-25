// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/276: the server's document-source 400s reach the user as Design's plain-language copy (p/25#110).
// Other 400s keep the server's own text.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => undefined }));

import { runOpEdCreate, documentSourceProblem } from './opedStream';

const params = { outlet: 'x', model: 'm', temperature: 0.2 } as never;

/** Runs one create that the server refuses with `message`, and returns the problem the user sees. */
async function problemFor(payload: Record<string, unknown>, message: string): Promise<string> {
  const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: message }), { status: 400 }));
  const err = await runOpEdCreate(fetchFn, { params, voices: ['acc'], ...payload } as never).then(() => null, (e: unknown) => e) as { problem: string };
  return err.problem;
}

describe('documentSourceProblem (t/276)', () => {
  it('maps the four document 400s to Design\'s wording', () => {
    expect(documentSourceProblem('documentText exceeds 500000 characters')).toBe('This document is too long. Use a shorter document. Documents can be up to 500,000 characters of text.');
    expect(documentSourceProblem('sourceName exceeds 255 characters')).toBe('The file name is too long. Shorten the file name, then choose the file again.');
    expect(documentSourceProblem('sourceName must be a bare file name: no path separators and no ".."')).toBe('This file name contains a slash or "..". Rename the file to remove them, then choose it again.');
    expect(documentSourceProblem('documentText (string) is required with sourceName')).toBe("We couldn't read this document. It may be empty or in a format we can't read. Choose the file again.");
    expect(documentSourceProblem('sourceName is required with documentText')).toBe("We couldn't read this document. It may be empty or in a format we can't read. Choose the file again.");
  });

  it('returns null for any other message, so the server text is kept', () => {
    expect(documentSourceProblem('topic is required and must be a non-empty string (≤2000 chars)')).toBeNull();
  });
});

describe('runOpEdCreate document 400s (t/276)', () => {
  it('shows the plain-language copy for a document refusal', async () => {
    const problem = await problemFor({ documentSource: { text: 'alpha', name: 'a.pdf' } }, 'sourceName exceeds 255 characters');
    expect(problem).toBe('The file name is too long. Shorten the file name, then choose the file again.');
  });

  it('keeps the server text for a topic refusal', async () => {
    const problem = await problemFor({ topic: 'x' }, 'sourceName exceeds 255 characters');
    expect(problem).toBe('sourceName exceeds 255 characters');
  });
});
