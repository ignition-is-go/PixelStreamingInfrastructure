import assert from 'node:assert/strict';
import test from 'node:test';
import { requirePlayback } from './production-h264-policy.mjs';

const expected = { width: 3840, height: 2160, seconds: 30, minimumFps: 24 };
function samples() {
    const before = {
        at: 0, peer: 1, connection: 'connected', protocols: ['udp', 'udp'], relayProtocols: [],
        video: { track: 'video-track', statsId: 'video-rtp', ssrc: 123, codec: 'video/H264', width: 3840, height: 2160, decoded: 10, presented: 10, mediaTime: 1, presentationTime: 1000, freezes: 0 },
        audio: { codec: 'audio/opus', packets: 10, samples: 48000, rate: 48000, concealed: 0 }
    };
    const after = structuredClone(before);
    after.at = 30000;
    after.video.decoded += 900;
    after.video.presented += 900;
    after.video.mediaTime += 30;
    after.video.presentationTime += 30000;
    after.audio.packets += 30;
    after.audio.samples += 1440000;
    return [before, after];
}

test('accepts sustained full-resolution H264 and decoded silent Opus', () => {
    assert.equal(requirePlayback(...samples(), expected).decoded, 900);
});

for (const [name, change, message] of [
    ['VP9 despite advancing frames', (s) => { s.video.codec = 'video/VP9'; }, /not H264/],
    ['TCP media', (s) => { s.protocols[0] = 'tcp'; }, /not UDP/],
    ['TCP TURN', (s) => { s.relayProtocols = ['tcp']; }, /TURN/],
    ['reduced resolution', (s) => { s.video.width = 1920; }, /resolution/],
    ['stalled decoder', (s) => { s.video.decoded = 10; }, /decode rate/],
    ['9.6 fps', (s) => { s.video.decoded = 298; }, /decode rate/],
    ['stalled presentation', (s) => { s.video.presented = 10; }, /presentation rate/],
    ['stalled presentation clock', (s) => { s.video.presentationTime = 1000; }, /presentation time/],
    ['live audio track without packets', (s) => { s.audio.packets = 10; }, /audio packets/],
    ['audio without decoded samples', (s) => { s.audio.samples = 48000; }, /audio samples/],
    ['missing audio decode evidence', (s) => { s.audio.samples = null; }, /counter is unavailable/],
    ['choppy concealed audio', (s) => { s.audio.concealed = 400000; }, /concealment/],
    ['video freeze', (s) => { s.video.freezes = 1; }, /froze/],
    ['rendered track replacement', (s) => { s.video.track = 'different-track'; }, /identity changed/],
    ['SSRC replacement', (s) => { s.video.ssrc = 42; }, /identity changed/],
    ['RTP report replacement', (s) => { s.video.statsId = 'other'; }, /identity changed/],
    ['peer replacement', (s) => { s.peer = 2; }, /peer changed/],
    ['two-frame smoke window', (s) => { s.at = 67; }, /too short/]
]) {
    test('rejects ' + name, () => {
        const [before, after] = samples();
        change(after);
        assert.throws(() => requirePlayback(before, after, expected), message);
    });
}

test('accepts live Firefox frames with a zero media timeline and advancing presentation clock', () => {
    const [before, after] = samples();
    before.video.mediaTime = after.video.mediaTime = 0;
    assert.equal(requirePlayback(before, after, expected).decoded, 900);
});
