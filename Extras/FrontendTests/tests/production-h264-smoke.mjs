import { Builder, By } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import firefox from 'selenium-webdriver/firefox.js';
import safari from 'selenium-webdriver/safari.js';

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
                    .setPageLoadStrategy('eager')
                    .addArguments('--headless=new')
                    .addArguments('--no-sandbox')
                    .addArguments('--disable-dev-shm-usage')
                    .addArguments('--autoplay-policy=no-user-gesture-required')
            );
        break;
    case 'firefox':
        builder = builder
            .forBrowser('firefox')
            .setFirefoxOptions(new firefox.Options().setPageLoadStrategy('eager').addArguments('-headless'));
        break;
    case 'safari':
        builder = builder
            .forBrowser('safari')
            .setSafariOptions(new safari.Options().setPageLoadStrategy('eager'));
        break;
    default: {
        const exhaustive = browserName;
        throw new Error(`Unsupported browser: ${exhaustive}`);
    }
}

let driver;
let phase = 'driver startup';
try {
    driver = await builder.build();
    await driver.manage().setTimeouts({ pageLoad: 10000, script: timeoutMs + 10000 });
    phase = 'viewer navigation';
    await driver.get('about:blank');
    await driver.executeScript((url) => window.location.assign(url), viewerUrl);

    phase = 'media discovery';
    const deadline = Date.now() + timeoutMs;
    const overlayClicks = { connect: 0, play: 0 };
    let navigationReached = false;
    let media;
    while (Date.now() < deadline) {
        navigationReached = (await driver.getCurrentUrl()) !== 'about:blank';
        for (const [kind, selector] of [
            ['connect', '#connectOverlay'],
            ['play', '#playOverlay']
        ]) {
            const overlays = await driver.findElements(By.css(selector));
            for (const overlay of overlays) {
                if (await overlay.isDisplayed()) {
                    await overlay.click();
                    overlayClicks[kind] += 1;
                }
            }
        }

        media = await driver.executeScript(() => {
            const elements = [...document.querySelectorAll('audio, video')];
            const streams = elements
                .map((element) => element.srcObject)
                .filter((stream) => stream instanceof MediaStream);
            const videoTracks = streams.flatMap((stream) => stream.getVideoTracks());
            const video = elements.find(
                (element) =>
                    element instanceof HTMLVideoElement &&
                    element.srcObject instanceof MediaStream &&
                    element.videoWidth > 0 &&
                    element.videoHeight > 0
            );
            return {
                width: video?.videoWidth ?? 0,
                height: video?.videoHeight ?? 0,
                readyState: document.readyState,
                bodyChildren: document.body?.childElementCount ?? 0,
                scripts: document.scripts.length,
                videoElements: elements.filter((element) => element instanceof HTMLVideoElement).length,
                attachedStreams: streams.length,
                liveVideoTracks: videoTracks.filter((track) => track.readyState === 'live').length,
                mutedVideoTracks: videoTracks.filter((track) => track.muted).length,
                audioTracks: streams
                    .flatMap((stream) => stream.getAudioTracks())
                    .filter((track) => track.readyState === 'live').length
            };
        });
        if (media.width > 0 && media.height > 0 && media.audioTracks > 0) break;
        await driver.sleep(250);
    }

    if (!media || media.width === 0 || media.height === 0) {
        const state = media ?? {
            videoElements: 0,
            readyState: 'missing',
            bodyChildren: 0,
            scripts: 0,
            attachedStreams: 0,
            liveVideoTracks: 0,
            mutedVideoTracks: 0,
            audioTracks: 0
        };
        throw new SmokeFailure(
            'no decoded production video appeared before the deadline; ' +
                `viewer navigation ${navigationReached ? 'reached' : 'not reached'}, ` +
                `document ${state.readyState}, body children ${state.bodyChildren}, scripts ${state.scripts}, ` +
                `video elements ${state.videoElements}, attached streams ${state.attachedStreams}, ` +
                `live video tracks ${state.liveVideoTracks}, muted video tracks ${state.mutedVideoTracks}, ` +
                `live audio tracks ${state.audioTracks}, connect clicks ${overlayClicks.connect}, ` +
                `play clicks ${overlayClicks.play}`
        );
    }
    if (media.audioTracks === 0) {
        throw new SmokeFailure('no live production audio track appeared before the deadline');
    }
    if (media.width !== expectedWidth || media.height !== expectedHeight) {
        throw new SmokeFailure(
            `expected ${expectedWidth}x${expectedHeight}, received ${media.width}x${media.height}`
        );
    }

    phase = 'media playback';
    const videos = await driver.findElements(By.css('video'));
    for (const video of videos) {
        if ((await video.isDisplayed()) && (await driver.executeScript((element) => element.paused, video))) {
            await video.click();
            break;
        }
    }

    phase = 'frame validation';
    const frames = await driver.executeAsyncScript(
        (timeout, done) => {
            const video = [...document.querySelectorAll('video')].find(
                (element) => element.srcObject && element.videoWidth > 0 && element.videoHeight > 0
            );
            if (!video || !('requestVideoFrameCallback' in video)) {
                done({ kind: 'failure', message: 'requestVideoFrameCallback is unavailable' });
                return;
            }

            const frameDeadline = Date.now() + timeout;
            const nextFrame = () =>
                new Promise((resolve, reject) => {
                    const remaining = Math.max(1, frameDeadline - Date.now());
                    const timer = setTimeout(() => reject(new Error('decoded frame timed out')), remaining);
                    video.requestVideoFrameCallback((_now, metadata) => {
                        clearTimeout(timer);
                        resolve({ mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
                    });
                });

            (async () => {
                const first = await nextFrame();
                let second = first;
                while (
                    Date.now() < frameDeadline &&
                    (second.presentedFrames <= first.presentedFrames || second.mediaTime <= first.mediaTime)
                ) {
                    second = await nextFrame();
                }
                done({ kind: 'success', first, second });
            })().catch((error) =>
                done({ kind: 'failure', message: error instanceof Error ? error.message : String(error) })
            );
        },
        Math.max(1000, deadline - Date.now())
    );

    if (frames.kind !== 'success') throw new SmokeFailure(frames.message);
    if (
        frames.second.presentedFrames <= frames.first.presentedFrames ||
        frames.second.mediaTime <= frames.first.mediaTime
    ) {
        throw new SmokeFailure('decoded video frames did not advance');
    }

    process.stdout.write(
        `${browserName}: decoded ${media.width}x${media.height}, ` +
            `frames +${frames.second.presentedFrames - frames.first.presentedFrames}, ` +
            `media +${(frames.second.mediaTime - frames.first.mediaTime).toFixed(3)}s, ` +
            `audio tracks ${media.audioTracks}\n`
    );
} catch (error) {
    const errorKind = error instanceof Error ? error.name : 'UnknownError';
    const message = error instanceof SmokeFailure ? error.message : `${phase} failed (${errorKind})`;
    process.stderr.write(`${browserName}: ${message}\n`);
    process.exitCode = 1;
} finally {
    if (driver) await driver.quit();
}
