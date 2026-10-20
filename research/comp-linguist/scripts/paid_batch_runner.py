"""Run ONE debate of a PI-approved paid batch, with a hard spend stop (t/3802#6, approved 2026-10-20).

Each call runs the next debate in the plan that has no `<slug>-debate.json` yet, then exits, so the batch
runs in the foreground one debate at a time (t/3790#16 run-gate 3) and resumes cleanly after any stop.

Hard stops, checked BEFORE a debate starts (shared across every plan in the batch, via one ledger):
  * spend: refuse if ledger spend + WORST_CASE_USD > --budget (default 15.00);
  * count: refuse if the ledger already holds --max-debates (default 56).
Spend is measured, not estimated: after each debate, the token usage in its flight recorder is priced
from ai-models.json. A model missing from the price table is priced at the highest listed rate, with a WARN.

Config pins (t/3790#16 run-gate 2): every debate's recorded model / protocol / audience / povers / seat_tags,
and the build identity (app_version, generated_with_prompt_version), must match the plan and the plan's first
debate. On any mismatch the runner exits 3 and the batch stops.

Usage:
  python paid_batch_runner.py --plan <plan.json> --ledger <ledger.json> --code-root <frozen worktree>
  python paid_batch_runner.py --ledger <ledger.json> --report
Exit codes: 0 ran one debate; 10 nothing left in this plan; 11 a hard stop refused the next debate;
3 a pin mismatch (abort); 4 the debate run failed.
"""
import argparse, glob, json, os, subprocess, sys, time
from datetime import datetime, timezone

WORST_CASE_USD = 0.25        # pilot max was $0.218 per debate (t/3802#5); rounded up
DEBATE_TIMEOUT_SEC = 570     # stays under the 10-minute foreground cap


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2)
    os.replace(tmp, path)


def price_table(code_root):
    return (load(os.path.join(code_root, "ai-models.json")) or {}).get("pricing", {})


def debate_cost(flight_recorder, prices):
    worst = max(prices.values(), key=lambda p: p.get("outputPer1M", 0)) if prices else {"inputPer1M": 0, "outputPer1M": 0}
    usd = tin = tout = calls = 0
    unpriced = set()
    try:
        fh = open(flight_recorder, encoding="utf-8")
    except FileNotFoundError:
        return {"usd": None, "calls": 0, "in": 0, "out": 0, "note": "no flight recorder"}
    with fh:
        for line in fh:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            data = ev.get("data") or {}
            u = data.get("usage")
            if not u or "success" not in str(ev.get("message", "")):
                continue
            i = int(u.get("promptTokens") or u.get("inputTokens") or 0)
            o = int(u.get("completionTokens") or u.get("outputTokens") or 0)
            model = data.get("model") or data.get("modelId") or ""
            p = prices.get(model)
            if p is None:
                unpriced.add(model)
                p = worst
            usd += i / 1e6 * p.get("inputPer1M", 0) + o / 1e6 * p.get("outputPer1M", 0)
            tin += i; tout += o; calls += 1
    if unpriced:
        sys.stderr.write(f"WARN paid_batch_runner: priced unknown model(s) {sorted(unpriced)} at the highest rate\n")
    return {"usd": round(usd, 4), "calls": calls, "in": tin, "out": tout}


def seat_tags_of(d):
    """{speaker: {pov_tag, tag_mode}} only, so extra recorded fields don't read as a mismatch."""
    st = d.get("seat_tags") or {}
    norm = {sp: {"pov_tag": v.get("pov_tag"), "tag_mode": v.get("tag_mode")}
            for sp, v in st.items() if isinstance(v, dict)}
    return norm or None


def pins_of(d):
    return {"debate_model": d.get("debate_model"), "protocol_id": d.get("protocol_id"),
            "audience": d.get("audience"), "active_povers": d.get("active_povers"),
            "seat_tags": seat_tags_of(d), "app_version": d.get("app_version"),
            "generated_with_prompt_version": d.get("generated_with_prompt_version")}


def report(ledger):
    rows = ledger.get("debates", [])
    spent = sum(r.get("usd") or 0 for r in rows)
    print(f"ledger: {len(rows)} debates, ${spent:.2f} spent of ${ledger.get('budget', 15):.2f}")
    for plan in sorted({r["plan"] for r in rows}):
        sub = [r for r in rows if r["plan"] == plan]
        print(f"  {plan}: {len(sub)} debates, ${sum(r.get('usd') or 0 for r in sub):.2f}, "
              f"failed {sum(1 for r in sub if r.get('status') != 'ok')}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--plan"); ap.add_argument("--ledger", required=True)
    ap.add_argument("--code-root"); ap.add_argument("--budget", type=float, default=15.0)
    ap.add_argument("--max-debates", type=int, default=56); ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    ledger = load(a.ledger, {"budget": a.budget, "max_debates": a.max_debates, "debates": []})
    if a.report:
        report(ledger); return 0

    plan = load(a.plan)
    out_dir = plan["output_dir"]
    os.makedirs(out_dir, exist_ok=True)
    done = {os.path.basename(p)[:-len("-debate.json")] for p in glob.glob(os.path.join(out_dir, "*-debate.json"))}
    todo = [d for d in plan["debates"] if d["slug"] not in done]
    if not todo:
        print(f"PLAN COMPLETE: {plan['name']} ({len(plan['debates'])} debates)"); return 10

    spent = sum(r.get("usd") or 0 for r in ledger["debates"])
    if len(ledger["debates"]) >= ledger["max_debates"]:
        print(f"HARD STOP: {len(ledger['debates'])} debates run, the cap is {ledger['max_debates']}"); return 11
    if spent + WORST_CASE_USD > ledger["budget"]:
        print(f"HARD STOP: spent ${spent:.2f}; one more debate (worst ${WORST_CASE_USD}) could pass "
              f"${ledger['budget']:.2f}"); return 11

    item = todo[0]
    cfg = dict(plan["base_config"]); cfg.update(item.get("config", {}))
    cfg.update({"slug": item["slug"], "outputDir": out_dir})
    cfg_path = os.path.join(out_dir, f"{item['slug']}-config.json")
    save(cfg_path, cfg)
    print(f"RUN {plan['name']} {item['slug']} ({len(done) + 1}/{len(plan['debates'])}); spent so far ${spent:.2f}")
    t0 = time.time()
    try:
        proc = subprocess.run(["npx", "tsx", "lib/debate/cli.ts", "--config", cfg_path], cwd=a.code_root,
                              capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=DEBATE_TIMEOUT_SEC, shell=(os.name == "nt"))
        rc, tail = proc.returncode, (proc.stdout + proc.stderr)[-1500:]
    except subprocess.TimeoutExpired:
        rc, tail = "timeout", ""
    secs = round(time.time() - t0)
    cost = debate_cost(os.path.join(out_dir, f"{item['slug']}-flight-recorder.jsonl"), price_table(a.code_root))
    row = {"plan": plan["name"], "slug": item["slug"], "usd": cost["usd"], "calls": cost["calls"],
           "in": cost["in"], "out": cost["out"], "secs": secs, "rc": rc,
           "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    debate = load(os.path.join(out_dir, f"{item['slug']}-debate.json"))
    if rc != 0 or debate is None:
        row["status"] = "failed"; ledger["debates"].append(row); save(a.ledger, ledger)
        print(f"FAILED {item['slug']} rc={rc} after {secs}s, cost ${cost['usd']}\n{tail}"); return 4

    expected = dict(plan["expected_pins"]); expected["seat_tags"] = item.get("expected_seat_tags")
    got = pins_of(debate)
    first = next((r.get("build") for r in ledger["debates"] if r["plan"] == plan["name"] and r.get("build")), None)
    build = {k: got[k] for k in ("app_version", "generated_with_prompt_version")}
    bad = {k: (expected[k], got[k]) for k in expected if k in got and expected[k] != got[k]}
    if first and first != build:
        bad["build"] = (first, build)
    row.update({"build": build, "status": "ok" if not bad else "pin-mismatch"})
    ledger["debates"].append(row); save(a.ledger, ledger)
    if bad:
        print(f"ABORT: pin mismatch on {item['slug']}: {bad}"); return 3
    print(f"OK {item['slug']} in {secs}s: {cost['calls']} calls, ${cost['usd']}; "
          f"batch total ${spent + (cost['usd'] or 0):.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
