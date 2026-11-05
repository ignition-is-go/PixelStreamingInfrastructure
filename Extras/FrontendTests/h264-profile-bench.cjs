const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { probeBrowsers } = require('./h264-profile-probe.cjs');
const { nalUnits } = require('./h264-profile-rtp.cjs');

function ffmpeg(args) {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-threads', '2', ...args], {
        encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120000
    });
    if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
    return result.stderr;
}

function describeFrame(file, rtpMtu) {
    const nals = nalUnits(readFileSync(file));
    const sps = nals.find(nal => (nal[0] & 31) === 7);
    if (!sps || !nals.some(nal => (nal[0] & 31) === 5)) throw new Error('Fixture has no SPS/IDR');
    // Conservative FU-A model: no aggregation, 12-byte RTP header, 2-byte FU header.
    const packets = nals.reduce((sum, nal) => sum + (nal.length <= rtpMtu - 12
        ? 1 : Math.ceil((nal.length - 1) / (rtpMtu - 14))), 0);
    return {
        bytes: nals.reduce((sum, nal) => sum + nal.length, 0),
        profileLevelId: sps.subarray(1, 4).toString('hex'),
        estimatedPackets: packets,
        estimatedFitsDefaultBuffer: packets <= 2048,
        estimateAssumptions: 'FU-A; no aggregation; 12-byte RTP header; excludes extensions and retransmissions'
    };
}

async function main() {
    const output = mkdtempSync(path.join(tmpdir(), 'h264-profile-bench-'));
    const cases = [];
    const source = 'testsrc2=size=3840x2160:rate=30';
    for (const [fixture, filter] of [
        ['pattern', source],
        ['detail', `${source},noise=alls=6:allf=t:all_seed=1`],
        ['grain', `${source},noise=alls=14:allf=t:all_seed=1`]
    ]) {
        const raw = path.join(output, `${fixture}.yuv`);
        ffmpeg(['-filter_threads', '1', '-f', 'lavfi', '-i', filter, '-frames:v', '1',
            '-pix_fmt', 'yuv420p', '-f', 'rawvideo', raw]);
        const rawInput = ['-f', 'rawvideo', '-pixel_format', 'yuv420p',
            '-video_size', '3840x2160', '-framerate', '30', '-i', raw];
        for (const profile of ['baseline', 'main', 'high']) {
            const file = path.join(output, `${fixture}-${profile}.h264`);
            const start = Date.now();
            ffmpeg([...rawInput, '-frames:v', '1', '-an',
                '-c:v', 'libx264', '-threads', '2', '-preset', 'medium', '-tune', 'zerolatency',
                '-profile:v', profile, '-qp', '12', '-x264-params', 'keyint=30:bframes=0:scenecut=0',
                '-f', 'h264', file]);
            const encodeMs = Date.now() - start;
            const quality = ffmpeg([...rawInput, '-i', file,
                '-filter_complex_threads', '1', '-filter_complex',
                '[0:v]split=2[r1][r2];[1:v]split=2[d1][d2];[r1][d1]ssim[s];[r2][d2]psnr[p]',
                '-map', '[s]', '-map', '[p]', '-frames:v', '1', '-f', 'null', '-']);
            const ssim = quality.match(/All:([\d.]+)/);
            const psnr = quality.match(/PSNR .*average:([\d.]+)/);
            if (!ssim || !psnr) throw new Error(`Missing quality measurements for ${file}`);
            const entry = { fixture, sourceFilter: filter, profile, file, qp: 12, encodeMs,
                ssim: Number(ssim[1]), psnrDb: Number(psnr[1]), ...describeFrame(file, 1400) };
            cases.push(entry);
            console.log(JSON.stringify(entry));
        }
    }
    const report = {
        schema: 'h264-offline-profile-bench/v1',
        productionQualified: false,
        browserMode: process.env.H264_PROFILE_BROWSER_MODE ?? 'portable',
        createdAt: new Date().toISOString(),
        encoder: 'libx264 software screening; not Unreal/NVENC qualification',
        ffmpeg: spawnSync('ffmpeg', ['-version'], {encoding: 'utf8'}).stdout.split('\n')[0],
        source: 'deterministic synthetic 3840x2160 YUV420 fixtures; one IDR per case',
        limits: ['SSIM/PSNR and equal QP do not establish identical visual quality',
            'Packet counts are estimates until measured on the actual RTP path',
            'Single-frame software encode timing is not a 4K30 performance benchmark',
            'Requires shipping Firefox/Safari and Unreal/NVENC canary before production'],
        cases,
        browsers: await probeBrowsers(cases)
    };
    const destination = path.join(output, 'report.json');
    writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`REPORT=${destination}`);
    const baseline = report.browsers.find(result => result.browser === 'chromium')?.cases
        .find(result => result.fixture === 'pattern' && result.profile === 'baseline');
    if (baseline?.status !== 'decoded') {
        throw new Error('Characterization harness failed its small 4K Baseline positive control; inspect report.json');
    }
    if (report.browsers.some(browser => browser.cases.some(result => result.status === 'error'))) {
        throw new Error('Characterization encountered a transport/harness error; inspect report.json');
    }
    if (report.browserMode === 'shipping' && report.browsers.some(browser => browser.status !== 'completed' ||
        browser.cases.find(result => result.fixture === 'pattern' && result.profile === 'baseline')?.status !== 'decoded')) {
        throw new Error('A shipping browser did not decode the 4K Baseline positive control; inspect report.json');
    }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { nalUnits, describeFrame };
