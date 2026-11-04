import { expect, test } from '@playwright/test';

const H264_BASELINE_OFFER = `v=0\r
o=- 10000 1 IN IP4 127.0.0.1\r
s=-\r
t=0 0\r
a=group:BUNDLE 0\r
a=msid-semantic: WMS program\r
m=video 9 UDP/TLS/RTP/SAVPF 96\r
c=IN IP4 127.0.0.1\r
a=ice-ufrag:upstream\r
a=ice-pwd:012345678901234567890123\r
a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00\r
a=setup:actpass\r
a=mid:0\r
a=sendonly\r
a=rtcp-mux\r
a=rtpmap:96 H264/90000\r
a=rtcp-fb:96 nack\r
a=rtcp-fb:96 nack pli\r
a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=PROFILE\r
a=ssrc:1234 cname:program\r
`;

for (const profile of ['42e01f'] as const) {
    test('accepts the fleet H.264 constrained baseline video profile', async ({ page }) => {
        const supportsH264 = await page.evaluate(
            () =>
                RTCRtpReceiver.getCapabilities('video')?.codecs.some(
                    (codec) => codec.mimeType.toLowerCase() === 'video/h264'
                ) ?? false
        );
        if (!supportsH264 && process.env.REQUIRE_H264 !== '1') {
            test.skip(true, 'This portable browser build has no platform H.264 codec');
        }
        expect(supportsH264, 'browser must expose a platform H.264 decoder').toBe(true);

        const answer = await page.evaluate(
            async (offer) => {
                const peer = new RTCPeerConnection();
                try {
                    await peer.setRemoteDescription({ type: 'offer', sdp: offer });
                    const description = await peer.createAnswer();
                    return description.sdp ?? '';
                } finally {
                    peer.close();
                }
            },
            H264_BASELINE_OFFER.replace('PROFILE', profile)
        );

        expect(answer).toMatch(/m=video (?!0 )\d+ UDP\/TLS\/RTP\/SAVPF 96/);
        expect(answer).toContain(`profile-level-id=${profile}`);
    });
}
