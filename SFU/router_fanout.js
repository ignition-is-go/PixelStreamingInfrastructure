const { runSafely } = require('./async_helpers');

const pipeListenInfo = {
    protocol: 'udp',
    ip: '127.0.0.1',
    sendBufferSize: 8 * 1024 * 1024,
    recvBufferSize: 8 * 1024 * 1024
};

function closeIfOpen(entity) {
    if (entity && !entity.closed) {
        entity.close();
    }
}

function closePipeResult(result) {
    closeIfOpen(result?.pipeConsumer);
    closeIfOpen(result?.pipeProducer);
    closeIfOpen(result?.pipeDataConsumer);
    closeIfOpen(result?.pipeDataProducer);
}

function webRtcTransportOptions(options) {
    const {
        listenIps,
        listenInfos,
        ...rest
    } = options;

    return {
        ...rest,
        ...(listenInfos ? { listenInfos } : { listenIps }),
        enableUdp: true,
        enableTcp: false,
        preferUdp: true,
        enableSctp: true
    };
}

async function createRouterFanout({
    mediasoup,
    workerCount = 1,
    workerOptions,
    routerOptions,
    webRtcTransportOptions: transportOptions,
    onWorkerDied,
    logger = console
}) {
    if (!Number.isInteger(workerCount) || workerCount < 1) {
        throw new TypeError('mediasoup.workerCount must be a positive integer');
    }
    if (!mediasoup || typeof mediasoup.createWorker !== 'function') {
        throw new TypeError('mediasoup.createWorker is required');
    }
    if (typeof onWorkerDied !== 'function') {
        throw new TypeError('onWorkerDied must be a function');
    }

    const slots = [];
    let closed = false;
    let nextTieBreak = 0;

    try {
        for (let index = 0; index < workerCount; index += 1) {
            const worker = await mediasoup.createWorker({ ...workerOptions });
            try {
                worker.on('died', () => onWorkerDied(index));
                const router = await worker.createRouter({ ...routerOptions });
                slots.push({ index, worker, router, viewerCount: 0 });
            } catch (error) {
                closeIfOpen(worker);
                throw error;
            }
        }
    } catch (error) {
        for (const slot of slots) {
            closeIfOpen(slot.worker);
        }
        throw error;
    }

    const ingressSlot = slots[0];
    const viewerSlots = slots.length === 1 ? slots : slots.slice(1);

    async function createWebRtcTransport(slot, {
        identifier,
        onIceStateChange,
        onSctpStateChange
    } = {}) {
        if (closed) {
            throw new Error('router fanout is closed');
        }

        const transport = await slot.router.createWebRtcTransport(
            webRtcTransportOptions(transportOptions)
        );
        transport.on('icestatechange', (iceState) => {
            logger.log('%s ICE state changed to %s', identifier, iceState);
            if (onIceStateChange) {
                void runSafely(
                    `${identifier} ICE state handler failed`,
                    () => onIceStateChange(iceState),
                    logger
                );
            }
        });
        transport.on('iceselectedtuplechange', (iceTuple) => {
            logger.log('%s ICE selected tuple %s', identifier, JSON.stringify(iceTuple));
        });
        transport.on('sctpstatechange', (sctpState) => {
            logger.log('%s SCTP state changed to %s', identifier, sctpState);
            if (onSctpStateChange) {
                void runSafely(
                    `${identifier} SCTP state handler failed`,
                    () => onSctpStateChange(sctpState),
                    logger
                );
            }
        });
        return transport;
    }

    function reserveViewer(playerId) {
        let selectedOffset = 0;
        let selected = viewerSlots[nextTieBreak % viewerSlots.length];

        for (let offset = 1; offset < viewerSlots.length; offset += 1) {
            const candidateOffset = (nextTieBreak + offset) % viewerSlots.length;
            const candidate = viewerSlots[candidateOffset];
            if (candidate.viewerCount < selected.viewerCount) {
                selected = candidate;
                selectedOffset = offset;
            }
        }

        const selectedIndex = (nextTieBreak + selectedOffset) % viewerSlots.length;
        nextTieBreak = (selectedIndex + 1) % viewerSlots.length;
        selected.viewerCount += 1;
        logger.log(
            'Assigned player %s to mediasoup worker %d (%d active)',
            playerId,
            selected.index,
            selected.viewerCount
        );

        let released = false;
        return {
            slot: selected,
            release() {
                if (released) {
                    return;
                }
                released = true;
                selected.viewerCount -= 1;
            }
        };
    }

    function openGeneration({ generation, producers }) {
        if (closed) {
            throw new Error('router fanout is closed');
        }

        const targets = new Map();
        const playerRoutes = new Set();
        let generationClosed = false;

        function closeTarget(target) {
            if (!target || target.closed) {
                return;
            }
            target.closed = true;
            for (const result of target.pipeResults) {
                closePipeResult(result);
            }
        }

        async function createTarget(slot) {
            if (slot === ingressSlot) {
                return {
                    slot,
                    mediaProducers: producers,
                    pipeResults: [],
                    closed: false
                };
            }

            const pipeResults = [];
            try {
                for (const producer of producers) {
                    const result = await ingressSlot.router.pipeToRouter({
                        producerId: producer.id,
                        router: slot.router,
                        listenInfo: pipeListenInfo,
                        enableSctp: true,
                        enableRtx: true
                    });
                    pipeResults.push(result);
                    if (generationClosed) {
                        for (const partial of pipeResults) {
                            closePipeResult(partial);
                        }
                        return null;
                    }
                }

                return {
                    slot,
                    mediaProducers: pipeResults.map((result) => result.pipeProducer),
                    pipeResults,
                    closed: false
                };
            } catch (error) {
                for (const partial of pipeResults) {
                    closePipeResult(partial);
                }
                throw error;
            }
        }

        function targetFor(slot) {
            const cached = targets.get(slot.index);
            if (cached) {
                return cached;
            }

            const pending = createTarget(slot);
            targets.set(slot.index, pending);
            pending.catch(() => {
                if (targets.get(slot.index) === pending) {
                    targets.delete(slot.index);
                }
            });
            return pending;
        }

        async function openPlayer({ playerId, isCurrent, identifier = `Peer ${playerId}` }) {
            if (generationClosed || !isCurrent()) {
                return { kind: 'stale' };
            }
            const reservation = reserveViewer(playerId);
            let transport = null;

            try {
                const target = await targetFor(reservation.slot);
                if (!target || generationClosed || !isCurrent()) {
                    reservation.release();
                    return { kind: 'stale' };
                }

                transport = await createWebRtcTransport(reservation.slot, { identifier });
                if (generationClosed || !isCurrent()) {
                    closeIfOpen(transport);
                    reservation.release();
                    return { kind: 'stale' };
                }

                const dataPipeResults = new Set();
                let routeClosed = false;
                const route = {
                    transport,
                    rtpCapabilities: reservation.slot.router.rtpCapabilities,
                    mediaProducers: target.mediaProducers,
                    async toIngress(dataProducer) {
                        return pipeDataProducer(
                            dataProducer,
                            reservation.slot.router,
                            ingressSlot.router
                        );
                    },
                    async fromIngress(dataProducer) {
                        return pipeDataProducer(
                            dataProducer,
                            ingressSlot.router,
                            reservation.slot.router
                        );
                    },
                    close() {
                        if (routeClosed) {
                            return;
                        }
                        routeClosed = true;
                        playerRoutes.delete(route);
                        for (const result of dataPipeResults) {
                            closePipeResult(result);
                        }
                        closeIfOpen(transport);
                        reservation.release();
                    }
                };

                async function pipeDataProducer(dataProducer, sourceRouter, destinationRouter) {
                    if (routeClosed || generationClosed || !isCurrent()) {
                        return { kind: 'stale' };
                    }
                    if (sourceRouter === destinationRouter) {
                        return { kind: 'ready', producer: dataProducer };
                    }

                    const result = await sourceRouter.pipeToRouter({
                        dataProducerId: dataProducer.id,
                        router: destinationRouter,
                        listenInfo: pipeListenInfo,
                        enableSctp: true,
                        enableRtx: true
                    });
                    if (routeClosed || generationClosed || !isCurrent()) {
                        closePipeResult(result);
                        return { kind: 'stale' };
                    }
                    dataPipeResults.add(result);
                    return { kind: 'ready', producer: result.pipeDataProducer };
                }

                playerRoutes.add(route);
                return { kind: 'ready', route };
            } catch (error) {
                closeIfOpen(transport);
                reservation.release();
                throw error;
            }
        }

        const fanoutGeneration = {
            generation,
            openPlayer,
            close() {
                if (generationClosed) {
                    return;
                }
                generationClosed = true;
                for (const route of [...playerRoutes]) {
                    route.close();
                }
                for (const pending of targets.values()) {
                    void pending.then(closeTarget, () => {});
                }
                targets.clear();
            }
        };
        return fanoutGeneration;
    }

    return {
        ingressRouter: ingressSlot.router,
        ingressRtpCapabilities: ingressSlot.router.rtpCapabilities,
        createIngressTransport(options) {
            return createWebRtcTransport(ingressSlot, options);
        },
        openGeneration,
        close() {
            if (closed) {
                return;
            }
            closed = true;
            for (const slot of slots) {
                closeIfOpen(slot.worker);
            }
        }
    };
}

module.exports = {
    createRouterFanout,
    webRtcTransportOptions
};
