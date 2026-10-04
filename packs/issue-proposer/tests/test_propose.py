#!/usr/bin/env python3
"""Tests for the issue-proposer skill mechanics.

Covers: fingerprint normalization, dedupe state (no duplicate proposals),
draft writing and round-trip parsing, dry-run safety (open changes nothing
without --yes), and the draft-then-open flow with a stubbed `gh`.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin")
)
import propose


class FakeGh:
    """Stub for propose.RUN_GH. Records calls, returns a fake issue URL."""

    def __init__(self, url="https://github.com/o/r/issues/42"):
        self.calls = []
        self.bodies = []
        self.url = url

    def __call__(self, args):
        self.calls.append(args)
        if args[:2] == ["issue", "create"]:
            body_file = args[args.index("--body-file") + 1]
            with open(body_file, encoding="utf-8") as f:
                self.bodies.append(f.read())
            return propose.CompletedLike(0, self.url + "\n", "")
        return propose.CompletedLike(0, "[]", "")


class ProposeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["ISSUE_PROPOSER_HOME"] = os.path.join(self.tmp.name, "home")
        self.fake_gh = FakeGh()
        self._real_gh = propose.RUN_GH
        propose.RUN_GH = self.fake_gh

    def tearDown(self):
        propose.RUN_GH = self._real_gh
        del os.environ["ISSUE_PROPOSER_HOME"]
        self.tmp.cleanup()

    # -- fingerprints ------------------------------------------------------

    def test_fingerprint_normalization(self):
        a = propose.fingerprint("o/r", "Fix the thing")
        b = propose.fingerprint("O/R", "  fix   THE thing ")
        self.assertEqual(a, b)
        c = propose.fingerprint("o/r", "Fix the other thing")
        self.assertNotEqual(a, c)
        d = propose.fingerprint("o/other", "Fix the thing")
        self.assertNotEqual(a, d)

    # -- drafts ------------------------------------------------------------

    def _body_file(self, text="Body text.\n"):
        path = os.path.join(self.tmp.name, "body.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def _draft(
        self,
        title="Add a health check endpoint",
        repo="o/r",
        kind="feature",
        based_on=("https://job.code.markets/jobs/job_1",),
    ):
        ns = propose.build_parser().parse_args(
            [
                "draft",
                repo,
                "--title",
                title,
                "--body-file",
                self._body_file(),
                "--kind",
                kind,
                "--based-on",
                *based_on,
            ]
        )
        ns.func(ns)

    def test_draft_round_trip(self):
        self._draft()
        paths = propose.list_drafts()
        self.assertEqual(len(paths), 1)
        meta, body = propose.read_draft(paths[0])
        self.assertEqual(meta["repo"], "o/r")
        self.assertEqual(meta["title"], "Add a health check endpoint")
        self.assertEqual(meta["kind"], "feature")
        self.assertEqual(meta["based_on"], ["https://job.code.markets/jobs/job_1"])
        self.assertIn("Body text.", body)

    def test_draft_rejects_bad_repo(self):
        ns = propose.build_parser().parse_args(
            ["draft", "not-a-slug", "--title", "T", "--body-file", self._body_file()]
        )
        with self.assertRaises(SystemExit):
            ns.func(ns)

    def test_draft_rejects_bad_kind(self):
        with self.assertRaises(SystemExit):
            ns = propose.build_parser().parse_args(
                [
                    "draft",
                    "o/r",
                    "--title",
                    "T",
                    "--body-file",
                    self._body_file(),
                    "--kind",
                    "epic",
                ]
            )
            ns.func(ns)

    def test_draft_rejects_duplicate_title(self):
        self._draft()
        with self.assertRaises(SystemExit):
            self._draft()

    # -- open: dry run ------------------------------------------------------

    def test_open_dry_run_changes_nothing(self):
        self._draft()
        ns = propose.build_parser().parse_args(["open"])
        ns.func(ns)
        creates = [c for c in self.fake_gh.calls if c[:2] == ["issue", "create"]]
        self.assertEqual(creates, [])
        state = propose.load_state()
        self.assertEqual(state["proposed"], {})

    # -- open: real flow with dedupe ---------------------------------------

    def test_open_yes_records_state_and_dedupes(self):
        self._draft()
        ns = propose.build_parser().parse_args(["open", "--yes"])
        ns.func(ns)
        creates = [c for c in self.fake_gh.calls if c[:2] == ["issue", "create"]]
        self.assertEqual(len(creates), 1)
        create = creates[0]
        self.assertIn("o/r", create)
        state = propose.load_state()
        self.assertEqual(len(state["proposed"]), 1)
        entry = next(iter(state["proposed"].values()))
        self.assertEqual(entry["repo"], "o/r")
        self.assertEqual(entry["issue_url"], "https://github.com/o/r/issues/42")

        # Second run skips the already-proposed draft.
        ns2 = propose.build_parser().parse_args(["open", "--yes"])
        ns2.func(ns2)
        creates2 = [c for c in self.fake_gh.calls if c[:2] == ["issue", "create"]]
        self.assertEqual(len(creates2), 1)

    def test_draft_refused_when_already_proposed(self):
        self._draft()
        ns = propose.build_parser().parse_args(["open", "--yes"])
        ns.func(ns)
        with self.assertRaises(SystemExit):
            self._draft()

    def test_opened_issue_body_has_grounding(self):
        self._draft(based_on=("https://github.com/o/r/issues/3",))
        ns = propose.build_parser().parse_args(["open", "--yes"])
        ns.func(ns)
        body = self.fake_gh.bodies[-1]
        self.assertIn("Grounded in", body)
        self.assertIn("https://github.com/o/r/issues/3", body)
        self.assertIn("unpaid", body)

    # -- discovery -----------------------------------------------------------

    def test_my_name_resolves_via_leaderboard(self):
        real_call = propose.call

        def fake_call(method, path, body=None):
            assert path.startswith("/v1/leaderboard")
            return {
                "leaderboard": [
                    {"github": "someoneelse", "name": "SomeoneElse"},
                    {"github": "ZuckbotAI", "name": "Zuckbot"},
                ]
            }

        propose.call = fake_call

        def fake_gh_login(args):
            assert args == ["api", "user", "--jq", ".login"]
            return propose.CompletedLike(0, "ZuckbotAI\n", "")

        propose.RUN_GH = fake_gh_login
        try:
            self.assertEqual(propose.my_name(), "Zuckbot")
            self.assertEqual(propose.my_name(agent_name="Override"), "Override")
        finally:
            propose.call = real_call
            propose.RUN_GH = self.fake_gh

    def test_my_name_unknown_login_exits(self):
        real_call = propose.call
        propose.call = lambda m, p, b=None: {"leaderboard": []}
        propose.RUN_GH = lambda args: propose.CompletedLike(0, "nobody\n", "")
        try:
            with self.assertRaises(SystemExit):
                propose.my_name()
        finally:
            propose.call = real_call
            propose.RUN_GH = self.fake_gh

    # -- state --------------------------------------------------------------

    def test_state_round_trip(self):
        state = {
            "proposed": {
                "abc": {
                    "repo": "o/r",
                    "title": "T",
                    "issue_url": "https://x",
                    "opened_at": "2026-01-01",
                }
            }
        }
        propose.save_state(state)
        loaded = propose.load_state()
        self.assertEqual(loaded, state)
        self.assertTrue(propose.already_proposed(loaded, "abc"))
        self.assertFalse(propose.already_proposed(loaded, "zzz"))

    def test_status_runs(self):
        ns = propose.build_parser().parse_args(["status"])
        ns.func(ns)  # must not raise on empty state


if __name__ == "__main__":
    unittest.main()
