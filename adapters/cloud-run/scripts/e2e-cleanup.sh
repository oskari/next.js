#!/usr/bin/env bash
# Cleanup script for the compatibility test suite (NEXT_TEST_CLEANUP_SCRIPT_PATH).
set -euo pipefail

if [ -f .adapter-service ]; then
  gcloud run services delete "$(cat .adapter-service)" \
    --region "${REGION:-us-central1}" --quiet || true
fi
if [ -f .adapter-server.pid ]; then
  kill "$(cat .adapter-server.pid)" 2>/dev/null || true
fi
