const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { prepare } = require('../prepare-production-smoke-client.cjs');

test('observer precedes application scripts and preserves the native constructor', () => {
    const html = prepare('<html><head><script src="player.js"></script></head></html>');
    assert.ok(html.indexOf('data-pixelstream-smoke-observer') < html.indexOf('src="player.js"'));
    const script = html.match(/<script data-pixelstream-smoke-observer="3">([\s\S]*?)<\/script>/)[1];
    class Native {
        constructor(...args) { this.args = args; }
        addEventListener(name, callback) { this[name] = callback; }
        static generateCertificate() { return 'native certificate'; }
    }
    class DataChannel {
        send(value) { this.sent = value; }
    }
    const window = { RTCPeerConnection: Native, RTCDataChannel: DataChannel };
    vm.runInNewContext(script, { window });
    const channel = new window.RTCDataChannel();
    channel.send(new Uint8Array([51, 0, 0]));
    channel.send('any application command');
    assert.equal(channel.sent, undefined);
    assert.equal(window.__pixelstreamSmokeBlockedDataMessages, 2);
    const peer = new window.RTCPeerConnection('configuration', 'constraints');
    assert.ok(peer instanceof Native);
    assert.deepEqual(peer.args, ['configuration', 'constraints']);
    assert.equal(window.RTCPeerConnection.generateCertificate(), 'native certificate');
    assert.equal(window.__pixelstreamSmokePeers[0], peer);
    const video = { jitterBufferTarget: null };
    const audio = { jitterBufferTarget: null };
    peer.track({ track: { kind: 'video' }, receiver: video });
    peer.track({ track: { kind: 'audio' }, receiver: audio });
    assert.equal(video.jitterBufferTarget, 200);
    assert.equal(audio.jitterBufferTarget, null);
    assert.equal(prepare(html), html);
});

test('observer refuses an unrelated document', () => {
    assert.throws(() => prepare('<video></video>'), /no head/);
});

test('observer permits the explicit 500 ms canary treatment', () => {
    assert.match(prepare('<head></head>', 500), /\)\(500\);<\/script>/);
    assert.throws(() => prepare('<head></head>', 501), /unsupported smoke buffer target/);
});

test('app observer identifies the build without taking over its receiver policy', () => {
    const commit = 'a'.repeat(40);
    const html = prepare('<head></head>', null, commit);
    const script = html.match(/<script data-pixelstream-smoke-observer="3">([\s\S]*?)<\/script>/)[1];
    class Native {
        addEventListener() { assert.fail('app observer must not set receiver parameters'); }
    }
    const window = { RTCPeerConnection: Native, RTCDataChannel: class {} };
    vm.runInNewContext(script, { window });
    new window.RTCPeerConnection();
    new window.RTCDataChannel().send('application command');
    assert.equal(window.__pixelstreamSmokeAppCommit, commit);
    assert.equal(window.__pixelstreamSmokeBlockedDataMessages, 1);
    assert.throws(() => prepare(html), /different smoke observer/);
    assert.throws(() => prepare('<head></head>', 500, commit), /no buffer override/);
});
