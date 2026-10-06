#!/usr/bin/env bash
# Deploy script for the Next.js adapter compatibility test suite
# (NEXT_TEST_DEPLOY_SCRIPT_PATH). Runs with cwd set to the isolated test app.
#
# NEXT_CLOUD_RUN_E2E_TARGET=local (default) starts the generated server on
# this machine; =gcp deploys to Cloud Run with scripts/deploy.sh.
set -euo pipefail

ADAPTER_DIR="${ADAPTER_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
export NEXT_ADAPTER_PATH="$ADAPTER_DIR/dist/index.js"

pnpm build >&2

{
  echo "BUILD_ID: $(cat .next/BUILD_ID)"
  echo "DEPLOYMENT_ID: cloud-run-${NEXT_CLOUD_RUN_E2E_TARGET:-local}"
  echo "NEXT_SUPPORTS_IMMUTABLE_ASSETS: 0"
} > .adapter-build.log

if [ "${NEXT_CLOUD_RUN_E2E_TARGET:-local}" = "gcp" ]; then
  SERVICE="${SERVICE:-next-e2e-$(basename "$PWD" | tr -cd 'a-z0-9' | tail -c 20)}"
  echo "$SERVICE" > .adapter-service
  SERVICE="$SERVICE" PUBLIC=1 "$ADAPTER_DIR/scripts/deploy.sh" .
  exit 0
fi

PORT="$(node -e "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})")"
nohup env PORT="$PORT" HOSTNAME=127.0.0.1 node .cloud-run/app/server.mjs \
  > .adapter-server.log 2>&1 &
echo $! > .adapter-server.pid

for _ in $(seq 1 100); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 0.1
done
echo "Server did not start" >&2
cat .adapter-server.log >&2
exit 1
