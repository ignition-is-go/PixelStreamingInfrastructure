const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const mediasoup = require('mediasoup');
const { createRouterFanout } = require('../router_fanout');

test('inter-worker 4K motion bursts do not require packet repair', { timeout: 20000 }, async () => {
    const routers = [];
    let fanout;
    try {
        const codec = {
            kind: 'video', mimeType: 'video/H264', clockRate: 90000,
            parameters: { 'packetization-mode': 1, 'profile-level-id': '64001f' },
            rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }]
        };
        fanout = await createRouterFanout({
            mediasoup: {
                async createWorker(options) {
                    const worker = await mediasoup.createWorker(options);
                    const createRouter = worker.createRouter.bind(worker);
                    worker.createRouter = async options => {
                        const router = await createRouter(options);
                        routers.push(router);
                        return router;
                    };
                    return worker;
                }
            },
            workerCount: 2,
            workerOptions: { logLevel: 'error' },
            routerOptions: { mediaCodecs: [codec] },
            webRtcTransportOptions: { listenIps: [{ ip: '127.0.0.1' }] },
            onWorkerDied() { assert.fail('native worker died'); },
            logger: { log() {}, error() {} }
        });
        const input = await fanout.ingressRouter.createDirectTransport();
        const producer = await input.produce({
            kind: 'video',
            rtpParameters: { codecs: [{ ...codec, payloadType: 103 }], encodings: [{ ssrc: 42 }] }
        });
        const generation = fanout.openGeneration({ generation: 1, producers: [producer] });
        const opened = await generation.openPlayer({ playerId: 'burst', isCurrent: () => true });
        const pipeProducer = opened.route.mediaProducers[0];
        const output = await routers[1].createDirectTransport();
        const consumer = await output.consume({
            producerId: pipeProducer.id, rtpCapabilities: routers[1].rtpCapabilities
        });
        const received = new Set();
        consumer.on('rtp', packet => received.add(packet.readUInt32BE(packet.length - 4)));
        const packetsPerFrame = 613;
        let index = 0;
        for (let frame = 0; frame < 120; frame++) {
            const started = Date.now();
            for (let fragment = 0; fragment < packetsPerFrame; fragment++, index++) {
                const packet = Buffer.alloc(1400);
                packet[0] = 0x80;
                packet[1] = 103 | (fragment === packetsPerFrame - 1 ? 0x80 : 0);
                packet.writeUInt16BE(index % 65536, 2);
                packet.writeUInt32BE(90000 + frame * 3000, 4);
                packet.writeUInt32BE(42, 8);
                packet[12] = fragment === 0 ? 0x67 : 0x7c;
                packet[13] = fragment === 0 ? 0x42 : 5 |
                    (fragment === 1 ? 0x80 : 0) | (fragment === packetsPerFrame - 1 ? 0x40 : 0);
                packet.writeUInt32BE(index, packet.length - 4);
                producer.send(packet);
            }
            await delay(Math.max(1, 33 - (Date.now() - started)));
        }
        await delay(2500);
        const [ingress] = await producer.getStats();
        const [pipe] = await pipeProducer.getStats();
        assert.equal(ingress.packetCount, index, 'the ingress must receive the complete stimulus');
        assert.equal(received.size, index, 'every fragment must reach the downstream consumer');
        assert.equal(pipe.packetsLost, 0, JSON.stringify(pipe));
        assert.equal(pipe.packetsRepaired, 0, 'the pipe must carry bursts without retransmission');
    } finally {
        fanout?.close();
    }
});
