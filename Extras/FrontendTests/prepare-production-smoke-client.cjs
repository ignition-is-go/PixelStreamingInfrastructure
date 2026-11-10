const fs = require('node:fs');

function observePeers(jitterBufferTarget) {
    window.__pixelstreamSmokePeers = [];
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
        constructor(...args) {
            super(...args);
            window.__pixelstreamSmokePeers.push(this);
            this.addEventListener('track', ({ track, receiver }) => {
                if (track.kind === 'video' && 'jitterBufferTarget' in receiver) {
                    receiver.jitterBufferTarget = jitterBufferTarget;
                }
            });
        }
    };
}

function prepare(html, jitterBufferTarget = 200) {
    if (![200, 500].includes(jitterBufferTarget)) throw new Error('unsupported smoke buffer target');
    const marker = 'data-pixelstream-smoke-observer="2"';
    if (html.includes(marker)) return html;
    if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('reference client has no head element');
    return html.replace(
        /<head(?:\s[^>]*)?>/i,
        (head) => head + '<script ' + marker + '>(' + observePeers.toString() + ')(' + jitterBufferTarget + ');</script>'
    );
}

module.exports = { prepare };
if (require.main === module) {
    const file = process.argv[2];
    if (!file) throw new Error('provide the built reference player.html path');
    const target = Number(process.env.PIXELSTREAM_SMOKE_JITTER_BUFFER_MS ?? 200);
    fs.writeFileSync(file, prepare(fs.readFileSync(file, 'utf8'), target));
}
