#!/usr/bin/env python3
"""t/373: what does the spec §7.6 `via` skip cost entity extraction? Read-only, no AI calls.

Entity extraction (InvokeEntityExtractionSteps.ps1, the §7.6 reader) sends each node's non-`via` fact
claims to the model, so a `via` claim is never seen. Because §7.4 keeps a copy's link only when it is not
near anything already kept, every `via` fact is novel to its node by construction. Measures:
  - via facts, nodes with any, nodes with ONLY via facts (the extractor returns null for those);
  - via facts mentioning a KNOWN entity (entities.json name/alias) that no non-via claim on the node
    mentions (a lower bound on missed attributions);
  - via facts with a capitalised multi-word span absent from the node's non-via claims (a rough proxy
    for not-yet-known entities; reported as a proxy, not as entities).
"""
import argparse
import json
import re
from collections import Counter


def norm(s):
    return re.sub(r"\s+", " ", (s or "").lower()).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    a = ap.parse_args()
    idx = json.load(open(f"{a.data}/taxonomy/Origin/source_evidence_index.json", encoding="utf-8"))
    ents = json.load(open(f"{a.data}/taxonomy/Origin/entities.json", encoding="utf-8"))["entities"]
    names = sorted({norm(n) for e in ents for n in [e.get("name", "")] + list(e.get("aliases") or []) if len(norm(n)) >= 4},
                   key=len, reverse=True)
    pat = [(n, re.compile(r"\b" + re.escape(n) + r"\b")) for n in names]
    caps = re.compile(r"\b(?:[A-Z][a-zA-Z0-9&.-]+(?:\s+(?:of|for|and|the|on|in)\s+|\s+)){1,4}[A-Z][a-zA-Z0-9&.-]+\b")

    via_total = nodes_with_via = only_via = 0
    via_known_missed = via_known_missed_mentions = via_caps_novel = 0
    via_docs = Counter()
    for node, v in idx.items():
        facts = [f for f in (v.get("facts") or []) if isinstance(f, dict)]
        via = [f for f in facts if f.get("via")]
        base = [f for f in facts if not f.get("via")]
        if not via:
            continue
        nodes_with_via += 1
        via_total += len(via)
        only_via += not base
        base_text = " ".join(norm(f.get("claim")) for f in base)
        base_raw = " ".join(f.get("claim") or "" for f in base)
        for f in via:
            via_docs[f.get("via")] += 1
            c = norm(f.get("claim"))
            missed = [n for n, p in pat if p.search(c) and not p.search(base_text)]
            if missed:
                via_known_missed += 1
                via_known_missed_mentions += len(missed)
            spans = [s.strip() for s in caps.findall(f.get("claim") or "")]
            if any(s and s not in base_raw for s in spans):
                via_caps_novel += 1
    print(json.dumps({
        "via_facts": via_total, "nodes_with_via": nodes_with_via, "nodes_only_via": only_via,
        "distinct_via_copies": len(via_docs),
        "via_facts_with_known_entity_absent_from_node_nonvia": via_known_missed,
        "known_entity_mentions_missed": via_known_missed_mentions,
        "via_facts_with_novel_capitalised_span_proxy": via_caps_novel,
        "known_entity_names_checked": len(names),
    }, indent=2))


if __name__ == "__main__":
    main()
