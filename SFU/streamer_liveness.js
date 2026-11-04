class StreamerLivenessMonitor {
    constructor({
        disconnectGraceMs,
        onDead,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout
    }) {
        if (!(disconnectGraceMs > 0)) {
            throw new Error('streamer disconnect grace must be positive');
        }

        this.disconnectGraceMs = disconnectGraceMs;
        this.onDead = onDead;
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.disconnectTimer = null;
        this.dead = false;
    }

    onIceState(state) {
        if (this.dead) {
            return;
        }
        if (state === 'connected' || state === 'completed') {
            this.clearDisconnectTimer();
        } else if (state === 'disconnected') {
            this.scheduleDisconnect();
        } else if (state === 'failed' || state === 'closed') {
            this.markDead(`ICE ${state}`);
        }
    }

    onSctpState(state) {
        if (state === 'failed' || state === 'closed') {
            this.markDead(`SCTP ${state}`);
        }
    }

    scheduleDisconnect() {
        if (this.disconnectTimer !== null) {
            return;
        }
        this.disconnectTimer = this.setTimeoutFn(() => {
            this.disconnectTimer = null;
            this.markDead('ICE disconnected beyond grace period');
        }, this.disconnectGraceMs);
    }

    clearDisconnectTimer() {
        if (this.disconnectTimer !== null) {
            this.clearTimeoutFn(this.disconnectTimer);
            this.disconnectTimer = null;
        }
    }

    markDead(reason) {
        if (this.dead) {
            return;
        }
        this.dead = true;
        this.clearDisconnectTimer();
        this.onDead(reason);
    }

    stop() {
        this.dead = true;
        this.clearDisconnectTimer();
    }
}

module.exports = { StreamerLivenessMonitor };
