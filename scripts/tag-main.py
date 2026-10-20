#!/usr/bin/env python3
"""Put the tag v<version> on the checked-out commit, from marketplace.json's top-level version.

Consumers pin this marketplace with "ref": "v<version>", so a tag must never move:

  tag absent on the remote              push it, pointing at HEAD
  tag already on HEAD                   nothing to do
  tag on an ancestor of HEAD, and       nothing to do: no plugin and no marketplace entry
    nothing users receive changed         changed since (check-versions.py --base <tag> passes),
    since then                            e.g. a README or CI-only commit
  anything else                         fail: the version was reused for different content

Run by .github/workflows/tag-main.yml on every push to main. Needs full history.

  tag-main.py [--remote origin] [--dry-run]
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARKETPLACE_JSON = ".claude-plugin/marketplace.json"


def load_check_versions():
    """check-versions.py has a dash in its name, so import it by path."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("check_versions", HERE / "check-versions.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(root, *args):
    p = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def remote_tag_commit(root, remote, tag):
    """The commit the remote's tag points at (peeled), None if absent; raises if unreachable."""
    rc, out, err = git(root, "ls-remote", "--tags", remote, f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}")
    if rc:
        raise RuntimeError(f"cannot list tags on {remote}: {err}")
    refs = {}
    for line in out.splitlines():
        sha, ref = line.split("\t")
        refs[ref] = sha
    return refs.get(f"refs/tags/{tag}^{{}}") or refs.get(f"refs/tags/{tag}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--remote", default="origin")
    parser.add_argument("--root", type=Path, default=HERE.parent,
                        help="repo root (default: this script's repo)")
    parser.add_argument("--dry-run", action="store_true", help="say what would happen, push nothing")
    args = parser.parse_args()
    root, remote = args.root, args.remote
    cv = load_check_versions()

    version = json.loads((root / MARKETPLACE_JSON).read_text()).get("version")
    if cv.parse_semver(version) is None:
        print(f"FAIL top-level version {version!r} in {MARKETPLACE_JSON} is not valid semver")
        return 1
    tag = f"v{version}"
    _, head, _ = git(root, "rev-parse", "HEAD")

    try:
        tagged = remote_tag_commit(root, remote, tag)
    except RuntimeError as e:
        print(f"FAIL {e}")
        return 1

    if tagged is None:
        if args.dry_run:
            print(f"DRY-RUN would push {tag} -> {head}")
            return 0
        rc, _, err = git(root, "push", remote, f"{head}:refs/tags/{tag}")
        if rc:
            print(f"FAIL pushing {tag} -> {head}: {err}")
            return 1
        print(f"TAGGED {tag} -> {head}")
        return 0

    if tagged == head:
        print(f"OK {tag} already on {head}")
        return 0

    # The tag is elsewhere. Fine only if HEAD is that commit plus changes users do not receive.
    rc, _, err = git(root, "fetch", "-q", remote, f"refs/tags/{tag}:refs/tags/{tag}")
    if rc:
        print(f"FAIL {tag} is on {tagged}, which cannot be fetched: {err}")
        return 1
    rc, _, _ = git(root, "merge-base", "--is-ancestor", tagged, head)
    failures = cv.check_bumps(root, tag, cv.check_consistency(root)[1]) if rc == 0 else [
        f"{tagged} is not an ancestor of {head}"]
    if failures:
        print(f"FAIL {tag} already points at {tagged}, not at {head}, and the tag will not be moved.")
        for line in failures:
            print(f"FAIL   {line}")
        print(f"FAIL Bump the top-level version in {MARKETPLACE_JSON} in a pull request; "
              f"that merge gets its own tag.")
        return 1
    print(f"OK {tag} stays on {tagged}: nothing users receive changed since")
    return 0


if __name__ == "__main__":
    sys.exit(main())
