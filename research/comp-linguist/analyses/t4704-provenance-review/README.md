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

**Selection false positive (corrected t/4708):** 57 of the 58 entries genuinely match an
aggregator host. `shape-thing-2026` (`https://bigmedium.com/...`) was selected because the host
match was a bare suffix match, so `bigmedium.com` matched `medium.com`. Its row's `host` now says
`bigmedium.com` and carries `selection_false_positive: true`. Its disposition stays `keep` (the
author's own site), so the counts and the 29 corpus-write candidates are unchanged. This earlier
README called it a corpus host/url mismatch; it isn't one. The corpus has the correct URL and no
`host` field, and the `medium.com` label existed only in this artifact. **A re-run must match
hosts on a dot boundary** (`h == d or h.endswith("." + d)`). Checked that way, the other 57 rows
all match.

One item outside the keep/re-point/remove scope, noted for separate follow-up rather than acted
on here:
- `anthropic-just-showed-what-doing-right-thing-looks-like-2026` (instagram.com) — kept on best
  judgment; could not confirm the post's content or match it to a specific source. Low confidence.

The 29 non-keep entries (re-point/remove) are the corpus-write candidates; per `/data-mutation`
this review does not itself write anything — the actual write is tracked as a separate ticket
with its own frozen list and authorization (duplicates sharing a URL are batched to one write).
The 28 re-points batch to **19** distinct replacement URLs.

**Replacement URLs corrected (t/217, re-verified 2026-11-10).** The write ticket's re-verification
found four bad replacements, affecting 8 rows. I checked each fix against the live page:
- `extreme-power-concentration-2026` ×4: `forethought.org` (a homepage, and the wrong publisher) →
  `https://80000hours.org/problem-profiles/extreme-power-concentration/`. The source is Rose
  Hadshar's 80,000 Hours problem profile; the corpus snapshot prints this URL.
- `tech-media-telecom-tmt-predictions-2026-2026`: a Deloitte 404 → the live "TMT Predictions 2026"
  page.
- `why-ai-will-save-world-2026`: an a16z podcast slug returning 404 → the essay at
  `https://a16z.com/ai-will-save-the-world/`.
- `white-house-releases-national-policy-framework-artificial-2026` ×2: the whitehouse.gov homepage
  → **Holland & Knight's alert** at
  `https://www.hklaw.com/en/insights/publications/2026/03/white-house-releases-a-national-policy-framework-for-artificial-intelligence`.
  A first fix pointed it at the White House framework PDF (#4903). The identity check below showed
  that was wrong: the snapshot *is* the H&K alert (2026-03-27), which discusses the framework.

**Identity check (snapshot vs replacement).** The write records each replacement as `verified`
provenance, which makes it a trusted identity key (`docs/specs/source-identity.md` §3). So for each
of the 19 replacement URLs I compared the corpus snapshot against the replacement document:
- **16 are the same document.**
- **2 are the same work on its canonical host.** `constructing-ai-speech-2026`'s snapshot is the
  Colorado Law repository copy of the Yale Law Journal Forum article.
  `floor-speech-artificial-intelligence-robotics-2026`'s snapshot is a Vote Smart reprint of the
  floor speech, and the replacement is the Congressional Record.
- **1 was a different document** (the H&K case above), now fixed.

15 of the 19 replacements return HTTP 200. The other four return 403 to scripted requests (bot
blocking): PsyPost, two weforum.org pages and hklaw.com. I confirmed each by search or by fetching
it directly.

**Provenance class:** derived (search-verified per entry, not stipulated) — see
`research/comp-linguist/docs/review-deliverable-schema.md`.
