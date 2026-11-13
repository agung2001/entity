#!/bin/sh
# Build, test and deploy this checkout on the target host.
#
#   ./scripts/deploy.sh pull    fetch origin/main, reset the checkout, keep .env
#   ./scripts/deploy.sh build   docker compose build
#   ./scripts/deploy.sh test    run the test suite in the build stage
#   ./scripts/deploy.sh up      start the built image
#
# TeamCity calls these four actions over SSH from the same checkout. The script
# lives in the repository so the pipeline does not depend on a host-local copy.
set -eu
export GIT_TERMINAL_PROMPT=0

DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO=https://github.com/agung2001/entity.git
BRANCH=main

cd "$DIR"

case "${1:-}" in
  pull)
    if [ ! -d .git ]; then
      git init -q
      git remote add origin "$REPO" 2>/dev/null || git remote set-url origin "$REPO"
      git fetch -q origin "$BRANCH"
      git checkout -f -B "$BRANCH" "origin/$BRANCH"
    else
      git remote set-url origin "$REPO"
      git fetch -q origin "$BRANCH"
      git reset --hard "origin/$BRANCH"
    fi
    # `.env` is untracked and ignored; keep the live credentials in place.
    git clean -fd -e .env
    ;;
  build)
    docker compose build
    ;;
  test)
    # The runtime image is intentionally lean (dist/server/electron only), while
    # the UI contract tests read src/. Build the test stage, not the prod image.
    docker build --target build -t entity-test:latest .
    docker run --rm --init entity-test:latest node --test electron/*.test.cjs
    ;;
  up)
    docker compose up -d --remove-orphans
    ;;
  *)
    echo "usage: $0 pull|build|test|up" >&2
    exit 2
    ;;
esac
