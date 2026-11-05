const assert = require('node:assert/strict');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { hostname } = require('node:os');
const { resolve } = require('node:path');
const WebSocket = require('ws');
const { producerSignallingUrl } = require('../producer_identity');

function declaration(url) {
    const params = new URL(url, 'ws://localhost').searchParams;
    assert.equal(params.getAll('pulseProducer').length, 1);
    return JSON.parse(params.get('pulseProducer'));
}

test('SFU process declaration keeps URL settings and is idempotent', () => {
    const configured = 'ws://localhost:8889/path?token=a%2Bb&pulseProducer=obsolete&pulseProducer=duplicate';
    const first = producerSignallingUrl(configured);
    assert.equal(producerSignallingUrl(first), first);
    const url = new URL(first);
    assert.equal(url.pathname, '/path');
    assert.equal(url.searchParams.get('token'), 'a+b');
    const producer = declaration(first);
    assert.equal(producer.application, 'sfu');
    assert.equal(producer.process.reportedHost, hostname());
    assert.equal(producer.process.pid, process.pid);
    assert.match(
        producer.process.instanceId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    assert.equal(
        configured,
        'ws://localhost:8889/path?token=a%2Bb&pulseProducer=obsolete&pulseProducer=duplicate'
    );
});

test(
    'real idle SFU declares its process on reconnect and changes UUID after restart',
    { timeout: 20000 },
    async (t) => {
        const server = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
        await once(server, 'listening');
        const pending = [];
        const waiters = [];
        server.on('connection', (socket, request) => {
            assert.equal(new URL(request.url, 'ws://localhost').searchParams.get('existing'), 'preserved');
            const received = { socket, producer: declaration(request.url) };
            socket.on('message', (data) => {
                const message = JSON.parse(data.toString());
                if (message.type === 'listStreamers')
                    socket.send(JSON.stringify({ type: 'streamerList', ids: [] }));
                if (message.type === 'endpointId') {
                    assert.equal(message.id, 'SFU');
                    if (waiters.length) waiters.shift()(received);
                    else pending.push(received);
                }
            });
            socket.send(JSON.stringify({ type: 'identify' }));
        });
        const next = () =>
            pending.length
                ? Promise.resolve(pending.shift())
                : new Promise((resolve) => waiters.push(resolve));
        const children = [];
        const launch = () => {
            const child = spawn(
                process.execPath,
                [
                    resolve(__dirname, '../sfu_server.js'),
                    `--signallingURL=ws://127.0.0.1:${server.address().port}/?existing=preserved`,
                    '--workerCount=1'
                ],
                { stdio: ['ignore', 'pipe', 'pipe'] }
            );
            let output = '';
            child.stdout.on('data', (data) => {
                output += data;
            });
            child.stderr.on('data', (data) => {
                output += data;
            });
            child.on('exit', (code) => {
                if (code) process.stderr.write(output);
            });
            children.push(child);
            return child;
        };
        const stop = async (child) => {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit');
                child.kill('SIGTERM');
                await exited;
            }
        };
        t.after(async () => {
            await Promise.all(children.map(stop));
            for (const socket of server.clients) socket.terminate();
            await new Promise((resolve) => server.close(resolve));
        });
        const first = launch();
        const registered = await next();
        assert.equal(registered.producer.application, 'sfu');
        assert.equal(registered.producer.process.pid, first.pid);
        assert.equal(registered.producer.process.reportedHost, hostname());
        registered.socket.terminate();
        const reconnected = await next();
        assert.deepEqual(reconnected.producer, registered.producer);
        await stop(first);
        const second = launch();
        const restarted = await next();
        assert.equal(restarted.producer.process.pid, second.pid);
        assert.notEqual(restarted.producer.process.instanceId, registered.producer.process.instanceId);
        t.diagnostic(
            JSON.stringify({
                first: registered.producer,
                reconnected: reconnected.producer,
                restarted: restarted.producer,
                upstream: null
            })
        );
    }
);
