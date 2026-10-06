#!/usr/bin/env bash
# Logs script for the compatibility test suite (NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH).
set -euo pipefail

[ -f .adapter-build.log ] && cat .adapter-build.log

if [ -f .adapter-service ]; then
  echo "=== Cloud Run logs ==="
  gcloud run services logs read "$(cat .adapter-service)" \
    --region "${REGION:-us-central1}" --limit 500 || true
elif [ -f .adapter-server.log ]; then
  echo "=== .adapter-server.log ==="
  cat .adapter-server.log
fi
