const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');

const { SignallingWatchdog, reconnectDelayMs } = require('../signalling_watchdog');
const { StreamerLivenessMonitor } = require('../streamer_liveness');
const { probeRegistration, streamerListContains } = require('../registration_probe');

function fakeTimerHarness() {
    const timers = [];
    return {
        timers,
        setTimer(callback, delay) {
            const timer = { callback, delay, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimer(timer) {
            timer.cleared = true;
        }
    };
}

test('signalling watchdog terminates a silent half-open socket exactly once', () => {
    let now = 0;
    let staleCount = 0;
    const intervals = fakeTimerHarness();
    const socket = { readyState: 1, pings: 0, ping() { this.pings += 1; } };
    const watchdog = new SignallingWatchdog(socket, {
        intervalMs: 1000,
        timeoutMs: 3000,
        openState: 1,
        onStale: () => { staleCount += 1; },
        logger: { error() {} },
        now: () => now,
        setIntervalFn: intervals.setTimer,
        clearIntervalFn: intervals.clearTimer
    });

    watchdog.start();
    now = 1000;
    watchdog.check();
    assert.equal(socket.pings, 1);
    now = 3000;
    watchdog.check();
    watchdog.check();
    assert.equal(staleCount, 1);
    assert.equal(intervals.timers[0].cleared, true);
});

test('signalling activity keeps the watchdog alive', () => {
    let now = 0;
    let staleCount = 0;
    const socket = { readyState: 1, ping() {} };
    const watchdog = new SignallingWatchdog(socket, {
        intervalMs: 1000,
        timeoutMs: 3000,
        openState: 1,
        onStale: () => { staleCount += 1; },
        logger: { error() {} },
        now: () => now,
        setIntervalFn: () => 1,
        clearIntervalFn: () => {}
    });

    now = 2500;
    watchdog.recordActivity();
    now = 5000;
    watchdog.check();
    assert.equal(staleCount, 0);
});

test('signalling reconnect delay backs off to a finite cap', () => {
    assert.deepEqual(
        [0, 1, 2, 3, 4, 20].map((attempt) => reconnectDelayMs(attempt, 2000, 30000)),
        [2000, 4000, 8000, 16000, 30000, 30000]
    );
});

test('streamer liveness tolerates a transient ICE disconnect', () => {
    const timers = fakeTimerHarness();
    const reasons = [];
    const monitor = new StreamerLivenessMonitor({
        disconnectGraceMs: 5000,
        onDead: (reason) => reasons.push(reason),
        setTimeoutFn: timers.setTimer,
        clearTimeoutFn: timers.clearTimer
    });

    monitor.onIceState('disconnected');
    assert.equal(timers.timers[0].delay, 5000);
    monitor.onIceState('completed');
    assert.equal(timers.timers[0].cleared, true);
    assert.deepEqual(reasons, []);
});

test('streamer liveness tears down terminal SCTP and sustained ICE failures', () => {
    const sctpReasons = [];
    const sctp = new StreamerLivenessMonitor({
        disconnectGraceMs: 5000,
        onDead: (reason) => sctpReasons.push(reason)
    });
    sctp.onSctpState('closed');
    sctp.onIceState('failed');
    assert.deepEqual(sctpReasons, ['SCTP closed']);

    const timers = fakeTimerHarness();
    const iceReasons = [];
    const ice = new StreamerLivenessMonitor({
        disconnectGraceMs: 5000,
        onDead: (reason) => iceReasons.push(reason),
        setTimeoutFn: timers.setTimer,
        clearTimeoutFn: timers.clearTimer
    });
    ice.onIceState('disconnected');
    timers.timers[0].callback();
    assert.deepEqual(iceReasons, ['ICE disconnected beyond grace period']);
});

test('registration probe requires an exact streamer identity', () => {
    const list = JSON.stringify({ type: 'streamerList', ids: ['render-13', 'HRLV Rotunda'] });
    assert.equal(streamerListContains(list, 'HRLV Rotunda'), true);
    assert.equal(streamerListContains(list, 'HRLV'), false);
    assert.equal(streamerListContains('{not json', 'HRLV Rotunda'), false);
});

test('registration probe observes the player-facing streamer list', async () => {
    const server = new WebSocket.Server({ port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    server.on('connection', (socket) => {
        socket.on('message', () => {
            socket.send(JSON.stringify({ type: 'streamerList', ids: ['render-13', 'HRLV Rotunda'] }));
        });
    });

    const address = server.address();
    await probeRegistration(`ws://127.0.0.1:${address.port}`, 'HRLV Rotunda', 1000);
    await new Promise((resolve) => server.close(resolve));
});

test('registration probe rejects a stale or absent SFU identity', async () => {
    const server = new WebSocket.Server({ port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    server.on('connection', (socket) => {
        socket.on('message', () => {
            socket.send(JSON.stringify({ type: 'streamerList', ids: ['render-13'] }));
        });
    });

    const address = server.address();
    await assert.rejects(
        probeRegistration(`ws://127.0.0.1:${address.port}`, 'HRLV Rotunda', 25),
        /timed out/
    );
    await new Promise((resolve) => server.close(resolve));
});
