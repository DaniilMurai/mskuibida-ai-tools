"""Tests for scripts/check-versions.py, run against throwaway git repos.

    python3 -m unittest discover scripts/tests
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "check-versions.py"


class Repo:
    """A throwaway repo with a marketplace and plugins, on a `main` branch."""

    def __init__(self, root):
        self.root = Path(root)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "T")
        self.git("config", "commit.gpgsign", "false")
        self.write(".claude-plugin/marketplace.json", {"name": "m", "version": "1.0.0", "plugins": []})

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def write(self, rel, content):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content, indent=2) if isinstance(content, dict) else content)

    def add_plugin(self, name, version="1.0.0", market_version=None):
        """Create the plugin dir and its marketplace entry (market_version defaults to version)."""
        self.write(f"plugins/{name}/.claude-plugin/plugin.json", {"name": name, "version": version})
        self.write(f"plugins/{name}/hooks/run.sh", "echo hi\n")
        self.set_market(name, market_version or version)

    def set_market(self, name, version):
        path = self.root / ".claude-plugin/marketplace.json"
        market = json.loads(path.read_text())
        market["plugins"] = [e for e in market["plugins"] if e["name"] != name]
        market["plugins"].append({"name": name, "source": f"./plugins/{name}", "version": version})
        self.write(".claude-plugin/marketplace.json", market)

    def set_version(self, name, version):
        self.write(f"plugins/{name}/.claude-plugin/plugin.json", {"name": name, "version": version})
        self.set_market(name, version)

    def market(self):
        return json.loads((self.root / ".claude-plugin/marketplace.json").read_text())

    def set_market_version(self, version):
        """Set the marketplace's top-level version; None removes it."""
        market = self.market()
        market.pop("version", None)
        if version is not None:
            market["version"] = version
        self.write(".claude-plugin/marketplace.json", market)

    def commit(self, message="c"):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def branch(self):
        """Mark the current commit as the base and move to a feature branch."""
        self.git("checkout", "-q", "-b", "feature")

    def check(self, *args):
        p = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), *args],
                           capture_output=True, text=True)
        return p.returncode, p.stdout


class CheckVersionsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Repo(tmp.name)
        self.repo.add_plugin("alpha")
        self.repo.commit("base")
        self.repo.branch()

    def assertOk(self, *args):
        rc, out = self.repo.check(*args)
        self.assertEqual(rc, 0, out)
        self.assertIn("OK", out)

    def assertFails(self, mentions, *args):
        rc, out = self.repo.check(*args)
        self.assertEqual(rc, 1, out)
        for text in mentions:
            self.assertIn(text, out)

    # consistency

    def test_consistent_is_ok(self):
        self.assertOk()

    def test_marketplace_mismatch_fails(self):
        self.repo.set_market("alpha", "1.1.0")
        self.assertFails(["alpha", "1.0.0", "1.1.0"])

    def test_plugin_dir_without_marketplace_entry_fails(self):
        self.repo.add_plugin("orphan")
        self.repo.write(".claude-plugin/marketplace.json", {"name": "m", "version": "1.0.0", "plugins": []})
        self.assertFails(["orphan", "no entry"])

    def test_marketplace_entry_without_plugin_json_fails(self):
        self.repo.set_market("ghost", "1.0.0")
        self.assertFails(["ghost", "no plugins/ghost"])

    def test_marketplace_without_version_fails(self):
        self.repo.set_market_version(None)
        self.assertFails(["marketplace", "top-level version", "not valid semver"])

    def test_marketplace_with_invalid_version_fails(self):
        self.repo.set_market_version("v1")
        self.assertFails(["marketplace", "'v1'", "not valid semver"])

    # bump guard

    def edit_code(self):
        self.repo.write("plugins/alpha/hooks/run.sh", "echo changed\n")
        self.repo.commit("code")

    def test_code_change_without_bump_fails(self):
        self.edit_code()
        self.assertFails(["alpha", "1.0.0", "bump version in plugins/alpha/.claude-plugin/plugin.json"],
                         "--base", "main")

    def test_code_change_with_bump_is_ok(self):
        self.edit_code()
        self.repo.set_version("alpha", "1.0.1")
        self.repo.set_market_version("1.0.1")
        self.repo.commit("bump")
        self.assertOk("--base", "main")

    def test_lowered_version_fails(self):
        self.edit_code()
        self.repo.set_version("alpha", "0.9.0")
        self.repo.commit("lower")
        self.assertFails(["alpha", "1.0.0 -> 0.9.0", "not higher"], "--base", "main")

    def test_invalid_semver_fails(self):
        self.edit_code()
        self.repo.set_version("alpha", "v2")
        self.repo.commit("bad")
        self.assertFails(["alpha", "not valid semver"], "--base", "main")

    def test_prerelease_is_below_its_release(self):
        self.repo.set_version("alpha", "2.0.0")
        self.repo.commit("release")
        self.repo.git("checkout", "-q", "-B", "main")
        self.repo.git("checkout", "-q", "-b", "next")
        self.edit_code()
        self.repo.set_version("alpha", "2.0.0-rc.1")
        self.repo.commit("pre")
        self.assertFails(["2.0.0 -> 2.0.0-rc.1"], "--base", "main")

    def test_readme_only_needs_no_bump(self):
        self.repo.write("plugins/alpha/README.md", "docs\n")
        self.repo.commit("docs")
        self.assertOk("--base", "main")

    def test_tests_and_evals_only_need_no_bump(self):
        self.repo.write("plugins/alpha/tests/t.sh", "true\n")
        self.repo.write("plugins/alpha/skills/x/evals/e.md", "eval\n")
        self.repo.commit("tests")
        self.assertOk("--base", "main")

    def test_skill_markdown_still_needs_a_bump(self):
        self.repo.write("plugins/alpha/skills/x/SKILL.md", "skill\n")
        self.repo.commit("skill")
        self.assertFails(["alpha", "1.0.0"], "--base", "main")

    def test_exempt_plus_code_change_still_needs_a_bump(self):
        self.repo.write("plugins/alpha/README.md", "docs\n")
        self.edit_code()
        self.assertFails(["alpha"], "--base", "main")

    def test_new_plugin_is_ok(self):
        self.repo.add_plugin("beta")
        self.repo.set_market_version("1.1.0")
        self.repo.commit("new")
        self.assertOk("--base", "main")

    # marketplace bump guard

    def test_plugin_bump_without_marketplace_bump_fails(self):
        self.edit_code()
        self.repo.set_version("alpha", "1.0.1")
        self.repo.commit("bump plugin only")
        self.assertFails(["marketplace", "plugin versions changed: alpha", "still 1.0.0",
                          "bump the top-level version in .claude-plugin/marketplace.json"],
                         "--base", "main")

    def test_new_plugin_without_marketplace_bump_fails(self):
        self.repo.add_plugin("beta")
        self.repo.commit("new")
        self.assertFails(["marketplace", "plugin versions changed: beta"], "--base", "main")

    def test_removed_plugin_without_marketplace_bump_fails(self):
        self.repo.write(".claude-plugin/marketplace.json", {"name": "m", "version": "1.0.0", "plugins": []})
        self.repo.git("rm", "-rq", "plugins/alpha")
        self.repo.commit("remove")
        self.assertFails(["marketplace", "plugin versions changed: alpha"], "--base", "main")

    def test_description_change_without_marketplace_bump_fails(self):
        market = self.repo.market()
        market["description"] = "new words"
        self.repo.write(".claude-plugin/marketplace.json", market)
        self.repo.commit("describe")
        self.assertFails(["marketplace", "its entries changed", "still 1.0.0"], "--base", "main")

    def test_lowered_marketplace_version_fails(self):
        self.edit_code()
        self.repo.set_version("alpha", "1.0.1")
        self.repo.set_market_version("0.9.0")
        self.repo.commit("lower")
        self.assertFails(["marketplace", "1.0.0 -> 0.9.0", "not higher"], "--base", "main")

    def test_marketplace_bump_alone_is_ok(self):
        self.repo.set_market_version("1.0.1")
        self.repo.commit("bump marketplace only")
        self.assertOk("--base", "main")

    def test_change_outside_plugins_needs_no_marketplace_bump(self):
        self.repo.write("README.md", "docs\n")
        self.repo.write("scripts/x.py", "pass\n")
        self.repo.commit("repo docs and scripts")
        self.assertOk("--base", "main")

    def test_base_without_marketplace_version_needs_only_a_valid_one(self):
        # The PR that introduces the marketplace version has nothing to bump from.
        self.repo.git("checkout", "-q", "main")
        self.repo.set_market_version(None)
        self.repo.commit("no version")
        self.repo.git("checkout", "-q", "-B", "intro")
        self.repo.set_market_version("1.0.0")
        self.repo.commit("introduce")
        self.assertOk("--base", "main")

    def test_unrelated_plugin_change_is_not_blamed_on_others(self):
        self.repo.add_plugin("beta")
        self.repo.commit("beta")
        self.repo.git("checkout", "-q", "main")
        self.repo.git("merge", "-q", "feature")
        self.repo.git("checkout", "-q", "-b", "next")
        self.repo.write("plugins/beta/hooks/run.sh", "echo changed\n")
        self.repo.commit("beta code")
        rc, out = self.repo.check("--base", "main")
        self.assertEqual(rc, 1, out)
        self.assertIn("beta", out)
        self.assertNotIn("alpha", out)

    def test_unknown_base_fails(self):
        self.assertFails(["merge base"], "--base", "no-such-ref")


if __name__ == "__main__":
    unittest.main()
