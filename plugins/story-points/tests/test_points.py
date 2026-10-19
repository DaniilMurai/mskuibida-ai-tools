"""Tests for scripts/points.py and hooks/story_point_guard.py.
Run: python3 -m unittest discover -s plugins/story-points/tests"""

import contextlib
import importlib.util
import io
import json
import os
import re
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(__file__)
os.environ.pop("CLAUDE_PROJECT_DIR", None)  # the tests name their project root themselves


def load(name, *parts):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "..", *parts))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


points = load("points", "scripts", "points.py")
guard = load("story_point_guard", "hooks", "story_point_guard.py")

CSV = """\
# Story points per Unit. Fibonacci 1, 2, 3, 5, 8; never above 8 (a bigger one is split).
# source: ai = an assistant's suggestion, human = the developers' estimate (the Jira story-point field).
unit,points,source
U1,8,ai
U2,3,ai
U3,5,human
U5,2,ai
"""

FIELD = "customfield_10016"
CONFIG = {
    "scale": [1, 2, 3, 5, 8],
    "tracker": {"type": "jira", "server": "jira", "site": "example.atlassian.net", "project": "PRJ",
                "issueType": "Unit", "field": FIELD, "fieldName": "Story point estimate"},
}
NO_TRACKER = {"scale": [1, 2, 3, 5, 8]}


def page(*issues, more=False):
    """A searchJiraIssuesUsingJql response as the connector returns it."""
    return {
        "issues": {
            "nodes": [
                {"key": key, "fields": {"summary": summary, FIELD: value[0] if isinstance(value, tuple) else value,
                                        "parent": {"key": value[1]} if isinstance(value, tuple) else None}}
                for key, summary, value in issues
            ],
            "pageInfo": {"hasNextPage": more, "endCursor": "x" if more else None},
        }
    }


class Workspace:
    """A throwaway workspace checkout with one intent record and, by default, a Jira-configured project."""

    def __init__(self, text=CSV, cursor=True, config=CONFIG):
        self.tmp = tempfile.TemporaryDirectory()
        self.top = self.tmp.name
        subprocess.run(["git", "init", "-q", self.top], check=True)
        intents = os.path.join(self.top, "aidlc", "spaces", "default", "intents")
        self.record = os.path.join(intents, "261006-demo-mvp-restart")
        os.makedirs(self.record)
        with open(os.path.join(intents, "intents.json"), "w") as f:
            json.dump([{"slug": "demo-mvp", "dirName": "261002-demo-mvp-2", "status": "archived"},
                       {"slug": "demo-mvp-restart", "dirName": "261006-demo-mvp-restart",
                        "status": "in-flight"}], f)
        if cursor:
            with open(os.path.join(intents, "active-intent"), "w") as f:
                f.write("261006-demo-mvp-restart\n")
        self.path = os.path.join(self.record, "unit-points.csv")
        self.config_path = os.path.join(self.top, ".story-points.json")
        if isinstance(config, str):  # raw text, for a broken file
            with open(self.config_path, "w") as f:
                f.write(config)
        elif config is not None:
            with open(self.config_path, "w") as f:
                json.dump(config, f)
        if text is not None:
            with open(self.path, "w") as f:
                f.write(text)

    def run(self, *argv, issues=None):
        args = list(argv)
        if issues is not None:
            saved = os.path.join(self.top, "issues.json")
            with open(saved, "w") as f:
                json.dump(issues, f)
            args += ["--issues", saved]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = points.main(args, cwd=self.top)
        return code, out.getvalue(), err.getvalue()

    def text(self):
        with open(self.path) as f:
            return f.read()

    def publish(self):
        """Commit the file as it is and make that commit `origin/main`, as a merged sync would."""
        git = ["git", "-C", self.top, "-c", "user.name=t", "-c", "user.email=t@example.com"]
        subprocess.run(git + ["add", "-A"], check=True)
        subprocess.run(git + ["commit", "-q", "-m", "points"], check=True)
        subprocess.run(git + ["update-ref", "refs/remotes/origin/main", "HEAD"], check=True)

    def close(self):
        self.tmp.cleanup()


class ApplyTest(unittest.TestCase):
    def setUp(self):
        self.ws = Workspace()

    def tearDown(self):
        self.ws.close()

    def test_default_rechecks_every_unit_and_keeps_the_rest_byte_for_byte(self):
        issues = [page(("PRJ-130", "U1 api-shell — the shell", 5), ("PRJ-131", "U2 web-sdk — the SDK", None),
                       more=True),
                  page(("PRJ-132", "U3 api-seed — the seed", 5), ("PRJ-140", "U12 api-x — added", 3))]
        code, out, _ = self.ws.run("apply", issues=issues)
        self.assertEqual(code, 0, out)
        lines = self.ws.text().splitlines()
        self.assertEqual(lines[:3], CSV.splitlines()[:3])
        self.assertEqual(lines[3:], ["U1,5,human", "U2,3,ai", "U3,5,human", "U5,2,ai", "U12,3,human"])
        self.assertIn("U1 8 ai -> 5 human (PRJ-130)", out)
        self.assertIn("U2 (PRJ-131)", out)  # empty in Jira
        self.assertIn("U5", out.split("no open Jira issue")[1])

    def test_empty_points_leave_the_row_as_it_is(self):
        code, out, _ = self.ws.run("apply", issues=[page(("PRJ-130", "U1 api-shell — x", None))])
        self.assertEqual(code, 0)
        self.assertEqual(self.ws.text(), CSV)
        self.assertIn("nothing to write", out)

    def test_named_units_only(self):
        issues = [page(("PRJ-130", "U1 a — x", 2), ("PRJ-131", "U2 b — x", 1), ("PRJ-134", "U4 d — x", 5))]
        code, _, _ = self.ws.run("apply", "u2", "4", issues=issues)
        self.assertEqual(code, 0)
        self.assertEqual(self.ws.text().splitlines()[3:], ["U1,8,ai", "U2,1,human", "U3,5,human", "U4,5,human", "U5,2,ai"])

    def test_source_filter(self):
        issues = [page(("PRJ-130", "U1 a — x", 2), ("PRJ-132", "U3 c — x", 8), ("PRJ-135", "U5 e — x", 3))]
        code, _, _ = self.ws.run("apply", "--source", "ai", issues=issues)
        self.assertEqual(code, 0)
        self.assertEqual(self.ws.text().splitlines()[3:], ["U1,2,human", "U2,3,ai", "U3,5,human", "U5,3,human"])

    def test_source_filter_with_units(self):
        issues = [page(("PRJ-130", "U1 a — x", 2), ("PRJ-132", "U3 c — x", 8), ("PRJ-135", "U5 e — x", 3))]
        self.ws.run("apply", "--source", "ai", "U3", "U5", issues=issues)
        self.assertEqual(self.ws.text().splitlines()[3:], ["U1,8,ai", "U2,3,ai", "U3,5,human", "U5,3,human"])

    def test_dry_run_writes_nothing(self):
        code, out, _ = self.ws.run("apply", "--dry-run", issues=[page(("PRJ-130", "U1 a — x", 3))])
        self.assertEqual(code, 0)
        self.assertEqual(self.ws.text(), CSV)
        self.assertIn("would change", out)

    def test_two_issues_for_one_unit_are_left_for_a_person(self):
        code, out, _ = self.ws.run("apply", issues=[page(("PRJ-130", "U1 a — x", 3), ("PRJ-150", "U1 a — y", 5))])
        self.assertEqual(code, 1)
        self.assertEqual(self.ws.text(), CSV)
        self.assertIn("PRJ-130, PRJ-150", out)

    def test_off_scale_is_written_and_reported(self):
        code, out, _ = self.ws.run("apply", issues=[page(("PRJ-130", "U1 a — x", 13.0))])
        self.assertEqual(code, 1)
        self.assertIn("U1,13,human", self.ws.text())
        self.assertIn("split", out)

    def test_bad_points_are_left_for_a_person(self):
        code, _, _ = self.ws.run("apply", issues=[page(("PRJ-130", "U1 a — x", "lots"), ("PRJ-131", "U2 b — x", 0))])
        self.assertEqual(code, 1)
        self.assertEqual(self.ws.text(), CSV)

    def test_summaries_that_are_not_units_are_ignored(self):
        code, _, _ = self.ws.run("apply", issues=[page(("PRJ-123", "pr-review: U1 summary", 3), ("PRJ-200", "U10x — no", 2))])
        self.assertEqual(code, 0)
        self.assertEqual(self.ws.text(), CSV)

    def test_flat_issue_list_and_custom_fields_shape(self):
        flat = [{"key": "PRJ-130", "summary": "U1 a — x", "points": 3},
                {"key": "PRJ-131", "fields": {"summary": "U2 b — x", "customFields": {FIELD: 2}}}]
        self.ws.run("apply", issues=flat)
        self.assertEqual(self.ws.text().splitlines()[3:5], ["U1,3,human", "U2,2,human"])

    def test_already_human_is_unchanged(self):
        code, out, _ = self.ws.run("apply", issues=[page(("PRJ-132", "U3 c — x", 5))])
        self.assertEqual(code, 0)
        self.assertEqual(self.ws.text(), CSV)
        self.assertIn("already the developers' estimate", out)

    def test_duplicate_rows_update_the_last_and_ask_for_a_look(self):
        self.ws.close()
        self.ws = Workspace(CSV + "U1,5,ai\n")
        code, out, _ = self.ws.run("apply", "U1", issues=[page(("PRJ-130", "U1 a — x", 3))])
        self.assertEqual(code, 1)
        self.assertEqual(self.ws.text().splitlines()[3], "U1,8,ai")
        self.assertEqual(self.ws.text().splitlines()[-1], "U1,3,human")
        self.assertIn("2 rows", out)


class HeaderlessTest(unittest.TestCase):
    def test_a_file_without_the_header(self):
        ws = Workspace("U1,8,ai\nU3,5,human\n")
        try:
            code, _, _ = ws.run("apply", issues=[page(("PRJ-130", "U1 a — x", 2), ("PRJ-132", "U2 b — x", 3))])
            self.assertEqual(code, 0)
            self.assertEqual(ws.text(), "U1,2,human\nU2,3,human\nU3,5,human\n")
        finally:
            ws.close()


class PlanTest(unittest.TestCase):
    def test_plan_lists_units_and_the_query(self):
        ws = Workspace()
        try:
            code, out, _ = ws.run("plan", "--source", "ai")
            self.assertEqual(code, 0)
            plan = json.loads(out)
            self.assertEqual(plan["units"], ["U1", "U2", "U5"])
            self.assertEqual(plan["field"], FIELD)
            self.assertIn('issuetype = "Unit"', plan["jql"])
            self.assertIn("statusCategory != Done", plan["jql"])
        finally:
            ws.close()

    def test_without_cursor_the_one_intent_in_flight(self):
        ws = Workspace(cursor=False)
        try:
            code, out, _ = ws.run("plan")
            self.assertEqual(code, 0)
            self.assertIn("261006-demo-mvp-restart", json.loads(out)["file"])
        finally:
            ws.close()

    def test_missing_file_and_bad_unit(self):
        ws = Workspace(text=None)
        try:
            self.assertEqual(ws.run("plan")[0], 2)
        finally:
            ws.close()
        ws = Workspace()
        try:
            code, _, err = ws.run("plan", "X7")
            self.assertEqual(code, 2)
            self.assertIn("not a Unit id", err)
        finally:
            ws.close()


class ClaimTest(unittest.TestCase):
    """Before a Unit is claimed: estimated and synced; the rest of its epic estimated, or approval."""

    def setUp(self):
        self.ws = Workspace()

    def tearDown(self):
        self.ws.close()

    def test_estimated_and_synced_with_a_fully_estimated_epic(self):
        self.ws.publish()
        issues = [page(("PRJ-132", "U3 c — x", (5, "PRJ-100")), ("PRJ-131", "U2 b — x", (3, "PRJ-100")),
                       ("PRJ-135", "U5 e — x", (None, "PRJ-101")))]
        code, out, _ = self.ws.run("claim", "U3", issues=issues)
        self.assertEqual(code, 0, out)
        self.assertIn("every other Unit of epic PRJ-100 is estimated", out)

    def test_blocked_without_an_estimate(self):
        self.ws.publish()
        code, out, _ = self.ws.run("claim", "U1", issues=[page(("PRJ-130", "U1 a — x", (None, "PRJ-100")))])
        self.assertEqual(code, 1)
        self.assertIn("BLOCKED U1", out)

    def test_blocked_until_the_row_is_synced(self):
        self.ws.publish()
        code, out, _ = self.ws.run("claim", "U1", issues=[page(("PRJ-130", "U1 a — x", (8, "PRJ-100")))])
        self.assertEqual(code, 1)
        self.assertIn("8,ai", out)

    def test_blocked_while_the_sync_is_only_in_the_working_copy(self):
        self.ws.publish()
        issues = [page(("PRJ-130", "U1 a — x", (5, "PRJ-100")))]
        self.assertEqual(self.ws.run("apply", "U1", issues=issues)[0], 0)
        self.assertIn("U1,5,human", self.ws.text())
        code, out, _ = self.ws.run("claim", "U1", issues=issues)
        self.assertEqual(code, 1)
        self.assertIn("working copy is synced", out)
        self.assertIn("on origin/main has 8,ai", out)
        self.ws.publish()
        self.assertEqual(self.ws.run("claim", "U1", issues=issues)[0], 0)

    def test_a_missing_ref_is_an_error_not_a_block(self):
        code, out, err = self.ws.run("claim", "U3", issues=[page(("PRJ-132", "U3 c — x", (5, "PRJ-100")))])
        self.assertEqual(code, 2, out)
        self.assertIn("origin/main does not exist; run git fetch origin main", err)
        code, _, err = self.ws.run("claim", "--ref", "origin/mian", "U3",
                                   issues=[page(("PRJ-132", "U3 c — x", (5, "PRJ-100")))])
        self.assertEqual(code, 2)
        self.assertIn("origin/mian does not exist", err)

    def test_blocked_when_the_file_is_not_on_main(self):
        os.rename(self.ws.path, self.ws.path + ".away")
        with open(os.path.join(self.ws.top, "README"), "w") as f:
            f.write("x\n")
        self.ws.publish()
        os.rename(self.ws.path + ".away", self.ws.path)
        code, out, _ = self.ws.run("claim", "U3", issues=[page(("PRJ-132", "U3 c — x", (5, "PRJ-100")))])
        self.assertEqual(code, 1)
        self.assertIn("has no file", out)

    def test_blocked_when_the_unit_has_no_row(self):
        self.ws.publish()
        code, out, _ = self.ws.run("claim", "U9", issues=[page(("PRJ-139", "U9 i — x", (3, "PRJ-100")))])
        self.assertEqual(code, 1)
        self.assertIn("has no row", out)

    def test_a_unit_without_an_epic(self):
        self.ws.publish()
        code, out, _ = self.ws.run("claim", "U3", issues=[page(("PRJ-132", "U3 c — x", (5, None)),
                                                               ("PRJ-131", "U2 b — x", (None, None)))])
        self.assertEqual(code, 0, out)
        self.assertIn("U3 has no epic", out)

    def test_unestimated_epic_siblings_need_approval(self):
        issues = [page(("PRJ-132", "U3 c — x", (5, "PRJ-100")), ("PRJ-131", "U2 b — x", (None, "PRJ-100")),
                       ("PRJ-134", "U4 d — x", (None, "PRJ-100")), ("PRJ-135", "U5 e — x", (None, "PRJ-101")))]
        self.ws.publish()
        code, out, _ = self.ws.run("claim", "U3", issues=issues)
        self.assertEqual(code, 3)
        self.assertIn("U2 (PRJ-131), U4 (PRJ-134)", out)
        self.assertNotIn("U5", out)
        self.assertEqual(self.ws.text(), CSV)

    def test_no_issue_is_an_error(self):
        self.assertEqual(self.ws.run("claim", "U9", issues=[page(("PRJ-130", "U1 a — x", 3))])[0], 2)


class GuardBase(unittest.TestCase):
    config = CONFIG

    def setUp(self):
        self.project = tempfile.TemporaryDirectory()
        if self.config is not None:
            with open(os.path.join(self.project.name, ".story-points.json"), "w") as f:
                f.write(self.config if isinstance(self.config, str) else json.dumps(self.config))

    def tearDown(self):
        self.project.cleanup()

    def check(self, tool, tool_input, stderr=False):
        event = json.dumps({"tool_name": tool, "tool_input": tool_input})
        env = {"PATH": os.environ["PATH"], "CLAUDE_PROJECT_DIR": self.project.name}
        proc = subprocess.run(["python3", os.path.join(HERE, "..", "hooks", "story_point_guard.py")],
                              input=event, capture_output=True, text=True, env=env)
        return (proc.returncode, proc.stderr) if stderr else proc.returncode


class GuardTest(GuardBase):
    def test_refuses_setting_the_field(self):
        self.assertEqual(self.check("mcp__jira__editJiraIssue",
                                    {"issueIdOrKey": "PRJ-130", "fields": {FIELD: 5}}), 2)
        self.assertEqual(self.check("mcp__jira__createJiraIssue",
                                    {"summary": "U1", "additional_fields": {"Story point estimate": 3}}), 2)
        self.assertEqual(self.check("mcp__other__executeWrite",
                                    {"name": "x", "inputs": json.dumps({"fields": {"story_points": 2}})}), 2)

    def test_refuses_the_field_named_as_a_value(self):
        self.assertEqual(self.check("mcp__x__executeWrite",
                                    {"name": "editIssue", "inputs": {"customFields": [{"id": FIELD, "value": 5}]}}), 2)
        self.assertEqual(self.check("mcp__jira__editJiraIssue",
                                    {"issueIdOrKey": "PRJ-130", "fields": [{"fieldId": "Story point estimate", "value": 3}]}), 2)
        self.assertEqual(self.check("mcp__jira__editJiraIssue",
                                    {"issueIdOrKey": "PRJ-130", "fields": {"summary": "customfield_10016 is the field"}}), 0)

    def test_the_hook_command_without_a_config_with_one_and_without_python(self):
        with open(os.path.join(HERE, "..", "hooks", "hooks.json")) as f:
            command = json.load(f)["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        event = json.dumps({"tool_name": "mcp__jira__editJiraIssue", "tool_input": {"fields": {FIELD: 5}}})
        plugin = os.path.join(HERE, "..")
        with tempfile.TemporaryDirectory() as elsewhere:
            env = {"PATH": os.environ["PATH"], "CLAUDE_PROJECT_DIR": elsewhere, "CLAUDE_PLUGIN_ROOT": plugin}
            done = subprocess.run(["/bin/sh", "-c", command], input=event, env=env, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)  # no config: nothing to guard
            with open(os.path.join(elsewhere, ".story-points.json"), "w") as f:
                json.dump(CONFIG, f)
            done = subprocess.run(["/bin/sh", "-c", command], input=event, env=env, capture_output=True, text=True)
            self.assertEqual(done.returncode, 2)
            with tempfile.TemporaryDirectory() as bare:
                env["PATH"] = bare  # no python3 on it
                done = subprocess.run(["/bin/sh", "-c", command], input=event, env=env, capture_output=True, text=True)
                self.assertEqual(done.returncode, 2)
                self.assertIn("python3 is not installed", done.stderr)

    def test_refuses_transitions_update_ops_and_other_servers(self):
        self.assertEqual(self.check("mcp__jira__transitionJiraIssue",
                                    {"issueIdOrKey": "PRJ-130", "transition": {"id": "31"},
                                     "fields": {FIELD: 5}}), 2)
        self.assertEqual(self.check("mcp__jira__editJiraIssue",
                                    {"issueIdOrKey": "PRJ-130", "update": {FIELD: [{"set": 5}]}}), 2)
        self.assertEqual(self.check("mcp__mcp-atlassian__jira_update_issue",
                                    {"issue_key": "PRJ-130", "fields": json.dumps({FIELD: 3})}), 2)
        self.assertEqual(self.check("mcp__mcp-atlassian__jira_create_issue",
                                    {"project_key": "PRJ", "additional_fields": {"story_points": 3}}), 2)

    def test_the_hook_matcher_and_the_script_agree(self):
        with open(os.path.join(HERE, "..", "hooks", "hooks.json")) as f:
            matcher = json.load(f)["hooks"]["PreToolUse"][0]["matcher"]
        self.assertEqual(matcher, guard.TOOLS.pattern)
        guarded = ["mcp__x__jira_issue_update", "mcp__jira__createJiraIssue", "mcp__jira__createJiraIssues",
                   "mcp__jira__editJiraIssue", "mcp__jira__transitionJiraIssue",
                   "mcp__mcp-atlassian__jira_update_issue", "mcp__mcp-atlassian__jira_create_issue",
                   "mcp__mcp-atlassian__jira_transition_issue", "mcp__x__executeWrite", "mcp__x__executeDestructive"]
        for name in guarded:
            self.assertRegex(name, matcher)
            self.assertTrue(guard.TOOLS.match(name), name)
        for name in ["mcp__jira__getJiraIssue", "mcp__jira__addCommentToJiraIssue",
                     "mcp__jira__searchJiraIssuesUsingJql", "mcp__slack__slack_send_message"]:
            self.assertIsNone(re.search(matcher, name), name)
            self.assertFalse(guard.TOOLS.match(name), name)

    def test_lets_other_writes_and_reads_through(self):
        self.assertEqual(self.check("mcp__jira__editJiraIssue",
                                    {"issueIdOrKey": "PRJ-130", "fields": {"summary": "story points: 5"}}), 0)
        self.assertEqual(self.check("mcp__jira__addCommentToJiraIssue",
                                    {"commentBody": "Suggested story points: 5."}), 0)
        self.assertEqual(self.check("mcp__jira__getJiraIssue", {"fields": [FIELD]}), 0)


class GuardConfigTest(GuardBase):
    """The hook follows the project's config, not the plugin's."""

    config = None  # no file by default; each test writes what it needs

    def write(self, config):
        with open(os.path.join(self.project.name, ".story-points.json"), "w") as f:
            f.write(config if isinstance(config, str) else json.dumps(config))

    def test_no_config_passes_everything(self):
        self.assertEqual(self.check("mcp__jira__editJiraIssue", {"fields": {FIELD: 5}}), 0)
        self.assertEqual(self.check("mcp__jira__editJiraIssue", {"fields": {"Story point estimate": 5}}), 0)

    def test_a_config_without_a_tracker_passes_everything(self):
        self.write(NO_TRACKER)
        self.assertEqual(self.check("mcp__jira__editJiraIssue", {"fields": {FIELD: 5}}), 0)

    def test_a_tracker_refuses_its_configured_field_and_names(self):
        tracker = dict(CONFIG["tracker"], field="customfield_99999", fieldName="Effort")
        self.write({"tracker": tracker})
        self.assertEqual(self.check("mcp__jira__editJiraIssue", {"fields": {"customfield_99999": 5}}), 2)
        self.assertEqual(self.check("mcp__jira__editJiraIssue", {"fields": {"Effort": 5}}), 2)
        self.assertEqual(self.check("mcp__jira__editJiraIssue", {"fields": {"story_points": 5}}), 2)
        self.assertEqual(self.check("mcp__jira__editJiraIssue", {"fields": {"summary": "Effort"}}), 0)

    def test_an_unreadable_config_refuses_issue_writes_and_names_the_file(self):
        self.write("{not json")
        code, err = self.check("mcp__jira__editJiraIssue", {"fields": {"summary": "x"}}, stderr=True)
        self.assertEqual(code, 2)
        self.assertIn(".story-points.json", err)
        self.assertEqual(self.check("mcp__jira__getJiraIssue", {}), 0)
        self.write({"tracker": {"type": "jira", "site": "example.atlassian.net"}})  # no field
        self.assertEqual(self.check("mcp__jira__editJiraIssue", {"fields": {"summary": "x"}}), 2)


class SetTest(unittest.TestCase):
    """Without a tracker, and the commands that need none."""

    def setUp(self):
        self.ws = Workspace(config=None)

    def tearDown(self):
        self.ws.close()

    def test_plan_says_there_is_no_tracker(self):
        code, out, _ = self.ws.run("plan")
        self.assertEqual(code, 0)
        plan = json.loads(out)
        self.assertIsNone(plan["tracker"])
        self.assertIn("no tracker is configured", plan["message"])
        self.assertEqual(plan["units"], ["U1", "U2", "U3", "U5"])

    def test_apply_exits_2_with_a_clear_message(self):
        code, _, err = self.ws.run("apply", issues=[page(("PRJ-130", "U1 a - x", 3))])
        self.assertEqual(code, 2)
        self.assertIn("no tracker is configured", err)
        self.assertIn("set UNIT POINTS", err)
        self.assertEqual(self.ws.text(), CSV)

    def test_set_updates_and_adds_a_human_row_and_keeps_the_rest_byte_for_byte(self):
        code, out, _ = self.ws.run("set", "u1", "5")
        self.assertEqual(code, 0, out)
        self.assertIn("U1 8 ai -> 5 human", out)
        self.assertEqual(self.ws.text(), CSV.replace("U1,8,ai", "U1,5,human"))
        self.assertEqual(self.ws.run("set", "12", "3")[0], 0)
        self.assertTrue(self.ws.text().endswith("U5,2,ai\nU12,3,human\n"))
        self.assertEqual(self.ws.run("set", "4", "2")[0], 0)  # lands between U3 and U5
        self.assertEqual(self.ws.text().splitlines()[3:],
                         ["U1,5,human", "U2,3,ai", "U3,5,human", "U4,2,human", "U5,2,ai", "U12,3,human"])

    def test_set_the_same_value_changes_nothing(self):
        code, out, _ = self.ws.run("set", "U3", "5")
        self.assertEqual(code, 0)
        self.assertIn("already in the file", out)
        self.assertEqual(self.ws.text(), CSV)

    def test_set_off_scale_is_written_and_exits_1(self):
        code, out, _ = self.ws.run("set", "U1", "13")
        self.assertEqual(code, 1)
        self.assertIn("U1,13,human", self.ws.text())
        self.assertIn("split", out)
        code, out, _ = self.ws.run("set", "U2", "4")
        self.assertEqual(code, 1)
        self.assertIn("not on the scale", out)
        self.assertIn("U2,4,human", self.ws.text())

    def test_set_source_ai_is_a_suggestion(self):
        self.assertEqual(self.ws.run("set", "U3", "8", "--source", "ai")[0], 0)
        self.assertIn("U3,8,ai", self.ws.text())

    def test_set_rejects_a_bad_number_or_unit_and_creates_a_missing_file(self):
        for args in (("U1", "lots"), ("U1", "0"), ("U1", "-2"), ("X7", "3")):
            self.assertEqual(self.ws.run("set", *args)[0], 2, args)
        self.assertEqual(self.ws.text(), CSV)
        ws = Workspace(text=None, config=None)
        try:
            code, out, _ = ws.run("set", "U1", "3")
            self.assertEqual(code, 0)
            self.assertIn("file created", out)
            self.assertEqual(ws.text(), "unit,points,source\nU1,3,human\n")
        finally:
            ws.close()

    def test_a_scale_from_the_config_applies_to_set(self):
        ws = Workspace(config={"scale": [1, 2, 4]})
        try:
            self.assertEqual(ws.run("set", "U1", "4")[0], 0)
            self.assertEqual(ws.run("set", "U2", "5")[0], 1)
        finally:
            ws.close()

    def test_show_lists_the_counting_rows_the_scale_and_the_unit_docs(self):
        docs = os.path.join(self.ws.record, "inception", "units-generation")
        os.makedirs(docs)
        with open(os.path.join(docs, "unit-of-work.md"), "w") as f:
            f.write("# Units\n")
        with open(self.ws.path, "a") as f:
            f.write("U1,3,human\n")  # a later row for U1 is the one that counts
        code, out, _ = self.ws.run("show")
        self.assertEqual(code, 0)
        shown = json.loads(out)
        self.assertEqual(shown["intent"], "261006-demo-mvp-restart")
        self.assertEqual(shown["scale"], [1, 2, 3, 5, 8])
        self.assertIsNone(shown["tracker"])
        self.assertEqual(shown["unitDocs"], [os.path.join("aidlc", "spaces", "default", "intents",
                                                          "261006-demo-mvp-restart", "inception",
                                                          "units-generation", "unit-of-work.md")])
        self.assertEqual(shown["rows"][0], {"unit": "U1", "points": "3", "source": "human"})
        self.assertEqual([r["unit"] for r in shown["rows"]], ["U1", "U2", "U3", "U5"])

    def test_show_without_a_file_has_no_rows(self):
        ws = Workspace(text=None, config=CONFIG)
        try:
            code, out, _ = ws.run("show")
            self.assertEqual(code, 0)
            shown = json.loads(out)
            self.assertEqual(shown["rows"], [])
            self.assertEqual(shown["tracker"], "jira")
            self.assertFalse(os.path.exists(ws.path))
        finally:
            ws.close()

    def test_claim_needs_a_human_row_on_the_ref(self):
        self.ws.publish()
        code, out, _ = self.ws.run("claim", "U3")  # --issues is not needed
        self.assertEqual(code, 0, out)
        self.assertIn("no epic", out)
        code, out, _ = self.ws.run("claim", "U1")  # an ai row
        self.assertEqual(code, 1)
        self.assertIn("BLOCKED U1", out)
        self.assertEqual(self.ws.run("claim", "U9")[0], 1)  # no row
        self.assertIn("no row", self.ws.run("claim", "U9")[1])

    def test_claim_counts_a_row_once_it_is_on_the_ref(self):
        self.ws.publish()
        self.assertEqual(self.ws.run("set", "U1", "5")[0], 0)
        code, out, _ = self.ws.run("claim", "U1")
        self.assertEqual(code, 1)
        self.assertIn("working copy has 5 human", out)
        self.ws.publish()
        self.assertEqual(self.ws.run("claim", "U1")[0], 0)

    def test_claim_with_a_missing_ref_is_an_error(self):
        code, _, err = self.ws.run("claim", "U3")
        self.assertEqual(code, 2)
        self.assertIn("origin/main does not exist", err)


class ConfigTest(unittest.TestCase):
    def broken(self, config, expect):
        ws = Workspace(config=config)
        try:
            code, _, err = ws.run("plan")
            self.assertEqual(code, 2, err)
            self.assertIn(".story-points.json", err)
            self.assertIn(expect, err)
        finally:
            ws.close()

    def test_invalid_json(self):
        self.broken("{nope", "not valid JSON")

    def test_wrong_types(self):
        self.broken("[1, 2]", "JSON object")
        self.broken({"scale": "1,2,3"}, "scale")
        self.broken({"scale": [1, "2"]}, "scale")
        self.broken({"intents": 7}, "intents")
        self.broken({"tracker": "jira"}, "tracker")
        self.broken({"tracker": dict(CONFIG["tracker"], type="linear")}, "type")
        self.broken({"tracker": dict(CONFIG["tracker"], issueType=3)}, "issueType")

    def test_a_tracker_missing_a_required_key(self):
        for key in ("site", "project", "field"):
            tracker = {k: v for k, v in CONFIG["tracker"].items() if k != key}
            self.broken({"tracker": tracker}, f"`{key}` is required")

    def test_tracker_defaults(self):
        tracker = {"type": "jira", "site": "example.atlassian.net", "project": "PRJ", "field": FIELD}
        ws = Workspace(config={"tracker": tracker})
        try:
            code, out, _ = ws.run("plan")
            self.assertEqual(code, 0)
            plan = json.loads(out)
            self.assertEqual(plan["server"], "jira")
            self.assertEqual(plan["fieldName"], "Story point estimate")
            self.assertIn('issuetype = "Unit"', plan["jql"])
        finally:
            ws.close()

    def test_a_custom_server_and_intents_directory(self):
        ws = Workspace(config=dict(CONFIG, intents="records", tracker=dict(CONFIG["tracker"], server="atlassian")))
        try:
            os.rename(os.path.join(ws.top, "aidlc", "spaces", "default", "intents"), os.path.join(ws.top, "records"))
            code, out, _ = ws.run("plan")
            self.assertEqual(code, 0, out)
            self.assertEqual(json.loads(out)["server"], "atlassian")
        finally:
            ws.close()

    def test_the_default_intents_directory_follows_the_active_space(self):
        ws = Workspace(config=None)
        try:
            os.makedirs(os.path.join(ws.top, "aidlc", "spaces", "team"))
            os.rename(os.path.join(ws.top, "aidlc", "spaces", "default"), os.path.join(ws.top, "aidlc", "spaces", "team", "x"))
            os.rename(os.path.join(ws.top, "aidlc", "spaces", "team", "x", "intents"),
                      os.path.join(ws.top, "aidlc", "spaces", "team", "intents"))
            with open(os.path.join(ws.top, "aidlc", "active-space"), "w") as f:
                f.write("team\n")
            self.assertEqual(ws.run("plan")[0], 0)
        finally:
            ws.close()


if __name__ == "__main__":
    unittest.main()
