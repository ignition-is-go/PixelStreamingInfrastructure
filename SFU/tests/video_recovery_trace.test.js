const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { traceVideoConsumer, traceVideoProducer } = require('../video_recovery_trace');

class TraceEntity extends EventEmitter {
    constructor(fields) {
        super();
        Object.assign(this, fields);
        this.enabled = [];
    }

    enableTraceEvent(types) {
        this.enabled.push(types);
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
});

test('tracing attributes feedback and keyframe boundaries without serializing BigInt fields', () => {
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

    assert.deepEqual(producer.enabled, [['keyframe']]);
    assert.deepEqual(consumer.enabled, [['pli', 'fir']]);
    assert.equal(logger.logs.length, 2);
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
});
