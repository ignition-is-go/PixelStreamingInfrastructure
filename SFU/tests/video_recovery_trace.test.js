const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { traceVideoConsumer, traceVideoProducer } = require('../video_recovery_trace');

class TraceEntity extends EventEmitter {
    constructor(fields) {
        super();
        Object.assign(this, fields);
        this.enabled = [];
        this.statsCalls = 0;
    }

    enableTraceEvent(types) {
        this.enabled.push(types);
    }

    getStats() {
        this.statsCalls += 1;
        return Promise.resolve([{
            type: 'outbound-rtp', ssrc: 21, packetsLost: 2, fractionLost: 3,
            nackCount: 4, nackPacketCount: 5, pliCount: 6, firCount: 7,
            packetsRetransmitted: 8, score: 9, roundTripTime: 10,
            byteCount: 11, packetCount: 12, bitrate: 13
        }]);
    }
}

function recordingLogger() {
    return {
        logs: [],
        errors: [],
        log(line) { this.logs.push(line); },
        error(line) { this.errors.push(line); }
    };
}

function payload(line) {
    return JSON.parse(line.slice(line.indexOf('{')));
}

test('disabled tracing has no effect on mediasoup entities', () => {
    const producer = new TraceEntity({ id: 'producer', kind: 'video' });
    const consumer = new TraceEntity({ id: 'consumer', producerId: 'producer', kind: 'video' });

    traceVideoProducer(producer, { enabled: false, generation: 1 });
    traceVideoConsumer(consumer, { enabled: false, peerId: 'peer', generation: 1 });

    assert.equal(producer.listenerCount('trace'), 0);
    assert.equal(consumer.listenerCount('trace'), 0);
    assert.deepEqual(producer.enabled, []);
    assert.deepEqual(consumer.enabled, []);
    assert.equal(consumer.statsCalls, 0);
});

test('tracing attributes feedback, outbound stats, and keyframe boundaries', async () => {
    const logger = recordingLogger();
    const producer = new TraceEntity({ id: 'producer', kind: 'video' });
    const consumer = new TraceEntity({ id: 'consumer', producerId: 'producer', kind: 'video' });

    traceVideoProducer(producer, { enabled: true, generation: 7, logger, now: () => 1000 });
    traceVideoConsumer(consumer, {
        enabled: true, peerId: 'peer', generation: 7, logger, now: () => 1001
    });

    const pli = { type: 'pli', timestamp: 10, direction: 'in', info: { ssrc: 11 } };
    consumer.emit('trace', pli);
    consumer.emit('trace', pli);
    producer.emit('trace', {
        type: 'keyframe',
        timestamp: 12,
        direction: 'in',
        info: {
            isRtx: false,
            rtpPacket: {
                ssrc: 13,
                sequenceNumber: 14,
                timestamp: 15,
                size: 1200n,
                payloadSize: 1188n
            }
        }
    });
    await new Promise(setImmediate);

    assert.deepEqual(producer.enabled, [['keyframe']]);
    assert.deepEqual(consumer.enabled, [['pli', 'fir']]);
    assert.equal(logger.logs.length, 3);
    assert.deepEqual(payload(logger.logs[0]), {
        event: 'consumer_feedback', feedback: 'pli', observedAt: 1001,
        traceTimestamp: 10, direction: 'in', peerId: 'peer', upstreamGeneration: 7,
        consumerId: 'consumer', producerId: 'producer', ssrc: 11
    });
    assert.deepEqual(payload(logger.logs[1]), {
        event: 'producer_keyframe', observedAt: 1000, traceTimestamp: 12,
        direction: 'in', upstreamGeneration: 7, producerId: 'producer', ssrc: 13,
        sequenceNumber: 14, rtpTimestamp: 15, isRtx: false
    });
    assert.deepEqual(payload(logger.logs[2]), {
        event: 'consumer_feedback_stats', feedback: 'pli', observedAt: 1001,
        traceTimestamp: 10, direction: 'in', peerId: 'peer', upstreamGeneration: 7,
        consumerId: 'consumer', producerId: 'producer', ssrc: 21,
        packetsLost: 2, fractionLost: 3, nackCount: 4, nackPacketCount: 5,
        pliCount: 6, firCount: 7, packetsRetransmitted: 8, score: 9,
        roundTripTime: 10, byteCount: 11, packetCount: 12, bitrate: 13
    });
    assert.equal(consumer.statsCalls, 1);
});

test('consumer feedback allows at most one pending stats request', async () => {
    const logger = recordingLogger();
    const consumer = new TraceEntity({ id: 'consumer', producerId: 'producer', kind: 'video' });
    let resolveStats;
    consumer.getStats = () => {
        consumer.statsCalls += 1;
        return new Promise((resolve) => { resolveStats = resolve; });
    };
    traceVideoConsumer(consumer, {
        enabled: true, peerId: 'peer', generation: 1, logger
    });

    consumer.emit('trace', { type: 'pli', timestamp: 1, direction: 'in', info: { ssrc: 2 } });
    consumer.emit('trace', { type: 'fir', timestamp: 2, direction: 'in', info: { ssrc: 2 } });
    await new Promise(setImmediate);
    assert.equal(consumer.statsCalls, 1);
    resolveStats([]);
    await new Promise(setImmediate);
    consumer.emit('trace', { type: 'pli', timestamp: 3, direction: 'in', info: { ssrc: 2 } });
    await new Promise(setImmediate);
    assert.equal(consumer.statsCalls, 2);
    resolveStats([]);
    await new Promise(setImmediate);
});

test('consumer stats rejection stays contained', async () => {
    const logger = recordingLogger();
    const consumer = new TraceEntity({ id: 'consumer', producerId: 'producer', kind: 'video' });
    consumer.getStats = () => Promise.reject(new Error('stats unavailable'));
    traceVideoConsumer(consumer, {
        enabled: true, peerId: 'peer', generation: 1, logger
    });

    assert.doesNotThrow(() => consumer.emit('trace', {
        type: 'pli', timestamp: 1, direction: 'in', info: { ssrc: 2 }
    }));
    await new Promise(setImmediate);
    assert.equal(logger.errors.length, 1);
    assert.equal(payload(logger.errors[0]).operation, 'consumer_stats');
});

test('activation and logger failures cannot escape into media setup', async () => {
    const entity = new TraceEntity({ id: 'consumer', producerId: 'producer', kind: 'video' });
    entity.enableTraceEvent = () => Promise.reject(new Error('worker refused trace'));
    const logger = {
        log() { throw new Error('logger failed'); },
        error() { throw new Error('logger failed'); }
    };

    assert.doesNotThrow(() => traceVideoConsumer(entity, {
        enabled: true, peerId: 'peer', generation: 1, logger
    }));
    assert.doesNotThrow(() => entity.emit('trace', {
        type: 'fir', timestamp: 1, direction: 'in', info: { ssrc: 2 }
    }));
    await new Promise(setImmediate);
});

test('synchronous listener registration failure stays contained', () => {
    const entity = new TraceEntity({ id: 'consumer', producerId: 'producer', kind: 'video' });
    entity.on = () => { throw new Error('listener refused trace'); };
    const logger = recordingLogger();

    assert.doesNotThrow(() => traceVideoConsumer(entity, {
        enabled: true, peerId: 'peer', generation: 1, logger
    }));
    assert.equal(entity.enabled.length, 0);
    assert.equal(logger.errors.length, 1);
    assert.equal(payload(logger.errors[0]).operation, 'consumer_trace_listener');
});

test('synchronous trace activation failure stays contained', () => {
    const entity = new TraceEntity({ id: 'producer', kind: 'video' });
    entity.enableTraceEvent = () => { throw new Error('worker refused trace'); };
    const logger = recordingLogger();

    assert.doesNotThrow(() => traceVideoProducer(entity, {
        enabled: true, generation: 1, logger
    }));
    assert.equal(entity.listenerCount('trace'), 1);
    assert.equal(logger.errors.length, 1);
    assert.equal(payload(logger.errors[0]).operation, 'producer_trace_enable');
});

test('audio entities are not traced', () => {
    const producer = new TraceEntity({ id: 'audio', kind: 'audio' });
    traceVideoProducer(producer, { enabled: true, generation: 1 });
    assert.equal(producer.listenerCount('trace'), 0);
    assert.deepEqual(producer.enabled, []);
    assert.equal(producer.statsCalls, 0);
});
