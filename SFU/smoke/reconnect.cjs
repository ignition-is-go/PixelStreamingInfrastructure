const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const repo = path.resolve(__dirname, '../..');
const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sfu-reconnect-'));
console.log('Smoke-test logs:', output);
const requireRepo = createRequire(path.join(repo, 'package.json'));
const { chromium } = requireRepo('playwright');
const children = [];
const pageErrors = [];
let browser, server;
function start(name, args) {
    const log = fs.openSync(path.join(output, name + '.log'), 'w');
    const p = spawn(process.execPath, args, { cwd: repo, stdio: ['ignore', log, log] });
    children.push(p);
    return p;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, description, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await fn()) return;
        await delay(200);
    }
    throw new Error('Timed out: ' + description);
}
(async () => {
    assert.deepEqual(
        Object.keys(require('node:os').networkInterfaces()).sort(),
        ['lo', 'smoke0'],
        'requires private dummy interface only'
    );
    assert.ok(
        fs
            .readFileSync('/proc/net/route', 'utf8')
            .trim()
            .split('\n')
            .slice(1)
            .every((line) => line.startsWith('smoke0\t')),
        'requires isolated namespace'
    );
    start('signalling', [
        'SignallingWebServer/dist/index.js',
        '--no_config',
        '--console_messages',
        'verbose',
        '--streamer_port',
        '18888',
        '--sfu_port',
        '18889',
        '--player_port',
        '18080',
        '--log_folder',
        path.join(output, 'signalling-logs')
    ]);
    start('sfu', [
        'SFU/sfu_server.js',
        '--signallingURL=ws://127.0.0.1:18889',
        '--PublicIP=10.200.0.1',
        `--workerCount=${process.env.SFU_WORKER_COUNT ?? 4}`
    ]);
    server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Isolated SFU smoke test</body></html>');
    });
    await new Promise((r) => server.listen(18081, '127.0.0.1', r));
    browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows'
        ]
    });
    const context = await browser.newContext();
    context.on('page', (p) => {
        p.on('console', (m) => console.log('browser:', m.text()));
        p.on('pageerror', (e) => {
            pageErrors.push(String(e));
            console.log('pageerror:', String(e));
        });
    });
    async function createViewer() {
        const viewer = await context.newPage();
        await viewer.goto('http://127.0.0.1:18081');
        await delay(1500);
        await viewer.evaluate(() => {
            window.errors = [];
            window.received = [];
            window.offers = 0;
            window.disconnections = 0;
            const send = (m) => window.ws.send(JSON.stringify(m));
            window.connectViewer = () => {
                window.ws = new WebSocket('ws://127.0.0.1:18080');
                ws.onclose = () => {
                    window.disconnections++;
                    window.subscribed = false;
                    window.pc?.close();
                    window.pc = null;
                    setTimeout(connectViewer, 300);
                };
                const setupChannel = (dc) => {
                    dc.binaryType = 'arraybuffer';
                    dc.onmessage = (e) => received.push(new TextDecoder().decode(e.data));
                };
                ws.onopen = () => send({ type: 'listStreamers' });
                ws.onmessage = async (e) => {
                    try {
                        const m = JSON.parse(e.data);
                        if (m.type === 'ping') send({ type: 'pong', time: m.time });
                        if (m.type !== 'streamerList') console.log('signal', m.type);
                        if (m.type === 'streamerList' && m.ids.includes('SFU') && !window.subscribed) {
                            window.subscribed = true;
                            send({ type: 'subscribe', streamerId: 'SFU' });
                        }
                        if (m.type === 'streamerDisconnected') {
                            window.subscribed = false;
                            window.disconnections++;
                            window.pc?.close();
                            window.pc = null;
                        }
                        if (m.type === 'offer') {
                            for (const old of document.querySelectorAll('video')) old.remove();
                            window.pc?.close();
                            window.pc = new RTCPeerConnection({ iceServers: [] });
                            window.offers++;
                            pc.ontrack = (e) => {
                                window.video = document.createElement('video');
                                video.autoplay = true;
                                video.muted = true;
                                video.srcObject = new MediaStream([e.track]);
                                document.body.append(video);
                                video.play();
                            };
                            await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
                            await pc.setLocalDescription(await pc.createAnswer());
                            send({ type: 'answer', sdp: pc.localDescription.sdp });
                            send({ type: 'dataChannelRequest' });
                        }
                        if (m.type === 'peerDataChannels') {
                            window.tx = pc.createDataChannel('send', {
                                negotiated: true,
                                id: m.sendStreamId
                            });
                            setupChannel(tx);
                            if (m.recvStreamId !== m.sendStreamId) {
                                window.rx = pc.createDataChannel('recv', {
                                    negotiated: true,
                                    id: m.recvStreamId
                                });
                                setupChannel(rx);
                            }
                            send({ type: 'peerDataChannelsReady' });
                        }
                    } catch (e) {
                        errors.push(String(e));
                        console.log('client error', String(e));
                    }
                };
            };
            connectViewer();
            window.poll = setInterval(() => {
                if (ws.readyState === 1) {
                    if (!window.pc && window.subscribed) {
                        send({ type: 'unsubscribe' });
                        window.subscribed = false;
                    }
                    send({ type: 'listStreamers' });
                }
            }, 500);
        });
        return viewer;
    }
    const viewer = await createViewer();
    await delay(1000);
    assert.equal(await viewer.evaluate(() => offers), 0);
    console.log('PASS: viewer connected before streamer, no premature offer');
    const streamer = await context.newPage();
    await streamer.goto('http://127.0.0.1:18081');
    await streamer.evaluate(() => {
        window.errors = [];
        window.received = [];
        window.channels = [];
        window.started = 0;
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        document.body.append(canvas);
        const ctx = canvas.getContext('2d');
        let tick = 0;
        setInterval(() => {
            ctx.fillStyle = `hsl(${tick++ % 360},100%,50%)`;
            ctx.fillRect(0, 0, 320, 180);
            ctx.fillStyle = 'black';
            ctx.fillText(String(tick), 20, 30);
        }, 33);
        window.stream = canvas.captureStream(30);
        window.audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();
        const oscillator = audioContext.createOscillator();
        oscillator.connect(destination);
        oscillator.start();
        stream.addTrack(destination.stream.getAudioTracks()[0]);
        window.start = () => {
            window.ws = new WebSocket('ws://127.0.0.1:18888');
            const send = (m) => ws.send(JSON.stringify(m));
            ws.onmessage = async (e) => {
                try {
                    const m = JSON.parse(e.data);
                    if (m.type === 'ping') send({ type: 'pong', time: m.time });
                    if (m.type !== 'streamerList') console.log('signal', m.type);
                    if (m.type === 'identify')
                        send({ type: 'endpointId', id: 'DefaultStreamer', protocolVersion: '1.0.0' });
                    if (m.type === 'playerConnected') {
                        window.pc?.close();
                        window.pc = new RTCPeerConnection({ iceServers: [] });
                        for (const track of stream.getTracks())
                            pc.addTransceiver(track, {
                                direction: 'sendonly',
                                streams: [stream]
                            });
                        const tx = pc.createDataChannel('send', { negotiated: true, id: 0 });
                        const rx = pc.createDataChannel('recv', { negotiated: true, id: 1 });
                        window.channels = [tx, rx];
                        rx.binaryType = 'arraybuffer';
                        rx.onmessage = (e) => {
                            const bytes = new Uint8Array(e.data);
                            if (bytes[0] === 199) {
                                const n = new DataView(bytes.buffer).getUint16(1, true);
                                received.push(new TextDecoder().decode(bytes.slice(3 + n)));
                                tx.send(bytes);
                            }
                        };
                        await pc.setLocalDescription(await pc.createOffer());
                        send({
                            type: 'offer',
                            playerId: m.playerId,
                            sdp: pc.localDescription.sdp,
                            multiplex: true
                        });
                    }
                    if (m.type === 'answer') {
                        await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
                        window.started++;
                    }
                    if (m.type === 'playerDisconnected') pc?.close();
                } catch (e) {
                    errors.push(String(e));
                    console.log('client error', String(e));
                }
            };
        };
        start();
    });
    async function verify(label, player = viewer) {
        await until(() => player.evaluate(() => window.tx?.readyState === 'open'), label + ' data channel');
        await until(
            () =>
                player.evaluate(() =>
                    [...document.querySelectorAll('video')].some(
                        (v) => v.getVideoPlaybackQuality().totalVideoFrames > 5
                    )
                ),
            label + ' video'
        ).catch(async (e) => {
            console.log(
                'viewer stats',
                JSON.stringify(
                    await player.evaluate(async () => ({
                        videos: [...document.querySelectorAll('video')].map((v) => ({
                            frames: v.getVideoPlaybackQuality().totalVideoFrames,
                            ready: v.readyState
                        })),
                        stats: [...(await pc.getStats())].filter(([k, v]) => v.type.includes('rtp'))
                    }))
                )
            );
            console.log(
                'streamer stats',
                await streamer.evaluate(async () =>
                    [...(await pc.getStats())].filter(([k, v]) => v.type.includes('rtp'))
                )
            );
            throw e;
        });
        await until(
            () =>
                player.evaluate(async () =>
                    [...(await pc.getStats()).values()].some(
                        (stat) =>
                            stat.type === 'inbound-rtp' &&
                            stat.kind === 'audio' &&
                            stat.bytesReceived > 0 &&
                            stat.totalSamplesReceived > 0
                    )
                ),
            label + ' decoded audio'
        );
        await player.evaluate((label) => tx.send(new TextEncoder().encode(label)), label);
        await until(
            () => streamer.evaluate((label) => received.includes(label), label),
            label + ' upstream data'
        );
        await until(
            () => player.evaluate((label) => received.includes(label), label),
            label + ' downstream data'
        );
        console.log(
            'PASS: ' + label + ' video, decoded audio and bidirectional multiplexed data',
            await player.evaluate(() =>
                [...document.querySelectorAll('video')].map(
                    (v) => v.getVideoPlaybackQuality().totalVideoFrames
                )
            )
        );
    }
    await verify('initial');
    const secondViewer = await createViewer();
    await verify('second viewer', secondViewer);
    const offers = await viewer.evaluate(() => window.offers);
    await streamer.evaluate(() => {
        ws.close();
        pc.close();
    });
    await until(() => viewer.evaluate(() => disconnections > 0), 'viewer observes disconnect');
    await streamer.evaluate(() => start());
    await until(() => viewer.evaluate((n) => offers > n, offers), 'replacement offer');
    await verify('reconnected');
    await verify('second viewer reconnected', secondViewer);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(await viewer.evaluate(() => errors), []);
    assert.deepEqual(await secondViewer.evaluate(() => errors), []);
    assert.deepEqual(await streamer.evaluate(() => errors), []);
    assert.doesNotMatch(
        fs.readFileSync(path.join(output, 'sfu.log'), 'utf8'),
        /TypeError|Failed to handle signalling/
    );
    console.log('PASS: no browser errors or SFU signalling exceptions');
})()
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (browser) await browser.close();
        if (server) server.close();
        for (const p of children) p.kill('SIGTERM');
        await Promise.all(
            children.map((p) =>
                p.exitCode !== null ? Promise.resolve() : new Promise((r) => p.once('exit', r))
            )
        );
    });
