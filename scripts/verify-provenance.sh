#!/usr/bin/bash
# Removes stray .DS_Store, then confirms that every file in app/ is byte-identical to yasir_pro apart from the five
# documented server-side edits, and lists those edits.
set -u
SRC="${YASIR_REFERENCE_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)/yasir_pro}"
DST="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$SRC" ] || { echo "reference project not found at $SRC"; exit 2; }
echo "Comparing $DST/app against $SRC"
same=0; changed=()
while IFS= read -r rel; do
  case "$rel" in
    app/interactive_edit/*) s="inetractive_edit/${rel#app/interactive_edit/}" ;;
    app/interactive_beta/*) s="interactive_beta/${rel#app/interactive_beta/}" ;;
    *) s="${rel#app/}" ;;
  esac
  if [ ! -f "$SRC/$s" ]; then changed+=("$rel (no source: $s)"); continue; fi
  if cmp -s "$SRC/$s" "$DST/$rel"; then same=$((same+1)); else changed+=("$rel"); fi
find "$DST/app" -name .DS_Store -delete 2>/dev/null
done < <(cd "$DST" && find app -type f -not -path '*/node_modules/*' -not -name '.DS_Store' | sort)
echo "byte-identical (installed dependencies excluded): $same"
echo "intentionally edited (${#changed[@]}):"
for item in "${changed[@]}"; do echo "  - $item"; done
echo
echo "diffs:"
# package-lock.json is regenerated because the editor's playwright dev-dependency moved
# to this project's root package.json; the runtime dependencies are the same versions.
for rel in app/interactive_edit/server.mjs app/interactive_edit/app.js app/interactive_edit/index.html app/interactive_edit/package.json; do
  case "$rel" in
    app/interactive_edit/*) s="$SRC/inetractive_edit/${rel#app/interactive_edit/}" ;;
    *) s="$SRC/${rel#app/}" ;;
  esac
  echo "--- $rel"; diff -u "$s" "$DST/$rel" || true
done
