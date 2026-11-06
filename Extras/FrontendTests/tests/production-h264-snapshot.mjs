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
    const receiver = peer.getReceivers().find((item) => item.track?.id === track.id);
    const reports = await peer.getStats();
    const renderedReports = await receiver.getStats();
    const inbound = [...reports.values()].filter((item) => item.type === 'inbound-rtp' && !item.isRemote);
    const active = (kind) => inbound
        .filter((item) => (item.kind ?? item.mediaType) === kind && item.codecId && item.bytesReceived > 0)
        .sort((a, b) => (b.lastPacketReceivedTimestamp ?? 0) - (a.lastPacketReceivedTimestamp ?? 0) ||
            b.bytesReceived - a.bytesReceived)[0];
    const videoStats = [...renderedReports.values()].find((item) =>
        item.type === 'inbound-rtp' && !item.isRemote &&
        (item.kind ?? item.mediaType) === 'video' && item.codecId && item.bytesReceived > 0 &&
        (!item.trackIdentifier || item.trackIdentifier === track.id));
    const audioStats = active('audio');
    if (!videoStats || !audioStats) throw new Error('video and audio RTP statistics are not ready');
    const transport = reports.get(videoStats.transportId);
    const pair = reports.get(transport?.selectedCandidatePairId);
    if (!transport || !pair) throw new Error('rendered video transport has no selected candidate pair');
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
    if (video.srcObject.getVideoTracks()[0]?.id !== track.id || receiver.track?.id !== track.id) {
        throw new Error('rendered track changed while sampling');
    }
    const audioCodec = reports.get(audioStats.codecId);
    const playback = video.getVideoPlaybackQuality?.();
    return {
        at: Date.now(),
        visibility: document.visibilityState ?? null,
        peer: peers.indexOf(peer),
        connection: peer.connectionState,
        protocols: candidates.map((item) => item?.protocol?.toLowerCase() ?? 'unknown'),
        relayProtocols: candidates.flatMap((item) => item?.relayProtocol ? [item.relayProtocol.toLowerCase()] : []),
        video: {
            track: track.id,
            statsId: videoStats.id,
            ssrc: videoStats.ssrc,
            codec: (renderedReports.get(videoStats.codecId) ?? reports.get(videoStats.codecId))?.mimeType ?? null,
            width: video.videoWidth,
            height: video.videoHeight,
            decoded: videoStats.framesDecoded ?? null,
            presented: metadata.presentedFrames,
            playbackTotal: playback?.totalVideoFrames ?? null,
            playbackDropped: playback?.droppedVideoFrames ?? null,
            mediaTime: metadata.mediaTime,
            presentationTime: metadata.presentationTime,
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

// Keep failure evidence useful without recording endpoints, ICE credentials or tokens.
export async function mediaDiagnostics() {
    const codecs = (sdp) => (sdp ?? '').split(/\r?\n/).filter((line) =>
        /^(m=(audio|video) |a=(rtpmap|fmtp|sendonly|recvonly|inactive|sendrecv)(:|$))/.test(line));
    const peers = [];
    for (const peer of (window.__pixelstreamSmokePeers ?? []).filter((item) => item.connectionState !== 'closed')) {
        const stats = await peer.getStats();
        peers.push({
            connection: peer.connectionState, ice: peer.iceConnectionState,
            signalling: peer.signalingState,
            offer: codecs(peer.remoteDescription?.sdp), answer: codecs(peer.localDescription?.sdp),
            inbound: [...stats.values()].filter((item) => item.type === 'inbound-rtp').map((item) => ({
                kind: item.kind ?? item.mediaType, track: item.trackIdentifier, ssrc: item.ssrc,
                codec: stats.get(item.codecId)?.mimeType, decoded: item.framesDecoded,
                received: item.framesReceived, dropped: item.framesDropped,
                packets: item.packetsReceived, lost: item.packetsLost, bytes: item.bytesReceived
            }))
        });
    }
    return { receiverCodecs: typeof RTCRtpReceiver.getCapabilities === 'function'
        ? RTCRtpReceiver.getCapabilities('video')?.codecs : null, peers };
}
