// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/276: the web create body. The server takes documentText + sourceName for a document (exact names),
// and a topic otherwise. A document must never go out as a topic, and topic must not ride along with it.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => undefined }));

import { runOpEdCreate } from './opedStream';

/** Captures the POST body. A 400 makes runOpEdCreate reject after the request, which the test accepts. */
async function bodyFor(payload: Parameters<typeof runOpEdCreate>[1]): Promise<Record<string, unknown>> {
  const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'captured' }), { status: 400 }));
  await expect(runOpEdCreate(fetchFn, payload)).rejects.toThrow();
  const init = fetchFn.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const params = { outlet: 'x', model: 'm', temperature: 0.2 } as never;

describe('runOpEdCreate body (t/276)', () => {
  it('sends documentText and sourceName for a document, with no topic', async () => {
    const body = await bodyFor({ documentSource: { text: 'alpha beta', name: 'report.pdf' }, params, voices: ['acc', 'saf'] } as never);
    expect(body).toEqual({ documentText: 'alpha beta', sourceName: 'report.pdf', povs: ['acc', 'saf'], params });
    expect(body).not.toHaveProperty('topic');
    expect(body).not.toHaveProperty('documentSource');
  });

  it('sends topic for a topic source, with no document fields', async () => {
    const body = await bodyFor({ topic: 'Audits', params, voices: ['acc'] } as never);
    expect(body).toEqual({ topic: 'Audits', povs: ['acc'], params });
    expect(body).not.toHaveProperty('documentText');
    expect(body).not.toHaveProperty('sourceName');
  });
});
