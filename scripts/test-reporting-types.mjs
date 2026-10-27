import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = mkdtempSync(join(tmpdir(), 'reporting-check-'));
try {
    mkdirSync(join(stage, 'scripts'));
    cpSync(join(root, 'scripts/update-reporting-types.mjs'), join(stage, 'scripts/update-reporting-types.mjs'));
    cpSync(join(root, 'vendor'), join(stage, 'vendor'), { recursive: true });
    cpSync(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));
    const check = () => spawnSync(process.execPath, ['scripts/update-reporting-types.mjs', '--check'], { cwd: stage, encoding: 'utf8' });
    assert.equal(check().status, 0);
    const metadataPath = join(stage, 'vendor/pulse-reporting-types.source.json');
    const metadata = readFileSync(metadataPath, 'utf8');
    for (const [key, value] of [['source', 'https://example.invalid/contracts'], ['revision', 'main'], ['version', '9.9.9'], ['sha256', '0'.repeat(64)]]) {
        writeFileSync(metadataPath, JSON.stringify({ ...JSON.parse(metadata), [key]: value }));
        assert.notEqual(check().status, 0, `accepted changed ${key}`);
    }
    writeFileSync(metadataPath, metadata);
    const lockPath = join(stage, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/@ignition-is-go/pulse-reporting-types'].integrity = 'sha512-wrong';
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.notEqual(check().status, 0, 'accepted changed lock integrity');
    console.log('PASS reporting archive source, version, checksum and lock guards');
} finally {
    rmSync(stage, { recursive: true, force: true });
}
