// This function is serialized into the real browser by WebDriver.
export async function mediaSnapshot() {
    const video = [...document.querySelectorAll('video')].find(
        (element) => element.srcObject instanceof MediaStream && element.videoWidth > 0
    );
    if (!video) throw new Error('decoded video is not ready');
    const track = video.srcObject.getVideoTracks()[0];
    const peers = window.__pixelstreamSmokePeers;
    if (!Array.isArray(peers)) throw new Error('reference-client observer is missing');
    const peer = peers.find(
        (candidate) => candidate.connectionState === 'connected' &&
            candidate.getReceivers().some((receiver) => receiver.track?.id === track.id)
    );
    if (!peer) throw new Error('rendered video has no connected observed peer');
    const reports = await peer.getStats();
    const inbound = [...reports.values()].filter((item) => item.type === 'inbound-rtp' && !item.isRemote);
    const active = (kind) => inbound
        .filter((item) => (item.kind ?? item.mediaType) === kind && item.codecId && item.bytesReceived > 0)
        .sort((a, b) => (b.lastPacketReceivedTimestamp ?? 0) - (a.lastPacketReceivedTimestamp ?? 0) ||
            b.bytesReceived - a.bytesReceived)[0];
    const videoStats = active('video');
    const audioStats = active('audio');
    if (!videoStats || !audioStats) throw new Error('video and audio RTP statistics are not ready');
    const transport = reports.get(videoStats.transportId);
    const pair = reports.get(transport?.selectedCandidatePairId) ??
        [...reports.values()].find(
            (item) => item.type === 'candidate-pair' && item.state === 'succeeded' &&
                (item.selected || item.nominated)
        );
    const candidates = pair
        ? [reports.get(pair.localCandidateId), reports.get(pair.remoteCandidateId)]
        : [];
    const metadata = await new Promise((resolve, reject) => {
        if (!video.requestVideoFrameCallback) {
            reject(new Error('video presentation callback is unavailable'));
            return;
        }
        const timer = setTimeout(() => reject(new Error('video presentation timed out')), 5000);
        video.requestVideoFrameCallback((_now, frame) => {
            clearTimeout(timer);
            resolve(frame);
        });
    });
    const audioCodec = reports.get(audioStats.codecId);
    return {
        at: Date.now(),
        peer: peers.indexOf(peer),
        connection: peer.connectionState,
        protocols: candidates.map((item) => item?.protocol?.toLowerCase() ?? 'unknown'),
        relayProtocols: candidates.flatMap((item) => item?.relayProtocol ? [item.relayProtocol.toLowerCase()] : []),
        video: {
            codec: reports.get(videoStats.codecId)?.mimeType ?? null,
            width: video.videoWidth,
            height: video.videoHeight,
            decoded: videoStats.framesDecoded ?? null,
            presented: metadata.presentedFrames,
            mediaTime: metadata.mediaTime,
            freezes: videoStats.freezeCount ?? null,
            dropped: videoStats.framesDropped ?? null
        },
        audio: {
            codec: audioCodec?.mimeType ?? null,
            rate: audioCodec?.clockRate ?? null,
            packets: audioStats.packetsReceived ?? 0,
            samples: audioStats.totalSamplesReceived ?? audioStats.jitterBufferEmittedCount ?? null,
            concealed: audioStats.concealedSamples ?? null
        }
    };
}
