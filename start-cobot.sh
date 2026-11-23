#!/usr/bin/env sh
set -eu
APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node --no-deprecation "$APP_DIR/scripts/daemon.js" restart "$@"
