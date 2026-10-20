const MULTIPLEX_MESSAGE_ID = 199; // ID | 2 byte length | PlayerId | Original message
const CHANNEL_RELAY_STATUS_MESSAGE_ID = 198; // ID | 2 byte length | PlayerId | 1 byte flag
const UI_INTERACTION_MESSAGE_ID = 50;
const KEY_DOWN_MESSAGE_ID = 60;
const KEY_UP_MESSAGE_ID = 61;
const MOUSE_DOWN_MESSAGE_ID = 72;
const MOUSE_UP_MESSAGE_ID = 73;

// Only an explicitly attributed operator action may move the camera Home. This
// keeps reconnecting and legacy clients from releasing the active shot while
// preserving the current UI's Home control.
function isUnattributedHomeReset(message) {
    if (!Buffer.isBuffer(message) || message.length < 2 || message.readUInt8(0) !== UI_INTERACTION_MESSAGE_ID) {
        return false;
    }

    try {
        const descriptor = JSON.parse(new TextDecoder('utf-16').decode(message.subarray(1)));
        const camera = descriptor?.StreamCamera;
        return camera?.ResetHome === true && camera.ResetHomeSource !== 'Operator';
    } catch {
        return false;
    }
}

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
        return route !== null && currentRoute === route && !route.closed;
    }

    function sendToStreamer(route, message) {
        if (!isCurrentRoute(route) || !route.ready || !route.producer || route.producer.closed) {
            return false;
        }

        route.producer.send(message, 53);
        return true;
    }

    function updateHeldInput(player, route, message) {
        if (!Buffer.isBuffer(message)) {
            return;
        }

        const type = message[0];
        if (type === KEY_DOWN_MESSAGE_ID && message.length === 3) {
            player.heldInput.set(`key:${message[1]}`, {
                generation: route.generation,
                release: Buffer.from([KEY_UP_MESSAGE_ID, message[1]])
            });
        } else if (type === KEY_UP_MESSAGE_ID && message.length === 2) {
            player.heldInput.delete(`key:${message[1]}`);
        } else if (type === MOUSE_DOWN_MESSAGE_ID && message.length === 6) {
            player.heldInput.set(`mouse:${message[1]}`, {
                generation: route.generation,
                release: Buffer.from([MOUSE_UP_MESSAGE_ID, ...message.subarray(1)])
            });
        } else if (type === MOUSE_UP_MESSAGE_ID && message.length === 6) {
            player.heldInput.delete(`mouse:${message[1]}`);
        }
    }

    function suppressSharedInputRelease(player, route, message) {
        if (!Buffer.isBuffer(message)) {
            return false;
        }

        const type = message[0];
        let input;
        if (type === KEY_UP_MESSAGE_ID && message.length === 2) {
            input = `key:${message[1]}`;
        } else if (type === MOUSE_UP_MESSAGE_ID && message.length === 6) {
            input = `mouse:${message[1]}`;
        } else {
            return false;
        }

        const heldByAnotherPlayer = [...players.values()].some((otherPlayer) => {
            if (otherPlayer === player) {
                return false;
            }
            return otherPlayer.heldInput.get(input)?.generation === route?.generation;
        });
        if (!heldByAnotherPlayer) {
            return false;
        }

        player.heldInput.delete(input);
        return true;
    }

    function releaseHeldInput(player, route) {
        for (const [input, held] of player.heldInput) {
            if (held.generation !== route?.generation) {
                continue;
            }

            const heldByAnotherPlayer = [...players.values()].some((otherPlayer) => {
                const otherHeld = otherPlayer.heldInput.get(input);
                return otherHeld?.generation === route.generation;
            });
            if (!heldByAnotherPlayer) {
                sendToStreamer(route, Buffer.concat([createMultiplexHeader(player.id), held.release]));
            }
        }
        player.heldInput.clear();
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
                releaseHeldInput(player, route);
                sendToStreamer(route, createRelayStatusMessage(player.id, 0));
            } else {
                player.heldInput.clear();
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
            announcedGeneration: null,
            heldInput: new Map()
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
                    if (isUnattributedHomeReset(message)) {
                        logger.warn(`Dropping unattributed ResetHome from ${player.id}`);
                        return;
                    }
                    if (suppressSharedInputRelease(player, activeRoute, message)) {
                        return;
                    }
                    if (sendToStreamer(activeRoute, Buffer.concat([createMultiplexHeader(player.id), message]))) {
                        updateHeldInput(player, activeRoute, message);
                    }
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
    createRelayStatusMessage,
    isUnattributedHomeReset
};
