# Source-document identity: hash, URL and link rules

**Status:** contract, fixture version 5. **Tickets:** t/4337 (ingestion dedupe, PowerShell) and t/4334 (canonical source index, TypeScript). **Fixture:** `tests/fixtures/source-identity-cases.json`.

This spec defines how a source document in `ai-triad-sources/<doc-id>/` is identified. The PowerShell ingester (`scripts/AITriad/Private/SourceIdentity.ps1`) and the TypeScript index (`lib/sourceIndex`) implement it. Both must pass every case in the fixture.

**To change a rule:** edit this spec and the fixture first, in one PR, then update both implementations. Never change one implementation alone.

## 0. Fields in `metadata.json`

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `content_sha256` | string, 64 lowercase hex chars, or absent | the ingester, at ingest | The content hash of the snapshot body (section 1). |
| `same_as` | string doc id, or absent | the ingester, only with `-SameAs` | A deliberate cross-outlet reprint of that document. It groups with it (section 4.1). |
| `parent_doc_id` | string doc id, or absent | the ingester, only with `-ParentDocId` | A deliberate part of a larger document. It groups with it (section 4.1). |
| `duplicate_of` | string doc id, or absent | a reviewed corpus cleanup (t/4337, `/data-mutation`), never the ingester | This document is a copy of that one. It groups with it (section 4.1), names the group's canonical (4.6), and takes the document out of selection (section 6). |

**When `content_sha256` is absent** (documents ingested before t/4337), compute it from `snapshot.md` using section 1. It gives the same value the ingester would have written.

**`same_as`, `parent_doc_id` and `duplicate_of` are never inferred.** `same_as` and `parent_doc_id` exist only when a person asked for them at ingest. `duplicate_of` exists only after a person signed off on it in a frozen cleanup list. An empty string is the same as absent.

## 1. Content hash (`content_sha256`)

### 1.1 What gets hashed

**Hash the text of `snapshot.md`,** exactly as ingestion writes it: the `Add-SnapshotHeader` output. Read it as UTF-8.

At ingest, the PowerShell side hashes that same string in memory, before writing it. So the field equals the hash of the file it describes. The raw file (`raw/`) and the pre-header markdown are **not** inputs.

### 1.2 Body normalization, in this order

1. **BOM:** if the first character is U+FEFF, remove it.
2. **Line endings:** replace every CRLF with LF, then every remaining lone CR with LF. (Snapshot headers are often CRLF while their bodies are LF.)
3. **Provenance header:** if the text starts with exactly `<!--\n  AI Triad Research Project`:
   1. find the first `\n-->\n`;
   2. after it, find the first `\n---\n`;
   3. discard everything up to and including that `\n---\n`.

   If either marker is missing, keep the text unchanged. The header holds the capture date and source URL, so two ingests of the same document on different days must not hash differently.
4. **Unicode:** normalize to **NFC** (.NET `String.Normalize(FormC)`, JS `String.prototype.normalize('NFC')`).
5. **Trailing whitespace:** split on LF. From the end of every line remove trailing U+0020 (space) and U+0009 (tab), and nothing else. Non-breaking spaces and other Unicode whitespace are kept.
6. **Edge blank lines:** remove leading and trailing lines that are now empty. Interior empty lines are kept.
7. **Join:** join the lines with LF, with no trailing newline. That string is the **body**.

### 1.3 No hash: the field is absent, never a hash of nothing

The document gets no `content_sha256`, and so no hash identity, when:
- the body is empty;
- the body starts with `# PDF EXTRACTION FAILED` (the `DocConverters` failure placeholder);
- the body is exactly `# <one line>`, then an empty line, then `[Binary file — no text extraction available]`;
- **the body has fewer than 100 words** (version 4, TL ruling p/801#17).
  - **What counts as a word:** split the body on runs of ASCII whitespace (space, `\t`, `\n`, `\r`, `\f`, `\v`) and count the non-empty tokens. **Not** Unicode `\s`: .NET and JS disagree on that set.
  - **Why:** a body this small is a cookie wall, a paywall stub or an error page more often than a document. Two different documents that both converted to the same stub would otherwise share a hash.
  - **Current corpus:** no hashed document is under 100 words (the smallest shared body is 310 words), so the floor changes nothing today.

Placeholders and stubs describe the failure, not the document, so two different documents would collide.

### 1.4 Digest

The digest is SHA-256 over the body's **UTF-8 bytes, with no BOM**, written as **lowercase hex**.

## 2. URL key

A URL key is a string, or **null** (meaning no URL identity). Normalization is purely textual: no percent-decoding or re-encoding, and no IDN or punycode conversion. So .NET and JS URL parsers can't diverge.

1. **Parse:** trim leading and trailing whitespace. Match `^(https?)://([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$`, where the scheme is case-insensitive.
   - If it doesn't match, the key is **null.** That covers non-http(s) input, relative URLs, a bare DOI and free text.
2. **Authority:** drop any userinfo (everything up to and including the last `@`).
   - **Lowercase it.** The scheme is dropped, and **only the host (authority) is lowercased.**
   - Drop a trailing `:80` or `:443`.
   - Drop one leading `www.`.
   - If it's now empty, the key is **null.**
3. **Path:** the raw path, **case preserved**, with all trailing `/` removed. It may be empty.
4. **Query:** split the text after `?` on `&`.
   - Drop empty parts.
   - Drop any parameter whose name (the text before the first `=`, compared lowercased) starts with `utm_` or is `fbclid`, `gclid`, `mc_cid` or `mc_eid`.
   - **Values and name case are kept as written**, because YouTube `v=` and HN `id=` are case-sensitive item ids.
   - Sort the remaining parameters by **ordinal** (UTF-16 code unit) comparison of the whole `name=value` text, and join them with `&`.
5. **Fragment:** dropped.
6. **Key:** authority + path, then `?` + query if any parameters remain.

## 3. Trusted URL keys of a document

1. The **candidates** are `url`, then `resolved_url`, each converted to a key with section 2. Null keys are dropped, and duplicates are kept once, first occurrence wins.
2. A candidate is **untrusted** if `provenance[]` holds an entry with `scheme == "url"`, `confidence == "search"` and an `id` whose key equals the candidate's key.
   - Search provenance is a guess made after ingest. It's how a reprint got another outlet's URL.
3. **Only trusted keys identify a document.**

## 4. Canonical grouping

*TL design decision on #3522 (p/801#6), replacing the t/4333 tier list. Strong evidence merges; weak evidence only confirms or reports.*

### 4.0 Input
The input is a set of documents. Each has an `id`, its `metadata.json` fields, and optionally a **snapshot hash**. The snapshot hash is the section 1 hash computed from `snapshot.md`, for a document with no **recorded** `content_sha256`.

**Recorded and computed hashes behave differently:**
- **both** make a hash edge;
- **only recorded hashes** can veto a suffix edge (4.4), because conversion-noise copies differ in their computed hash.

### 4.1–4.3 Strong edges
The groups are the **connected components** over every edge (union, not "first matching tier"). That way the result doesn't depend on the order tiers are checked or files are listed.
1. **Explicit link (4.1):** `parent_doc_id`, `same_as` or `duplicate_of` joins the document to that id. **The link is ignored if the target id isn't in the set.** A `duplicate_of` that section 6 rejects (a chain, for example) still makes this edge; it only loses its effect on the canonical, the resolver and selection.
2. **Content hash (4.2):** equal hashes, where a document's hash is its recorded `content_sha256`, or else its snapshot hash. Absent means no edge (section 1.3).
3. **URL (4.3):** an equal trusted URL key (section 3). Every trusted key of a document counts.
   - **URL edges are pairwise.** Every pair of documents sharing a key is considered, so one pair can be dropped.
   - **The conflict veto** (TL ruling t/4337#8): a pair sharing a URL key does **not** join when **both** of these hold:
     - **the hashes differ:** both documents have an **effective hash** (the recorded `content_sha256`, else the snapshot hash) and the two differ;
     - **the titles differ:** both title keys (4.5) are non-empty and differ.
   - **A vetoed pair is reported as a `url_conflict`** (4.5), never merged.
   - **Why:** a valid-looking but truncated identifier, such as the DOI `10.1073/pnas`, can be attached to two different papers. A real re-ingestion keeps its title, so it still joins.
   - **Why the effective hash and not only the recorded one:** the veto needs **two** differences, so conversion-noise copies (same title) still join. And documents ingested before t/4337 have no recorded hash.
   - **The veto removes one edge, not a group.** A vetoed pair still ends up in one group if other edges connect them, for example both share a hash with a third copy.

### 4.4 Conditional suffix edge
**Which documents qualify:** a document `X-N`, meaning its id matches `^(.+)-(\d+)$`, whose captured base `X` is also an id in the set.

**`X-N` joins `X` only if all three hold:**
1. **Equal titles:** their title keys (4.5) are equal and non-empty. A missing title gives an empty key, so there's no edge.
2. **No URL conflict:** both have at least one trusted URL key, and they share none. **A URL on only one side is not a conflict**, and neither is a search-provenance URL, since it isn't trusted.
3. **No recorded-hash conflict:** both have a **recorded** `content_sha256` and they differ. A recorded hash on only one side, or differing *computed* snapshot hashes, is not a conflict.

**Why:** t/4337 now deliberately mints `-N` for a genuine slug collision with different content and records its hash, and rule 3 keeps that document separate. Rule 1 also removes t/4334's year-suffix limitation: `foo-2026` joins `foo` only when their titles match.

### 4.5 Title key, and the `title_collision` and `url_conflict` reports
**The title key:** lowercase (invariant), then replace `+` with a space, then **delete every character that isn't ASCII `[a-z0-9_]` or ASCII whitespace** (space, `\t`, `\n`, `\r`, `\f`, `\v`), then collapse ASCII whitespace runs to one space, then trim.
- Non-ASCII letters are deleted, not kept, because .NET `\w` is Unicode and JS `\w` is ASCII.
- **No id fallback:** a missing or empty title gives an empty key.

**A title on its own adds no edge.** Generic titles ("AI Policy Bulletin", "Executive Summary") and non-ASCII titles that reduce to the same ASCII key would otherwise chain distinct documents together.

**Grouping also reports every `url_conflict`:** a pair the 4.3 veto kept from joining, as `{url_key, ids: [a, b]}`.
- `a` sorts before `b` ordinally.
- The list is sorted by `url_key` and then by the ids, all ordinal.
- A pair is reported even if other edges put both documents in one group.
- It's input for the same human pass as `title_collision`.

**Instead, grouping reports a `title_collision`:** for each non-empty title key whose documents fall in two or more groups, it lists those documents' ids.
- Ids within a collision are sorted ordinally, and collisions are sorted by their first id.
- **The report is input for a human** (the t/4337 cleanup pass). It never merges anything.

### 4.6 Canonical id
1. **A group with a valid `duplicate_of` mark** (6.1): the canonical id is the mark's target. If valid marks in one group name different targets, it's the **ordinal-smallest** of those targets, and the other marks are `conflict` errors (6.1).
2. **Any other group:** the canonical id is the **ordinal-smallest id** (UTF-16 code units) in it.

`same_as` and `parent_doc_id` change only grouping. Which document a person sees as primary is the consumer's display choice. `duplicate_of` is the one field that names the canonical, because the cleanup chooses it deliberately: the member the summaries and most live references already use (SO condition C6, e/342#2), not the smallest id.

## 5. Fixture format

`tests/fixtures/source-identity-cases.json` has six case lists:
- `hash_cases`: `{name, text, expected_sha256}`, where `expected_sha256` may be `null`;
- `url_cases`: `{name, input, expected}`, where `expected` may be `null`;
- `trust_cases`: `{name, metadata, expected}`, where `expected` is an array of keys;
- `title_cases`: `{name, input, expected}`;
- `grouping_cases`: `{name, documents: [{id, metadata, snapshot_sha256?, snapshot_text?}], expected_canonical: {id: canonicalId}, expected_title_collisions: [[id, …], …], expected_url_conflicts: [{url_key, ids: [a, b]}, …]}`.
  - `metadata.content_sha256` is a **recorded** hash, and `snapshot_sha256` is a **computed** one (4.0).
  - `snapshot_text`, when present, is the document's `snapshot.md` text. The consumer computes the snapshot hash from it with section 1, which can be no hash at all (1.3). Then it groups. It's never given together with `snapshot_sha256`.
  - Real-corpus cases carry the documents' actual metadata. No corpus document records a hash yet, so each one's hash, computed from the real `snapshot.md`, is in `snapshot_sha256`.
- `duplicate_of_cases`: `{name, documents, expected_canonical, expected_resolved: {id: resolvedId}, expected_selectable: [id, …], expected_duplicate_of_errors: [{id, target, kind}, …]}`, with `documents` as in `grouping_cases`.
  - `expected_selectable` is sorted ordinally.
  - **It's a separate list** so a consumer that hasn't adopted section 6 still passes `grouping_cases` unchanged. No `grouping_case` carries `duplicate_of`.

The fixture's `version` is bumped whenever a rule changes an expected value (version 2: the section 4 revision; version 3: the 4.3 URL conflict veto and the `url_conflict` report; version 4: the 1.3 100-word body floor and `snapshot_text`; version 5: `duplicate_of`, section 6 and `duplicate_of_cases`).

Expected values are generated by one implementation and **independently confirmed** by a second, from-spec implementation in the other runtime before they are committed.

## 6. Duplicate marks: resolver and selection

*Version 5, from the Second Opinion's conditions C1, C2 and C6 on the t/4337 cleanup (e/342#2).* A duplicate stays on disk and stays resolvable by id, but it stops counting as a separate document.

### 6.1 Valid marks and `duplicate_of_error`
A document `X` with `duplicate_of: T` has a **valid mark** when every check below passes. Otherwise the mark is an error of the first kind that fails:

| Check | Error kind |
|---|---|
| `T` is not `X` | `self` |
| `T` is a document in the set | `missing_target` |
| `T` has no `duplicate_of` of its own (one hop only, so no chains and no cycles) | `chain` |
| `T` is its group's canonical (4.6 rule 1) | `conflict` |

**Evaluate in two passes** (Quality, review of #3569). The `conflict` check depends on the group's canonical, and 4.6 rule 1 picks the canonical from valid marks. So:
1. apply the first three checks to every mark;
2. for each group, take the ordinal-smallest target among the marks that passed them as the group's canonical;
3. then mark as `conflict` every remaining mark whose target isn't that canonical.

A single pass that checks `conflict` before the canonical is chosen gives order-dependent results.

- **An invalid mark is treated as absent** by the canonical rule, the resolver and selection. The document stays selectable and resolves to itself, so a bad mark is visible and hides nothing.
- **Grouping reports every error** as `{id, target, kind}`, sorted by `id` (ordinal).
- **Consumers WARN on errors at load and never throw.** The cleanup write is gated on **zero** errors, checked against the frozen list before anything is written.
  - **Its `/data-mutation` proof asserts structurally that the frozen list has no chains** (TL, t/4337#13): no target is also marked, and each group has exactly one target.
- In a two-document cycle (`A → B`, `B → A`), both marks are `chain` errors.

### 6.2 Resolver
`resolve(id)` is the mark's target when `id` has a valid mark, and `id` otherwise. It never takes more than one hop, because a valid target carries no mark.

- **The resolver uses the mark only, not grouping.** An unmarked member of a group resolves to itself, even when the group's canonical is another document. Only a signed-off mark redirects evidence; grouping never does.
- **Every by-id lookup still finds a marked document,** so historical records (debates, analyses) that cite it keep working.

### 6.3 Selection and evidence
- **Selectable documents** are the documents with no valid mark. Listings, pickers, AI producer inputs, and the summary and batch pipelines use only these.
- **Evidence and attribution** (`source_index`, `source_evidence_index`, entity indexes, citation counts) attribute each citation to `resolve(id)` and count each resolved id **once**. A duplicate pair therefore gives one evidence unit, not two.

### 6.4 Exact versus resolved id
Every citation has two ids, and each has its own use. This mirrors the taxonomy's `superseded_by` split (t/4354):

| | **Exact id** (as cited) | **Resolved id** (`resolve(exact)`) |
|---|---|---|
| **Used for** | History: stored records, citations and provenance | New attribution: evidence counts, index entries, selection |
| **Stored data** | **Kept as written.** A mark never rewrites an existing reference: debates, analyses, summaries and taxonomy `source_refs` keep the id they cite. | Computed at read time, never persisted over the exact id. |
| **Display** | What the record actually cited | The document to show or open as primary |

- **A consumer may show both** (for example "cited as X, now Y"). It must never replace a stored exact id with the resolved id.
- **Why:** the mark is the reviewed fact, and grouping is a heuristic that can change with the spec. Keeping the exact id means removing or correcting a mark restores the original attribution, with no data repair.
