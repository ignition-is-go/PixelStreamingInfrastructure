# rtcp-playwright-test

## Running locally
### Setup
```
npm install
npx playwright install-deps
npx playwright install firefox
npx playwright install chromium
```

### Prepare
- Run signalling server
- Start streamer pointed at signalling server
- [optional] Create .env file (can use example.env as a reference) and point to signalling server URL if not localhost

### Run tests
```
npx playwright test
```


## Protected H264 media qualification

The production smoke test uses shipping Chrome, Firefox, or Safari through
WebDriver. Prepare the built reference client before serving it:

    node prepare-production-smoke-client.cjs /path/to/client/player.html
    npm run test:h264:production-policy

Set PIXELSTREAM_BROWSER, PIXELSTREAM_PRODUCTION_VIEWER_URL,
PIXELSTREAM_SOURCE_COMMIT to the exact reviewed Git commit, and
PIXELSTREAM_SMOKE_REPORT to the JSON receipt path, then run
npm run test:h264:production.

The default qualification requires 3840x2160 H264 over UDP, at least 24 decoded
and presented frames per second for 30 seconds per connection, advancing Opus
decode counters, and two forced reconnects. Silent audio is valid; missing audio
packets, stalled samples, excessive concealment, and reported video freezes fail.
The test uses normal browser packet-buffer limits.

The observer records actual peer statistics and frame presentation without
changing negotiation. It excludes empty SDP SSRC records and stores no candidate
addresses or endpoint URLs. Receipts include the browser version, reviewed
reference-client commit, each connection's evidence, and any failure. A successful
schema-version-2 receipt is required; the earlier two-frame smoke is insufficient.

Production endpoints belong in protected CI secrets, not this repository.
Safari requires a GUI runner with authorized system Safari WebDriver. The
protected orchestration workflow lives in pulse-deploy.

## Qualify the compiled Pulse Pixelstream viewer

Stage a copy of the compiled app from a known Git commit. Point its runtime
config at the isolated canary. Prepare the copy of the entry page before
serving it:

    export PIXELSTREAM_SMOKE_CLIENT=app
    export PIXELSTREAM_APP_SOURCE_COMMIT="$APP_BUILD_COMMIT"
    export PIXELSTREAM_APP_WASM_SHA256="$APP_BUILD_WASM_SHA256"
    node prepare-production-smoke-client.cjs /path/to/staged/app/index.html

Set `PIXELSTREAM_PRODUCTION_VIEWER_URL` to the staged viewer URL and
`PIXELSTREAM_SOURCE_COMMIT` to the harness commit. Set
`PIXELSTREAM_APP_EXPECTED_ROUTE` to `edge`, `direct`, or `local` and
`PIXELSTREAM_APP_EXPECTED_BUFFER_MS` to the receiver target for the browser
and route. Set the browser and receipt path as for the reference client, then
run `npm run test:h264:production`.

The app observer blocks outgoing WebRTC data channel commands and leaves
negotiation and receiver settings alone. The test uses **Unmute stream audio**
and checks **Media via** in the viewer's **Stream status** dialog. A fallback
route, muted playback, build mismatch, or incorrect receiver target fails the
qualification. Preparation verifies the staged WASM against the digest from
the candidate build before it stamps the entry page.
