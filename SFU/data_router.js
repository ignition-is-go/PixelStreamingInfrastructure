const MULTIPLEX_MESSAGE_ID = 199; // ID | 2 byte length | PlayerId | Original message
const CHANNEL_RELAY_STATUS_MESSAGE_ID = 198; // ID | 2 byte length | PlayerId | 1 byte flag

function closeIfOpen(entity) {
    if (entity && !entity.closed) {
        entity.close();
    }
}

function createMultiplexHeader(playerId) {
    const byteLength = 1 + 2 + playerId.length * 2;
    const buffer = Buffer.alloc(byteLength);
    let byteOffset = 0;
    buffer.writeUInt8(MULTIPLEX_MESSAGE_ID, byteOffset++);
    buffer.writeUInt16LE(playerId.length * 2, byteOffset);
    byteOffset += 2;
    for (let i = 0; i < playerId.length; i++) {
        buffer.writeUInt16LE(playerId.charCodeAt(i), byteOffset);
        byteOffset += 2;
    }
    return buffer;
}

function parseMultiplexHeader(message) {
    if (!Buffer.isBuffer(message) || message.length < 3) {
        throw new Error('multiplex message is shorter than its header');
    }

    const type = message.readUInt8(0);
    if (type !== MULTIPLEX_MESSAGE_ID) {
        return null;
    }

    const length = message.readUInt16LE(1);
    const headerEnd = length + 3;
    if (length % 2 !== 0 || headerEnd > message.length) {
        throw new Error('multiplex message has an invalid player id length');
    }

    return {
        playerId: new TextDecoder('utf-16').decode(message.subarray(3, headerEnd)),
        buffer: message.subarray(headerEnd)
    };
}

function createRelayStatusMessage(playerId, status) {
    const byteLength = 1 + 2 + playerId.length * 2 + 1;
    const buffer = Buffer.alloc(byteLength);
    let byteOffset = 0;
    buffer.writeUInt8(CHANNEL_RELAY_STATUS_MESSAGE_ID, byteOffset++);
    buffer.writeUInt16LE(playerId.length * 2, byteOffset);
    byteOffset += 2;
    for (let i = 0; i < playerId.length; i++) {
        buffer.writeUInt16LE(playerId.charCodeAt(i), byteOffset);
        byteOffset += 2;
    }
    buffer.writeUInt8(status, byteOffset);
    return buffer;
}

async function createDataRouter(mediasoupRouter, logger = console) {
    if (!mediasoupRouter) {
        throw new Error('mediasoupRouter is undefined');
    }

    const transport = await mediasoupRouter.createDirectTransport({ maxMessageSize: 262144 });
    const players = new Map();
    let currentRoute = null;

    function isCurrentRoute(route) {
        return currentRoute === route && !route.closed;
    }

    function sendToStreamer(route, message) {
        if (!isCurrentRoute(route) || !route.ready || !route.producer || route.producer.closed) {
            return false;
        }

        route.producer.send(message, 53);
        return true;
    }

    function closeRoute(route) {
        if (!route) {
            return;
        }

        if (!route.closed) {
            route.closed = true;
            route.ready = false;
            if (currentRoute === route) {
                currentRoute = null;
            }
        }
        closeIfOpen(route.consumer);
        closeIfOpen(route.producer);
    }

    function disposePlayer(player, announceRemoval = true) {
        if (!player) {
            return;
        }

        if (!player.closed) {
            player.closed = true;
            if (players.get(player.id) === player) {
                players.delete(player.id);
            }

            const route = currentRoute;
            if (announceRemoval && player.announcedGeneration === route?.generation) {
                sendToStreamer(route, createRelayStatusMessage(player.id, 0));
            }
        }

        closeIfOpen(player.consumer);
        closeIfOpen(player.producer);
    }

    function announcePlayer(route, player) {
        if (!player.active || player.closed || players.get(player.id) !== player) {
            return false;
        }
        if (!sendToStreamer(route, createRelayStatusMessage(player.id, 1))) {
            return false;
        }
        player.announcedGeneration = route.generation;
        return true;
    }

    function activateStreamer(route) {
        if (!isCurrentRoute(route) || route.dataProducer.closed || route.producer.closed) {
            closeRoute(route);
            return false;
        }
        if (route.ready) {
            return true;
        }

        route.ready = true;
        for (const player of players.values()) {
            announcePlayer(route, player);
        }
        return true;
    }

    async function prepareStreamer(dataProducer, generation) {
        closeRoute(currentRoute);

        const route = {
            generation,
            dataProducer,
            consumer: null,
            producer: null,
            ready: false,
            closed: false
        };
        currentRoute = route;

        dataProducer.observer.once('close', () => closeRoute(route));

        try {
            route.consumer = await transport.consumeData({ dataProducerId: dataProducer.id });
            if (!isCurrentRoute(route) || dataProducer.closed) {
                closeRoute(route);
                return null;
            }

            route.consumer.on('message', (message) => {
                let relayMessage;
                try {
                    relayMessage = parseMultiplexHeader(message);
                } catch (error) {
                    logger.warn(`Dropping malformed multiplex message: ${error.message}`);
                    return;
                }

                if (!relayMessage) {
                    logger.warn('Dropping non-multiplexed streamer message');
                    return;
                }

                const player = players.get(relayMessage.playerId);
                if (player && player.active && !player.closed && player.producer && !player.producer.closed) {
                    player.producer.send(relayMessage.buffer, 53);
                }
            });

            route.producer = await transport.produceData({ label: 'streamer-producer' });
            if (!isCurrentRoute(route) || dataProducer.closed) {
                closeRoute(route);
                return null;
            }

            return route;
        } catch (error) {
            closeRoute(route);
            throw error;
        }
    }

    async function preparePlayer(dataProducer, playerId, generation) {
        const route = currentRoute;
        if (
            !isCurrentRoute(route) ||
            !route.ready ||
            route.generation !== generation ||
            dataProducer.closed
        ) {
            return null;
        }

        const previousPlayer = players.get(playerId);
        disposePlayer(previousPlayer);

        const player = {
            id: playerId,
            generation,
            dataProducer,
            consumer: null,
            producer: null,
            active: false,
            closed: false,
            announcedGeneration: null
        };
        players.set(playerId, player);
        dataProducer.observer.once('close', () => disposePlayer(player));

        try {
            player.consumer = await transport.consumeData({ dataProducerId: dataProducer.id });
            if (
                players.get(playerId) !== player ||
                player.closed ||
                dataProducer.closed ||
                !isCurrentRoute(route)
            ) {
                disposePlayer(player, false);
                return null;
            }

            player.consumer.on('message', (message) => {
                const activeRoute = currentRoute;
                if (player.active && !player.closed && players.get(player.id) === player) {
                    sendToStreamer(activeRoute, Buffer.concat([createMultiplexHeader(player.id), message]));
                }
            });

            player.producer = await transport.produceData({ label: 'player-producer' });
            if (
                players.get(playerId) !== player ||
                player.closed ||
                dataProducer.closed ||
                !isCurrentRoute(route) ||
                route.generation !== generation
            ) {
                disposePlayer(player, false);
                return null;
            }

            return player;
        } catch (error) {
            disposePlayer(player, false);
            throw error;
        }
    }

    function activatePlayer(player) {
        const route = currentRoute;
        if (
            !player ||
            players.get(player.id) !== player ||
            player.closed ||
            player.dataProducer.closed ||
            !isCurrentRoute(route) ||
            !route.ready ||
            route.generation !== player.generation ||
            !player.producer ||
            player.producer.closed
        ) {
            disposePlayer(player, false);
            return false;
        }

        player.active = true;
        if (!announcePlayer(route, player)) {
            disposePlayer(player, false);
            return false;
        }
        return true;
    }

    return {
        prepareStreamer,
        activateStreamer,
        preparePlayer,
        activatePlayer,
        closeStreamer(generation) {
            if (currentRoute?.generation === generation) {
                closeRoute(currentRoute);
            }
        },
        closePlayer(player) {
            disposePlayer(player);
        }
    };
}

module.exports = {
    createDataRouter,
    createMultiplexHeader,
    parseMultiplexHeader,
    createRelayStatusMessage
};
