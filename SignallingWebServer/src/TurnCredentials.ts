// Copyright Epic Games, Inc. All Rights Reserved.
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Read server-only TURN configuration once, then issue credentials for each connection. */
export function loadTurnPeerOptionsProviders(configPath: string): {
    peerOptionsProvider: () => object;
    streamerPeerOptionsProvider: () => object;
} {
    const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw new Error('TURN config must be an object');
    }
    const urls = parseUrls('urls' in config ? config.urls : undefined, 'turn');
    if (!urls.length) throw new Error('TURN config requires nonempty TURN URLs');
    const streamerUrls = 'streamerUrls' in config ? parseUrls(config.streamerUrls, 'turn') : urls;
    if (!streamerUrls.length) throw new Error('TURN config requires nonempty streamer TURN URLs');
    if (!('secretFile' in config) || typeof config.secretFile !== 'string' || !config.secretFile) {
        throw new Error('TURN config requires secretFile');
    }
    if (
        !('ttlSeconds' in config) ||
        typeof config.ttlSeconds !== 'number' ||
        !Number.isSafeInteger(config.ttlSeconds) ||
        config.ttlSeconds < 60 ||
        config.ttlSeconds > 604800
    ) {
        throw new Error('TURN ttlSeconds must be an integer from 60 through 604800');
    }
    const ttlSeconds = config.ttlSeconds;
    const stunUrls = 'stunUrls' in config ? parseUrls(config.stunUrls, 'stun') : [];
    const secret = readFileSync(resolve(dirname(configPath), config.secretFile), 'utf8').trim();
    if (!secret) {
        throw new Error('TURN secret file is empty');
    }
    const issuePeerOptions = (relayUrls: string[]) => {
        const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${randomUUID()}`;
        const credential = createHmac('sha1', secret).update(username).digest('base64');
        return {
            iceServers: [
                ...(stunUrls.length ? [{ urls: stunUrls }] : []),
                { urls: relayUrls, username, credential }
            ]
        };
    };
    return {
        peerOptionsProvider: () => issuePeerOptions(urls),
        streamerPeerOptionsProvider: () => issuePeerOptions(streamerUrls)
    };
}

function parseUrls(value: unknown, kind: 'turn' | 'stun'): string[] {
    if (!Array.isArray(value)) throw new Error(`${kind} URLs must be an array`);
    const entries: unknown[] = value;
    const urls: string[] = [];
    const pattern =
        kind === 'turn'
            ? /^turns?:[a-zA-Z0-9.\-[\]:]+(?:\?transport=(udp|tcp))?$/
            : /^stuns?:[a-zA-Z0-9.\-[\]:]+$/;
    for (const entry of entries) {
        if (typeof entry !== 'string' || !pattern.test(entry)) {
            throw new Error(`Invalid ${kind} URL; embedded credentials are not allowed`);
        }
        const parsed = new URL(entry.replace(/^(turn|stun)s?:/, 'https://'));
        if (!parsed.hostname) throw new Error(`Invalid ${kind} hostname`);
        urls.push(entry);
    }
    return urls;
}
