// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/276 / t/645 example scenario: the New op-ed dialog's Document source on the real desktop path.
// dialog.showOpenDialog is stubbed to fixture files; IPC, main-process extraction and the chip are real.
// Fixtures: set CAPTURE_FIXTURES to a folder with a text-layer PDF (text.pdf) and an image-only PDF (image-only.pdf)
// that we own. Never use a real source document.
import { join } from 'node:path';

export default async function opedDocument(h) {
  const fixtures = process.env.CAPTURE_FIXTURES;
  if (!fixtures) throw new Error('Set CAPTURE_FIXTURES to a folder with text.pdf and image-only.pdf (our own fixtures).');
  const { win } = h;
  await win.waitForTimeout(8000); // first load: taxonomy and models

  await win.getByRole('button', { name: /Op-?Ed/i }).first().click().catch(() => {});
  await win.getByRole('button', { name: /New op-?ed/i }).first().click({ timeout: 20_000 });
  await win.getByRole('radio', { name: 'Document' }).click({ timeout: 20_000 });

  // Ready: a readable PDF.
  await h.stubOpenDialog(join(fixtures, 'text.pdf'));
  await win.getByRole('button', { name: 'Choose a file…' }).click();
  await win.locator('.oped-doc-chip, .oped-doc-error').first().waitFor({ timeout: 60_000 });
  for (const theme of ['harvard', 'dark']) {
    await h.setTheme(theme);
    await h.label(`PACKED APP, dialog stubbed - Document ready - ${theme}`);
    await h.shot(`oped-document-ready_${theme}_1280`);
  }

  // Failed: an image-only PDF (no text layer).
  await win.getByRole('button', { name: /^Remove / }).click().catch(() => {});
  await h.stubOpenDialog(join(fixtures, 'image-only.pdf'));
  await win.getByRole('button', { name: 'Choose a file…' }).click();
  await win.locator('.oped-doc-error').first().waitFor({ timeout: 60_000 });
  await h.setTheme('harvard');
  await h.label('PACKED APP, dialog stubbed - Document failed - harvard');
  await h.shot('oped-document-failed_harvard_1280');
}
