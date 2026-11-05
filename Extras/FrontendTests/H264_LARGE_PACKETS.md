# Test larger H264 RTP packets over UDP

This isolated experiment tests a quality-preserving workaround for frames that
exceed browser packet-assembly capacity. It does not change production settings.

From the repository root, install locked dependencies and ffmpeg with libx264.
Build the experimental worker:

```sh
node Extras/FrontendTests/build-h264-large-packet-worker.cjs
```

The command copies the installed mediasoup source into a temporary directory,
changes its RTP capacity from 1500 to 1900 bytes, preserves its existing RTCP
budget, and builds the native worker. It prints `MEDIASOUP_WORKER_BIN` and writes
a receipt containing the binary hash. The installed dependency stays unchanged.

Set `MEDIASOUP_WORKER_BIN` to the printed path, then run:

```sh
node Extras/FrontendTests/h264-large-packet-bench.cjs
```

The test requires the matching build receipt before sending larger packets.
It generates a small positive control and a larger synthetic 4K Baseline frame.
The large frame uses the same encoded file at both packet sizes. The report
records its SHA-256 hash, packet counts, selected UDP tuples and decode counters.
The test requires the large frame to fail at 1400 bytes and decode at 1800 bytes.
It also checks that the fixture crosses the 2048-packet boundary.

Local mode requires Chromium and WebKit decoding. To test installed Chrome,
Firefox and Safari on macOS, install geckodriver, enable Safari WebDriver, and run:

```sh
H264_PROFILE_BROWSER_MODE=shipping node Extras/FrontendTests/h264-large-packet-bench.cjs
```

The dedicated CI workflow builds the worker and requires all three shipping
browsers to pass. It uploads reports and build logs without production access.
This is a local-path browser test. It does not qualify IP fragmentation on a
1500-byte network path or on the production internet path. Set
`H264_PACKET_TRANSPORT=tcp` only to repeat the earlier diagnostic comparison.
TCP does not satisfy the production UDP requirement.

The SFU image accepts `--build-arg H264_RTP_CAPACITY=1900` to build and install the
same worker inside its runtime base image. The default remains 1500. The opt-in
image contains the worker hash receipt and patched capacity header. Use it only
for the dedicated canary until the actual UDP paths are qualified.

## Remaining production work

This experiment packetizes before mediasoup input. Raising the worker capacity
does not combine existing input packets. A production implementation must supply
larger packets through upstream packetization or an SFU repacketizer.

UDP packets above the path MTU require IP fragmentation. Validate fragment
delivery and reassembly, retransmission, and loss behavior on each relevant
network path. A shared compositor packetizer must not send larger packets to
unrelated consumers. A dedicated canary route must precede any default change.

The synthetic encoder and two-fps repeated IDRs do not qualify Unreal/NVENC,
sustained 4K30, latency under packet loss, retransmission behavior, or maximum
future keyframe size. Validate actual-source late joins and image preservation
before rollout. Frames can still exceed the assembly budget at 1800 bytes.
