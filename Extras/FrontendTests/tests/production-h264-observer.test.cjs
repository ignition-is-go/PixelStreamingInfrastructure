const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
    const appBuild = { sourceCommit: 'a'.repeat(40), wasmSha256: 'b'.repeat(64) };
    const html = prepare('<head></head>', null, appBuild);
    const script = html.match(/<script data-pixelstream-smoke-observer="3">([\s\S]*?)<\/script>/)[1];
    class Native {
        addEventListener() { assert.fail('app observer must not set receiver parameters'); }
    }
    class DataChannel {
        send(value) { this.sent = value; }
    }
    const window = { RTCPeerConnection: Native, RTCDataChannel: DataChannel };
    vm.runInNewContext(script, { window });
    new window.RTCPeerConnection();
    const channel = new window.RTCDataChannel();
    const encode = (id, json) => Uint8Array.of(id, json.length, 0, ...Buffer.from(json, 'utf16le'));
    const request = '{"StreamCamera":{"RequestState":true}}';
    const allowed = encode(50, request);
    channel.send(allowed);
    channel.send(encode(50, '{"StreamCamera":{"RequestState":true,"ResetHome":true}}'));
    channel.send(encode(51, request));
    channel.send(Uint8Array.of(60, 87, 0));
    assert.equal(channel.sent, allowed);
    assert.equal(window.__pixelstreamSmokeStateRequests, 1);
    assert.equal(window.__pixelstreamSmokeAppBuild.sourceCommit, appBuild.sourceCommit);
    assert.equal(window.__pixelstreamSmokeAppBuild.wasmSha256, appBuild.wasmSha256);
    assert.equal(window.__pixelstreamSmokeBlockedDataMessages, 3);
    assert.throws(() => prepare(html), /different smoke observer/);
    assert.throws(() => prepare('<head></head>', 500, appBuild), /no buffer override/);
});

test('app preparation refuses a stale WASM file without changing the entry page', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'h264-app-observer-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const entry = path.join(directory, 'index.html');
    const html = '<head></head><script>init({module_or_path: "/app_bg.wasm"})</script>';
    fs.writeFileSync(entry, html);
    fs.writeFileSync(path.join(directory, 'app_bg.wasm'), 'stale bytes');
    const result = spawnSync(process.execPath, [require.resolve('../prepare-production-smoke-client.cjs'), entry], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PIXELSTREAM_SMOKE_CLIENT: 'app',
            PIXELSTREAM_APP_SOURCE_COMMIT: 'a'.repeat(40),
            PIXELSTREAM_APP_WASM_SHA256: createHash('sha256').update('candidate bytes').digest('hex')
        }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /WASM does not match/);
    assert.equal(fs.readFileSync(entry, 'utf8'), html);
});
