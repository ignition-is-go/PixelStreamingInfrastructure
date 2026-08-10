const WebSocket = require('ws');
const minimist = require('minimist');

function streamerListContains(data, expectedStreamerId) {
    let message;
    try {
        message = JSON.parse(data);
    } catch (_error) {
        return false;
    }
    return message.type === 'streamerList' && Array.isArray(message.ids) &&
        message.ids.includes(expectedStreamerId);
}

function probeRegistration(signallingURL, expectedStreamerId, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(signallingURL, { handshakeTimeout: timeoutMs });
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            socket.terminate();
            reject(new Error(`timed out waiting for ${expectedStreamerId} registration`));
        }, timeoutMs);

        const finish = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.terminate();
            }
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        socket.on('open', () => socket.send(JSON.stringify({ type: 'listStreamers' })));
        socket.on('message', (data) => {
            if (streamerListContains(data, expectedStreamerId)) {
                finish();
            }
        });
        socket.on('error', (error) => finish(error));
    });
}

async function main() {
    const args = minimist(process.argv.slice(2));
    const signallingURL = args.signallingURL;
    const streamerId = args.streamerId;
    const timeoutMs = Number(args.timeoutMs || 5000);
    if (!signallingURL || !streamerId || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('usage: registration_probe.js --signallingURL=ws://host:port --streamerId=ID [--timeoutMs=5000]');
    }

    await probeRegistration(signallingURL, streamerId, timeoutMs);
    console.log(`SFU ${streamerId} is registered at ${signallingURL}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { probeRegistration, streamerListContains };
