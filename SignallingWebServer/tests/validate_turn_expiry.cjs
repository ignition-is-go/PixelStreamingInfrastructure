// Run only against an isolated signaller configured with a 60-second credential lifetime.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
    const endpoint = process.argv[2];
    if (!endpoint || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname))
        throw new Error('Provide the isolated local signaller WebSocket URL');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        const result = await page.evaluate(async (endpoint) => {
            async function config() {
                const ws = new WebSocket(endpoint);
                return await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                        ws.close();
                        reject(new Error('WS timeout'));
                    }, 5000);
                    ws.onmessage = (e) => {
                        const m = JSON.parse(e.data);
                        if (m.type === 'config') {
                            clearTimeout(timer);
                            ws.close();
                            resolve(m.peerConnectionOptions.iceServers.find((s) => s.username));
                        }
                    };
                    ws.onerror = () => {
                        clearTimeout(timer);
                        ws.close();
                        reject(new Error('WS failed'));
                    };
                });
            }
            let sequence = 0;
            const credentials = await config();
            const urls = typeof credentials.urls === 'string' ? [credentials.urls] : credentials.urls;
            const url = urls.find((url) => url.startsWith('turn:') && !url.includes('transport=tcp'));
            if (!url) throw new Error('Short-TTL fixture must advertise UDP TURN');
            async function pair(credentials) {
                const cfg = { iceServers: [{ ...credentials, urls: url }], iceTransportPolicy: 'relay' };
                const a = new RTCPeerConnection(cfg),
                    b = new RTCPeerConnection(cfg),
                    queues = new Map([
                        [a, []],
                        [b, []]
                    ]);
                for (const [pc, other] of [
                    [a, b],
                    [b, a]
                ])
                    pc.onicecandidate = (e) => {
                        if (e.candidate) {
                            if (other.remoteDescription) other.addIceCandidate(e.candidate).catch(() => {});
                            else queues.get(other).push(e.candidate);
                        }
                    };
                const channel = a.createDataChannel('expiry-proof');
                b.ondatachannel = (e) => (e.channel.onmessage = (m) => e.channel.send(m.data));
                async function negotiate() {
                    await a.setLocalDescription(await a.createOffer());
                    await b.setRemoteDescription(a.localDescription);
                    for (const c of queues.get(b).splice(0)) await b.addIceCandidate(c);
                    await b.setLocalDescription(await b.createAnswer());
                    await a.setRemoteDescription(b.localDescription);
                    for (const c of queues.get(a).splice(0)) await a.addIceCandidate(c);
                }
                async function echo(timeout = 20000) {
                    return await new Promise((resolve) => {
                        const marker = String(++sequence);
                        const timer = setTimeout(() => resolve(false), timeout);
                        channel.onmessage = (e) => {
                            if (e.data === marker) {
                                clearTimeout(timer);
                                resolve(true);
                            }
                        };
                        const send = () => channel.send(marker);
                        if (channel.readyState === 'open') send();
                        else channel.onopen = send;
                    });
                }
                const close = () => {
                    a.close();
                    b.close();
                };
                try {
                    await negotiate();
                    return { a, b, echo, negotiate, close };
                } catch (e) {
                    close();
                    throw e;
                }
            }
            const expiry = Number(credentials.username.split(':')[0]) * 1000;
            if (expiry - Date.now() > 90000 || expiry <= Date.now())
                throw new Error('Use a short-TTL fixture with 60–90 seconds remaining');
            const initial = await pair(credentials);
            try {
                const initialEcho = await initial.echo();
                if (!initialEcho) throw new Error('initial relay failed');
                while (Date.now() < expiry + 3000) {
                    await new Promise((r) => setTimeout(r, 5000));
                    if (!(await initial.echo(3000)))
                        throw new Error('existing pair failed before expiry check');
                }
                const existingEchoAfterExpiry = await initial.echo();
                initial.a.restartIce();
                await initial.negotiate();
                await new Promise((r) => setTimeout(r, 2000));
                const existingEchoAfterIceRestart = await initial.echo(5000);
                const expired = await pair(credentials);
                let expiredNewAllocationEcho;
                try {
                    expiredNewAllocationEcho = await expired.echo(20000);
                } finally {
                    expired.close();
                }
                const freshCredentials = await config();
                const fresh = await pair(freshCredentials);
                let freshNewAllocationEcho;
                try {
                    freshNewAllocationEcho = await fresh.echo();
                } finally {
                    fresh.close();
                }
                return {
                    initialEcho,
                    existingEchoAfterExpiry,
                    existingEchoAfterIceRestart,
                    expiredNewAllocationEcho,
                    freshNewAllocationEcho,
                    freshExpiryLater: Number(freshCredentials.username.split(':')[0]) * 1000 > expiry,
                    scope: 'Short-lived UDP allocations only; does not prove long-term allocation refresh or automatic client renewal'
                };
            } finally {
                initial.close();
            }
        }, endpoint);
        console.log(JSON.stringify(result));
        if (!result.initialEcho || result.expiredNewAllocationEcho || !result.freshNewAllocationEcho)
            process.exitCode = 1;
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
