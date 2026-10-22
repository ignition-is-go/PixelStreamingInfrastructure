const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const WebSocket = require('ws');

function loadSfuLifecycle(bridge) {
    const serverPath = path.resolve(__dirname, '..', 'sfu_server.js');
    const serverRequire = createRequire(serverPath);
    const source = `${fs.readFileSync(serverPath, 'utf8')}
module.exports = {
    onStreamerDisconnected,
    onStreamerList,
    onStreamerOffer,
    onPeerConnected,
    onPeerDisconnected,
    setupPeerDataChannels,
    setFanout(fanout) { routerFanout = fanout; },
    setState(socket, upstream, router) {
        signalServer = socket;
        streamer = upstream;
        dataRouter = router;
    },
    setPeerState(socket, upstream, peer, router) {
        signalServer = socket;
        streamer = upstream;
        peers = new Map([[peer.id, peer]]);
        dataRouter = router;
    },
    setPendingState(socket, upstream, router) {
        signalServer = socket;
        streamer = null;
        dataRouter = router;
        streamerGenerations.begin(upstream);
    }
};`;
    const module = { exports: {} };
    const context = vm.createContext({
        console: { error() {}, log() {}, warn() {} },
        module,
        require: name => name === '@epicgames-ps/mediasoup-sdp-bridge' && bridge ? bridge : serverRequire(name),
        setTimeout() { return {}; }
    });

    vm.runInContext(source, context, { filename: serverPath });
    return module.exports;
}

function createEarlyViewerHarness() {
    const lifecycle = loadSfuLifecycle({
        createSdpEndpoint() {
            return {
                async processOffer() { return { producers: [], dataEnabled: false }; },
                createAnswer() { return 'upstream-answer'; },
                createOffer() { return 'viewer-offer'; }
            };
        }
    });
    const signals = [];
    const socket = {
        readyState: WebSocket.OPEN,
        send(message) { signals.push(JSON.parse(message)); }
    };
    const transport = () => ({ closed: false, close() { this.closed = true; } });
    lifecycle.setState(socket, null, { closeStreamer() {} });
    lifecycle.setFanout({
        async createIngressTransport() { return transport(); },
        openGeneration() {
            return {
                async openPlayer() {
                    return { kind: 'ready', route: {
                        transport: transport(), rtpCapabilities: {}, mediaProducers: [], close() {}
                    } };
                },
                close() {}
            };
        }
    });
    return { lifecycle, signals, socket };
}

test('viewer arriving before upstream receives an offer when upstream becomes ready', async () => {
    const { lifecycle, signals } = createEarlyViewerHarness();
    await lifecycle.onPeerConnected('early');
    await lifecycle.onPeerConnected('early');
    assert.equal(signals.length, 0);

    await lifecycle.onStreamerOffer({ sdp: 'upstream-offer' });

    assert.deepEqual(signals, [
        { type: 'answer', sdp: 'upstream-answer' },
        { type: 'offer', playerId: 'early', sdp: 'viewer-offer', sfu: true, scalabilityMode: 'L1T1' }
    ]);
});

test('viewer leaving before upstream is ready is not negotiated later', async () => {
    const { lifecycle, signals } = createEarlyViewerHarness();
    await lifecycle.onPeerConnected('gone');
    lifecycle.onPeerDisconnected('gone');

    await lifecycle.onStreamerOffer({ sdp: 'upstream-offer' });

    assert.deepEqual(signals, [{ type: 'answer', sdp: 'upstream-answer' }]);
});

test('viewer leaving while waiting offers are scheduled is not recreated', async () => {
    const { lifecycle, signals, socket } = createEarlyViewerHarness();
    const send = socket.send;
    socket.send = message => {
        send(message);
        if (JSON.parse(message).type === 'answer') {
            queueMicrotask(() => lifecycle.onPeerDisconnected('leaving'));
        }
    };
    await lifecycle.onPeerConnected('leaving');

    await lifecycle.onStreamerOffer({ sdp: 'upstream-offer' });

    assert.deepEqual(signals, [{ type: 'answer', sdp: 'upstream-answer' }]);
});

test('waiting viewers from a lost signalling connection are not reused', async () => {
    const { lifecycle, signals } = createEarlyViewerHarness();
    await lifecycle.onPeerConnected('old-socket');
    lifecycle.onStreamerDisconnected(false);

    await lifecycle.onStreamerOffer({ sdp: 'upstream-offer' });

    assert.deepEqual(signals, [{ type: 'answer', sdp: 'upstream-answer' }]);
});

class FakeSignaller {
    constructor() {
        this.readyState = WebSocket.OPEN;
        this.subscribed = false;
        this.trace = [];
    }

    send(data) {
        const message = JSON.parse(data);
        this.trace.push(message.type);

        if (message.type === 'subscribe') {
            if (this.subscribed) {
                this.trace.push('subscribeIgnored');
                return;
            }
            this.subscribed = true;
            this.trace.push('playerConnected');
        } else if (message.type === 'unsubscribe') {
            this.subscribed = false;
            this.trace.push('playerDisconnected');
        }
    }
}

test('upstream discovery resubscribes on the same signalling socket after ICE loss', async () => {
    const lifecycle = loadSfuLifecycle();
    const signaller = new FakeSignaller();
    const upstream = {
        generation: 1,
        liveness: { stop() {} },
        producers: [],
        transport: {
            closed: false,
            close() { this.closed = true; }
        }
    };
    lifecycle.setState(signaller, upstream, { closeStreamer() {} });

    await lifecycle.onStreamerList({ ids: ['DefaultStreamer'] });
    lifecycle.onStreamerDisconnected();
    await lifecycle.onStreamerList({ ids: ['DefaultStreamer'] });

    assert.deepEqual(signaller.trace, [
        'subscribe',
        'playerConnected',
        'unsubscribe',
        'playerDisconnected',
        'stopStreaming',
        'subscribe',
        'playerConnected'
    ]);
});

test('upstream discovery clears its subscription when ICE fails during offer setup', async () => {
    const lifecycle = loadSfuLifecycle();
    const signaller = new FakeSignaller();
    const pendingUpstream = {
        liveness: { stop() {} },
        producers: [],
        transport: {
            closed: false,
            close() { this.closed = true; }
        }
    };
    lifecycle.setPendingState(signaller, pendingUpstream, { closeStreamer() {} });

    await lifecycle.onStreamerList({ ids: ['DefaultStreamer'] });
    lifecycle.onStreamerDisconnected();
    await lifecycle.onStreamerList({ ids: ['DefaultStreamer'] });

    assert.deepEqual(signaller.trace, [
        'subscribe',
        'playerConnected',
        'unsubscribe',
        'playerDisconnected',
        'subscribe',
        'playerConnected'
    ]);
});

class FakeDataEntity {
    constructor(id, streamId, label = 'send-datachannel') {
        this.id = id;
        this.label = label;
        this.closed = false;
        this.sctpStreamParameters = { streamId, ordered: true };
    }

    close() {
        this.closed = true;
    }
}

class FakeDataTransport {
    constructor(prefix) {
        this.prefix = prefix;
        this.nextStreamId = 0;
        this.produced = [];
        this.consumed = [];
        this.closed = false;
    }

    getNextSctpStreamId() {
        return this.nextStreamId++;
    }

    async produceData(options) {
        const producer = new FakeDataEntity(
            `${this.prefix}-producer-${this.produced.length}`,
            options.sctpStreamParameters.streamId,
            options.label
        );
        this.produced.push(producer);
        return producer;
    }

    async consumeData({ dataProducerId }) {
        const consumer = new FakeDataEntity(
            `${this.prefix}-consumer-${this.consumed.length}`,
            this.nextStreamId++
        );
        this.consumed.push({ dataProducerId, consumer });
        return consumer;
    }

    close() {
        this.closed = true;
    }
}

function createPeerDataHarness(multiplexChannels) {
    const lifecycle = loadSfuLifecycle();
    const signals = [];
    const socket = {
        readyState: WebSocket.OPEN,
        send(message) {
            signals.push(JSON.parse(message));
        }
    };
    const upstream = {
        generation: 1,
        multiplexChannels,
        transport: new FakeDataTransport('upstream')
    };
    const routeCalls = [];
    const peer = {
        id: 'PlayerOne',
        streamerGeneration: 1,
        transport: new FakeDataTransport('peer'),
        route: {
            async toIngress(producer) {
                routeCalls.push(['toIngress', producer.id]);
                return {
                    kind: 'ready',
                    producer: new FakeDataEntity(`ingress-${producer.id}`, 40)
                };
            },
            async fromIngress(producer) {
                routeCalls.push(['fromIngress', producer.id]);
                return {
                    kind: 'ready',
                    producer: new FakeDataEntity(`viewer-${producer.id}`, 41)
                };
            },
            close() {}
        },
        consumers: [],
        peerDataProducer: null,
        peerDataConsumer: null,
        streamerDataProducer: null,
        streamerDataConsumer: null,
        dataRouterPlayer: null,
        dataChannelsStarted: false,
        closed: false
    };
    return { lifecycle, peer, routeCalls, signals, socket, upstream };
}

test('dedicated data channels pipe both native directions without changing signals', async () => {
    const harness = createPeerDataHarness(false);
    harness.lifecycle.setPeerState(
        harness.socket,
        harness.upstream,
        harness.peer,
        { closePlayer() {} }
    );

    await harness.lifecycle.setupPeerDataChannels(harness.peer.id);

    assert.deepEqual(harness.routeCalls.map(([direction]) => direction), [
        'fromIngress',
        'toIngress'
    ]);
    assert.equal(
        harness.peer.transport.consumed[0].dataProducerId,
        `viewer-${harness.peer.streamerDataProducer.id}`
    );
    assert.equal(
        harness.upstream.transport.consumed[0].dataProducerId,
        `ingress-${harness.peer.peerDataProducer.id}`
    );
    assert.deepEqual(harness.signals, [{
        type: 'peerDataChannels',
        playerId: harness.peer.id,
        sendStreamId: harness.peer.peerDataProducer.sctpStreamParameters.streamId,
        recvStreamId: harness.peer.peerDataConsumer.sctpStreamParameters.streamId
    }]);
});

test('multiplex data stores the prepared global player before the outbound pipe await', async () => {
    const harness = createPeerDataHarness(true);
    let prepared;
    const dataRouter = {
        async preparePlayer(producer, playerId, generation) {
            assert.equal(producer.id, `ingress-${harness.peer.peerDataProducer.id}`);
            assert.equal(playerId, harness.peer.id);
            assert.equal(generation, harness.upstream.generation);
            prepared = {
                producer: new FakeDataEntity('central-player-producer', 50)
            };
            return prepared;
        },
        activatePlayer(player) {
            assert.equal(player, prepared);
            return true;
        },
        closePlayer() {}
    };
    const originalFromIngress = harness.peer.route.fromIngress;
    harness.peer.route.fromIngress = async (producer) => {
        assert.equal(harness.peer.dataRouterPlayer, prepared);
        return originalFromIngress(producer);
    };
    harness.lifecycle.setPeerState(
        harness.socket,
        harness.upstream,
        harness.peer,
        dataRouter
    );

    await harness.lifecycle.setupPeerDataChannels(harness.peer.id);

    assert.deepEqual(harness.routeCalls.map(([direction]) => direction), [
        'toIngress',
        'fromIngress'
    ]);
    assert.equal(
        harness.peer.transport.consumed[0].dataProducerId,
        'viewer-central-player-producer'
    );
    assert.deepEqual(harness.signals, [{
        type: 'peerDataChannels',
        playerId: harness.peer.id,
        sendStreamId: harness.peer.peerDataProducer.sctpStreamParameters.streamId,
        recvStreamId: harness.peer.peerDataConsumer.sctpStreamParameters.streamId
    }]);
});
