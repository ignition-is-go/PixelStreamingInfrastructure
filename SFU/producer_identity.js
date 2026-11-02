const { randomUUID } = require('node:crypto');
const { hostname } = require('node:os');

/** @type {import('@ignition-is-go/pulse-reporting-types').StreamProducerDeclaration} */
const producer = {
    application: 'sfu',
    process: { instanceId: randomUUID(), reportedHost: hostname(), pid: process.pid }
};

/** @param {string} server */
function producerSignallingUrl(server) {
    const url = new URL(server);
    url.searchParams.set('pulseProducer', JSON.stringify(producer));
    return url.toString();
}

module.exports = { producerSignallingUrl };
