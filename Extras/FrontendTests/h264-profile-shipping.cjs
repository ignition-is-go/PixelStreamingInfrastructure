const {Builder} = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const firefox = require('selenium-webdriver/firefox');
const {createServer} = require('node:http');

async function launchShipping(browserName) {
    let builder = new Builder().forBrowser(browserName === 'chromium' ? 'chrome' : browserName);
    if (browserName === 'chromium') {
        builder = builder.setChromeOptions(new chrome.Options()
            .addArguments('--headless=new', '--autoplay-policy=no-user-gesture-required'));
    } else if (browserName === 'firefox') {
        builder = builder.setFirefoxOptions(new firefox.Options().addArguments('-headless'));
    }
    const driver = await builder.build();
    const server = createServer((_request, response) => {
        response.writeHead(200, {'Content-Type': 'text/html'});
        response.end('<!doctype html><html><body></body></html>');
    });
    async function close() {
        try { await driver.quit(); }
        finally { await new Promise(resolve => server.close(resolve)); }
    }
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        await driver.manage().setTimeouts({script: 15000, pageLoad: 15000});
        await driver.get(`http://127.0.0.1:${server.address().port}/`);
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
            close
        };
    } catch (error) {
        await close();
        throw error;
    }
}

module.exports = {launchShipping};
