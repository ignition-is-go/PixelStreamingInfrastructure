class SignallingWatchdog {
    constructor(socket, {
        intervalMs,
        timeoutMs,
        openState,
        onStale,
        logger = console,
        now = Date.now,
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval
    }) {
        if (!(intervalMs > 0) || !(timeoutMs > intervalMs)) {
            throw new Error('signalling watchdog timeout must be greater than its interval');
        }

        this.socket = socket;
        this.intervalMs = intervalMs;
        this.timeoutMs = timeoutMs;
        this.openState = openState;
        this.onStale = onStale;
        this.logger = logger;
        this.now = now;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.lastActivityAt = now();
        this.timer = null;
        this.stale = false;
    }

    start() {
        if (this.timer === null && !this.stale) {
            this.timer = this.setIntervalFn(() => this.check(), this.intervalMs);
        }
    }

    recordActivity() {
        this.lastActivityAt = this.now();
    }

    check() {
        if (this.stale) {
            return;
        }

        const silentForMs = this.now() - this.lastActivityAt;
        if (silentForMs >= this.timeoutMs) {
            this.stale = true;
            this.stop();
            this.logger.error(`Signalling connection received no activity for ${silentForMs}ms; forcing reconnect`);
            this.onStale();
            return;
        }

        if (this.socket.readyState === this.openState) {
            try {
                this.socket.ping();
            } catch (error) {
                this.stale = true;
                this.stop();
                this.logger.error(`Signalling heartbeat failed: ${error.message}`);
                this.onStale();
            }
        }
    }

    stop() {
        if (this.timer !== null) {
            this.clearIntervalFn(this.timer);
            this.timer = null;
        }
    }
}

function reconnectDelayMs(attempt, minimumMs, maximumMs) {
    if (!(minimumMs > 0) || maximumMs < minimumMs) {
        throw new Error('invalid signalling reconnect bounds');
    }
    const exponent = Math.max(0, Math.min(attempt, 30));
    return Math.min(maximumMs, minimumMs * (2 ** exponent));
}

module.exports = { SignallingWatchdog, reconnectDelayMs };
