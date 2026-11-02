// Copyright Epic Games, Inc. All Rights Reserved.
import type { IncomingMessage } from 'http';
import type { StreamProducerDeclaration } from '@ignition-is-go/pulse-reporting-types';
import { Logger } from './Logger';

export function readStreamProducer(
    request: IncomingMessage | undefined,
    application: StreamProducerDeclaration['application']
): StreamProducerDeclaration | undefined {
    try {
        const declarations = new URL(request?.url ?? '/', 'http://signalling').searchParams.getAll(
            'pulseProducer'
        );
        if (declarations.length === 0) {
            Logger.debug(
                `Stream producer identity missing ${JSON.stringify({
                    application,
                    remoteAddress: request?.socket.remoteAddress
                })}`
            );
            return undefined;
        }
        if (declarations.length !== 1) throw new Error('duplicate pulseProducer parameters');
        const value: unknown = JSON.parse(declarations[0]);
        if (
            typeof value !== 'object' ||
            value === null ||
            !('application' in value) ||
            value.application !== application ||
            !('process' in value)
        ) {
            throw new Error('producer application does not match connection');
        }
        const process = value.process;
        if (
            typeof process !== 'object' ||
            process === null ||
            !('instanceId' in process) ||
            typeof process.instanceId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(process.instanceId) ||
            process.instanceId === '00000000-0000-0000-0000-000000000000' ||
            !('reportedHost' in process) ||
            typeof process.reportedHost !== 'string' ||
            process.reportedHost.trim().length === 0 ||
            !('pid' in process) ||
            typeof process.pid !== 'number' ||
            !Number.isInteger(process.pid) ||
            process.pid <= 0 ||
            process.pid > 0xffffffff
        ) {
            throw new Error('invalid producer process identity');
        }
        return {
            application,
            process: {
                instanceId: process.instanceId.toLowerCase(),
                reportedHost: process.reportedHost,
                pid: process.pid
            }
        };
    } catch (error) {
        Logger.warn(
            `Stream producer identity ignored ${JSON.stringify({
                application,
                remoteAddress: request?.socket.remoteAddress,
                reason: error instanceof Error ? error.message : String(error)
            })}`
        );
        return undefined;
    }
}
