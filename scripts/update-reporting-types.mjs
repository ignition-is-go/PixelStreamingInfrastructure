import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
const source = 'https://github.com/ignition-is-go/pulse-reporting.git';
const packageName = '@ignition-is-go/pulse-reporting-types';
const mode = process.argv[2];
const checking = mode === '--check' || mode === '--check-source';
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
let revision = mode;
let expectedArchive;
if (checking) {
    const metadata = JSON.parse(readFileSync(join(vendor, 'pulse-reporting-types.source.json'), 'utf8'));
    if (metadata.source !== source || !/^[a-f0-9]{40}$/.test(metadata.revision)) {
        throw new Error('Reporting contract source must be the fixed repository and full revision');
    }
    revision = metadata.revision;
    expectedArchive = readFileSync(join(vendor, 'pulse-reporting-types.tgz'));
    if (createHash('sha256').update(expectedArchive).digest('hex') !== metadata.sha256) {
        throw new Error('Reporting contract archive checksum mismatch');
    }
    const manifest = JSON.parse(run('tar', ['-xOf', join(vendor, 'pulse-reporting-types.tgz'), 'package/package.json'], root));
    if (manifest.name !== packageName || manifest.version !== metadata.version || manifest.types !== './bindings/index.d.ts') {
        throw new Error('Reporting contract package identity does not match source metadata');
    }
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const entry = lock.packages[`node_modules/${packageName}`];
    const integrity = 'sha512-' + createHash('sha512').update(expectedArchive).digest('base64');
    if (entry.integrity !== integrity || entry.version !== metadata.version || entry.resolved !== 'file:vendor/pulse-reporting-types.tgz') {
        throw new Error('Reporting contract lockfile identity or integrity mismatch');
    }
    if (mode === '--check') process.exit(0);
}
if (!/^[a-f0-9]{40}$/.test(revision ?? '')) {
    throw new Error('Usage: node scripts/update-reporting-types.mjs <full-commit-sha>|--check|--check-source');
}
const temporary = mkdtempSync(join(tmpdir(), 'pulse-reporting-types-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
    const checkout = join(temporary, 'source');
    run('git', ['clone', '--filter=blob:none', '--no-checkout', source, checkout], temporary);
    run('git', ['checkout', '--detach', revision], checkout);
    if (run('git', ['rev-parse', 'HEAD'], checkout).trim() !== revision) {
        throw new Error('Contract checkout does not match requested revision');
    }
    run('cargo', ['run', '-p', 'export-types', '--locked', '--', '--check'], checkout);
    const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
    if (manifest.name !== packageName) throw new Error('Unexpected contract package');
    const [packed] = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], checkout));
    const archive = join(temporary, packed.filename);
    const bytes = readFileSync(archive);
    if (checking) {
        if (!bytes.equals(expectedArchive)) throw new Error('Reporting archive differs from verified generated source');
        console.log(`Verified generated reporting contracts at ${revision}`);
    } else {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        mkdirSync(vendor, { recursive: true });
        copyFileSync(archive, join(vendor, 'pulse-reporting-types.tgz'));
        writeFileSync(join(vendor, 'pulse-reporting-types.source.json'), JSON.stringify({ source, revision, version: manifest.version, sha256 }, null, 4) + '\n');
        const lockfile = join(root, 'package-lock.json');
        const lock = JSON.parse(readFileSync(lockfile, 'utf8'));
        delete lock.packages[`node_modules/${packageName}`];
        writeFileSync(lockfile, JSON.stringify(lock, null, 4) + '\n');
        run(npm, ['install', '--package-lock-only', '--ignore-scripts'], root);
        console.log(`Updated reporting contracts to ${revision} (${sha256})`);
    }
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
