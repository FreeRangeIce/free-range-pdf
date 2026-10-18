#!/usr/bin/env bash
# Pre-commit guard: refuse to commit anything from private customer documents.
# Install: ln -sf ../../scripts/check-no-private.sh .git/hooks/pre-commit   (scripts/install-hooks.sh does this)
# Rejects a staged file when
#   - its path matches micah-real* or contains frm-pdf-private, or
#   - its content holds the protected account number (as a whole token) or the protected street address
#     (5-token phrase, case/punctuation-insensitive). Both are stored ONLY as SHA-256 hashes below.
# Usage without git (CI or manual): scripts/check-no-private.sh --files <file>...
set -euo pipefail
ACCOUNT_SHA256_TOKENS="3d53a85150dd6c2cf53d7413fe287ebc2dba06c3d6fb89df281e3837a05d383c"
ADDRESS_SHA256_5GRAMS="9d8931a615c075145150d5f32181b8963fbf849539c1aee184dd465e45171d5f"
if [[ "${1:-}" == "--files" ]]; then shift; FILES=("$@"); else mapfile -t FILES < <(git diff --cached --name-only --diff-filter=ACMR); fi
[[ ${#FILES[@]} -eq 0 ]] && exit 0
bad=0
for f in "${FILES[@]}"; do
  case "$f" in *micah-real*|*frm-pdf-private*) echo "BLOCKED (private path): $f" >&2; bad=1; continue;; esac
done
# content check: staged blob (or file on disk with --files)
PYCODE='
import sys, re, hashlib, subprocess
acct = set(sys.argv[1].split()); addr = set(sys.argv[2].split()); staged = sys.argv[3] == "1"; bad = 0
H = lambda s: hashlib.sha256(s.encode()).hexdigest()
for f in sys.argv[4:]:
    try: data = subprocess.run(["git", "show", ":" + f], capture_output=True, check=True).stdout if staged else open(f, "rb").read()
    except Exception: continue
    t = data.decode("latin1").lower()
    toks = re.findall(r"[0-9a-z]+", t)
    if any(H(x) in acct for x in set(toks)): print("BLOCKED (protected account number): " + f, file=sys.stderr); bad = 1; continue
    if any(H(" ".join(toks[i:i + 5])) in addr for i in range(len(toks) - 4)): print("BLOCKED (protected street address): " + f, file=sys.stderr); bad = 1
sys.exit(bad)
'
staged=1; [[ "${FILES_MODE:-}" == "disk" || "${1:-}" == "--files" ]] && staged=0
[[ -n "${FRM_FILES_FROM_DISK:-}" ]] && staged=0
if ! python3 -c "$PYCODE" "$ACCOUNT_SHA256_TOKENS" "$ADDRESS_SHA256_5GRAMS" "$staged" "${FILES[@]}"; then bad=1; fi
if [[ $bad -ne 0 ]]; then echo "Commit refused: private customer data. Keep it under \$FRM_PDF_PRIVATE, outside the repo." >&2; exit 1; fi
exit 0
