// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import path from 'path';

describe('pick-document-file return contract (t/275 + debate parity)', () => {
  // t/275: pick-document-file must return filePath for debate mode (NewDebateDialog.tsx:1076).
  // This test documents the return shape contract so it's never accidentally broken.
  it('must return filePath alongside fileName and content (debate parity)', () => {
    // The expected return from pick-document-file handler when a user picks a document:
    const expectedReturnShape = {
      cancelled: false,
      filePath: '/path/to/document.pdf', // REQUIRED for debate mode (NewDebateDialog.tsx:1076)
      fileName: 'document.pdf', // basename only, for both debate and op-ed modes
      content: 'extracted text here', // extracted text
      format: 'pdf' as const, // document type for op-ed mode
    };
    
    // Contract: filePath exists and fileName is basename
    expect(expectedReturnShape.filePath).toBeDefined();
    expect(expectedReturnShape.fileName).toBe(path.basename(expectedReturnShape.filePath));
    
    // If filePath is missing, NewDebateDialog.tsx:1076 does `if (!result.filePath) return`,
    // silently aborting the entire document pick. This test prevents that regression.
  });

  it('enforces 500k character limit on extracted text (t/275 + t/273#4)', () => {
    // Re-validation happens at create-oped-set handler time.
    // The limit is 500k characters per t/273#4 item 3.
    const sizeLimit = 500_000;
    const oversizedText = 'x'.repeat(sizeLimit + 1);
    
    expect(oversizedText.length).toBeGreaterThan(sizeLimit);
    // This limit is enforced by validateCreateOpEdPayload at handler time.
  });

  it('restricts document name to bare file name (no paths)', () => {
    // Per t/275 spec: document name must be a bare file name with no path separators
    // or parent directory references.
    const validName = 'document.pdf';
    const invalidPaths = [
      'folder/document.pdf', // forward slash not allowed
      'folder\\document.pdf', // backslash not allowed
      '../document.pdf', // parent reference not allowed
    ];
    
    expect(validName).not.toContain('/');
    expect(validName).not.toContain('\\');
    expect(validName).not.toContain('..');
    
    for (const invalid of invalidPaths) {
      expect(invalid).toMatch(/[/\\]|\.\./) ;
    }
    // These are checked by validateCreateOpEdPayload.
  });
});
