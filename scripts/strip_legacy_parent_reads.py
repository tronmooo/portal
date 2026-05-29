#!/usr/bin/env python3
"""Strip legacy fields._parentProfileId read fallbacks across client/server files.

The DB column `parent_profile_id` (camelCased to `parentProfileId`) is now the
single source of truth. The JSON shadow `fields._parentProfileId` is no longer
written. Reading it is dead code.
"""
import re
import sys
from pathlib import Path

FILES = [
    "client/src/components/dashboard/HeroKPIPopups.tsx",
    "client/src/components/asset/asset-overview.tsx",
    "client/src/pages/dashboard.tsx",
    "client/src/pages/finance.tsx",
    "client/src/pages/profiles.tsx",
    "client/src/pages/trackers.tsx",
    "client/src/pages/liability-detail.tsx",
]

# Patterns: (regex, replacement)
# Each pattern matches a binary "||" expression mixing the JSON shadow with the
# column read. Result keeps only the column read.
PATTERNS = [
    # X.fields?._parentProfileId || X.parentProfileId
    (re.compile(r"(\b\w+)\.fields\?\._parentProfileId\s*\|\|\s*\1\.parentProfileId"), r"\1.parentProfileId"),
    # X.parentProfileId || X.fields?._parentProfileId
    (re.compile(r"(\b\w+)\.parentProfileId\s*\|\|\s*\1\.fields\?\._parentProfileId"), r"\1.parentProfileId"),
    # (X.fields as any)?._parentProfileId || X.parentProfileId
    (re.compile(r"\((\w+)\.fields as any\)\?\._parentProfileId\s*\|\|\s*\1\.parentProfileId"), r"\1.parentProfileId"),
    # X.parentProfileId || (X.fields as any)?._parentProfileId
    (re.compile(r"(\b\w+)\.parentProfileId\s*\|\|\s*\((\w+)\.fields as any\)\?\._parentProfileId"), r"\1.parentProfileId"),
    # cur.fields?._parentProfileId || cur.parentProfileId   (already covered above, but include for cur/c?.)
    # c?.parentProfileId || (c?.fields as any)?._parentProfileId
    (re.compile(r"(\w+)\?\.parentProfileId\s*\|\|\s*\((\w+)\?\.fields as any\)\?\._parentProfileId"), r"\1?.parentProfileId"),
    # (p.fields as any)?._parentProfileId || (p as any).parentProfileId
    (re.compile(r"\((\w+)\.fields as any\)\?\._parentProfileId\s*\|\|\s*\((\w+) as any\)\.parentProfileId"), r"(\1 as any).parentProfileId"),
    # X.fields?._parentProfileId || (X as any).parentProfileId
    (re.compile(r"(\b\w+)\.fields\?\._parentProfileId\s*\|\|\s*\((\w+) as any\)\.parentProfileId"), r"(\1 as any).parentProfileId"),
    # liability-detail.tsx:  !p.fields?._parentProfileId  -> !p.parentProfileId
    (re.compile(r"!\s*(\b\w+)\.fields\?\._parentProfileId\b"), r"!\1.parentProfileId"),
]

root = Path("/home/user/workspace/portal")
total = 0
for rel in FILES:
    path = root / rel
    txt = path.read_text()
    orig = txt
    for pat, repl in PATTERNS:
        txt = pat.sub(repl, txt)
    if txt != orig:
        # Count how many _parentProfileId references remain to surface
        remaining = txt.count("_parentProfileId")
        before = orig.count("_parentProfileId")
        print(f"{rel}: {before} -> {remaining}")
        path.write_text(txt)
        total += (before - remaining)
print(f"TOTAL stripped: {total}")
