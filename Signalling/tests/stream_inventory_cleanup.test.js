const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const { getEventListeners } = require('node:events');
const { StreamerRegistry } = require('../dist/cjs/StreamerRegistry.js');
const { StreamInventoryServer } = require('../dist/cjs/StreamInventoryServer.js');

test('closing inventory removes registry listener and disconnects observers', async () => {
    const registry = new StreamerRegistry();
    const publisher = new StreamInventoryServer(registry, { host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => publisher.server.once('listening', resolve));
    const socket = new WebSocket(`ws://127.0.0.1:${publisher.server.address().port}`);
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    assert.equal(getEventListeners(registry, 'changed').length, 1);
    const closed = new Promise((resolve) => socket.once('close', resolve));
    registry.notifyChanged();
    await publisher.close();
    await closed;
    assert.equal(getEventListeners(registry, 'changed').length, 0);
    registry.notifyChanged();
    assert.equal(publisher.server.clients.size, 0);
});
