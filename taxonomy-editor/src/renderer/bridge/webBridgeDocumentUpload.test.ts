// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/276: "Upload document" on web. The picked File's bytes go to POST /api/documents/extract.
// file.text() corrupted PDF and DOCX, so these tests pin that the request body is the File itself.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => undefined }));

import { api } from './web-bridge';

/** Makes the bridge's hidden file input "pick" the given File as soon as it is clicked. */
function stubPicker(file: File | null) {
  const input = {
    files: file ? [file] : [],
    onchange: null as (() => void) | null,
    oncancel: null as (() => void) | null,
    click() { if (file) this.onchange?.(); else this.oncancel?.(); },
  };
  vi.spyOn(document, 'createElement').mockImplementation(() => input as unknown as HTMLElement);
}

describe('web-bridge pickDocumentFile (t/276)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends the File bytes to /api/documents/extract and returns the extracted text', async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'report.pdf', { type: 'application/pdf' });
    stubPicker(file);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'extracted text', format: 'pdf', words: 2, warnings: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.pickDocumentFile();

    expect(result).toEqual({ cancelled: false, filePath: 'report.pdf', content: 'extracted text' });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/documents/extract'));
    expect(call, 'expected a fetch to POST /api/documents/extract').toBeTruthy();
    const init = call![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect((init.headers as Record<string, string>)['X-Document-Name']).toBe('report.pdf');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
  });

  it('a cancelled picker resolves cancelled and makes no request', async () => {
    stubPicker(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.pickDocumentFile()).resolves.toEqual({ cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a file over 10 MB before any upload (the server cap is authoritative)', async () => {
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' });
    stubPicker(big);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.pickDocumentFile()).rejects.toThrow(/limit is 10 MB/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['page.html', 'page.htm'])('accepts %s, as the old picker did, and uploads its bytes', async (name) => {
    const file = new File(['<p>hello</p>'], name, { type: 'text/html' });
    stubPicker(file);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'hello' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.pickDocumentFile()).resolves.toEqual({ cancelled: false, filePath: name, content: 'hello' });
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(file);
  });

  it('refuses an unsupported file type before any upload', async () => {
    stubPicker(new File(['1,2'], 'sheet.csv', { type: 'text/csv' }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.pickDocumentFile()).rejects.toThrow(/isn't a supported file type/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // t/276 harness finding: the server's `error` is an ActionableError dump, and the bridge's generic
  // mutation error wraps it in another one. The Document field shows err.message, so a failed read
  // must reject with one plain line chosen by status and code, never the server text.
  const DUMP = '\n  Goal:     Extract text\n  Error:    Could not parse the PDF\n  Location: lib/extraction\n  Resolve:\n  1. Try another file';
  const failing = (status: number, code?: string) => vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: DUMP, code }), { status, headers: { 'content-type': 'application/json' } }),
  );
  const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'brief.pdf', { type: 'application/pdf' });

  it.each([
    [422, 'CORRUPT_DOCUMENT', "Couldn't read text from this file. If it's a scanned PDF it has no text layer: try a text-based PDF or another format."],
    [422, 'EXTRACTION_TIMEOUT', "Couldn't read text from this file. If it's a scanned PDF it has no text layer: try a text-based PDF or another format."],
    [422, 'EMPTY_DOCUMENT', 'This file has no readable text.'],
    [422, 'ENCRYPTED_DOCUMENT', '“brief.pdf” is password-protected. Remove the password, then choose it again.'],
    [413, 'SIZE_LIMIT_EXCEEDED', '“brief.pdf” is over the 10 MB limit.'],
    [415, 'UNSUPPORTED_FORMAT', "“brief.pdf” isn't a supported file type. Choose a PDF, Word (.docx), text or Markdown file."],
    [429, 'EXTRACTION_BUSY', 'The server is busy reading other documents. Try again in a minute.'],
    [500, 'EXTRACTION_FAILED', "Couldn't read text from this file. If it's a scanned PDF it has no text layer: try a text-based PDF or another format."],
  ])('HTTP %i %s rejects with the plain line only', async (status, code, line) => {
    stubPicker(pdf());
    vi.stubGlobal('fetch', failing(status, code));
    const err = await api.pickDocumentFile().then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe(line);
    expect(err?.message).not.toMatch(/Goal:|Location:|Resolve:|HTTP \d{3}/);
  });

  it('a non-JSON error body still gets a plain line from the status', async () => {
    stubPicker(pdf());
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 })));
    await expect(api.pickDocumentFile()).rejects.toThrow(/^Couldn't read text from this file\./);
  });
});
