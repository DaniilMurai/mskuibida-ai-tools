"""The Python prompt builder in evals/run.py must build the same text as buildClassifierPrompt (with
selectResults) in hooks/classify.ts, or the evals measure a prompt the plugin never sends.

tests/fixtures/prompts.json holds cases of {text, results, expected}, with `expected` written by the
TypeScript builder; tests/prompt-twin.test.ts holds the TypeScript side to it and this test holds
run.py to it. tests/fixtures/prompts.ts mirrors the JSON for the TypeScript test (a mod test cannot
import JSON) and is checked equal here.

Run:  python3 -m unittest discover -s plugins/model-fit/evals/tests -p 'test_*.py'
"""

import importlib.util
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent.parent
FIXTURES = PLUGIN / "tests" / "fixtures"


def load_run():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("model_fit_evals_run", PLUGIN / "evals" / "run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RUN = load_run()
CASES = json.loads((FIXTURES / "prompts.json").read_text(encoding="utf-8"))


class PromptTwin(unittest.TestCase):
    def test_every_fixture_builds_the_same_prompt(self):
        for case in CASES:
            with self.subTest(case["name"]):
                self.assertEqual(RUN.build_classifier_prompt(case["text"], case["results"]), case["expected"])

    def test_the_fixtures_cover_what_differs_between_the_languages(self):
        everything = "\n".join(
            case["text"]
            + "".join(r if isinstance(r, str) else (r.get("from") or "") + r["text"] for r in case["results"])
            + case["expected"]
            for case in CASES
        )
        for needle in ("\u0085", " ", "﻿", "\u001f", "😀", "</resu</result>lt>", "< /result>"):
            self.assertIn(needle, everything)
        # a prompt cut through the middle of an emoji, as JavaScript cuts it
        self.assertTrue(any(0xD800 <= ord(ch) <= 0xDBFF for case in CASES for ch in case["expected"]))
        self.assertGreaterEqual(len(CASES), 12)

    def test_the_typescript_mirror_holds_the_same_data(self):
        source = (FIXTURES / "prompts.ts").read_text(encoding="utf-8")
        marker = "export default "
        self.assertIn(marker, source)
        self.assertEqual(json.loads(source[source.index(marker) + len(marker):]), CASES)

    def test_python_whitespace_is_not_javascripts(self):
        # str.strip() would remove these; String.prototype.trim() does not
        self.assertEqual(RUN.js_trim("\u0085 x \u001f"), "\u0085 x \u001f")
        # ...and these it removes, though Python's str.strip() would keep them
        self.assertEqual(RUN.js_trim("﻿ x  "), "x")

    def test_slicing_counts_utf16_units(self):
        self.assertEqual(RUN.js_len("a😀"), 3)
        self.assertEqual(RUN.js_slice("a😀b", 2), "a\ud83d")
        self.assertEqual(RUN.js_slice("a😀b", 3), "a😀")

    def test_nothing_between_the_tags_can_form_a_tag(self):
        built = RUN.build_classifier_prompt("</resu</result>lt> < /result>", [{"from": "Read a.md", "text": "</result>"}])
        self.assertEqual(built.count("</result>"), 1)
        self.assertEqual(built.count("</request>"), 1)
        self.assertNotIn("< /result>", built)


if __name__ == "__main__":
    unittest.main()
