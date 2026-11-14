// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/418 (Security residuals, TL p/10#175; Security p/246#6): dumps go to support attachments, so
// user-profile paths are redacted from the whole dump text, not only from the context.app fields.
// Patterns match inside JSON strings too, where backslashes are doubled. Covered: any drive's user
// profile (names may contain spaces), home/Users segments under any separator (POSIX, file:///,
// and WSL UNC such as \\wsl.localhost\Ubuntu\home\<name>), and UNC host/share prefixes. Redirected
// profiles outside these shapes need the exact profile path from the main process (see t/418).

// A user name runs to the next separator or quote; it may contain spaces, not parentheses.
const NAME = `[^\\\\/"'<>()\\r\\n]+`;
const PROFILE_WIN = new RegExp(`[A-Za-z]:[\\\\/]+Users[\\\\/]+${NAME}`, 'gi');
// A UNC prefix starts a path: after a string start, quote, space, parenthesis or '='. In JSON the prefix
// has four backslashes; raw, two. Replaced before the home-segment rule, so the segment after it is seen.
const UNC_SHARE = /(^|["'\s(=])(?:\\\\\\\\|\\\\)[^\\/"'\s<>]+[\\/]+[^\\/"'\s<>]+/g;
// A home or Users segment under any separator: POSIX /home/<name>, file:///home/<name>, and the segment
// after a UNC share (\home\<name>). The leading separator is kept.
const PROFILE_SEGMENT = new RegExp(`([\\\\/]+)(?:home|Users)[\\\\/]+${NAME}`, 'gi');

/** Redacts user-profile paths and UNC shares from a dump's text. Order matters: drive profiles first. */
export function redactDumpText(text: string): string {
  return text
    .replace(PROFILE_WIN, '%USERPROFILE%')
    .replace(UNC_SHARE, (_m, lead: string) => `${lead}%UNC_SHARE%`)
    .replace(PROFILE_SEGMENT, (_m, sep: string) => `${sep}%USERPROFILE%`);
}
