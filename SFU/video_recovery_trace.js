const LOG_PREFIX = 'VIDEO_RECOVERY';

function writeLog(logger, level, prefix, payload) {
    try {
        logger[level](`${prefix} ${JSON.stringify(payload)}`);
    } catch (_) {
    }
}

function reportFailure(logger, label, error) {
    writeLog(logger, 'error', 'VIDEO_RECOVERY_ERROR', {
        operation: label,
        error: error?.message || String(error)
    });
}

function enableTrace(entity, types, handler, logger, label) {
    try {
        entity.on('trace', handler);
    } catch (error) {
        reportFailure(logger, `${label}_listener`, error);
        return;
    }

    let activation;
    try {
        activation = entity.enableTraceEvent(types);
    } catch (error) {
        reportFailure(logger, `${label}_enable`, error);
        return;
    }

    void Promise.resolve(activation).catch((error) => {
        reportFailure(logger, `${label}_enable`, error);
    });
}

function traceVideoProducer(producer, {
    enabled,
    generation,
    logger = console,
    now = Date.now
}) {
    if (!enabled || producer.kind !== 'video') {
        return;
    }

    const handler = (trace) => {
        try {
            if (trace?.type !== 'keyframe') {
                return;
            }
            const packet = trace.info?.rtpPacket;
            writeLog(logger, 'log', LOG_PREFIX, {
                event: 'producer_keyframe',
                observedAt: now(),
                traceTimestamp: trace.timestamp,
                direction: trace.direction,
                upstreamGeneration: generation,
                producerId: producer.id,
                ssrc: packet?.ssrc,
                sequenceNumber: packet?.sequenceNumber,
                rtpTimestamp: packet?.timestamp,
                isRtx: trace.info?.isRtx
            });
        } catch (error) {
            reportFailure(logger, 'producer_trace', error);
        }
    };

    enableTrace(producer, ['keyframe'], handler, logger, 'producer_trace');
}

function traceVideoConsumer(consumer, {
    enabled,
    peerId,
    generation,
    logger = console,
    now = Date.now
}) {
    if (!enabled || consumer.kind !== 'video') {
        return;
    }

    // mediasoup 3.15.5 emits each Consumer trace object twice. Remembering the
    // object avoids double-counting without merging distinct feedback packets.
    const seen = new WeakSet();
    const handler = (trace) => {
        try {
            if (!trace || (trace.type !== 'pli' && trace.type !== 'fir')) {
                return;
            }
            if (typeof trace === 'object') {
                if (seen.has(trace)) {
                    return;
                }
                seen.add(trace);
            }
            writeLog(logger, 'log', LOG_PREFIX, {
                event: 'consumer_feedback',
                feedback: trace.type,
                observedAt: now(),
                traceTimestamp: trace.timestamp,
                direction: trace.direction,
                peerId,
                upstreamGeneration: generation,
                consumerId: consumer.id,
                producerId: consumer.producerId,
                ssrc: trace.info?.ssrc
            });
        } catch (error) {
            reportFailure(logger, 'consumer_trace', error);
        }
    };

    enableTrace(consumer, ['pli', 'fir'], handler, logger, 'consumer_trace');
}

module.exports = { traceVideoConsumer, traceVideoProducer };
