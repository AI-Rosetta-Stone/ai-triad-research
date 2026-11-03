# t/4704 — provenance review: social/aggregator-host `search`-confidence entries

Follow-up from t/4658 (e/407#2 SO review). 58 `provenance[].confidence == "search"` entries
matching a social/aggregator host (linkedin.com, x.com, medium.com, substack.com, reddit.com,
facebook.com, instagram.com, tiktok.com) were hand-reviewed per the t/4383#1 method: for each
entry, check whether the linked post genuinely supports the document, or whether it's a
repost/announcement of content with a better-known canonical primary source.

**Method:** 48 distinct URLs (58 entries, several duplicated across variant doc_ids) were each
checked by web search for (a) topical match to the document and (b) existence of a better-known
canonical original. Dispositions and rationale: `dispositions.json`.

**Counts:** keep = 29, re-point = 28, remove = 1.

Two items outside the keep/re-point/remove scope, noted for separate follow-up rather than acted
on here:
- `anthropic-just-showed-what-doing-right-thing-looks-like-2026` (instagram.com) — kept on best
  judgment; could not confirm the post's content or match it to a specific source. Low confidence.
- `shape-thing-2026` — its `host` field says `medium.com` but the actual URL is `bigmedium.com`
  (a different, unrelated domain — appears to be the author's own site, so the *disposition* is
  still `keep`, but the host/url field mismatch itself is a distinct data-quality issue).

The 29 non-keep entries (re-point/remove) are the corpus-write candidates; per `/data-mutation`
this review does not itself write anything — the actual write is tracked as a separate ticket
with its own frozen list and authorization (duplicates sharing a URL are batched to one write).

**Provenance class:** derived (search-verified per entry, not stipulated) — see
`research/comp-linguist/docs/review-deliverable-schema.md`.
