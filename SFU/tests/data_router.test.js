const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { runSafely } = require('../async_helpers');
const { GenerationRegistry } = require('../generation_registry');
const { createDataRouter, createMultiplexHeader, isUnattributedHomeReset } = require('../data_router');

let nextEntityId = 0;

class MockEntity extends EventEmitter {
    constructor(label) {
        super();
        this.id = `${label}-${++nextEntityId}`;
        this.label = label;
        this.closed = false;
        this.messages = [];
        this.observer = new EventEmitter();
    }

    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.observer.emit('close');
    }

    send(message, ppid) {
        assert.equal(this.closed, false, `send attempted on closed ${this.label}`);
        this.messages.push({ message, ppid });
    }
}

class MockDirectTransport {
    constructor() {
        this.consumeResults = [];
        this.produceResults = [];
        this.consumers = [];
        this.producers = [];
    }

    async consumeData() {
        const result = this.consumeResults.shift() ?? new MockEntity('direct-consumer');
        const consumer = await result;
        this.consumers.push(consumer);
        return consumer;
    }

    async produceData({ label }) {
        const result = this.produceResults.shift() ?? new MockEntity(label);
        const producer = await result;
        this.producers.push(producer);
        return producer;
    }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function createLogger() {
    return {
        warnings: [],
        errors: [],
        warn(message) {
            this.warnings.push(message);
        },
        error(message) {
            this.errors.push(message);
        }
    };
}

async function createHarness() {
    const transport = new MockDirectTransport();
    const logger = createLogger();
    const mediasoupRouter = {
        async createDirectTransport() {
            return transport;
        }
    };
    const router = await createDataRouter(mediasoupRouter, logger);
    return { router, transport, logger };
}

async function activateRoute(harness, generation) {
    const dataProducer = new MockEntity(`streamer-data-${generation}`);
    const route = await harness.router.prepareStreamer(dataProducer, generation);
    assert.ok(route);
    assert.equal(harness.router.activateStreamer(route), true);
    return { dataProducer, route };
}

async function activatePlayer(harness, generation, playerId = 'Player1') {
    const dataProducer = new MockEntity(`player-data-${playerId}`);
    const player = await harness.router.preparePlayer(dataProducer, playerId, generation);
    assert.ok(player);
    assert.equal(harness.router.activatePlayer(player), true);
    return { dataProducer, player };
}

function relayStatuses(route) {
    return route.producer.messages
        .filter(({ message }) => message[0] === 198)
        .map(({ message }) => ({
            playerId: new TextDecoder('utf-16').decode(message.subarray(3, 3 + message.readUInt16LE(1))),
            status: message[message.length - 1]
        }));
}

function routedPlayerMessages(route) {
    return route.producer.messages
        .filter(({ message }) => message[0] === 199)
        .map(({ message }) => message.subarray(3 + message.readUInt16LE(1)));
}

test('player setup without a streamer route returns null and can retry after activation', async () => {
    const harness = await createHarness();
    const playerData = new MockEntity('early-player-data');

    assert.equal(await harness.router.preparePlayer(playerData, 'PlayerEarly', 1), null);
    assert.equal(harness.transport.consumers.length, 0);
    assert.equal(harness.transport.producers.length, 0);

    const { route } = await activateRoute(harness, 1);
    const player = await harness.router.preparePlayer(playerData, 'PlayerEarly', 1);
    assert.equal(harness.router.activatePlayer(player), true);
    assert.deepEqual(relayStatuses(route), [{ playerId: 'PlayerEarly', status: 1 }]);
});

test('player messages during a streamer gap are dropped and resume on the replacement route', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const { player } = await activatePlayer(harness, 1);
    harness.router.closeStreamer(1);
    const messagesBeforeGap = route.producer.messages.length;

    player.consumer.emit('message', Buffer.from('during gap'));
    assert.equal(route.producer.messages.length, messagesBeforeGap);

    const replacement = await activateRoute(harness, 2);
    const message = Buffer.from('after reconnect');
    player.consumer.emit('message', message);
    assert.deepEqual(
        replacement.route.producer.messages.at(-1).message,
        Buffer.concat([createMultiplexHeader('Player1'), message])
    );
});

test('player activation after streamer teardown closes prepared resources', async () => {
    const harness = await createHarness();
    await activateRoute(harness, 1);
    const player = await harness.router.preparePlayer(new MockEntity('player-data'), 'Player1', 1);
    harness.router.closeStreamer(1);

    assert.equal(harness.router.activatePlayer(player), false);
    assert.equal(player.consumer.closed, true);
    assert.equal(player.producer.closed, true);
});

test('late player setup fails closed when streamer tears down during consumeData', async () => {
    const harness = await createHarness();
    await activateRoute(harness, 1);
    const pendingConsumer = deferred();
    harness.transport.consumeResults.push(pendingConsumer.promise);

    const playerData = new MockEntity('late-player-data');
    const preparing = harness.router.preparePlayer(playerData, 'PlayerLate', 1);
    harness.router.closeStreamer(1);
    const consumer = new MockEntity('late-player-consumer');
    pendingConsumer.resolve(consumer);

    assert.equal(await preparing, null);
    assert.equal(consumer.closed, true);
});

test('streamer close during direct producer creation closes the late route resources', async () => {
    const harness = await createHarness();
    const pendingProducer = deferred();
    harness.transport.produceResults.push(pendingProducer.promise);
    const streamerData = new MockEntity('closing-streamer-data');

    const preparing = harness.router.prepareStreamer(streamerData, 1);
    await new Promise((resolve) => setImmediate(resolve));
    streamerData.close();
    const producer = new MockEntity('late-streamer-producer');
    pendingProducer.resolve(producer);

    assert.equal(await preparing, null);
    assert.equal(producer.closed, true);
    assert.equal(harness.transport.consumers[0].closed, true);
});

test('player close during produceData closes the late producer without announcing', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const pendingProducer = deferred();
    harness.transport.produceResults.push(pendingProducer.promise);
    const playerData = new MockEntity('closing-player-data');

    const preparing = harness.router.preparePlayer(playerData, 'PlayerClosing', 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.transport.produceResults.length, 0, 'player setup reached produceData');
    playerData.close();
    const producer = new MockEntity('late-player-producer');
    pendingProducer.resolve(producer);

    assert.equal(await preparing, null);
    assert.equal(producer.closed, true);
    assert.deepEqual(relayStatuses(route), []);
});

test('old streamer close callback cannot close the current generation', async () => {
    const harness = await createHarness();
    const oldRoute = await activateRoute(harness, 1);
    const currentRoute = await activateRoute(harness, 2);

    oldRoute.dataProducer.close();
    assert.equal(currentRoute.route.producer.closed, false);
    await activatePlayer(harness, 2, 'PlayerCurrent');
    assert.deepEqual(relayStatuses(currentRoute.route), [{ playerId: 'PlayerCurrent', status: 1 }]);
});

test('old player close callback cannot delete a reused player id', async () => {
    const harness = await createHarness();
    await activateRoute(harness, 1);
    const oldPlayer = await activatePlayer(harness, 1, 'PlayerSame');
    const newPlayer = await activatePlayer(harness, 1, 'PlayerSame');

    oldPlayer.dataProducer.close();
    assert.equal(newPlayer.player.producer.closed, false);
    assert.equal(newPlayer.player.closed, false);
});

test('late teardown of a reused player id does not swallow command responses', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const oldPlayer = await activatePlayer(harness, 1, 'PlayerReconnected');
    const currentPlayer = await activatePlayer(harness, 1, 'PlayerReconnected');

    // This is the production race: teardown from the replaced socket arrives
    // after its replacement has already claimed the same signalling player id.
    oldPlayer.dataProducer.close();

    const command = Buffer.from('Hero Push Forward');
    currentPlayer.player.consumer.emit('message', command);
    assert.deepEqual(
        route.producer.messages.at(-1).message,
        Buffer.concat([createMultiplexHeader('PlayerReconnected'), command])
    );

    const response = Buffer.from('shot-selected');
    route.consumer.emit(
        'message',
        Buffer.concat([createMultiplexHeader('PlayerReconnected'), response])
    );
    assert.deepEqual(currentPlayer.player.producer.messages.at(-1).message, response);
});

test('current active players are replayed exactly once to a replacement route', async () => {
    const harness = await createHarness();
    await activateRoute(harness, 1);
    await activatePlayer(harness, 1, 'PlayerReplay');

    const replacement = await activateRoute(harness, 2);
    assert.deepEqual(relayStatuses(replacement.route), [{ playerId: 'PlayerReplay', status: 1 }]);
    assert.equal(harness.router.activateStreamer(replacement.route), true);
    assert.deepEqual(relayStatuses(replacement.route), [{ playerId: 'PlayerReplay', status: 1 }]);
});

test('prepared but inactive players are not replayed to a replacement route', async () => {
    const harness = await createHarness();
    await activateRoute(harness, 1);
    const dataProducer = new MockEntity('half-built-player');
    assert.ok(await harness.router.preparePlayer(dataProducer, 'PlayerHalf', 1));

    const replacement = await activateRoute(harness, 2);
    assert.deepEqual(relayStatuses(replacement.route), []);
});

test('player removal is idempotent and announced only on its owning route', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const { dataProducer, player } = await activatePlayer(harness, 1, 'PlayerRemove');

    dataProducer.close();
    harness.router.closePlayer(player);
    assert.deepEqual(relayStatuses(route), [
        { playerId: 'PlayerRemove', status: 1 },
        { playerId: 'PlayerRemove', status: 0 }
    ]);
});

test('abrupt client gone releases held input before relay removal without frontend cleanup', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const { dataProducer, player } = await activatePlayer(harness, 1, 'PlayerHoldingW');
    const keyDown = Buffer.from([60, 87, 0]);
    const keyUp = Buffer.from([61, 87]);

    player.consumer.emit('message', keyDown);
    dataProducer.close();

    const streamerMessages = route.producer.messages.map(({ message }) => {
        if (message[0] !== 199) {
            return Buffer.from([message[0], message.at(-1)]);
        }
        return message.subarray(3 + message.readUInt16LE(1));
    });
    assert.deepEqual(
        streamerMessages,
        [
            Buffer.from([198, 1]),
            keyDown,
            keyUp,
            Buffer.from([198, 0])
        ]
    );
    assert.deepEqual(relayStatuses(route), [
        { playerId: 'PlayerHoldingW', status: 1 },
        { playerId: 'PlayerHoldingW', status: 0 }
    ]);
});

test('abrupt client gone releases held mouse buttons at their last down position', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const { dataProducer, player } = await activatePlayer(harness, 1, 'PlayerHoldingMouse');
    const mouseDown = Buffer.from([72, 0, 52, 18, 120, 86]);
    const mouseUp = Buffer.from([73, 0, 52, 18, 120, 86]);

    player.consumer.emit('message', mouseDown);
    dataProducer.close();

    assert.deepEqual(routedPlayerMessages(route), [mouseDown, mouseUp]);
});

test('normal input release prevents a duplicate release during disposal', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const { dataProducer, player } = await activatePlayer(harness, 1, 'PlayerReleasedW');
    const keyDown = Buffer.from([60, 87, 0]);
    const keyUp = Buffer.from([61, 87]);

    player.consumer.emit('message', keyDown);
    player.consumer.emit('message', keyUp);
    dataProducer.close();
    dataProducer.close();

    assert.deepEqual(routedPlayerMessages(route), [keyDown, keyUp]);
});

test('held input from a stale route is not released into its replacement', async () => {
    const harness = await createHarness();
    const oldRoute = await activateRoute(harness, 1);
    const { dataProducer, player } = await activatePlayer(harness, 1, 'PlayerStaleRoute');
    const keyDown = Buffer.from([60, 87, 0]);

    player.consumer.emit('message', keyDown);
    const replacement = await activateRoute(harness, 2);
    dataProducer.close();

    assert.deepEqual(routedPlayerMessages(oldRoute.route), [keyDown]);
    assert.deepEqual(routedPlayerMessages(replacement.route), []);
});

test('disconnecting one holder does not release another active player input', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const first = await activatePlayer(harness, 1, 'PlayerFirst');
    const second = await activatePlayer(harness, 1, 'PlayerSecond');
    const keyDown = Buffer.from([60, 87, 0]);

    first.player.consumer.emit('message', keyDown);
    second.player.consumer.emit('message', keyDown);
    first.dataProducer.close();
    assert.deepEqual(routedPlayerMessages(route), [keyDown, keyDown]);

    second.dataProducer.close();
    second.dataProducer.close();
    assert.deepEqual(routedPlayerMessages(route), [keyDown, keyDown, Buffer.from([61, 87])]);
});

test('normal release from one holder waits for the final holder release', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const first = await activatePlayer(harness, 1, 'PlayerFirstRelease');
    const second = await activatePlayer(harness, 1, 'PlayerLastRelease');
    const keyDown = Buffer.from([60, 87, 0]);
    const keyUp = Buffer.from([61, 87]);

    first.player.consumer.emit('message', keyDown);
    second.player.consumer.emit('message', keyDown);
    first.player.consumer.emit('message', keyUp);
    assert.deepEqual(routedPlayerMessages(route), [keyDown, keyDown]);

    second.player.consumer.emit('message', keyUp);
    assert.deepEqual(routedPlayerMessages(route), [keyDown, keyDown, keyUp]);
});

test('normal release from one holder leaves disconnect cleanup to release the last holder', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const first = await activatePlayer(harness, 1, 'PlayerNormalRelease');
    const second = await activatePlayer(harness, 1, 'PlayerDisconnectRelease');
    const mouseDown = Buffer.from([72, 0, 52, 18, 120, 86]);
    const mouseUp = Buffer.from([73, 0, 52, 18, 120, 86]);

    first.player.consumer.emit('message', mouseDown);
    second.player.consumer.emit('message', mouseDown);
    first.player.consumer.emit('message', mouseUp);
    second.dataProducer.close();

    assert.deepEqual(routedPlayerMessages(route), [mouseDown, mouseDown, mouseUp]);
});

test('pending release from a reconnected player does not release another current holder', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const holder = await activatePlayer(harness, 1, 'PlayerHoldingW');
    const reconnect = await activatePlayer(harness, 1, 'PlayerReconnect');
    const keyDown = Buffer.from([60, 87, 0]);
    const keyUp = Buffer.from([61, 87]);

    holder.player.consumer.emit('message', keyDown);
    reconnect.player.consumer.emit('message', keyUp);
    assert.deepEqual(routedPlayerMessages(route), [keyDown]);

    holder.dataProducer.close();
    assert.deepEqual(routedPlayerMessages(route), [keyDown, keyUp]);
});

test('short and oversized multiplex messages are dropped without closing the route', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);

    route.consumer.emit('message', Buffer.from([199]));
    route.consumer.emit('message', Buffer.from([199, 20, 0, 65, 0]));

    assert.equal(route.producer.closed, false);
    assert.equal(harness.logger.warnings.length, 2);
});

test('non-multiplexed streamer messages are ignored without terminating routing', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    route.consumer.emit('message', Buffer.from([42, 0, 0]));

    assert.equal(route.producer.closed, false);
    assert.match(harness.logger.warnings[0], /non-multiplexed/);
});

function uiInteraction(descriptor) {
    return Buffer.concat([Buffer.from([50]), Buffer.from(JSON.stringify(descriptor), 'utf16le')]);
}

test('only attributed operator Home resets pass containment', () => {
    assert.equal(isUnattributedHomeReset(uiInteraction({
        StreamCamera: { SetHome: true, HomeLocationX: 1, ResetHome: true }
    })), true);
    assert.equal(isUnattributedHomeReset(uiInteraction({ StreamCamera: { SetHome: true } })), false);
    assert.equal(isUnattributedHomeReset(uiInteraction({ StreamCamera: { ResetHome: true } })), true);
    assert.equal(isUnattributedHomeReset(uiInteraction({
        StreamCamera: { ResetHome: true, ResetHomeSource: 'Operator' }
    })), false);
    assert.equal(isUnattributedHomeReset(uiInteraction({ StreamCamera: { GoToPreset: 'Hero' } })), false);
});

test('legacy combined Home reset is dropped before the streamer route', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const { player } = await activatePlayer(harness, 1, 'LegacyTab');
    const before = route.producer.messages.length;

    player.consumer.emit('message', uiInteraction({
        StreamCamera: { SetHome: true, ResetHome: true }
    }));

    assert.equal(route.producer.messages.length, before);
    assert.match(harness.logger.warnings.at(-1), /LegacyTab/);
});

test('attributed operator Home reset reaches the streamer route', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const { player } = await activatePlayer(harness, 1, 'CurrentTab');
    const reset = uiInteraction({
        StreamCamera: { ReleaseRig: true, ResetHome: true, ResetHomeSource: 'Operator' }
    });

    player.consumer.emit('message', reset);

    assert.deepEqual(
        route.producer.messages.at(-1).message,
        Buffer.concat([createMultiplexHeader('CurrentTab'), reset])
    );
});

test('player and streamer messages route only through active current identities', async () => {
    const harness = await createHarness();
    const { route } = await activateRoute(harness, 1);
    const { player } = await activatePlayer(harness, 1, 'PlayerRoute');
    const browserPayload = Buffer.from([10, 20, 30]);
    player.consumer.emit('message', browserPayload);
    assert.deepEqual(
        route.producer.messages.at(-1).message,
        Buffer.concat([createMultiplexHeader('PlayerRoute'), browserPayload])
    );

    const streamerPayload = Buffer.from([40, 50]);
    route.consumer.emit('message', Buffer.concat([createMultiplexHeader('PlayerRoute'), streamerPayload]));
    assert.deepEqual(player.producer.messages.at(-1).message, streamerPayload);
});

test('async containment logs a rejection and resolves without an unhandled error', async () => {
    const logger = createLogger();
    let callbackError = null;
    const result = await runSafely(
        'late data channel setup failed',
        async () => {
            throw new Error('streamer route is gone');
        },
        logger,
        (error) => {
            callbackError = error;
        }
    );

    assert.equal(result, undefined);
    assert.match(logger.errors[0], /streamer route is gone/);
    assert.equal(callbackError.message, 'streamer route is gone');
});

test('concurrent streamer offers reserve exactly one pending generation', () => {
    const registry = new GenerationRegistry();
    const first = registry.begin({ name: 'first' });
    const second = registry.begin({ name: 'second' });

    assert.ok(first);
    assert.equal(first.generation, 1);
    assert.equal(second, null);
    assert.equal(registry.pending, first);
});

test('stale generation teardown cannot clear the current streamer', () => {
    const registry = new GenerationRegistry();
    const oldGeneration = registry.begin({ name: 'old' });
    assert.equal(registry.activate(oldGeneration), true);
    assert.equal(registry.clearCurrent(oldGeneration), true);
    const currentGeneration = registry.begin({ name: 'current' });
    assert.equal(registry.activate(currentGeneration), true);

    assert.equal(registry.clearCurrent(oldGeneration), false);
    assert.equal(registry.current, currentGeneration);
    assert.equal(registry.isCurrent(oldGeneration), false);
});

test('cancelled pending setup cannot become current and generations stay monotonic', () => {
    const registry = new GenerationRegistry();
    const cancelled = registry.begin({ name: 'cancelled' });
    assert.equal(registry.cancelPending(), cancelled);
    assert.equal(registry.activate(cancelled), false);

    const replacement = registry.begin({ name: 'replacement' });
    assert.equal(replacement.generation, 2);
    assert.equal(registry.activate(replacement), true);
});
