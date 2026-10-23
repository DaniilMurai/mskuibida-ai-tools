"""Tests for hooks/findings_guard.py, run as the harness runs it: a subprocess fed one event on stdin.
Run: python3 -m unittest discover -s plugins/review-findings/tests"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hooks", "findings_guard.py")
HOOKS_JSON = os.path.join(HERE, "..", "hooks", "hooks.json")
FIXTURES = os.path.join(HERE, "fixtures")

STAGE = "domain-design"
BRIEF_COMMAND = f"aidlc engine review-brief review --stage {STAGE} --why first"
FORM_ID = "260101-demo-shop-domain-design-findings-20261019t1000"
CODE_FORM_ID = "code-review-20261019t1000"
URL = "https://claude.ai/artifact/abc"
TRIAGE_TEXT = "2 review findings are open (1 blocking). What should I do with them?"


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return f.read()


def report_command(result, reason="", stage=STAGE, extra=""):
    command = f"aidlc engine orchestrate report --stage {stage} --result {result}"
    if reason:
        command += f' --reason "{reason}"'
    return command + extra


def triage_input(accept=False, text=TRIAGE_TEXT):
    options = [{"label": "Fix", "description": "x"}]
    if accept:
        options.append({"label": "Accept", "description": "x"})
    options.append({"label": "Open in form", "description": "x"})
    return {"questions": [{"question": text, "header": "Findings", "options": options, "multiSelect": False}]}


def gate_input(text="Domain Design complete. How would you like to proceed?"):
    return {"questions": [{"question": text, "header": "Approval", "multiSelect": False, "options": [
        {"label": "Approve", "description": "Continue"}, {"label": "Request Changes", "description": "Feedback"}]}]}


def answer(tool_input, label):
    return {"answers": {tool_input["questions"][0]["question"]: label}}


class Harness:
    """One session: a state directory, a copy of the fixture project, and the hook as a subprocess."""

    def __init__(self, project=True):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "state")
        self.project = os.path.join(self.tmp.name, "project")
        if project:
            shutil.copytree(os.path.join(FIXTURES, "project"), self.project)
        else:
            os.makedirs(self.project)

    def close(self):
        self.tmp.cleanup()

    def run(self, event_name, tool=None, tool_input=None, response=None, session="s1", raw=None):
        event = {"hook_event_name": event_name, "session_id": session, "cwd": self.project}
        if tool:
            event.update(tool_name=tool, tool_input=tool_input or {})
        if response is not None:
            event["tool_response"] = response
        if event_name == "UserPromptSubmit":
            event["prompt"] = tool_input
        env = dict(os.environ, REVIEW_FINDINGS_DIR=self.state, CLAUDE_PROJECT_DIR=self.project)
        done = subprocess.run([sys.executable, HOOK], input=raw if raw is not None else json.dumps(event),
                              capture_output=True, text=True, env=env, check=False)
        return done.returncode, done.stdout, done.stderr

    def pre(self, tool, tool_input, **kw):
        return self.run("PreToolUse", tool, tool_input, **kw)

    def post(self, tool, tool_input, response=None, **kw):
        return self.run("PostToolUse", tool, tool_input, response if response is not None else {}, **kw)

    def brief(self, text=None, command=BRIEF_COMMAND, **kw):
        return self.post("Bash", {"command": command}, {"stdout": text or fixture("brief-open.txt"), "stderr": ""}, **kw)

    def report_findings(self, minor_only=False, **kw):
        data = json.loads(fixture("report-findings.json"))
        if minor_only:
            data["findings"] = [dict(data["findings"][1])]
        return self.post("ReportFindings", data, "Reported.", **kw)

    def pending(self, session="s1"):
        try:
            with open(os.path.join(self.state, session + ".json"), encoding="utf-8") as f:
                return json.load(f).get("pending")
        except FileNotFoundError:
            return None

    def triage(self, label, accept=False, session="s1"):
        ti = triage_input(accept)
        return self.post("AskUserQuestion", ti, answer(ti, label), session=session)

    def write_form(self, form_id=FORM_ID):
        writes = [{"op": "set", "collection": "forms", "doc_id": form_id, "data": {"title": "Review findings", "status": "open"}},
                  {"op": "set", "collection": f"forms/{form_id}/questions", "doc_id": "R-02", "data": {"n": 1, "kind": "card"}}]
        return self.post("ArtifactData", {"action": "batch", "url": URL, "writes": writes}, {"ok": True})

    def read_form(self, status, form_id=FORM_ID):
        return self.post("ArtifactData", {"action": "get", "url": URL, "collection": "forms", "doc_id": form_id},
                         {"id": form_id, "status": status})


def context(stdout):
    return json.loads(stdout)["hookSpecificOutput"]["additionalContext"] if stdout.strip() else ""


class GuardCase(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.addCleanup(self.h.close)

    def assertRefused(self, result, *needles):
        code, _, err = result
        self.assertEqual(code, 2, err)
        self.assertIn("/review-findings:release", err)
        for needle in needles:
            self.assertIn(needle, err)

    def assertAllowed(self, result):
        self.assertEqual(result[0], 0, result[2])
        self.assertEqual(result[2], "")


class Brief(GuardCase):
    def test_open_findings_set_pending_and_emit_the_summary(self):
        code, out, _ = self.h.brief()
        self.assertEqual(code, 0)
        pend = self.h.pending()
        self.assertEqual((pend["source"], pend["stage"], pend["open"], pend["blocking"], pend["asked"]),
                         ("aidlc", STAGE, 2, 1, False))
        self.assertEqual([f["id"] for f in pend["findings"]], ["R-02", "R-03"])
        text = context(out)
        self.assertIn("**Review findings — Domain Design:** 2 open, 1 blocking", text)
        self.assertIn(TRIAGE_TEXT, text)
        self.assertIn("Fix, Open in form", text)
        self.assertNotIn("Fix, Accept", text)
        self.assertTrue(text.startswith("review-findings:"))
        self.assertTrue(os.path.isfile(os.path.join(self.h.state, "s1.findings")))

    def test_no_open_findings_no_pending(self):
        code, out, _ = self.h.brief(fixture("brief-none.txt"))
        self.assertEqual((code, out), (0, ""))
        self.assertIsNone(self.h.pending())
        self.assertFalse(os.path.exists(os.path.join(self.h.state, "s1.json")))

    def test_a_clean_brief_clears_an_earlier_pending(self):
        self.h.brief()
        self.h.brief(fixture("brief-none.txt"))
        self.assertIsNone(self.h.pending())

    def test_unit_stage_is_kept(self):
        self.h.brief(command=BRIEF_COMMAND + " --unit u1-core")
        self.assertEqual(self.h.pending()["unit"], "u1-core")

    def test_other_commands_do_nothing(self):
        self.h.post("Bash", {"command": "ls"}, {"stdout": fixture("brief-open.txt")})
        self.assertIsNone(self.h.pending())

    def test_outside_an_aidlc_project(self):
        h = Harness(project=False)
        self.addCleanup(h.close)
        self.assertEqual(h.brief()[1], "")
        self.assertIsNone(h.pending())
        self.assertAllowed(h.pre("AskUserQuestion", gate_input()))

    def test_the_same_findings_again_keep_the_answer(self):
        self.h.brief()
        self.h.triage("Fix")
        self.h.brief()
        self.assertEqual(self.h.pending()["answer"], "fix")


class Triage(GuardCase):
    def setUp(self):
        super().setUp()
        self.h.brief()

    def test_a_gate_is_refused_while_unasked(self):
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input()), "Findings", "Fix, Open in form")

    def test_other_questions_are_refused_while_unasked(self):
        ti = {"questions": [{"question": "Which colour?", "header": "Form", "multiSelect": False,
                             "options": [{"label": "Red", "description": ""}, {"label": "Blue", "description": ""}]}]}
        self.assertRefused(self.h.pre("AskUserQuestion", ti))

    def test_a_findings_header_without_the_options_is_not_the_triage(self):
        ti = {"questions": [{"question": "x", "header": "Findings", "multiSelect": False,
                             "options": [{"label": "Yes", "description": ""}, {"label": "No", "description": ""}]}]}
        self.assertRefused(self.h.pre("AskUserQuestion", ti))

    def test_accept_while_blocking_is_refused(self):
        self.assertRefused(self.h.pre("AskUserQuestion", triage_input(accept=True)), "Accept is offered only when no finding is blocking")

    def test_no_accept_when_nothing_blocks_is_refused(self):
        h = Harness()
        self.addCleanup(h.close)
        h.brief(fixture("brief-open.txt").replace("| R-02 | Major |", "| R-02 | Minor |"))
        self.assertEqual(h.pending()["blocking"], 0)
        self.assertRefused(h.pre("AskUserQuestion", triage_input(accept=False)), "Fix, Accept, Open in form")
        self.assertAllowed(h.pre("AskUserQuestion", triage_input(accept=True)))
        self.assertIn("Fix, Accept, Open in form", context(h.brief(fixture("brief-open.txt").replace("| R-02 | Major |", "| R-02 | Minor |"))[1]))

    def test_the_valid_triage_is_allowed(self):
        self.assertAllowed(self.h.pre("AskUserQuestion", triage_input()))

    def test_fix_is_recorded(self):
        code, out, _ = self.h.triage("Fix")
        self.assertEqual(code, 0)
        pend = self.h.pending()
        self.assertEqual((pend["asked"], pend["answer"]), (True, "fix"))
        self.assertIn("R-02, R-03", context(out))
        self.assertIn("review-freeze", context(out))
        self.assertAllowed(self.h.pre("AskUserQuestion", gate_input()))

    def test_a_free_text_answer_decides_nothing(self):
        _, out, _ = self.h.triage("do whatever")
        self.assertFalse(self.h.pending()["asked"])
        self.assertIn("not one of the options", context(out))
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input()))

    def test_an_unreadable_answer_decides_nothing(self):
        ti = triage_input()
        _, out, _ = self.h.post("AskUserQuestion", ti, {"answers": {}})
        self.assertFalse(self.h.pending()["asked"])
        self.assertIn("could not be read", context(out))

    def test_accept_is_recorded_and_the_gate_follows(self):
        h = Harness()
        self.addCleanup(h.close)
        h.brief(fixture("brief-open.txt").replace("| R-02 | Major |", "| R-02 | Minor |"))
        _, out, _ = h.triage("Accept", accept=True)
        self.assertEqual(h.pending()["answer"], "accept")
        self.assertIn("Accepted risk", context(out))
        self.assertAllowed(h.pre("AskUserQuestion", gate_input()))

    def test_a_pull_request_gate_is_not_this_gate(self):
        self.h.triage("Fix")
        self.assertAllowed(self.h.pre("AskUserQuestion", gate_input("Merge #12 now?")))


class Reports(GuardCase):
    def setUp(self):
        super().setUp()
        self.h.brief()

    def bash(self, command):
        return self.h.pre("Bash", {"command": command})

    def test_approved_before_the_question_is_refused(self):
        self.assertRefused(self.bash(report_command("approved")), "has not been asked")

    def test_rejected_before_the_question_is_refused(self):
        self.assertRefused(self.bash(report_command("rejected", "R-02 R-03")), "has not been asked")

    def test_awaiting_approval_and_other_stages_are_not_checked(self):
        self.assertAllowed(self.bash(report_command("awaiting-approval")))
        self.assertAllowed(self.bash(report_command("approved", stage="other-stage")))
        self.assertAllowed(self.bash("ls -la"))

    def test_fix_requires_every_id_in_the_reason(self):
        self.h.triage("Fix")
        self.assertRefused(self.bash(report_command("rejected", "R-02: state the winning event")), "Missing: R-03")
        self.assertRefused(self.bash(report_command("rejected", "see the review")), "R-02, R-03")
        self.assertAllowed(self.bash(report_command("rejected", "R-02: state the winner; R-03: rename the event")))
        self.assertAllowed(self.bash("cd /tmp && " + report_command("rejected", "R-03, R-02") + " --user-input 'Request Changes'"))

    def test_an_id_is_not_matched_inside_a_longer_one(self):
        self.h.triage("Fix")
        self.assertRefused(self.bash(report_command("rejected", "R-02 and R-031")), "R-03")

    def test_approve_is_allowed_after_the_answer_and_clears_the_pending(self):
        self.h.triage("Fix")
        self.assertAllowed(self.bash(report_command("approved") + " --user-input Approve"))
        self.h.post("Bash", {"command": report_command("approved")}, {"stdout": "ok"})
        self.assertIsNone(self.h.pending())

    def test_rejected_post_clears_the_pending(self):
        self.h.triage("Fix")
        self.h.post("Bash", {"command": report_command("rejected", "R-02 R-03")}, {"stdout": "ok"})
        self.assertIsNone(self.h.pending())

    def test_an_unbalanced_quote_is_read_from_the_raw_text(self):
        self.h.triage("Fix")
        self.assertAllowed(self.bash('aidlc engine orchestrate report --stage domain-design --result rejected --reason "R-02 R-03'))
        self.assertRefused(self.bash('aidlc engine orchestrate report --stage domain-design --result rejected --reason "R-02'), "R-03")

    def test_request_changes_after_fix_names_the_ids(self):
        self.h.triage("Fix")
        gate = gate_input()
        _, out, _ = self.h.post("AskUserQuestion", gate, answer(gate, "Request Changes"))
        self.assertIn("name every finding in --reason", context(out))
        self.assertIn("R-02, R-03", context(out))

    def test_approve_with_open_findings_is_noted(self):
        self.h.triage("Fix")
        gate = gate_input()
        _, out, _ = self.h.post("AskUserQuestion", gate, answer(gate, "Approve"))
        self.assertIn("Accepted risk", context(out))


class Form(GuardCase):
    def setUp(self):
        super().setUp()
        self.h.brief()

    def test_the_gate_waits_for_the_form(self):
        _, out, _ = self.h.triage("Open in form")
        self.assertIn("BOARD form", context(out))
        self.assertIn("findings.py", context(out))
        self.assertEqual(self.h.pending()["answer"], "form")
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input()), "Open in form")  # no form yet
        self.assertRefused(self.h.pre("Bash", {"command": report_command("approved")}), "Open in form")
        self.h.write_form()
        self.assertEqual(self.h.pending()["form"], {"id": FORM_ID, "url": URL, "done": False})
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input()), f"Answer the form to continue: {URL}#{FORM_ID}")
        self.assertRefused(self.h.pre("Bash", {"command": report_command("approved")}), "Answer the form to continue")
        form_check = {"questions": [{"question": f"Look at the form and pick one from above: {URL}#{FORM_ID}", "header": "Form",
                                     "multiSelect": False, "options": [{"label": "Saved in the form", "description": ""},
                                                                       {"label": "Something is wrong in the form", "description": ""}]}]}
        self.assertAllowed(self.h.pre("AskUserQuestion", form_check))
        _, out, _ = self.h.read_form("open")
        self.assertIn("not marked Done", context(out))
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input()), "Answer the form")
        _, out, _ = self.h.read_form("done")
        self.assertIn("Summary of your answers", context(out))
        self.assertTrue(self.h.pending()["form"]["done"])
        self.assertAllowed(self.h.pre("AskUserQuestion", gate_input()))
        self.assertAllowed(self.h.pre("Bash", {"command": report_command("approved")}))

    def test_a_query_that_lists_the_form_marks_it_done(self):
        self.h.triage("Open in form")
        self.h.write_form()
        query = {"action": "query", "url": URL, "collection": "forms", "query": {"where": [["status", "eq", "done"]]}}
        self.h.post("ArtifactData", query, {"docs": [{"id": "some-other-form", "status": "done"}]})
        self.assertFalse(self.h.pending()["form"]["done"])
        self.h.post("ArtifactData", query, {"docs": [{"id": FORM_ID, "status": "done"}]})
        self.assertTrue(self.h.pending()["form"]["done"])

    def test_a_get_of_another_document_does_not_count(self):
        self.h.triage("Open in form")
        self.h.write_form()
        self.h.read_form("done", form_id="260101-demo-shop-other-findings-20261019t1000")
        self.assertFalse(self.h.pending()["form"]["done"])

    def test_the_agent_never_writes_done(self):
        self.h.triage("Open in form")
        for ti in ({"action": "update", "url": URL, "collection": "forms", "doc_id": FORM_ID, "data": {"status": "done"}},
                   {"action": "batch", "url": URL, "writes": [{"op": "update", "collection": "forms", "doc_id": FORM_ID,
                                                              "data": {"status": "done"}}]},
                   {"action": "batch", "url": URL, "writes": [{"op": "update", "collection": "forms", "doc_id": FORM_ID,
                                                              "file_path": "/nonexistent/file.json"}]}):
            self.assertRefused(self.h.pre("ArtifactData", ti), "pressing Done")
        self.assertAllowed(self.h.pre("ArtifactData", {"action": "update", "url": URL, "collection": "forms", "doc_id": FORM_ID,
                                                       "data": {"status": "open"}}))
        self.assertAllowed(self.h.pre("ArtifactData", {"action": "update", "url": URL, "collection": "forms", "doc_id": "other",
                                                       "data": {"status": "done"}}))

    def test_rewriting_the_form_takes_done_back(self):
        self.h.triage("Open in form")
        self.h.write_form()
        self.h.read_form("done")
        self.h.post("ArtifactData", {"action": "update", "url": URL, "collection": "forms", "doc_id": FORM_ID,
                                     "data": {"status": "open"}}, {"ok": True})
        self.assertFalse(self.h.pending()["form"]["done"])

    def test_a_rejected_report_after_the_form_names_an_open_id(self):
        self.h.triage("Open in form")
        self.h.write_form()
        self.h.read_form("done")
        self.assertRefused(self.h.pre("Bash", {"command": report_command("rejected", "please fix it")}), "R-02, R-03")
        self.assertAllowed(self.h.pre("Bash", {"command": report_command("rejected", "R-02 needs a winner")
                                               + ' --reject-finding "x.md#R-03=deliberate"'}))

    def test_request_changes_after_the_form(self):
        self.h.triage("Open in form")
        self.h.write_form()
        self.h.read_form("done")
        gate = gate_input()
        _, out, _ = self.h.post("AskUserQuestion", gate, answer(gate, "Request Changes"))
        self.assertIn(f"forms/{FORM_ID}", context(out))
        self.assertIn("--reject-finding", context(out))


class CodeReview(GuardCase):
    EDIT = {"file_path": "", "old_string": "a", "new_string": "b"}

    def setUp(self):
        super().setUp()
        self.edit = dict(self.EDIT, file_path=os.path.join(self.h.project, "src", "cart.py"))
        self.h.report_findings()

    def test_the_tool_sets_pending_anywhere(self):
        h = Harness(project=False)
        self.addCleanup(h.close)
        _, out, _ = h.report_findings()
        pend = h.pending()
        self.assertEqual((pend["source"], pend["open"], pend["blocking"], pend["asked"]), ("code-review", 3, 1, False))
        self.assertIn("**Review findings — code review:** 3 open, 1 blocking", context(out))
        self.assertIn("3 review findings are open (1 blocking)", context(out))

    def test_an_empty_report_does_nothing(self):
        h = Harness()
        self.addCleanup(h.close)
        h.post("ReportFindings", {"findings": []}, "Reported.")
        self.assertIsNone(h.pending())

    def test_edits_and_commits_wait_for_the_answer(self):
        for tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
            self.assertRefused(self.h.pre(tool, self.edit), "Fix / Accept / Open in form")
        self.assertRefused(self.h.pre("Bash", {"command": "git add -A && git commit -m x"}), "Ask first")
        self.assertRefused(self.h.pre("Bash", {"command": "git -C /tmp/x push origin main"}), "Ask first")
        self.assertAllowed(self.h.pre("Bash", {"command": "git status && git diff"}))
        self.assertAllowed(self.h.pre("Bash", {"command": "echo 'git commit' > /dev/null"}))

    def test_a_file_outside_the_project_may_be_written(self):
        self.assertAllowed(self.h.pre("Write", dict(self.EDIT, file_path="/private/tmp/scratch/writes.json")))

    def test_other_questions_wait_too(self):
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input()))
        self.assertAllowed(self.h.pre("AskUserQuestion", triage_input()))
        self.assertRefused(self.h.pre("AskUserQuestion", triage_input(accept=True)), "Accept is offered only")

    def test_fix_releases_edits(self):
        _, out, _ = self.h.triage("Fix")
        self.assertIn("--fix flow", context(out))
        self.assertIsNone(self.h.pending())
        self.assertAllowed(self.h.pre("Edit", self.edit))
        self.assertAllowed(self.h.pre("Bash", {"command": "git commit -m fix"}))

    def test_accept_releases_edits(self):
        h = Harness(project=False)
        self.addCleanup(h.close)
        _, out, _ = h.report_findings(minor_only=True)
        self.assertIn("Fix, Accept, Open in form", context(out))
        self.assertAllowed(h.pre("AskUserQuestion", triage_input(accept=True, text="1 review finding is open (none blocking). What should I do with them?")))
        h.triage("Accept", accept=True)
        self.assertIsNone(h.pending())
        self.assertAllowed(h.pre("Edit", self.edit))

    def test_the_form_holds_edits_until_it_is_done(self):
        self.h.triage("Open in form")
        self.assertRefused(self.h.pre("Edit", self.edit), "Open in form")
        self.h.write_form(CODE_FORM_ID)
        self.assertRefused(self.h.pre("Edit", self.edit), f"{URL}#{CODE_FORM_ID}")
        self.assertRefused(self.h.pre("Bash", {"command": "git push"}), "Answer the form to continue")
        self.h.read_form("open", CODE_FORM_ID)
        self.assertRefused(self.h.pre("Edit", self.edit))
        _, out, _ = self.h.read_form("done", CODE_FORM_ID)
        self.assertIn("Fix cards are fixed now", context(out))
        self.assertIsNone(self.h.pending())
        self.assertAllowed(self.h.pre("Edit", self.edit))

    def test_aidlc_reports_are_not_this_source(self):
        self.assertAllowed(self.h.pre("Bash", {"command": report_command("approved")}))


class Release(GuardCase):
    def test_the_prompt_clears_the_state(self):
        self.h.brief()
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input()))
        code, out, _ = self.h.run("UserPromptSubmit", tool_input="/review-findings:release")
        self.assertEqual(code, 0)
        self.assertIn("cleared", context(out))
        self.assertIsNone(self.h.pending())
        self.assertEqual([n for n in os.listdir(self.h.state) if not n.endswith(".lock")], [])
        self.assertAllowed(self.h.pre("AskUserQuestion", gate_input()))

    def test_other_prompts_change_nothing(self):
        self.h.brief()
        self.assertEqual(self.h.run("UserPromptSubmit", tool_input="Approve it")[1], "")
        self.assertEqual(self.h.run("UserPromptSubmit", tool_input="/release")[1], "")
        self.assertIsNotNone(self.h.pending())

    def test_sessions_are_separate(self):
        self.h.brief(session="a")
        self.assertAllowed(self.h.pre("AskUserQuestion", gate_input(), session="b"))
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input(), session="a"))


class Robustness(GuardCase):
    def test_malformed_stdin_exits_zero(self):
        for raw in ("", "not json", "[1, 2]", "null"):
            for name in ("PreToolUse", "PostToolUse", "UserPromptSubmit"):
                self.assertEqual(self.h.run(name, raw=raw)[0], 0)

    def test_malformed_events_exit_zero(self):
        raw = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_input": {"questions": "x"}})
        self.assertEqual(self.h.run("PreToolUse", raw=raw)[0], 0)
        raw = json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": None, "tool_response": 5})
        self.assertEqual(self.h.run("PostToolUse", raw=raw)[0], 0)

    def test_nothing_pending_nothing_refused(self):
        self.assertAllowed(self.h.pre("AskUserQuestion", gate_input()))
        self.assertAllowed(self.h.pre("Edit", {"file_path": "/x", "old_string": "a", "new_string": "b"}))
        self.assertAllowed(self.h.pre("Bash", {"command": "git commit -m x"}))
        self.assertEqual(os.path.exists(self.h.state), False)  # no state, no lock files

    def test_an_unreadable_state_refuses_guarded_calls_only(self):
        os.makedirs(self.h.state)
        with open(os.path.join(self.h.state, "s1.json"), "w", encoding="utf-8") as f:
            f.write("{broken")
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input()), "cannot be read")
        self.assertAllowed(self.h.pre("Bash", {"command": "ls"}))
        self.assertEqual(self.h.run("UserPromptSubmit", tool_input="/review-findings:release")[0], 0)
        self.assertAllowed(self.h.pre("AskUserQuestion", gate_input()))

    def test_post_rebuilds_an_unreadable_state(self):
        os.makedirs(self.h.state)
        with open(os.path.join(self.h.state, "s1.json"), "w", encoding="utf-8") as f:
            f.write("{broken")
        self.h.brief()
        self.assertEqual(self.h.pending()["open"], 2)


class CutOffBrief(GuardCase):
    """The brief printed through `| head -30`: the table arrives, the `> R-NN Finding:` lines do not."""
    CUT = BRIEF_COMMAND + " | head -30"

    def cut(self, command=BRIEF_COMMAND):
        return self.h.brief(fixture("brief-cut.txt"), command=command)

    def test_a_cut_off_brief_is_not_recorded_as_findings(self):
        code, out, _ = self.cut(self.CUT)
        self.assertEqual(code, 0)
        pend = self.h.pending()
        self.assertEqual((pend["truncated"]["ids"], pend["asked"]), (["R-02", "R-03"], False))
        self.assertFalse(os.path.exists(os.path.join(self.h.state, "s1.findings")))
        text = context(out)
        self.assertIn("cut off", text)
        self.assertIn("unpiped as the only command", text)
        self.assertNotIn("Review findings —", text)  # no summary with empty Finding cells

    def test_the_next_step_is_refused_until_a_complete_brief(self):
        self.cut(self.CUT)
        self.assertRefused(self.h.pre("AskUserQuestion", triage_input()), "cut off", "unpiped as the only command")
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input()), "cut off")
        self.assertRefused(self.h.pre("Bash", {"command": report_command("approved")}), "cut off")
        self.assertRefused(self.h.pre("Bash", {"command": report_command("rejected", "R-02 R-03")}), "cut off")
        self.assertAllowed(self.h.pre("Bash", {"command": report_command("awaiting-approval")}))

    def test_a_complete_brief_replaces_it_and_the_guard_works_as_usual(self):
        self.cut(self.CUT)
        code, out, _ = self.h.brief()
        self.assertEqual(code, 0)
        pend = self.h.pending()
        self.assertNotIn("truncated", pend)
        self.assertEqual([f["id"] for f in pend["findings"]], ["R-02", "R-03"])
        self.assertTrue(all(f["finding"] for f in pend["findings"]))
        self.assertIn("Review findings — Domain Design", context(out))
        self.assertTrue(os.path.isfile(os.path.join(self.h.state, "s1.findings")))
        self.assertAllowed(self.h.pre("AskUserQuestion", triage_input()))
        self.assertRefused(self.h.pre("AskUserQuestion", gate_input()), "Findings")

    def test_a_cut_off_reprint_leaves_recorded_findings_alone(self):
        self.h.brief()
        self.h.triage("Fix")
        code, out, _ = self.cut(self.CUT)
        self.assertEqual(code, 0)
        pend = self.h.pending()
        self.assertEqual((pend["answer"], pend["asked"]), ("fix", True))
        self.assertNotIn("truncated", pend)
        self.assertIn("cut off", context(out))

    def test_a_clean_brief_after_a_cut_off_one_clears_it(self):
        self.cut(self.CUT)
        self.h.brief(fixture("brief-none.txt"))
        self.assertIsNone(self.h.pending())

    def test_no_pending_outside_an_aidlc_project(self):
        h = Harness(project=False)
        self.addCleanup(h.close)
        h.brief(fixture("brief-cut.txt"), command=self.CUT)
        self.assertIsNone(h.pending())

    def test_a_piped_or_redirected_brief_is_refused_before_it_runs(self):
        for command in (self.CUT, BRIEF_COMMAND + " 2>&1 | tail -20", BRIEF_COMMAND + " | grep -n R-0",
                        BRIEF_COMMAND + " > /tmp/brief.txt", BRIEF_COMMAND + " >> /tmp/brief.txt",
                        "cd x && " + BRIEF_COMMAND + " |& head", f"bash -c '{BRIEF_COMMAND} | head'",
                        "aidlc engine review-brief review --stage 'domain design | x | head"):
            with self.subTest(command=command):
                self.assertRefused(self.h.pre("Bash", {"command": command}), "unpiped and in full")

    def test_a_plain_brief_is_not_refused(self):
        for command in (BRIEF_COMMAND, BRIEF_COMMAND + " 2>&1", BRIEF_COMMAND + " 2>/dev/null",
                        "cd x && " + BRIEF_COMMAND + " && echo done", "echo hi | head -1",
                        "aidlc engine status | head -5"):
            with self.subTest(command=command):
                self.assertAllowed(self.h.pre("Bash", {"command": command}))

    def test_outside_an_aidlc_project_a_piped_brief_is_not_this_guard(self):
        h = Harness(project=False)
        self.addCleanup(h.close)
        self.assertAllowed(h.pre("Bash", {"command": self.CUT}))


class Manifest(unittest.TestCase):
    def test_hooks_json(self):
        with open(HOOKS_JSON, encoding="utf-8") as f:
            hooks = json.load(f)["hooks"]
        self.assertEqual(set(hooks), {"PreToolUse", "PostToolUse", "UserPromptSubmit"})
        self.assertEqual(hooks["PostToolUse"][0]["matcher"], "Bash|ReportFindings|AskUserQuestion|ArtifactData")
        for tool in ("AskUserQuestion", "Bash", "Edit", "MultiEdit", "Write", "NotebookEdit"):
            self.assertIn(tool, hooks["PreToolUse"][0]["matcher"].split("|"))
        self.assertNotIn("matcher", hooks["UserPromptSubmit"][0])
        for entries in hooks.values():
            for entry in entries:
                for hook in entry["hooks"]:
                    self.assertIn("${CLAUDE_PLUGIN_ROOT}/hooks/findings_guard.py", hook["command"])
                    self.assertNotIn("aidlc/spaces", hook["command"])  # the ReportFindings source applies anywhere


if __name__ == "__main__":
    unittest.main()
