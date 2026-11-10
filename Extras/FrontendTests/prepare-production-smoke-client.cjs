const fs = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

function observePeers(jitterBufferTarget, appBuild) {
    // Epic's reference UI can send encoder and input commands during startup.
    // This page only observes media; RTP/RTCP and inbound SCTP are unaffected.
    let blocked = 0;
    let stateRequests = 0;
    const send = window.RTCDataChannel.prototype.send;
    const requestState = '{"StreamCamera":{"RequestState":true}}';
    const stateRequest = [50, requestState.length, 0,
        ...Array.from(requestState, (character) => [character.charCodeAt(0), 0]).flat()];
    window.RTCDataChannel.prototype.send = function (value) {
        if (appBuild && ArrayBuffer.isView(value) && value.byteLength === stateRequest.length) {
            const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            if (bytes.every((byte, index) => byte === stateRequest[index])) {
                stateRequests++;
                return send.call(this, value);
            }
        }
        blocked++;
    };
    Object.defineProperty(window, '__pixelstreamSmokeBlockedDataMessages', { get: () => blocked });
    if (appBuild) {
        Object.defineProperty(window, '__pixelstreamSmokeAppBuild', { value: Object.freeze(appBuild) });
        Object.defineProperty(window, '__pixelstreamSmokeStateRequests', { get: () => stateRequests });
    }
    window.__pixelstreamSmokePeers = [];
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
        constructor(...args) {
            super(...args);
            window.__pixelstreamSmokePeers.push(this);
            if (jitterBufferTarget !== null) {
                this.addEventListener('track', ({ track, receiver }) => {
                    if (track.kind === 'video' && 'jitterBufferTarget' in receiver) {
                        receiver.jitterBufferTarget = jitterBufferTarget;
                    }
                });
            }
        }
    };
}

function prepare(html, jitterBufferTarget = 200, appBuild = null) {
    if (appBuild !== null) {
        if (!/^[a-f0-9]{40}$/.test(appBuild.sourceCommit) || !/^[a-f0-9]{64}$/.test(appBuild.wasmSha256) ||
            jitterBufferTarget !== null) {
            throw new Error('app observer requires an exact source commit, WASM hash, and no buffer override');
        }
    } else if (![200, 500].includes(jitterBufferTarget)) {
        throw new Error('unsupported smoke buffer target');
    }
    const marker = 'data-pixelstream-smoke-observer="3"';
    const args = appBuild ? 'null,' + JSON.stringify({
        sourceCommit: appBuild.sourceCommit, wasmSha256: appBuild.wasmSha256
    }) : String(jitterBufferTarget);
    const script = '<script ' + marker + '>(' + observePeers.toString() + ')(' + args + ');</script>';
    if (html.includes(marker)) {
        if (html.includes(script)) return html;
        throw new Error('client has a different smoke observer');
    }
    if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('client has no head element');
    return html.replace(
        /<head(?:\s[^>]*)?>/i,
        (head) => head + script
    );
}

function verifyAppWasm(html, entryFile, expectedSha256) {
    const name = html.match(/module_or_path:\s*['"]\/?([a-zA-Z0-9_-]+_bg\.wasm)['"]/)?.[1];
    if (!name) throw new Error('compiled app entry does not identify its WASM');
    const actualSha256 = createHash('sha256').update(fs.readFileSync(path.join(path.dirname(entryFile), name))).digest('hex');
    if (actualSha256 !== expectedSha256) throw new Error('compiled app WASM does not match the expected hash');
    return actualSha256;
}

module.exports = { prepare };
if (require.main === module) {
    const file = process.argv[2];
    if (!file) throw new Error('provide the built client HTML path');
    const client = process.env.PIXELSTREAM_SMOKE_CLIENT ?? 'reference';
    if (!['reference', 'app'].includes(client)) throw new Error('unsupported smoke client');
    const target = Number(process.env.PIXELSTREAM_SMOKE_JITTER_BUFFER_MS ?? 200);
    const html = fs.readFileSync(file, 'utf8');
    const prepared = client === 'app'
        ? prepare(html, null, {
            sourceCommit: process.env.PIXELSTREAM_APP_SOURCE_COMMIT,
            wasmSha256: verifyAppWasm(html, file, process.env.PIXELSTREAM_APP_WASM_SHA256)
        })
        : prepare(html, target);
    fs.writeFileSync(file, prepared);
}
