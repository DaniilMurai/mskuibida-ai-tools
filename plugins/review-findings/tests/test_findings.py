"""Tests for scripts/findings.py.
Run: python3 -m unittest discover -s plugins/review-findings/tests"""

import contextlib
import datetime
import importlib.util
import io
import json
import os
import re
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")


def load(name, *parts):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "..", *parts))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


findings = load("findings", "scripts", "findings.py")


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return f.read()


def by_id(doc):
    return {f["id"]: f for f in doc["findings"]}


class ParseBrief(unittest.TestCase):
    def setUp(self):
        self.doc = findings.parse_brief(fixture("brief-open.txt"), "domain-design")

    def test_open_findings_only(self):
        self.assertEqual([f["id"] for f in self.doc["findings"]], ["R-02", "R-03"])
        self.assertEqual(findings.counts(self.doc), (2, 1))

    def test_blocking_is_critical_or_major(self):
        found = by_id(self.doc)
        self.assertTrue(found["R-02"]["blocking"])
        self.assertFalse(found["R-03"]["blocking"])
        self.assertEqual((found["R-02"]["severity"], found["R-03"]["status"]), ("Major", "Unresolved"))

    def test_quotes_hydrate_the_rows(self):
        found = by_id(self.doc)["R-02"]
        self.assertEqual(found["where"], "domain-model.md > Cart aggregate, invariants list")  # not the cut table cell
        self.assertTrue(found["finding"].startswith("The `Cart` rule `checkout | expire` is ambiguous."))
        self.assertIn("A reader cannot tell what happens to reserved stock.", found["finding"])  # a second line
        self.assertEqual(found["action"], "State the winning event.\nAdd one line on what happens to reserved stock.")

    def test_a_finding_without_quotes_keeps_the_table_cell(self):
        found = by_id(self.doc)["R-03"]
        self.assertEqual(found["where"], "domain-model.md > Events")
        self.assertEqual(found["action"], "")
        self.assertTrue(found["finding"].startswith("The Events table lists"))

    def test_header_lines(self):
        self.assertEqual(self.doc["stage_name"], "Domain Design")
        self.assertEqual(self.doc["stage"], "domain-design")
        self.assertEqual(self.doc["artifact"],
                         "aidlc/spaces/default/intents/260101-demo-shop/inception/domain-design/domain-model.md")
        self.assertEqual(findings.parse_brief(fixture("brief-open.txt"))["stage"], "domain-design")  # slug of the name

    def test_no_open_findings(self):
        doc = findings.parse_brief(fixture("brief-none.txt"), "domain-design")
        self.assertEqual(doc["findings"], [])  # Accepted risk, Resolved and Rejected: <reason> are closed
        self.assertEqual(findings.counts(doc), (0, 0))

    def test_not_a_brief(self):
        self.assertEqual(findings.parse_brief("ok\n")["findings"], [])


class ParseReview(unittest.TestCase):
    def test_six_column_table(self):
        doc = findings.parse_review(fixture("review-07.md"), "domain-design")
        self.assertEqual([f["id"] for f in doc["findings"]], ["R-01", "R-03"])  # R-02 is Resolved
        first = doc["findings"][0]
        self.assertEqual((first["severity"], first["where"]), ("Critical", "domain-model.md > Payment"))
        self.assertEqual(first["action"], "Add an idempotency key to the capture command.")
        self.assertTrue(first["blocking"])
        self.assertEqual((doc["verdict"], doc["reviewer"], doc["iteration"]), ("NOT-READY", "aidlc-architect-agent", "2"))


class ParseReport(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(FIXTURES, "report-findings.json"), encoding="utf-8") as f:
            self.doc = findings.parse_report(json.load(f))

    def test_ids_and_blocking(self):
        self.assertEqual([f["id"] for f in self.doc["findings"]], ["F-01", "F-02", "F-03"])
        self.assertEqual([f["blocking"] for f in self.doc["findings"]], [True, False, False])
        self.assertEqual(self.doc["source"], "code-review")
        self.assertEqual(findings.counts(self.doc), (3, 1))

    def test_fields(self):
        first = self.doc["findings"][0]
        self.assertEqual((first["where"], first["severity"], first["title"]), ("src/cart.py:42", "Confirmed", "Discount applied before tax"))
        self.assertIn("108 instead of 110", first["scenario"])
        self.assertEqual(self.doc["findings"][2]["severity"], "Unrated")  # no verdict

    def test_list_input_and_empty(self):
        self.assertEqual(findings.parse_report([])["findings"], [])
        self.assertEqual(findings.parse_report({"findings": []})["findings"], [])
        self.assertEqual(len(findings.parse_report([{"file": "a.py", "summary": "x"}])["findings"]), 1)


class Summary(unittest.TestCase):
    def test_block(self):
        text = findings.summary(findings.parse_brief(fixture("brief-open.txt"), "domain-design"))
        lines = text.splitlines()
        self.assertEqual(lines[0], "**Review findings — Domain Design:** 2 open, 1 blocking")
        self.assertEqual(lines[1], "| ID | Severity | Where | Finding |")
        self.assertEqual(lines[2], "|---|---|---|---|")
        self.assertTrue(lines[3].startswith("| R-02 | Major | domain-model.md > Cart aggregate, invariants list |"))
        self.assertEqual(len(lines), 5)

    def test_pipes_are_escaped(self):
        text = findings.summary(findings.parse_brief(fixture("brief-open.txt"), "domain-design"))
        self.assertIn("`checkout \\| expire`", text)
        for row in text.splitlines()[3:]:
            self.assertEqual(len(re.split(r"(?<!\\)\|", row.strip())), 6)  # 4 cells between 5 bars

    def test_first_sentence_and_truncation(self):
        doc = {"source": "aidlc", "stage_name": "X", "findings": [
            {"id": "R-01", "severity": "Minor", "where": "w" * 200, "finding": "A" * 300 + ". Second.", "blocking": False}]}
        row = findings.summary(doc).splitlines()[3]
        cells = [c.strip() for c in row.strip("|").split("|")]
        self.assertEqual(len(cells[3]), 140)
        self.assertTrue(cells[3].endswith("…"))
        self.assertEqual(len(cells[2]), 80)
        self.assertEqual(findings.first_sentence("One. Two.", 140), "One.")
        self.assertEqual(findings.first_sentence("See requirements.md for more. Two.", 140), "See requirements.md for more.")

    def test_code_review_label(self):
        with open(os.path.join(FIXTURES, "report-findings.json"), encoding="utf-8") as f:
            doc = findings.parse_report(json.load(f))
        self.assertTrue(findings.summary(doc).startswith("**Review findings — code review:** 3 open, 1 blocking"))

    def test_none_open(self):
        self.assertEqual(findings.summary({"source": "aidlc", "stage_name": "X", "findings": []}),
                         "**Review findings — X:** 0 open, 0 blocking")


class Triage(unittest.TestCase):
    def test_question_text(self):
        self.assertEqual(findings.question_text(3, 1), "3 review findings are open (1 blocking). What should I do with them?")
        self.assertEqual(findings.question_text(2, 0), "2 review findings are open (none blocking). What should I do with them?")
        self.assertEqual(findings.question_text(1, 1), "1 review finding is open (1 blocking). What should I do with them?")

    def test_options(self):
        blocking = findings.triage(findings.parse_brief(fixture("brief-open.txt"), "domain-design"))["questions"][0]
        self.assertEqual(blocking["header"], "Findings")
        self.assertEqual([o["label"] for o in blocking["options"]], ["Fix", "Open in form"])
        doc = {"source": "aidlc", "findings": [{"id": "R-01", "blocking": False}]}
        self.assertEqual([o["label"] for o in findings.triage(doc)["questions"][0]["options"]], ["Fix", "Accept", "Open in form"])


class Board(unittest.TestCase):
    NOW = datetime.datetime(2026, 1, 5, 10, 7, 59, tzinfo=datetime.timezone.utc)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.doc = findings.parse_brief(fixture("brief-open.txt"), "domain-design")
        self.fid = "260101-demo-shop-domain-design-findings-20260105t1007"

    def made(self):
        findings.board(self.doc, self.fid, "Review findings · Domain Design", self.tmp.name, now=self.NOW)
        return (self.read("forms.json"), self.read("cards", "R-02.json"), self.read("cards", "R-03.json"),
                self.read("writes.json"))

    def read(self, *parts):
        with open(os.path.join(self.tmp.name, *parts), encoding="utf-8") as f:
            return json.load(f)

    def test_form_row(self):
        form = self.made()[0]
        self.assertEqual((form["view"], form["status"], form["createdAt"]), ("board", "open", "2026-01-05T10:07:59Z"))
        self.assertEqual(form["title"], "Review findings · Domain Design")
        self.assertEqual([b["k"] for b in form["boxes"]], ["fix", "accept", "reject"])
        self.assertEqual([b.get("tone") for b in form["boxes"]], ["ink", "muted", "warn"])
        self.assertEqual(form["boxes"][0]["hint"], "Fixed before approval")
        self.assertEqual(form["boxes"][2]["t"], "Reject (reason required)")
        self.assertTrue(form["boxes"][2]["sink"])
        self.assertNotIn("sink", form["boxes"][0])
        self.assertTrue(form["file"].endswith("domain-model.md"))

    def test_cards(self):
        _, blocking, minor, _ = self.made()
        self.assertEqual((blocking["kind"], blocking["n"], minor["n"]), ("card", 1, 2))
        self.assertEqual(blocking["proposed"], {"k": "fix", "why": "Major"})
        self.assertEqual(minor["proposed"], {"k": "accept", "why": "Minor"})
        self.assertEqual(set(blocking["outcomes"]), {"fix", "accept", "reject"})
        self.assertEqual(blocking["from"], "AI review, Major")
        self.assertLessEqual(len(blocking["text"]), 90)
        self.assertEqual(blocking["text"], "The `Cart` rule `checkout | expire` is ambiguous.")

    def test_ctx_blocks_are_separated_by_blank_lines(self):
        _, blocking, minor, _ = self.made()
        blocks = blocking["ctx"].split("\n\n")
        self.assertEqual([b.split(":**")[0] for b in blocks], ["**Where", "**Finding", "**Required action"])
        self.assertEqual([b.split(":**")[0] for b in minor["ctx"].split("\n\n")], ["**Where", "**Finding"])  # no action
        for b in blocks:
            self.assertNotIn("\n\n", b)

    def test_writes_json(self):
        writes = self.made()[3]
        self.assertEqual([(w["op"], w["collection"], w["doc_id"]) for w in writes], [
            ("set", "forms", self.fid),
            ("set", f"forms/{self.fid}/questions", "R-02"),
            ("set", f"forms/{self.fid}/questions", "R-03"),
        ])
        for w in writes:
            self.assertTrue(os.path.isabs(w["file_path"]) and os.path.isfile(w["file_path"]))
            self.assertNotIn("if_version", w)
            self.assertNotIn("data", w)

    def test_code_review_cards(self):
        with open(os.path.join(FIXTURES, "report-findings.json"), encoding="utf-8") as f:
            doc = findings.parse_report(json.load(f))
        findings.board(doc, "code-review-20260105t1007", "Review findings · code review", self.tmp.name, now=self.NOW)
        with open(os.path.join(self.tmp.name, "cards", "F-01.json"), encoding="utf-8") as f:
            card = json.load(f)
        with open(os.path.join(self.tmp.name, "forms.json"), encoding="utf-8") as f:
            form = json.load(f)
        self.assertEqual(card["from"], "Code review, Confirmed, correctness")
        self.assertIn("**What goes wrong:** A cart of 100", card["ctx"])
        self.assertEqual(card["proposed"]["k"], "fix")
        self.assertNotIn("stage", form)

    def test_no_findings_is_an_error(self):
        with self.assertRaises(ValueError):
            findings.board({"source": "aidlc", "findings": []}, "x", "t", self.tmp.name)

    def test_form_id_pattern(self):
        project = os.path.join(FIXTURES, "project")
        self.assertEqual(findings.form_id(self.doc, project, self.NOW), self.fid)
        self.assertEqual(findings.form_id(dict(self.doc, unit="u1-core"), project, self.NOW),
                         "260101-demo-shop-domain-design-u1-core-findings-20260105t1007")
        self.assertEqual(findings.form_id({"source": "code-review"}, project, self.NOW), "code-review-20260105t1007")
        for fid in (self.fid, findings.form_id({"source": "code-review"}, "", self.NOW)):
            self.assertRegex(fid, r"^[a-z0-9._-]+$")


class Cli(unittest.TestCase):
    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = findings.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_parse_summary_board(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, _ = self.run_cli("parse", "--brief", os.path.join(FIXTURES, "brief-open.txt"), "--stage", "domain-design")
            self.assertEqual(code, 0)
            path = os.path.join(tmp, "findings.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write(out)
            self.assertIn("2 open, 1 blocking", self.run_cli("summary", "--findings", path)[1])
            self.assertEqual(json.loads(self.run_cli("question", "--findings", path)[1])["questions"][0]["header"], "Findings")
            code, out, _ = self.run_cli("board", "--findings", path, "--project-dir", os.path.join(FIXTURES, "project"),
                                        "--out", os.path.join(tmp, "board"))
            self.assertEqual(code, 0)
            result = json.loads(out)
            self.assertEqual(result["cards"], 2)
            self.assertRegex(result["id"], r"^260101-demo-shop-domain-design-findings-\d{8}t\d{4}$")
            self.assertTrue(os.path.isfile(result["writes"]))

    def test_a_cut_off_brief_builds_no_form_summary_or_question(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "findings.json")
            code, out, _ = self.run_cli("parse", "--brief", os.path.join(FIXTURES, "brief-cut.txt"), "--stage", "domain-design")
            self.assertEqual(code, 0)
            with open(path, "w", encoding="utf-8") as f:
                f.write(out)
            for argv in (("summary", "--findings", path), ("question", "--findings", path),
                         ("board", "--findings", path, "--out", os.path.join(tmp, "board"))):
                with self.subTest(command=argv[0]):
                    code, out, err = self.run_cli(*argv)
                    self.assertEqual((code, out), (1, ""))
                    self.assertIn("cut off", err)
                    self.assertIn("unpiped as the only command", err)
                    self.assertIn("R-02, R-03", err)
            self.assertFalse(os.path.exists(os.path.join(tmp, "board")))

    def test_board_refuses_a_finding_without_text(self):
        doc = findings.parse_brief(fixture("brief-open.txt"), "domain-design")
        doc["findings"][1]["finding"] = "  "
        with tempfile.TemporaryDirectory() as tmp, self.assertRaisesRegex(ValueError, "cut off.*R-03"):
            findings.board(doc, "x", "t", tmp)

    def test_errors_exit_one(self):
        code, _, err = self.run_cli("summary", "--findings", os.path.join(FIXTURES, "brief-open.txt"))
        self.assertEqual(code, 1)
        self.assertIn("findings.py:", err)


if __name__ == "__main__":
    unittest.main()
