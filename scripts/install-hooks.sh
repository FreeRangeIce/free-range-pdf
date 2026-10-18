#!/usr/bin/env bash
# Installs the repo's git hooks (run once after clone).
set -euo pipefail; cd "$(git rev-parse --show-toplevel)"
ln -sf ../../scripts/check-no-private.sh .git/hooks/pre-commit && echo "pre-commit hook installed"
