const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createRouterFanout, webRtcTransportOptions } = require('../router_fanout');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

let nextId = 0;

class FakeEntity extends EventEmitter {
    constructor(kind) {
        super();
        this.id = `${kind}-${++nextId}`;
        this.kind = kind;
        this.closed = false;
        this.observer = new EventEmitter();
    }

    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.observer.emit('close');
    }
}

class FakeRouter {
    constructor(index) {
        this.id = `router-${index}`;
        this.rtpCapabilities = { router: index };
        this.pipeCalls = [];
        this.pipeResults = [];
        this.transportResults = [];
        this.transports = [];
    }

    async pipeToRouter(options) {
        this.pipeCalls.push(options);
        const configured = this.pipeResults.shift();
        if (configured) {
            return configured;
        }
        if (options.producerId) {
            return {
                pipeConsumer: new FakeEntity('pipe-consumer'),
                pipeProducer: Object.assign(new FakeEntity('pipe-producer'), {
                    id: options.producerId
                })
            };
        }
        return {
            pipeDataConsumer: new FakeEntity('pipe-data-consumer'),
            pipeDataProducer: Object.assign(new FakeEntity('pipe-data-producer'), {
                id: options.dataProducerId
            })
        };
    }

    async createWebRtcTransport(options) {
        const configured = this.transportResults.shift();
        const transport = configured ? await configured : new FakeEntity('webrtc-transport');
        transport.options = options;
        this.transports.push(transport);
        return transport;
    }
}

class FakeWorker extends EventEmitter {
    constructor(index) {
        super();
        this.closed = false;
        this.router = new FakeRouter(index);
    }

    async createRouter() {
        return this.router;
    }

    close() {
        this.closed = true;
    }
}

async function createHarness(workerCount, logger = { log() {}, error() {} }) {
    const workers = [];
    const mediasoup = {
        async createWorker() {
            const worker = new FakeWorker(workers.length);
            workers.push(worker);
            return worker;
        }
    };
    const deaths = [];
    const fanout = await createRouterFanout({
        mediasoup,
        workerCount,
        workerOptions: { rtcMinPort: 40000 },
        routerOptions: { mediaCodecs: [] },
        webRtcTransportOptions: {
            listenIps: [{ ip: '127.0.0.1' }],
            initialAvailableOutgoingBitrate: 1000000
        },
        onWorkerDied: (index) => deaths.push(index),
        logger
    });
    return { fanout, workers, deaths };
}

function mediaProducer(id, kind) {
    return Object.assign(new FakeEntity(kind), { id, kind });
}

for (const modern of [false, true]) {
    test(`transport options preserve ${modern ? 'listenInfos socket settings' : 'legacy listenIps'}`, () => {
        const listenIps = [{ ip: '127.0.0.1', announcedIp: '127.0.0.1' }];
        const listenInfos = [{
            protocol: 'udp',
            ip: '127.0.0.1',
            recvBufferSize: 8 * 1024 * 1024
        }];
        const options = webRtcTransportOptions({
            listenIps,
            ...(modern ? { listenInfos } : {}),
            initialAvailableOutgoingBitrate: 1000000
        });

        assert.equal(options[modern ? 'listenInfos' : 'listenIps'], modern ? listenInfos : listenIps);
        assert.equal(Object.hasOwn(options, modern ? 'listenIps' : 'listenInfos'), false);
        assert.equal(options.initialAvailableOutgoingBitrate, 1000000);
        assert.equal(options.enableSctp, true);
    });
}

test('concurrent first viewers share one complete audio and video target', async () => {
    const { fanout, workers } = await createHarness(2);
    const firstPipe = deferred();
    workers[0].router.pipeResults.push(firstPipe.promise);
    const producers = [
        mediaProducer('audio-1', 'audio'),
        mediaProducer('video-1', 'video')
    ];
    const generation = fanout.openGeneration({ generation: 1, producers });

    const first = generation.openPlayer({ playerId: 'first', isCurrent: () => true });
    const second = generation.openPlayer({ playerId: 'second', isCurrent: () => true });
    assert.equal(workers[0].router.pipeCalls.length, 1);

    firstPipe.resolve({
        pipeConsumer: new FakeEntity('audio-consumer'),
        pipeProducer: Object.assign(new FakeEntity('audio-producer'), { id: 'audio-1' })
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(workers[0].router.pipeCalls.length, 2);
    assert.deepEqual(
        workers[0].router.pipeCalls.map(({ producerId, enableSctp, enableRtx }) => ({
            producerId,
            enableSctp,
            enableRtx
        })),
        [
            { producerId: 'audio-1', enableSctp: true, enableRtx: true },
            { producerId: 'video-1', enableSctp: true, enableRtx: true }
        ]
    );
    assert.deepEqual(firstResult.route.mediaProducers.map(({ id }) => id), ['audio-1', 'video-1']);
    assert.equal(firstResult.route.mediaProducers, secondResult.route.mediaProducers);

    firstResult.route.close();
    assert.equal(firstResult.route.mediaProducers[0].closed, false);
    assert.equal(secondResult.route.transport.closed, false);
});

test('least-active reservations happen before awaits and release exactly once', async () => {
    const logs = [];
    const { fanout, workers } = await createHarness(3, {
        log(...args) { logs.push(args); },
        error() {}
    });
    const firstTransport = deferred();
    workers[1].router.transportResults.push(firstTransport.promise);
    const generation = fanout.openGeneration({
        generation: 1,
        producers: [mediaProducer('video', 'video')]
    });

    const first = generation.openPlayer({ playerId: 'first', isCurrent: () => true });
    const second = await generation.openPlayer({ playerId: 'second', isCurrent: () => true });
    const third = await generation.openPlayer({ playerId: 'third', isCurrent: () => true });

    assert.equal(workers[1].router.transports.length, 1);
    assert.equal(workers[2].router.transports.length, 1);
    assert.deepEqual(logs.slice(0, 3).map((entry) => entry.slice(1)), [
        ['first', 1, 1],
        ['second', 2, 1],
        ['third', 1, 2]
    ]);

    second.route.close();
    second.route.close();
    const fourth = await generation.openPlayer({ playerId: 'fourth', isCurrent: () => true });
    assert.equal(workers[2].router.transports.length, 2);

    firstTransport.resolve(new FakeEntity('first-transport'));
    const openedFirst = await first;
    openedFirst.route.close();
    third.route.close();
    fourth.route.close();
});

test('failed lazy target closes partial pipes and a later viewer retries', async () => {
    const { fanout, workers } = await createHarness(2);
    const partial = {
        pipeConsumer: new FakeEntity('partial-consumer'),
        pipeProducer: Object.assign(new FakeEntity('partial-producer'), { id: 'audio' })
    };
    workers[0].router.pipeResults.push(partial, Promise.reject(new Error('pipe failed')));
    const generation = fanout.openGeneration({
        generation: 1,
        producers: [mediaProducer('audio', 'audio'), mediaProducer('video', 'video')]
    });

    await assert.rejects(
        generation.openPlayer({ playerId: 'failed', isCurrent: () => true }),
        /pipe failed/
    );
    assert.equal(partial.pipeConsumer.closed, true);
    assert.equal(partial.pipeProducer.closed, true);

    const retried = await generation.openPlayer({ playerId: 'retry', isCurrent: () => true });
    assert.equal(retried.kind, 'ready');
    assert.equal(workers[0].router.pipeCalls.length, 4);
});

test('a cancelled reused player id cannot close shared media or the replacement route', async () => {
    const { fanout, workers } = await createHarness(2);
    const pending = deferred();
    workers[0].router.pipeResults.push(pending.promise);
    const generation = fanout.openGeneration({
        generation: 1,
        producers: [mediaProducer('video', 'video')]
    });
    let oldCurrent = true;

    const oldOpen = generation.openPlayer({ playerId: 'same', isCurrent: () => oldCurrent });
    oldCurrent = false;
    const replacementOpen = generation.openPlayer({ playerId: 'same', isCurrent: () => true });
    const sharedPipe = {
        pipeConsumer: new FakeEntity('shared-consumer'),
        pipeProducer: Object.assign(new FakeEntity('shared-producer'), { id: 'video' })
    };
    pending.resolve(sharedPipe);

    const [oldResult, replacement] = await Promise.all([oldOpen, replacementOpen]);
    assert.equal(oldResult.kind, 'stale');
    assert.equal(replacement.kind, 'ready');
    assert.equal(sharedPipe.pipeProducer.closed, false);
    assert.equal(replacement.route.transport.closed, false);
});

test('cancellation during transport creation closes the late transport and releases placement', async () => {
    const logs = [];
    const { fanout, workers } = await createHarness(2, {
        log(...args) { logs.push(args); },
        error() {}
    });
    const pendingTransport = deferred();
    workers[1].router.transportResults.push(pendingTransport.promise);
    const generation = fanout.openGeneration({
        generation: 1,
        producers: [mediaProducer('video', 'video')]
    });
    let current = true;

    const opening = generation.openPlayer({ playerId: 'cancelled', isCurrent: () => current });
    await new Promise((resolve) => setImmediate(resolve));
    current = false;
    const lateTransport = new FakeEntity('late-transport');
    pendingTransport.resolve(lateTransport);

    assert.equal((await opening).kind, 'stale');
    assert.equal(lateTransport.closed, true);
    const replacement = await generation.openPlayer({
        playerId: 'replacement',
        isCurrent: () => true
    });
    assert.deepEqual(logs.filter(([format]) => format.startsWith('Assigned')).map((entry) => entry.at(-1)), [
        1,
        1
    ]);
    replacement.route.close();
});

test('closing during transport and data pipe awaits cleans only peer-owned resources', async () => {
    const { fanout, workers } = await createHarness(2);
    const generation = fanout.openGeneration({
        generation: 1,
        producers: [mediaProducer('video', 'video')]
    });
    const opened = await generation.openPlayer({ playerId: 'peer', isCurrent: () => true });
    const pendingData = deferred();
    workers[1].router.pipeResults.push(pendingData.promise);

    const piped = opened.route.toIngress(new FakeEntity('viewer-data'));
    opened.route.close();
    const dataPair = {
        pipeDataConsumer: new FakeEntity('late-data-consumer'),
        pipeDataProducer: new FakeEntity('late-data-producer')
    };
    pendingData.resolve(dataPair);

    assert.deepEqual(await piped, { kind: 'stale' });
    assert.equal(dataPair.pipeDataConsumer.closed, true);
    assert.equal(dataPair.pipeDataProducer.closed, true);
    assert.equal(opened.route.mediaProducers[0].closed, false);
});

test('generation close during a media pipe await closes the late pair', async () => {
    const { fanout, workers } = await createHarness(2);
    const pending = deferred();
    workers[0].router.pipeResults.push(pending.promise);
    const generation = fanout.openGeneration({
        generation: 1,
        producers: [mediaProducer('video', 'video')]
    });
    const opened = generation.openPlayer({ playerId: 'peer', isCurrent: () => true });
    generation.close();
    const pair = {
        pipeConsumer: new FakeEntity('late-consumer'),
        pipeProducer: new FakeEntity('late-producer')
    };
    pending.resolve(pair);

    assert.equal((await opened).kind, 'stale');
    assert.equal(pair.pipeConsumer.closed, true);
    assert.equal(pair.pipeProducer.closed, true);
});

test('worker death reports its slot and fanout close closes every worker', async () => {
    const { fanout, workers, deaths } = await createHarness(2);
    workers[1].emit('died');
    assert.deepEqual(deaths, [1]);

    fanout.close();
    fanout.close();
    assert.equal(workers.every(({ closed }) => closed), true);
});

test('omitted worker count keeps external configs on one worker', async () => {
    const { fanout, workers } = await createHarness(undefined);

    assert.equal(workers.length, 1);
    fanout.close();
});

test('invalid worker counts fail at the configuration boundary', async () => {
    for (const workerCount of [0, -1, 1.5, '4']) {
        await assert.rejects(
            createRouterFanout({ workerCount }),
            /positive integer/
        );
    }
});

test('native two-worker fanout exposes audio, video, and bidirectional data locally', async () => {
    const mediasoup = require('mediasoup');
    const fanout = await createRouterFanout({
        mediasoup,
        workerCount: 2,
        workerOptions: { logLevel: 'warn' },
        routerOptions: {
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000
                }
            ]
        },
        webRtcTransportOptions: {
            listenInfos: [{ protocol: 'udp', ip: '127.0.0.1' }]
        },
        onWorkerDied() {},
        logger: { log() {}, error() {} }
    });

    try {
        const ingress = await fanout.createIngressTransport({ identifier: 'native-ingress' });
        const audio = await ingress.produce({
            kind: 'audio',
            rtpParameters: {
                mid: 'audio',
                codecs: [{
                    mimeType: 'audio/opus',
                    payloadType: 111,
                    clockRate: 48000,
                    channels: 2
                }],
                encodings: [{ ssrc: 11111111 }],
                rtcp: { cname: 'native-audio' }
            }
        });
        const video = await ingress.produce({
            kind: 'video',
            rtpParameters: {
                mid: 'video',
                codecs: [{
                    mimeType: 'video/VP8',
                    payloadType: 112,
                    clockRate: 90000,
                    rtcpFeedback: [{ type: 'nack', parameter: 'pli' }]
                }],
                encodings: [{ ssrc: 22222222 }],
                rtcp: { cname: 'native-video' }
            }
        });
        const generation = fanout.openGeneration({
            generation: 1,
            producers: [audio, video]
        });
        const opened = await generation.openPlayer({
            playerId: 'native-player',
            isCurrent: () => true
        });

        assert.equal(opened.kind, 'ready');
        assert.deepEqual(opened.route.mediaProducers.map(({ id, kind }) => ({ id, kind })), [
            { id: audio.id, kind: 'audio' },
            { id: video.id, kind: 'video' }
        ]);
        for (const producer of opened.route.mediaProducers) {
            const consumer = await opened.route.transport.consume({
                producerId: producer.id,
                rtpCapabilities: opened.route.rtpCapabilities,
                paused: true
            });
            assert.equal(consumer.kind, producer.kind);
            assert.equal(consumer.paused, true);
        }

        const ingressData = await ingress.produceData({
            label: 'ingress-to-viewer',
            sctpStreamParameters: { streamId: 1, ordered: true }
        });
        const localForViewer = await opened.route.fromIngress(ingressData);
        assert.equal(localForViewer.kind, 'ready');
        assert.equal(localForViewer.producer.id, ingressData.id);
        const viewerConsumer = await opened.route.transport.consumeData({
            dataProducerId: localForViewer.producer.id
        });
        assert.equal(viewerConsumer.label, 'ingress-to-viewer');

        const viewerData = await opened.route.transport.produceData({
            label: 'viewer-to-ingress',
            sctpStreamParameters: { streamId: 2, ordered: true }
        });
        const localForIngress = await opened.route.toIngress(viewerData);
        assert.equal(localForIngress.kind, 'ready');
        assert.equal(localForIngress.producer.id, viewerData.id);
        const ingressConsumer = await ingress.consumeData({
            dataProducerId: localForIngress.producer.id
        });
        assert.equal(ingressConsumer.label, 'viewer-to-ingress');

        generation.close();
        assert.equal(opened.route.transport.closed, true);
    } finally {
        fanout.close();
    }
});
