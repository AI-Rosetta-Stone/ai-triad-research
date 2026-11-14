// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/418 (Security residuals, TL p/10#175): dumps go to support attachments, so user-profile paths are
// redacted from the whole dump text, not only from the context.app fields. Patterns match inside
// JSON strings too, where backslashes are doubled, so every slash form is covered. Any drive letter,
// POSIX home paths, and UNC \\server\share prefixes are replaced. Redirected profiles outside these
// shapes are NOT detected here; they need the exact profile path from the main process (see t/418).

const PROFILE_WIN = /[A-Za-z]:[\\/]+Users[\\/]+[^\\/"'\s<>]+/gi;
const PROFILE_POSIX = /(^|[\s"'(=])\/(?:home|Users)\/[^/"'\s<>]+/g;
// A UNC prefix starts a path: after a string start, quote, space, parenthesis or '='. It is not matched
// after a placeholder or inside another path. In JSON the prefix has four backslashes; raw, two.
const UNC_SHARE = /(^|["'\s(=])(?:\\\\\\\\|\\\\)[^\\/"'\s<>]+[\\/]+[^\\/"'\s<>]+/g;

/** Redacts user-profile paths and UNC shares from a dump's text. Order matters: drive profiles first. */
export function redactDumpText(text: string): string {
  return text
    .replace(PROFILE_WIN, '%USERPROFILE%')
    .replace(PROFILE_POSIX, (_m, lead: string) => `${lead}%USERPROFILE%`)
    .replace(UNC_SHARE, (_m, lead: string) => `${lead}%UNC_SHARE%`);
}
