#!/usr/bin/env bash
# Builds dist/ - a stash package source: the plugin zip plus the index.yml that
# advertises it. Point stash at the published index.yml under
# Settings > Plugins > Available Plugins > Add Source.
#
# No bundling step: plugin/ is shipped as is. Needs python3.
set -euo pipefail

ID="TCodePlayer"
NAME="TCode Player"
DESC="Plays single- and multi-axis funscripts on TCode devices (OSR2, SR6, SSR1) over Web Serial, with per-scene channel mapping and a 3D preview."

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"

VERSION="$(sed -n 's/^version: *//p' "$ROOT/plugin/$ID.yml" | tr -d '"' | head -1)"
[ -n "$VERSION" ] || { echo "could not read version from plugin/$ID.yml" >&2; exit 1; }

rm -rf "$DIST"
mkdir -p "$DIST"

ID="$ID" NAME="$NAME" DESC="$DESC" VERSION="$VERSION" ROOT="$ROOT" DIST="$DIST" python3 <<'PY'
import hashlib, json, os, time, zipfile

ID, DIST, ROOT = os.environ["ID"], os.environ["DIST"], os.environ["ROOT"]
PLUGIN = f"{ROOT}/plugin"

# stash writes each zip entry verbatim under plugins/<id>/ (creating parent
# dirs), so the zip has to be flat - a wrapping directory would nest as
# plugins/<id>/<id>/... Everything in plugin/ ships, vendor/ included.
members = []
for dirpath, dirnames, filenames in os.walk(PLUGIN):
    dirnames.sort()
    for fn in sorted(filenames):
        src = os.path.join(dirpath, fn)
        members.append((src, os.path.relpath(src, PLUGIN).replace(os.sep, "/")))
members.append((f"{ROOT}/README.md", "README.md"))
members.append((f"{ROOT}/LICENSE", "LICENSE"))

zpath = f"{DIST}/{ID}.zip"
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    for src, name in members:
        # fixed timestamp so an unchanged build produces an unchanged sha256
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        with open(src, "rb") as f:
            z.writestr(info, f.read())

sha = hashlib.sha256(open(zpath, "rb").read()).hexdigest()
date = os.environ.get("SOURCE_DATE") or time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())

# json strings are valid YAML scalars, so names with ':' or quotes stay safe
q = json.dumps
with open(f"{DIST}/index.yml", "w") as f:
    f.write(
        f"- id: {ID}\n"
        f"  name: {q(os.environ['NAME'])}\n"
        f"  version: {os.environ['VERSION']}\n"
        f"  date: {date}\n"
        f"  path: {ID}.zip\n"
        f"  sha256: {sha}\n"
        f"  metadata:\n"
        f"    description: {q(os.environ['DESC'])}\n"
    )

print(f"built {zpath}  ({os.environ['VERSION']}, sha256 {sha[:12]}...)")
print("contents:")
with zipfile.ZipFile(zpath) as z:
    for n in z.namelist():
        print(f"  {n}")
PY
