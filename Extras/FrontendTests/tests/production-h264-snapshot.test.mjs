import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { mediaSnapshot } from './production-h264-snapshot.mjs';

test('uses received media rather than the empty SDP SSRC seen in a real browser', async () => {
    const reports = new Map([
        ['empty', { type: 'inbound-rtp', kind: 'video', framesDecoded: 0, bytesReceived: 0 }],
        ['video', {
            type: 'inbound-rtp', kind: 'video', codecId: 'video-codec', transportId: 'transport',
            framesDecoded: 8, bytesReceived: 10000
        }],
        ['audio', {
            type: 'inbound-rtp', kind: 'audio', codecId: 'audio-codec',
            bytesReceived: 100, packetsReceived: 5, totalSamplesReceived: 48000
        }],
        ['video-codec', { mimeType: 'video/VP9' }],
        ['audio-codec', { mimeType: 'audio/opus', clockRate: 48000 }],
        ['transport', { selectedCandidatePairId: 'pair' }],
        ['pair', { localCandidateId: 'local', remoteCandidateId: 'remote' }],
        ['local', { protocol: 'udp' }],
        ['remote', { protocol: 'udp' }]
    ]);
    class MediaStream {
        getVideoTracks() { return [{ id: 'rendered-track' }]; }
    }
    const video = {
        srcObject: new MediaStream(), videoWidth: 3840, videoHeight: 2160,
        requestVideoFrameCallback(callback) { queueMicrotask(() => callback(0, { presentedFrames: 9, mediaTime: 0.3 })); }
    };
    const peer = {
        connectionState: 'connected',
        getReceivers: () => [{ track: { id: 'rendered-track' } }],
        getStats: async () => reports
    };
    const sample = await vm.runInNewContext('(' + mediaSnapshot.toString() + ')()', {
        document: { querySelectorAll: () => [video] },
        window: { __pixelstreamSmokePeers: [peer] },
        MediaStream, setTimeout, clearTimeout
    });
    assert.equal(sample.video.codec, 'video/VP9');
    assert.equal(sample.video.decoded, 8);
    assert.equal(sample.audio.samples, 48000);
    assert.equal(sample.protocols.join(','), 'udp,udp');
});
