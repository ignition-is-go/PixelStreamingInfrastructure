const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { SFUConnection } = require('../dist/cjs/SFUConnection.js');
const { StreamerConnection } = require('../dist/cjs/StreamerConnection.js');
const { PlayerConnection } = require('../dist/cjs/PlayerConnection.js');
const { StreamerRegistry } = require('../dist/cjs/StreamerRegistry.js');
const { PlayerRegistry } = require('../dist/cjs/PlayerRegistry.js');
const { StreamInventoryServer } = require('../dist/cjs/StreamInventoryServer.js');

function inbox(socket) {
    const queued = [],
        waiters = [];
    socket.on('message', (data) => {
        const value = JSON.parse(data.toString());
        const index = waiters.findIndex((waiter) => waiter.predicate(value));
        if (index < 0) queued.push(value);
        else {
            queued.length = 0;
            waiters.splice(index, 1)[0].resolve(value);
        }
    });
    return (predicate) => {
        const index = queued.findIndex(predicate);
        return index >= 0
            ? Promise.resolve(queued.splice(0, index + 1).at(-1))
            : new Promise((resolve) => waiters.push({ predicate, resolve }));
    };
}

async function connect(url) {
    const socket = new WebSocket(url);
    const next = inbox(socket);
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    return { socket, next };
}

async function connection(signalling, Kind, name, feed) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    const accepted = new Promise((resolve) => server.once('connection', resolve));
    const client = await connect(`ws://127.0.0.1:${server.address().port}`);
    const native = new Kind(signalling, await accepted);
    if (Kind !== PlayerConnection) {
        signalling.streamerRegistry.add(native);
        native.transport.on('close', () => signalling.streamerRegistry.remove(native));
        await client.next((message) => message.type === 'identify');
        client.socket.send(JSON.stringify({ type: 'endpointId', id: name, ...(feed ? { feed } : {}) }));
        await client.next((message) => message.type === 'endpointIdConfirm');
    }
    if (Kind !== StreamerConnection) signalling.playerRegistry.add(native);
    return {
        ...client,
        native,
        async close() {
            if (client.socket.readyState !== WebSocket.CLOSED) {
                client.socket.terminate();
                await new Promise((resolve) => client.socket.once('close', resolve));
            }
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

test(
    'private inventory follows native registrations and matches player discovery without viewers',
    { timeout: 15000 },
    async (t) => {
        const signalling = {
            config: {},
            streamerRegistry: new StreamerRegistry(),
            playerRegistry: new PlayerRegistry()
        };
        const publisher = new StreamInventoryServer(signalling.streamerRegistry, {
            host: '127.0.0.1',
            port: 0
        });
        await new Promise((resolve) => publisher.server.once('listening', resolve));
        const observer = await connect(`ws://127.0.0.1:${publisher.server.address().port}`);
        const connections = [];
        t.after(async () => {
            await publisher.close();
            await Promise.all(connections.map((item) => item.close()));
        });
        assert.deepEqual(await observer.next(() => true), { streams: [] });
        assert.equal(signalling.playerRegistry.count(), 0, 'monitor is not a player');

        const a = await connection(signalling, StreamerConnection, 'direct-a');
        connections.push(a);
        let snapshot = await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'direct-a')
        );
        assert.deepEqual(snapshot.streams, [
            {
                streamerId: 'direct-a',
                producerKind: 'streamer',
                availableToPlayers: true,
                upstreamStreamerId: null
            }
        ]);
        const b = await connection(signalling, StreamerConnection, 'direct-b');
        connections.push(b);
        const sfu = await connection(signalling, SFUConnection, 'edge');
        connections.push(sfu);
        sfu.socket.send(JSON.stringify({ type: 'subscribe', streamerId: 'direct-a' }));
        snapshot = await observer.next((value) =>
            value.streams.some(
                (stream) => stream.streamerId === 'edge' && stream.upstreamStreamerId === 'direct-a'
            )
        );
        assert.equal(signalling.playerRegistry.count(), 1, 'only SFU is a player before picker connects');

        const picker = await connection(signalling, PlayerConnection);
        connections.push(picker);
        picker.socket.send(JSON.stringify({ type: 'listStreamers' }));
        const list = await picker.next((message) => message.type === 'streamerList');
        assert.deepEqual(
            list.ids.sort(),
            snapshot.streams
                .filter((stream) => stream.availableToPlayers)
                .map((stream) => stream.streamerId)
                .sort()
        );
        assert.equal(
            signalling.playerRegistry.listPlayers().filter((player) => player.subscribedStreamer).length,
            1,
            'no browser media subscription'
        );

        sfu.socket.send(JSON.stringify({ type: 'subscribe', streamerId: 'direct-b' }));
        await observer.next((value) =>
            value.streams.some(
                (stream) => stream.streamerId === 'edge' && stream.upstreamStreamerId === 'direct-b'
            )
        );
        b.socket.send(JSON.stringify({ type: 'endpointId', id: 'renamed-b' }));
        await observer.next((value) =>
            value.streams.some(
                (stream) => stream.streamerId === 'edge' && stream.upstreamStreamerId === 'renamed-b'
            )
        );
        sfu.socket.send(JSON.stringify({ type: 'unsubscribe' }));
        await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'edge' && stream.upstreamStreamerId === null)
        );
        sfu.socket.send(JSON.stringify({ type: 'stopStreaming' }));
        snapshot = await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'edge' && !stream.availableToPlayers)
        );
        picker.socket.send(JSON.stringify({ type: 'listStreamers' }));
        const stoppedList = await picker.next((message) => message.type === 'streamerList');
        assert.deepEqual(
            stoppedList.ids.sort(),
            snapshot.streams
                .filter((stream) => stream.availableToPlayers)
                .map((stream) => stream.streamerId)
                .sort()
        );
        sfu.socket.send(JSON.stringify({ type: 'startStreaming' }));
        await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'edge' && stream.availableToPlayers)
        );
        const late = await connect(`ws://127.0.0.1:${publisher.server.address().port}`);
        assert.ok((await late.next(() => true)).streams.some((stream) => stream.streamerId === 'edge'));
        late.socket.terminate();
        await a.close();
        await observer.next((value) => !value.streams.some((stream) => stream.streamerId === 'direct-a'));
        assert.equal(signalling.streamerRegistry.find('direct-a'), undefined);
    }
);

test(
    'SFU feed advertisements update live inventory without changing media availability',
    { timeout: 15000 },
    async (t) => {
        const signalling = {
            config: {},
            streamerRegistry: new StreamerRegistry(),
            playerRegistry: new PlayerRegistry()
        };
        const publisher = new StreamInventoryServer(signalling.streamerRegistry, {
            host: '127.0.0.1',
            port: 0
        });
        await new Promise((resolve) => publisher.server.once('listening', resolve));
        const observer = await connect(`ws://127.0.0.1:${publisher.server.address().port}`);
        const connections = [];
        t.after(async () => {
            await publisher.close();
            await Promise.all(connections.map((item) => item.close()));
        });
        await observer.next(() => true);
        const legacy = await connection(signalling, SFUConnection, 'legacy');
        connections.push(legacy);
        let snapshot = await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'legacy')
        );
        assert.equal(snapshot.streams[0].feed, undefined);
        const sfu = await connection(signalling, SFUConnection, 'third', {
            id: 'Arbitrary third feed',
            kind: 'program',
            route: 'edge'
        });
        connections.push(sfu);
        snapshot = await observer.next((value) =>
            value.streams.some((stream) => stream.feed?.id === 'Arbitrary third feed')
        );
        assert.deepEqual(snapshot.streams.find((stream) => stream.feed).feed, {
            id: 'Arbitrary third feed',
            kind: 'program',
            route: 'edge'
        });
        sfu.socket.send(
            JSON.stringify({
                type: 'endpointId',
                id: 'changed',
                feed: { id: 'Changed feed', kind: 'preview', route: 'local' }
            })
        );
        await sfu.next((message) => message.type === 'endpointIdConfirm');
        await observer.next((value) => value.streams.some((stream) => stream.feed?.id === 'Changed feed'));
        let index = 0;
        for (const feed of [
            { id: '', kind: 'program', route: 'edge' },
            { id: 'bad', kind: 'other', route: 'edge' },
            { id: 'bad', kind: 'program', route: 'direct' },
            null
        ]) {
            const id = `invalid-${index++}`;
            sfu.socket.send(JSON.stringify({ type: 'endpointId', id, feed }));
            await sfu.next((message) => message.type === 'endpointIdConfirm');
            snapshot = await observer.next((value) =>
                value.streams.some((stream) => stream.streamerId === id)
            );
            assert.equal(snapshot.streams.find((stream) => stream.streamerId === id).feed, undefined);
            assert.equal(sfu.native.streaming, true);
        }
        const id = sfu.native.streamerId;
        await sfu.close();
        await observer.next((value) => !value.streams.some((stream) => stream.streamerId === id));
    }
);
