const config = require('./config');
const WebSocket = require('ws');
const mediasoup = require('mediasoup');
const mediasoupSdp = require('@epicgames-ps/mediasoup-sdp-bridge');
const minimist = require('minimist');
const { createDataRouter } = require('./data_router');
const { runSafely } = require('./async_helpers');
const { GenerationRegistry } = require('./generation_registry');
const { SignallingWatchdog, reconnectDelayMs } = require('./signalling_watchdog');
const { StreamerLivenessMonitor } = require('./streamer_liveness');

if (!config.retrySubscribeDelaySecs) {
    config.retrySubscribeDelaySecs = 10;
}
if (!config.signallingHeartbeatIntervalSecs) {
    config.signallingHeartbeatIntervalSecs = 10;
}
if (!config.signallingHeartbeatTimeoutSecs) {
    config.signallingHeartbeatTimeoutSecs = 30;
}
if (!config.signallingConnectTimeoutSecs) {
    config.signallingConnectTimeoutSecs = 10;
}
if (!config.signallingReconnectMinDelaySecs) {
    config.signallingReconnectMinDelaySecs = 2;
}
if (!config.signallingReconnectMaxDelaySecs) {
    config.signallingReconnectMaxDelaySecs = 30;
}
if (!config.streamerDisconnectGraceSecs) {
    config.streamerDisconnectGraceSecs = 5;
}

let signalServer = null;
let signallingWatchdog = null;
let signallingReconnectTimer = null;
let signallingReconnectAttempt = 0;
let streamerDiscoveryTimer = null;
let mediasoupRouter;
let streamer = null;
const streamerGenerations = new GenerationRegistry();
let peers = new Map();
let dataRouter;
let scalabilityMode = "L1T1"; // Scalability mode defaults to L1T1 and is set by the offer from the streamer

function sendSignalling(message) {
    const socket = signalServer;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
        console.warn(`Cannot send ${message.type}: signalling server is not connected`);
        return false;
    }

    try {
        socket.send(JSON.stringify(message));
        return true;
    } catch (error) {
        console.error(`Failed to send ${message.type} to signalling server: ${error.message}`);
        return false;
    }
}

function scheduleSignallingReconnect(server) {
    if (signallingReconnectTimer !== null) {
        return;
    }

    const delayMs = reconnectDelayMs(
        signallingReconnectAttempt,
        config.signallingReconnectMinDelaySecs * 1000,
        config.signallingReconnectMaxDelaySecs * 1000
    );
    signallingReconnectAttempt += 1;
    console.log(`Reconnecting to signalling server in ${delayMs}ms...`);
    signallingReconnectTimer = setTimeout(() => {
        signallingReconnectTimer = null;
        connectSignalling(server);
    }, delayMs);
}

function scheduleStreamerDiscovery() {
    if (streamerDiscoveryTimer !== null) {
        return;
    }
    streamerDiscoveryTimer = setTimeout(() => {
        streamerDiscoveryTimer = null;
        if (streamer === null && streamerGenerations.pending === null) {
            sendSignalling({ type: 'listStreamers' });
        }
    }, config.retrySubscribeDelaySecs * 1000);
}

function connectSignalling(server) {
    console.log("Connecting to Signalling Server at %s", server);
    const socket = new WebSocket(server, {
        handshakeTimeout: config.signallingConnectTimeoutSecs * 1000
    });
    signalServer = socket;
    socket.addEventListener("open", _ => {
        signallingReconnectAttempt = 0;
        console.log(`Connected to signalling server`);
        signallingWatchdog = new SignallingWatchdog(socket, {
            intervalMs: config.signallingHeartbeatIntervalSecs * 1000,
            timeoutMs: config.signallingHeartbeatTimeoutSecs * 1000,
            openState: WebSocket.OPEN,
            onStale: () => {
                if (signalServer === socket) {
                    socket.terminate();
                }
            }
        });
        signallingWatchdog.start();
    });
    socket.addEventListener("error", result => { console.log(`Error: ${result.message}`); });
    socket.addEventListener("message", result => {
        if (signalServer === socket) {
            signallingWatchdog?.recordActivity();
            void runSafely('Failed to handle signalling message', () => onSignallingMessage(result.data));
        }
    });
    socket.on("pong", () => {
        if (signalServer === socket) {
            signallingWatchdog?.recordActivity();
        }
    });
    socket.addEventListener("close", result => {
        // Ignore a late close from a socket that has already been superseded.
        if (signalServer !== socket) {
            return;
        }

        signallingWatchdog?.stop();
        signallingWatchdog = null;
        signalServer = null;
        try {
            // The signalling socket is already closed. Tear down local media state
            // without trying to send stopStreaming on it; that synchronous send used
            // to throw here and prevent the reconnect timer from ever being scheduled.
            onStreamerDisconnected(false);
        } catch (error) {
            console.error(`Failed to clean up after signalling disconnect: ${error.stack || error.message}`);
        } finally {
            console.log(`Disconnected from signalling server: ${result.code} ${result.reason}`);
            scheduleSignallingReconnect(server);
        }
    });
}

async function onStreamerList(msg) {
    // Ignore our own published id and the transient name used before an Unreal
    // streamer commits its real endpoint id. Subscribing to UnknownStreamer can
    // succeed at the signalling layer just before it is renamed, leaving the SFU
    // waiting forever for an offer that will never arrive.
    const streamerIds = msg.ids.filter(id => id !== config.SFUId && id !== 'UnknownStreamer');

    // subscribe to either the configured streamer, or if not configured, just grab the first id
    if (streamerIds.length > 0) {
        if (!!config.subscribeStreamerId && config.subscribeStreamerId.length != 0) {
            if (streamerIds.includes(config.subscribeStreamerId)) {
                sendSignalling({ type: 'subscribe', streamerId: config.subscribeStreamerId });
            }
        } else {
            sendSignalling({ type: 'subscribe', streamerId: streamerIds[0] });
        }
    }

    // A successful WebSocket send is not an upstream acknowledgement. Keep a
    // bounded discovery retry armed until an actual streamer offer arrives.
    scheduleStreamerDiscovery();
}

async function onIdentify(msg) {
    sendSignalling({ type: 'endpointId', id: config.SFUId });
    sendSignalling({ type: 'listStreamers' });
}

async function onStreamerOffer(msg) {
    console.log("Got offer from streamer");

    if (streamerDiscoveryTimer !== null) {
        clearTimeout(streamerDiscoveryTimer);
        streamerDiscoveryTimer = null;
    }

    if (streamer !== null || streamerGenerations.pending !== null) {
        console.warn('Ignoring duplicate streamer offer while a producer generation is already active');
        return;
    }

    if (msg.scalabilityMode) {
        scalabilityMode = msg.scalabilityMode;
    }

    const candidate = streamerGenerations.begin({
        cancelled: false,
        transport: null,
        producers: [],
        dataEnabled: false,
        multiplexChannels: msg.multiplex,
        dataChannelsStarted: false,
        streamerDataProducer: null,
        streamerDataConsumer: null,
        dataRoute: null,
        liveness: null
    });
    candidate.liveness = new StreamerLivenessMonitor({
        disconnectGraceMs: config.streamerDisconnectGraceSecs * 1000,
        onDead: (reason) => {
            if (streamerGenerations.pending === candidate || streamerGenerations.isCurrent(candidate)) {
                console.warn(`Streamer generation ${candidate.generation} is no longer usable: ${reason}`);
                onStreamerDisconnected();
            }
        }
    });

    try {
        candidate.transport = await createWebRtcTransport(
            "Streamer",
            (iceState) => onStreamerICEStateChange(candidate, iceState),
            (sctpState) => candidate.liveness.onSctpState(sctpState)
        );
        if (streamerGenerations.pending !== candidate || candidate.cancelled) {
            candidate.transport.close();
            return;
        }

        const sdpEndpoint = mediasoupSdp.createSdpEndpoint(candidate.transport, mediasoupRouter.rtpCapabilities);
        const offerResult = await sdpEndpoint.processOffer(msg.sdp, scalabilityMode);
        if (streamerGenerations.pending !== candidate || candidate.cancelled) {
            for (const producer of offerResult.producers) {
                producer.close();
            }
            candidate.transport.close();
            return;
        }

        candidate.producers = offerResult.producers;
        candidate.dataEnabled = offerResult.dataEnabled;
        if (!streamerGenerations.activate(candidate)) {
            throw new Error(`streamer generation ${candidate.generation} was superseded during setup`);
        }
        streamer = candidate;

        console.log("Sending answer to streamer.");
        if (!sendSignalling({ type: "answer", sdp: sdpEndpoint.createAnswer() })) {
            onStreamerDisconnected(false);
        }
    } catch (error) {
        if (streamerGenerations.pending === candidate) {
            streamerGenerations.cancelPending();
        }
        candidate.liveness.stop();
        if (streamerGenerations.isCurrent(candidate)) {
            streamerGenerations.clearCurrent(candidate);
            streamer = null;
        }
        for (const producer of candidate.producers) {
            producer.close();
        }
        if (candidate.transport && !candidate.transport.closed) {
            candidate.transport.close();
        }
        scheduleStreamerDiscovery();
        throw error;
    }
}

function onStreamerDisconnected(notifySignalling = true) {
    console.log("Streamer disconnected");

    if (streamerGenerations.pending !== null) {
        const pending = streamerGenerations.cancelPending();
        pending.cancelled = true;
        pending.liveness?.stop();
        for (const producer of pending.producers) {
            producer.close();
        }
        if (pending.transport && !pending.transport.closed) {
            pending.transport.close();
        }
    }

    const disconnectedStreamer = streamer;
    streamer = null;
    streamerGenerations.clearCurrent(disconnectedStreamer);
    disconnectAllPeers();

    if (disconnectedStreamer !== null) {
        disconnectedStreamer.liveness?.stop();
        dataRouter.closeStreamer(disconnectedStreamer.generation);
        for (const mediaProducer of disconnectedStreamer.producers) {
            mediaProducer.close();
        }
        if (!disconnectedStreamer.transport.closed) {
            disconnectedStreamer.transport.close();
        }
        if (notifySignalling) {
            sendSignalling({ type: 'stopStreaming' });
        }
    }

    // The signalling server can report streamerDisconnected after local media
    // teardown has already cleared `streamer`. Resubscription must not depend on
    // that local state, otherwise the SFU never discovers the streamer returning.
    if (notifySignalling) {
        scheduleStreamerDiscovery();
    }
}

function isCurrentPeer(peer, upstream = streamer) {
    return !peer.closed && peers.get(peer.id) === peer && upstream !== null &&
        streamer === upstream && peer.streamerGeneration === upstream.generation;
}

function closePeer(peer) {
    if (!peer) {
        return;
    }

    if (!peer.closed) {
        peer.closed = true;
        if (peers.get(peer.id) === peer) {
            peers.delete(peer.id);
        }
    }

    if (peer.dataRouterPlayer) {
        dataRouter.closePlayer(peer.dataRouterPlayer);
        peer.dataRouterPlayer = null;
    }
    for (const consumer of peer.consumers) {
        if (!consumer.closed) {
            consumer.close();
        }
    }
    for (const entity of [
        peer.peerDataConsumer,
        peer.peerDataProducer,
        peer.streamerDataConsumer,
        peer.streamerDataProducer,
        peer.transport
    ]) {
        if (entity && !entity.closed) {
            entity.close();
        }
    }
}

async function onPeerConnected(peerId) {
    console.log("Player %s joined", peerId);

    const upstream = streamer;
    if (upstream === null) {
        console.log("No streamer connected, ignoring player.");
        return;
    }

    const existingPeer = peers.get(peerId);
    if (existingPeer) {
        closePeer(existingPeer);
    }

    const peer = {
        id: peerId,
        streamerGeneration: upstream.generation,
        transport: null,
        sdpEndpoint: null,
        consumers: [],
        peerDataProducer: null,
        peerDataConsumer: null,
        streamerDataProducer: null,
        streamerDataConsumer: null,
        dataRouterPlayer: null,
        dataChannelsStarted: false,
        closed: false
    };
    peers.set(peerId, peer);

    try {
        peer.transport = await createWebRtcTransport("Peer " + peerId);
        if (!isCurrentPeer(peer, upstream)) {
            closePeer(peer);
            return;
        }
        peer.sdpEndpoint = mediasoupSdp.createSdpEndpoint(peer.transport, mediasoupRouter.rtpCapabilities);

        for (const mediaProducer of upstream.producers) {
            // mediasoup recommends creating server-side consumers paused until
            // the browser has applied the SDP answer. Starting immediately can
            // request the only useful keyframe before the remote receiver is
            // ready, producing a connected-but-black player until a later IDR.
            const consumer = await peer.transport.consume({
                producerId: mediaProducer.id,
                rtpCapabilities: mediasoupRouter.rtpCapabilities,
                paused: true
            });
            if (!isCurrentPeer(peer, upstream)) {
                consumer.close();
                closePeer(peer);
                return;
            }
            consumer.observer.on("layerschange", function() { console.log("layer changed!", consumer.currentLayers); });
            peer.sdpEndpoint.addConsumer(consumer);
            peer.consumers.push(consumer);
        }

        if (upstream.dataEnabled) {
            peer.sdpEndpoint.receiveData();
        }

        const offerSignal = {
            type: "offer",
            playerId: peerId,
            sdp: peer.sdpEndpoint.createOffer(),
            sfu: true, // indicate we're offering from sfu
            scalabilityMode: scalabilityMode
        };

        if (!sendSignalling(offerSignal)) {
            closePeer(peer);
        }
    } catch (error) {
        closePeer(peer);
        throw error;
    }
}

async function setupPeerDataChannels(peerId) {
    const peer = peers.get(peerId);
    if (!peer) {
        console.error(`Could not send browser any datachannels for peer=${peerId} because peer was not found.`);
        return;
    }

    const upstream = streamer;
    if (!isCurrentPeer(peer, upstream)) {
        closePeer(peer);
        return;
    }
    if (peer.dataChannelsStarted) {
        return;
    }
    peer.dataChannelsStarted = true;

    if (upstream.multiplexChannels) {
        await setupMultiplexPeerDataChannels(peer, upstream);
        return;
    }

    const nextStreamerSCTPStreamId = upstream.transport.getNextSctpStreamId();
    const nextPeerSCTPStreamId = peer.transport.getNextSctpStreamId();

    console.log(`Attempting streamer SCTP id=${nextStreamerSCTPStreamId}`);

    // streamer data producer (produces data for the peer)
    peer.streamerDataProducer = await upstream.transport.produceData({ label: 'send-datachannel', sctpStreamParameters: { streamId: nextStreamerSCTPStreamId, ordered: true } });
    if (!isCurrentPeer(peer, upstream)) {
        closePeer(peer);
        return;
    }

    console.log(`Attempting peer SCTP id=${nextPeerSCTPStreamId}`);

    // peer data producer (produces data for the streamer)
    peer.peerDataProducer = await peer.transport.produceData({ label: 'send-datachannel', sctpStreamParameters: { streamId: nextPeerSCTPStreamId, ordered: true } });
    if (!isCurrentPeer(peer, upstream)) {
        closePeer(peer);
        return;
    }

    // peer data consumer (consumes streamer data)
    peer.peerDataConsumer = await peer.transport.consumeData({ dataProducerId: peer.streamerDataProducer.id });
    if (!isCurrentPeer(peer, upstream)) {
        closePeer(peer);
        return;
    }

    // streamer data consumer (consumes peer data)
    peer.streamerDataConsumer = await upstream.transport.consumeData({ dataProducerId: peer.peerDataProducer.id });
    if (!isCurrentPeer(peer, upstream)) {
        closePeer(peer);
        return;
    }

    const peerSignal = {
        type: 'peerDataChannels',
        playerId: peerId,
        sendStreamId: peer.peerDataProducer.sctpStreamParameters.streamId,
        recvStreamId: peer.peerDataConsumer.sctpStreamParameters.streamId
    };

    // Send browser a message with a send/recv data channel SCTP stream id
    if (!sendSignalling(peerSignal)) {
        closePeer(peer);
    }

}

async function setupMultiplexPeerDataChannels(peer, upstream) {
    //this will be always 0 as we are using only one producer
    const nextPeerSCTPStreamId = peer.transport.getNextSctpStreamId();
    peer.peerDataProducer = await peer.transport.produceData({ label: 'send-datachannel', sctpStreamParameters: { streamId: nextPeerSCTPStreamId, ordered: true } });
    if (!isCurrentPeer(peer, upstream)) {
        closePeer(peer);
        return;
    }

    peer.dataRouterPlayer = await dataRouter.preparePlayer(peer.peerDataProducer, peer.id, upstream.generation);
    if (!peer.dataRouterPlayer || !isCurrentPeer(peer, upstream)) {
        closePeer(peer);
        return;
    }

    peer.peerDataConsumer = await peer.transport.consumeData({ dataProducerId: peer.dataRouterPlayer.producer.id });
    if (!isCurrentPeer(peer, upstream) || !dataRouter.activatePlayer(peer.dataRouterPlayer)) {
        closePeer(peer);
        return;
    }
    console.log('peerProducerId %s, peerConsumerId %s', peer.peerDataProducer.id, peer.peerDataConsumer.id);

    const peerSignal = {
        type: 'peerDataChannels',
        playerId: peer.id,
        sendStreamId: peer.peerDataProducer.sctpStreamParameters.streamId,
        recvStreamId: peer.peerDataConsumer.sctpStreamParameters.streamId
    };
    if (!sendSignalling(peerSignal)) {
        closePeer(peer);
    }
}

async function setupStreamerDataChannelsForPeer(peerId) {
    const upstream = streamer;
    if (upstream === null) {
        return;
    }
    if (upstream.multiplexChannels) {
        return;
    }

    const peer = peers.get(peerId);
    if (!peer) {
        console.error(`Could not send streamer any datachannels for peer=${peerId} because peer was not found.`);
        return;
    }

    if (!peer.streamerDataProducer || !peer.streamerDataConsumer) {
        console.error(`There was no streamer data producer/consumer setup for peer=${peerId}. Did you make sure to send "dataChannelRequest" first?`);
        return;
    }

    const streamerSignal = {
        type: "streamerDataChannels",
        playerId: peerId,
        sendStreamId: peer.streamerDataProducer.sctpStreamParameters.streamId,
        recvStreamId: peer.streamerDataConsumer.sctpStreamParameters.streamId
    };

    // send streamer a message with a send/recv data channel SCTP stream id
    if (!isCurrentPeer(peer, upstream) || !sendSignalling(streamerSignal)) {
        closePeer(peer);
    }
}

async function onPeerAnswer(peerId, sdp) {
    console.log("Got answer from player %s", peerId);

    const peer = peers.get(peerId);
    if (!peer) {
        console.error(`Unable to find player ${peerId}`);
    }
    else {
        const upstream = streamer;
        try {
            await peer.sdpEndpoint.processAnswer(sdp);
            if (!isCurrentPeer(peer, upstream)) {
                closePeer(peer);
                return;
            }
            for (const consumer of peer.consumers) {
                await consumer.resume();
                if (!isCurrentPeer(peer, upstream)) {
                    closePeer(peer);
                    return;
                }
                if (consumer.kind === 'video') {
                    await consumer.requestKeyFrame();
                    if (!isCurrentPeer(peer, upstream)) {
                        closePeer(peer);
                        return;
                    }
                }
            }
        } catch (error) {
            closePeer(peer);
            console.error(`Failed to activate media for player ${peerId}: ${error.stack || error.message}`);
        }
    }
}

function onPeerDisconnected(peerId) {
    console.log("Player %s disconnected", peerId);
    const peer = peers.get(peerId);
    if (peer) {
        closePeer(peer);
    }
}

function disconnectAllPeers() {
    console.log("Disconnected all players");
    for (const peer of [...peers.values()]) {
        closePeer(peer);
    }
}

async function onLayerPreference(msg) {
    console.log("onLayerPreference: " + JSON.stringify(msg));
    const peer = peers.get(`${msg.playerId}`);
    // Same null-vs-undefined guard bug as onPeerDisconnected: peers.get() returns
    // undefined for a missing peer, which `!== null` admits -> peer.consumers throws.
    if (peer) {
        for (const consumer of peer.consumers) {
            await consumer.setPreferredLayers({ spatialLayer: msg.spatialLayer, temporalLayer: msg.temporalLayer });
            if (peers.get(peer.id) !== peer || peer.closed) {
                return;
            }
        }
    }
}

async function onSignallingMessage(message) {
    //console.log(`Got MSG: ${message}`);
    let msg;
    try {
        msg = JSON.parse(message);
    } catch (e) {
        console.error('Failed to parse signalling message: %s', e.message);
        return;
    }

    try {
        if (msg.type === 'offer') {
            await onStreamerOffer(msg);
        }
        else if (msg.type === 'answer') {
            await onPeerAnswer(msg.playerId, msg.sdp);
        }
        else if (msg.type === 'playerConnected') {
            await onPeerConnected(msg.playerId);
        }
        else if (msg.type === 'playerDisconnected') {
            onPeerDisconnected(msg.playerId);
        }
        else if (msg.type === 'streamerDisconnected') {
            onStreamerDisconnected();
        }
        else if (msg.type === 'dataChannelRequest') {
            await setupPeerDataChannels(msg.playerId);
        }
        else if (msg.type === 'peerDataChannelsReady') {
            await setupStreamerDataChannelsForPeer(msg.playerId);
        }
        else if (msg.type === 'layerPreference') {
            await onLayerPreference(msg);
        }
        else if (msg.type === 'streamerList') {
            await onStreamerList(msg);
        }
        else if (msg.type === 'identify') {
            await onIdentify(msg);
        }
    } catch (error) {
        if (msg.playerId) {
            closePeer(peers.get(msg.playerId));
        }
        throw error;
    }
}

async function startMediasoup() {
    let worker = await mediasoup.createWorker({
        logLevel: config.mediasoup.worker.logLevel,
        logTags: config.mediasoup.worker.logTags,
        rtcMinPort: config.mediasoup.worker.rtcMinPort,
        rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    worker.on('died', () => {
        console.error('mediasoup worker died (this should never happen)');
        process.exit(1);
    });

    const mediaCodecs = config.mediasoup.router.mediaCodecs;
    const mediasoupRouter = await worker.createRouter({ mediaCodecs });

    return mediasoupRouter;
}

async function onStreamerICEStateChange(upstream, iceState) {
    upstream.liveness.onIceState(iceState);
    if (iceState !== 'completed' || streamer !== upstream || upstream.dataChannelsStarted) {
        return;
    }
    upstream.dataChannelsStarted = true;

    try {
        if (upstream.multiplexChannels) {
            const nextStreamerSCTPStreamId = upstream.transport.getNextSctpStreamId();
            console.log(`Attempting streamer SCTP id=${nextStreamerSCTPStreamId}`);

            upstream.streamerDataProducer = await upstream.transport.produceData({
                label: 'send-datachannel',
                sctpStreamParameters: { streamId: nextStreamerSCTPStreamId, ordered: true }
            });
            if (streamer !== upstream) {
                if (!upstream.streamerDataProducer.closed) {
                    upstream.streamerDataProducer.close();
                }
                return;
            }

            upstream.dataRoute = await dataRouter.prepareStreamer(upstream.streamerDataProducer, upstream.generation);
            if (streamer !== upstream) {
                return;
            }
            if (!upstream.dataRoute) {
                onStreamerDisconnected();
                return;
            }

            upstream.streamerDataConsumer = await upstream.transport.consumeData({ dataProducerId: upstream.dataRoute.producer.id });
            if (streamer !== upstream) {
                return;
            }
            if (!dataRouter.activateStreamer(upstream.dataRoute)) {
                onStreamerDisconnected();
                return;
            }
            console.log(
                'Setting up sctp for the streamer, producer sctp id %s, consumer sctp id %s',
                upstream.streamerDataProducer.sctpStreamParameters.streamId,
                upstream.streamerDataConsumer.sctpStreamParameters.streamId
            );
        }
        if (streamer === upstream && !sendSignalling({ type: 'startStreaming' })) {
            onStreamerDisconnected(false);
        }
    } catch (error) {
        if (streamer === upstream) {
            onStreamerDisconnected();
        }
        throw error;
    }
}

async function createWebRtcTransport(identifier, iceStateHandler, sctpStateHandler) {
    const {
        listenIps,
        initialAvailableOutgoingBitrate
    } = config.mediasoup.webRtcTransport;

    const transport = await mediasoupRouter.createWebRtcTransport({
        listenIps: listenIps,
        enableUdp: true,
        enableTcp: false,
        preferUdp: true,
        enableSctp: true, // datachannels
        initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate
    });

    transport.on("icestatechange", (iceState) => {
        console.log("%s ICE state changed to %s", identifier, iceState);
        if (iceStateHandler) {
            void runSafely(`${identifier} ICE state handler failed`, () => iceStateHandler(iceState));
        }
    });
    transport.on("iceselectedtuplechange", (iceTuple) => { console.log("%s ICE selected tuple %s", identifier, JSON.stringify(iceTuple)); });
    transport.on("sctpstatechange", (sctpState) => {
        console.log("%s SCTP state changed to %s", identifier, sctpState);
        if (sctpStateHandler) {
            void runSafely(`${identifier} SCTP state handler failed`, () => sctpStateHandler(sctpState));
        }
    });

    return transport;
}

async function main() {
    var argv = minimist(process.argv.slice(2));

    if ('signallingURL' in argv) {
        config.signallingURL = argv['signallingURL'];
    }

    console.log('Starting Mediasoup...');
    console.log("Config = ");
    console.log(config);

    mediasoupRouter = await startMediasoup();
    dataRouter = await createDataRouter(mediasoupRouter);

    connectSignalling(config.signallingURL);
}

if (require.main === module) {
    void runSafely('SFU startup failed', main, console, () => {
        process.exitCode = 1;
    });
}
