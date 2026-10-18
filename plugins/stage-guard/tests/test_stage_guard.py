"""Tests for hooks/stage_guard.py. Run: python3 -m unittest discover -s plugins/stage-guard/tests

Each test builds a throwaway git repository with an `origin`, an AI-DLC state file, a fake `gh`
on PATH that answers `gh pr list` with the pull requests of a JSON file, and a fake `aidlc` that
answers `aidlc engine status` with the text of another file.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(__file__), "..", "hooks", "stage_guard.py")

STATE = """\
# AI-DLC State Tracking

## Project Information
- **Start Date**: 2026-10-06T20:58:39Z

## Stage Progress

### INITIALIZATION PHASE
- [x] state-init — EXECUTE

### IDEATION PHASE
- [x] intent-capture — EXECUTE
- [ ] market-research — SKIP
- [{fs}] feasibility — EXECUTE
- [{sd}] scope-definition — EXECUTE
- [ ] rough-mockups — EXECUTE

### CONSTRUCTION PHASE
- [{cg}] code-generation — EXECUTE
"""

FAKE_GH = """\
#!/usr/bin/env python3
import json, os, sys
print(json.dumps(json.load(open(os.environ["FAKE_GH_PRS"]))))
"""


FAKE_AIDLC = """\
#!/usr/bin/env python3
import os, sys
if sys.argv[1:3] != ["engine", "status"]:
    sys.exit(f"unexpected aidlc call: {sys.argv[1:]}")
print(open(os.environ["FAKE_AIDLC_STATUS"]).read())
sys.exit(int(os.environ.get("FAKE_AIDLC_EXIT", "0")))
"""

CURRENT = "AI-DLC Workflow Status\nValidity:       Current\n\nLast Completed: feasibility\n"


def drift(stale="none", revalidate="none"):
    return ("AI-DLC Workflow Status\nValidity:       Drift detected - advisory; routing continues\n"
            f"Directly stale: {stale}\nRevalidate:     {revalidate}\nSuggested redo: /aidlc --stage x\n"
            "Untracked:      state-init\n\nLast Completed: feasibility\n")


def sh(cwd, *cmd):
    subprocess.run(cmd, cwd=cwd, check=True, capture_output=True)


TEAM = {"developers": ["aa", "bb"], "ticket": "PRJ-\\d+", "startCheck": True}


class Fixture(unittest.TestCase):
    """A throwaway repository, its `origin`, an AI-DLC record and the fakes; the helpers every test uses.

    CONFIG is written as `.stage-guard.json` (a dict as JSON, a string as it is, None for no file),
    MAIN is the trunk's name, HEADS the prefix of the branches the earlier stages' pull requests had."""

    CONFIG = TEAM
    MAIN = "main"
    HEADS = "aa/PRJ-5/"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        self.origin = os.path.join(root, "origin.git")
        self.repo = os.path.join(root, "repo")
        sh(root, "git", "init", "-q", "--bare", "-b", self.MAIN, self.origin)
        sh(root, "git", "init", "-q", "-b", self.MAIN, self.repo)
        sh(self.repo, "git", "config", "user.email", "t@example.com")
        sh(self.repo, "git", "config", "user.name", "t")
        intents = os.path.join(self.repo, "aidlc", "spaces", "default", "intents")
        os.makedirs(os.path.join(intents, "i1"))
        with open(os.path.join(intents, "active-intent"), "w") as f:
            f.write("i1\n")
        self.state = os.path.join(intents, "i1", "aidlc-state.md")
        self.write_state(sd="-")
        self.config(self.CONFIG)
        sh(self.repo, "git", "add", "-A")
        sh(self.repo, "git", "commit", "-q", "-m", "init")
        sh(self.repo, "git", "remote", "add", "origin", self.origin)
        sh(self.repo, "git", "push", "-q", "origin", self.MAIN)
        sh(self.repo, "git", "fetch", "-q", "origin")
        bindir = os.path.join(root, "bin")
        os.makedirs(bindir)
        gh = os.path.join(bindir, "gh")
        with open(gh, "w") as f:
            f.write(FAKE_GH)
        os.chmod(gh, 0o755)
        aidlc = os.path.join(bindir, "aidlc")
        with open(aidlc, "w") as f:
            f.write(FAKE_AIDLC)
        os.chmod(aidlc, 0o755)
        self.prs_file = os.path.join(root, "prs.json")
        self.status_file = os.path.join(root, "status.txt")
        self.status(CURRENT)
        self.env = dict(os.environ, PATH=bindir + os.pathsep + os.environ["PATH"], FAKE_GH_PRS=self.prs_file,
                        FAKE_AIDLC_STATUS=self.status_file)
        self.prs((self.HEADS + "intent-capture", "MERGED", 18), (self.HEADS + "feasibility", "MERGED", 19))

    def tearDown(self):
        self.tmp.cleanup()

    def config(self, config):
        """Write (or, for None, remove) the project's `.stage-guard.json`."""
        path = os.path.join(self.repo, ".stage-guard.json")
        if config is None:
            if os.path.exists(path):
                os.remove(path)
            return
        with open(path, "w") as f:
            f.write(config if isinstance(config, str) else json.dumps(config))

    def write_state(self, sd=" ", cg=" ", fs="x"):
        with open(self.state, "w") as f:
            f.write(STATE.format(sd=sd, cg=cg, fs=fs))

    def prs(self, *rows, created="2026-10-07T10:00:00Z"):
        """Pull requests as (head, state, number), all created at `created` unless a row has a 4th field."""
        with open(self.prs_file, "w") as f:
            json.dump([{"headRefName": r[0], "state": r[1], "number": r[2], "url": f"u{r[2]}",
                        "createdAt": r[3] if len(r) > 3 else created} for r in rows], f)

    def status(self, text):
        with open(self.status_file, "w") as f:
            f.write(text)

    def branch(self, name):
        sh(self.repo, "git", "switch", "-q", "-c", name)

    def hook(self, command="aidlc engine orchestrate next"):
        event = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": self.repo}
        proc = subprocess.run([sys.executable, HOOK], input=json.dumps(event), capture_output=True,
                              text=True, env=self.env)
        return proc.returncode, proc.stderr

    def start_check(self, text="- **Blockers:** none\n", confirm=True):
        with open(os.path.join(os.path.dirname(self.state), "start-check.md"), "w") as f:
            f.write(text)
        if confirm:
            self.assertIn("confirmed the current", self.prompt("/stage-guard:confirm-start-check"))

    def record(self, *name):
        return os.path.join(os.path.dirname(self.state), *name)

    def sha(self, path):
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()

    def prompt(self, text):
        event = {"hook_event_name": "UserPromptSubmit", "prompt": text, "cwd": self.repo}
        proc = subprocess.run([sys.executable, HOOK], input=json.dumps(event), capture_output=True,
                              text=True, env=self.env)
        self.assertEqual(proc.returncode, 0)
        return proc.stdout

    def tool(self, name, tool_input):
        event = {"tool_name": name, "tool_input": tool_input, "cwd": self.repo}
        proc = subprocess.run([sys.executable, HOOK], input=json.dumps(event), capture_output=True,
                              text=True, env=self.env)
        return proc.returncode

    def folds(self):
        with open(os.path.join(os.path.dirname(self.state), "stage-folds.json")) as f:
            return json.load(f)


class StageGuardTest(Fixture):
    """The behaviour with a ticket pattern, two developers and the start check on."""

    # The three cases of the task.
    def test_refuses_on_main(self):
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("on `main`", err)
        self.assertIn("git switch -c aa/PRJ-5/scope-definition", err)

    def test_allows_right_branch_previous_merged(self):
        self.branch("aa/PRJ-5/scope-definition")
        self.assertEqual(self.hook(), (0, ""))

    def test_refuses_while_previous_pr_open(self):
        self.prs(("aa/PRJ-5/intent-capture", "MERGED", 18), ("aa/PRJ-5/feasibility", "OPEN", 19))
        self.branch("aa/PRJ-5/scope-definition")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("still under review in u19", err)

    # Around them.
    def test_refuses_when_previous_never_merged(self):
        self.prs(("aa/PRJ-5/intent-capture", "MERGED", 18))
        self.branch("aa/PRJ-5/scope-definition")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("no merged pull request", err)

    def test_refuses_other_stage_branch(self):
        self.branch("aa/PRJ-5/something-else")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("runs on `aa/PRJ-5/scope-definition`", err)

    def test_after_approval_gives_the_sequence(self):
        self.branch("aa/PRJ-5/scope-definition")
        self.write_state(sd="x")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("is approved but its pull request is not open yet", err)
        self.assertIn("aidlc engine orchestrate park", err)

    def test_after_approval_pr_open_says_park(self):
        self.branch("aa/PRJ-5/scope-definition")
        self.write_state(sd="x")
        self.prs(("aa/PRJ-5/feasibility", "MERGED", 19), ("aa/PRJ-5/scope-definition", "OPEN", 22))
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("waiting for review in u22", err)

    def test_new_stage_needs_latest_main(self):
        self.write_state(sd="x")
        self.prs(("aa/PRJ-5/feasibility", "MERGED", 19), ("aa/PRJ-5/scope-definition", "MERGED", 22))
        self.branch("aa/PRJ-5/rough-mockups")
        self.assertEqual(self.hook(), (0, ""))
        # main moves on; the not-yet-started stage branch is now stale
        sh(self.repo, "git", "switch", "-q", "main")
        sh(self.repo, "git", "commit", "-q", "--allow-empty", "-m", "later")
        sh(self.repo, "git", "push", "-q", "origin", "main")
        sh(self.repo, "git", "switch", "-q", "aa/PRJ-5/rough-mockups")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("does not contain the latest main", err)

    # The ticket key comes from the intent, not from a constant.
    def test_new_intent_with_another_key(self):
        # An earlier intent's PRJ-5 pull requests predate this intent's start and do not count.
        self.prs(("aa/PRJ-5/feasibility", "MERGED", 19, "2026-10-01T00:00:00Z"),
                 ("aa/PRJ-9/intent-capture", "MERGED", 30), ("aa/PRJ-9/feasibility", "MERGED", 31))
        self.branch("aa/PRJ-9/scope-definition")
        self.assertEqual(self.hook(), (0, ""))

    def test_old_merged_pr_of_the_same_name_does_not_count(self):
        self.prs(("aa/PRJ-5/feasibility", "MERGED", 9, "2026-10-01T00:00:00Z"),
                 ("aa/PRJ-5/intent-capture", "MERGED", 18))
        self.branch("aa/PRJ-5/scope-definition")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("no merged pull request since this intent started", err)

    def test_branch_with_another_key_than_the_intent(self):
        self.branch("aa/PRJ-7/scope-definition")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("carry the ticket `PRJ-5`", err)

    def test_construction_needs_a_confirmed_start_check(self):
        self.write_state(sd="x", cg="-")
        self.branch("aa/PRJ-5/rough-mockups")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("has no `start-check.md`", err)
        self.start_check("- nothing\n", confirm=False)
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("no `**Blockers:**` line", err)
        self.start_check("- **Blockers:** item 2\n", confirm=False)
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("still lists blockers (item 2)", err)
        self.assertIn("not confirmed", self.prompt("/stage-guard:confirm-start-check"))  # blockers: nothing recorded
        self.start_check("- **Blockers:** none\n", confirm=False)
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("has not confirmed the current", err)
        self.assertIn("confirmed the current", self.prompt("/stage-guard:confirm-start-check"))
        self.assertEqual(self.hook(), (0, ""))
        with open(os.path.join(os.path.dirname(self.state), "start-check.md"), "a") as f:
            f.write("- changed after the confirmation\n")  # the confirmation is bound to the text
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("has not confirmed the current", err)

    def test_agent_cannot_write_the_start_check_approval(self):
        path = os.path.join(os.path.dirname(self.state), "start-check-approval.json")
        self.assertEqual(self.tool("Write", {"file_path": path, "content": "{}"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"echo '{{}}' > {path}"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"git checkout main -- {path}"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"cat {path}"}), 0)
        forged = "echo '{\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"/stage-guard:confirm-start-check\"}'"
        self.assertEqual(self.tool("Bash", {"command": f"{forged} | python3 {HOOK}"}), 2)

    # The ways a start-check confirmation could be faked or skipped.
    def ready(self, blockers="none"):
        """A Construction stage next, on a Unit branch, with a start check that has not been confirmed."""
        self.write_state(sd="x", cg="-")
        self.branch("aa/PRJ-5/rough-mockups")
        self.start_check(f"- **Blockers:** {blockers}\n", confirm=False)

    def approval(self, content):
        with open(self.record("start-check-approval.json"), "w") as f:
            f.write(content)

    def test_malformed_or_foreign_approvals_do_not_count(self):
        self.ready()
        other = self.record("other.txt")
        with open(other, "w") as f:
            f.write("not the start check\n")
        for content in ("not json", "[]", '"x"', "null", "{}", '{"sha256": 7}',
                        json.dumps({"sha256": self.sha(other)}),  # the hash of a different file
                        json.dumps({"sha256": "0" * 64})):
            self.approval(content)
            code, err = self.hook()
            self.assertEqual(code, 2, content)
            self.assertIn("has not confirmed the current", err)
        self.approval(json.dumps({"sha256": self.sha(self.record("start-check.md"))}))
        self.assertEqual(self.hook(), (0, ""))

    def test_none_variants_and_other_words(self):
        self.ready()
        for ok in ("none", "None.", "`none`", "NONE"):
            self.start_check(f"- **Blockers:** {ok}\n")
            self.assertEqual(self.hook(), (0, ""), ok)
        for bad in ("nothing", "none, except item 2", "n/a", ""):
            self.start_check(f"- **Blockers:** {bad}\n", confirm=False)
            self.assertIn("not confirmed", self.prompt("/stage-guard:confirm-start-check"), bad)
            self.assertEqual(self.hook()[0], 2, bad)

    def test_the_blockers_line_is_the_only_one(self):
        self.ready()
        two = "- **Blockers:** none\n\n## Result\n\n- **Blockers:** item 2\n"
        self.start_check(two, confirm=False)
        self.assertIn("2 `**Blockers:**` lines", self.prompt("/stage-guard:confirm-start-check"))
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("2 `**Blockers:**` lines", err)
        self.assertFalse(os.path.exists(self.record("start-check-approval.json")))
        # even a note that carries one, with the real line saying none
        self.start_check("A note.\n- **Blockers:** none\n- **Blockers:** none\n", confirm=False)
        self.assertEqual(self.hook()[0], 2)

    def test_confirm_must_be_the_first_line_of_the_prompt(self):
        self.ready()
        for text in ("hello\n/stage-guard:confirm-start-check", "please /stage-guard:confirm-start-check",
                     "/stage-guard:confirm-start-check-now", "  \n"):
            self.assertEqual(self.prompt(text), "", text)
        self.assertFalse(os.path.exists(self.record("start-check-approval.json")))
        self.assertIn("confirmed the current", self.prompt("  /stage-guard:confirm-start-check  "))

    def test_confirm_for_another_and_for_an_unknown_intent(self):
        self.ready()
        other = os.path.join(os.path.dirname(os.path.dirname(self.state)), "i2")
        os.makedirs(other)
        with open(os.path.join(other, "aidlc-state.md"), "w") as f:
            f.write("# state\n")
        with open(os.path.join(other, "start-check.md"), "w") as f:
            f.write("- **Blockers:** none\n")
        intents_json = os.path.join(os.path.dirname(os.path.dirname(self.state)), "intents.json")
        self.assertIn("intents.json cannot be read", self.prompt("/stage-guard:confirm-start-check i2"))
        with open(intents_json, "w") as f:
            json.dump([{"slug": "one", "dirName": "i1"}, {"slug": "two", "dirName": "i2"}], f)
        self.assertIn("is not an intent", self.prompt("/stage-guard:confirm-start-check nope"))
        self.assertFalse(os.path.exists(os.path.join(other, "start-check-approval.json")))
        self.assertIn("confirmed the current", self.prompt("/stage-guard:confirm-start-check two"))
        with open(os.path.join(other, "start-check-approval.json")) as f:
            self.assertEqual(json.load(f)["sha256"], self.sha(os.path.join(other, "start-check.md")))
        self.assertFalse(os.path.exists(self.record("start-check-approval.json")))  # the active intent is untouched
        self.assertEqual(self.hook()[0], 2)

    def test_an_operation_stage_needs_the_start_check_too(self):
        with open(self.state, "w") as f:
            f.write(STATE.format(sd="x", cg="x", fs="x").replace("[ ] rough-mockups", "[x] rough-mockups")
                    + "\n### OPERATION PHASE\n- [ ] deployment-pipeline — EXECUTE\n")
        self.branch("aa/PRJ-5/rough-mockups")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("has no `start-check.md`", err)
        self.start_check()
        self.assertEqual(self.hook(), (0, ""))

    def test_a_fold_prompt_is_not_a_confirmation_and_the_reverse(self):
        self.ready()
        self.assertIn("approved carrying", self.prompt("/fold feasibility"))
        self.assertFalse(os.path.exists(self.record("start-check-approval.json")))  # a fold confirms nothing
        folds = self.folds()
        self.assertIn("confirmed the current", self.prompt("/stage-guard:confirm-start-check"))
        self.assertEqual(self.folds(), folds)  # and a confirmation records no fold

    def test_shell_writes_to_the_approval_are_refused(self):
        path = self.record("start-check-approval.json")
        for command in (f"bash -c 'echo > {path}'", f"printf '{{}}' > {path}", f"echo '{{}}' | tee {path}",
                        f"sed -i '' s/a/b/ {path}", f"cp x {path}", f"git restore {path}"):
            self.assertEqual(self.tool("Bash", {"command": command}), 2, command)
        self.assertEqual(self.tool("Edit", {"file_path": path, "old_string": "a", "new_string": "b"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"cat {path} && git add {path}"}), 0)

    def test_construction_needs_unit_branch(self):
        self.write_state(sd="x", cg="-")
        self.start_check()
        self.branch("aa/PRJ-5/rough-mockups")
        self.assertEqual(self.hook()[0], 0)  # shaped like a Unit branch
        sh(self.repo, "git", "switch", "-q", "-c", "feature/x")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("not a Unit branch", err)

    def test_wrapped_and_exempt_calls(self):
        self.assertEqual(self.hook("bash -c 'aidlc engine orchestrate next --resume'")[0], 2)
        self.assertEqual(self.hook("aidlc engine orchestrate next --status"), (0, ""))
        self.assertEqual(self.hook("aidlc engine orchestrate next --stage feasibility --single"), (0, ""))
        self.assertEqual(self.hook("aidlc engine orchestrate report --stage x --result approved"), (0, ""))
        self.assertEqual(self.hook("git commit -m 'run aidlc engine orchestrate next later'"), (0, ""))

    # Folding a reopened stage into a later stage's pull request.
    FOLD = "aa/PRJ-5/scope-definition--folded--feasibility"

    def forge(self, branch, stages):
        with open(os.path.join(os.path.dirname(self.state), "stage-folds.json"), "w") as f:
            json.dump({branch: {"intent": "i1", "stages": stages}}, f)

    def test_fold_branch_without_approval_refused(self):
        self.write_state(fs="-")
        self.branch(self.FOLD)
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("records no fold approval", err)
        self.assertIn("/stage-guard:fold", err)

    def test_reopen_on_later_branch_suggests_fold(self):
        self.branch("aa/PRJ-5/scope-definition")
        self.write_state(fs="-")  # jumped back to feasibility
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("runs on its own branch", err)
        self.assertIn("typing `/stage-guard:fold feasibility`", err)

    def test_typed_fold_back_then_rename_then_both_stages_run(self):
        self.branch("aa/PRJ-5/scope-definition")
        out = self.prompt("/stage-guard:fold feasibility")
        self.assertIn("approved carrying `feasibility`, `scope-definition`", out)
        self.assertIn("jump execute --target feasibility --direction backward", out)
        fold = self.folds()[self.FOLD]
        self.assertEqual((fold["intent"], fold["stages"]), ("i1", ["feasibility", "scope-definition"]))
        # Jumped back but not renamed yet: the refusal gives the rename.
        self.write_state(fs="-")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn(f"git branch -m aa/PRJ-5/scope-definition {self.FOLD}", err)
        sh(self.repo, "git", "branch", "-m", self.FOLD)
        self.assertEqual(self.hook(), (0, ""))  # the reopened stage
        self.write_state(fs="x")
        # The later stage, with the fold branch's own pull request already open.
        self.prs(("aa/PRJ-5/intent-capture", "MERGED", 18), ("aa/PRJ-5/feasibility", "MERGED", 19),
                 (self.FOLD, "OPEN", 33))
        self.assertEqual(self.hook(), (0, ""))
        # Both approved: the next stage waits for the fold's pull request.
        self.write_state(fs="x", sd="x")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("waiting for review in u33", err)

    def test_fold_with_no_open_pull_request_renames_on_github(self):
        self.branch("aa/PRJ-5/scope-definition")
        out = self.prompt("/stage-guard:fold feasibility")
        self.assertIn(f"git branch -m aa/PRJ-5/scope-definition {self.FOLD}", out)
        self.assertIn("no pull request is open from it", out)
        self.assertIn(f"branches/aa/PRJ-5/scope-definition/rename -f new_name={self.FOLD}", out)
        # The refusal before the rename gives the GitHub rename too.
        self.write_state(fs="-")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn(f"branches/aa/PRJ-5/scope-definition/rename -f new_name={self.FOLD}", err)
        self.assertNotIn("gh pr close", err)

    def test_fold_with_only_a_merged_or_closed_pull_request_renames_on_github(self):
        # Only an OPEN pull request from the branch takes the replacement steps.
        self.prs(("aa/PRJ-5/intent-capture", "MERGED", 18), ("aa/PRJ-5/feasibility", "MERGED", 19),
                 ("aa/PRJ-5/scope-definition", "MERGED", 30), ("aa/PRJ-5/scope-definition", "CLOSED", 31))
        self.branch("aa/PRJ-5/scope-definition")
        out = self.prompt("/stage-guard:fold feasibility")
        self.assertIn(f"branches/aa/PRJ-5/scope-definition/rename -f new_name={self.FOLD}", out)
        self.assertNotIn("gh pr close", out)
        self.write_state(fs="-")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn(f"branches/aa/PRJ-5/scope-definition/rename -f new_name={self.FOLD}", err)
        self.assertNotIn("gh pr close", err)

    def test_fold_with_an_open_pull_request_opens_a_new_one(self):
        # Renaming the head branch of an open pull request on GitHub closes it.
        self.prs(("aa/PRJ-5/intent-capture", "MERGED", 18), ("aa/PRJ-5/feasibility", "MERGED", 19),
                 ("aa/PRJ-5/scope-definition", "OPEN", 30))
        self.branch("aa/PRJ-5/scope-definition")
        out = self.prompt("/stage-guard:fold feasibility")
        self.assertNotIn("/rename", out)
        steps = [f"git branch -m aa/PRJ-5/scope-definition {self.FOLD}", f"git push -u origin {self.FOLD}",
                 "links u30", "gh pr close 30 --comment",
                 "git push origin --delete aa/PRJ-5/scope-definition",
                 "the new one starts without an approval", "needs a new review"]
        at = [out.find(s) for s in steps]
        self.assertNotIn(-1, at, out)
        self.assertEqual(at, sorted(at))  # in this order, the old branch deleted after the close
        self.assertNotIn("which keeps its review", out)  # the approval stays on the closed one
        # The refusal before the rename gives the same steps.
        self.write_state(fs="-")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertNotIn("/rename", err)
        self.assertIn("gh pr close 30 --comment", err)

    def test_fold_when_gh_cannot_answer_gives_both_cases(self):
        self.branch("aa/PRJ-5/scope-definition")
        with open(os.path.join(self.tmp.name, "bin", "gh"), "w") as f:
            f.write("#!/bin/sh\nexit 1\n")
        out = self.prompt("/stage-guard:fold feasibility")
        self.assertIn("approved carrying `feasibility`, `scope-definition`", out)
        self.assertIn("gh pr list --head aa/PRJ-5/scope-definition --state open", out)
        self.assertIn("never rename it on GitHub, which closes that pull request", out)
        self.assertIn("If it is not, rename the branch", out)

    def test_typed_fold_forward_carries_the_next_stage(self):
        self.branch("aa/PRJ-5/scope-definition")
        self.write_state(sd="x")  # approved, no pull request yet
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("is approved but its pull request is not open yet", err)
        self.assertIn("typing `/stage-guard:fold rough-mockups`", err)
        out = self.prompt("/stage-guard:fold rough-mockups")
        self.assertIn("approved carrying `scope-definition`, `rough-mockups`", out)
        self.assertNotIn("jump execute", out)
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("git branch -m aa/PRJ-5/scope-definition aa/PRJ-5/scope-definition--folded--rough-mockups", err)
        sh(self.repo, "git", "branch", "-m", "aa/PRJ-5/scope-definition--folded--rough-mockups")
        # The previous stage is on this branch, so it needs no merged pull request of its own.
        self.assertEqual(self.hook(), (0, ""))

    def test_fold_fills_the_stages_between(self):
        self.branch("aa/PRJ-5/rough-mockups")
        out = self.prompt("/stage-guard:fold feasibility")
        self.assertIn("aa/PRJ-5/rough-mockups--folded--feasibility,scope-definition", out)
        self.assertIn("`scope-definition` is included because the workflow runs the stages in order", out)

    def test_fold_by_number(self):
        data = os.path.join(self.repo, ".claude", "tools", "data")
        os.makedirs(data)
        with open(os.path.join(data, "stage-graph.json"), "w") as f:
            json.dump([{"number": "1.3", "slug": "feasibility"}], f)
        self.branch("aa/PRJ-5/scope-definition")
        self.assertIn("approved carrying `feasibility`, `scope-definition`", self.prompt("/fold 1.3"))

    def test_fold_prompt_refuses_unknown_stage(self):
        self.branch("aa/PRJ-5/scope-definition")
        self.assertIn("fold not recorded", self.prompt("/stage-guard:fold market-research"))  # SKIP
        self.assertIn("fold not recorded", self.prompt("/stage-guard:fold no-such-stage"))
        self.assertIn("fold not recorded", self.prompt("/stage-guard:fold"))
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.state), "stage-folds.json")))
        self.assertEqual(self.prompt("please fold this into the PR"), "")  # not the command

    def test_fold_branch_out_of_plan_order(self):
        b = "aa/PRJ-5/rough-mockups--folded--scope-definition,feasibility"
        self.branch(b)
        self.forge(b, ["feasibility", "scope-definition", "rough-mockups"])
        self.write_state(fs="-")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("out of stage order", err)

    def test_fold_branch_with_a_gap(self):
        self.branch("aa/PRJ-5/rough-mockups--folded--feasibility")
        self.forge("aa/PRJ-5/rough-mockups--folded--feasibility", ["feasibility", "rough-mockups"])
        self.write_state(fs="-")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("consecutive", err)

    def test_agent_cannot_write_the_folds_file(self):
        path = os.path.join(os.path.dirname(self.state), "stage-folds.json")
        self.assertEqual(self.tool("Write", {"file_path": path, "content": "{}"}), 2)
        self.assertEqual(self.tool("Edit", {"file_path": path, "old_string": "a", "new_string": "b"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"echo '{{}}' > {path}"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"sed -i '' s/a/b/ {path}"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"bash -c 'cp x {path}'"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"git add {path} && git commit -m fold"}), 0)
        self.assertEqual(self.tool("Bash", {"command": f"cat {path}"}), 0)
        self.assertEqual(self.tool("Bash", {"command": "gh pr create --body 'commits stage-folds.json'"}), 0)
        self.assertEqual(self.tool("Bash", {"command": f"echo '{{}}' | tee {path}"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"git checkout main -- {path}"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"git restore {path}"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"git mv {path} x.json"}), 2)

    def test_agent_cannot_run_the_fold_hook_by_hand(self):
        forged = "echo '{\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"/fold feasibility\"}'"
        self.assertEqual(self.tool("Bash", {"command": f"{forged} | python3 {HOOK}"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"bash -c \"python3 {HOOK} < event.json\""}), 2)
        self.assertEqual(self.tool("Bash", {"command": "python3 -c 'import stage_guard'"}), 2)
        self.assertEqual(self.tool("Bash", {"command": "cd hooks && python3 -m stage_guard < ev.json"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"python3 - < {HOOK}"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"env X=1 {HOOK} < ev.json"}), 2)
        self.assertEqual(self.tool("Bash", {"command": f"eval 'python3 {HOOK} < ev.json'"}), 2)
        self.assertEqual(self.tool("Bash", {"command": "python3 -m unittest discover -s plugins/stage-guard/tests"}), 0)
        # Reading, linting or testing the file is not running it.
        self.assertEqual(self.tool("Bash", {"command": f"ruff check {HOOK} && mypy {HOOK}"}), 0)
        self.assertEqual(self.tool("Bash", {"command": f"sed -n 1,20p {HOOK}"}), 0)
        self.assertEqual(self.tool("Bash", {"command": "python3 -m unittest tests/test_stage_guard.py"}), 0)
        self.assertEqual(self.tool("Bash", {"command": f"python3 -m ruff check {HOOK}"}), 0)
        self.assertEqual(self.tool("Bash", {"command": f"git add {HOOK} && git diff {HOOK}"}), 0)
        self.assertEqual(self.tool("Write", {"file_path": os.path.join(self.repo, "notes.md"), "content": ""}), 0)

    # An earlier stage whose approved work changed since its approval.
    def test_refuses_on_top_of_a_drifted_earlier_stage(self):
        self.branch("aa/PRJ-5/scope-definition")
        self.status(drift(stale="feasibility"))
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("stage `scope-definition` would build on stale work: `feasibility` changed after approval", err)
        self.assertIn("aidlc engine jump execute --target feasibility --direction backward", err)
        self.assertIn("`/stage-guard:fold feasibility`", err)
        self.assertEqual(self.hook("aidlc engine orchestrate next --status"), (0, ""))  # still readable

    def test_refuses_on_top_of_a_stage_that_needs_revalidation(self):
        self.branch("aa/PRJ-5/scope-definition")
        self.status(drift(stale="rough-mockups", revalidate="feasibility, intent-capture"))
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("`feasibility`, `intent-capture` read the results of a stage that did", err)
        self.assertNotIn("rough-mockups", err)  # later stages run again anyway
        self.assertIn("--target intent-capture", err)  # the earliest one is reopened

    def test_drift_at_or_after_the_stage_passes(self):
        self.branch("aa/PRJ-5/scope-definition")
        for text in (drift(stale="rough-mockups"), drift(stale="scope-definition"),
                     "Validity:       Untracked completions - advisory; routing continues\nUntracked: state-init\n"):
            self.status(text)
            self.assertEqual(self.hook(), (0, ""), text)

    def test_the_reopened_stage_itself_runs(self):
        # Jumped back to feasibility and folded into this branch: the reopen is what clears the drift.
        self.write_state(fs="-")
        self.branch(self.FOLD)
        self.forge(self.FOLD, ["feasibility", "scope-definition"])
        self.status(drift(stale="feasibility"))
        self.assertEqual(self.hook(), (0, ""))

    def test_fold_hint_only_for_a_stage_not_on_the_branch(self):
        self.write_state(fs="x", sd="-")
        self.branch(self.FOLD)
        self.forge(self.FOLD, ["feasibility", "scope-definition"])
        self.prs(("aa/PRJ-5/intent-capture", "MERGED", 18), (self.FOLD, "OPEN", 33))
        self.status(drift(stale="feasibility"))
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("--target feasibility", err)
        self.assertNotIn("/stage-guard:fold", err)

    def test_construction_refuses_on_drift_without_a_fold(self):
        self.write_state(sd="x", cg="-")
        self.start_check()
        self.branch("aa/PRJ-5/rough-mockups")
        self.status(drift(stale="scope-definition"))
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("stage `code-generation` would build on stale work", err)
        self.assertNotIn("/stage-guard:fold", err)

    def test_validity_that_cannot_be_read_refuses(self):
        self.branch("aa/PRJ-5/scope-definition")
        self.status("Validity:       Inspection partly unavailable - advisory; routing continues\n")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("validity cannot be checked (Inspection partly unavailable", err)
        self.status("AI-DLC Workflow Status\nNo validity block\n")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("printed no Validity line", err)
        self.status(CURRENT)
        self.env["FAKE_AIDLC_EXIT"] = "3"
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("`aidlc engine status` failed", err)

    def test_missing_gh_refuses(self):
        self.branch("aa/PRJ-5/scope-definition")
        self.env["PATH"] = "/usr/bin:/bin"
        if subprocess.run(["sh", "-c", "command -v gh"], env=self.env, capture_output=True).returncode == 0:
            self.skipTest("gh is installed system-wide")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("`gh` is not installed", err)


class NoConfigTest(Fixture):
    """No `.stage-guard.json`: any branch prefix, no ticket segment, no start check, trunk `main`."""

    CONFIG = None
    HEADS = "aa/"

    def test_refuses_on_main_and_suggests_a_placeholder_prefix(self):
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("on `main`", err)
        self.assertIn("git switch main && git pull --ff-only && git switch -c <you>/scope-definition", err)
        self.assertNotIn("with your own prefix", err)  # no developers are configured
        self.assertIn("(The rule: one branch and one pull request per Ideation or Inception stage", err)

    def test_any_prefix_is_accepted(self):
        for prefix in ("aa", "zz", "some-one", "x9"):
            sh(self.repo, "git", "switch", "-q", "-C", f"{prefix}/scope-definition", "main")
            self.assertEqual(self.hook(), (0, ""), prefix)

    def test_the_shape_has_no_ticket_segment(self):
        for name in ("zz/X-1/scope-definition", "zz/x-1/scope-definition", "zz/PRJ-5/scope-definition"):
            sh(self.repo, "git", "switch", "-q", "-C", name, "main")
            code, err = self.hook()
            self.assertEqual(code, 2, name)
            self.assertIn("it runs on `<you>/scope-definition`", err)
        sh(self.repo, "git", "switch", "-q", "-C", "zz/something-else", "main")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("it runs on `<you>/scope-definition`", err)

    def test_the_previous_stage_still_has_to_be_merged(self):
        self.branch("zz/scope-definition")
        self.prs(("aa/intent-capture", "MERGED", 18), ("aa/feasibility", "OPEN", 19))
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("still under review in u19", err)
        self.prs(("aa/intent-capture", "MERGED", 18))
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("no merged pull request since this intent started. Open it from `<you>/feasibility`", err)
        # a branch with a ticket-shaped middle segment is no stage branch here, so its pull request is no stage's
        self.prs(("aa/intent-capture", "MERGED", 18), ("aa/PRJ-5/feasibility", "MERGED", 19))
        self.assertEqual(self.hook()[0], 2)

    def test_the_pr_template_is_named_only_when_it_exists(self):
        self.write_state(sd="x")
        self.branch("zz/scope-definition")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("open the pull request, then park the workflow", err)
        template = os.path.join(self.repo, ".github", "pull_request_template.md")
        os.makedirs(os.path.dirname(template))
        with open(template, "w") as f:
            f.write("template\n")
        code, err = self.hook()
        self.assertIn("open the pull request from `.github/pull_request_template.md`, then park", err)
        self.config({"prTemplate": "docs/pr.md"})  # a configured template that is not there
        code, err = self.hook()
        self.assertIn("open the pull request, then park the workflow", err)
        os.makedirs(os.path.join(self.repo, "docs"))
        with open(os.path.join(self.repo, "docs", "pr.md"), "w") as f:
            f.write("template\n")
        code, err = self.hook()
        self.assertIn("open the pull request from `docs/pr.md`, then park", err)

    def test_construction_needs_no_start_check_and_any_unit_branch(self):
        self.write_state(sd="x", cg="-")
        self.branch("zz/rough-mockups")
        self.assertEqual(self.hook(), (0, ""))  # no start-check.md in the record
        sh(self.repo, "git", "switch", "-q", "-C", "zz/PRJ-5/rough-mockups", "main")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("not a Unit branch. Switch to the Unit's branch `<developer>/<name>`", err)
        sh(self.repo, "git", "switch", "-q", "main")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("Construction runs on the Unit's branch `<developer>/<name>`", err)

    def test_the_start_check_is_not_enabled(self):
        self.write_state(sd="x", cg="-")
        self.start_check("- **Blockers:** none\n", confirm=False)
        self.assertIn("the start check is not enabled for this project", self.prompt("/stage-guard:confirm-start-check"))
        self.assertFalse(os.path.exists(self.record("start-check-approval.json")))

    def test_fold_without_a_ticket(self):
        self.branch("zz/scope-definition")
        out = self.prompt("/stage-guard:fold feasibility")
        fold = "zz/scope-definition--folded--feasibility"
        self.assertIn(f"git branch -m zz/scope-definition {fold}", out)
        self.assertEqual(self.folds()[fold]["stages"], ["feasibility", "scope-definition"])
        self.write_state(fs="-")
        sh(self.repo, "git", "branch", "-m", fold)
        self.assertEqual(self.hook(), (0, ""))  # the reopened stage
        self.write_state(fs="x")
        self.assertEqual(self.hook(), (0, ""))  # then the later one, on the same branch

    def test_a_fold_branch_without_approval_is_refused(self):
        self.write_state(fs="-")
        self.branch("zz/scope-definition--folded--feasibility")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("records no fold approval", err)

    def test_fold_prompt_off_a_stage_branch_names_the_plain_shape(self):
        self.branch("zz/PRJ-5/scope-definition")
        out = self.prompt("/stage-guard:fold feasibility")
        self.assertIn("is not a stage branch `<developer>/<stage>`", out)


class TicketOnlyTest(Fixture):
    """A ticket pattern and no developer list: any prefix, the ticket segment is required."""

    CONFIG = {"ticket": "PRJ-\\d+"}
    HEADS = "zz/PRJ-5/"

    def test_any_prefix_with_the_intents_ticket(self):
        for prefix in ("aa", "zz", "some-one"):
            sh(self.repo, "git", "switch", "-q", "-C", f"{prefix}/PRJ-5/scope-definition", "main")
            self.assertEqual(self.hook(), (0, ""), prefix)

    def test_refusals_use_the_placeholder_prefix(self):
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("git switch -c <you>/PRJ-5/scope-definition", err)
        self.branch("zz/scope-definition")  # no ticket segment
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("it runs on `<you>/PRJ-5/scope-definition`", err)
        sh(self.repo, "git", "switch", "-q", "-C", "zz/PRJ-7/scope-definition", "main")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("carry the ticket `PRJ-5`", err)
        self.assertIn("Rename the branch to `zz/PRJ-5/scope-definition`", err)


class StartCheckOffTest(Fixture):
    """With a ticket and developers but no `startCheck`, Construction needs no start-check.md."""

    CONFIG = {"developers": ["aa", "bb"], "ticket": "PRJ-\\d+"}

    def test_construction_proceeds_without_a_start_check(self):
        self.write_state(sd="x", cg="-")
        self.branch("aa/PRJ-5/rough-mockups")
        self.assertEqual(self.hook(), (0, ""))
        self.assertIn("not enabled for this project", self.prompt("/stage-guard:confirm-start-check"))

    def test_startcheck_false_is_the_same(self):
        self.config(dict(self.CONFIG, startCheck=False))
        self.write_state(sd="x", cg="-")
        self.branch("bb/PRJ-5/rough-mockups")
        self.assertEqual(self.hook(), (0, ""))

    def test_a_unit_branch_still_needs_its_shape(self):
        self.write_state(sd="x", cg="-")
        self.branch("cc/PRJ-5/rough-mockups")  # not a configured developer
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("`<aa|bb>/<ticket>/<name>`", err)

    def test_refusals_name_the_developers(self):
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("git switch -c aa/PRJ-5/scope-definition` (with your own prefix: `aa/` or `bb/`)", err)


class MainBranchTest(Fixture):
    CONFIG = dict(TEAM, mainBranch="develop")
    MAIN = "develop"

    def test_refuses_on_the_configured_main_branch(self):
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("on `develop`", err)
        self.assertIn("git switch develop && git pull --ff-only && git switch -c aa/PRJ-5/scope-definition", err)

    def test_a_branch_named_main_is_just_a_branch(self):
        sh(self.repo, "git", "switch", "-q", "-c", "main")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("would run on `main`; it runs on `aa/PRJ-5/scope-definition`", err)

    def test_the_stage_branch_must_contain_the_latest_trunk(self):
        self.write_state(sd="x")
        self.prs(("aa/PRJ-5/feasibility", "MERGED", 19), ("aa/PRJ-5/scope-definition", "MERGED", 22))
        self.branch("aa/PRJ-5/rough-mockups")
        self.assertEqual(self.hook(), (0, ""))
        sh(self.repo, "git", "switch", "-q", "develop")
        sh(self.repo, "git", "commit", "-q", "--allow-empty", "-m", "later")
        sh(self.repo, "git", "push", "-q", "origin", "develop")
        sh(self.repo, "git", "switch", "-q", "aa/PRJ-5/rough-mockups")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("does not contain the latest develop", err)
        self.assertIn("Rebase it onto `origin/develop`", err)

    def test_a_unit_on_the_trunk_is_refused(self):
        self.write_state(sd="x", cg="-")
        self.start_check()
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertIn("would run on `develop`", err)
        self.assertIn("created from an up-to-date develop", err)


class RulesRefTest(Fixture):
    CONFIG = dict(TEAM, rulesRef="docs/process.md, Branches")

    def test_the_reference_replaces_the_neutral_rule(self):
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertTrue(err.rstrip().endswith("(docs/process.md, Branches)"), err)
        self.assertNotIn("The rule:", err)

    def test_the_reference_is_on_every_check_refusal(self):
        self.branch("aa/PRJ-5/something-else")
        code, err = self.hook()
        self.assertEqual(code, 2)
        self.assertTrue(err.rstrip().endswith("(docs/process.md, Branches)"), err)


class InvalidConfigTest(Fixture):
    """A config file that is there but wrong fails closed, naming the file."""

    BAD = ("{not json", "", "[]", '"x"', "null", '{"startCheck": "yes"}', '{"ticket": "("}', '{"ticket": ""}',
           '{"ticket": 5}', '{"developers": []}', '{"developers": "aa"}', '{"developers": ["a/b"]}',
           '{"developers": ["aa", "aa"]}', '{"mainBranch": 3}', '{"mainBranch": ""}', '{"prTemplate": 1}',
           '{"rulesRef": 1}', '{"startCheckSources": "x.md"}', '{"startCheckSources": ["/abs.md"]}',
           '{"startCheckSources": ["../up.md"]}')

    def test_a_guarded_call_is_refused(self):
        self.branch("aa/PRJ-5/scope-definition")  # the branch a valid config would accept
        for text in self.BAD:
            self.config(text)
            code, err = self.hook()
            self.assertEqual(code, 2, text)
            self.assertIn(".stage-guard.json", err, text)

    def test_calls_that_are_not_guarded_calls_pass(self):
        self.config("{not json")
        self.assertEqual(self.hook("aidlc engine orchestrate next --status"), (0, ""))
        self.assertEqual(self.hook("git status"), (0, ""))
        self.assertEqual(self.tool("Write", {"file_path": os.path.join(self.repo, "notes.md"), "content": ""}), 0)

    def test_prompts_record_nothing(self):
        self.write_state(sd="x", cg="-")
        self.start_check("- **Blockers:** none\n", confirm=False)
        self.branch("aa/PRJ-5/scope-definition")
        self.config('{"startCheck": "yes"}')
        for text in ("/stage-guard:fold feasibility", "/stage-guard:confirm-start-check"):
            out = self.prompt(text)
            self.assertIn("not recorded" if "fold" in text else "not confirmed", out)
            self.assertIn(".stage-guard.json", out)
        self.assertFalse(os.path.exists(self.record("stage-folds.json")))
        self.assertFalse(os.path.exists(self.record("start-check-approval.json")))

    def test_an_empty_object_is_the_defaults(self):
        self.config("{}")
        self.prs(("aa/intent-capture", "MERGED", 18), ("aa/feasibility", "MERGED", 19))
        self.branch("zz/scope-definition")
        self.assertEqual(self.hook(), (0, ""))
        self.config('{"unknownKey": 1}')  # unknown keys are ignored
        self.assertEqual(self.hook(), (0, ""))


class NeutralityTest(unittest.TestCase):
    """The published plugin carries no wording of the team it was written for."""

    NAMES = re.compile(r"blick" + r"mahl|dani" + r"il", re.IGNORECASE)
    OTHER = re.compile(r"\bMax\b|\bBM-|\b(?:ms|dm)/|\bD(?:5\d|6\d)\b|team\.md|/pr-" + r"review|open-" + r"decisions"
                       r"|workspace pull request")

    def test_no_team_specific_wording_in_the_plugin(self):
        root = os.path.join(os.path.dirname(__file__), "..")
        found = []
        for base, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in ("tests", "__pycache__")]
            for name in files:
                path = os.path.join(base, name)
                with open(path, encoding="utf-8") as f:
                    for n, line in enumerate(f, 1):
                        if self.NAMES.search(line) or self.OTHER.search(line):
                            found.append(f"{os.path.relpath(path, root)}:{n}: {line.strip()[:80]}")
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
