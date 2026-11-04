const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { SFUConnection } = require('../dist/cjs/SFUConnection.js');
const { StreamerConnection } = require('../dist/cjs/StreamerConnection.js');
const { StreamerRegistry } = require('../dist/cjs/StreamerRegistry.js');
const { PlayerRegistry } = require('../dist/cjs/PlayerRegistry.js');

async function socketPair() {
    const server = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const accepted = new Promise((resolve) => server.once('connection', resolve));
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
    });
    const socket = await accepted;
    return {
        client,
        socket,
        async close() {
            if (client.readyState === WebSocket.OPEN) {
                client.close();
                await new Promise((resolve) => client.once('close', resolve));
            }
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

function inbox(socket) {
    const queued = [];
    const waiters = [];
    socket.on('message', (data) => {
        const message = JSON.parse(data.toString());
        const index = waiters.findIndex((waiter) => waiter.predicate(message));
        if (index === -1) {
            queued.push(message);
        } else {
            waiters.splice(index, 1)[0].resolve(message);
        }
    });
    return (predicate) => {
        const index = queued.findIndex(predicate);
        if (index !== -1) {
            return Promise.resolve(queued.splice(index, 1)[0]);
        }
        return new Promise((resolve) => waiters.push({ predicate, resolve }));
    };
}

async function identify(client, nextMessage, id) {
    await nextMessage((message) => message.type === 'identify');
    client.send(JSON.stringify({ type: 'endpointId', id }));
    return nextMessage((message) => message.type === 'endpointIdConfirm');
}

async function addStreamer(signalling, id) {
    const pair = await socketPair();
    const nextMessage = inbox(pair.client);
    const connection = new StreamerConnection(signalling, pair.socket);
    signalling.streamerRegistry.add(connection);
    await identify(pair.client, nextMessage, id);
    return { ...pair, connection, nextMessage };
}

async function addSfu(signalling, id) {
    const pair = await socketPair();
    const nextMessage = inbox(pair.client);
    const connection = new SFUConnection(signalling, pair.socket);
    signalling.streamerRegistry.add(connection);
    signalling.playerRegistry.add(connection);
    await identify(pair.client, nextMessage, id);
    return { ...pair, connection, nextMessage };
}

function nextLifecycle(streamer, sessionId, connectionState, subscriptionState) {
    return streamer.nextMessage(
        (message) =>
            message.type === 'sfuSignallingState' &&
            (!sessionId || message.sessionId === sessionId) &&
            message.connectionState === connectionState &&
            message.subscriptionState === subscriptionState
    );
}

test('SFU socket lifecycle stays distinct from subscription lifecycle', async (t) => {
    const signalling = {
        config: {},
        streamerRegistry: new StreamerRegistry(),
        playerRegistry: new PlayerRegistry()
    };
    const programA = await addStreamer(signalling, 'program-a');
    const programB = await addStreamer(signalling, 'program-b');
    const sfu = await addSfu(signalling, 'HRLV Program Local');
    t.after(async () => {
        await Promise.all([sfu.close(), programA.close(), programB.close()]);
    });

    sfu.client.send(JSON.stringify({ type: 'subscribe', streamerId: 'program-a' }));
    const connected = await nextLifecycle(programA, null, 'connected', 'active');
    assert.equal(connected.sfuStreamerId, 'HRLV Program Local');
    assert.equal(connected.upstreamStreamerId, 'program-a');
    assert.equal(connected.playerId, sfu.connection.playerId);
    assert.match(connected.sessionId, /^[0-9a-f-]{36}$/);

    sfu.client.send(JSON.stringify({ type: 'unsubscribe' }));
    const detached = await nextLifecycle(programA, connected.sessionId, 'connected', 'detached');
    assert.equal(detached.upstreamStreamerId, 'program-a');

    sfu.client.send(JSON.stringify({ type: 'subscribe', streamerId: 'program-a' }));
    await nextLifecycle(programA, connected.sessionId, 'connected', 'active');
    sfu.client.send(JSON.stringify({ type: 'subscribe', streamerId: 'program-b' }));
    await nextLifecycle(programA, connected.sessionId, 'connected', 'detached');
    const rebound = await nextLifecycle(programB, connected.sessionId, 'connected', 'active');
    assert.equal(rebound.upstreamStreamerId, 'program-b');

    const terminalOrMediaDisconnect = programB.nextMessage(
        (message) =>
            (message.type === 'sfuSignallingState' && message.sessionId === connected.sessionId) ||
            (message.type === 'playerDisconnected' && message.playerId === sfu.connection.playerId)
    );
    programA.client.close();
    await new Promise((resolve) => programA.client.once('close', resolve));
    sfu.client.close();
    const terminalB = await terminalOrMediaDisconnect;
    assert.equal(terminalB.type, 'sfuSignallingState');
    assert.equal(terminalB.connectionState, 'disconnected');
    const mediaDisconnect = await programB.nextMessage(
        (message) => message.type === 'playerDisconnected' && message.playerId === sfu.connection.playerId
    );
    assert.equal(terminalB.sfuStreamerId, 'HRLV Program Local');
    assert.equal(mediaDisconnect.playerId, sfu.connection.playerId);
});

test('replacement SFU socket publishes a new globally unique session', async (t) => {
    const signalling = {
        config: {},
        streamerRegistry: new StreamerRegistry(),
        playerRegistry: new PlayerRegistry()
    };
    const program = await addStreamer(signalling, 'program');
    const first = await addSfu(signalling, 'edge');
    t.after(async () => {
        await Promise.all([first.close(), program.close()]);
    });

    first.client.send(JSON.stringify({ type: 'subscribe', streamerId: 'program' }));
    const firstActive = await nextLifecycle(program, null, 'connected', 'active');

    const replacement = await addSfu(signalling, 'edge');
    t.after(() => replacement.close());
    await nextLifecycle(program, firstActive.sessionId, 'disconnected', 'detached');
    replacement.client.send(JSON.stringify({ type: 'subscribe', streamerId: 'program' }));
    const replacementActive = await nextLifecycle(program, null, 'connected', 'active');

    assert.equal(replacementActive.sfuStreamerId, 'edge');
    assert.notEqual(replacementActive.sessionId, firstActive.sessionId);
});
