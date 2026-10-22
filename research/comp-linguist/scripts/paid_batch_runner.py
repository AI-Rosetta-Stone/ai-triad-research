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

Approval gate (t/3963#9): a plan must carry `approval_ref`, the recorded approval of its spend, as a
ticket comment `t/KEY#N` or a ping `p/N#M`. A plan-level `hard_stop_usd` override must cite one in its
`hard_stop_ref`. "Approved in chat" is not a record; the runner refuses such a plan before any spend (exit 5).

Usage:
  python paid_batch_runner.py --plan <plan.json> --ledger <ledger.json> --code-root <frozen worktree>
  python paid_batch_runner.py --ledger <ledger.json> --report
Exit codes: 0 ran one debate; 10 nothing left in this plan; 11 a hard stop refused the next debate;
3 a pin mismatch (abort); 4 the debate run failed; 5 the plan has no recorded approval (refused).
"""
import argparse, glob, json, os, re, subprocess, sys, time
from datetime import datetime, timezone

WORST_CASE_USD = 0.25        # pilot max was $0.218 per debate (t/3802#5); rounded up
DEBATE_TIMEOUT_SEC = 570     # stays under the 10-minute foreground cap
RECORDED_REF = re.compile(r"(?<![\w/])(?:t/[A-Za-z0-9-]+#\d+|p/\d+#\d+)(?!\w)")


def approval_problem(plan):
    """Why the plan's spend approval isn't a recorded reference, or None when it is."""
    ref = plan.get("approval_ref")
    if not isinstance(ref, str) or not RECORDED_REF.fullmatch(ref.strip()):
        return (f"approval_ref is {ref!r}, not a recorded ticket comment (t/KEY#N) or ping (p/N#M)"
                + (f"; approval_status: {plan['approval_status']}" if plan.get("approval_status") else ""))
    if "hard_stop_usd" in plan and not RECORDED_REF.search(str(plan.get("hard_stop_ref", ""))):
        return f"hard_stop_usd {plan['hard_stop_usd']} overrides the cap, but hard_stop_ref cites no t/KEY#N or p/N#M"
    return None


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
    """Model -> {inputPer1M, outputPer1M}; skips non-model entries such as `_comment`."""
    raw = (load(os.path.join(code_root, "ai-models.json")) or {}).get("pricing", {})
    return {k: v for k, v in raw.items() if isinstance(v, dict)}


def counted(row):
    """A ledger row uses a slot of the debate cap if the debate completed or it spent money.
    `counts_toward_cap: false` exempts a run that never started a debate (zero AI calls); its booked
    spend still counts toward the budget."""
    if row.get("counts_toward_cap") is False:
        return False
    return row.get("status") == "ok" or (row.get("usd") or 0) > 0


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
            "staging_pacing": (d.get("adaptive_staging") or {}).get("pacing"),
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
    ap.add_argument("--reserve", type=float, default=WORST_CASE_USD,
                    help="per-debate spend reserved before starting one; size it to the format's max cost")
    ap.add_argument("--timeout", type=int, default=DEBATE_TIMEOUT_SEC)
    a = ap.parse_args()
    ledger = load(a.ledger, {"budget": a.budget, "max_debates": a.max_debates, "debates": []})
    # An existing ledger keeps the limits it was created with; the flags apply only to a new one (t/3963).
    for key, flag in (("budget", a.budget), ("max_debates", a.max_debates)):
        if ledger.get(key) != flag:
            print(f"WARN: --{key.replace('_', '-')} {flag} ignored; the existing ledger's {key} is {ledger.get(key)}")
    if a.report:
        report(ledger); return 0

    plan = load(a.plan)
    problem = approval_problem(plan)
    if problem:
        sys.stderr.write(
            "ERROR paid_batch_runner: refusing the plan before any spend.\n"
            f"  Goal: run the next debate of paid plan '{plan.get('name')}'.\n"
            f"  Problem: {problem.rstrip('.')}.\n"
            f"  Location: {a.plan}\n"
            "  Next Steps: get the spend approved by the PI and recorded on a ticket comment or ping, then set "
            "approval_ref to that reference (t/3963#9).\n")
        return 5
    out_dir = plan["output_dir"]
    os.makedirs(out_dir, exist_ok=True)
    done = {os.path.basename(p)[:-len("-debate.json")] for p in glob.glob(os.path.join(out_dir, "*-debate.json"))}
    # Reconcile: a completed debate with no ledger row (e.g. the runner died after the run) is priced now,
    # so spend is never undercounted.
    logged = {(r["plan"], r["slug"]) for r in ledger["debates"] if r.get("status") == "ok"}
    for slug in sorted(done):
        if (plan["name"], slug) not in logged:
            c = debate_cost(os.path.join(out_dir, f"{slug}-flight-recorder.jsonl"), price_table(a.code_root))
            ledger["debates"].append({"plan": plan["name"], "slug": slug, "usd": c["usd"], "calls": c["calls"],
                                      "in": c["in"], "out": c["out"], "status": "ok", "note": "reconciled"})
            sys.stderr.write(f"WARN paid_batch_runner: reconciled unlogged completed debate {slug} (${c['usd']})\n")
    save(a.ledger, ledger)
    todo = [d for d in plan["debates"] if d["slug"] not in done]
    if not todo:
        print(f"PLAN COMPLETE: {plan['name']} ({len(plan['debates'])} debates)"); return 10

    spent = sum(r.get("usd") or 0 for r in ledger["debates"])  # every dollar, killed attempts included
    # `count_cap_on: "completed"` (a plan-level ruling, re-read each debate) counts only completed debates
    # toward max_debates; the default counts every paid attempt. Spend is never exempted either way.
    if plan.get("count_cap_on") == "completed":
        used = sum(1 for r in ledger["debates"] if r.get("status") == "ok")
    else:
        used = sum(1 for r in ledger["debates"] if counted(r))
    # A PI-approved cap change is recorded in the plan (`hard_stop_usd`, with its approval ref), which a
    # running loop re-reads every debate. The ledger's own `budget` is rewritten by whichever process saves
    # last, so it can't carry a mid-run change safely.
    budget = plan.get("hard_stop_usd", ledger["budget"])
    if budget != ledger["budget"]:
        sys.stderr.write(f"WARN paid_batch_runner: hard stop ${budget:.2f} from the plan "
                         f"({plan.get('hard_stop_ref', 'no ref')}) overrides the ledger's ${ledger['budget']:.2f}\n")
        ledger["budget"] = budget
    if used >= ledger["max_debates"]:
        print(f"HARD STOP: {used} debates counted, the cap is {ledger['max_debates']}"); return 11
    if spent + a.reserve > budget:
        print(f"HARD STOP: spent ${spent:.2f}; one more debate (reserve ${a.reserve}) could pass "
              f"${budget:.2f}"); return 11

    item = todo[0]
    cfg = dict(plan["base_config"]); cfg.update(item.get("config", {}))
    cfg.update({"slug": item["slug"], "outputDir": out_dir})
    # The CLI applies `pacing` only with useAdaptiveStaging=true; without it the debate runs fixed rounds
    # and records no staging block (the 2026-10-20 batch ran 56 debates that way, t/3802#8). Refuse it
    # before spending anything.
    if cfg.get("pacing") and not cfg.get("useAdaptiveStaging"):
        print(f"ABORT before run: {item['slug']} sets pacing={cfg['pacing']!r} without useAdaptiveStaging=true, "
              "so the CLI would ignore the pacing. Set useAdaptiveStaging, or drop pacing.")
        return 3
    cfg_path = os.path.join(out_dir, f"{item['slug']}-config.json")
    save(cfg_path, cfg)
    print(f"RUN {plan['name']} {item['slug']} ({len(done) + 1}/{len(plan['debates'])}); spent so far ${spent:.2f}",
          flush=True)
    # Book the reserve BEFORE running. If this process is killed mid-debate (e.g. by a low-memory reaper),
    # the saved in-flight row keeps the reserve in the ledger, so the hard stop never undercounts. A
    # returning run replaces it with the measured row.
    inflight = {"plan": plan["name"], "slug": item["slug"], "usd": a.reserve, "status": "in-flight",
                "note": "booked at --reserve before the run; a row left in this state means the run was killed",
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    ledger["debates"].append(inflight); save(a.ledger, ledger)
    t0 = time.time()
    try:
        proc = subprocess.run(["npx", "tsx", "lib/debate/cli.ts", "--config", cfg_path], cwd=a.code_root,
                              capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=a.timeout, shell=(os.name == "nt"))
        rc, tail = proc.returncode, (proc.stdout + proc.stderr)[-1500:]
    except subprocess.TimeoutExpired:
        rc, tail = "timeout", ""
    secs = round(time.time() - t0)
    ledger["debates"].remove(inflight)  # replaced below by the measured (or failed) row
    cost = debate_cost(os.path.join(out_dir, f"{item['slug']}-flight-recorder.jsonl"), price_table(a.code_root))
    row = {"plan": plan["name"], "slug": item["slug"], "usd": cost["usd"], "calls": cost["calls"],
           "in": cost["in"], "out": cost["out"], "secs": secs, "rc": rc,
           "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    debate = load(os.path.join(out_dir, f"{item['slug']}-debate.json"))
    if rc != 0 or debate is None:
        if cost["usd"] is None:  # no flight recorder: fall back to the partial's own AI-call count
            partial = load(os.path.join(out_dir, f"{item['slug']}-partial.json")) or {}
            overview = (partial.get("diagnostics") or {}).get("overview") or {}
            n_calls = overview.get("total_ai_calls")
            n_in = overview.get("total_input_tokens") or 0
            n_turns = len(partial.get("transcript") or [])
            # `total_ai_calls` can read 0 on a run that spent (t3790a32: 0 calls, 583,910 input tokens,
            # 14 turns), so it is only "no spend" when the tokens and the transcript agree. Unknown spend
            # is booked at the worst case.
            zero_spend = n_calls == 0 and n_in == 0 and n_turns == 0
            row["usd"] = 0.0 if zero_spend else a.reserve
            row["note"] = (f"no flight recorder; partial total_ai_calls={n_calls}, "
                           f"total_input_tokens={n_in}, transcript turns={n_turns}")
            if not zero_spend and n_calls == 0:
                sys.stderr.write(f"WARN paid_batch_runner: {item['slug']} partial reports 0 AI calls but "
                                 f"{n_in} input tokens and {n_turns} turns; booked at the reserve ${a.reserve}\n")
        row["status"] = "failed"; ledger["debates"].append(row); save(a.ledger, ledger)
        print(f"FAILED {item['slug']} rc={rc} after {secs}s, booked ${row['usd']}\n--- CLI output tail ---\n{tail}")
        return 4

    expected = dict(plan["expected_pins"]); expected["seat_tags"] = item.get("expected_seat_tags")
    if cfg.get("useAdaptiveStaging"):
        expected["staging_pacing"] = cfg.get("pacing") or "moderate"
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
