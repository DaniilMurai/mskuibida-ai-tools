"""Tests for hooks/rule_guard.py. Run: python3 -m unittest discover -s plugins/rule-guard/tests"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
import rule_guard  # noqa: E402

TEAM = "# Team\n\n## Way of Working\n\n- a\n\n## Testing Posture\n\n- b\n"
PROJECT = "# Project\n\n## Forbidden\n\n## Mandated\n"


class RuleGuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        memory = os.path.join(self.root, "aidlc", "spaces", "default", "memory")
        os.makedirs(memory)
        self.write(os.path.join(memory, "team.md"), TEAM)
        self.write(os.path.join(memory, "project.md"), PROJECT)
        env = mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": self.root})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(self.tmp.cleanup)

    def write(self, path, text):
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def persist(self, *selections):
        path = os.path.join(self.root, "sel.json")
        self.write(path, json.dumps({"selections": list(selections)}))
        event = {"tool_name": "Bash", "cwd": self.root,
                 "tool_input": {"command": f"aidlc engine learnings persist --selections-json {path}"}}
        err = io.StringIO()
        with redirect_stderr(err):
            code = rule_guard.guard(event)
        return code, err.getvalue()

    def test_existing_sections_pass(self):
        code, _ = self.persist({"candidate_id": "c1", "scope": "team", "heading": "## Testing Posture"},
                               {"candidate_id": "c2", "scope": "project", "heading": "Mandated"})
        self.assertEqual(code, 0)

    def test_corrections_empty_and_unknown_headings_refused(self):
        for heading in ("Corrections", "", "Code Style"):
            code, err = self.persist({"candidate_id": "c1", "scope": "team", "heading": heading})
            self.assertEqual(code, 2, heading)
            self.assertIn("Way of Working, Testing Posture", err)

    def test_sections_follow_the_active_space(self):
        other = os.path.join(self.root, "aidlc", "spaces", "other", "memory")
        os.makedirs(other)
        self.write(os.path.join(other, "team.md"), "## Code Style\n")
        self.write(os.path.join(other, "project.md"), PROJECT)
        self.write(os.path.join(self.root, "aidlc", "active-space"), "other\n")
        self.assertEqual(self.persist({"scope": "team", "heading": "Code Style"})[0], 0)
        self.assertEqual(self.persist({"scope": "team", "heading": "Way of Working"})[0], 2)

    def test_unreadable_rule_file_refuses(self):
        os.remove(os.path.join(self.root, "aidlc", "spaces", "default", "memory", "project.md"))
        code, err = self.persist({"scope": "project", "heading": "Mandated"})
        self.assertEqual(code, 2)
        self.assertIn("cannot read project.md", err)

    def test_sensor_selections_pass(self):
        self.assertEqual(self.persist({"type": "sensor", "heading": "Corrections"})[0], 0)

    def test_wrapped_call_is_checked(self):
        path = os.path.join(self.root, "sel.json")
        self.write(path, json.dumps({"selections": [{"scope": "team", "heading": "Corrections"}]}))
        event = {"tool_name": "Bash", "cwd": self.root,
                 "tool_input": {"command": f"bash -c 'learnings persist --selections-json {path}'"}}
        with redirect_stderr(io.StringIO()):
            self.assertEqual(rule_guard.guard(event), 2)

    def test_mention_passes(self):
        event = {"tool_name": "Bash", "cwd": self.root,
                 "tool_input": {"command": "git commit -m 'run learnings persist later'"}}
        self.assertEqual(rule_guard.guard(event), 0)

    def test_edit_adding_corrections_heading_refused(self):
        path = os.path.join(self.root, "aidlc", "spaces", "default", "memory", "team.md")
        with redirect_stderr(io.StringIO()):
            self.assertEqual(rule_guard.guard({"tool_name": "Edit", "tool_input": {
                "file_path": path, "new_string": "\n## corrections\n- x\n"}}), 2)
            self.assertEqual(rule_guard.guard({"tool_name": "Edit", "tool_input": {
                "file_path": path, "new_string": "- see Corrections below\n"}}), 0)
            self.assertEqual(rule_guard.guard({"tool_name": "Write", "tool_input": {
                "file_path": os.path.join(self.root, "notes.md"), "content": "## Corrections\n"}}), 0)


if __name__ == "__main__":
    unittest.main()
