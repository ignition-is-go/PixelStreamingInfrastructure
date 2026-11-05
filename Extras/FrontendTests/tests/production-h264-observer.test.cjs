const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { prepare } = require('../prepare-production-smoke-client.cjs');

test('observer precedes application scripts and preserves the native constructor', () => {
    const html = prepare('<html><head><script src="player.js"></script></head></html>');
    assert.ok(html.indexOf('data-pixelstream-smoke-observer') < html.indexOf('src="player.js"'));
    const script = html.match(/<script data-pixelstream-smoke-observer="2">([\s\S]*?)<\/script>/)[1];
    class Native {
        constructor(...args) { this.args = args; }
        static generateCertificate() { return 'native certificate'; }
    }
    const window = { RTCPeerConnection: Native };
    vm.runInNewContext(script, { window });
    const peer = new window.RTCPeerConnection('configuration', 'constraints');
    assert.ok(peer instanceof Native);
    assert.deepEqual(peer.args, ['configuration', 'constraints']);
    assert.equal(window.RTCPeerConnection.generateCertificate(), 'native certificate');
    assert.equal(window.__pixelstreamSmokePeers[0], peer);
    assert.equal(prepare(html), html);
});

test('observer refuses an unrelated document', () => {
    assert.throws(() => prepare('<video></video>'), /no head/);
});
