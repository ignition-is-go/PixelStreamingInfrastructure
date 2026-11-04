const assert = require('node:assert/strict');
const test = require('node:test');

const { StreamerRegistry } = require('../dist/cjs/StreamerRegistry.js');

function mockStreamer(initialId = '') {
    const handlers = new Map();
    const disconnects = [];
    const sent = [];
    const streamer = {
        streamerId: initialId,
        streaming: false,
        maxSubscribers: 0,
        subscribers: new Set(),
        transport: {},
        protocol: {
            on(type, handler) {
                handlers.set(type, handler);
            },
            disconnect(code, reason) {
                disconnects.push({ code, reason });
            }
        },
        emit() {},
        sendMessage(message) {
            sent.push(message);
        },
        getStreamerInfo() {
            return {};
        }
    };
    return {
        streamer,
        disconnects,
        sent,
        identify(id) {
            const handler = handlers.get('endpointId');
            assert.ok(handler, 'registry installed the endpointId handler');
            handler({ type: 'endpointId', id });
        }
    };
}

test('an explicitly named reconnect replaces the stale id holder', () => {
    const registry = new StreamerRegistry();
    const stale = mockStreamer();
    const replacement = mockStreamer();

    assert.equal(registry.add(stale.streamer), true);
    stale.identify('HRLV Rotunda');
    assert.equal(registry.find('HRLV Rotunda'), stale.streamer);

    assert.equal(registry.add(replacement.streamer), true);
    replacement.identify('HRLV Rotunda');

    assert.equal(registry.find('HRLV Rotunda'), replacement.streamer);
    assert.equal(registry.find('HRLV Rotunda1'), undefined);
    assert.equal(registry.count(), 1);
    assert.deepEqual(stale.disconnects, [{ code: 1000, reason: 'Replaced by new streamer with same id' }]);
});

test('anonymous streamers still receive unique generated ids', () => {
    const registry = new StreamerRegistry();
    const first = mockStreamer();
    const second = mockStreamer();

    assert.equal(registry.add(first.streamer), true);
    assert.equal(registry.add(second.streamer), true);
    assert.equal(first.streamer.streamerId, 'UnknownStreamer');
    assert.equal(second.streamer.streamerId, 'UnknownStreamer1');
});
