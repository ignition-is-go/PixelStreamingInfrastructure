const assert = require('node:assert/strict');
const test = require('node:test');

const { SignallingServer } = require('../dist/cjs/SignallingServer.js');

function sendConfig(config, override) {
    let sent;
    const connection = {
        sendMessage(message) {
            sent = message;
        }
    };
    SignallingServer.prototype.sendConfigMessage.call(
        {
            config,
            protocolConfig: { protocolVersion: '1.0', peerConnectionOptions: config.peerOptions }
        },
        connection,
        override
    );
    return sent.peerConnectionOptions;
}

test('config message uses static peer options when no provider is configured', () => {
    const peerOptions = { iceServers: [{ urls: ['stun:static.example.com'] }] };
    assert.equal(sendConfig({ peerOptions }), peerOptions);
});

test('config message falls back to the configured provider when no override is supplied', () => {
    const provided = { iceServers: [{ urls: ['turn:default.example.com'] }] };
    const config = { peerOptions: {}, peerOptionsProvider: () => provided };
    assert.equal(sendConfig(config), provided);
});

test('config message uses an explicit provider override', () => {
    const configured = { iceServers: [{ urls: ['turn:default.example.com'] }] };
    const overridden = { iceServers: [{ urls: ['turn:streamer.example.com'] }] };
    const config = { peerOptions: {}, peerOptionsProvider: () => configured };
    assert.equal(sendConfig(config, () => overridden), overridden);
});
