const assert = require('node:assert/strict');
const test = require('node:test');
const { collectHealth, startHealthReporter } = require('../health');
const media = (id, kind, rows) => ({ id, kind, paused: false, getStats: async () => rows });
const row = (type, packets) => ({ type, ssrc: 42, packetCount: packets, byteCount: packets * 100, bitrate: 8000, packetsLost: 2 });
const upstream = () => ({ generation: 2, transport: { iceState: 'completed', dtlsState: 'connected' }, producers: [media('video', 'video', [row('inbound-rtp', 10)])] });

test('reports ingress and each viewer independently without mixing consumer inbound stats', async () => {
    const report = await collectHealth(upstream(), [{ id: 'Player7', transport: { iceState: 'completed', dtlsState: 'connected' }, consumers: [media('out', 'video', [row('inbound-rtp', 100), row('outbound-rtp', 8)])] }]);
    assert.equal(report.inputs[0].samples[0].packets, 10);
    assert.equal(report.viewers[0].outputs[0].samples.length, 1);
    assert.equal(report.viewers[0].outputs[0].samples[0].packets, 8);
    assert.equal(report.viewers[0].playerId, 'Player7');
});

test('a failed stream observation does not fabricate counters or suppress other streams', async () => {
    const input = upstream();
    input.producers.push({ id: 'broken', kind: 'audio', paused: false, getStats: async () => { throw new Error('closed'); } });
    const report = await collectHealth(input, []);
    assert.equal(report.inputs[0].samples[0].packets, 10);
    assert.equal(report.inputs[1].error, 'closed');
    assert.deepEqual(report.inputs[1].samples, []);
});

test('late observations are discarded after generation replacement or reporter shutdown', async () => {
    let finish;
    let current = upstream();
    current.producers[0].getStats = () => new Promise(resolve => { finish = resolve; });
    const reports = [];
    const stop = startHealthReporter({ intervalMs: 1000, maxAgeMs: 3000, current: () => current, peers: () => [], send: report => reports.push(report), onError: assert.fail });
    current = upstream();
    finish([row('inbound-rtp', 10)]);
    await new Promise(setImmediate);
    stop();
    assert.deepEqual(reports, []);
});

test('freshness deadline is explicit in published reports', async () => {
    const input = upstream();
    let resolve;
    const observed = new Promise(done => { resolve = done; });
    const stop = startHealthReporter({ intervalMs: 1000, maxAgeMs: 3000, current: () => input, peers: () => [], send: resolve, onError: assert.fail });
    const report = await observed;
    stop();
    assert.equal(report.validUntilMs - report.collectedAtMs, 3000);
});

test('slow collection does not renew the age of an older sample', async () => {
    const input = upstream();
    let finish;
    input.producers[0].getStats = () => new Promise(resolve => { finish = resolve; });
    const pending = collectHealth(input, []);
    const issuedAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 25));
    finish([row('inbound-rtp', 10)]);
    assert.ok((await pending).collectedAtMs <= issuedAt);
});
