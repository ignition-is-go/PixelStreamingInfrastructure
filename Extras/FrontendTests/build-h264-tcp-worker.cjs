const {cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, appendFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');

// Build an isolated experiment. Never modify the installed dependency or its worker.
const source = path.dirname(require.resolve('mediasoup/package.json'));
const directory = mkdtempSync(path.join(tmpdir(), 'mediasoup-h264-tcp-'));
cpSync(source, directory, {recursive: true});
const constants = path.join(directory, 'worker/include/RTC/Consts.hpp');
let text = readFileSync(constants, 'utf8');
for (const [before, after] of [
    ['constexpr size_t MtuSize{ 1500u };', 'constexpr size_t MtuSize{ 1900u };'],
    ['RTC::Consts::MtuSize - 40 - 20 - 148u', '1500u - 40 - 20 - 148u']
]) {
    if (!text.includes(before)) throw new Error(`Unsupported mediasoup source: missing ${before}`);
    text = text.replace(before, after);
}
writeFileSync(constants, text);
for (const name of ['node-fetch', 'tar']) {
    const target = path.join(directory, 'node_modules', name);
    if (!existsSync(target)) symlinkSync(path.resolve(__dirname, '../../node_modules', name), target, 'dir');
}
const node = process.execPath;
// Limit Linux build concurrency without changing the dependency's build scripts.
const result = process.platform === 'linux'
    ? spawnSync('python3', ['-c',
        'import os,sys; os.sched_setaffinity(0, sorted(os.sched_getaffinity(0))[:4]); os.execv(sys.argv[1], sys.argv[1:])',
        node, 'npm-scripts.mjs', 'worker:build'], {cwd: directory, stdio: 'inherit'})
    : spawnSync(node, ['npm-scripts.mjs', 'worker:build'], {cwd: directory, stdio: 'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Worker build failed: ${result.status}`);
const binary = path.join(directory, 'worker/out/Release/mediasoup-worker');
writeFileSync(path.join(path.dirname(binary), 'h264-tcp-build.json'), JSON.stringify({
    mediasoupVersion: JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')).version,
    rtpCapacity:1900, rtcpCapacityUnchanged:true,
    binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex')
}));
console.log(`MEDIASOUP_WORKER_BIN=${binary}`);
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `MEDIASOUP_WORKER_BIN=${binary}\n`);
