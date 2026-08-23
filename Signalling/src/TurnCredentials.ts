// Copyright Epic Games, Inc. All Rights Reserved.
import { createHmac } from 'crypto';

export interface TurnRestIceServer {
    urls: string[];
    username: string;
    credential: string;
}

/** Create a coturn REST-API credential without exposing the shared secret. */
export function createTurnRestIceServer(
    urls: string[],
    sharedSecret: string,
    ttlSeconds = 600,
    nowSeconds = Math.floor(Date.now() / 1000)
): TurnRestIceServer {
    const ttl = Math.max(60, ttlSeconds);
    const username = `${nowSeconds + ttl}:pixelstream`;
    return {
        urls,
        username,
        credential: createHmac('sha1', sharedSecret).update(username).digest('base64')
    };
}
