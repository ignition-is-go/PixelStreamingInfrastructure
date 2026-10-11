const assert = require('node:assert/strict');
const test = require('node:test');
const { snapshotMedia } = require('../media_diagnostics');

function entity(id, kind, stats) {
    return { id, kind, closed: false, paused: false, getStats: async () => stats };
}

test('media snapshot distinguishes producer input from consumer output', async () => {
    const producer = entity('input', 'video', [{ packetCount: 120 }]);
    const consumer = entity('output', 'video', [{ packetCount: 0 }]);
    consumer.paused = true;
    const snapshot = await snapshotMedia({ generation: 2,
        transport: entity('upstream', undefined, []), producers: [producer] },
    new Map([['viewer', { id: 'viewer', transport: entity('downstream', undefined, []), consumers: [consumer] }]]));
    assert.equal(snapshot.streamer.producers[0].stats[0].packetCount, 120);
    assert.equal(snapshot.peers[0].consumers[0].stats[0].packetCount, 0);
    assert.equal(snapshot.peers[0].consumers[0].paused, true);
});

test('disconnected snapshot has no streamer or viewers', async () => {
    const snapshot = await snapshotMedia(null, new Map());
    assert.equal(snapshot.streamer, null);
    assert.deepEqual(snapshot.peers, []);
});

test('entity closing during snapshot preserves the other evidence', async () => {
    const producer = entity('closing', 'video', []);
    producer.getStats = async () => { throw new Error('Producer closed'); };
    const snapshot = await snapshotMedia({ generation: 3,
        transport: entity('upstream', undefined, [{ bytesReceived: 500 }]), producers: [producer] }, new Map());
    assert.equal(snapshot.streamer.producers[0].error, 'Producer closed');
    assert.equal(snapshot.streamer.transport.stats[0].bytesReceived, 500);
});
