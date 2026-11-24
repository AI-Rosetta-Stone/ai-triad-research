// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/492: document titles for evidence citations, from the sources index.
//
// The engine cites a source by its title. On the desktop and the CLI it reads titles from the
// sources directory on disk (evidenceIndexLoader.loadDocTitles). A hosted server has no sources
// directory, so the host reads `sources-index.json` through its own storage backend and passes the
// result in `DebateConfig.docTitles`. This maps the index to the shape the engine uses. Pure; no IO.

import type { DocMetaMap } from './evidenceFromSummaries.js';

/** An arXiv identifier standing where a title should be, such as "1703.06856v3" or "arXiv:2503.22732". */
const ARXIV_ID = /^(?:arxiv:\s*)?\d{4}\.\d{4,5}(?:v\d+)?$/i;

/**
 * A stored title that is only an identifier: an arXiv-style id, or the document's own id. It is
 * not a title, and handed to the model it is cited as the source's name (Comp-Linguist ruling,
 * t/492#18). Such a document is treated as untitled, so it takes the id path and its WARN. The
 * real titles are a data fix, not something to guess here.
 */
export function isIdentifierOnlyTitle(title: string, docId: string): boolean {
  const t = title.trim();
  return ARXIV_ID.test(t) || t.toLowerCase() === docId.trim().toLowerCase();
}

/** The usable title of a document, trimmed, or '' when it has none or only an identifier. */
export function usableTitle(title: unknown, docId: string): string {
  const t = typeof title === 'string' ? title.trim() : '';
  return t && !isIdentifierOnlyTitle(t, docId) ? t : '';
}

/** The fields of a sources-index entry this mapping reads. A subset of `SourcesIndexEntry`. */
export interface SourcesIndexTitleEntry {
  id: string;
  title?: string;
  url?: string;
  resolved_url?: string;
  provenance?: { id?: string }[];
}

/**
 * doc_id → { title, resolved_url, provenance_label } for every index entry that has a usable title.
 * An entry with no title, or with only an identifier for one, is left out, so its evidence is still
 * cited by document id, with the WARN from retrieveSourceEvidence. The field choices match loadDocTitles: `resolved_url`, else `url`;
 * the first provenance id as the label. Returns undefined for a missing or empty index, so the
 * engine falls back to its own lookup.
 */
export function docMetaMapFromSourcesIndex(index: { docs?: SourcesIndexTitleEntry[] } | null | undefined): DocMetaMap | undefined {
  const docs = Array.isArray(index?.docs) ? index.docs : [];
  const map: DocMetaMap = {};
  for (const d of docs) {
    const title = d?.id ? usableTitle(d.title, d.id) : '';
    if (!title) continue;
    const url = d.resolved_url || d.url;
    const label = d.provenance?.[0]?.id;
    map[d.id] = { title, ...(url ? { resolved_url: url } : {}), ...(label ? { provenance_label: label } : {}) };
  }
  return Object.keys(map).length > 0 ? map : undefined;
}
