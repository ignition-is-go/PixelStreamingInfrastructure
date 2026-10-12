# Validate SFU reconnects in isolation

This Linux smoke test runs the real signalling server and SFU with Chromium
clients. The source is a generated canvas video with multiplexed data channels.
It checks viewer-before-streamer startup, fresh video after reconnect, and a
browser-to-streamer-to-browser payload round trip. It does not run Unreal Engine
or verify application-specific controls, production TURN, or WAN connectivity.

The wrapper creates a private network namespace containing loopback and one dummy
interface. There is no external interface or route. All services are local to
that namespace. The runner rejects other network interfaces, closes its browser
and child processes on exit, and leaves logs in the printed temporary directory.

From the repository root, prepare dependencies with the version in `NODE_VERSION`:

```sh
npx --yes --package=node@22.14.0 -c 'npm ci --ignore-scripts && npm rebuild mediasoup'
npx --yes --package=node@22.14.0 -c 'npm run build:cjs --workspace=Common && npm run build:cjs --workspace=Signalling && npm run build --workspace=SignallingWebServer && npm run build --workspace=Extras/mediasoup-sdp-bridge'
npx playwright install chromium
```

Run from a Linux environment that permits network namespace creation and has
`iproute2` and Chromium's system dependencies installed:

```sh
npx --yes --package=node@22.14.0 -c 'SFU/smoke/run-reconnect.sh'
```

Success requires four `PASS` lines and exit code zero. No production credentials
or endpoints are needed. This is a manual integration check, separate from the
fast `SFU/tests/*.test.js` suite.
