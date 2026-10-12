// Synthetic peers only. Does not subscribe to a streamer or modify a service.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const WebSocket = require('ws');
async function fetchConfig(endpoint) {
    const ws = new WebSocket(endpoint);
    let timer;
    try {
        return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('config timeout')), 5000);
            ws.on('error', reject);
            ws.on('message', (raw) => {
                const message = JSON.parse(raw);
                if (message.type === 'config') resolve(message.peerConnectionOptions);
            });
        });
    } finally {
        clearTimeout(timer);
        ws.close();
    }
}
(async () => {
    const endpoint = process.argv[2];
    if (!endpoint || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname))
        throw new Error('Provide the isolated local signaller WebSocket URL');
    const options = await fetchConfig(endpoint);
    const urls = options.iceServers
        .flatMap((server) => (typeof server.urls === 'string' ? [server.urls] : server.urls))
        .filter((url) => /^turns?:/.test(url));
    if (!urls.length) throw new Error('Candidate signaller advertised no TURN URLs');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        for (const url of urls) {
            const result = await page.evaluate(
                async ({ url, first, second }) => {
                    function config(options) {
                        const relay = options.iceServers.find((server) =>
                            (typeof server.urls === 'string' ? [server.urls] : server.urls).includes(url)
                        );
                        if (!relay) throw new Error('TURN URL disappeared on reconnect');
                        return { iceServers: [{ ...relay, urls: url }], iceTransportPolicy: 'relay' };
                    }
                    const a = new RTCPeerConnection(config(first)),
                        b = new RTCPeerConnection(config(second));
                    const result = { url, candidates: [], errors: [], echoes: 0 };
                    const pendingA = [],
                        pendingB = [];
                    for (const [pc, other, queue] of [
                        [a, b, pendingB],
                        [b, a, pendingA]
                    ]) {
                        pc.onicecandidate = (e) => {
                            if (e.candidate) {
                                result.candidates.push({
                                    type: e.candidate.type,
                                    protocol: e.candidate.protocol,
                                    relayProtocol: e.candidate.relayProtocol
                                });
                                if (other.remoteDescription)
                                    other
                                        .addIceCandidate(e.candidate)
                                        .catch((x) => result.errors.push(x.message));
                                else queue.push(e.candidate);
                            }
                        };
                        pc.onicecandidateerror = (e) =>
                            result.errors.push({ code: e.errorCode, text: e.errorText });
                    }
                    let timer;
                    try {
                        const channel = a.createDataChannel('isolated-turn-proof');
                        const proof = new Promise((resolve, reject) => {
                            timer = setTimeout(
                                () => reject(new Error('relay echo timeout after 20 seconds')),
                                20000
                            );
                            b.ondatachannel = (e) => {
                                e.channel.onmessage = (m) => e.channel.send(m.data);
                            };
                            channel.onopen = () => {
                                for (let i = 0; i < 10; i++) channel.send('turn-validation-' + i);
                            };
                            channel.onmessage = (e) => {
                                if (e.data === 'turn-validation-' + result.echoes) result.echoes++;
                                if (result.echoes === 10) resolve();
                            };
                        });
                        await a.setLocalDescription(await a.createOffer());
                        await b.setRemoteDescription(a.localDescription);
                        for (const c of pendingB.splice(0)) await b.addIceCandidate(c);
                        await b.setLocalDescription(await b.createAnswer());
                        await a.setRemoteDescription(b.localDescription);
                        for (const c of pendingA.splice(0)) await a.addIceCandidate(c);
                        await proof;
                        await new Promise((resolve) => setTimeout(resolve, 1000));
                        const stats = await a.getStats();
                        const pair = [...stats.values()].find(
                            (x) => x.type === 'candidate-pair' && x.state === 'succeeded' && x.nominated
                        );
                        if (pair) {
                            const local = stats.get(pair.localCandidateId),
                                remote = stats.get(pair.remoteCandidateId);
                            result.selected = {
                                localType: local.candidateType,
                                remoteType: remote.candidateType,
                                relayProtocol: local.relayProtocol,
                                bytesSent: pair.bytesSent,
                                bytesReceived: pair.bytesReceived,
                                currentRoundTripTime: pair.currentRoundTripTime
                            };
                        }
                        result.pass =
                            result.echoes === 10 &&
                            result.selected?.localType === 'relay' &&
                            result.selected?.remoteType === 'relay';
                    } catch (e) {
                        result.pass = false;
                        result.failure = e.message;
                    } finally {
                        clearTimeout(timer);
                        a.close();
                        b.close();
                    }
                    return result;
                },
                { url, first: await fetchConfig(endpoint), second: await fetchConfig(endpoint) }
            );
            console.log(JSON.stringify(result));
            if (!result.pass) process.exitCode = 1;
        }
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
