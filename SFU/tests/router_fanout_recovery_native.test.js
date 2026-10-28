const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const mediasoup = require('mediasoup');
const { createRouterFanout } = require('../router_fanout');

async function lossyPipe() {
    const sockets = [dgram.createSocket('udp4'), dgram.createSocket('udp4')];
    await Promise.all(sockets.map(socket => new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))));
    const destinations = [];
    let videoPackets = 0;
    let droppedSequence;
    for (const [side, socket] of sockets.entries()) {
        socket.on('message', packet => {
            const isRtp = packet.length >= 12 && packet[0] >> 6 === 2 &&
                !(packet[1] >= 192 && packet[1] <= 223);
            if (side === 0 && isRtp && ++videoPackets === 3) {
                droppedSequence = packet.readUInt16BE(2);
                return;
            }
            const target = destinations[1 - side];
            if (target) sockets[1 - side].send(packet, target, '127.0.0.1');
        });
    }
    return {
        redirect(transport, side) {
            destinations[side] = transport.tuple.localPort;
            const connect = transport.connect.bind(transport);
            transport.connect = options => connect({ ...options, ip: '127.0.0.1', port: sockets[side].address().port });
        },
        droppedSequence: () => droppedSequence,
        close() { for (const socket of sockets) socket.close(); }
    };
}

test('inter-worker video repairs packet loss and preserves control data', { timeout: 10000 }, async () => {
    const proxy = await lossyPipe();
    const routers = [];
    const nativeMediasoup = {
        async createWorker(options) {
            const worker = await mediasoup.createWorker(options);
            const createRouter = worker.createRouter.bind(worker);
            worker.createRouter = async options => {
                const router = await createRouter(options);
                const side = routers.length;
                routers.push(router);
                const createPipeTransport = router.createPipeTransport.bind(router);
                router.createPipeTransport = async options => {
                    const transport = await createPipeTransport(options);
                    proxy.redirect(transport, side);
                    return transport;
                };
                return router;
            };
            return worker;
        }
    };
    let fanout;
    try {
        fanout = await createRouterFanout({
            mediasoup: nativeMediasoup,
            workerCount: 2,
            workerOptions: { rtcMinPort: 56000, rtcMaxPort: 56099, logLevel: 'warn' },
            routerOptions: { mediaCodecs: [{ kind: 'video', mimeType: 'video/H264', clockRate: 90000,
                parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f' } }] },
            webRtcTransportOptions: { listenIps: [{ ip: '127.0.0.1' }] },
            onWorkerDied() { assert.fail('native worker died'); },
            logger: { log() {}, error() {} }
        });
        const input = await fanout.ingressRouter.createDirectTransport();
        const producer = await input.produce({ kind: 'video', rtpParameters: {
            codecs: [{ mimeType: 'video/H264', payloadType: 102, clockRate: 90000,
                parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f' },
                rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }] }],
            encodings: [{ ssrc: 42 }]
        } });
        const bootstrap = fanout.openGeneration({ generation: 0, producers: [] });
        const bootstrapRoute = await bootstrap.openPlayer({ playerId: 'data-first', isCurrent: () => true });
        assert.equal(bootstrapRoute.kind, 'ready');
        const bootstrapData = await input.produceData({ label: 'bootstrap' });
        const bootstrapPipe = await bootstrapRoute.route.fromIngress(bootstrapData);
        assert.equal(bootstrapPipe.kind, 'ready');
        bootstrap.close();
        bootstrapData.close();
        const generation = fanout.openGeneration({ generation: 1, producers: [producer] });
        const result = await generation.openPlayer({ playerId: 'native-viewer', isCurrent: () => true });
        assert.equal(result.kind, 'ready');
        const pipedProducer = result.route.mediaProducers[0];
        const output = await routers[1].createDirectTransport();
        const consumer = await output.consume({ producerId: pipedProducer.id, rtpCapabilities: routers[1].rtpCapabilities });
        const received = new Set();
        consumer.on('rtp', packet => received.add(packet[packet.length - 1]));
        for (let index = 0; index < 20; index++) {
            const packet = Buffer.alloc(32);
            packet[0] = 0x80;
            packet[1] = 102 | (index === 19 ? 0x80 : 0);
            packet.writeUInt16BE(100 + index, 2);
            packet.writeUInt32BE(90000, 4);
            packet.writeUInt32BE(42, 8);
            packet[12] = index === 0 ? 0x67 : 0x7c;
            packet[13] = index === 0 ? 0x42 : 0x05 | (index === 1 ? 0x80 : index === 19 ? 0x40 : 0);
            packet[31] = index;
            producer.send(packet);
            await delay(2);
        }
        const deadline = Date.now() + 1500;
        while (!received.has(2) && Date.now() < deadline) await delay(20);
        const [ingressStats] = await producer.getStats();
        assert.ok(ingressStats.packetCount >= 19, `ingress did not receive test video: ${JSON.stringify(ingressStats)}`);
        assert.notEqual(proxy.droppedSequence(), undefined, 'the inter-worker proxy must drop a real RTP packet');
        const [stats] = await pipedProducer.getStats();
        assert.ok(stats.packetsRepaired >= 1, `pipe did not repair the lost fragment: ${JSON.stringify(stats)}`);
        assert.ok(received.has(2), 'the repaired fragment must reach the downstream consumer');

        const controls = await output.produceData({ label: 'controls' });
        const upstream = await result.route.toIngress(controls);
        assert.equal(upstream.kind, 'ready');
        const controlReceiver = await input.consumeData({ dataProducerId: upstream.producer.id });
        const controlMessage = once(controlReceiver, 'message', { signal: AbortSignal.timeout(1500) });
        controls.send(Buffer.from('camera input'));
        assert.equal((await controlMessage)[0].toString(), 'camera input');

        const responses = await input.produceData({ label: 'responses' });
        const downstream = await result.route.fromIngress(responses);
        assert.equal(downstream.kind, 'ready');
        const responseReceiver = await output.consumeData({ dataProducerId: downstream.producer.id });
        const responseMessage = once(responseReceiver, 'message', { signal: AbortSignal.timeout(1500) });
        responses.send(Buffer.from('camera response'));
        assert.equal((await responseMessage)[0].toString(), 'camera response');
    } finally {
        fanout?.close();
        proxy.close();
    }
});
