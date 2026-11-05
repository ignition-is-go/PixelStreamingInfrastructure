const {Builder} = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const firefox = require('selenium-webdriver/firefox');

async function launchShipping(browserName) {
    let builder = new Builder().forBrowser(browserName === 'chromium' ? 'chrome' : browserName);
    if (browserName === 'chromium') {
        builder = builder.setChromeOptions(new chrome.Options()
            .addArguments('--headless=new', '--autoplay-policy=no-user-gesture-required'));
    } else if (browserName === 'firefox') {
        builder = builder.setFirefoxOptions(new firefox.Options().addArguments('-headless'));
    }
    const driver = await builder.build();
    try {
        await driver.manage().setTimeouts({script: 15000, pageLoad: 15000});
        await driver.get('about:blank');
        const capabilities = await driver.getCapabilities();
        return {
            version: () => capabilities.get('browserVersion'),
            newPage: async () => ({
                async evaluate(fn, argument) {
                    const result = await driver.executeAsyncScript(`
                        const argument = arguments[0];
                        const done = arguments[arguments.length - 1];
                        Promise.resolve().then(() => (${fn.toString()})(argument))
                            .then(value => done({ok: true, value}),
                                error => done({ok: false, error: String(error.message || error)}));
                    `, argument ?? null);
                    if (!result.ok) throw new Error(result.error);
                    return result.value;
                }
            }),
            close: () => driver.quit()
        };
    } catch (error) {
        await driver.quit();
        throw error;
    }
}

module.exports = {launchShipping};
