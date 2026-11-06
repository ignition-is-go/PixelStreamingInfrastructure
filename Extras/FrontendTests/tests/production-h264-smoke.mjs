import fs from 'node:fs';
import { Builder, By } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import firefox from 'selenium-webdriver/firefox.js';
import safari from 'selenium-webdriver/safari.js';
import { reportVersion, requireMediaFormat, requirePlayback } from './production-h264-policy.mjs';
import { mediaSnapshot, mediaDiagnostics } from './production-h264-snapshot.mjs';

function requiredEnvironment(name) {
    const value = process.env[name];
    if (!value) throw new Error(name + ' is required');
    return value;
}

function positiveInteger(name, fallback) {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(name + ' must be a positive integer');
    return value;
}

const reportFile = requiredEnvironment('PIXELSTREAM_SMOKE_REPORT');
const report = { schemaVersion: reportVersion, sourceCommit: process.env.PIXELSTREAM_SOURCE_COMMIT,
    browser: process.env.PIXELSTREAM_BROWSER, sessions: [], success: false };
class SmokeFailure extends Error {}
let driver;
let phase = 'configuration';
let browserName = process.env.PIXELSTREAM_BROWSER;
try {
browserName = requiredEnvironment('PIXELSTREAM_BROWSER');
const browsers = { chromium: 'chrome', firefox: 'firefox', safari: 'safari' };
if (!Object.hasOwn(browsers, browserName)) throw new Error('unsupported PIXELSTREAM_BROWSER');
const viewerUrl = requiredEnvironment('PIXELSTREAM_PRODUCTION_VIEWER_URL');
const sourceCommit = requiredEnvironment('PIXELSTREAM_SOURCE_COMMIT');
if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) throw new Error('PIXELSTREAM_SOURCE_COMMIT must be an exact Git commit');
const expected = {
    width: positiveInteger('PIXELSTREAM_EXPECTED_WIDTH', '3840'),
    height: positiveInteger('PIXELSTREAM_EXPECTED_HEIGHT', '2160'),
    seconds: positiveInteger('PIXELSTREAM_OBSERVE_SECONDS', '30'),
    minimumFps: positiveInteger('PIXELSTREAM_MINIMUM_FPS', '24')
};
if (expected.seconds < 30 || expected.minimumFps < 24) {
    throw new Error('the qualification gate requires at least thirty seconds and 24 fps');
}
const rejoins = positiveInteger('PIXELSTREAM_REJOINS', '2');
if (rejoins < 2) throw new Error('the qualification gate requires at least two rejoins');
const timeoutMs = positiveInteger('PIXELSTREAM_TIMEOUT_MS', '60000');

report.requirements = { ...expected, rejoins };


let builder = new Builder();
if (browserName === 'chromium') {
    const options = new chrome.Options().setPageLoadStrategy('eager')
        .addArguments('--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
            '--autoplay-policy=no-user-gesture-required');
    if (process.env.PIXELSTREAM_CHROME_BINARY) options.setChromeBinaryPath(process.env.PIXELSTREAM_CHROME_BINARY);
    builder = builder.forBrowser('chrome').setChromeOptions(options);
} else if (browserName === 'firefox') {
    const options = new firefox.Options().setPageLoadStrategy('eager').addArguments('-headless');
    if (process.env.PIXELSTREAM_FIREFOX_BINARY) options.setBinary(process.env.PIXELSTREAM_FIREFOX_BINARY);
    builder = builder.forBrowser('firefox').setFirefoxOptions(options);
} else {
    builder = builder.forBrowser('safari').setSafariOptions(new safari.Options().setPageLoadStrategy('eager'));
}

const snapshotScript = 'const done = arguments[arguments.length - 1]; (' +
    mediaSnapshot.toString() + ')().then(sample => done({sample}), error => done({error: error.message}));';

async function snapshot(driver) {
    const result = await driver.executeAsyncScript(snapshotScript);
    if (result.error) throw new SmokeFailure(result.error);
    return result.sample;
}

async function join(driver) {
    try {
        await driver.get('about:blank');
        await driver.get(viewerUrl);
    } catch {
        throw new SmokeFailure('browser navigation failed before opening the reference client');
    }
    const deadline = Date.now() + timeoutMs;
    let reason = 'media did not become ready';
    while (Date.now() < deadline) {
        for (const selector of ['#connectOverlay', '#playOverlay']) {
            for (const overlay of await driver.findElements(By.css(selector))) {
                if (await overlay.isDisplayed()) await overlay.click();
            }
        }
        const result = await driver.executeAsyncScript(snapshotScript);
        if (result.sample) return result.sample;
        reason = result.error;
        await driver.sleep(250);
    }
    throw new SmokeFailure(reason);
}

phase = 'driver startup';
    driver = await builder.build();
    await driver.manage().setTimeouts({ pageLoad: 10000, script: timeoutMs + 10000 });
    const capabilities = await driver.getCapabilities();
    report.capabilities = {
        browserName: capabilities.get('browserName'),
        browserVersion: capabilities.get('browserVersion'),
        platformName: capabilities.get('platformName')
    };
    if (report.capabilities.browserName?.toLowerCase() !== browsers[browserName] ||
        !report.capabilities.browserVersion) {
        throw new SmokeFailure('WebDriver did not identify the required browser and version');
    }
    for (let index = 0; index <= rejoins; index += 1) {
        phase = 'join ' + index;
        const session = { index };
        report.sessions.push(session);
        const before = await join(driver);
        session.before = before;
        try { requireMediaFormat(before, expected); } catch (error) { throw new SmokeFailure(error.message); }
        phase = 'sustained playback ' + index;
        await driver.sleep(expected.seconds * 1000);
        const after = await snapshot(driver);
        session.after = after;
        let result;
        try { result = requirePlayback(before, after, expected); } catch (error) { throw new SmokeFailure(error.message); }
        session.result = result;
        process.stdout.write(browserName + ': H264 UDP ' + expected.width + 'x' + expected.height +
            ', join ' + index + ', decoded +' + result.decoded + ', presented +' + result.presented +
            ', decoded audio samples +' + result.audioSamples + '\n');
    }
    report.success = true;
} catch (error) {
    if (driver) {
        try {
            report.diagnostics = await driver.executeAsyncScript(
                'const done = arguments[arguments.length - 1]; (' + mediaDiagnostics.toString() +
                ')().then(done, () => done({unavailable: true}));');
        } catch { report.diagnostics = { unavailable: true }; }
    }
    report.failure = {
        phase,
        message: error instanceof SmokeFailure ? error.message : phase + ' failed before media qualification'
    };
    process.stderr.write(browserName + ': ' + report.failure.message + '\n');
    process.exitCode = 1;
} finally {
    if (driver) {
        try { await driver.quit(); } catch {
            report.success = false;
            report.cleanupFailed = true;
            process.stderr.write(browserName + ': WebDriver cleanup failed\n');
            process.exitCode = 1;
        }
    }
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
}
