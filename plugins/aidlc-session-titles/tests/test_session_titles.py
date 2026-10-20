"""Tests for hooks/session_titles.py and hooks/hooks.json.
Run: python3 -m unittest discover -s plugins/aidlc-session-titles/tests

The hook runs as a subprocess, as the harness runs it, with AIDLC_SESSION_TITLES_DIR pointing into a temporary folder
and the event's cwd at a project built in that folder. No `aidlc` binary is needed: the hook reads the project's files
and the commands the assistant ran."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
HOOK = os.path.join(PLUGIN, "hooks", "session_titles.py")
SID = "11111111-2222-3333-4444-555555555555"
INTENT = "261016-daily-page"
UUID = "01a145a3-19be-716a-8b04-32b5dc65032d"
RENAME = "mcp__ccd_session_mgmt__set_session_title"

GRAPH = [
    {"slug": "requirements-analysis", "name": "Requirements Analysis", "phase": "inception"},
    {"slug": "units-generation", "name": "Units Generation", "phase": "inception"},
    {"slug": "functional-design", "name": "Functional Design", "phase": "construction"},
    {"slug": "build-and-test", "name": "Build and Test", "phase": "construction"},
]


def state_md(current, unit_stage="", active_unit=""):
    lines = ["# AI-DLC State Tracking", "", "## Current Status", f"- **Current Stage**: {current}", ""]
    if active_unit:
        lines.append(f"- **Active Unit**: {active_unit}")
    if unit_stage:
        lines.append(f"- **Unit Stage**: {unit_stage}")
    lines += ["", "## Stage Progress", "", "### INCEPTION PHASE", "- [x] requirements-analysis — EXECUTE",
              "- [x] units-generation — EXECUTE", "", "### CONSTRUCTION PHASE", "- [-] functional-design — EXECUTE",
              "- [ ] build-and-test — EXECUTE", "- [ ] code-review-sweep — EXECUTE", ""]
    return "\n".join(lines)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.project = os.path.join(self.root, "project")
        self.states = os.path.join(self.root, "states")
        self.intents = os.path.join(self.project, "aidlc", "spaces", "default", "intents")
        self.intent_dir = os.path.join(self.intents, INTENT)
        os.makedirs(os.path.join(self.intent_dir, ".aidlc-engine"))
        self.write("aidlc/active-space", "default\n")
        self.write(os.path.join("aidlc/spaces/default/intents", "active-intent"), INTENT + "\n")
        self.write("aidlc/spaces/default/intents/intents.json", json.dumps([{"dirName": INTENT, "uuid": UUID}]))
        self.write(".claude/tools/data/stage-graph.json", json.dumps(GRAPH))
        self.set_state("requirements-analysis")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel, text):
        path = os.path.join(self.project, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def set_state(self, current, **kw):
        path = self.write(os.path.relpath(os.path.join(self.intent_dir, "aidlc-state.md"), self.project),
                          state_md(current, **kw))
        later = time.time() + 5
        os.utime(path, (later, later))  # newer than any directive written earlier in the test

    def set_directive(self, stage, unit=None, newer=True):
        body = {"version": 2, "stage": stage}
        if unit:
            body["unit"] = unit
        path = os.path.join(self.intent_dir, ".aidlc-engine", "active-directive.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(body, f)
        at = time.time() + (60 if newer else -60)
        os.utime(path, (at, at))

    def claim(self, unit, uuid=UUID):
        self.write("aidlc/.aidlc-unit-scope.json", json.dumps({"space": "default", "intent_uuid": uuid, "unit": unit}))

    def bind(self):
        self.write(f"aidlc/.aidlc-sessions/{SID}.binding.json",
                   json.dumps({"space": "default", "intent": INTENT, "boundAt": "2026-10-20T00:00:00Z"}))

    def run_hook(self, event, desktop=True):
        event = {"session_id": SID, "cwd": self.project, **event}
        env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_PROJECT_DIR", "CLAUDE_CODE_ENTRYPOINT")}
        env["AIDLC_SESSION_TITLES_DIR"] = self.states
        if desktop:
            env["CLAUDE_CODE_ENTRYPOINT"] = "claude-desktop"
        done = subprocess.run([sys.executable, HOOK], input=json.dumps(event), capture_output=True, text=True,
                              env=env, cwd=self.root, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout) if done.stdout.strip() else None

    def prompt(self, text="go on", desktop=True):
        return self.run_hook({"hook_event_name": "UserPromptSubmit", "prompt": text}, desktop)

    def bash(self, command="aidlc engine orchestrate next"):
        return self.run_hook({"hook_event_name": "PostToolUse", "tool_name": "Bash",
                              "tool_input": {"command": command}, "tool_response": {"stdout": ""}})

    def renamed(self, title, response="Session renamed.", failure=False):
        return self.run_hook({"hook_event_name": "PostToolUseFailure" if failure else "PostToolUse",
                              "tool_name": RENAME, "tool_input": {"session_id": "self", "title": title},
                              "tool_response": response})

    def stop(self, active=False):
        return self.run_hook({"hook_event_name": "Stop", "stop_hook_active": active})

    @staticmethod
    def title_of(out):
        return (out or {}).get("hookSpecificOutput", {}).get("sessionTitle")

    @staticmethod
    def context_of(out):
        return (out or {}).get("hookSpecificOutput", {}).get("additionalContext") or ""


class TitleTests(Base):
    """What the title says, read through the prompt hook of a session that runs the workflow."""

    def title(self):
        self.bind()
        return self.title_of(self.prompt())

    def test_phase_and_stage_from_the_graph(self):
        self.assertEqual(self.title(), "Inception — Requirements Analysis")

    def test_claimed_unit_on_a_per_unit_stage(self):
        self.set_state("functional-design")
        self.claim("u4-day-navigation")
        self.assertEqual(self.title(), "u4-day-navigation — Functional Design")

    def test_unit_stage_and_active_unit_from_the_state(self):
        self.set_state("units-generation", unit_stage="functional-design", active_unit="u5-live-updates")
        self.assertEqual(self.title(), "u5-live-updates — Functional Design")

    def test_claim_wins_over_the_shared_active_unit(self):
        self.set_state("units-generation", unit_stage="functional-design", active_unit="u5-live-updates")
        self.claim("u2-blocks")
        self.assertEqual(self.title(), "u2-blocks — Functional Design")

    def test_claim_of_another_intent_is_ignored(self):
        self.set_state("functional-design")
        self.claim("u2-blocks", uuid="ffffffff-0000-0000-0000-000000000000")
        self.assertEqual(self.title(), "Construction — Functional Design")

    def test_construction_stage_not_per_unit_names_the_phase(self):
        self.set_state("build-and-test")
        self.claim("u2-blocks")
        self.assertEqual(self.title(), "Construction — Build and Test")

    def test_newer_directive_with_its_unit(self):
        self.set_directive("functional-design", unit="u3-notes")
        self.assertEqual(self.title(), "u3-notes — Functional Design")

    def test_older_directive_is_ignored(self):
        self.set_directive("functional-design", unit="u3-notes", newer=False)
        self.assertEqual(self.title(), "Inception — Requirements Analysis")

    def test_stage_missing_from_the_graph_uses_the_state_heading(self):
        self.set_state("code-review-sweep")
        self.assertEqual(self.title(), "Construction — Code Review Sweep")

    def test_lone_intent_without_a_cursor(self):
        os.remove(os.path.join(self.intents, "active-intent"))
        self.assertEqual(self.title(), "Inception — Requirements Analysis")

    def test_no_title_without_a_stage(self):
        self.write(os.path.relpath(os.path.join(self.intent_dir, "aidlc-state.md"), self.project), "# empty\n")
        self.assertIsNone(self.title())


class SessionTests(Base):
    """When the hook acts, and how often."""

    def test_session_not_running_the_workflow_is_left_alone(self):
        self.assertIsNone(self.prompt())
        self.assertIsNone(self.bash("ls aidlc/spaces && cat aidlc/active-space"))
        self.assertIsNone(self.stop())

    def test_aidlc_command_prompt_marks_the_session(self):
        self.assertEqual(self.title_of(self.prompt("/aidlc next")), "Inception — Requirements Analysis")

    def test_engine_call_asks_for_the_rename_once(self):
        out = self.bash()
        self.assertIn('"title": "Inception — Requirements Analysis"', self.context_of(out))
        self.assertIsNone(self.bash())  # asked already

    def test_aidlc_skill_marks_the_session(self):
        out = self.run_hook({"hook_event_name": "PostToolUse", "tool_name": "Skill",
                             "tool_input": {"skill": "aidlc-functional-design"}})
        self.assertIn(RENAME, self.context_of(out))

    def test_stage_change_asks_again(self):
        self.bash()
        self.renamed("Inception — Requirements Analysis")
        self.assertIsNone(self.bash())
        self.set_state("functional-design")
        self.claim("u1-core")
        self.assertIn('"u1-core — Functional Design"', self.context_of(self.bash()))

    def test_prompt_emits_only_on_change(self):
        self.bind()
        self.assertEqual(self.title_of(self.prompt()), "Inception — Requirements Analysis")
        self.assertIsNone(self.prompt())
        self.set_state("units-generation")
        self.assertEqual(self.title_of(self.prompt()), "Inception — Units Generation")

    def test_stop_blocks_once_while_behind(self):
        self.bash()
        out = self.stop()
        self.assertEqual(out["decision"], "block")
        self.assertIn(RENAME, out["reason"])
        self.assertIsNone(self.stop())

    def test_stop_lets_go_when_renamed(self):
        self.bash()
        self.renamed("Inception — Requirements Analysis")
        self.assertIsNone(self.stop())

    def test_stop_respects_stop_hook_active(self):
        self.bash()
        self.assertIsNone(self.stop(active=True))

    def test_declined_rename_is_not_asked_again(self):
        self.bash()
        self.renamed("Inception — Requirements Analysis", response="The user declined the new title.")
        self.assertIsNone(self.bash())
        self.assertIsNone(self.stop())

    def test_failed_rename_is_not_asked_again(self):
        self.bash()
        self.renamed("Inception — Requirements Analysis", response="boom", failure=True)
        self.assertIsNone(self.stop())

    def test_unit_named_error_is_a_success(self):
        self.set_state("functional-design")
        self.claim("u3-error-pages")
        self.bash()
        self.renamed("u3-error-pages — Functional Design", response="Renamed to u3-error-pages — Functional Design")
        self.assertIsNone(self.stop())

    def test_outside_the_desktop_app_only_the_harness_title(self):
        self.bind()
        self.assertEqual(self.title_of(self.prompt(desktop=False)), "Inception — Requirements Analysis")
        out = self.run_hook({"hook_event_name": "Stop"}, desktop=False)
        self.assertIsNone(out)

    def test_subagent_is_left_alone(self):
        self.assertIsNone(self.run_hook({"hook_event_name": "PostToolUse", "tool_name": "Bash", "agent_id": "a1",
                                         "tool_input": {"command": "aidlc engine orchestrate next"}}))

    def test_outside_a_project_does_nothing(self):
        out = self.run_hook({"hook_event_name": "UserPromptSubmit", "prompt": "/aidlc", "cwd": self.root})
        self.assertIsNone(out)

    def test_garbage_stdin_is_ignored(self):
        done = subprocess.run([sys.executable, HOOK], input="not json", capture_output=True, text=True, timeout=30)
        self.assertEqual((done.returncode, done.stdout), (0, ""))


class ManifestTests(unittest.TestCase):
    def test_hooks_json_runs_the_script_on_each_event(self):
        with open(os.path.join(PLUGIN, "hooks", "hooks.json"), encoding="utf-8") as f:
            hooks = json.load(f)["hooks"]
        self.assertEqual(set(hooks), {"SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Stop"})
        for groups in hooks.values():
            for group in groups:
                for hook in group["hooks"]:
                    self.assertIn("hooks/session_titles.py", hook["command"])
        self.assertIn(RENAME, hooks["PostToolUse"][0]["matcher"])


if __name__ == "__main__":
    unittest.main()
