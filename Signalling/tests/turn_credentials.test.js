const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const test = require('node:test');

const { createTurnRestIceServer } = require('../dist/cjs/TurnCredentials.js');

test('creates a short-lived coturn REST credential', () => {
    const urls = ['turn:edge.example:3478?transport=udp', 'turns:edge.example:443?transport=tcp'];
    const server = createTurnRestIceServer(urls, 'test-secret', 600, 1_700_000_000);

    assert.deepEqual(server.urls, urls);
    assert.equal(server.username, '1700000600:pixelstream');
    assert.equal(
        server.credential,
        createHmac('sha1', 'test-secret').update(server.username).digest('base64')
    );
});

test('enforces a one-minute minimum credential lifetime', () => {
    const server = createTurnRestIceServer(['turn:edge.example'], 'secret', 1, 100);
    assert.equal(server.username, '160:pixelstream');
});
