const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const WebSocket = require('ws');

function loadSfuLifecycle(webRtcTransport) {
    const serverPath = path.resolve(__dirname, '..', 'sfu_server.js');
    const serverRequire = createRequire(serverPath);
    const source = `${fs.readFileSync(serverPath, 'utf8')}
module.exports = {
    onStreamerDisconnected,
    onStreamerList,
    createWebRtcTransport,
    setMediasoupRouter(router) {
        mediasoupRouter = router;
    },
    setState(socket, upstream, router) {
        signalServer = socket;
        streamer = upstream;
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
        require(specifier) {
            if (specifier === './config' && webRtcTransport) {
                return { mediasoup: { webRtcTransport } };
            }
            return serverRequire(specifier);
        },
        setTimeout() { return {}; }
    });

    vm.runInContext(source, context, { filename: serverPath });
    return module.exports;
}

for (const modern of [false, true]) {
    test(`transport preserves ${modern ? 'listenInfos socket options' : 'legacy listenIps'}`, async () => {
        const listenIps = [{ ip: '127.0.0.1', announcedIp: '127.0.0.1' }];
        const listenInfos = [{
            protocol: 'udp',
            ip: '127.0.0.1',
            announcedAddress: '127.0.0.1',
            recvBufferSize: 8 * 1024 * 1024
        }];
        const settings = {
            listenIps,
            initialAvailableOutgoingBitrate: 1000000,
            ...(modern ? { listenInfos } : {})
        };
        const lifecycle = loadSfuLifecycle(settings);
        let received;
        const transport = { on() {} };
        lifecycle.setMediasoupRouter({
            async createWebRtcTransport(options) {
                received = options;
                return transport;
            }
        });
        assert.equal(await lifecycle.createWebRtcTransport('test'), transport);
        assert.equal(received.initialAvailableOutgoingBitrate, 1000000);
        assert.equal(received.enableSctp, true);
        assert.equal(received[modern ? 'listenInfos' : 'listenIps'], modern ? listenInfos : listenIps);
        assert.equal(Object.hasOwn(received, modern ? 'listenIps' : 'listenInfos'), false);
    });
}

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
