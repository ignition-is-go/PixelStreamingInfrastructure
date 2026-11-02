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

async function connection(signalling, Kind, name, query = '') {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    const accepted = new Promise((resolve) =>
        server.once('connection', (socket, request) => resolve({ socket, request }))
    );
    const client = await connect(`ws://127.0.0.1:${server.address().port}/${query}`);
    const incoming = await accepted;
    const native = new Kind(
        signalling,
        incoming.socket,
        incoming.request.socket.remoteAddress,
        incoming.request
    );
    if (Kind !== PlayerConnection) {
        signalling.streamerRegistry.add(native);
        native.transport.on('close', () => signalling.streamerRegistry.remove(native));
        await client.next((message) => message.type === 'identify');
        client.socket.send(JSON.stringify({ type: 'endpointId', id: name }));
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

const producer = (application, pid = 42) => ({
    application,
    process: {
        instanceId: '4c685de2-5bb8-4a84-9703-ebc2bff9ad71',
        reportedHost: 'render-16',
        pid
    }
});
const queryFor = (value) => `?pulseProducer=${encodeURIComponent(JSON.stringify(value))}`;

test(
    'upgrade identity follows the connection through rename, replacement, reconnect and close',
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
        const first = await connection(
            signalling,
            StreamerConnection,
            'direct',
            queryFor(producer('unreal'))
        );
        connections.push(first);
        let snapshot = await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'direct')
        );
        assert.deepEqual(snapshot.streams[0].producer, producer('unreal'));
        first.socket.send(JSON.stringify({ type: 'endpointId', id: 'renamed' }));
        snapshot = await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'renamed')
        );
        assert.deepEqual(snapshot.streams[0].producer, producer('unreal'));
        const replacement = await connection(
            signalling,
            StreamerConnection,
            'renamed',
            queryFor(producer('unreal', 43))
        );
        connections.push(replacement);
        snapshot = await observer.next((value) =>
            value.streams.some(
                (stream) => stream.streamerId === 'renamed' && stream.producer?.process.pid === 43
            )
        );
        assert.equal(snapshot.streams.length, 1);
        assert.deepEqual(snapshot.streams[0].producer, producer('unreal', 43));
        const legacyReplacement = await connection(signalling, StreamerConnection, 'renamed');
        connections.push(legacyReplacement);
        snapshot = await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'renamed' && !stream.producer)
        );
        assert.equal(snapshot.streams.length, 1);
        assert.equal(snapshot.streams[0].producer, undefined);
        await legacyReplacement.close();
        await observer.next((value) => value.streams.length === 0);
        const sfu = await connection(signalling, SFUConnection, 'idle', queryFor(producer('sfu')));
        connections.push(sfu);
        snapshot = await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'idle')
        );
        assert.deepEqual(snapshot.streams[0].producer, producer('sfu'));
        assert.equal(snapshot.streams[0].upstreamStreamerId, null);
        await sfu.close();
        await observer.next((value) => value.streams.length === 0);
        const reconnect = await connection(signalling, SFUConnection, 'idle', queryFor(producer('sfu')));
        connections.push(reconnect);
        snapshot = await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'idle')
        );
        assert.deepEqual(snapshot.streams[0].producer, producer('sfu'));
        connections.push(
            await connection(signalling, SFUConnection, 'conflicting', queryFor(producer('sfu', 99)))
        );
        snapshot = await observer.next((value) =>
            value.streams.some((stream) => stream.streamerId === 'conflicting')
        );
        assert.equal(snapshot.streams.length, 2);
        assert.deepEqual(
            snapshot.streams.map((stream) => stream.producer),
            [producer('sfu', 99), producer('sfu')]
        );
    }
);

test(
    'invalid, absent and duplicate producer declarations retain visible registrations',
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
        const cases = [
            '',
            '?pulseProducer=%7B',
            queryFor(null),
            queryFor({}),
            queryFor(producer('viewer')),
            queryFor(producer('sfu', 0)),
            queryFor(producer('sfu', -1)),
            queryFor(producer('sfu', 1.5)),
            queryFor(producer('sfu', 4294967296)),
            queryFor({ ...producer('sfu'), process: { ...producer('sfu').process, reportedHost: '  ' } }),
            queryFor({ ...producer('sfu'), process: { ...producer('sfu').process, instanceId: 'invalid' } }),
            queryFor({
                ...producer('sfu'),
                process: { ...producer('sfu').process, instanceId: '00000000-0000-0000-0000-000000000000' }
            }),
            queryFor(producer('unreal')),
            `${queryFor(producer('sfu'))}&pulseProducer=${encodeURIComponent(JSON.stringify(producer('sfu', 99)))}`
        ];
        for (const [index, query] of cases.entries()) {
            const name = `invalid-${index}`;
            connections.push(await connection(signalling, SFUConnection, name, query));
            const snapshot = await observer.next((value) =>
                value.streams.some((stream) => stream.streamerId === name)
            );
            const stream = snapshot.streams.find((stream) => stream.streamerId === name);
            assert.equal(stream.availableToPlayers, true);
            assert.equal(stream.producer, undefined);
        }
    }
);
