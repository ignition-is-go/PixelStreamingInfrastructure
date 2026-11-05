const fs = require('node:fs');

function observePeers() {
    window.__pixelstreamSmokePeers = [];
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
        constructor(...args) {
            super(...args);
            window.__pixelstreamSmokePeers.push(this);
        }
    };
}

function prepare(html) {
    const marker = 'data-pixelstream-smoke-observer="2"';
    if (html.includes(marker)) return html;
    if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('reference client has no head element');
    return html.replace(
        /<head(?:\s[^>]*)?>/i,
        (head) => head + '<script ' + marker + '>(' + observePeers.toString() + ')();</script>'
    );
}

module.exports = { prepare };
if (require.main === module) {
    const file = process.argv[2];
    if (!file) throw new Error('provide the built reference player.html path');
    fs.writeFileSync(file, prepare(fs.readFileSync(file, 'utf8')));
}
