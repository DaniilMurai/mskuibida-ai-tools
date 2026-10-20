"""Tests for hooks/gate_guard.py and hooks/hooks.json.
Run: python3 -m unittest discover -s plugins/approval-gates/tests

The hook runs as a subprocess, as the harness runs it, with APPROVAL_GATES_DIR and CLAUDE_PROJECT_DIR
pointing into a temporary folder (a copy of the fixture project). No `aidlc` binary is needed: the hook
only reads the commands the assistant ran."""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
HOOK = os.path.join(PLUGIN, "hooks", "gate_guard.py")
FIXTURE = os.path.join(HERE, "fixtures", "project")
INTENT = "260101-bakery-preorder"
URL = "https://claude.ai/artifact/abc123"
os.environ.pop("CLAUDE_PROJECT_DIR", None)


def load_module():
    spec = importlib.util.spec_from_file_location("gate_guard", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = load_module()


def report(result, stage="user-stories", unit=None, extra=""):
    cmd = f"aidlc engine orchestrate report --stage {stage}" + (f" --unit {unit}" if unit else "")
    return cmd + f" --result {result}" + extra


def gate_question(text, header="Approval", labels=("Approve", "Request Changes")):
    return {"questions": [{"question": text, "header": header, "multiSelect": False,
                           "options": [{"label": label, "description": "x"} for label in labels]}]}


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.project = os.path.join(self.tmp, "project")
        shutil.copytree(FIXTURE, self.project)
        self.state = os.path.join(self.tmp, "state")
        self.transcript = os.path.join(self.tmp, "transcript.jsonl")
        open(self.transcript, "w", encoding="utf-8").close()  # the session's transcript exists before any hook runs
        self.counter = 0

    @property
    def record(self):
        return os.path.join(self.project, "aidlc", "spaces", "default", "intents", INTENT)

    def run_hook(self, event, project=None, session="s1", raw=None, cwd=None):
        env = dict(os.environ, APPROVAL_GATES_DIR=self.state, CLAUDE_PROJECT_DIR=project or self.project)
        event = dict({"transcript_path": self.transcript}, **event, session_id=session)
        if cwd:
            event["cwd"] = cwd
        done = subprocess.run([sys.executable, HOOK], input=raw if raw is not None else json.dumps(event),
                              capture_output=True, text=True, env=env, timeout=30)
        return done.returncode, done.stdout, done.stderr

    def pre(self, tool, tool_input, **kw):
        return self.run_hook({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input}, **kw)

    def post(self, tool, tool_input, response=None, **kw):
        return self.run_hook({"hook_event_name": "PostToolUse", "tool_name": tool, "tool_input": tool_input,
                              "tool_response": response if response is not None else {}}, **kw)

    def prompt(self, text, **kw):
        return self.run_hook({"hook_event_name": "UserPromptSubmit", "prompt": text}, **kw)

    def state_of(self, session="s1"):
        path = os.path.join(self.state, session + ".json")
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def said(self, text, kind="assistant", block="text", sidechain=False):
        """Append one transcript line, shaped as Claude Code writes them: one content block per line."""
        content = [{"type": block, "text": text}] if block == "text" else [{"type": block, "name": "X", "input": {"q": text}}]
        with open(self.transcript, "a", encoding="utf-8") as f:
            f.write(json.dumps({"type": kind, "isSidechain": sidechain, "uuid": "u%d" % self.counter,
                                "timestamp": "2026-01-01T09:00:00.000Z",
                                "message": {"role": kind, "content": content}}) + "\n")
        self.counter += 1

    def context(self, out):
        self.assertTrue(out.strip(), "the hook printed nothing")
        return json.loads(out)["hookSpecificOutput"]["additionalContext"]

    # steps of a gate, each checked to succeed -----------------------------------------------------

    def open_gate(self, stage="user-stories", unit=None, result="awaiting-approval", **kw):
        code, out, err = self.post("Bash", {"command": report(result, stage, unit)}, {"stdout": "ok", "stderr": ""}, **kw)
        self.assertEqual(code, 0, err)
        return out

    def batch(self, gate_id, rows=1):
        """An ArtifactData batch like the one the skill sends: file_path entries for real files."""
        folder = os.path.join(self.tmp, "bundle-%d" % self.counter)
        self.counter += 1
        os.makedirs(folder)
        gate = os.path.join(folder, "gate.json")
        with open(gate, "w", encoding="utf-8") as f:
            json.dump({"title": "User Stories", "status": "open", "round": 1}, f)
        writes = [{"op": "set", "collection": "gates", "doc_id": gate_id, "file_path": gate}]
        for n in range(rows):
            path = os.path.join(folder, "doc%d.json" % n)
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"n": n + 1, "key": "doc%d" % n, "text": "# Doc"}, f)
            writes.append({"op": "set", "collection": f"gates/{gate_id}/documents", "doc_id": "doc%d" % n,
                           "file_path": path})
        return {"action": "batch", "url": URL, "writes": writes}

    def publish(self, gate_id=None, link=True, **kw):
        """Publish the gate's rows and, unless link=False, send the developer the link as the skill does."""
        gate_id = gate_id or f"{INTENT}-user-stories-20260101T0900"
        call = self.batch(gate_id)
        code, _out, err = self.pre("ArtifactData", call, **kw)
        self.assertEqual(code, 0, err)
        code, out, err = self.post("ArtifactData", call, {"ok": True}, **kw)
        self.assertEqual(code, 0, err)
        self.last_publish = out
        if link:
            self.said(f"**Review:** approved (iteration 1)\n**Read:** {URL}#{gate_id}")
        return gate_id

    def ask(self, text, **kw):
        return self.pre("AskUserQuestion", gate_question(text), **kw)


class TestOpening(Case):
    def test_awaiting_approval_opens_the_gate_and_says_what_to_do(self):
        out = self.open_gate()
        pending = self.state_of()["pending"]
        self.assertEqual(pending["stage"], "user-stories")
        self.assertIsNone(pending["unit"])
        self.assertEqual(pending["kind"], "gate")
        self.assertGreater(pending["opened_at"], 1_000_000_000)
        said = self.context(out)
        self.assertTrue(said.startswith("approval-gates:"))
        self.assertIn("user-stories", said)
        self.assertIn(os.path.join(PLUGIN, "scripts", "gate_bundle.py"), said)
        self.assertIn("--why <first|revision>", said)
        self.assertIn("writes.json", said)
        self.assertIn("ArtifactData", said)
        self.assertIn("<artifact url>#<gate id>", said)
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["hookEventName"], "PostToolUse")

    def test_revised_opens_a_fresh_gate(self):
        self.open_gate()
        first = self.state_of()["pending"]["opened_at"]
        self.open_gate(result="revised")
        self.assertGreater(self.state_of()["pending"]["opened_at"], first)

    def test_unit_comes_from_the_option(self):
        self.open_gate("functional-design", "u1-core")
        pending = self.state_of()["pending"]
        self.assertEqual((pending["stage"], pending["unit"]), ("functional-design", "u1-core"))
        self.assertIn("--unit u1-core", self.context(self.open_gate("functional-design", "u1-core")))

    def test_unit_comes_from_the_active_directive_when_the_option_is_missing(self):
        path = os.path.join(self.record, ".aidlc-engine", "active-directive.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"stage": "functional-design", "unit": "u1-core", "kind": "ask"}, f)
        self.open_gate("functional-design")
        self.assertEqual(self.state_of()["pending"]["unit"], "u1-core")

    def test_directive_of_another_stage_gives_no_unit(self):
        path = os.path.join(self.record, ".aidlc-engine", "active-directive.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"stage": "functional-design", "unit": "u1-core"}, f)
        self.open_gate("user-stories")
        self.assertIsNone(self.state_of()["pending"]["unit"])

    def test_other_reports_and_commands_change_nothing(self):
        for command in ("ls -la", "aidlc engine status", "aidlc engine orchestrate report --stage user-stories --result started",
                        "aidlc engine log decision --stage code-generation --checkpoint other"):
            code, out, err = self.post("Bash", {"command": command}, {"stdout": ""})
            self.assertEqual((code, out), (0, ""), err)
        self.assertIsNone(self.state_of())

    def test_report_inside_a_command_chain(self):
        cmd = "cd /tmp && " + report("awaiting-approval") + " && echo done"
        self.post("Bash", {"command": cmd}, {"stdout": ""})
        self.assertEqual(self.state_of()["pending"]["stage"], "user-stories")

    def test_unparseable_quoting_falls_back_to_a_pattern(self):
        cmd = report("awaiting-approval") + " --note 'it's broken"
        self.post("Bash", {"command": cmd}, {"stdout": ""})
        self.assertEqual(self.state_of()["pending"]["stage"], "user-stories")

    def test_plan_approval_decision_opens_a_plan_gate(self):
        cmd = "aidlc engine log decision --unit u1-core --checkpoint plan-approval --value presented"
        out = self.post("Bash", {"command": cmd}, {"stdout": ""})[1]
        pending = self.state_of()["pending"]
        self.assertEqual((pending["stage"], pending["unit"], pending["kind"]), ("code-generation", "u1-core", "plan"))
        self.assertIn("Approve Plan", self.context(out))
        self.assertIn("--stage code-generation --unit u1-core", self.context(out))


class TestTheQuestion(Case):
    def test_refused_before_the_documents_are_published(self):
        self.open_gate()
        code, _out, err = self.ask("User Stories complete. How would you like to proceed?")
        self.assertEqual(code, 2)
        self.assertIn("The developer reads the stage's documents in the AI-DLC approval gates page", err)
        self.assertIn("Publish them first", err)
        self.assertIn("--stage user-stories", err)
        self.assertIn(os.path.join(PLUGIN, "scripts", "gate_bundle.py"), err)
        self.assertTrue(err.strip().endswith(
            "(Blocked by the approval-gates plugin. The developer can release it by typing /approval-gates:release.)"))

    def test_publishing_is_recorded_and_the_question_carries_no_link(self):
        self.open_gate()
        gate_id = self.publish()
        published = self.state_of()["published"]["user-stories"]
        self.assertEqual((published["id"], published["url"]), (gate_id, URL))
        code, _out, err = self.ask("User Stories complete. How would you like to proceed?")
        self.assertEqual((code, err), (0, ""))
        code, _out, err = self.ask(f"User Stories complete, read the documents at {URL}#{gate_id}. How would you like to proceed?")
        self.assertEqual(code, 2)
        self.assertIn("in a message of its own", err)
        self.assertIn(f"{URL}#{gate_id}", err)

    def test_any_gate_link_in_the_question_is_refused(self):
        self.open_gate()
        self.publish()
        for text in (f"Read {URL}#{INTENT}-user-stories-20250101T0000 and decide.",
                     f"Read {URL} and decide.",
                     f"Read claude.ai/artifact/zzz#{INTENT}-user-stories-20250101T0000 and decide."):
            code, _out, err = self.ask(text)
            self.assertEqual(code, 2, text)
            self.assertIn("in a message of its own", err)

    def test_the_question_waits_for_the_link_message(self):
        self.open_gate()
        gate_id = self.publish(link=False)
        self.assertIn(f"Send the developer the link `{URL}#{gate_id}`", self.context(self.last_publish))
        code, _out, err = self.ask("User Stories complete. How would you like to proceed?")
        self.assertEqual(code, 2)
        self.assertIn("no message of yours carries it yet", err)
        self.assertIn(f"`{URL}#{gate_id}`", err)
        self.said(f"Ready to review.\n\n**Read:** {URL}#{gate_id}")
        code, _out, err = self.ask("User Stories complete. How would you like to proceed?")
        self.assertEqual((code, err), (0, ""))

    def test_the_link_counts_only_in_a_message_of_the_assistant(self):
        self.open_gate()
        gate_id = self.publish(link=False)
        link = f"{URL}#{gate_id}"
        self.said(link, kind="user")                       # the developer typed it
        self.said(link, kind="assistant", block="tool_use")  # inside a tool call
        self.said(link, sidechain=True)                    # a subagent said it
        self.said(f"{URL}#{INTENT}-user-stories-20250101T0000")  # an older gate's link
        self.said("not json", kind="assistant")
        with open(self.transcript, "a", encoding="utf-8") as f:
            f.write("{broken\n")
        self.assertEqual(self.ask("User Stories complete. How would you like to proceed?")[0], 2)
        self.said(f"[Read the documents]({link})")
        self.assertEqual(self.ask("User Stories complete. How would you like to proceed?")[0], 0)

    def test_a_fresh_gate_needs_its_own_link(self):
        self.open_gate()
        self.publish()
        self.post("Bash", {"command": report("rejected", extra=' --user-input "Request Changes" --reason "fix"')})
        self.open_gate(result="revised")
        newer = self.publish(f"{INTENT}-user-stories-20260102T1000", link=False)
        code, _out, err = self.ask("User Stories complete. How would you like to proceed?")
        self.assertEqual(code, 2)
        self.assertIn(f"`{URL}#{newer}`", err)

    def test_without_a_transcript_the_question_cannot_be_checked(self):
        self.open_gate()
        self.publish()
        event = {"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion",
                 "tool_input": gate_question("Stage complete. How would you like to proceed?")}
        for path in (None, os.path.join(self.tmp, "missing.jsonl")):
            code, _out, err = self.run_hook(dict(event, transcript_path=path))
            self.assertEqual(code, 2, path)
            self.assertIn("cannot be checked", err)
            self.assertIn("/approval-gates:release", err)

    def test_documents_published_before_the_gate_opened_do_not_count(self):
        self.open_gate()
        gate_id = self.publish()
        self.assertEqual(self.ask("Stage complete. How would you like to proceed?")[0], 0)
        self.post("Bash", {"command": report("rejected", extra=' --user-input "Request Changes" --reason "fix"')})
        self.open_gate(result="revised")
        code, _out, err = self.ask(f"Read {URL}#{gate_id}")
        self.assertEqual(code, 2)
        self.assertIn("Publish them first", err)
        self.publish(f"{INTENT}-user-stories-20260102T1000")
        self.assertEqual(self.ask("Stage complete. How would you like to proceed?")[0], 0)

    def test_without_an_open_gate_the_current_stage_decides(self):
        code, _out, err = self.ask("Anything to add?")
        self.assertEqual(code, 2)
        self.assertIn("--stage user-stories", err)
        gate_id = self.publish()  # recorded by matching the active directive's stage
        self.assertEqual(self.state_of()["published"]["user-stories"]["id"], gate_id)
        self.assertEqual(self.ask("Stage complete. How would you like to proceed?")[0], 0)

    def test_a_row_for_another_stage_does_not_unlock_this_one(self):
        self.open_gate()
        other = f"{INTENT}-delivery-planning-20260101T0900"
        self.publish(other)
        self.assertEqual(self.state_of()["published"], {})
        self.assertEqual(self.ask(f"Read {URL}#{other}")[0], 2)

    def test_a_unit_stage_needs_its_unit_in_the_id(self):
        self.open_gate("functional-design", "u1-core")
        wrong = f"{INTENT}-functional-design-20260101T0900"
        self.publish(wrong)
        self.assertEqual(self.state_of()["published"], {})
        right = self.publish(f"{INTENT}-functional-design-u1-core-20260101T0900")
        self.assertEqual(self.state_of()["published"]["functional-design/u1-core"]["id"], right)
        self.assertEqual(self.ask("Functional Design complete. How would you like to proceed?")[0], 0)

    def test_a_failed_write_is_not_recorded(self):
        self.open_gate()
        call = self.batch(f"{INTENT}-user-stories-20260101T0900")
        self.post("ArtifactData", call, {"error": "document already exists", "is_error": True})
        self.assertEqual(self.state_of()["published"], {})

    def test_rows_of_other_collections_are_not_recorded(self):
        self.open_gate()
        call = self.batch(f"{INTENT}-user-stories-20260101T0900")
        for write in call["writes"]:
            write["collection"] = write["collection"].replace("gates", "forms")
        self.post("ArtifactData", call, {"ok": True})
        self.assertEqual(self.state_of()["published"], {})

    def test_plan_question_is_gated_too(self):
        self.post("Bash", {"command": "aidlc engine log decision --unit u1-core --checkpoint plan-approval"}, {"stdout": ""})
        question = gate_question("Code generation plan ready. How would you like to proceed?", labels=("Approve Plan", "Request Changes"))
        self.assertEqual(self.pre("AskUserQuestion", question)[0], 2)
        gate_id = self.publish(f"{INTENT}-code-generation-u1-core-20260101T0900")
        self.assertEqual(self.pre("AskUserQuestion", question)[0], 0)
        question = gate_question(f"Plan ready, read {URL}#{gate_id}.", labels=("Approve Plan", "Request Changes"))
        self.assertEqual(self.pre("AskUserQuestion", question)[0], 2)  # the link belongs in a message

    def test_accept_as_is_is_a_gate_label(self):
        self.open_gate()
        question = gate_question("Done?", labels=("Accept as-is", "Request Changes"))
        self.assertEqual(self.pre("AskUserQuestion", question)[0], 2)

    def test_header_and_labels_are_matched_loosely(self):
        self.open_gate()
        question = gate_question("Done?", header=" approval ", labels=("APPROVE", "Request Changes"))
        self.assertEqual(self.pre("AskUserQuestion", question)[0], 2)

    def test_questions_that_are_not_gates_pass(self):
        self.open_gate()
        cases = [
            gate_question("Look at the form and pick one from above: x", header="Form", labels=("Saved in the form", "Something is wrong in the form")),
            gate_question("Which database?", header="Database", labels=("Postgres", "SQLite")),
            gate_question("Pull request #12: how would you like to proceed?", labels=("Approve", "Merge")),
            gate_question("Merge https://github.com/acme/app/pull/12?", labels=("Approve", "Request Changes")),
            gate_question("Approve acme/app#12?", labels=("Approve", "Request Changes")),
            gate_question("Approval of the plan", header="Approval", labels=("Go", "Stop")),
        ]
        for question in cases:
            code, _out, err = self.pre("AskUserQuestion", question)
            self.assertEqual((code, err), (0, ""), question)

    def test_a_number_in_a_gate_id_is_not_a_pull_request(self):
        self.open_gate()
        gate_id = self.publish()
        # a question carrying the link is still a gate (so it is refused for the link, not passed as a pull request)
        code, _out, err = self.ask(f"Read {URL}#{gate_id} (2 documents).")
        self.assertEqual(code, 2)
        self.assertIn("in a message of its own", err)
        self.assertEqual(self.ask("Read the documents (2 of them). How would you like to proceed?")[0], 0)
        self.assertEqual(self.ask("Read it; also see #12.")[0], 0)  # a pull request is named: not an AI-DLC gate

    def test_two_sessions_do_not_share_state(self):
        self.open_gate(session="a")
        self.publish(session="a")
        self.assertEqual(self.ask("x", session="a")[0], 0)
        self.open_gate(session="b")
        self.assertEqual(self.ask("x", session="b")[0], 2)
        self.assertIn("Publish them first", self.ask("x", session="b")[2])


class TestTheReport(Case):
    def test_approved_is_refused_before_the_documents_are_published(self):
        self.open_gate()
        code, _out, err = self.pre("Bash", {"command": report("approved", extra=' --user-input "Approve"')})
        self.assertEqual(code, 2)
        self.assertIn("Publish them first", err)

    def test_approved_goes_after_publishing_and_closes_the_gate(self):
        self.open_gate()
        self.publish()
        cmd = report("approved", extra=' --user-input "Approve"')
        self.assertEqual(self.pre("Bash", {"command": cmd})[0], 0)
        self.assertEqual(self.post("Bash", {"command": cmd}, {"stdout": "ok"})[0], 0)
        state = self.state_of()
        self.assertIsNone(state["pending"])
        self.assertIn("user-stories", state["published"])  # kept

    def test_rejected_is_gated_the_same_way(self):
        self.open_gate()
        cmd = report("rejected", extra=' --user-input "Request Changes" --reason "more detail"')
        self.assertEqual(self.pre("Bash", {"command": cmd})[0], 2)
        self.publish()
        self.assertEqual(self.pre("Bash", {"command": cmd})[0], 0)
        self.post("Bash", {"command": cmd}, {"stdout": ""})
        self.assertIsNone(self.state_of()["pending"])

    def test_accepted_is_gated_too(self):
        self.open_gate()
        self.assertEqual(self.pre("Bash", {"command": report("accepted")})[0], 2)

    def test_opening_reports_and_other_commands_are_allowed(self):
        self.open_gate()
        for command in (report("awaiting-approval"), report("revised"), "ls", "git status",
                        "aidlc engine review-brief review --stage user-stories --why first",
                        "aidlc engine log review --stage user-stories --verdict READY"):
            code, _out, err = self.pre("Bash", {"command": command})
            self.assertEqual((code, err), (0, ""), command)

    def test_report_for_another_stage_is_checked_against_that_stage(self):
        self.open_gate()
        self.publish()
        code, _out, err = self.pre("Bash", {"command": report("approved", "delivery-planning")})
        self.assertEqual(code, 2)
        self.assertIn("--stage delivery-planning", err)

    def test_chain_with_cd_is_still_checked(self):
        self.open_gate()
        cmd = "cd /tmp && " + report("approved") + " ; echo x"
        self.assertEqual(self.pre("Bash", {"command": cmd})[0], 2)

    def test_unit_report_uses_the_pending_unit(self):
        self.open_gate("functional-design", "u1-core")
        self.assertEqual(self.pre("Bash", {"command": report("approved", "functional-design")})[0], 2)
        self.publish(f"{INTENT}-functional-design-u1-core-20260101T0900")
        self.assertEqual(self.pre("Bash", {"command": report("approved", "functional-design")})[0], 0)
        self.assertEqual(self.pre("Bash", {"command": report("approved", "functional-design", "u1-core")})[0], 0)

    def test_without_an_open_gate_the_report_needs_a_published_page_too(self):
        self.assertEqual(self.pre("Bash", {"command": report("approved")})[0], 2)
        self.publish()
        self.assertEqual(self.pre("Bash", {"command": report("approved")})[0], 0)


class TestGateRows(Case):
    def write(self, **fields):
        return {"action": "batch", "url": URL, "writes": [
            {"op": "set", "collection": "gates", "doc_id": "x-20260101T0900", "data": dict({"title": "t"}, **fields)}]}

    def test_a_decided_status_is_refused(self):
        code, _out, err = self.pre("ArtifactData", self.write(status="decided"))
        self.assertEqual(code, 2)
        self.assertIn("written by the developer in the page", err)
        self.assertEqual(self.pre("ArtifactData", self.write(status="Decided"))[0], 2)

    def test_decision_and_notes_are_refused(self):
        self.assertEqual(self.pre("ArtifactData", self.write(decision={"k": "approve"}))[0], 2)
        self.assertEqual(self.pre("ArtifactData", self.write(notes={"stories": "x"}))[0], 2)

    def test_a_single_update_is_checked_too(self):
        call = {"action": "update", "url": URL, "collection": "gates", "doc_id": "x", "data": {"status": "decided"}}
        self.assertEqual(self.pre("ArtifactData", call)[0], 2)

    def test_the_row_in_a_file_is_read(self):
        path = os.path.join(self.tmp, "row.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"status": "decided"}, f)
        call = {"action": "batch", "url": URL, "writes": [
            {"op": "set", "collection": "gates", "doc_id": "x", "file_path": path}]}
        self.assertEqual(self.pre("ArtifactData", call)[0], 2)

    def test_a_row_that_cannot_be_read_is_refused(self):
        call = {"action": "batch", "url": URL, "writes": [
            {"op": "set", "collection": "gates", "doc_id": "x", "file_path": os.path.join(self.tmp, "gone.json")}]}
        code, _out, err = self.pre("ArtifactData", call)
        self.assertEqual(code, 2)
        self.assertIn("cannot be read", err)

    def test_normal_rows_and_other_collections_pass(self):
        self.assertEqual(self.pre("ArtifactData", self.write(status="open"))[0], 0)
        other = {"action": "set", "url": URL, "collection": "forms", "doc_id": "f", "data": {"status": "done"}}
        self.assertEqual(self.pre("ArtifactData", other)[0], 0)  # question-forms and its own hook decide that
        documents = {"action": "set", "url": URL, "collection": "gates/x/documents", "doc_id": "k",
                     "data": {"text": "a note: notes", "key": "k"}}
        self.assertEqual(self.pre("ArtifactData", documents)[0], 0)
        read = {"action": "get", "url": URL, "collection": "gates", "doc_id": "x"}
        self.assertEqual(self.pre("ArtifactData", read)[0], 0)


class TestRequestChanges(Case):
    def answer(self, question, answer):
        return self.post("AskUserQuestion", question, {"answers": {question["questions"][0]["question"]: answer}})

    def test_request_changes_says_to_read_the_notes(self):
        self.open_gate()
        gate_id = self.publish()
        question = gate_question(f"Read {URL}#{gate_id}. How would you like to proceed?")
        code, out, err = self.answer(question, "Request Changes")
        self.assertEqual(code, 0, err)
        said = self.context(out)
        self.assertIn(f"gates/{gate_id}", said)
        self.assertIn("ArtifactData get", said)
        self.assertIn("decision.note", said)
        self.assertIn("--reason", said)

    def test_approve_says_nothing(self):
        self.open_gate()
        gate_id = self.publish()
        question = gate_question(f"Read {URL}#{gate_id}.")
        self.assertEqual(self.answer(question, "Approve")[1], "")

    def test_a_typed_answer_that_asks_for_changes_counts(self):
        self.open_gate()
        gate_id = self.publish()
        question = gate_question(f"Read {URL}#{gate_id}.")
        self.assertIn("ArtifactData get", self.context(self.answer(question, "Request Changes, and add a persona")[1]))

    def test_other_questions_get_no_context(self):
        question = gate_question("Which database?", header="Database", labels=("Postgres", "Request Changes"))
        self.assertEqual(self.answer(question, "Request Changes")[1], "")


class TestRelease(Case):
    def test_release_clears_the_state(self):
        self.open_gate()
        self.publish()
        self.assertIsNotNone(self.state_of())
        code, out, err = self.prompt("/approval-gates:release")
        self.assertEqual(code, 0, err)
        self.assertIsNone(self.state_of())
        self.assertEqual(self.context(out), "approval-gates: guard state cleared for this session.")
        self.assertEqual(json.loads(out)["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit")
        self.assertEqual(self.ask("Anything?")[0], 2)  # held again by the current stage, with a fresh state

    def test_release_leaves_other_sessions_alone(self):
        self.open_gate(session="a")
        self.open_gate(session="b")
        self.prompt("/approval-gates:release", session="a")
        self.assertIsNone(self.state_of("a"))
        self.assertIsNotNone(self.state_of("b"))

    def test_release_with_nothing_to_clear_still_answers(self):
        self.assertIn("cleared", self.context(self.prompt("  /approval-gates:release now")[1]))

    def test_bare_release_acts_only_on_an_existing_state(self):
        self.assertEqual(self.prompt("/release")[1], "")
        self.open_gate()
        self.assertIn("cleared", self.context(self.prompt("/release")[1]))
        self.assertIsNone(self.state_of())

    def test_other_prompts_are_ignored(self):
        self.open_gate()
        for text in ("please release it", "/approval-gates:released", "/review-findings:release", ""):
            self.assertEqual(self.prompt(text), (0, "", ""), text)
        self.assertIsNotNone(self.state_of())


class TestWorktrees(Case):
    """In a git worktree session CLAUDE_PROJECT_DIR is the main checkout, whose per-clone pointers are missing."""

    def main_checkout(self):
        main = os.path.join(self.tmp, "main")
        shutil.copytree(FIXTURE, main)
        os.remove(os.path.join(main, "aidlc", "active-space"))
        os.remove(os.path.join(main, "aidlc", "spaces", "default", "intents", "active-intent"))
        shutil.rmtree(os.path.join(main, "aidlc", "spaces", "default", "intents", INTENT, ".aidlc-engine"))
        return main

    def whole_gate(self, **kw):
        self.open_gate(**kw)
        self.publish(**kw)
        self.assertEqual(self.ask("User Stories complete. How would you like to proceed?", **kw)[0], 0)
        cmd = report("approved", extra=' --user-input "Approve"')
        self.assertEqual(self.pre("Bash", {"command": cmd}, **kw)[0], 0)
        self.assertEqual(self.post("Bash", {"command": cmd}, {"stdout": "ok"}, **kw)[0], 0)
        state = self.state_of()
        self.assertIsNone(state["pending"])
        self.assertIn("user-stories", state["published"])

    def test_the_working_directory_wins_over_the_main_checkout(self):
        self.whole_gate(project=self.main_checkout(), cwd=self.project)

    def test_a_working_directory_below_the_project_walks_up(self):
        self.whole_gate(project=self.main_checkout(), cwd=os.path.join(self.project, "aidlc", "spaces"))

    def test_a_working_directory_outside_any_project_falls_back(self):
        self.whole_gate(cwd=self.tmp)

    def test_a_publish_with_no_known_stage_is_kept_by_its_id(self):
        main = self.main_checkout()
        gate_id = self.publish(f"{INTENT}-user-stories-20260101T0900", project=main, cwd=main)
        self.assertEqual(list(self.state_of()["published"]), ["id:" + gate_id])
        self.assertIn(f"Send the developer the link `{URL}#{gate_id}`", self.context(self.last_publish))
        cmd = report("approved", extra=' --user-input "Approve"')
        self.assertEqual(self.pre("Bash", {"command": cmd}, project=main, cwd=main)[0], 0)
        code, _out, err = self.pre("Bash", {"command": report("approved", stage="delivery-planning")}, project=main, cwd=main)
        self.assertEqual(code, 2)
        self.assertIn("Publish them first", err)
        code, _out, err = self.pre("Bash", {"command": report("approved", unit="u1-core")}, project=main, cwd=main)
        self.assertEqual(code, 2)

    def test_a_row_with_a_foreign_id_is_not_kept(self):
        main = self.main_checkout()
        call = self.batch("random-row")
        self.post("ArtifactData", call, {"ok": True}, project=main, cwd=main)
        self.assertIsNone(self.state_of())


class TestFailingOpen(Case):
    def test_malformed_stdin(self):
        for raw in ("", "not json", "[1, 2]", "null", "{"):
            self.assertEqual(self.run_hook({}, raw=raw), (0, "", ""), raw)

    def test_unknown_events_and_tools(self):
        self.assertEqual(self.run_hook({"hook_event_name": "Stop"}), (0, "", ""))
        self.assertEqual(self.pre("Read", {"file_path": "/x"}), (0, "", ""))
        self.assertEqual(self.pre("Bash", {}), (0, "", ""))
        self.assertEqual(self.pre("Bash", {"command": None}), (0, "", ""))
        self.assertEqual(self.pre("AskUserQuestion", {"questions": "nope"}), (0, "", ""))
        self.assertEqual(self.pre("AskUserQuestion", {}), (0, "", ""))

    def test_outside_an_aidlc_project(self):
        bare = os.path.join(self.tmp, "bare")
        os.makedirs(bare)
        self.assertEqual(self.pre("Bash", {"command": report("approved")}, project=bare), (0, "", ""))
        self.assertEqual(self.ask("x", project=bare), (0, "", ""))
        self.assertEqual(self.post("Bash", {"command": report("awaiting-approval")}, project=bare), (0, "", ""))
        self.assertIsNone(self.state_of())

    def test_project_dir_falls_back_to_the_working_directory(self):
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        env["APPROVAL_GATES_DIR"] = self.state
        event = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "s1", "cwd": self.project,
                 "tool_input": {"command": report("approved")}}
        done = subprocess.run([sys.executable, HOOK], input=json.dumps(event), capture_output=True, text=True, env=env, cwd=self.tmp)
        self.assertEqual(done.returncode, 2, done.stderr)

    def test_unreadable_state_refuses_a_guarded_call_and_names_the_release(self):
        os.makedirs(self.state)
        with open(os.path.join(self.state, "s1.json"), "w", encoding="utf-8") as f:
            f.write("{ not json")
        code, _out, err = self.ask("x")
        self.assertEqual(code, 2)
        self.assertIn("cannot be read", err)
        self.assertIn("/approval-gates:release", err)
        self.assertEqual(self.pre("Bash", {"command": "ls"}), (0, "", ""))  # not a guarded call: no state needed
        self.assertEqual(self.post("Bash", {"command": report("awaiting-approval")}), (0, "", ""))  # PostToolUse never fails
        self.prompt("/approval-gates:release")
        self.assertIsNone(self.state_of())

    def test_state_of_the_wrong_shape_is_tolerated(self):
        os.makedirs(self.state)
        with open(os.path.join(self.state, "s1.json"), "w", encoding="utf-8") as f:
            json.dump({"pending": "x", "published": [1]}, f)
        self.assertEqual(self.ask("x")[0], 2)  # held by the current stage, like a fresh state
        self.open_gate()
        self.assertEqual(self.state_of()["pending"]["stage"], "user-stories")

    def test_no_current_stage_means_nothing_to_guard(self):
        os.remove(os.path.join(self.record, ".aidlc-engine", "active-directive.json"))
        os.remove(os.path.join(self.record, "aidlc-state.md"))
        self.assertEqual(self.ask("x"), (0, "", ""))

    def test_current_stage_falls_back_to_the_state_file(self):
        os.remove(os.path.join(self.record, ".aidlc-engine", "active-directive.json"))
        code, _out, err = self.ask("x")
        self.assertEqual(code, 2)
        self.assertIn("--stage user-stories", err)

    def test_stale_state_of_other_sessions_is_removed_on_save(self):
        os.makedirs(self.state)
        old = os.path.join(self.state, "old.json")
        with open(old, "w", encoding="utf-8") as f:
            f.write("{}")
        long_ago = 1_000_000_000
        os.utime(old, (long_ago, long_ago))
        self.open_gate()
        self.assertFalse(os.path.exists(old))
        self.assertIsNotNone(self.state_of())


class TestHelpers(unittest.TestCase):
    def calls(self, command):
        return guard.engine_calls(command)

    def test_engine_calls(self):
        self.assertEqual(self.calls("aidlc engine orchestrate report --stage a --result approved --user-input 'Approve'"),
                         [{"kind": "report", "stage": "a", "result": "approved", "unit": None}])
        self.assertEqual(self.calls("./node_modules/.bin/aidlc engine orchestrate report --stage=a --result=revised --unit u1")[0]["unit"], "u1")
        self.assertEqual(len(self.calls("aidlc engine orchestrate report --stage a --result approved && aidlc engine orchestrate report --stage b --result approved")), 2)
        self.assertEqual(self.calls("echo 'aidlc engine orchestrate report --stage a --result approved'"), [])  # quoted text
        self.assertEqual(self.calls("grep report file"), [])
        self.assertEqual(self.calls("git commit -m 'aidlc notes'"), [])

    def test_engine_calls_over_lines_and_quotes(self):
        cmd = 'aidlc engine orchestrate report --stage a --result rejected --reason "R-01: fix; and R-02" \\\n  --user-input "Request Changes"'
        calls = self.calls(cmd)
        self.assertEqual([(c["stage"], c["result"]) for c in calls], [("a", "rejected")])
        self.assertEqual(self.calls("cd x\naidlc engine orchestrate report --stage a --result approved")[0]["stage"], "a")

    def test_decision_calls(self):
        calls = self.calls("aidlc engine log decision --checkpoint plan-approval --unit u1")
        self.assertEqual(calls, [{"kind": "decision", "stage": None, "checkpoint": "plan-approval", "unit": "u1"}])

    def test_names_pull_request(self):
        for text in ("PR #12", "see #7.", "(#7)", "acme/app#12", "https://github.com/a/b/pull/3"):
            self.assertTrue(guard.names_pull_request(text), text)
        for text in ("https://claude.ai/artifact/x#260101-bakery-user-stories-20260101T0900", "no number", "C#", "#abc"):
            self.assertFalse(guard.names_pull_request(text), text)

    def test_a_question_carrying_the_gate_link_is_still_a_gate(self):
        # the intent id starts with digits: `#260101-…` must not read as pull request #260101
        link = "https://claude.ai/artifact/abc123#260101-bakery-preorder-delivery-planning-20261019T2310"
        for text in (f"Delivery Planning complete, read {link}. How would you like to proceed?",
                     "Read claude.ai/artifact/abc123#260101-bakery-preorder-user-stories-20261019T2310 now",
                     "Read #260101-bakery-preorder-user-stories-20261019T2310 now"):
            self.assertFalse(guard.names_pull_request(text), text)
            self.assertTrue(guard.is_gate(gate_question(text)["questions"][0]), text)
        for text in ("Merge #12?", f"Read {link} and merge #12", "Approve https://github.com/a/b/pull/12"):
            self.assertTrue(guard.names_pull_request(text), text)
            self.assertFalse(guard.is_gate(gate_question(text)["questions"][0]), text)

    def test_id_matches(self):
        self.assertTrue(guard.id_matches("260101-x-user-stories-20260101T0900", "260101-x", "user-stories", None))
        self.assertTrue(guard.id_matches("260101-x-user-stories-20260101t0900", "260101-x", "user-stories", None))  # either case
        self.assertTrue(guard.id_matches("260101-x-functional-design-u1-core-20260101T0900", "260101-x", "functional-design", "u1-core"))
        self.assertFalse(guard.id_matches("260101-x-functional-design-u1-core-20260101T0900", "260101-x", "functional-design", None))
        self.assertFalse(guard.id_matches("260101-x-pre-user-stories-20260101T0900", "260101-x", "user-stories", None))
        self.assertTrue(guard.id_matches("anything-user-stories-20260101T0900", None, "user-stories", None))
        self.assertFalse(guard.id_matches("260101-x-user-stories-notatime", "260101-x", "user-stories", None))

    def test_is_gate(self):
        self.assertTrue(guard.is_gate(gate_question("x")["questions"][0]))
        self.assertFalse(guard.is_gate(gate_question("x", header="Findings")["questions"][0]))


class TestHooksJson(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(PLUGIN, "hooks", "hooks.json"), encoding="utf-8") as f:
            self.hooks = json.load(f)["hooks"]

    def test_events_and_matchers(self):
        self.assertEqual(set(self.hooks), {"PreToolUse", "PostToolUse", "UserPromptSubmit"})
        self.assertEqual(self.hooks["PreToolUse"][0]["matcher"], "AskUserQuestion|Bash|ArtifactData")
        self.assertEqual(self.hooks["PostToolUse"][0]["matcher"], "Bash|ArtifactData|AskUserQuestion")
        self.assertNotIn("matcher", self.hooks["UserPromptSubmit"][0])

    def test_every_command_skips_outside_aidlc_and_runs_the_hook(self):
        for event, groups in self.hooks.items():
            command = groups[0]["hooks"][0]["command"]
            self.assertTrue(command.startswith('[ -d "${CLAUDE_PROJECT_DIR:-.}/aidlc/spaces" ] || [ -d ./aidlc/spaces ] || exit 0;'), event)
            self.assertIn('python3 "${CLAUDE_PLUGIN_ROOT}/hooks/gate_guard.py"', command)
            self.assertIn("command -v python3", command)

    def test_the_shell_command_exits_quietly_outside_an_aidlc_project(self):
        bare = os.path.join(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, bare, ignore_errors=True)
        env = dict(os.environ, CLAUDE_PROJECT_DIR=bare, CLAUDE_PLUGIN_ROOT=PLUGIN)
        for event, groups in self.hooks.items():
            done = subprocess.run(["sh", "-c", groups[0]["hooks"][0]["command"]], input="{}", capture_output=True,
                                  text=True, env=env)
            self.assertEqual((done.returncode, done.stdout, done.stderr), (0, "", ""), event)

    def test_missing_python_refuses_only_when_a_state_exists(self):
        command = self.hooks["PreToolUse"][0]["hooks"][0]["command"]
        project = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, project, ignore_errors=True)
        os.makedirs(os.path.join(project, "aidlc", "spaces"))
        state = os.path.join(project, "state")
        os.makedirs(state)
        # a PATH with no python3 but with the tools the command line needs
        bin_dir = os.path.join(project, "bin")
        os.makedirs(bin_dir)
        for tool in ("ls", "echo"):
            found = shutil.which(tool)
            if found:
                os.symlink(found, os.path.join(bin_dir, tool))
        env = {"PATH": bin_dir, "CLAUDE_PROJECT_DIR": project, "CLAUDE_PLUGIN_ROOT": PLUGIN, "APPROVAL_GATES_DIR": state}
        sh = shutil.which("sh")
        done = subprocess.run([sh, "-c", command], capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        with open(os.path.join(state, "s1.json"), "w", encoding="utf-8") as f:
            f.write("{}")
        done = subprocess.run([sh, "-c", command], capture_output=True, text=True, env=env)
        self.assertEqual(done.returncode, 2)
        self.assertIn("python3 is not installed", done.stderr)


if __name__ == "__main__":
    unittest.main()
