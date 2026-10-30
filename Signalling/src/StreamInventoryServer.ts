// Copyright Epic Games, Inc. All Rights Reserved.
import type { StreamEndpoint, StreamInventorySnapshot } from '@ignition-is-go/pulse-reporting-types';
import { WebSocket, WebSocketServer } from 'ws';
import { SFUConnection } from './SFUConnection';
import { StreamerRegistry } from './StreamerRegistry';
import { Logger } from './Logger';

/** Full registration facts; availability uses the same projection as player discovery. */
export function streamInventory(registry: StreamerRegistry): StreamInventorySnapshot {
    const available = new Set(registry.availableToPlayers());
    return {
        streams: registry.streamers
            .map(
                (streamer): StreamEndpoint => ({
                    streamerId: streamer.streamerId,
                    producerKind: streamer instanceof SFUConnection ? 'sfu' : 'streamer',
                    availableToPlayers: available.has(streamer),
                    upstreamStreamerId:
                        streamer instanceof SFUConnection
                            ? (streamer.subscribedStreamer?.streamerId ?? null)
                            : null
                })
            )
            .sort((left, right) => left.streamerId.localeCompare(right.streamerId))
    };
}

/** Optional private listener. Clients observe inventory without becoming Pixel Streaming players. */
export class StreamInventoryServer {
    readonly server: WebSocketServer;
    private queued = false;
    private closed = false;
    private previous: string;
    private readonly changed = () => {
        if (this.closed || this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
            this.queued = false;
            if (this.closed) return;
            const payload = JSON.stringify(streamInventory(this.registry));
            if (payload === this.previous) return;
            this.previous = payload;
            for (const socket of this.server.clients) {
                if (socket.readyState === WebSocket.OPEN) socket.send(payload);
            }
        });
    };

    constructor(
        private readonly registry: StreamerRegistry,
        address: { host: string; port: number }
    ) {
        this.previous = JSON.stringify(streamInventory(registry));
        this.server = new WebSocketServer(address);
        this.server.on('error', (error) => Logger.error(`Stream inventory listener: ${error.message}`));
        this.server.on('connection', (socket) => {
            socket.on('error', (error) => Logger.warn(`Stream inventory client: ${error.message}`));
            socket.send(JSON.stringify(streamInventory(registry)));
        });
        registry.on('changed', this.changed);
    }

    close(): Promise<void> {
        this.closed = true;
        this.registry.off('changed', this.changed);
        for (const socket of this.server.clients) socket.terminate();
        return new Promise((resolve, reject) =>
            this.server.close((error) => (error ? reject(error) : resolve()))
        );
    }
}
