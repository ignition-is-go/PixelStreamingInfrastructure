const assert = require('node:assert/strict');
const test = require('node:test');
const {nalUnits, packetize} = require('./h264-profile-rtp.cjs');

test('Annex-B parsing accepts three and four byte start codes', () => {
    const first = Buffer.from([0x67, 0x42, 0xc0, 0x33]);
    const second = Buffer.from([0x68, 0x44, 0x55]);
    const stream = Buffer.concat([Buffer.from([0, 0, 0, 1]), first, Buffer.from([0, 0, 1]), second]);
    assert.deepEqual(nalUnits(stream), [first, second]);
});

test('FU-A fragments reconstruct the original NAL without changing encoded bytes', () => {
    const nals = [Buffer.from([0x67, 0x42, 0xc0, 0x33]),
        Buffer.concat([Buffer.from([0x65]), Buffer.alloc(10000, 0x44)])];
    for (const mtu of [1200, 1400, 1460]) {
        const result = packetize(nals, {mtu, sequence: 65530, timestamp: 90000, ssrc: 99});
        assert.equal(result.packets.filter(p => p[1] & 128).length, 1);
        assert.ok(result.packets.at(-1)[1] & 128);
        for (const [i, packet] of result.packets.entries()) {
            assert.ok(packet.length <= mtu);
            assert.equal(packet.readUInt16BE(2), (65530 + i) & 65535);
            assert.equal(packet.readUInt32BE(4), 90000);
            assert.equal(packet.readUInt32BE(8), 99);
            assert.equal(packet[1] & 127, 96);
        }
        const fragments = result.packets.slice(1);
        assert.ok(fragments[0][13] & 128);
        assert.ok(fragments.at(-1)[13] & 64);
        const restored = Buffer.concat([Buffer.from([(fragments[0][12] & 0xe0) | (fragments[0][13] & 31)]),
            ...fragments.map(p => p.subarray(14))]);
        assert.deepEqual(restored, nals[1]);
        assert.equal(result.nextSequence, (65530 + result.packets.length) & 65535);
    }
});

test('packet counts distinguish the 2048 packet boundary from an oversized frame', () => {
    for (const [bytes, expected] of [[1386 * 2048 + 1, 2048], [1386 * 2048 + 2, 2049]]) {
        const nal = Buffer.alloc(bytes, 0x44);
        nal[0] = 0x65;
        const {packets} = packetize([nal], {sequence: 1, timestamp: 1});
        assert.equal(packets.length, expected);
    }
});
