#!/bin/sh
# Fetch the self-hosted webfont for Sekolah Siaga Panas.
#
# WHY THIS EXISTS
# The app must render correctly offline and on Android, where "Arial Narrow" is
# absent. Loading fonts from a CDN at runtime would break offline use and leak a
# request to a third party on every visit, so the font is vendored into
# assets/fonts/ and served from the same origin as the app.
#
# WHAT IT DOWNLOADS
# Archivo Narrow, by Omnibus-Type, licensed under the SIL Open Font License 1.1
# (https://openfontlicense.org) — redistribution alongside this app is permitted.
# Source: Google Fonts (fonts.gstatic.com), family version v35.
#
# NOTE: Google serves Archivo Narrow as a VARIABLE font. The URLs Google returns
# for weight 400 and weight 700 are byte-identical: a single file carries the
# whole 400..700 weight axis. We therefore vendor one file per unicode subset,
# not one per weight, and declare `font-weight: 400 700` in the @font-face rule
# in styles.css. Downloading a "-400" and a "-700" file would just store the
# same bytes twice.
#
# Re-run this script to refresh the fonts. Re-resolve the URLs below by running:
#   curl -H 'User-Agent: Mozilla/5.0 ... Chrome/120.0 ...' \
#     'https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@400;700&display=swap'
# The modern User-Agent matters — without it Google returns legacy .ttf URLs.

set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)/assets/fonts"
mkdir -p "$DIR"

# latin subset — U+0000-00FF etc. Covers all of Indonesian.
LATIN="https://fonts.gstatic.com/s/archivonarrow/v35/tss0ApVBdCYD5Q7hcxTE1ArZ0bbwiXw.woff2"
# latin-ext subset — kept so loanwords and place names with rarer diacritics
# do not fall back to a non-condensed face mid-word.
LATIN_EXT="https://fonts.gstatic.com/s/archivonarrow/v35/tss0ApVBdCYD5Q7hcxTE1ArZ0bb-iXxi2g.woff2"

echo "Downloading Archivo Narrow (variable, 400..700) into $DIR"
curl -fsSL --max-time 60 "$LATIN"     -o "$DIR/archivo-narrow-latin.woff2"
curl -fsSL --max-time 60 "$LATIN_EXT" -o "$DIR/archivo-narrow-latin-ext.woff2"

# A truncated or error-page download would silently break typography, so verify
# each file really is a woff2 (magic bytes "wOF2") and is a plausible size.
for f in "$DIR/archivo-narrow-latin.woff2" "$DIR/archivo-narrow-latin-ext.woff2"; do
  magic=$(dd if="$f" bs=1 count=4 2>/dev/null || true)
  size=$(wc -c < "$f" | tr -d ' ')
  if [ "$magic" != "wOF2" ] || [ "$size" -lt 2000 ]; then
    echo "FAILED: $f is not a valid woff2 (magic='$magic', ${size}B)" >&2
    exit 1
  fi
  echo "  ok  $(basename "$f")  ${size} bytes"
done

echo "Done. styles.css references these via @font-face; no CDN at runtime."
