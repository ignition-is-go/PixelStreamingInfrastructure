/**
 * @typedef {import('@ignition-is-go/pulse-reporting-types').SfuHealth} SfuHealth
 * @typedef {import('@ignition-is-go/pulse-reporting-types').MediaHealth} MediaHealth
 * @typedef {import('mediasoup').types.Producer} Producer
 * @typedef {import('mediasoup').types.Consumer} Consumer
 * @typedef {Pick<Producer, 'id' | 'kind' | 'paused'> & Partial<Pick<Consumer, 'producerPaused'>> & { getStats: Consumer['getStats'] }} ObservedMedia
 * @typedef {Pick<import('mediasoup').types.WebRtcTransport, 'iceState' | 'dtlsState'>} ObservedTransport
 * @typedef {{ generation: number, transport: ObservedTransport, producers: ObservedMedia[] }} ObservedUpstream
 * @typedef {{ id: string, transport?: ObservedTransport, consumers: ObservedMedia[] }} ObservedPeer
 */

/**
 * @param {ObservedMedia} media
 * @param {'in' | 'out'} direction
 * @returns {Promise<MediaHealth>}
 */
async function mediaObservation(media, direction) {
    try {
        const stats = (await media.getStats()).filter(row => row.type === `${direction}bound-rtp`);
        return {
            id: media.id, kind: media.kind, paused: media.paused || media.producerPaused === true,
            samples: stats.map(row => ({
                ssrc: row.ssrc, packets: row.packetCount, bytes: row.byteCount,
                bitrate: row.bitrate, packetsLost: row.packetsLost
            }))
        };
    } catch (error) {
        return { id: media.id, kind: media.kind, paused: media.paused || media.producerPaused === true, error: error instanceof Error ? error.message : String(error), samples: [] };
    }
}

/**
 * @param {ObservedUpstream} upstream
 * @param {ObservedPeer[]} peers
 * @returns {Promise<Omit<SfuHealth, 'validUntilMs'>>}
 */
async function collectHealth(upstream, peers) {
    const collectedAtMs = Date.now();
    const [inputs, viewers] = await Promise.all([
        Promise.all(upstream.producers.map(producer => mediaObservation(producer, 'in'))),
        Promise.all(peers.map(async peer => ({
            playerId: peer.id,
            iceState: peer.transport?.iceState || 'unreported',
            dtlsState: peer.transport?.dtlsState || 'unreported',
            outputs: await Promise.all(peer.consumers.map(consumer => mediaObservation(consumer, 'out')))
        })))
    ]);
    return {
        generation: upstream.generation,
        iceState: upstream.transport.iceState,
        dtlsState: upstream.transport.dtlsState,
        inputs, viewers,
        collectedAtMs
    };
}

/**
 * @param {{
 *   intervalMs: number,
 *   maxAgeMs: number,
 *   current: () => ObservedUpstream | null | undefined,
 *   peers: (upstream: ObservedUpstream) => ObservedPeer[],
 *   send: (report: SfuHealth) => void,
 *   onError: (error: unknown) => void
 * }} options
 */
function startHealthReporter({ intervalMs, maxAgeMs, current, peers, send, onError }) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(maxAgeMs) || maxAgeMs <= intervalMs) {
        throw new TypeError('healthIntervalMs must be positive and healthMaxAgeMs must exceed it');
    }
    let stopped = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    async function sample() {
        try {
            const upstream = current();
            if (upstream) {
                const report = await collectHealth(upstream, peers(upstream));
                if (!stopped && current() === upstream) send({ ...report, validUntilMs: report.collectedAtMs + maxAgeMs });
            }
        } catch (error) {
            onError(error);
        } finally {
            if (!stopped) timer = setTimeout(sample, intervalMs);
        }
    }
    void sample();
    return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { collectHealth, startHealthReporter };
