// Copyright Epic Games, Inc. All Rights Reserved.
import type { IncomingMessage } from 'http';
import type { StreamProducerDeclaration } from '@ignition-is-go/pulse-reporting-types';
import { Logger } from './Logger';

function parseInstanceId(value: string): string {
    let id = value;
    if (value.length === 32) {
        id = `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    } else if (value.length === 38 && value.startsWith('{') && value.endsWith('}')) {
        id = value.slice(1, -1);
    } else if (value.length === 45 && value.slice(0, 9).toLowerCase() === 'urn:uuid:') {
        id = value.slice(9);
    }
    if (
        id.length !== 36 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
        id === '00000000-0000-0000-0000-000000000000'
    ) {
        throw new Error('invalid producer instanceId');
    }
    return id.toLowerCase();
}

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
                instanceId: parseInstanceId(process.instanceId),
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
