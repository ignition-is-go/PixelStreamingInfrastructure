import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
const revision = process.argv[2];
if (revision === '--check') {
    const metadata = JSON.parse(readFileSync(join(vendor, 'pulse-reporting-types.source.json'), 'utf8'));
    const archive = readFileSync(join(vendor, 'pulse-reporting-types.tgz'));
    const actual = createHash('sha256').update(archive).digest('hex');
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
    if (lock.packages['node_modules/@ignition-is-go/pulse-reporting-types'].integrity !== integrity) {
        throw new Error('Reporting contract lockfile integrity mismatch');
    }
    if (actual !== metadata.sha256) throw new Error('Reporting contract archive checksum mismatch');
    process.exit(0);
}
if (!/^[a-f0-9]{40}$/.test(revision ?? '')) {
    throw new Error('Usage: node scripts/update-reporting-types.mjs <full-commit-sha>');
}
const source = 'https://github.com/ignition-is-go/pulse-reporting.git';
const temporary = mkdtempSync(join(tmpdir(), 'pulse-reporting-types-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
try {
    const checkout = join(temporary, 'source');
    run('git', ['clone', '--filter=blob:none', '--no-checkout', source, checkout], temporary);
    run('git', ['checkout', '--detach', revision], checkout);
    const actual = run('git', ['rev-parse', 'HEAD'], checkout).trim();
    if (actual !== revision) throw new Error('Contract checkout does not match requested revision');
    const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
    if (manifest.name !== '@ignition-is-go/pulse-reporting-types') throw new Error('Unexpected contract package');
    const [packed] = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], checkout));
    const archive = join(temporary, packed.filename);
    const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
    mkdirSync(vendor, { recursive: true });
    copyFileSync(archive, join(vendor, 'pulse-reporting-types.tgz'));
    writeFileSync(join(vendor, 'pulse-reporting-types.source.json'), JSON.stringify({ source, revision, version: manifest.version, sha256 }, null, 4) + '\n');
    const lockfile = join(root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockfile, 'utf8'));
    delete lock.packages['node_modules/@ignition-is-go/pulse-reporting-types'];
    writeFileSync(lockfile, JSON.stringify(lock, null, 4) + '\n');
    run(npm, ['install', '--package-lock-only', '--ignore-scripts'], root);
    console.log(`Updated reporting contracts to ${revision} (${sha256})`);
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
