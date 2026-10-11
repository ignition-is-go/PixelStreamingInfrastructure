async function inspectMediaEntity(entity) {
    const snapshot = {
        id: entity.id,
        kind: entity.kind,
        closed: entity.closed,
        paused: entity.paused,
        producerPaused: entity.producerPaused,
        iceState: entity.iceState,
        dtlsState: entity.dtlsState,
        rtpParameters: entity.rtpParameters
    };
    try {
        snapshot.stats = await entity.getStats();
    } catch (error) {
        snapshot.error = String(error.message || error);
    }
    return snapshot;
}

async function snapshotMedia(streamer, peers) {
    const currentPeers = [...peers.values()];
    return {
        at: new Date().toISOString(),
        streamer: streamer === null ? null : {
            generation: streamer.generation,
            transport: await inspectMediaEntity(streamer.transport),
            producers: await Promise.all(streamer.producers.map(inspectMediaEntity))
        },
        peers: await Promise.all(currentPeers.map(async peer => ({
            id: peer.id,
            transport: peer.transport === null ? null : await inspectMediaEntity(peer.transport),
            consumers: await Promise.all(peer.consumers.map(inspectMediaEntity))
        })))
    };
}

module.exports = { snapshotMedia };
