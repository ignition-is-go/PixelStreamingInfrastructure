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

## Offline H264 profile characterization

Run without a render VM, production endpoint, or credentials:

```sh
# From the repository root, after npm ci. Requires ffmpeg with libx264.
npm run test:h264:packetizer --workspace Extras/FrontendTests
npm run characterize:h264:profiles --workspace Extras/FrontendTests
# On macOS with shipping Chrome/Firefox, geckodriver, and enabled Safari WebDriver:
H264_PROFILE_BROWSER_MODE=shipping npm run characterize:h264:profiles --workspace Extras/FrontendTests
```

The command generates identical raw 3840x2160 fixtures for Baseline, Main, and High
at QP 12. It records encoded IDR size, SPS profile/level, SSIM/PSNR against the exact
raw input, and packet-count estimates at a 1400-byte RTP MTU. It then sends the
unchanged encoded bytes through a local native mediasoup transport to Chromium,
Firefox, and WebKit, reporting actual packet counts, negotiation rejection,
decoded-frame counters, and missing H264 implementations separately. Browser
buffers use their defaults. Synthetic frames repeat at two frames per second;
this is not a 30 fps performance test. Shipping mode uses WebDriver to test the
installed Chrome, Firefox, and Safari, and fails if any cannot decode the small
4K Baseline positive control. The CI workflow runs both portable Linux and
shipping macOS characterization without production credentials.

Fixtures and `report.json` are written to a new temporary directory printed as
`REPORT=...`. The CI workflow uploads only the report and command log. A small
4K Baseline fixture must actually decode in Chromium for the harness to pass its
positive control. A green characterization job does **not** qualify any profile
for production. Complex frames may remain oversized under every profile.

These are software libx264 results, not Unreal/NVENC results. Equal QP and close
SSIM/PSNR do not prove identical visual quality. Portable WebKit is not shipping
Safari; missing H264 in a portable Firefox build is not a shipping Firefox result.
Before rollout, validate the selected profile with actual frame decoding in all
three shipping browsers, then measure maximum frame packet counts, quality, GPU
cost, late joins, and sustained 4K30 on a spare render VM using the deployed
Unreal/NVENC stack. No production profile/configuration is changed by this test.

