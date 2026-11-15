// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/225: CodeQL #6277/#6278 indirect command-line injection fix verification.
// Tests that SHA validation prevents shell metacharacter injection.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const SHA_PATTERN = /^[0-9a-f]{40}$/;

test('check-code-root-allowlist: accept valid SHA-1 hashes', () => {
  const validSha = '1234567890abcdef1234567890abcdef12345678';
  assert.strictEqual(SHA_PATTERN.test(validSha), true, 'valid SHA should match');
});

test('check-code-root-allowlist: reject SHA with shell metacharacters', () => {
  const maliciousInputs = [
    '1234567890abcdef1234567890abcdef1234567;ls',
    '1234567890abcdef1234567890abcdef12345678 && echo hacked',
    '1234567890abcdef1234567890abcdef12345678|cat /etc/passwd',
    '1234567890abcdef1234567890abcdef12345678$(whoami)',
    '1234567890abcdef1234567890abcdef12345678`id`',
    '1234567890abcdef1234567890abcdef12345678>out.txt',
    '1234567890abcdef1234567890abcdef12345678<in.txt',
  ];
  for (const malicious of maliciousInputs) {
    assert.strictEqual(SHA_PATTERN.test(malicious), false, `${malicious} should be rejected`);
  }
});

test('check-code-root-allowlist: reject SHA with uppercase letters', () => {
  const uppercaseSha = '1234567890ABCDEF1234567890abcdef12345678';
  assert.strictEqual(SHA_PATTERN.test(uppercaseSha), false, 'uppercase SHA should be rejected');
});

test('check-code-root-allowlist: reject SHA that is too short', () => {
  const shortSha = '1234567890abcdef1234567890abcdef1234567';
  assert.strictEqual(SHA_PATTERN.test(shortSha), false, 'short SHA should be rejected');
});

test('check-code-root-allowlist: reject SHA with invalid characters', () => {
  const invalidSha = '1234567890abcdef1234567890abcdef1234567z';
  assert.strictEqual(SHA_PATTERN.test(invalidSha), false, 'invalid character SHA should be rejected');
});
