import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { requirePlayback } from './production-h264-policy.mjs';
import { mediaSnapshot } from './production-h264-snapshot.mjs';

test('uses received media rather than the empty SDP SSRC seen in a real browser', async () => {
    const reports = new Map([
        ['empty', { type: 'inbound-rtp', kind: 'video', framesDecoded: 0, bytesReceived: 0 }],
        ['video', {
            type: 'inbound-rtp', kind: 'video', codecId: 'video-codec', transportId: 'transport',
            trackIdentifier: 'rendered-track', framesDecoded: 8, bytesReceived: 10000
        }],
        ['unrendered', { type: 'inbound-rtp', kind: 'video', codecId: 'other-codec',
            trackIdentifier: 'other-track', framesDecoded: 900, bytesReceived: 1000000, lastPacketReceivedTimestamp: 999 }],
        ['other-codec', { mimeType: 'video/H264' }],
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
        getReceivers: () => [{ track: { id: 'rendered-track' }, getStats: async () => new Map([...reports].filter(([id]) => !['unrendered', 'other-codec'].includes(id))) }],
        getStats: async () => reports
    };
    const sample = await vm.runInNewContext('(' + mediaSnapshot.toString() + ')()', {
        document: { querySelectorAll: () => [video] },
        window: { __pixelstreamSmokePeers: [peer] },
        MediaStream, setTimeout, clearTimeout
    });
    assert.equal(sample.video.codec, 'video/VP9');
    assert.equal(sample.video.track, 'rendered-track');
    assert.throws(() => requirePlayback(sample, sample, {}), /not H264/);
    assert.equal(sample.video.decoded, 8);
    assert.equal(sample.audio.samples, 48000);
    assert.equal(sample.protocols.join(','), 'udp,udp');
    reports.delete('transport');
    reports.get('pair').state = 'succeeded';
    reports.get('pair').nominated = true;
    await assert.rejects(() => vm.runInNewContext('(' + mediaSnapshot.toString() + ')()', {
        document: { querySelectorAll: () => [video] },
        window: { __pixelstreamSmokePeers: [peer] },
        MediaStream, setTimeout, clearTimeout
    }), /rendered video transport has no selected candidate pair/);
});

test('failure diagnostics retain codec rejection without endpoint or ICE secrets', async () => {
    const { mediaDiagnostics } = await import('./production-h264-snapshot.mjs');
    const sdp = 'm=video 0 UDP/TLS/RTP/SAVPF 105\r\na=fmtp:105 profile-level-id=4d001f\r\n' +
        'c=IN IP4 192.0.2.1\r\na=candidate:secret-address\r\na=ice-pwd:secret-password\r\na=fingerprint:secret-fingerprint\r\n';
    const result = await vm.runInNewContext('(' + mediaDiagnostics.toString() + ')()', {
        RTCRtpReceiver: { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }) },
        window: { __pixelstreamSmokePeers: [{
            connectionState: 'connected', remoteDescription: { sdp }, localDescription: { sdp },
            getStats: async () => new Map([['candidate', { type: 'local-candidate', address: '192.0.2.2' }]])
        }] }
    });
    const encoded = JSON.stringify(result);
    assert.match(encoded, /profile-level-id=4d001f/);
    assert.match(encoded, /m=video 0/);
    assert.doesNotMatch(encoded, /secret|192\.0\.2/);
});
