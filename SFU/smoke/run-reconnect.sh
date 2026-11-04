#!/usr/bin/env bash
set -euo pipefail

# Prerequisites: npm ci, built Common/Signalling/SignallingWebServer and
# Extras/mediasoup-sdp-bridge, mediasoup worker, and Playwright Chromium.
# Requires Linux network-namespace privileges. No production access is needed.
cd "$(dirname "$0")/../.."
if [[ "$(node --version)" != "$(cat NODE_VERSION)" ]]; then
    echo "Run with the Node version in NODE_VERSION (for example via npx --package=node@22.14.0)." >&2
    exit 1
fi
exec unshare --net bash -euc '
    ip link set lo up
    ip link add smoke0 type dummy
    ip addr add 10.200.0.1/24 dev smoke0
    ip link set smoke0 up
    exec node SFU/smoke/reconnect.cjs
'
