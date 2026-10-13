const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createHmac } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const WebSocket = require('ws');
const { loadTurnPeerOptionsProvider } = require('../dist/TurnCredentials');

function fixture(t, overrides = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'turn-issuer-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const secret = 'test-only-hmac-secret-never-log';
    writeFileSync(join(dir, 'secret'), secret + '\n', { mode: 0o600 });
    const config = {
        urls: ['turn:127.0.0.1:3478?transport=udp'],
        stunUrls: ['stun:127.0.0.1:3478'],
        secretFile: 'secret',
        ttlSeconds: 60,
        ...overrides
    };
    const path = join(dir, 'turn.json');
    writeFileSync(path, JSON.stringify(config));
    return { dir, secret, config, path };
}

test('each config gets unique valid HMAC credentials and expiry follows issuance time', (t) => {
    const f = fixture(t);
    const issue = loadTurnPeerOptionsProvider(f.path);
    t.mock.method(Date, 'now', () => 1000000);
    const first = issue();
    const second = issue();
    const a = first.iceServers[1],
        b = second.iceServers[1];
    assert.notEqual(a.username, b.username);
    assert.equal(a.username.split(':')[0], '1060');
    assert.equal(a.credential, createHmac('sha1', f.secret).update(a.username).digest('base64'));
    Date.now.mock.mockImplementation(() => 2000000);
    const later = issue().iceServers[1];
    assert.equal(later.username.split(':')[0], '2060');
    assert.ok(Number(a.username.split(':')[0]) < Date.now() / 1000);
    assert.ok(!JSON.stringify(first).includes(f.secret));
    assert.equal(first.iceTransportPolicy, undefined);
});

for (const [name, override] of Object.entries({
    emptyUrls: { urls: [] },
    nonTurn: { urls: ['https://example.com'] },
    credentialsInUrl: { urls: ['turn:user:password@localhost'] },
    ttlZero: { ttlSeconds: 0 },
    ttlTooLong: { ttlSeconds: 604801 },
    ttlFraction: { ttlSeconds: 1.5 },
    missingSecret: { secretFile: 'missing' },
    mixedStun: { stunUrls: ['turn:localhost:3478'] }
})) {
    test(`invalid config fails before listening: ${name}`, (t) => {
        const f = fixture(t, override);
        assert.throws(() => loadTurnPeerOptionsProvider(f.path));
    });
}

test('empty secret fails closed', (t) => {
    const f = fixture(t);
    writeFileSync(join(f.dir, 'secret'), '\n');
    assert.throws(() => loadTurnPeerOptionsProvider(f.path), /empty/);
});

async function freePort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function readConfig(url) {
    const ws = new WebSocket(url);
    let timer;
    try {
        return await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('config timeout')), 5000);
            ws.on('error', reject);
            ws.on('message', (raw) => {
                const message = JSON.parse(raw);
                if (message.type === 'config') resolve(message.peerConnectionOptions);
            });
        });
    } finally {
        clearTimeout(timer);
        ws.close();
    }
}

test(
    'real signaller issues fresh configs and keeps credentials out of debug logs and REST config',
    { timeout: 15000 },
    async (t) => {
        const f = fixture(t);
        const player = await freePort(),
            streamer = await freePort(),
            sfu = await freePort();
        const proc = spawn(
            process.execPath,
            [
                'dist/index.js',
                '--no_config',
                '--player_port',
                String(player),
                '--streamer_port',
                String(streamer),
                '--sfu_port',
                String(sfu),
                '--rest_api',
                '--log_folder',
                f.dir,
                '--log_level_console',
                'debug',
                '--log_level_file',
                'debug',
                '--console_messages',
                'verbose'
            ],
            {
                cwd: resolve(__dirname, '..'),
                env: { ...process.env, TURN_CONFIG_FILE: f.path },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        let output = '';
        proc.stdout.on('data', (data) => (output += data));
        proc.stderr.on('data', (data) => (output += data));
        t.after(async () => {
            if (proc.exitCode === null) {
                proc.kill();
                await once(proc, 'exit');
            }
        });
        let first;
        for (let i = 0; i < 80; i++) {
            assert.equal(proc.exitCode, null, output);
            try {
                first = await readConfig(`ws://127.0.0.1:${player}`);
                break;
            } catch {
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        assert.ok(first, output);
        const second = await readConfig(`ws://127.0.0.1:${player}`);
        const upstream = await readConfig(`ws://127.0.0.1:${streamer}`);
        assert.notEqual(first.iceServers[1].username, second.iceServers[1].username);
        for (const options of [first, second, upstream]) {
            const relay = options.iceServers[1];
            assert.deepEqual(relay.urls, f.config.urls);
            assert.equal(
                relay.credential,
                createHmac('sha1', f.secret).update(relay.username).digest('base64')
            );
        }
        const response = await fetch(`http://127.0.0.1:${player}/api/config`);
        assert.equal(response.status, 200);
        const api = await response.text();
        await new Promise((r) => setTimeout(r, 100));
        for (const name of readdirSync(f.dir).filter((n) => n.endsWith('.log')))
            output += readFileSync(join(f.dir, name), 'utf8');
        for (const value of [
            f.secret,
            first.iceServers[1].credential,
            second.iceServers[1].credential,
            upstream.iceServers[1].credential
        ]) {
            assert.ok(!output.includes(value), 'credentials must not appear in debug/verbose logs');
            assert.ok(!api.includes(value), 'credentials must not appear in REST config');
        }
    }
);

test('startup skips synthesized office TURN when issuer config is selected', (t) => {
    const f = fixture(t);
    const { execFileSync } = require('node:child_process');
    writeFileSync(
        join(f.dir, 'start.sh'),
        readFileSync(resolve(__dirname, '../platform_scripts/bash/start.sh'))
    );
    writeFileSync(
        join(f.dir, 'common.sh'),
        `
parse_args() { SERVER_ARGS=''; }
setup() { :; }
set_public_ip() { PUBLIC_IP=192.0.2.1; }
setup_turn_stun() { STUN_SERVER=stun.example.com:19302; TURN_SERVER=192.0.2.1:19303; TURN_USER=test; TURN_PASS=test; }
build_wilbur() { :; }
print_config() { :; }
start_wilbur() { printf '%s' "$SERVER_ARGS"; }
`
    );
    const withIssuer = execFileSync('bash', [join(f.dir, 'start.sh')], {
        env: { ...process.env, TURN_CONFIG_FILE: f.path, PEER_OPTIONS: 'stale-inherited-options' },
        encoding: 'utf8'
    });
    assert.ok(!withIssuer.includes('--peer_options'));
    assert.ok(!withIssuer.includes('stale-inherited-options'));
    const withoutIssuer = execFileSync('bash', [join(f.dir, 'start.sh')], {
        env: { ...process.env, TURN_CONFIG_FILE: '' },
        encoding: 'utf8'
    });
    assert.ok(withoutIssuer.includes('turn:192.0.2.1:19303'));
});
