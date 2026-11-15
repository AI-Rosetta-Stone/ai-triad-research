#!/usr/bin/env python3
"""t/322: would a relevance cap have kept the nodes Chat actually cited?

For every POVer turn in the saved chats that cites taxonomy_refs, rank the POVer camp's live BDI
nodes (and all situations) by cosine similarity to the turn's query, using the corpus embeddings
(all-MiniLM-L6-v2, embeddings.json) and the same model at its pin for the query. Report the share of
cited refs that fall inside the top k. Local only: no AI calls.

Query = chat topic + the most recent user message before the turn (POVers often open a chat or
speak twice in a row, so a turn may have no fresh user message; the topic is always present).
"""
import argparse
import glob
import json
import os
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "scripts"))
from embed_model_pins import load_sentence_transformer  # noqa: E402

PERSONA = {"prometheus": "accelerationist", "sentinel": "safetyist", "cassandra": "skeptic"}
POVS = ("accelerationist", "safetyist", "skeptic")
KS = (6, 12, 20, 30, 50)


def camp(name):
    name = (name or "").lower()
    return PERSONA.get(name, name if name in POVS else None)


def refs_of(m):
    out = []
    for x in m.get("taxonomy_refs") or []:
        i = x if isinstance(x, str) else (x.get("node_id") or x.get("id"))
        if i:
            out.append(i)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", default=str(Path(__file__).with_name("results.json")))
    a = ap.parse_args()
    data = Path(a.data)
    emb = json.load(open(data / "taxonomy" / "Origin" / "embeddings.json", encoding="utf-8"))["nodes"]
    live = {}
    for pov in POVS:
        nodes = json.load(open(data / "taxonomy" / "Origin" / f"{pov}.json", encoding="utf-8"))["nodes"]
        live[pov] = [n["id"] for n in nodes if not n.get("superseded_by") and n["id"] in emb]
    sits = [i for i in emb if i.startswith("sit-")]

    def mat(ids):
        m = np.array([emb[i]["vector"] for i in ids], dtype=np.float32)
        return m / np.linalg.norm(m, axis=1, keepdims=True)

    mats = {p: mat(live[p]) for p in POVS}
    sit_m = mat(sits)
    model = load_sentence_transformer("sentence-transformers/all-MiniLM-L6-v2")

    rows = []
    files = sorted(glob.glob(str(data / "chats" / "*.json")) + glob.glob(str(data / "chats" / "_archive" / "*.json")))
    for f in files:
        d = json.load(open(f, encoding="utf-8"))
        last_user = ""
        for m in d.get("transcript") or []:
            sp = (m.get("speaker") or "").lower()
            if sp == "user":
                last_user = m.get("content") or ""
                continue
            pov = camp(sp)
            refs = refs_of(m)
            if not pov or not refs:
                continue
            q = f"{d.get('topic') or ''}\n{last_user}".strip()
            # Ceiling: rank against the turn's own answer text. If cited nodes rank low even here,
            # the citations are loose; if high here but low on the query, the query is the problem.
            content = m.get("content") or ""
            try:
                content = json.loads(content).get("response", content)
            except (ValueError, AttributeError):
                pass
            v, va = model.encode([q, content], normalize_embeddings=True).astype(np.float32)
            rank, srank, arank, asrank = ({i: r + 1 for r, i in enumerate([ids[j] for j in np.argsort(-(M @ x))])}
                                          for ids, M, x in ((live[pov], mats[pov], v), (sits, sit_m, v),
                                                            (live[pov], mats[pov], va), (sits, sit_m, va)))
            for i in refs:
                if i.startswith("sit-"):
                    rows.append({"chat": os.path.basename(f), "kind": "sit", "id": i, "rank": srank.get(i),
                                 "answer_rank": asrank.get(i)})
                else:
                    rows.append({"chat": os.path.basename(f), "kind": "bdi", "pov": pov, "id": i,
                                 "rank": rank.get(i), "answer_rank": arank.get(i), "own_camp": i in rank})

    def summarize(kind):
        rs = [r for r in rows if r["kind"] == kind]
        ranked = [r for r in rs if r["rank"]]
        out = {"n_refs": len(rs), "n_rankable": len(ranked)}
        for key in ("rank", "answer_rank"):
            tag = "query" if key == "rank" else "answer"
            for k in KS:
                out[f"{tag}_recall@{k}"] = round(sum(r[key] <= k for r in ranked) / len(ranked), 3) if ranked else None
            out[f"{tag}_median_rank"] = int(np.median([r[key] for r in ranked])) if ranked else None
        return out

    res = {"bdi": summarize("bdi"), "situations": summarize("sit"),
           "bdi_not_in_own_camp": sum(1 for r in rows if r["kind"] == "bdi" and not r["own_camp"]),
           "rows": rows}
    json.dump(res, open(a.out, "w", encoding="utf-8"), indent=2)
    print(json.dumps({k: v for k, v in res.items() if k != "rows"}, indent=2))


if __name__ == "__main__":
    main()
