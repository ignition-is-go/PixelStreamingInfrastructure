const assert = require('node:assert/strict');
const test = require('node:test');
const mediasoup = require('mediasoup');
const { createSdpEndpoint } = require('@epicgames-ps/mediasoup-sdp-bridge');
const config = require('../config');

function videoOffer(profileLevelId, packetizationMode = 1, levelAsymmetry = 1) {
    return [
        'v=0',
        'o=- 12345 1 IN IP4 127.0.0.1',
        's=-',
        't=0 0',
        'a=group:BUNDLE video',
        'm=video 9 UDP/TLS/RTP/SAVPF 96',
        'c=IN IP4 0.0.0.0',
        'a=setup:actpass',
        'a=mid:video',
        'a=sendonly',
        'a=rtcp-mux',
        'a=ice-ufrag:abc123',
        'a=ice-pwd:sPGzTMqxsaPGSAiFA2Wdsf',
        'a=fingerprint:sha-256 ' + Array(32).fill('E2').join(':'),
        'a=rtpmap:96 H264/90000',
        `a=fmtp:96 level-asymmetry-allowed=${levelAsymmetry};packetization-mode=${packetizationMode};profile-level-id=${profileLevelId}`,
        'a=ssrc:7654321 cname:isolated-h264',
        ''
    ].join('\r\n');
}

test('native SFU preserves offered H264 ingress levels for matching profiles and packetization', async () => {
    const worker = await mediasoup.createWorker();
    try {
        const router = await worker.createRouter(config.mediasoup.router);
        const highRouter = await worker.createRouter({ mediaCodecs: [{
            kind: 'video',
            mimeType: 'video/h264',
            clockRate: 90000,
            parameters: { 'packetization-mode': 1, 'profile-level-id': '64001f', 'level-asymmetry-allowed': 1 }
        }] });
        for (const [target, offered, expected, asymmetry] of [
            [router, '42e01e', '42e01e', 1],
            [router, '42e033', '42e033', 1],
            [router, '42e034', '42e034', 1],
            [highRouter, '640034', '640034', 1],
            [router, '42e034', '42e01f', 0]
        ]) {
            const transport = await target.createWebRtcTransport({
                listenInfos: [{ protocol: 'udp', ip: '127.0.0.1' }],
                enableUdp: true
            });
            try {
                const endpoint = createSdpEndpoint(transport, target.rtpCapabilities);
                const { producers } = await endpoint.processOffer(videoOffer(offered, 1, asymmetry));
                const [codec] = producers[0].rtpParameters.codecs;
                assert.equal(codec.parameters['profile-level-id'], expected);
                assert.equal(codec.parameters['packetization-mode'], 1);
                const fmtp = endpoint.createAnswer().split('\r\n').find(line => line.startsWith('a=fmtp:96 '));
                assert.match(fmtp, new RegExp(`(?:[ ;])profile-level-id=${expected}(?:;|$)`));
            } finally {
                transport.close();
            }
        }
        for (const offer of [videoOffer('4d0034'), videoOffer('42e034', 0)]) {
            const transport = await router.createWebRtcTransport({
                listenInfos: [{ protocol: 'udp', ip: '127.0.0.1' }],
                enableUdp: true
            });
            try {
                const endpoint = createSdpEndpoint(transport, router.rtpCapabilities);
                await assert.rejects(endpoint.processOffer(offer), /Cannot create mediasoup Producer/);
            } finally {
                transport.close();
            }
        }
    } finally {
        worker.close();
    }
});
