#!/usr/bin/env python3
"""Build GitHub release notes from CHANGELOG.md for a CalVer tag.

CalVer tags look like ``2026.10.15`` with an optional same-day counter
(``2026.10.15.1``) — no ``v`` prefix. Release notes are the changelog
sections newer than the previous release: every ``## [YYYY-MM-DD]`` (or
``## [start — end]`` range) section whose end date is after the previous
tag's date is included verbatim, newest first.

When there is no previous tag (first release) the whole changelog body is
used. When date filtering matches nothing (e.g. the tag date has no
changelog heading yet) the newest section is used as a fallback so the
release never ships empty notes.

Usage:
    python3 scripts/release_notes.py --tag 2026.10.15 \\
        --image ghcr.io/mcowger/olive2 --prev-tag 2026.10.01 > notes.md
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

CALVER_RE = re.compile(r"^(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$")
HEADING_RE = re.compile(r"^##\s*\[(.+?)\]\s*$")
DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")


@dataclass
class Section:
    heading: str
    lines: list[str] = field(default_factory=list)
    start: str | None = None  # YYYY-MM-DD or None when undated
    end: str | None = None


def parse_tag_date(tag: str) -> str:
    """Map a CalVer tag to its ``YYYY-MM-DD`` date; raises ``ValueError``."""
    match = CALVER_RE.match(tag.strip())
    if not match:
        raise ValueError(
            f"invalid CalVer tag {tag!r}: expected YYYY.MM.DD with "
            "an optional .N same-day counter (e.g. 2026.10.15.1)"
        )
    year, month, day = match.group(1), match.group(2), match.group(3)
    return f"{year}-{month}-{day}"


def split_sections(text: str) -> tuple[list[str], list[Section]]:
    """Split changelog markdown into preamble lines and ``## [...]`` sections."""
    preamble: list[str] = []
    sections: list[Section] = []
    current: Section | None = None
    for line in text.splitlines():
        heading = HEADING_RE.match(line.strip())
        if heading:
            current = Section(heading=line.rstrip())
            dates = DATE_RE.findall(heading.group(1))
            if dates:
                iso = [f"{y}-{m}-{d}" for y, m, d in dates]
                current.start, current.end = iso[0], iso[-1]
            sections.append(current)
        elif current is None:
            preamble.append(line)
        else:
            current.lines.append(line)
    return preamble, sections


def select_sections(
    sections: list[Section], prev_date: str | None
) -> tuple[list[Section], bool]:
    """Return sections newer than ``prev_date`` plus whether fallback applied."""
    if prev_date is None:
        return sections, False
    selected = [
        section
        for section in sections
        if section.end is None or section.end > prev_date
    ]
    if selected:
        return selected, False
    return sections[:1], True


def render_section(section: Section) -> str:
    return "\n".join([section.heading, *section.lines]).rstrip()


def build_body(
    *,
    tag: str,
    image: str,
    changelog: str,
    prev_tag: str | None,
) -> str:
    """Compose the full release-notes markdown for ``tag``."""
    parse_tag_date(tag)  # validate eagerly so callers fail fast
    prev_date = parse_tag_date(prev_tag) if prev_tag else None
    _, sections = split_sections(changelog)
    if not sections:
        raise ValueError("no '## [...]' sections found in CHANGELOG.md")
    selected, _ = select_sections(sections, prev_date)
    excerpt = "\n\n".join(render_section(section) for section in selected).rstrip()

    since = f"Changes since `{prev_tag}`" if prev_tag else "Changelog"
    return (
        f"Run this release with Docker:\n\n"
        f"```sh\ndocker pull {image}:{tag}\n```\n\n"
        f"`:{tag}` is pinned to this release; `:latest` points at the same image.\n\n"
        f"## {since}\n\n"
        f"{excerpt}\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="CalVer tag, e.g. 2026.10.15")
    parser.add_argument("--prev-tag", default=None, help="Previous CalVer tag")
    parser.add_argument(
        "--changelog",
        default=str(Path(__file__).resolve().parents[1] / "CHANGELOG.md"),
        help="Path to CHANGELOG.md",
    )
    parser.add_argument("--image", required=True, help="Image ref, e.g. ghcr.io/o/r")
    parser.add_argument("--output", default=None, help="Write notes here, not stdout")
    args = parser.parse_args(argv)

    try:
        changelog = Path(args.changelog).read_text(encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot read changelog: {exc}", file=sys.stderr)
        return 1
    try:
        body = build_body(
            tag=args.tag, image=args.image, changelog=changelog, prev_tag=args.prev_tag
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if args.output:
        Path(args.output).write_text(body, encoding="utf-8")
    else:
        sys.stdout.write(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
