import { Builder } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import firefox from 'selenium-webdriver/firefox.js';

const browserNames = new Set(['chromium', 'firefox', 'safari']);

function requiredEnvironment(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function positiveInteger(name, fallback) {
    const raw = process.env[name] ?? fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

const browserName = requiredEnvironment('PIXELSTREAM_BROWSER');
if (!browserNames.has(browserName)) {
    throw new Error('PIXELSTREAM_BROWSER must be chromium, firefox, or safari');
}

const viewerUrl = requiredEnvironment('PIXELSTREAM_PRODUCTION_VIEWER_URL');
const expectedWidth = positiveInteger('PIXELSTREAM_EXPECTED_WIDTH', '3840');
const expectedHeight = positiveInteger('PIXELSTREAM_EXPECTED_HEIGHT', '2160');
const timeoutMs = positiveInteger('PIXELSTREAM_TIMEOUT_MS', '60000');

class SmokeFailure extends Error {}

let builder = new Builder();
switch (browserName) {
    case 'chromium':
        builder = builder
            .forBrowser('chrome')
            .setChromeOptions(
                new chrome.Options()
                    .addArguments('--headless=new')
                    .addArguments('--no-sandbox')
                    .addArguments('--disable-dev-shm-usage')
                    .addArguments('--autoplay-policy=no-user-gesture-required')
            );
        break;
    case 'firefox':
        builder = builder
            .forBrowser('firefox')
            .setFirefoxOptions(new firefox.Options().addArguments('-headless'));
        break;
    case 'safari':
        builder = builder.forBrowser('safari');
        break;
    default: {
        const exhaustive = browserName;
        throw new Error(`Unsupported browser: ${exhaustive}`);
    }
}

builder = builder.setCapability('pageLoadStrategy', 'eager');

let driver;
try {
    driver = await builder.build();
    await driver.manage().setTimeouts({ pageLoad: timeoutMs, script: timeoutMs + 10000 });
    await driver.get(viewerUrl);

    const result = await driver.executeAsyncScript(
        (width, height, timeout, done) => {
            const deadline = Date.now() + timeout;

            const fail = (message) => done({ kind: 'failure', message });
            const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
            const findVideo = () =>
                [...document.querySelectorAll('video')].find(
                    (video) => video.srcObject && video.videoWidth > 0 && video.videoHeight > 0
                );
            const audioTrackCount = () =>
                [...document.querySelectorAll('audio, video')]
                    .map((element) => element.srcObject)
                    .filter((stream) => stream instanceof MediaStream)
                    .flatMap((stream) => stream.getAudioTracks())
                    .filter((track) => track.readyState === 'live').length;

            const nextFrame = (video) =>
                new Promise((resolve, reject) => {
                    if (!('requestVideoFrameCallback' in video)) {
                        reject(new Error('requestVideoFrameCallback is unavailable'));
                        return;
                    }
                    const timer = setTimeout(() => reject(new Error('decoded frame timed out')), timeout);
                    video.requestVideoFrameCallback((_now, metadata) => {
                        clearTimeout(timer);
                        resolve({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
                    });
                });

            (async () => {
                let video;
                while (Date.now() < deadline) {
                    video = findVideo();
                    if (video && audioTrackCount() > 0) break;
                    await wait(250);
                }
                if (!video) return fail('no decoded production video appeared before the deadline');
                if (audioTrackCount() === 0)
                    return fail('no live production audio track appeared before the deadline');
                if (video.videoWidth !== width || video.videoHeight !== height) {
                    return fail(
                        `expected ${width}x${height}, received ${video.videoWidth}x${video.videoHeight}`
                    );
                }

                await video.play();
                const first = await nextFrame(video);
                const second = await nextFrame(video);
                if (second.presentedFrames <= first.presentedFrames || second.mediaTime <= first.mediaTime) {
                    return fail('decoded video frames did not advance');
                }

                done({
                    kind: 'success',
                    width: video.videoWidth,
                    height: video.videoHeight,
                    frameDelta: second.presentedFrames - first.presentedFrames,
                    mediaTimeDelta: second.mediaTime - first.mediaTime,
                    audioTracks: audioTrackCount()
                });
            })().catch((error) => fail(error instanceof Error ? error.message : String(error)));
        },
        expectedWidth,
        expectedHeight,
        timeoutMs
    );

    if (result.kind !== 'success') throw new SmokeFailure(result.message);
    process.stdout.write(
        `${browserName}: decoded ${result.width}x${result.height}, ` +
            `frames +${result.frameDelta}, media +${result.mediaTimeDelta.toFixed(3)}s, ` +
            `audio tracks ${result.audioTracks}\n`
    );
} catch (error) {
    const message =
        error instanceof SmokeFailure ? error.message : 'browser automation failed before decode validation';
    process.stderr.write(`${browserName}: ${message}\n`);
    process.exitCode = 1;
} finally {
    if (driver) await driver.quit();
}
