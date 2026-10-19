"""Tests for scripts/gate_bundle.py.
Run: python3 -m unittest discover -s plugins/approval-gates/tests

The review brief comes from `aidlc engine review-brief …`; there is no `aidlc` binary here, so the tests point
$APPROVAL_GATES_AIDLC at a small shell script that stands in for it."""

import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "fixtures", "project")
INTENT = "260101-bakery-preorder"
os.environ.pop("CLAUDE_PROJECT_DIR", None)


def load(name, *parts):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "..", *parts))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bundle = load("gate_bundle", "scripts", "gate_bundle.py")


def record(project):
    return os.path.join(project, "aidlc", "spaces", "default", "intents", INTENT)


class Case(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.project = os.path.join(self.tmp, "project")
        shutil.copytree(FIXTURE, self.project)
        self.out = os.path.join(self.tmp, "out")

    def fake_aidlc(self, body):
        path = os.path.join(self.tmp, "fake-aidlc")
        with open(path, "w", encoding="utf-8") as f:
            f.write("#!/bin/sh\n" + body + "\n")
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
        return path

    def run_script(self, *args, aidlc=None):
        """(exit code, stdout, stderr) of main() with the project and output folder filled in."""
        argv = ["--project-dir", self.project, "--out", self.out, *args]
        env = {"APPROVAL_GATES_AIDLC": aidlc} if aidlc else {}
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = bundle.main(argv)
        return code, out.getvalue(), err.getvalue()

    def gate(self):
        with open(os.path.join(self.out, "gate.json"), encoding="utf-8") as f:
            return json.load(f)

    def document(self, key):
        with open(os.path.join(self.out, "documents", key + ".json"), encoding="utf-8") as f:
            return json.load(f)

    def summary(self, *args, **kw):
        code, out, err = self.run_script(*args, **kw)
        self.assertEqual(code, 0, err)
        return json.loads(out)


class TestRows(Case):
    def test_user_stories_documents_and_order(self):
        summary = self.summary("--stage", "user-stories", "--no-brief")
        # the graph's `produces` first (a missing file is skipped), then the other files by name, then the review
        self.assertEqual(summary["documents"],
                         ["stories", "personas", "traceability", "user-stories-questions", "review-02"])
        self.assertNotIn("memory", summary["documents"])
        self.assertEqual(summary["round"], 1)
        self.assertEqual(summary["stage"], "user-stories")
        self.assertIsNone(summary["unit"])

    def test_gate_row(self):
        summary = self.summary("--stage", "user-stories", "--no-brief")
        gate = self.gate()
        self.assertRegex(summary["id"], r"^260101-bakery-preorder-user-stories-\d{8}T\d{4}$")
        self.assertRegex(summary["id"], r"^[a-z0-9._-]+-\d{8}T\d{4}$")
        self.assertEqual(gate["title"], "User Stories")
        self.assertEqual(gate["stageName"], "User Stories")
        self.assertEqual(gate["stage"], "user-stories")
        self.assertEqual(gate["phase"], "inception")
        self.assertEqual(gate["intent"], INTENT)
        self.assertEqual(gate["round"], 1)
        self.assertEqual(gate["why"], "first")
        self.assertEqual(gate["status"], "open")
        self.assertRegex(gate["createdAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertTrue(gate["project"].startswith("A pre-order app for a neighbourhood bakery"))
        self.assertEqual(gate["nextStage"], "Delivery Planning")
        self.assertEqual(gate["options"], [
            {"k": "approve", "t": "Approve", "d": "Continue to Delivery Planning"},
            {"k": "changes", "t": "Request Changes", "d": "Provide revision feedback"}])
        self.assertNotIn("unit", gate)
        self.assertNotIn("decision", gate)
        self.assertNotIn("notes", gate)

    def test_document_kinds_and_texts(self):
        self.summary("--stage", "user-stories", "--no-brief")
        index = {d["key"]: d for d in self.gate()["documents"]}
        self.assertEqual({k: d["kind"] for k, d in index.items()},
                         {"stories": "markdown", "personas": "markdown", "traceability": "json",
                          "user-stories-questions": "questions", "review-02": "review"})
        stories = self.document("stories")
        self.assertEqual(stories["n"], 1)
        self.assertEqual(stories["title"], "Stories")
        self.assertEqual(stories["path"], "aidlc/spaces/default/intents/%s/inception/user-stories/stories.md" % INTENT)
        with open(os.path.join(self.project, stories["path"]), encoding="utf-8") as f:
            self.assertEqual(stories["text"], f.read())  # the file as is
        self.assertIn("```mermaid", stories["text"])
        self.assertEqual(index["stories"]["bytes"], os.path.getsize(os.path.join(self.project, stories["path"])))
        self.assertEqual(self.document("review-02")["n"], 5)

    def test_json_is_pretty_printed(self):
        self.summary("--stage", "user-stories", "--no-brief")
        text = self.document("traceability")["text"]
        self.assertTrue(text.startswith('{\n  "stage": "user-stories",\n'), text[:60])
        self.assertEqual(json.loads(text)["coverage"][0]["id"], "FR1")

    def test_newest_review_and_its_verdict(self):
        self.summary("--stage", "user-stories", "--no-brief")
        gate = self.gate()
        self.assertEqual(gate["review"], {
            "verdict": "READY", "reviewer": "aidlc-product-lead-agent", "iteration": 2,
            "file": "aidlc/spaces/default/intents/%s/inception/user-stories/reviews/review-02.md" % INTENT})
        self.assertIn("The baker story now has a criterion", self.document("review-02")["text"])

    def test_stage_without_review_has_no_review_field(self):
        self.summary("--stage", "delivery-planning", "--no-brief")
        gate = self.gate()
        self.assertNotIn("review", gate)
        self.assertEqual(gate["phase"], "inception")
        self.assertEqual([d["key"] for d in gate["documents"]], ["bolt-plan"])

    def test_unit_stage(self):
        summary = self.summary("--stage", "functional-design", "--unit", "u1-core", "--no-brief")
        gate = self.gate()
        self.assertEqual(summary["documents"], ["entities", "rules", "functional-spec", "traceability"])
        self.assertEqual(gate["title"], "Functional Design \u00b7 u1-core")
        self.assertEqual(gate["unit"], "u1-core")
        self.assertEqual(gate["phase"], "construction")
        self.assertEqual(summary["unit"], "u1-core")
        self.assertRegex(summary["id"], r"^260101-bakery-preorder-functional-design-u1-core-\d{8}T\d{4}$")
        self.assertIn("construction/u1-core/functional-design/", self.document("rules")["path"])

    def test_summary_file(self):
        path = os.path.join(self.tmp, "summary.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write("## Summary\n\nTwo stories, one open question.\n")
        self.summary("--stage", "user-stories", "--no-brief", "--summary-file", path)
        self.assertEqual(self.gate()["summary"], "## Summary\n\nTwo stories, one open question.")

    def test_missing_summary_file_is_an_error(self):
        code, _out, err = self.run_script("--stage", "user-stories", "--no-brief", "--summary-file", "/no/such/file")
        self.assertEqual(code, 1)
        self.assertIn("summary file", err)

    def test_stage_names(self):
        self.assertEqual(bundle.stage_name("nfr-design", None), "NFR Design")
        self.assertEqual(bundle.stage_name("ci-pipeline", None), "CI Pipeline")
        self.assertEqual(bundle.stage_name("user-stories", None), "User Stories")
        self.assertEqual(bundle.stage_name("user-stories", {"name": "Stories, Of Users"}), "Stories, Of Users")

    def test_long_document_is_truncated(self):
        path = os.path.join(record(self.project), "inception", "user-stories", "personas.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write("x" * 250_000)
        self.summary("--stage", "user-stories", "--no-brief")
        text = self.document("personas")["text"]
        self.assertTrue(text.startswith("x" * 1000))
        self.assertTrue(text.endswith("\n\u2026 (truncated, 50000 bytes more; open the file)"), text[-80:])
        self.assertLess(len(text.encode("utf-8")), 200_100)
        index = {d["key"]: d for d in self.gate()["documents"]}
        self.assertEqual(index["personas"]["bytes"], 250_000)

    def test_hidden_and_lock_files_are_skipped(self):
        folder = os.path.join(record(self.project), "inception", "user-stories")
        for name in (".hidden.md", "notes.md.lock", "readme.txt"):
            with open(os.path.join(folder, name), "w", encoding="utf-8") as f:
                f.write("x")
        summary = self.summary("--stage", "user-stories", "--no-brief")
        self.assertNotIn(".hidden", " ".join(summary["documents"]))
        self.assertEqual(len(summary["documents"]), 5)


class TestWrites(Case):
    def test_writes_json_shape(self):
        summary = self.summary("--stage", "user-stories", "--no-brief")
        with open(summary["writes"], encoding="utf-8") as f:
            writes = json.load(f)
        self.assertEqual(summary["writes"], os.path.join(self.out, "writes.json"))
        self.assertEqual(summary["batches"], [summary["writes"]])
        self.assertEqual(len(writes), 1 + 5)
        gate_id = summary["id"]
        self.assertEqual(writes[0], {"op": "set", "collection": "gates", "doc_id": gate_id,
                                     "file_path": os.path.join(self.out, "gate.json")})
        for write, key in zip(writes[1:], summary["documents"]):
            self.assertEqual(write, {"op": "set", "collection": "gates/%s/documents" % gate_id, "doc_id": key,
                                     "file_path": os.path.join(self.out, "documents", key + ".json")})
        for write in writes:
            self.assertNotIn("if_version", write)
            self.assertTrue(os.path.isabs(write["file_path"]))
            self.assertTrue(os.path.isfile(write["file_path"]))

    def test_many_documents_are_split_into_batches(self):
        folder = os.path.join(record(self.project), "inception", "delivery-planning")
        for n in range(60):
            with open(os.path.join(folder, "extra-%02d.md" % n), "w", encoding="utf-8") as f:
                f.write("# Extra %d\n" % n)
        code, out, err = self.run_script("--stage", "delivery-planning", "--no-brief")
        self.assertEqual(code, 0, err)
        summary = json.loads(out)
        self.assertEqual(len(summary["batches"]), 2)
        self.assertIn("do not fit one batch", err)
        with open(summary["writes"], encoding="utf-8") as f:
            everything = json.load(f)
        self.assertEqual(len(everything), 62)
        parts = []
        for path in summary["batches"]:
            with open(path, encoding="utf-8") as f:
                parts.append(json.load(f))
        self.assertEqual([len(p) for p in parts], [50, 12])
        self.assertEqual(parts[0] + parts[1], everything)
        self.assertEqual(parts[0][0]["collection"], "gates")  # the gate row opens the first batch


class TestRound(Case):
    def audit(self, *entries):
        with open(os.path.join(record(self.project), "audit", "session-b.md"), "w", encoding="utf-8") as f:
            f.write("# Audit\n")
            for stage, unit in entries:
                f.write("\n## Gate Rejected\n**Timestamp**: 2026-01-01T10:00:00Z\n**Event**: GATE_REJECTED\n"
                        "**Stage**: %s\n" % stage)
                if unit:
                    f.write("**Unit**: %s\n" % unit)
                f.write("**Feedback**: fix it\n\n---\n")

    def test_round_counts_rejections_of_this_stage(self):
        self.audit(("user-stories", None), ("user-stories", None), ("delivery-planning", None))
        summary = self.summary("--stage", "user-stories", "--no-brief")
        self.assertEqual(summary["round"], 3)
        self.assertEqual(self.gate()["round"], 3)
        self.assertEqual(self.gate()["why"], "revision")

    def test_explicit_why_wins(self):
        self.audit(("user-stories", None))
        self.summary("--stage", "user-stories", "--no-brief", "--why", "stale")
        self.assertEqual(self.gate()["why"], "stale")
        self.assertEqual(self.gate()["round"], 2)

    def test_round_one_without_rejections(self):
        self.summary("--stage", "user-stories", "--no-brief")
        self.assertEqual(self.gate()["round"], 1)
        self.assertEqual(self.gate()["why"], "first")

    def test_unit_rounds_are_counted_per_unit(self):
        self.audit(("functional-design", "u1-core"), ("functional-design", "u2-other"), ("functional-design", None))
        summary = self.summary("--stage", "functional-design", "--unit", "u1-core", "--no-brief")
        self.assertEqual(summary["round"], 2)

    def test_approvals_are_not_rejections(self):
        self.assertEqual(bundle.count_rejections(record(self.project), "requirements-analysis", None), 0)


class TestBrief(Case):
    def test_brief_comes_from_the_review_brief_command(self):
        fake = self.fake_aidlc('printf "**Stage:** User Stories\\nargs: %s\\n" "$*"')
        self.summary("--stage", "user-stories", aidlc=fake)
        brief = self.gate()["brief"]
        self.assertIn("args: engine review-brief review --stage user-stories --why first", brief)
        self.assertTrue(brief.startswith("**Stage:** User Stories"))

    def test_brief_gets_unit_and_why(self):
        fake = self.fake_aidlc('echo "$*"')
        self.summary("--stage", "functional-design", "--unit", "u1-core", "--why", "revision", aidlc=fake)
        self.assertEqual(self.gate()["brief"],
                         "engine review-brief review --stage functional-design --unit u1-core --why revision")

    def test_brief_runs_in_the_project_directory(self):
        fake = self.fake_aidlc("pwd")
        self.summary("--stage", "user-stories", aidlc=fake)
        self.assertEqual(os.path.realpath(self.gate()["brief"]), os.path.realpath(self.project))

    def test_brief_is_left_out_when_the_command_fails(self):
        fake = self.fake_aidlc("echo broken >&2; exit 3")
        code, out, err = self.run_script("--stage", "user-stories", aidlc=fake)
        self.assertEqual(code, 0)
        self.assertNotIn("brief", self.gate())
        self.assertIn("review brief was left out", err)
        self.assertIn("exit 3", err)

    def test_brief_is_left_out_when_the_program_is_missing(self):
        code, _out, err = self.run_script("--stage", "user-stories", aidlc=os.path.join(self.tmp, "nothing-here"))
        self.assertEqual(code, 0)
        self.assertNotIn("brief", self.gate())
        self.assertIn("review brief was left out", err)

    def test_no_brief_flag(self):
        fake = self.fake_aidlc("echo should-not-run")
        self.summary("--stage", "user-stories", "--no-brief", aidlc=fake)
        self.assertNotIn("brief", self.gate())

    def test_no_brief_for_a_stage_without_a_reviewer(self):
        fake = self.fake_aidlc("echo should-not-run")
        self.summary("--stage", "delivery-planning", aidlc=fake)
        self.assertNotIn("brief", self.gate())


class TestErrors(Case):
    def test_missing_stage_folder(self):
        code, out, err = self.run_script("--stage", "no-such-stage", "--no-brief")
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("stage folder not found", err)
        self.assertIn("no-such-stage", err)
        self.assertFalse(os.path.exists(os.path.join(self.out, "writes.json")))

    def test_missing_unit_folder(self):
        code, _out, err = self.run_script("--stage", "functional-design", "--unit", "u9-none", "--no-brief")
        self.assertEqual(code, 1)
        self.assertIn("u9-none", err)

    def test_not_an_aidlc_project(self):
        empty = os.path.join(self.tmp, "empty")
        os.makedirs(empty)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = bundle.main(["--project-dir", empty, "--stage", "user-stories", "--out", self.out])
        self.assertEqual(code, 1)
        self.assertIn("no active space", err.getvalue())

    def test_project_dir_falls_back_to_the_environment(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": self.project}), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = bundle.main(["--stage", "user-stories", "--no-brief", "--out", self.out])
        self.assertEqual(code, 0, err.getvalue())
        self.assertEqual(json.loads(out.getvalue())["stage"], "user-stories")

    def test_empty_stage_folder(self):
        os.makedirs(os.path.join(record(self.project), "inception", "empty-stage"))
        code, _out, err = self.run_script("--stage", "empty-stage", "--no-brief")
        self.assertEqual(code, 1)
        self.assertIn("no document", err)


class TestWithoutGraph(Case):
    def setUp(self):
        super().setUp()
        shutil.rmtree(os.path.join(self.project, ".claude"))

    def test_works_without_the_stage_graph(self):
        summary = self.summary("--stage", "user-stories", "--no-brief")
        gate = self.gate()
        self.assertEqual(gate["stageName"], "User Stories")
        self.assertEqual(gate["phase"], "inception")  # found by looking for the folder
        self.assertEqual(gate["nextStage"], "Delivery Planning")
        # no `produces` order: every file by name, then the review
        self.assertEqual(summary["documents"],
                         ["personas", "stories", "traceability", "user-stories-questions", "review-02"])

    def test_unit_stage_without_the_graph(self):
        self.summary("--stage", "functional-design", "--unit", "u1-core", "--no-brief")
        self.assertEqual(self.gate()["stageName"], "Functional Design")

    def test_reviews_folder_means_a_reviewer(self):
        fake = self.fake_aidlc("echo brief-text")
        self.summary("--stage", "user-stories", aidlc=fake)
        self.assertEqual(self.gate()["brief"], "brief-text")

    def test_no_reviews_folder_means_no_brief(self):
        fake = self.fake_aidlc("echo brief-text")
        self.summary("--stage", "delivery-planning", aidlc=fake)
        self.assertNotIn("brief", self.gate())

    def test_fixture_graph_is_trimmed_to_a_few_stages(self):
        with open(os.path.join(FIXTURE, ".claude", "tools", "data", "stage-graph.json"), encoding="utf-8") as f:
            graph = json.load(f)
        self.assertEqual([s["slug"] for s in graph],
                         ["user-stories", "delivery-planning", "functional-design", "code-generation"])
        for stage in graph:
            self.assertRegex(stage["number"], r"^\d\.\d$")


class TestHelpers(unittest.TestCase):
    def test_slugify_and_humanize(self):
        self.assertEqual(bundle.slugify("User Stories_Q1"), "user-stories_q1")
        self.assertEqual(bundle.humanize("user-stories-questions"), "User Stories Questions")
        self.assertEqual(bundle.humanize("nfr-design"), "NFR Design")
        self.assertEqual(bundle.humanize("review-02"), "Review 02")

    def test_parse_review(self):
        text = "## Review\n\n**Verdict:** NOT-READY\n**Reviewer:** some-agent\n**Iteration:** 3\n"
        self.assertEqual(bundle.parse_review(text), {"verdict": "NOT-READY", "reviewer": "some-agent", "iteration": 3})
        self.assertEqual(bundle.parse_review("nothing here"), {})

    def test_cut_keeps_whole_characters(self):
        text = "\u00e9" * 150_000  # two bytes each
        out = bundle.cut(text)
        self.assertIn("truncated", out)
        self.assertRegex(out, r"\(truncated, \d+ bytes more; open the file\)$")
        self.assertEqual(bundle.cut("short"), "short")

    def test_batches_respect_both_limits(self):
        writes = list(range(120))
        self.assertEqual([len(b) for b in bundle.batches_of(writes, [1] * 120)], [50, 50, 20])
        self.assertEqual([len(b) for b in bundle.batches_of(writes[:4], [400_000] * 4)], [2, 2])
        self.assertEqual(bundle.batches_of([], []), [])

    def test_id_pattern_is_the_documented_one(self):
        self.assertEqual(bundle.slugify("260101-Bakery_Preorder"), "260101-bakery_preorder")
        self.assertIsNotNone(re.fullmatch(r"[a-z0-9._-]+", bundle.slugify("260101-Bakery Preorder")))


if __name__ == "__main__":
    unittest.main()
