function nalUnits(data) {
    const starts = [];
    for (let i = 0; i + 3 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            starts.push({ start: i, payload: i + 3 });
            i += 2;
        } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
            starts.push({ start: i, payload: i + 4 });
            i += 3;
        }
    }
    return starts.map((entry, i) => data.subarray(entry.payload, starts[i + 1]?.start ?? data.length));
}

function packetize(nals, {mtu = 1400, sequence, timestamp, ssrc = 42}) {
    const packets = [];
    function emit(payload, marker) {
        const packet = Buffer.alloc(12 + payload.length);
        packet[0] = 0x80;
        packet[1] = 96 | (marker ? 0x80 : 0);
        packet.writeUInt16BE(sequence, 2);
        packet.writeUInt32BE(timestamp >>> 0, 4);
        packet.writeUInt32BE(ssrc, 8);
        payload.copy(packet, 12);
        packets.push(packet);
        sequence = (sequence + 1) & 65535;
    }
    for (const [index, nal] of nals.entries()) {
        const lastNal = index === nals.length - 1;
        if (nal.length <= mtu - 12) {
            emit(nal, lastNal);
            continue;
        }
        for (let offset = 1; offset < nal.length; offset += mtu - 14) {
            const end = Math.min(offset + mtu - 14, nal.length);
            const payload = Buffer.alloc(2 + end - offset);
            payload[0] = (nal[0] & 0xe0) | 28;
            payload[1] = (nal[0] & 31) | (offset === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0);
            nal.copy(payload, 2, offset, end);
            emit(payload, lastNal && end === nal.length);
        }
    }
    return {packets, nextSequence: sequence};
}

module.exports = { nalUnits, packetize };
