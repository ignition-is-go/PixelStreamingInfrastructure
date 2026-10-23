const assert = require('node:assert/strict');
const test = require('node:test');
const mediasoup = require('mediasoup');
const { collectHealth } = require('../health');

test('native mediasoup producer and consumer counters survive health collection', async () => {
    const worker = await mediasoup.createWorker();
    try {
        const router = await worker.createRouter({ mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }] });
        const transport = await router.createDirectTransport();
        const producer = await transport.produce({ kind: 'audio', rtpParameters: {
            codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
            encodings: [{ ssrc: 42 }]
        } });
        const output = await router.createDirectTransport();
        const consumer = await output.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities });
        consumer.on('rtp', () => {});
        for (let index = 0; index < 10; index++) {
            const rtp = Buffer.from([0x80, 111, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42, 0xf8, 0xff, 0xfe]);
            rtp.writeUInt16BE(index, 2);
            rtp.writeUInt32BE(index * 960, 4);
            producer.send(rtp);
        }
        const report = await collectHealth({ generation: 1, transport: { iceState: 'not-applicable', dtlsState: 'not-applicable' }, producers: [producer] }, [{ id: 'native-viewer', transport: { iceState: 'not-applicable', dtlsState: 'not-applicable' }, consumers: [consumer] }]);
        assert.equal(report.inputs[0].error, undefined);
        assert.equal(report.inputs[0].samples.length, 1);
        assert.ok(report.inputs[0].samples[0].packets >= 9);
        assert.ok(report.inputs[0].samples[0].bytes > 0);
        assert.equal(report.inputs[0].kind, 'audio');
        assert.equal(report.viewers[0].outputs[0].samples.length, 1);
        assert.ok(report.viewers[0].outputs[0].samples[0].packets >= 9);
        assert.ok(report.viewers[0].outputs[0].samples[0].bytes > 0);
    } finally {
        worker.close();
    }
});
