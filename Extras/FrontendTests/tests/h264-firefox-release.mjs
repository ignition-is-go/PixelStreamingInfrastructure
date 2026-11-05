import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

const baseOffer = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS program',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 127.0.0.1',
    'a=ice-ufrag:upstream',
    'a=ice-pwd:012345678901234567890123',
    'a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
    'a=setup:actpass',
    'a=mid:0',
    'a=sendonly',
    'a=rtcp-mux',
    'a=rtpmap:96 H264/90000',
    'a=rtcp-fb:96 nack',
    'a=rtcp-fb:96 nack pli',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=PROFILE',
    'a=ssrc:1234 cname:program',
    ''
].join('\r\n');

const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(new firefox.Options().addArguments('-headless'))
    .build();

try {
    await driver.get('data:text/html,<title>H264 compatibility</title>');
    for (const profile of ['42e01f']) {
        const result = await driver.executeAsyncScript(
            (remoteOffer, done) => {
                const supportsH264 =
                    RTCRtpReceiver.getCapabilities('video')?.codecs.some(
                        (codec) => codec.mimeType.toLowerCase() === 'video/h264'
                    ) ?? false;
                if (!supportsH264) return done({ error: 'Firefox does not expose an H264 decoder' });
                const peer = new RTCPeerConnection();
                peer.setRemoteDescription({ type: 'offer', sdp: remoteOffer })
                    .then(() => peer.createAnswer())
                    .then((answer) => done({ sdp: answer.sdp ?? '' }))
                    .catch((error) => done({ error: String(error) }))
                    .finally(() => peer.close());
            },
            baseOffer.replace('PROFILE', profile)
        );

        if (result.error) throw new Error(result.error);
        if (!/m=video (?!0 )\d+ UDP\/TLS\/RTP\/SAVPF 96/.test(result.sdp)) {
            throw new Error(`Firefox rejected H264 ${profile}:\n${result.sdp}`);
        }
    }
} finally {
    await driver.quit();
}
