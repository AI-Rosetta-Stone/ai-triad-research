// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/418 (Security residuals, TL p/10#175; Security p/246#6): profile paths in the whole dump text are
// redacted, including main-process stack traces embedded in JSON strings.

import { describe, it, expect } from 'vitest';
import { redactDumpText } from './flightRecorderRedact';

describe('redactDumpText — t/418 dump-wide profile redaction', () => {
  it('redacts a profile in a JSON stack trace (doubled backslashes)', () => {
    const line = '{"stack":"at fn (C:\\\\Users\\\\jsnov\\\\repos\\\\app\\\\main.js:10:5)"}';
    expect(redactDumpText(line)).toBe('{"stack":"at fn (%USERPROFILE%\\\\repos\\\\app\\\\main.js:10:5)"}');
  });

  it('redacts a profile on any drive letter', () => {
    expect(redactDumpText('D:\\Users\\alice\\x')).toBe('%USERPROFILE%\\x');
    expect(redactDumpText('E:/Users/bob/x')).toBe('%USERPROFILE%/x');
  });

  it('redacts a user name that contains a space', () => {
    expect(redactDumpText('C:\\Users\\John Smith\\repos\\app')).toBe('%USERPROFILE%\\repos\\app');
  });

  it('redacts POSIX home paths anywhere in the text', () => {
    expect(redactDumpText('at /home/carol/src/a.js')).toBe('at /%USERPROFILE%/src/a.js');
    expect(redactDumpText('path=/Users/dave/x')).toBe('path=/%USERPROFILE%/x');
  });

  it('redacts the user segment of a file:/// URL', () => {
    expect(redactDumpText('file:///home/erin/app.js')).toBe('file:///%USERPROFILE%/app.js');
  });

  it('redacts the home segment of a WSL UNC path, not only the share', () => {
    expect(redactDumpText('\\\\\\\\wsl.localhost\\\\Ubuntu\\\\home\\\\jsnov\\\\x')).toBe('%UNC_SHARE%\\\\%USERPROFILE%\\\\x');
  });

  it('redacts a UNC host and share, including inside JSON, and keeps the rest of the path', () => {
    // The share is "home" here, so it is consumed with the host; "eve" is not a home segment.
    expect(redactDumpText('"\\\\\\\\fileserver\\\\home\\\\eve\\\\x"')).toBe('"%UNC_SHARE%\\\\eve\\\\x"');
  });

  it('does not treat a placeholder remainder as a UNC share', () => {
    expect(redactDumpText('C:\\\\Users\\\\jsnov\\\\repos\\\\app')).toBe('%USERPROFILE%\\\\repos\\\\app');
  });

  it('leaves non-profile paths alone', () => {
    expect(redactDumpText('C:\\Program Files\\app')).toBe('C:\\Program Files\\app');
    expect(redactDumpText('/var/log/app.log')).toBe('/var/log/app.log');
  });

  it('redacts a redirected profile from the exact USERPROFILE, in JSON and raw forms', () => {
    const profile = 'D:\\Profiles\\alice';
    expect(redactDumpText('{"stack":"at D:\\\\Profiles\\\\alice\\\\app\\\\main.js"}', profile))
      .toBe('{"stack":"at %USERPROFILE%\\\\app\\\\main.js"}');
    expect(redactDumpText('D:/Profiles/alice/x', profile)).toBe('%USERPROFILE%/x');
  });

  it('does not match a longer name that merely starts with the profile', () => {
    expect(redactDumpText('D:\\Profiles\\alice2\\x', 'D:\\Profiles\\alice')).toBe('D:\\Profiles\\alice2\\x');
  });

  it('is a no-op for an empty or missing USERPROFILE', () => {
    expect(redactDumpText('D:\\Profiles\\alice\\x', '')).toBe('D:\\Profiles\\alice\\x');
    expect(redactDumpText('D:\\Profiles\\alice\\x', null)).toBe('D:\\Profiles\\alice\\x');
  });
});
