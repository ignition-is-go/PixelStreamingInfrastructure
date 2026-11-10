const fs = require('node:fs');

function observePeers(jitterBufferTarget, appSourceCommit) {
    // Epic's reference UI can send encoder and input commands during startup.
    // This page only observes media; RTP/RTCP and inbound SCTP are unaffected.
    let blocked = 0;
    window.RTCDataChannel.prototype.send = function () { blocked++; };
    Object.defineProperty(window, '__pixelstreamSmokeBlockedDataMessages', { get: () => blocked });
    if (appSourceCommit) {
        Object.defineProperty(window, '__pixelstreamSmokeAppCommit', { value: appSourceCommit });
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

function prepare(html, jitterBufferTarget = 200, appSourceCommit = null) {
    if (appSourceCommit !== null) {
        if (!/^[a-f0-9]{40}$/.test(appSourceCommit) || jitterBufferTarget !== null) {
            throw new Error('app observer requires an exact source commit and no buffer override');
        }
    } else if (![200, 500].includes(jitterBufferTarget)) {
        throw new Error('unsupported smoke buffer target');
    }
    const marker = 'data-pixelstream-smoke-observer="3"';
    const args = appSourceCommit ? 'null,' + JSON.stringify(appSourceCommit) : String(jitterBufferTarget);
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

module.exports = { prepare };
if (require.main === module) {
    const file = process.argv[2];
    if (!file) throw new Error('provide the built client HTML path');
    const client = process.env.PIXELSTREAM_SMOKE_CLIENT ?? 'reference';
    if (!['reference', 'app'].includes(client)) throw new Error('unsupported smoke client');
    const target = Number(process.env.PIXELSTREAM_SMOKE_JITTER_BUFFER_MS ?? 200);
    const prepared = client === 'app'
        ? prepare(fs.readFileSync(file, 'utf8'), null, process.env.PIXELSTREAM_APP_SOURCE_COMMIT ?? '')
        : prepare(fs.readFileSync(file, 'utf8'), target);
    fs.writeFileSync(file, prepared);
}
