"""Tests for scripts/tag-main.py, run against a throwaway repo and a bare remote.

    python3 -m unittest discover scripts/tests
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "tag-main.py"


class TagMainTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.remote = Path(tmp.name) / "remote.git"
        self.root = Path(tmp.name) / "work"
        self.root.mkdir()
        subprocess.run(["git", "init", "-q", "--bare", str(self.remote)], check=True)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "T")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "tag.gpgsign", "false")
        self.git("remote", "add", "origin", str(self.remote))
        self.write("plugins/alpha/.claude-plugin/plugin.json", {"name": "alpha", "version": "1.0.0"})
        self.write("plugins/alpha/hooks/run.sh", "echo hi\n")
        self.set_market(market_version="1.0.0", alpha="1.0.0")
        self.commit("base")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True,
                              text=True).stdout.strip()

    def write(self, rel, content):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content, indent=2) if isinstance(content, dict) else content)

    def set_market(self, market_version, alpha):
        self.write(".claude-plugin/marketplace.json", {
            "name": "m", "version": market_version,
            "plugins": [{"name": "alpha", "source": "./plugins/alpha", "version": alpha}]})
        self.write("plugins/alpha/.claude-plugin/plugin.json", {"name": "alpha", "version": alpha})

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        self.git("push", "-q", "origin", "main")
        return self.git("rev-parse", "HEAD")

    def run_script(self, *args):
        p = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), *args],
                           capture_output=True, text=True)
        return p.returncode, p.stdout + p.stderr

    def remote_tag(self, tag):
        out = subprocess.run(["git", "ls-remote", "--tags", str(self.remote), f"refs/tags/{tag}"],
                             capture_output=True, text=True, check=True).stdout
        return out.split("\t")[0] if out else None

    def test_absent_tag_is_pushed_on_head(self):
        rc, out = self.run_script()
        self.assertEqual(rc, 0, out)
        self.assertIn("TAGGED v1.0.0", out)
        self.assertEqual(self.remote_tag("v1.0.0"), self.git("rev-parse", "HEAD"))

    def test_dry_run_pushes_nothing(self):
        rc, out = self.run_script("--dry-run")
        self.assertEqual(rc, 0, out)
        self.assertIn("DRY-RUN would push v1.0.0", out)
        self.assertIsNone(self.remote_tag("v1.0.0"))

    def test_tag_already_on_head_is_ok(self):
        self.run_script()
        rc, out = self.run_script()
        self.assertEqual(rc, 0, out)
        self.assertIn("already on", out)

    def test_annotated_tag_on_head_is_ok(self):
        self.git("tag", "-a", "v1.0.0", "-m", "first")
        self.git("push", "-q", "origin", "v1.0.0")
        rc, out = self.run_script()
        self.assertEqual(rc, 0, out)
        self.assertIn("already on", out)

    def test_docs_only_commit_keeps_the_tag_where_it_is(self):
        self.run_script()
        first = self.git("rev-parse", "HEAD")
        self.write("README.md", "docs\n")
        self.write("plugins/alpha/tests/t.sh", "true\n")
        self.commit("docs")
        rc, out = self.run_script()
        self.assertEqual(rc, 0, out)
        self.assertIn(f"v1.0.0 stays on {first}", out)
        self.assertEqual(self.remote_tag("v1.0.0"), first)

    def test_new_version_gets_its_own_tag(self):
        self.run_script()
        self.write("plugins/alpha/hooks/run.sh", "echo changed\n")
        self.set_market(market_version="1.1.0", alpha="1.0.1")
        head = self.commit("bump")
        rc, out = self.run_script()
        self.assertEqual(rc, 0, out)
        self.assertIn("TAGGED v1.1.0", out)
        self.assertEqual(self.remote_tag("v1.1.0"), head)

    def test_reused_version_for_changed_plugins_fails_and_does_not_move_the_tag(self):
        self.run_script()
        first = self.git("rev-parse", "HEAD")
        self.write("plugins/alpha/hooks/run.sh", "echo changed\n")
        self.set_market(market_version="1.0.0", alpha="1.0.1")
        self.commit("bump plugin, not marketplace")
        rc, out = self.run_script()
        self.assertEqual(rc, 1, out)
        self.assertIn(f"v1.0.0 already points at {first}", out)
        self.assertIn("will not be moved", out)
        self.assertEqual(self.remote_tag("v1.0.0"), first)

    def test_unbumped_plugin_change_fails(self):
        self.run_script()
        self.write("plugins/alpha/hooks/run.sh", "echo changed\n")
        self.commit("code, no bump")
        rc, out = self.run_script()
        self.assertEqual(rc, 1, out)
        self.assertIn("alpha", out)

    def test_tag_on_a_commit_off_main_fails(self):
        self.git("checkout", "-q", "-b", "side")
        self.write("other.txt", "x\n")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "side")
        side = self.git("rev-parse", "HEAD")
        self.git("push", "-q", "origin", "HEAD:refs/tags/v1.0.0")
        self.git("checkout", "-q", "main")
        rc, out = self.run_script()
        self.assertEqual(rc, 1, out)
        self.assertIn("is not an ancestor of", out)
        self.assertEqual(self.remote_tag("v1.0.0"), side)

    def test_invalid_version_fails(self):
        self.set_market(market_version="v1", alpha="1.0.0")
        self.commit("bad")
        rc, out = self.run_script()
        self.assertEqual(rc, 1, out)
        self.assertIn("not valid semver", out)


if __name__ == "__main__":
    unittest.main()
