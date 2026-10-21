const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const mediasoup = require('mediasoup');
const { traceVideoConsumer, traceVideoProducer } = require('../video_recovery_trace');

test('real worker reports consumer PLI and its H264 keyframe boundary', async () => {
    const worker = await mediasoup.createWorker({ logLevel: 'error' });
    try {
        const router = await worker.createRouter({
            mediaCodecs: [{
                kind: 'video', mimeType: 'video/H264', clockRate: 90000,
                parameters: {
                    'packetization-mode': 1,
                    'profile-level-id': '42e01f',
                    'level-asymmetry-allowed': 1
                }
            }]
        });
        const source = await router.createDirectTransport();
        const receiver = await router.createDirectTransport();
        const producer = await source.produce({
            kind: 'video',
            rtpParameters: {
                codecs: [{
                    mimeType: 'video/H264', payloadType: 96, clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '42e01f',
                        'level-asymmetry-allowed': 1
                    },
                    rtcpFeedback: [
                        { type: 'nack', parameter: 'pli' },
                        { type: 'ccm', parameter: 'fir' }
                    ]
                }],
                encodings: [{ ssrc: 1111 }]
            }
        });
        const consumer = await receiver.consume({
            producerId: producer.id,
            rtpCapabilities: router.rtpCapabilities
        });
        const lines = [];
        const errors = [];
        const logger = {
            log: (line) => lines.push(line),
            error: (line) => errors.push(line)
        };
        traceVideoProducer(producer, { enabled: true, generation: 4, logger });
        traceVideoConsumer(consumer, {
            enabled: true, peerId: 'worker-peer', generation: 4, logger
        });

        const sps = Buffer.alloc(15);
        sps[0] = 0x80;
        sps[1] = 0x80 | 96;
        sps.writeUInt16BE(1, 2);
        sps.writeUInt32BE(3000, 4);
        sps.writeUInt32BE(1111, 8);
        sps.set([0x67, 0x42, 0xe0], 12);
        producer.send(sps);

        const pli = Buffer.alloc(12);
        pli[0] = 0x81;
        pli[1] = 206;
        pli.writeUInt16BE(2, 2);
        pli.writeUInt32BE(2222, 4);
        pli.writeUInt32BE(consumer.rtpParameters.encodings[0].ssrc, 8);
        receiver.sendRtcp(pli);
        await sleep(100);

        const receipts = lines.map((line) => JSON.parse(line.slice(line.indexOf('{'))));
        assert(receipts.some((receipt) =>
            receipt.event === 'consumer_feedback' &&
            receipt.feedback === 'pli' &&
            receipt.peerId === 'worker-peer' &&
            receipt.upstreamGeneration === 4 &&
            receipt.consumerId === consumer.id &&
            receipt.producerId === producer.id
        ));
        assert(receipts.some((receipt) =>
            receipt.event === 'producer_keyframe' &&
            receipt.upstreamGeneration === 4 &&
            receipt.producerId === producer.id
        ));
        const stats = receipts.find((receipt) => receipt.event === 'consumer_feedback_stats');
        assert(stats);
        assert.equal(stats.peerId, 'worker-peer');
        assert.equal(stats.upstreamGeneration, 4);
        assert.equal(stats.consumerId, consumer.id);
        assert.equal(stats.producerId, producer.id);
        assert.equal(typeof stats.packetCount, 'number');
        assert.equal(typeof stats.byteCount, 'number');
        assert.equal(typeof stats.bitrate, 'number');
        assert.deepEqual(errors, []);
    } finally {
        worker.close();
    }
});
