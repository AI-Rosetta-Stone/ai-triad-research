# Source-document identity: hash, URL and link rules

**Status:** contract, version 1. **Tickets:** t/4337 (ingestion dedupe, PowerShell) and t/4334 (canonical source index, TypeScript). **Fixture:** `tests/fixtures/source-identity-cases.json`.

This spec defines how a source document in `ai-triad-sources/<doc-id>/` is identified. The PowerShell ingester (`scripts/AITriad/Private/SourceIdentity.ps1`) and the TypeScript index (`lib/sourceIndex`) implement it. Both must pass every case in the fixture.

**To change a rule:** edit this spec and the fixture first, in one PR, then update both implementations. Never change one implementation alone.

## 0. Fields in `metadata.json`

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `content_sha256` | string, 64 lowercase hex chars, or absent | the ingester, at ingest | The content hash of the snapshot body (section 1). |
| `same_as` | string doc id, or absent | the ingester, only with `-SameAs` | A deliberate cross-outlet reprint of that document. It groups with it (section 4.1). |
| `parent_doc_id` | string doc id, or absent | the ingester, only with `-ParentDocId` | A deliberate part of a larger document. It groups with it (section 4.1). |

**When `content_sha256` is absent** (documents ingested before t/4337), compute it from `snapshot.md` using section 1. It gives the same value the ingester would have written.

**`same_as` and `parent_doc_id` are never inferred.** They exist only when a person asked for them at ingest.

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
- the body is exactly `# <one line>`, then an empty line, then `[Binary file — no text extraction available]`.

Placeholders describe the failure, not the document, so two different documents would collide.

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
1. **Explicit link (4.1):** `parent_doc_id` or `same_as` joins the document to that id. **The link is ignored if the target id isn't in the set.**
2. **Content hash (4.2):** equal hashes, where a document's hash is its recorded `content_sha256`, or else its snapshot hash. Absent means no edge (section 1.3).
3. **URL (4.3):** an equal trusted URL key (section 3). Every trusted key of a document counts.

### 4.4 Conditional suffix edge
**Which documents qualify:** a document `X-N`, meaning its id matches `^(.+)-(\d+)$`, whose captured base `X` is also an id in the set.

**`X-N` joins `X` only if all three hold:**
1. **Equal titles:** their title keys (4.5) are equal and non-empty. A missing title gives an empty key, so there's no edge.
2. **No URL conflict:** both have at least one trusted URL key, and they share none. **A URL on only one side is not a conflict**, and neither is a search-provenance URL, since it isn't trusted.
3. **No recorded-hash conflict:** both have a **recorded** `content_sha256` and they differ. A recorded hash on only one side, or differing *computed* snapshot hashes, is not a conflict.

**Why:** t/4337 now deliberately mints `-N` for a genuine slug collision with different content and records its hash, and rule 3 keeps that document separate. Rule 1 also removes t/4334's year-suffix limitation: `foo-2026` joins `foo` only when their titles match.

### 4.5 Title key and the `title_collision` report
**The title key:** lowercase (invariant), then replace `+` with a space, then **delete every character that isn't ASCII `[a-z0-9_]` or ASCII whitespace** (space, `\t`, `\n`, `\r`, `\f`, `\v`), then collapse ASCII whitespace runs to one space, then trim.
- Non-ASCII letters are deleted, not kept, because .NET `\w` is Unicode and JS `\w` is ASCII.
- **No id fallback:** a missing or empty title gives an empty key.

**A title on its own adds no edge.** Generic titles ("AI Policy Bulletin", "Executive Summary") and non-ASCII titles that reduce to the same ASCII key would otherwise chain distinct documents together.

**Instead, grouping reports a `title_collision`:** for each non-empty title key whose documents fall in two or more groups, it lists those documents' ids.
- Ids within a collision are sorted ordinally, and collisions are sorted by their first id.
- **The report is input for a human** (the t/4337 cleanup pass). It never merges anything.

### 4.6 Canonical id
The canonical id of a document is the **ordinal-smallest id** (UTF-16 code units) in its group.

`same_as` and `parent_doc_id` change only grouping. Which document a person sees as primary is the consumer's display choice.

## 5. Fixture format

`tests/fixtures/source-identity-cases.json` has five case lists:
- `hash_cases`: `{name, text, expected_sha256}`, where `expected_sha256` may be `null`;
- `url_cases`: `{name, input, expected}`, where `expected` may be `null`;
- `trust_cases`: `{name, metadata, expected}`, where `expected` is an array of keys;
- `title_cases`: `{name, input, expected}`;
- `grouping_cases`: `{name, documents: [{id, metadata, snapshot_sha256?}], expected_canonical: {id: canonicalId}, expected_title_collisions: [[id, …], …]}`.
  - `metadata.content_sha256` is a **recorded** hash, and `snapshot_sha256` is a **computed** one (4.0).
  - Real-corpus cases carry the documents' actual metadata. No corpus document records a hash yet, so each one's hash, computed from the real `snapshot.md`, is in `snapshot_sha256`.

The fixture's `version` is bumped whenever a rule changes an expected value (version 2: the section 4 revision).

Expected values are generated by one implementation and **independently confirmed** by a second, from-spec implementation in the other runtime before they are committed.
