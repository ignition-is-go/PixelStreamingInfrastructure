const { readFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { nalUnits, packetize } = require('./h264-profile-rtp.cjs');
const mediasoup = require('mediasoup');
const bridge = require('@epicgames-ps/mediasoup-sdp-bridge');
const playwright = require('playwright');
const { launchShipping } = require('./h264-profile-shipping.cjs');

async function decode(page, worker, fixture) {
    let router, sending;
    let stopping = false;
    try {
        router = await worker.createRouter({ mediaCodecs: [{
            kind: 'video', mimeType: 'video/H264', clockRate: 90000,
            parameters: { 'packetization-mode': 1, 'profile-level-id': fixture.profileLevelId,
                'level-asymmetry-allowed': 1 },
            rtcpFeedback: [{type: 'nack'}, {type: 'nack', parameter: 'pli'}]
        }] });
        const input = await router.createDirectTransport();
        const producer = await input.produce({ kind: 'video', rtpParameters: {
            codecs: [{mimeType: 'video/H264', payloadType: 96, clockRate: 90000,
                parameters: { 'packetization-mode': 1, 'profile-level-id': fixture.profileLevelId,
                    'level-asymmetry-allowed': 1 }}],
            encodings: [{ssrc: 42}]
        } });
        const transport = await router.createWebRtcTransport({
            listenInfos: [{protocol: 'udp', ip: '127.0.0.1'}],
            initialAvailableOutgoingBitrate: 200000000
        });
        const consumer = await transport.consume({producerId: producer.id,
            rtpCapabilities: router.rtpCapabilities, paused: true});
        const endpoint = bridge.createSdpEndpoint(transport, router.rtpCapabilities);
        endpoint.addConsumer(consumer);
        const answer = await page.evaluate(async offer => {
            window.probePeer?.close();
            document.body.replaceChildren();
            const video = document.createElement('video');
            video.autoplay = true; video.muted = true; video.playsInline = true;
            document.body.append(video);
            const peer = window.probePeer = new RTCPeerConnection({iceServers: []});
            peer.ontrack = event => {
                if (event.track.id === 'probator') return;
                video.srcObject = new MediaStream([event.track]);
                void video.play().catch(() => {});
            };
            await peer.setRemoteDescription({type: 'offer', sdp: offer});
            await peer.setLocalDescription(await peer.createAnswer());
            return peer.localDescription.sdp;
        }, endpoint.createOffer());
        if (!/^m=video (?!0\s)\d+ /m.test(answer)) {
            return {fixture: fixture.fixture, profile: fixture.profile, status: 'profile-rejected'};
        }
        await endpoint.processAnswer(answer);
        await consumer.resume();
        const nals = nalUnits(readFileSync(fixture.file));
        const frames = [];
        let sendError;
        sending = (async () => {
            let sequence = 1000, timestamp = 90000;
            while (!stopping) {
                const frame = packetize(nals, {sequence, timestamp});
                for (const [index, packet] of frame.packets.entries()) {
                    if (stopping) return;
                    producer.send(packet);
                    if (index % 16 === 15) await delay(1);
                }
                frames.push({packets: frame.packets.length});
                sequence = frame.nextSequence;
                timestamp += 45000;
                await delay(500);
            }
        })().catch(error => { sendError = error.message; });
        const deadline = Date.now() + 5000;
        let decoded = false;
        while (Date.now() < deadline) {
            decoded = await page.evaluate(async () => {
                const stats = await window.probePeer.getStats();
                return [...stats.values()].some(s => s.type === 'inbound-rtp' && s.kind === 'video' &&
                    s.framesDecoded >= 2 && s.frameWidth === 3840 && s.frameHeight === 2160);
            });
            if (decoded || sendError) break;
            await delay(100);
        }
        const stats = await page.evaluate(async () => {
            const stats = await window.probePeer.getStats();
            return [...stats.values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'video')
                .map(s => ({framesDecoded:s.framesDecoded, framesReceived:s.framesReceived,
                    width:s.frameWidth, height:s.frameHeight, packetsReceived:s.packetsReceived,
                    packetsLost:s.packetsLost, pliCount:s.pliCount}));
        });
        return { fixture: fixture.fixture, profile: fixture.profile, status: decoded ? 'decoded' : 'no-decoded-frame',
            stats, maxMeasuredPackets: frames.length ? Math.max(...frames.map(f => f.packets)) : null,
            completedRtpFrames: frames.length, sendError: sendError || null };
    } catch (error) {
        return {fixture: fixture.fixture, profile: fixture.profile, status: 'error', error: error.message};
    } finally {
        stopping = true;
        await sending;
        await page.evaluate(() => window.probePeer?.close()).catch(() => {});
        router?.close();
    }
}

async function probeBrowsers(fixtures) {
    const results = [];
    const shipping = process.env.H264_PROFILE_BROWSER_MODE === 'shipping';
    const worker = await mediasoup.createWorker({logLevel: 'error'});
    try {
        for (const browserName of shipping ? ['chromium', 'firefox', 'safari'] : ['chromium', 'firefox', 'webkit']) {
            let browser;
            const result = {browser: browserName, implementation: shipping
                ? 'shipping browser via WebDriver' : 'local Playwright build; not shipping Safari/Firefox qualification', cases: []};
            results.push(result);
            try {
                browser = shipping ? await launchShipping(browserName) : await playwright[browserName].launch({headless: true,
                    args: browserName === 'chromium' ? ['--no-sandbox'] : []});
                result.version = browser.version();
                const page = await browser.newPage();
                result.h264Capabilities = await page.evaluate(() => RTCRtpReceiver.getCapabilities('video')?.codecs
                    .filter(c => c.mimeType.toLowerCase() === 'video/h264').map(c => c.sdpFmtpLine) ?? []);
                if (!result.h264Capabilities.length) { result.status = 'h264-unavailable'; continue; }
                for (const fixture of fixtures) {
                    const outcome = await decode(page, worker, fixture);
                    result.cases.push(outcome);
                    console.log(JSON.stringify({browser: browserName, ...outcome}));
                }
                result.status = 'completed';
            } catch (error) { result.status = 'unavailable'; result.error = error.message.split('\n')[0]; }
            finally { await browser?.close(); }
        }
    } finally { worker.close(); }
    return results;
}

module.exports = { probeBrowsers };
