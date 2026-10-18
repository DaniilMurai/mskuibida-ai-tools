#!/usr/bin/env python3
"""PreToolUse guard: an assistant never sets the story-point field of a Jira issue.

It acts only when the project's `.story-points.json` configures a Jira `tracker`; with no file, or no
tracker in it, it lets everything through.

Refuses, with exit code 2 and a reason on stderr, a Jira write of any MCP server (a tool whose name
creates, edits, updates or transitions an issue, in camelCase or snake_case: `createJiraIssue`,
`editJiraIssue`, `transitionJiraIssue`, `jira_update_issue`, ...; or `executeWrite`,
`executeDestructive`) whose input names the story-point field anywhere: the tracker's `field` id or
`fieldName`, or a name like `Story point estimate` or `story_points`, as a key
(`{"fields": {"customfield_10016": 5}}`) or as the string under `id`, `key`, `fieldId` or `name` of an
entry (`{"customFields": [{"id": "customfield_10016", "value": 5}]}`). Text that only mentions story
points (a description, a comment) passes. A config that cannot be read or has a tracker block of the
wrong shape refuses every such write, with a message that names the file: fail closed. Standard
library only.
"""

import json
import os
import re
import subprocess
import sys

CONFIG_NAME = ".story-points.json"
# The same string as the matcher in hooks.json (a test holds them equal): letter classes rather than
# ignore-case, so the hook's own regex and this one agree on every name.
TOOLS = re.compile(r"^mcp__.+__(?:(?=\w*(?:[Cc]reate|[Ee]dit|[Uu]pdate|[Tt]ransition))(?=\w*[Ii]ssue)\w+|execute(?:Write|Destructive))$")
NAME = re.compile(r"^story[ _-]?points?([ _-]?estimate)?$", re.IGNORECASE)


def project_root():
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return env
    try:
        proc = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    except OSError:
        pass
    return os.getcwd()


def guarded_names(path):
    """The names to refuse, or None when no tracker is configured. Raises ValueError for a config the
    script would refuse too."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return None
    except OSError as why:
        raise ValueError(f"cannot be read: {why}") from None
    if not isinstance(raw, dict):
        raise ValueError("must hold a JSON object")
    tracker = raw.get("tracker")
    if tracker is None:
        return None
    if not isinstance(tracker, dict) or tracker.get("type") != "jira":
        raise ValueError('`tracker` must be an object with `type` "jira"')
    field = tracker.get("field")
    name = tracker.get("fieldName", "Story point estimate")
    if not isinstance(field, str) or not field.strip() or not isinstance(name, str):
        raise ValueError("`tracker.field` must be a non-empty string and `tracker.fieldName` a string")
    return {field.strip().lower(), name.strip().lower()} - {""}


NAMING = ("id", "key", "fieldId", "name")  # keys whose string value names a field in an entry


def keys(value):
    """Every name a field could be given in the input: each key, and each string under NAMING."""
    if isinstance(value, dict):
        for key, inner in value.items():
            yield str(key)
            if key in NAMING and isinstance(inner, str):
                yield inner
            yield from keys(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from keys(inner)
    elif isinstance(value, str) and value.lstrip().startswith(("{", "[")):
        try:
            yield from keys(json.loads(value))
        except ValueError:
            pass


def sets_points(tool_input, names):
    return any(k.strip().lower() in names or NAME.match(k) for k in keys(tool_input))


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    if not TOOLS.match(event.get("tool_name", "")):
        return 0
    path = os.path.join(project_root(), CONFIG_NAME)
    try:
        names = guarded_names(path)
    except ValueError as why:
        print(f"Refused by the story-points plugin: {path} {why}, so a Jira write cannot be checked for the "
              "story-point field. Fix the file or remove the plugin.", file=sys.stderr)
        return 2
    if names is None:
        return 0
    if sets_points(event.get("tool_input", {}), names):
        print(
            "Refused by the story-points plugin: an assistant never sets the story-point field of a Jira "
            "issue; the developers do. Post the suggestion as a comment on the issue and, when the "
            "developer asked for one, as a row with source `ai` in the intent's unit-points.csv "
            "(`points.py set --source ai`).",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
