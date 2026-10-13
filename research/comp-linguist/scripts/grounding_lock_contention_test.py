#!/usr/bin/env python3
"""Cross-replica contention test for reconcile_grounding.grounding_lock (t/4177, ServerAPI p/747#7).

Question: on the real shared mount (Azure Files), does grounding_lock give mutual exclusion when
several replicas race it? Two separate risks, tested separately:

  arm A  O_EXCL atomicity: N workers race os.open(O_CREAT|O_EXCL) on the same fresh path, once per
         round. Pass: exactly one winner per round, and every loser saw FileExistsError (EEXIST).
  arm B  the full lock, INCLUDING the stale-break path: workers loop acquiring grounding_lock with
         a short stale_sec, and some holds deliberately outlive it. Inside the critical section each
         worker checks that it is alone. Pass: zero overlaps. A stale-break race shows up here as an
         overlap even if arm A passes, because two breakers can each unlink, and one unlinks the
         other's fresh lock.
  skew   the mount sets mtime (server clock); staleness compares it with this host's time.time().
         Reports this host's offset, which shifts the effective stale window.

The real grounding_lock is extracted from reconcile_grounding.py with ast and run in isolation:
importing that module runs the reconciler (run_live() at module level), so it must not be imported.

Cross-replica use: run the SAME command on every replica, pointing --dir at a fresh directory on the
shared mount and passing the SAME --start-at (an epoch a minute or so in the future), each with its
own --worker id. Then run --report once. Single-host smoke test: --local N spawns N processes.

  python grounding_lock_contention_test.py --dir /mnt/share/lockprobe --worker r1 --start-at 1760300000
  python grounding_lock_contention_test.py --dir /mnt/share/lockprobe --report
  python grounding_lock_contention_test.py --dir /tmp/lockprobe --local 6        # smoke test

Detection only: writes nothing outside --dir. Exit 0 = PASS, 1 = FAIL, 2 = the run itself was bad.
"""
import argparse, ast, contextlib, datetime, json, os, random, socket, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "reconcile_grounding.py")


def load_grounding_lock():
    """Return the real grounding_lock from reconcile_grounding.py without running that module."""
    tree = ast.parse(open(SOURCE, encoding="utf-8").read(), SOURCE)
    fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "grounding_lock"), None)
    if fn is None:
        sys.exit("BAD RUN: grounding_lock not found in reconcile_grounding.py")
    mod = ast.Module(body=[fn], type_ignores=[])
    ns = {"contextlib": contextlib, "json": json, "os": os, "socket": socket, "sys": sys, "time": time,
          "datetime": datetime.datetime, "timezone": datetime.timezone,
          # the defaults reference these module constants; arm B always passes explicit values
          "LOCKFILE": None, "LOCK_WAIT_SEC": 60, "LOCK_STALE_SEC": 120, "LOCK_POLL_SEC": 0.5}
    exec(compile(mod, SOURCE, "exec"), ns)
    return ns["grounding_lock"]


def wait_until(t):
    d = t - time.time()
    if d > 0:
        time.sleep(d)


def run_worker(a):
    os.makedirs(a.dir, exist_ok=True)
    out = {"worker": a.worker, "host": socket.gethostname(), "pid": os.getpid(), "excl": [], "overlaps": [],
           "acquired": 0, "lock_errors": 0}
    # skew: create a file and compare the mount's mtime with this host's clock
    probe = os.path.join(a.dir, f"skew-{a.worker}")
    t0 = time.time()
    with open(probe, "w") as f:
        f.write("x")
    out["skew_sec"] = round(os.path.getmtime(probe) - t0, 3)
    os.unlink(probe)

    # arm A: one O_EXCL race per round, on a fresh path per round
    for r in range(a.rounds):
        wait_until(a.start_at + r * a.period)
        path = os.path.join(a.dir, f"excl-{r:04d}")
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, a.worker.encode())
            os.close(fd)
            out["excl"].append([r, "won"])
        except FileExistsError:
            out["excl"].append([r, "eexist"])
        except OSError as e:  # anything else is a finding too: the loser must see EEXIST specifically
            out["excl"].append([r, f"error:{e.errno}"])

    save(a, out)  # arm A is recorded even if arm B later dies

    # arm B: the real lock, with a short stale window and some holds that outlive it. Each completed
    # critical section is logged as [enter, exit]; the report intersects intervals across workers, so a
    # crashed worker leaves no phantom occupancy behind.
    grounding_lock = load_grounding_lock()
    lock = os.path.join(a.dir, "probe.lock")
    b_start = a.start_at + a.rounds * a.period + 2
    wait_until(b_start)
    rnd = random.Random(a.worker)
    out["intervals"], out["lock_exceptions"] = [], {}
    while time.time() < b_start + a.duration:
        try:
            with grounding_lock(holder=a.worker, path=lock, wait_sec=a.stale + 5, stale_sec=a.stale,
                                poll_sec=0.05):
                enter = time.time()
                hold = a.stale * 1.5 if rnd.random() < a.long_frac else rnd.uniform(0.05, 0.3)
                time.sleep(hold)
                out["intervals"].append([enter, time.time(), round(hold, 2)])
            out["acquired"] += 1
        except RuntimeError:
            out["lock_errors"] += 1  # waited past wait_sec; not an exclusion failure by itself
        except OSError as e:
            # any other OSError escaping grounding_lock is a finding: the caller would crash here
            k = f"{type(e).__name__}:{getattr(e, 'winerror', None) or e.errno}"
            out["lock_exceptions"][k] = out["lock_exceptions"].get(k, 0) + 1
            time.sleep(0.05)
        save(a, out)


def save(a, out):
    tmp = os.path.join(a.dir, f".result-{a.worker}.tmp")
    with open(tmp, "w") as f:
        json.dump(out, f)
    os.replace(tmp, os.path.join(a.dir, f"result-{a.worker}.json"))


def report(a):
    res = [json.load(open(os.path.join(a.dir, n))) for n in sorted(os.listdir(a.dir)) if n.startswith("result-")]
    if len(res) < 2:
        print(f"BAD RUN: {len(res)} worker result(s) in {a.dir}; need at least 2 racing workers")
        return 2
    hosts = sorted({r["host"] for r in res})
    rounds = {}
    for r in res:
        for rd, outcome in r["excl"]:
            rounds.setdefault(rd, []).append(outcome)
    complete = [rd for rd, o in rounds.items() if len(o) == len(res)]
    if len(complete) < len(rounds):
        print(f"WARNING: {len(rounds) - len(complete)} arm A rounds lack a result from every worker; judged on "
              f"the {len(complete)} complete rounds only")
    bad_rounds = {rd: rounds[rd] for rd in complete
                  if rounds[rd].count("won") != 1 or any(x.startswith("error") for x in rounds[rd])}
    iv = sorted((s, e, h, r["worker"]) for r in res for s, e, h in r.get("intervals", []))
    overlaps = []
    for i, (s, e, h, w) in enumerate(iv):  # intervals are sorted by start; any later start before e overlaps
        for s2, e2, h2, w2 in iv[i + 1:]:
            if s2 >= e:
                break
            if w2 != w:
                overlaps.append((w, {"with": [w2], "hold": h, "by_s": round(min(e, e2) - s2, 3)}))
    acquired = sum(r["acquired"] for r in res)
    exc = {}
    for r in res:
        for k, v in r.get("lock_exceptions", {}).items():
            exc[k] = exc.get(k, 0) + v
    if exc:
        print(f"lock exceptions escaping grounding_lock (caller would crash): {exc}")
    print(f"workers {len(res)} on {len(hosts)} host(s): {', '.join(hosts)}")
    print(f"clock offset vs mount mtime (s): " + ", ".join(f"{r['worker']} {r['skew_sec']:+}" for r in res))
    print(f"arm A  O_EXCL: {len(rounds)} rounds, {len(bad_rounds)} bad (want exactly 1 winner, losers EEXIST)")
    for rd, o in list(bad_rounds.items())[:10]:
        print(f"   round {rd}: {o}")
    print(f"arm B  lock incl. stale-break: {acquired} acquisitions, {len(overlaps)} overlaps, "
          f"{sum(r['lock_errors'] for r in res)} wait timeouts")
    for w, o in overlaps[:10]:
        print(f"   {w} overlapped {o['with']} by {o['by_s']}s (hold {o['hold']}s)")
    if acquired == 0:
        print("BAD RUN: arm B never acquired the lock, so it proved nothing")
        return 2
    if len(hosts) < 2:
        print("NOTE: single host. This exercises processes, not separate SMB clients; run on 2+ replicas "
              "for the cross-replica answer.")
    ok = not bad_rounds and not overlaps and not exc
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dir", required=True, help="a FRESH directory on the mount under test")
    p.add_argument("--worker", help="this worker's unique id")
    p.add_argument("--start-at", type=float, help="shared epoch start time (same on every worker)")
    p.add_argument("--rounds", type=int, default=50)
    p.add_argument("--period", type=float, default=1.0, help="seconds between arm A rounds")
    p.add_argument("--duration", type=float, default=60.0, help="arm B run time, seconds")
    p.add_argument("--stale", type=float, default=2.0, help="arm B stale_sec (short, to force breaks)")
    p.add_argument("--long-frac", type=float, default=0.1, help="share of arm B holds that outlive stale_sec")
    p.add_argument("--report", action="store_true")
    p.add_argument("--local", type=int, help="smoke test: spawn N local workers, then report")
    a = p.parse_args()
    if a.report:
        sys.exit(report(a))
    if a.local:
        start = time.time() + 3
        procs = [subprocess.Popen([sys.executable, __file__, "--dir", a.dir, "--worker", f"w{i}",
                                   "--start-at", str(start), "--rounds", str(a.rounds), "--period", str(a.period),
                                   "--duration", str(a.duration), "--stale", str(a.stale),
                                   "--long-frac", str(a.long_frac)]) for i in range(a.local)]
        for pr in procs:
            pr.wait()
        sys.exit(report(a))
    if not (a.worker and a.start_at):
        sys.exit("BAD RUN: a worker needs --worker and --start-at (or use --local N / --report)")
    run_worker(a)


if __name__ == "__main__":
    main()
