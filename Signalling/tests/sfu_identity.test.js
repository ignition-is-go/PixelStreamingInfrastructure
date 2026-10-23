const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { SFUConnection } = require('../dist/cjs/SFUConnection.js');
const { Messages } = require('@epicgames-ps/lib-pixelstreamingcommon-ue5.8');

test('SFU subscriptions carry registered identity independently of player ID', () => {
    const upstream = new EventEmitter();
    upstream.streamerId = 'program';
    upstream.subscribers = new Set();
    for (const [playerId, streamerId] of [['Player7', 'HRLV Program Local'], ['Player12', 'HRLV Program']]) {
        let received;
        const peer = {
            server: { streamerRegistry: { find: () => upstream } },
            streamerId, playerId, subscribedStreamer: null,
            heldByBarrier: () => undefined,
            sendToStreamer: message => { received = message; },
            layerPreferenceListener() {}, streamerIdChangeListener() {}, streamerDisconnectedListener() {}
        };
        SFUConnection.prototype.subscribe.call(peer, 'program');
        const decoded = Messages.playerConnected.fromJson(Messages.playerConnected.toJson(received));
        assert.equal(decoded.sfuStreamerId, streamerId);
        assert.equal(decoded.playerId, playerId);
        assert.equal(decoded.sfu, true);
    }
});
