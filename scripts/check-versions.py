#!/usr/bin/env python3
"""Keep plugin versions honest: consistent everywhere, and bumped when users would get a change.

Claude Code delivers a plugin update only when its version string changes, so a user-facing
change merged without a bump never reaches anyone.

  check-versions.py                 plugin.json and marketplace.json agree, for every plugin
  check-versions.py --base <ref>    ...and every plugin changed since <ref> has a higher version

Exits 1 and prints one line per failure; prints a short OK summary otherwise.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# Changes that users gain nothing from, so they do not need a version bump. A change
# is exempt only if every file it touches is in a directory named here or is named here.
# Note: not "*.md" -- skills, agents and output styles are markdown and are the product.
EXEMPT_DIRS = {"tests", "evals"}
EXEMPT_FILES = {"README.md", "CHANGELOG.md"}

PLUGIN_JSON = ".claude-plugin/plugin.json"
SEMVER = re.compile(
    r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$"
)


def parse_semver(text):
    """Return a sortable key for a semver string, or None if it is not valid semver."""
    m = SEMVER.match(text) if isinstance(text, str) else None
    if not m:
        return None
    core = tuple(int(x) for x in m.groups()[:3])
    # A release outranks its own prereleases; numeric identifiers rank below alphanumeric.
    pre = m.group(4)
    pre_key = (1,) if pre is None else (
        0, [(0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")])
    return core, pre_key


def git(root, *args):
    p = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    return p.returncode, p.stdout


def read_json(path):
    return json.loads(Path(path).read_text())


def check_consistency(root):
    """Return (failures, plugin names)."""
    failures = []
    entries = {e["name"]: e for e in read_json(root / ".claude-plugin/marketplace.json")["plugins"]}
    on_disk = sorted(p.parent.parent.name for p in root.glob(f"plugins/*/{PLUGIN_JSON}"))
    for name, entry in sorted(entries.items()):
        if not str(entry.get("source", "")).startswith("./plugins/"):
            continue
        path = root / "plugins" / name / PLUGIN_JSON
        if not path.exists():
            failures.append(f"{name}: marketplace entry has no plugins/{name}/{PLUGIN_JSON}")
        elif read_json(path).get("version") != entry.get("version"):
            failures.append(
                f"{name}: plugin.json says {read_json(path).get('version')} but marketplace.json "
                f"says {entry.get('version')} -- make them equal in plugins/{name}/{PLUGIN_JSON} "
                f"and the marketplace entry")
    for name in on_disk:
        if name not in entries:
            failures.append(f"{name}: plugins/{name} has no entry in .claude-plugin/marketplace.json")
    return failures, on_disk


def needs_bump(rel_path):
    """True if a file path (relative to its plugin dir) is something users receive."""
    parts = Path(rel_path).parts
    return not (set(parts[:-1]) & EXEMPT_DIRS or parts[-1] in EXEMPT_FILES)


def check_bumps(root, base, plugins):
    failures = []
    rc, out = git(root, "merge-base", base, "HEAD")
    if rc:
        return [f"cannot find a merge base between {base} and HEAD (is the history fetched?)"]
    fork = out.strip()
    rc, out = git(root, "diff", "--name-only", f"{base}...HEAD")
    changed = out.splitlines()
    for name in plugins:
        prefix = f"plugins/{name}/"
        if not any(needs_bump(f[len(prefix):]) for f in changed if f.startswith(prefix)):
            continue
        rc, old_json = git(root, "show", f"{fork}:{prefix}{PLUGIN_JSON}")
        if rc:
            continue  # new plugin: nothing to bump from
        old = json.loads(old_json).get("version")
        new = read_json(root / "plugins" / name / PLUGIN_JSON).get("version")
        fix = f"bump version in plugins/{name}/{PLUGIN_JSON} and the marketplace entry"
        if new == old:
            failures.append(f"{name}: changed since {base} but still at {old} -- {fix}")
        elif parse_semver(new) is None:
            failures.append(f"{name}: version {new!r} (was {old}) is not valid semver -- {fix}")
        elif parse_semver(old) is not None and parse_semver(new) <= parse_semver(old):
            failures.append(f"{name}: version went {old} -> {new}, which is not higher -- {fix}")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--base", help="git ref to compare against (e.g. origin/main)")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent,
                        help="repo root (default: this script's repo)")
    args = parser.parse_args()

    failures, plugins = check_consistency(args.root)
    if args.base:
        failures += check_bumps(args.root, args.base, plugins)
    for line in failures:
        print(f"FAIL {line}")
    if failures:
        return 1
    guard = f"; bump guard vs {args.base} passed" if args.base else ""
    print(f"OK {len(plugins)} plugins consistent{guard}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
