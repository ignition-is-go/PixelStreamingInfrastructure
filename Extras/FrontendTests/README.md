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
