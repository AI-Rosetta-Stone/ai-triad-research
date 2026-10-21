// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { getGlobalRecorder } from '../flight-recorder/index.js';

// Markdown image with a data: URI target: ![alt](data:...)
const RE_MD_DATA_IMAGE = /!\[[^\]]*\]\(\s*data:[^)]*\)/g;
// Bare data URI: data:<mediatype>(;param)*;base64,<payload> — no whitespace in payload
const RE_BARE_DATA_URI = /data:[a-zA-Z0-9!#$&\-^_]+(?:;[a-zA-Z0-9!#$&\-^_=]+)*;base64,[A-Za-z0-9+/=]+/g;

const STRIP_WARN_THRESHOLD = 1_000;

export interface StripDataUrisResult {
  text: string;
  strippedChars: number;
  uriCount: number;
}

/** Strip inline data: URIs from text before it reaches a model. */
export function stripDataUris(text: string): StripDataUrisResult {
  let uriCount = 0;
  const stripped = text
    .replace(RE_MD_DATA_IMAGE, (m) => { uriCount++; return ''; })
    .replace(RE_BARE_DATA_URI, (m) => { uriCount++; return ''; });
  const strippedChars = text.length - stripped.length;
  if (strippedChars > STRIP_WARN_THRESHOLD) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'strip-data-uris', level: 'warn',
      message: `Stripped ${strippedChars} chars (${uriCount} data: URI(s)) before model input — snapshot may contain inline images`,
    });
  }
  return { text: stripped, strippedChars, uriCount };
}