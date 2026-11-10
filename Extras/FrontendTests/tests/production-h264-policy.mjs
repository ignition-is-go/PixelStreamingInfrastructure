export const reportVersion = 2;

function requireCondition(condition, message) {
    if (!condition) throw new Error(message);
}

export function requireMediaFormat(sample, expected) {
    requireCondition(sample.connection === 'connected', 'media peer is not connected');
    requireCondition(sample.video.codec?.toLowerCase() === 'video/h264', 'received video is not H264');
    requireCondition(sample.audio.codec?.toLowerCase() === 'audio/opus', 'received audio is not Opus');
    requireCondition(
        sample.video.width === expected.width && sample.video.height === expected.height,
        'decoded resolution differs from the required resolution'
    );
    requireCondition(
        sample.protocols.length === 2 && sample.protocols.every((value) => value === 'udp'),
        'selected media transport is not UDP'
    );
    requireCondition(
        sample.relayProtocols.every((value) => value === 'udp'),
        'media uses a TCP or TLS TURN connection'
    );
    requireCondition(typeof sample.video.track === 'string' && typeof sample.video.statsId === 'string' &&
        Number.isFinite(sample.video.ssrc), 'rendered video identity is unavailable');
    requireCondition(Number.isFinite(sample.video.decoded), 'video decode counter is unavailable');
    requireCondition(Number.isSafeInteger(sample.video.freezes) && sample.video.freezes >= 0,
        'video freeze counter is unavailable');
    requireCondition(Number.isFinite(sample.audio.samples), 'audio decode counter is unavailable');
    if (expected.app) {
        requireCondition(Number.isInteger(sample.blockedDataMessages) && sample.blockedDataMessages >= 0,
            'read-only app observer is missing');
        requireCondition(sample.app?.sourceCommit === expected.app.sourceCommit, 'compiled app commit differs from the required commit');
        requireCondition(sample.app.wasmSha256 === expected.app.wasmSha256, 'compiled app WASM hash differs from the required hash');
        requireCondition(sample.app.route === expected.app.route, 'viewer is not playing the required media route');
        requireCondition(sample.app.audioEnabled === true, 'viewer audio is not enabled');
        requireCondition(sample.video.jitterBufferTarget === expected.app.bufferMs,
            'viewer did not apply the required video receiver target');
    }
}

export function requirePlayback(before, after, expected) {
    requireMediaFormat(before, expected);
    requireMediaFormat(after, expected);
    requireCondition(before.peer === after.peer, 'media peer changed during observation');
    for (const key of ['track', 'statsId', 'ssrc']) {
        requireCondition(before.video[key] === after.video[key], 'rendered video identity changed during observation');
    }
    const elapsed = (after.at - before.at) / 1000;
    requireCondition(elapsed >= expected.seconds, 'playback observation was too short');
    const decoded = after.video.decoded - before.video.decoded;
    const presented = after.video.presented - before.video.presented;
    requireCondition(decoded / elapsed >= expected.minimumFps, 'H264 decode rate is below the requirement');
    requireCondition(presented / elapsed >= expected.minimumFps, 'video presentation rate is below the requirement');
    requireCondition(
        Number.isFinite(before.video.presentationTime) && Number.isFinite(after.video.presentationTime) &&
            after.video.presentationTime - before.video.presentationTime >= elapsed * 1000 * 0.8,
        'video presentation time did not advance'
    );
    requireCondition(after.audio.packets > before.audio.packets, 'audio packets did not advance');
    const samples = after.audio.samples - before.audio.samples;
    requireCondition(
        Number.isFinite(after.audio.rate) && samples >= elapsed * after.audio.rate * 0.8,
        'decoded audio samples did not advance'
    );
    if (Number.isFinite(before.audio.concealed) && Number.isFinite(after.audio.concealed)) {
        requireCondition(
            (after.audio.concealed - before.audio.concealed) / samples <= 0.05,
            'audio concealment exceeds five percent'
        );
    }
    requireCondition(after.video.freezes === before.video.freezes, 'video froze during observation');
    return { seconds: elapsed, decoded, presented, audioSamples: samples };
}
