"""G7 grounding reconciler (t/3160, TL ruling A). Hash-gated, idempotent, path-agnostic.

DISJOINT-SCOPE CONTRACT (TL condition 1): this reconciler OWNS the node-grounding family —
node.concept_refs, node.entity_refs, term.used_by_nodes, and the `node:*` containers of
entity_mentions.json. It NEVER writes `sei:*` containers (those stay with
Update-EntityMentionIndex.ps1, which after the handoff owns sei:* ONLY). A no-double-write
assertion enforces the split. Handoff sequencing (condition 2): this ships and writes node:*
BEFORE the PS cmdlet is reduced to drop node:*, so no node:* mention is ever orphaned.

Per changed node (text_sha256 over label+description+plain_description): resolve concept_refs
(surface->linked, embedding cosine>=0.55->proposed) + entity_refs (surface/alias->linked) and
the node:* mention record; used_by_nodes is DERIVED from the forward concept_refs (condition 4:
guarantees forward<->reverse consistency, which a union cannot). Removed nodes are purged from
ALL reverse maps incl. node:* mentions (condition 5).

Usage: --selftest (tests, no write) | --apply (write) | default dry-run summary.
       --nodes id1,id2,... : G8a scoped mode (t/3171) — re-resolve ONLY those node ids (the
       inline write-hook's dirty-set), leaving every other node's stored grounding untouched.
       used_by_nodes is still re-derived globally so forward<->reverse consistency holds under
       partial refresh; writes are bounded to touched POV files + changed dict files. Combine
       with --apply to persist. The CALLER MUST serialize this against Update-EntityMentionIndex
       (shared entity_mentions.json is a full read-merge-write; TL concurrency caveat t/3160#7).

CROSS-TOOL WRITE-LOCK CONTRACT (TL, t/3163#1 / t/3194): both writers of the shared
entity_mentions.json — this reconciler AND Update-EntityMentionIndex.ps1 — coordinate on ONE
advisory lockfile `entity_mentions.lock` beside it. Acquire = atomic O_CREAT|O_EXCL create;
a holder older than LOCK_STALE_SEC (by mtime) is presumed dead and broken; every file write is
tmp-file + atomic rename so no reader sees a torn file. Staleness is by MTIME (language-agnostic)
so the PS cmdlet honors the identical rule. The lock is held only around the live apply
read-merge-write; dry-run/selftest never lock.
"""
import json, re, os, glob, sys, hashlib, time, socket, contextlib
from datetime import datetime, timezone
import numpy as np

def _resolve_data_root():
    """Portable data-root resolution (root AGENTS.md): AI_TRIAD_DATA_ROOT env > .aitriad.json
    `data_root` (relative to the repo root that holds it) > `../ai-triad-data` monorepo fallback.
    Uses only the CODE repo (.aitriad.json is code-tracked), so it resolves on any host incl. the
    ACA Linux container and CI runners — no data-repo checkout needed just to compute paths (t/3189)."""
    env = os.environ.get("AI_TRIAD_DATA_ROOT")
    if env:
        return os.path.abspath(env)
    here = os.path.dirname(os.path.abspath(__file__))
    d = here
    for _ in range(8):  # walk up to the repo root that holds .aitriad.json
        cfg = os.path.join(d, ".aitriad.json")
        if os.path.isfile(cfg):
            try:
                with open(cfg, encoding="utf-8") as fh:
                    dr = (json.load(fh) or {}).get("data_root")
            except (OSError, ValueError):
                dr = None
            if dr:
                return os.path.abspath(dr if os.path.isabs(dr) else os.path.join(d, dr))
            break
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    # fallback: <repo>/../ai-triad-data — repo root is 3 levels up from this script
    repo_root = os.path.abspath(os.path.join(here, os.pardir, os.pardir, os.pardir))
    return os.path.abspath(os.path.join(repo_root, os.pardir, "ai-triad-data"))

D = _resolve_data_root()
O = os.path.join(D, "taxonomy", "Origin")
STD = os.path.join(D, "dictionary", "standardized")
MENTIONS = os.path.join(O, "entity_mentions.json")
SIDECAR = os.path.join(O, "grounding_index.json")
LOCKFILE = os.path.join(O, "entity_mentions.lock")
LOCK_WAIT_SEC = 60    # max wait for a live lock before erroring
LOCK_STALE_SEC = 120  # a holder older than this (by mtime) is presumed dead and broken
LOCK_POLL_SEC = 0.5
CON_TAU = 0.55
APPLY = "--apply" in sys.argv
SELFTEST = "--selftest" in sys.argv

def _arg(flag):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None

# G8a scoped mode: --nodes id1,id2,... limits re-resolution to the caller's declared dirty-set.
# Guard against a following flag being swallowed as a value (e.g. `--nodes --apply`).
SCOPED = "--nodes" in sys.argv
SCOPED_IDS = [x.strip() for x in (_arg("--nodes") or "").split(",")
              if x.strip() and not x.strip().startswith("--")]

def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def node_text(n):
    parts = [n.get("label", ""), n.get("description", "")]
    if n.get("plain_description"):
        parts.append(n["plain_description"])
    return "\n".join(parts)

def word_span(surface, text_lower):
    m = re.search(r"\b" + re.escape(surface.lower()) + r"\b", text_lower)
    return m.start() if m else None

def entity_span(surface, text, low):
    """Entity surface match with an acronym case-sensitivity guard (t/3222). An all-caps alpha
    acronym surface (AIMS, GDPR, RLHF) matches CASE-SENSITIVELY against the original text: the
    acronym is uppercase in prose, while its lowercase homograph is an ordinary word ("AIMS" the
    institute vs "aims" the verb — the alias "AIMS" was false-linking 52 nodes on "aims"). All other
    surfaces stay case-insensitive (word_span). Complements distinctive()'s common-word gate, which
    already drops single lowercase-common names (Capital, Nature)."""
    if surface.isalpha() and surface.isupper() and len(surface) >= 2:
        m = re.search(r"\b" + re.escape(surface) + r"\b", text)
        return m.start() if m else None
    return word_span(surface, low)

def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def dump_json(path, obj):
    # atomic write: tmp + rename, so no reader (incl. the PS cmdlet) ever sees a torn file (t/3194)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)

@contextlib.contextmanager
def grounding_lock(holder="reconciler", path=LOCKFILE, wait_sec=LOCK_WAIT_SEC,
                   stale_sec=LOCK_STALE_SEC, poll_sec=LOCK_POLL_SEC):
    """Cross-tool advisory write-lock for entity_mentions.json (shared with Update-EntityMentionIndex).
    Acquire = atomic O_CREAT|O_EXCL create of `path`; a holder older than `stale_sec` (by mtime) is
    presumed dead and broken (WARN). Waits up to `wait_sec` for a live holder, then raises. Released on
    exit. The PS cmdlet MUST honor the SAME lockfile + mtime-staleness rule (TL contract, t/3163#1).

    Windows (t/4193): another process holding the lockfile open, or a delete still pending, surfaces as
    PermissionError (WinError 5/13/32) rather than FileExistsError/FileNotFoundError. Every acquire-side
    PermissionError is treated as contention (wait one poll, retry, same wait_sec budget); a release-side
    one is retried briefly, then WARNed and left to go stale, never raised into the caller.
    KNOWN GAP (t/4193): two waiters can both judge one stale lock dead and both break it, so a stale
    break can admit two holders. Exposure needs a dead or >stale_sec holder; the fix changes the
    cross-tool protocol and is tracked there."""
    payload = json.dumps({"holder": holder, "pid": os.getpid(), "host": socket.gethostname(),
                          "acquired_at": datetime.now(timezone.utc).isoformat()})
    start = time.monotonic()

    def wait_or_raise(detail):
        if time.monotonic() - start > wait_sec:
            raise RuntimeError(
                "Goal: acquire the grounding write-lock to reconcile entity_mentions.json safely. "
                f"Error: lock held by another writer for >{wait_sec}s ({detail}). Location: {path}. "
                "Resolve: another reconciler or Update-EntityMentionIndex run is in progress — let "
                "it finish; if it is hung, remove the lockfile after confirming no writer is active.")
        time.sleep(poll_sec)

    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
            break
        except PermissionError:
            wait_or_raise("lockfile busy or delete pending (PermissionError on create)")
            continue
        except FileExistsError:
            try:
                age = time.time() - os.path.getmtime(path)
            except FileNotFoundError:
                continue  # released between the failed create and the stat — retry acquire
            except PermissionError:
                wait_or_raise("lockfile busy (PermissionError on stat)")
                continue
            if age > stale_sec:
                # Fallback path (root AGENTS.md): a stale lock is being broken — record that + why.
                sys.stderr.write(f"WARN grounding_lock: breaking stale lock (mtime age {age:.0f}s "
                                 f"> {stale_sec}s) at {path}; prior holder presumed dead\n")
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass
                except PermissionError:
                    # someone else has it open: another breaker, or a fresh holder writing it. Not ours
                    # to delete; treat as live and wait.
                    wait_or_raise("stale lock busy (PermissionError on break)")
                continue
            wait_or_raise(f"not stale: mtime age {age:.0f}s < {stale_sec}s")
    try:
        yield
    finally:
        for attempt in range(40):  # ~2s: on Windows a reader's brief open can block the delete
            try:
                os.unlink(path)
                break
            except FileNotFoundError:
                break
            except PermissionError:
                if attempt == 39:
                    # Fallback path: leave the lockfile; it goes stale after stale_sec and is broken.
                    sys.stderr.write(f"WARN grounding_lock: could not remove {path} on release "
                                     f"(PermissionError after retries); it will be broken as stale "
                                     f"after {stale_sec}s\n")
                else:
                    time.sleep(0.05)

# ---------- load resolver inputs ----------
def load_terms():
    out = []
    for f in glob.glob(os.path.join(STD, "*.json")):
        d = json.load(open(f, encoding="utf-8"))
        phrases = [p for p in ((d.get("characteristic_phrases") or []) + (d.get("translates_from_colloquial") or []))
                   if len(p.split()) >= 2 and len(p) > 5]
        out.append({"cf": d["canonical_form"], "phrases": phrases, "file": f})
    return out

# Distinctiveness gate for entity SURFACE auto-linking (t/3219). A single-token surface that is a
# common English word (Capital, Nature, Windows, Gospel) collides with ordinary prose: case-
# insensitive word-boundary matching turns "venture capital" into a link to Marx's "Capital" and
# "AI's nature" into a link to the journal "Nature" (measured: 42 such false positives across the
# 904 BDI nodes once the entity set grew to 459). Such surfaces are EXCLUDED from surface auto-
# linking; they can still be reached by semantic (embedding) proposal or manual confirmation.
# Distinctive iff: multiword, OR contains a digit, OR contains a hyphen/dot, OR has an internal/
# acronym uppercase (>=2 caps: GDPR, RLHF, BERT), OR a single word NOT in COMMON_WORDS.
# Precision over recall — a well-structured entity space, not an infinite dictionary. Provenance:
# stipulated lexicon, evidence = the measured false-positive set (metric-provenance-register).
COMMON_WORDS = frozenset('''
a an the of to in on at by for with from into over under and or but so as is are was were be been
being do does did have has had not no it its they them their we our you your can could may might
must shall should will would if then than when where which who whose what why how all any both each
more most other some such only own same too very just also about above below between through during
before after out up down off again further once this that these those he she his her him
capital nature windows gospel control surface scale gap beam beams pattern patterns state states
model models agent agents policy policies power labor value values market markets light matter
subject object nation summit index reason reasons ground grounds system systems means end ends
'''.split())

def distinctive(surface):
    s = surface.strip()
    if len(s.split()) >= 2: return True                      # multiword
    if any(c.isdigit() for c in s): return True              # GPT-5, 10 USC 3252
    if "-" in s or "." in s: return True                     # robots.txt, GPT-4-base
    if sum(1 for c in s if c.isupper()) >= 2: return True    # GDPR, RLHF, BERT, iOS
    return s.lower() not in COMMON_WORDS                     # single word: link iff not common

def load_entities():
    with open(os.path.join(O, "entities.json"), encoding="utf-8") as f:
        store = json.load(f)
    out = []
    for e in store["entities"]:
        if e.get("status") != "approved":
            continue
        surfs = [("exact", e["name"])]
        al = e.get("aliases")
        if isinstance(al, list): surfs += [("alias", a) for a in al]
        elif isinstance(al, str) and al: surfs.append(("alias", al))
        # distinctiveness gate: drop common-word surfaces that would false-match ordinary prose
        out.append((e["id"], [(m, s) for m, s in surfs if s and len(s) > 2 and distinctive(s)]))
    return out

def load_situations():
    """Situation nodes (sit-*) own node:sit-* mention containers (TL ruling: all node:* is
    node-grounding). Text = concatenated interpretation belief/desire/intention across POVs."""
    p = os.path.join(O, "situations.json")
    if not os.path.exists(p):
        return []
    with open(p, encoding="utf-8") as f:
        raw = json.load(f)
    out = []
    for s in raw.get("nodes", []):
        parts = []
        for v in (s.get("interpretations") or {}).values():
            if isinstance(v, dict):
                parts += [str(v[k]) for k in ("belief", "desire", "intention") if v.get(k)]
            elif isinstance(v, str) and v:
                parts.append(v)
        text = "\n".join(parts)
        if text.strip():
            out.append((s["id"], text))
    return out

def entity_mentions_for(text, low, ents):
    mentions = []
    for eid, surfs in ents:
        hit = next(((meth, s, entity_span(s, text, low)) for meth, s in surfs if entity_span(s, text, low) is not None), None)
        if hit:
            meth, s, off = hit
            mentions.append({"entity_ref": eid, "quote": text[off:off + len(s)], "offset": off, "discovered_by": meth})
    return mentions

def load_vectors():
    emb = json.load(open(os.path.join(O, "embeddings.json"), encoding="utf-8")).get("nodes", {})
    nv = {}
    for nid, e in emb.items():
        v = e.get("vector") or e.get("embedding")
        if v:
            a = np.array(v, dtype=np.float64); nv[nid] = a / (np.linalg.norm(a) + 1e-9)
    sense = json.load(open(os.path.join(STD.replace("standardized", "sense_embeddings.json")), encoding="utf-8")).get("entries", {}) \
        if os.path.exists(STD.replace("standardized", "sense_embeddings.json")) else {}
    return nv, sense

# ---------- resolve one node ----------
def resolve(n, terms, ents, nv, sense):
    txt = node_text(n); low = txt.lower()
    crefs = []
    surfaced = set()
    for t in terms:
        m = next((ph for ph in t["phrases"] if word_span(ph, low) is not None), None)
        if m:
            crefs.append({"ref": "term:" + t["cf"], "surface": m, "method": "surface", "link_confidence": 1.0, "status": "linked"})
            surfaced.add(t["cf"])
    # embedding-proposed concepts (not already surface-linked)
    vec = nv.get(n["id"])
    if vec is not None and sense:
        for t in terms:
            if t["cf"] in surfaced or t["cf"] not in sense:
                continue
            sv = np.array(sense[t["cf"]]["embedding"], dtype=np.float64); sv = sv / (np.linalg.norm(sv) + 1e-9)
            cos = float(vec @ sv)
            if cos >= CON_TAU:
                crefs.append({"ref": "term:" + t["cf"], "surface": "", "method": "embedding", "link_confidence": round(cos, 4), "status": "proposed"})
    erefs, mentions = [], []
    for eid, surfs in ents:
        hit = next(((meth, s, entity_span(s, txt, low)) for meth, s in surfs if entity_span(s, txt, low) is not None), None)
        if hit:
            meth, s, off = hit
            erefs.append({"ref": eid, "surface": s, "method": meth, "link_confidence": 1.0, "match_level": "exact", "status": "linked"})
            mentions.append({"entity_ref": eid, "quote": txt[off:off + len(s)], "offset": off, "discovered_by": meth})
    return crefs, erefs, mentions

def _vocab_sha(terms, ents):
    """Hash of the resolver vocabulary (term phrases + entity surfaces). If this changes, already-
    resolved nodes may be STALE even when their own text is unchanged (vocabulary churn — a term's
    characteristic_phrases or an entity's aliases were edited). The full sweep stores it as the
    `_vocab_sha` sidecar sentinel and invalidates the per-node hash gate when it differs (G9, t/3164)."""
    tv = sorted(p for t in terms for p in t.get("phrases", []))
    ev = sorted(s for _, surfs in ents for _, s in surfs)
    return sha(json.dumps([tv, ev], ensure_ascii=False))  # unambiguous canonical serialization

# ---------- core reconcile (in-memory) ----------
def reconcile(pov_data, mentions_store, sidecar, terms, ents, nv, sense, situations=()):
    """Mutates pov_data nodes + mentions_store node:* + returns stats. Pure over inputs.
    `situations` = [(sit_id, text)] whose node:sit-* entity-mention containers are also owned here
    (TL ruling: all node:* is node-grounding). Situation forward concept_refs/entity_refs await a
    situation-schema field and are out of scope for this pass.

    Vocabulary-churn gate (G9, t/3164): this FULL sweep also compares the vocabulary hash against the
    `_vocab_sha` sentinel; on a mismatch it re-resolves EVERY node (not just text-changed ones), since a
    dictionary/alias edit can stale any node's concept_refs. Sentinel keys (`_`-prefixed) are never
    treated as node ids — excluded from removal-purge. Vocab-churn rides this sweep, not the inline
    scoped path (which is node-PUT-scoped and can't see dictionary edits)."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    vsha = _vocab_sha(terms, ents)
    vocab_changed = sidecar.get("_vocab_sha") != vsha
    current_ids = set()
    changed = skipped = 0
    for data in pov_data.values():
        for n in data["nodes"]:
            if not n.get("description"):
                continue
            nid = n["id"]; current_ids.add(nid)
            h = sha(node_text(n))
            if not vocab_changed and sidecar.get(nid) == h:
                skipped += 1; continue
            crefs, erefs, mentions = resolve(n, terms, ents, nv, sense)
            if crefs: n["concept_refs"] = crefs
            elif "concept_refs" in n: del n["concept_refs"]
            if erefs: n["entity_refs"] = erefs
            elif "entity_refs" in n: del n["entity_refs"]
            key = "node:" + nid
            if mentions:
                mentions_store["containers"][key] = {"text_sha256": h, "extracted_at": now, "mentions": mentions}
            elif key in mentions_store["containers"]:
                del mentions_store["containers"][key]
            sidecar[nid] = h; changed += 1
    # situations (sit-*): own their node:sit-* entity-mention containers (TL ruling)
    for sid, stext in situations:
        current_ids.add(sid)
        h = sha(stext)
        if not vocab_changed and sidecar.get(sid) == h:
            skipped += 1; continue
        mentions = entity_mentions_for(stext, stext.lower(), ents)
        key = "node:" + sid
        if mentions:
            mentions_store["containers"][key] = {"text_sha256": h, "extracted_at": now, "mentions": mentions}
        elif key in mentions_store["containers"]:
            del mentions_store["containers"][key]
        sidecar[sid] = h; changed += 1
    # purge removed nodes from ALL reverse maps (condition 5) — `_`-prefixed sentinels are NOT node ids
    removed = [nid for nid in list(sidecar) if not nid.startswith("_") and nid not in current_ids]
    for nid in removed:
        del sidecar[nid]
        mentions_store["containers"].pop("node:" + nid, None)
    sidecar["_vocab_sha"] = vsha  # stamp current vocabulary state (G9, t/3164)
    # derive used_by_nodes from forward concept_refs (condition 4)
    by_term = {}
    for data in pov_data.values():
        for n in data["nodes"]:
            for r in (n.get("concept_refs") or []):
                by_term.setdefault(r["ref"][len("term:"):], set()).add(n["id"])
    return {"changed": changed, "skipped": skipped, "removed": len(removed)}, by_term

# ---------- scoped reconcile (G8a inline entry point, t/3171) ----------
def reconcile_scoped(pov_data, mentions_store, sidecar, dirty_ids, terms, ents, nv, sense, situations=()):
    """Re-resolve ONLY nodes whose id is in `dirty_ids` (the PUT's changed set); every other node's
    stored grounding is left untouched. used_by_nodes is STILL re-derived globally from the current
    forward concept_refs (dirty nodes freshly resolved, all others as-stored) so the forward<->reverse
    consistency invariant (condition 4) holds under partial refresh. A dirty id absent from the current
    taxonomy+situations is a removal and is purged from ALL reverse maps (condition 5). Non-dirty nodes
    whose text changed are intentionally NOT re-resolved here — the caller declares the dirty-set and the
    scheduled full sweep (G8b) is the backstop. Returns (stats, by_term, touched_povs).

    The hash-gate still applies within the dirty-set (a dirty id whose text is unchanged is skipped), so
    this stays idempotent. Same disjoint-scope contract as reconcile(): sei:*/summary:* are never written.
    Caller MUST serialize against Update-EntityMentionIndex (shared-file read-merge-write; TL #7)."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    dirty = set(dirty_ids)
    sit_map = dict(situations)
    current_ids = {n["id"] for data in pov_data.values() for n in data["nodes"]} | set(sit_map)
    changed = skipped = removed = 0
    touched_povs = set()
    for pov_name, data in pov_data.items():
        for n in data["nodes"]:
            nid = n["id"]
            if nid not in dirty or not n.get("description"):
                continue
            h = sha(node_text(n))
            if sidecar.get(nid) == h:
                skipped += 1; continue
            crefs, erefs, mentions = resolve(n, terms, ents, nv, sense)
            if crefs: n["concept_refs"] = crefs
            elif "concept_refs" in n: del n["concept_refs"]
            if erefs: n["entity_refs"] = erefs
            elif "entity_refs" in n: del n["entity_refs"]
            key = "node:" + nid
            if mentions:
                mentions_store["containers"][key] = {"text_sha256": h, "extracted_at": now, "mentions": mentions}
            elif key in mentions_store["containers"]:
                del mentions_store["containers"][key]
            sidecar[nid] = h; changed += 1; touched_povs.add(pov_name)
    # dirty situations (sit-*): own node:sit-* containers
    for sid in dirty:
        if sid not in sit_map:
            continue
        stext = sit_map[sid]
        h = sha(stext)
        if sidecar.get(sid) == h:
            skipped += 1; continue
        mentions = entity_mentions_for(stext, stext.lower(), ents)
        key = "node:" + sid
        if mentions:
            mentions_store["containers"][key] = {"text_sha256": h, "extracted_at": now, "mentions": mentions}
        elif key in mentions_store["containers"]:
            del mentions_store["containers"][key]
        sidecar[sid] = h; changed += 1
    # removal-purge: dirty ids no longer present in taxonomy+situations (condition 5), scoped to the dirty-set
    for nid in dirty:
        if nid not in current_ids:
            if nid in sidecar:
                del sidecar[nid]; removed += 1
            mentions_store["containers"].pop("node:" + nid, None)
    # derive used_by_nodes GLOBALLY from current forward concept_refs (condition 4 holds under partial refresh)
    by_term = {}
    for data in pov_data.values():
        for n in data["nodes"]:
            for r in (n.get("concept_refs") or []):
                by_term.setdefault(r["ref"][len("term:"):], set()).add(n["id"])
    return {"changed": changed, "skipped": skipped, "removed": removed}, by_term, touched_povs

# ---------- selftest ----------
def _fixtures():
    """Synthetic in-memory inputs for a HERMETIC selftest — zero data-repo reads (t/3189), so the
    contract gate runs on any host / CI runner without an ai-triad-data checkout. Fresh objects each
    call (selftest mutates them). Exercises: surface links, an embedding-proposed ref, an entity ref,
    a node:* mention, a situation mention, and preserved sei:*/summary:* containers."""
    terms = [
        {"cf": "adaptive_governance", "phrases": ["adaptive governance"], "file": None},
        {"cf": "strict_liability", "phrases": ["strict liability"], "file": None},
        {"cf": "human_oversight", "phrases": ["human oversight"], "file": None},
    ]
    ents = [("ent-001", [("exact", "Manhattan Project"), ("alias", "Manhattan")])]
    mk = lambda nid, desc: {"id": nid, "label": nid, "description": desc}
    pov = {
        "accelerationist": {"nodes": [mk("acc-1", "adaptive governance is the priority"),
                                      mk("acc-2", "markets favor rapid deployment")]},
        "safetyist": {"nodes": [mk("saf-1", "human oversight, unlike the Manhattan Project, is essential"),
                                mk("saf-2", "precaution over speed")]},
        "skeptic": {"nodes": [mk("skp-1", "the hype exceeds reality")]},
    }
    ms = {"containers": {
        "sei:doc-1#e1": {"text_sha256": "x", "extracted_at": "t", "mentions": []},
        "summary:doc-1#acc-kp-1": {"text_sha256": "y", "extracted_at": "t", "mentions": []},
    }}
    # one embedding-proposed case: acc-1's (already unit-norm) vector aligns with the human_oversight sense vector
    v = [1.0, 0.0, 0.0, 0.0]
    nv = {"acc-1": np.array(v, dtype=np.float64)}
    sense = {"human_oversight": {"embedding": v}}
    sit = [("sit-001", "a debate invoking the Manhattan Project as precedent")]
    return terms, ents, pov, ms, nv, sense, sit

def selftest():
    terms, ents, pov, ms, nv, sense, sit = _fixtures()
    sc = {}
    sei_before = {k for k in ms["containers"] if k.startswith("sei:")}
    summary_before = {k for k in ms["containers"] if k.startswith("summary:")}
    # run 1 (cold): everything changes
    s1, ubn = reconcile(pov, ms, sc, terms, ents, nv, sense, sit)
    # SITUATION coverage: node:sit-* containers are owned + written here
    assert any(k.startswith("node:sit") for k in ms["containers"]), "FAIL: no node:sit-* container written"
    # CONSISTENCY (load-bearing): used_by_nodes == {nodes whose concept_refs include term}
    fwd = {}
    for data in pov.values():
        for n in data["nodes"]:
            for r in (n.get("concept_refs") or []):
                fwd.setdefault(r["ref"][len("term:"):], set()).add(n["id"])
    assert fwd == {k: v for k, v in ubn.items()}, "FAIL: forward<->reverse mismatch"
    # DISJOINT: sei:* untouched
    sei_after = {k for k in ms["containers"] if k.startswith("sei:")}
    assert sei_before == sei_after, "FAIL: sei:* containers modified (double-write)"
    assert {k for k in ms["containers"] if k.startswith("summary:")} == summary_before, "FAIL: summary:* containers modified (double-write; PS owns sei:*+summary:*)"
    # IDEMPOTENCE: run 2 (warm) with same sidecar -> 0 changed
    s2, _ = reconcile(pov, ms, sc, terms, ents, nv, sense, sit)
    assert s2["changed"] == 0, f"FAIL: not idempotent, {s2['changed']} changed on warm run"
    # CHANGE-DETECTION: edit one node -> only it re-resolves
    tgt = pov["accelerationist"]["nodes"][0]; tgt["description"] = (tgt.get("description") or "") + " strict liability regime."
    s3, _ = reconcile(pov, ms, sc, terms, ents, nv, sense, sit)
    assert s3["changed"] == 1, f"FAIL: change-detection re-resolved {s3['changed']} nodes, expected 1"
    # REMOVAL-PURGE: drop a node -> purged from mentions + sidecar
    victim = pov["safetyist"]["nodes"][0]["id"]
    pov["safetyist"]["nodes"] = pov["safetyist"]["nodes"][1:]
    s4, ubn4 = reconcile(pov, ms, sc, terms, ents, nv, sense, sit)
    assert victim not in sc, "FAIL: removed node still in sidecar"
    assert ("node:" + victim) not in ms["containers"], "FAIL: removed node still has node:* mention"
    assert all(victim not in v for v in ubn4.values()), "FAIL: removed node still in used_by_nodes"
    # VOCAB-CHURN (G9, t/3164): editing a term's phrases invalidates the gate -> full re-resolve even
    # though no node text changed; the `_vocab_sha` sentinel persists (never purged, not a node id).
    vt, ve, vpov, vms, vnv, vse, vsit = _fixtures()
    vsc = {}
    reconcile(vpov, vms, vsc, vt, ve, vnv, vse, vsit)                      # cold
    rvw, _ = reconcile(vpov, vms, vsc, vt, ve, vnv, vse, vsit)             # warm -> 0 changed
    assert rvw["changed"] == 0, f"FAIL: vocab warm run changed {rvw['changed']}"
    assert "_vocab_sha" in vsc, "FAIL: _vocab_sha sentinel not stamped"
    vt[0]["phrases"] = vt[0]["phrases"] + ["adaptive oversight regime"]    # churn ONE term's phrases
    n_units = sum(len(d["nodes"]) for d in vpov.values()) + len(vsit)
    rvc, _ = reconcile(vpov, vms, vsc, vt, ve, vnv, vse, vsit)
    assert rvc["changed"] == n_units, f"FAIL: vocab churn re-resolved {rvc['changed']}, expected all {n_units}"
    assert rvc["removed"] == 0, "FAIL: sentinel wrongly counted as a removed node"
    rvw2, _ = reconcile(vpov, vms, vsc, vt, ve, vnv, vse, vsit)            # settles back to idempotent
    assert rvw2["changed"] == 0 and "_vocab_sha" in vsc, "FAIL: sentinel purged or not idempotent after churn"
    # SCOPED (G8a, t/3171): re-resolve only the dirty-set; non-dirty nodes preserved; consistency holds
    _t2, _e2, pov2, ms2, _nv2, _s2, _sit2 = _fixtures()  # fresh synthetic tree (hermetic, t/3189)
    sc2 = {}
    reconcile(pov2, ms2, sc2, terms, ents, nv, sense, sit)  # cold baseline: full refs + sidecar
    a, b = pov2["accelerationist"]["nodes"][0], pov2["accelerationist"]["nodes"][1]
    bump = " adaptive governance oversight, strict liability regime."
    a["description"] = (a.get("description") or "") + bump
    b["description"] = (b.get("description") or "") + bump  # b edited too but NOT in the scoped set
    b_refs_before = b.get("concept_refs")
    ssc, sub, touched = reconcile_scoped(pov2, ms2, sc2, [a["id"]], terms, ents, nv, sense, sit)
    assert ssc["changed"] == 1, f"FAIL: scoped re-resolved {ssc['changed']} nodes, expected 1"
    assert b.get("concept_refs") == b_refs_before, "FAIL: scoped run mutated a non-dirty node's refs"
    assert touched == {"accelerationist"}, f"FAIL: scoped touched_povs {touched}, expected {{accelerationist}}"
    fwd2 = {}
    for data in pov2.values():
        for n in data["nodes"]:
            for r in (n.get("concept_refs") or []):
                fwd2.setdefault(r["ref"][len("term:"):], set()).add(n["id"])
    assert fwd2 == {k: v for k, v in sub.items()}, "FAIL: scoped forward<->reverse mismatch"
    assert {k for k in ms2["containers"] if k.startswith("sei:")} == sei_before, "FAIL: scoped touched sei:*"
    assert {k for k in ms2["containers"] if k.startswith("summary:")} == summary_before, "FAIL: scoped touched summary:*"
    # SCOPED removal: a dirty id absent from taxonomy is purged; a re-run over unchanged dirty-set = 0 changed
    ssc2, _, _ = reconcile_scoped(pov2, ms2, sc2, [a["id"]], terms, ents, nv, sense, sit)
    assert ssc2["changed"] == 0, f"FAIL: scoped not idempotent, {ssc2['changed']} changed on re-run"
    # LOCK (t/3194): acquire creates the file; a held lock blocks a bounded second acquire; release removes it;
    # a stale (old-mtime) lock is broken. Uses a tempdir path so the data repo is untouched.
    import tempfile
    lp = os.path.join(tempfile.gettempdir(), f"grounding_selftest_{os.getpid()}.lock")
    if os.path.exists(lp):
        os.unlink(lp)
    with grounding_lock("t", path=lp, wait_sec=1, stale_sec=9999):
        assert os.path.exists(lp), "FAIL: lock file not created on acquire"
        try:
            with grounding_lock("t2", path=lp, wait_sec=1, stale_sec=9999):
                assert False, "FAIL: acquired an already-held lock"
        except RuntimeError:
            pass  # expected: bounded wait elapsed while the lock was held
    assert not os.path.exists(lp), "FAIL: lock file not removed on release"
    with open(lp, "w", encoding="utf-8") as f:
        f.write("stale")
    old = time.time() - 10000
    os.utime(lp, (old, old))
    with grounding_lock("t", path=lp, wait_sec=1, stale_sec=120):  # stale -> broken + re-acquired
        assert os.path.exists(lp), "FAIL: stale lock not re-acquired"
    assert not os.path.exists(lp), "FAIL: lock file not removed after stale-break run"
    print("SELFTEST PASS: consistency, disjoint-scope, idempotence, change-detection, removal-purge, vocab-churn, scoped, lock")
    print(f"  cold run: {s1}   used_by_nodes terms: {len(ubn)}")

if SELFTEST:
    selftest(); sys.exit(0)

# ---------- dry-run / apply over live data ----------
# Resolver inputs are read-only + atomic-safe (tmp+rename) — loaded OUTSIDE the lock to keep hold time short.
terms, ents = load_terms(), load_entities()
nv, sense = load_vectors()
sit = load_situations()

def commit_mentions(ms):
    """Tightest critical section (t/3163 lock-hold gate). `node:*` mention containers are derived from
    SOURCE (pov/dict/vectors), NOT from entity_mentions.json, so `reconcile()` computes the complete
    node:* set OUTSIDE the lock. Only this shared-file read-merge-write is serialized vs
    Update-EntityMentionIndex. The re-read INSIDE the lock is the merge basis: a concurrent PS
    `sei:*`/`summary:*` write landing between compute and acquire is picked up (not a lost update).
    We own node:* only — drop the fresh read's stale node:* and set our freshly-resolved set; sei:*/
    summary:* pass through untouched. Hold time = one entity_mentions read+write (was ~61s when the
    whole run_live, incl. the per-node concept-embedding cosine, sat under the lock)."""
    node_star = {k: v for k, v in ms["containers"].items() if k.startswith("node:")}
    with grounding_lock("reconciler"):
        t0 = datetime.now(timezone.utc)
        fresh = load_json(MENTIONS)
        fc = fresh["containers"]
        for k in [k for k in fc if k.startswith("node:")]:
            del fc[k]
        fc.update(node_star)
        dump_json(MENTIONS, fresh)
        held = (datetime.now(timezone.utc) - t0).total_seconds()
        # observability for the t/3163 lock-hold gate: must stay well under the 120s stale-break.
        sys.stderr.write(f"grounding_lock held {held:.2f}s (node:* merge; PS-shared critical section)\n")

def run_live():
    """Resolve grounding and write. Resolution + the reconciler-OWNED writes (pov concept_refs/
    entity_refs, dict used_by_nodes, sidecar) run OUTSIDE the lock — none of those are shared with
    Update-EntityMentionIndex, and each file write is atomic (tmp+rename). Only the entity_mentions.json
    read-merge-write is locked, via commit_mentions(). Dry-run/selftest are read-only (no lock)."""
    pov = {p: load_json(os.path.join(O, p + ".json")) for p in ("accelerationist", "safetyist", "skeptic")}
    ms = load_json(MENTIONS)
    sc = load_json(SIDECAR) if os.path.exists(SIDECAR) else {}
    if SCOPED:
        # G8a scoped mode (t/3171): re-resolve only the dirty-set; bound writes to touched POV + changed dict files.
        # Presence of --nodes forces scoped mode; an empty/malformed id list is a safe no-op, NEVER a full apply.
        stats, ubn, touched = reconcile_scoped(pov, ms, sc, SCOPED_IDS, terms, ents, nv, sense, sit)
        print(json.dumps(stats, indent=2))
        print(f"scoped nodes: {len(SCOPED_IDS)}  touched POVs: {sorted(touched)}  used_by_nodes terms: {len(ubn)}")
        if APPLY:
            for p in touched:
                dump_json(os.path.join(O, p + ".json"), pov[p])
            dict_writes = 0
            for t in terms:
                d = load_json(t["file"])
                new = sorted(ubn.get(t["cf"], set()))
                if d.get("used_by_nodes") != new:  # write only terms whose reverse-set actually changed
                    d["used_by_nodes"] = new
                    dump_json(t["file"], d)
                    dict_writes += 1
            commit_mentions(ms)  # locked: shared entity_mentions.json read-merge-write
            dump_json(SIDECAR, sc)  # ledger LAST (t/3163 GV): a crash before this UNDER-reports (re-resolve next run), never over-reports done-but-unwritten node:*
            print(f"APPLIED (scoped): {len(touched)} POV file(s), {dict_writes} dict file(s)")
        else:
            print("DRY RUN (scoped)")
    else:
        stats, ubn = reconcile(pov, ms, sc, terms, ents, nv, sense, sit)
        print(json.dumps(stats, indent=2))
        print(f"used_by_nodes terms: {len(ubn)}  total node-links: {sum(len(v) for v in ubn.values())}")
        if APPLY:
            for p, data in pov.items():
                dump_json(os.path.join(O, p + ".json"), data)
            # write used_by_nodes into standardized files
            for t in terms:
                d = load_json(t["file"])
                d["used_by_nodes"] = sorted(ubn.get(t["cf"], set()))
                dump_json(t["file"], d)
            commit_mentions(ms)  # locked: shared entity_mentions.json read-merge-write
            dump_json(SIDECAR, sc)  # ledger LAST (t/3163 GV): a crash before this UNDER-reports (re-resolve next run), never over-reports done-but-unwritten node:*
            print("APPLIED")
        else:
            print("DRY RUN")

run_live()  # APPLY locks only commit_mentions(); dry-run/selftest are read-only
