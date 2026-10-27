"""Tests for paid_batch_runner's failed-run spend booking (t/4507). No AI calls, no spend.

Each case patches run_cli to fake a CLI outcome, runs main() for one debate, and checks the ledger row.
Run: python research/comp-linguist/scripts/paid_batch_runner_test.py   (from the repo root)
"""
import json, os, subprocess, sys, tempfile, time, unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paid_batch_runner as pbr  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
USAGE = ('[usage] {"ts":"2026-10-26T13:54:29.023Z","backend":"gemini","model":"gemini-3.5-flash-lite",'
         '"modelId":"gemini-3.5-flash-lite","latencyMs":3993,"promptTokens":9070,"completionTokens":997,'
         '"totalTokens":10067}')
RESERVE = 0.6


class RunnerCase(unittest.TestCase):
    """Shared fixture: a one-debate plan, a ledger, and run_one() with a faked CLI. No tests of its own."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out)
        self.plan = os.path.join(self.tmp, "plan.json")
        self.ledger = os.path.join(self.tmp, "ledger.json")
        self.write(self.plan, {"name": "t", "output_dir": self.out, "approval_ref": "t/4507#2",
                               "base_config": {"model": "gemini-3.5-flash-lite"}, "expected_pins": {},
                               "debates": [{"slug": "s1"}]})

    @staticmethod
    def write(path, obj):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)

    def run_one(self, rc, output, partial=None, partial_before_run=False, slug="s1"):
        partial_path = os.path.join(self.out, "s1-partial.json")
        if partial is not None and partial_before_run:
            self.write(partial_path, partial)

        def fake(cmd, cwd, timeout):
            if partial is not None and not partial_before_run:
                self.write(partial_path, partial)
            return rc, output

        argv = ["pbr", "--plan", self.plan, "--ledger", self.ledger, "--code-root", REPO,
                "--budget", "25", "--max-debates", "50", "--reserve", str(RESERVE)]
        with mock.patch.object(pbr, "run_cli", fake), mock.patch.object(sys, "argv", argv):
            self.assertEqual(pbr.main(), 4)
        with open(self.ledger, encoding="utf-8") as fh:
            return json.load(fh)["debates"][-1]


class FailedRunBooking(RunnerCase):
    def test_usage_lines_without_recorder_book_at_least_reserve(self):
        # The attempt-3 shape: killed mid-opening, paid calls visible only in the output.
        row = self.run_one(1, "noise\n" + USAGE + "\n" + USAGE + "\n")
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["calls"], 2)
        self.assertGreaterEqual(row["usd"], RESERVE)

    def test_stale_partial_from_earlier_attempt_is_not_zero_spend_evidence(self):
        # The attempt-2/3 shape: a 0/0/0 partial left by an EARLIER attempt. It is set aside, so it can't
        # prove zero; with no usage lines and no fresh partial the run is still provably zero only if
        # nothing ran. Here the output shows a call, so it must be booked.
        row = self.run_one(1, USAGE, partial={"transcript": [], "diagnostics": {"overview": {
            "total_ai_calls": 0, "total_input_tokens": 0}}}, partial_before_run=True)
        self.assertGreaterEqual(row["usd"], RESERVE)
        self.assertTrue(os.path.isdir(os.path.join(self.out, "_attempts")), "stale partial must be set aside")
        self.assertFalse(os.path.exists(os.path.join(self.out, "s1-partial.json")))

    def test_timeout_is_never_booked_zero(self):
        row = self.run_one("timeout", "")
        self.assertEqual(row["rc"], "timeout")
        self.assertGreaterEqual(row["usd"], RESERVE)

    def test_proven_zero_spend_books_zero(self):
        # No usage line, not a timeout, and this attempt's own partial agrees on 0/0/0.
        row = self.run_one(1, "startup failed before any call\n", partial={"transcript": [], "diagnostics": {
            "overview": {"total_ai_calls": 0, "total_input_tokens": 0}}})
        self.assertEqual(row["usd"], 0.0)

    def test_fresh_partial_with_tokens_books_reserve(self):
        # t3790a32 shape: total_ai_calls 0 but tokens and turns present.
        row = self.run_one(1, "", partial={"transcript": [{}] * 14, "diagnostics": {
            "overview": {"total_ai_calls": 0, "total_input_tokens": 583910}}})
        self.assertGreaterEqual(row["usd"], RESERVE)


class ResumeSafety(RunnerCase):
    """Stop and resume (t/4507): one runner per ledger, and a dead runner's in-flight row is labelled."""

    def argv(self):
        return ["pbr", "--plan", self.plan, "--ledger", self.ledger, "--code-root", REPO,
                "--budget", "25", "--max-debates", "50", "--reserve", str(RESERVE)]

    def test_live_lock_refuses_a_second_runner(self):
        self.write(self.ledger + ".lock", {"pid": os.getpid()})  # this test process is alive
        ran = []
        with mock.patch.object(pbr, "run_cli", lambda *x: ran.append(x) or (0, "")), \
                mock.patch.object(sys, "argv", self.argv()):
            self.assertEqual(pbr.main(), 6)
        self.assertEqual(ran, [], "no debate may start while another runner holds the lock")
        self.assertTrue(os.path.exists(self.ledger + ".lock"), "the live holder's lock must be left alone")

    def test_dead_runner_lock_is_taken_over_and_inflight_marked_interrupted(self):
        dead = subprocess.Popen([sys.executable, "-c", "pass"]); dead.wait()  # a pid that has exited
        self.write(self.ledger + ".lock", {"pid": dead.pid})
        self.write(self.ledger, {"budget": 25.0, "max_debates": 50, "debates": [
            {"plan": "t", "slug": "s1", "usd": RESERVE, "status": "in-flight"}]})
        row = self.run_one(1, "")  # resumes, re-runs s1, fails (no spend proven? no usage, no partial -> 0)
        with open(self.ledger, encoding="utf-8") as fh:
            rows = json.load(fh)["debates"]
        self.assertEqual(rows[0]["status"], "interrupted")
        self.assertEqual(rows[0]["usd"], RESERVE, "an interrupted debate keeps its reserve")
        self.assertEqual(row["status"], "failed")
        self.assertFalse(os.path.exists(self.ledger + ".lock"), "the lock is released on exit")

    def test_lock_released_after_a_normal_run(self):
        self.run_one(1, USAGE)
        self.assertFalse(os.path.exists(self.ledger + ".lock"))


class SlugGuard(unittest.TestCase):
    def test_unsafe_slug_is_refused_before_any_run(self):
        tmp = tempfile.mkdtemp()
        plan, ledger = os.path.join(tmp, "plan.json"), os.path.join(tmp, "ledger.json")
        RunnerCase.write(plan, {"name": "t", "output_dir": tmp, "approval_ref": "t/4507#2",
                                      "base_config": {}, "expected_pins": {}, "debates": [{"slug": "a&calc"}]})
        argv = ["pbr", "--plan", plan, "--ledger", ledger, "--code-root", REPO, "--budget", "25"]
        ran = []
        with mock.patch.object(pbr, "run_cli", lambda *a: ran.append(a) or (0, "")), \
                mock.patch.object(sys, "argv", argv):
            self.assertEqual(pbr.main(), 3)
        self.assertEqual(ran, [], "the CLI must not be invoked for an unsafe slug")


class TreeKill(unittest.TestCase):
    def test_timeout_kills_the_child_process_tree(self):
        # A grandchild that would outlive a plain shell kill: the shell starts python, which sleeps.
        marker = f"pbr-treekill-{os.getpid()}-{int(time.time())}"
        cmd = [sys.executable, "-c", f"import time; time.sleep(60)  # {marker}"]
        t0 = time.time()
        rc, _ = pbr.run_cli(cmd, os.getcwd(), timeout=2)
        self.assertEqual(rc, "timeout")
        self.assertLess(time.time() - t0, 30, "timeout must not wait for the child to finish")
        time.sleep(1)
        if os.name == "nt":
            ps = subprocess.run(["powershell", "-NoProfile", "-Command",
                                 f"@(Get-CimInstance Win32_Process | ? {{ $_.CommandLine -like '*{marker}*' -and $_.Name -like 'python*' }}).Count"],
                                capture_output=True, text=True)
            self.assertEqual(ps.stdout.strip(), "0", "the sleeping child must be killed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
