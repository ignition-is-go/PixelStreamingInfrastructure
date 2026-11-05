const {execFileSync} = require('node:child_process');
const {mkdtempSync, readFileSync, writeFileSync} = require('node:fs');
const {createHash} = require('node:crypto');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {nalUnits, packetize} = require('./h264-profile-rtp.cjs');
const {probeBrowsers} = require('./h264-profile-probe.cjs');

async function main() {
    if (!process.env.MEDIASOUP_WORKER_BIN) throw new Error('Build and select the isolated TCP worker first');
    const workerBuild = JSON.parse(readFileSync(path.join(path.dirname(process.env.MEDIASOUP_WORKER_BIN), 'h264-tcp-build.json')));
    if (workerBuild.rtpCapacity !== 1900 || workerBuild.binarySha256 !==
        createHash('sha256').update(readFileSync(process.env.MEDIASOUP_WORKER_BIN)).digest('hex')) {
        throw new Error('Worker does not match the isolated larger-packet build receipt');
    }
    const directory = mkdtempSync(path.join(tmpdir(), 'h264-tcp-bench-'));
    const fixtures = [];
    const files = [];
    for (const [name, filter, qp] of [
        ['small', 'testsrc2=size=3840x2160:rate=30', 12],
        ['large', 'testsrc2=size=3840x2160:rate=30,noise=alls=6:allf=t:all_seed=1', 20]
    ]) {
        const file = path.join(directory, `${name}.h264`);
        execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-filter_threads', '1',
            '-f', 'lavfi', '-i', filter, '-frames:v', '1', '-an', '-pix_fmt', 'yuv420p',
            '-c:v', 'libx264', '-threads', '2', '-preset', 'medium', '-tune', 'zerolatency',
            '-profile:v', 'baseline', '-qp', String(qp), '-x264-params', 'keyint=30:bframes=0:scenecut=0',
            '-f', 'h264', file], {stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000});
        const bytes = readFileSync(file);
        const nals = nalUnits(bytes);
        const profileLevelId = nals.find(nal => (nal[0] & 31) === 7).subarray(1,4).toString('hex');
        files.push({name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), qp});
        for (const rtpMtu of name === 'small' ? [1400] : [1400, 1800]) {
            const packets = packetize(nals, {mtu:rtpMtu, sequence:1000, timestamp:90000}).packets.length;
            if (name === 'large' && (rtpMtu === 1400 ? packets <= 2048 : packets > 2048)) {
                throw new Error(`Fixture does not bracket assembly budget: mtu=${rtpMtu} packets=${packets}`);
            }
            fixtures.push({file, fixture:`${name}-mtu-${rtpMtu}`, profile:'baseline', profileLevelId, rtpMtu});
        }
    }
    const browsers = await probeBrowsers(fixtures, {transportProtocol:'tcp'});
    const report = {productionQualified:false, files, browsers, workerBuild,
        worker:process.env.MEDIASOUP_WORKER_BIN,
        limits:['Synthetic libx264 frames, not actual Unreal/NVENC qualification',
            'Repeated IDRs at two fps, not sustained 4K30 or loss/latency acceptance',
            'Larger packets require TCP on every network leg; UDP remains unqualified',
            'RTP is packetized before mediasoup input; production repacketization remains separate']};
    const destination = path.join(directory, 'report.json');
    writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`REPORT=${destination}`);
    const required = process.env.H264_PROFILE_BROWSER_MODE === 'shipping'
        ? ['chromium','firefox','safari'] : ['chromium','webkit'];
    for (const name of required) {
        const browser = browsers.find(browser => browser.browser === name);
        if (browser?.status !== 'completed') throw new Error(`${name} unavailable`);
        for (const fixture of fixtures) {
            const outcome = browser.cases.find(outcome => outcome.fixture === fixture.fixture);
            const expected = fixture.fixture === 'large-mtu-1400' ? 'no-decoded-frame' : 'decoded';
            if (outcome?.status !== expected || outcome.selectedTuple?.protocol !== 'tcp' || outcome.sendError) {
                throw new Error(`${name} ${fixture.fixture}: expected ${expected} over TCP`);
            }
        }
    }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
