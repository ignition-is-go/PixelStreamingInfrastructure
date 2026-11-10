import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

for (const [name, overrides] of [
    ['missing browser configuration', { PIXELSTREAM_BROWSER: '' }],
    ['one rejoin', { PIXELSTREAM_REJOINS: '1' }]
]) {
    test('records failed qualification for ' + name, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'media-gate-config-'));
        try {
            const reportFile = path.join(directory, 'report.json');
            const result = spawnSync(process.execPath, ['tests/production-h264-smoke.mjs'], {
                cwd: new URL('..', import.meta.url),
                env: { ...process.env, PIXELSTREAM_BROWSER: 'chromium',
                    PIXELSTREAM_PRODUCTION_VIEWER_URL: 'http://127.0.0.1/',
                    PIXELSTREAM_SOURCE_COMMIT: 'a'.repeat(40), PIXELSTREAM_SMOKE_REPORT: reportFile,
                    ...overrides }
            });
            assert.equal(result.status, 1);
            const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
            assert.equal(report.schemaVersion, 2);
            assert.equal(report.success, false);
            assert.equal(report.failure.phase, 'configuration');
            assert.equal(report.sessions.length, 0);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
