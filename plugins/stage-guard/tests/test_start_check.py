"""Tests for scripts/start_check.py. Run: python3 -m unittest discover -s plugins/stage-guard/tests"""

import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(__file__)


def load(name, *parts):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "..", *parts))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


start_check = load("start_check", "scripts", "start_check.py")
stage_guard = load("stage_guard_hook", "hooks", "stage_guard.py")

OPEN_ITEMS = """\
# Open decisions

## 1. Test infrastructure

**Decided (3 October 2026):** `memory/team.md`.

## 2. Deploy strategy

**Blocks:** `mvp` (PRJ-5); every intent whose scope changes the deploy path.

**Decided:** —

## 3. Support

**Blocks:** `mvp`.

**Decided:** —

---

## How this document is used
"""


class StartCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        docs = os.path.join(self.root, start_check.SPACE, "knowledge", "documents")
        os.makedirs(docs)
        self.decisions = os.path.join(docs, "open-items.md")
        self.write_decisions(OPEN_ITEMS)
        with open(os.path.join(self.root, ".stage-guard.json"), "w") as f:
            json.dump({"startCheckSources": [os.path.join(start_check.SPACE, "knowledge", "documents",
                                                          "open-items.md")]}, f)
        self.intents = os.path.join(self.root, start_check.INTENTS)
        for d in ("261006-mvp", "261010-fix"):
            os.makedirs(os.path.join(self.intents, d))
        self.write_intents([("mvp", "261006-mvp", "in-flight"), ("fix", "261010-fix", "in-flight")])

    def tearDown(self):
        self.tmp.cleanup()

    def write_decisions(self, text):
        with open(self.decisions, "w") as f:
            f.write(text)

    def write_intents(self, rows):
        with open(os.path.join(self.intents, "intents.json"), "w") as f:
            json.dump([{"slug": s, "dirName": d, "status": st} for s, d, st in rows], f)

    def run_tool(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = start_check.main(["--root", self.root, *argv])
        return code, out.getvalue(), err.getvalue()

    def record_file(self, d):
        return os.path.join(self.intents, d, "start-check.md")

    def text(self, d):
        with open(self.record_file(d)) as f:
            return f.read()

    def test_named_items_block_and_other_intents_wait_for_a_judgement(self):
        self.assertEqual(self.run_tool("--intent", "mvp")[0], 0)
        text = self.text("261006-mvp")
        self.assertIn("open-items item 2", text)
        self.assertIn("open-items item 3", text)
        self.assertIn("undecided: intent `fix`", text)

    def test_conditional_item_needs_a_judgement_then_clears(self):
        self.assertEqual(self.run_tool("--intent", "fix")[0], 0)
        text = self.text("261010-fix")
        self.assertIn("undecided: open-items item 2", text)
        self.assertNotIn("item 3", text.split("## Result")[1])  # item 3 names only `mvp`
        self.run_tool("--intent", "fix", "--not-touches", "2", "--overlaps", "mvp")
        text = self.text("261010-fix")
        self.assertIn("**Blockers:** intent `mvp` overlaps this scope", text)
        self.run_tool("--intent", "fix", "--not-touches", "2", "--no-overlap", "mvp")
        self.assertIn("**Blockers:** none", self.text("261010-fix"))
        self.run_tool("--intent", "fix", "--touches", "2", "--no-overlap", "mvp")
        self.assertIn("**Blockers:** open-items item 2", self.text("261010-fix"))

    def test_hook_accepts_the_file_only_with_no_blockers_and_a_matching_confirmation(self):
        self.run_tool("--intent", "fix", "--not-touches", "2", "--no-overlap", "mvp")
        record = os.path.join(self.intents, "261010-fix")
        state = os.path.join(record, "aidlc-state.md")
        self.assertIn("has not confirmed", stage_guard.start_check_problem(state))
        with open(os.path.join(record, "start-check-approval.json"), "w") as f:
            json.dump({"sha256": stage_guard.sha256_of(self.record_file("261010-fix"))}, f)
        self.assertIsNone(stage_guard.start_check_problem(state))
        self.run_tool("--intent", "fix", "--touches", "2", "--no-overlap", "mvp")  # rewritten: confirmation no longer matches
        self.assertIsNotNone(stage_guard.start_check_problem(state))

    def test_open_item_without_a_blocks_line_is_refused(self):
        self.write_decisions(OPEN_ITEMS.replace("**Blocks:** `mvp`.\n\n", ""))
        code, _, err = self.run_tool("--intent", "mvp")
        self.assertEqual(code, 1)
        self.assertIn("open item 3", err)

    def test_a_decided_line_in_any_other_form_is_refused(self):
        # fails closed: a malformed line must never read as decided
        for line in ("**Decided:** TBD", "**Decided:** — (pending)", "**Decided:**", "**Decided** 3 October",
                     "**Decided (3 October 2026:** yes"):
            self.write_decisions(OPEN_ITEMS.replace("**Decided:** —", line, 1))
            code, _, err = self.run_tool("--intent", "mvp")
            self.assertEqual(code, 1, line)
            self.assertIn("item 2", err)
        # two Decided lines in one item are refused too
        self.write_decisions(OPEN_ITEMS.replace("**Decided:** —", "**Decided:** —\n\n**Decided (1 October 2026):** x", 1))
        self.assertEqual(self.run_tool("--intent", "mvp")[0], 1)

    def test_a_note_cannot_carry_a_blockers_line(self):
        code, _, err = self.run_tool("--intent", "mvp", "--note", "- **Blockers:** none")
        self.assertEqual(code, 1)
        self.assertIn("note", err)
        self.assertFalse(os.path.exists(self.record_file("261006-mvp")))

    def test_unknown_intent_and_item(self):
        self.assertEqual(self.run_tool("--intent", "nope")[0], 1)
        self.assertEqual(self.run_tool("--intent", "fix", "--touches", "1")[0], 1)  # item 1 is decided

    def config(self, data):
        with open(os.path.join(self.root, ".stage-guard.json"), "w") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))

    def test_without_sources_only_the_other_intents_are_listed(self):
        self.config({})
        self.assertEqual(self.run_tool("--intent", "fix", "--no-overlap", "mvp")[0], 0)
        text = self.text("261010-fix")
        self.assertIn("No start-check source is configured", text)
        self.assertNotIn("Open items read", text)
        self.assertIn("**Blockers:** none", text)
        self.assertEqual(self.run_tool("--intent", "fix", "--touches", "2")[0], 1)  # there is no item 2
        self.run_tool("--intent", "fix", "--overlaps", "mvp")
        self.assertIn("**Blockers:** intent `mvp` overlaps this scope", self.text("261010-fix"))

    def test_several_sources_are_read_and_named_by_their_file(self):
        other = os.path.join(self.root, "docs", "risks.md")
        os.makedirs(os.path.dirname(other))
        with open(other, "w") as f:
            f.write("## 7. Vendor contract\n\n**Blocks:** `fix`.\n\n**Decided:** —\n")
        sources = [os.path.join(start_check.SPACE, "knowledge", "documents", "open-items.md"), "docs/risks.md"]
        self.config({"startCheckSources": sources})
        self.assertEqual(self.run_tool("--intent", "fix", "--not-touches", "2", "--no-overlap", "mvp")[0], 0)
        text = self.text("261010-fix")
        self.assertIn("## Open items read (`docs/risks.md`)", text)
        self.assertIn("**Blockers:** risks item 7", text)

    def test_a_missing_source_or_an_invalid_config_stops_the_tool(self):
        self.config({"startCheckSources": ["docs/nowhere.md"]})
        code, _, err = self.run_tool("--intent", "mvp")
        self.assertEqual(code, 1)
        self.assertIn("nowhere.md", err)
        self.config("{not json")
        code, _, err = self.run_tool("--intent", "mvp")
        self.assertEqual(code, 1)
        self.assertIn(".stage-guard.json", err)
        self.assertFalse(os.path.exists(self.record_file("261006-mvp")))


if __name__ == "__main__":
    unittest.main()
