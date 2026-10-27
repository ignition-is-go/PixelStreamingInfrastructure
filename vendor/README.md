# Reporting contracts

`pulse-reporting-types.tgz` is the npm package generated from the private
`ignition-is-go/pulse-reporting` repository. The accompanying source metadata
records its exact commit and SHA-256 checksum. npm's lockfile also pins the
archive integrity.

The SFU and signalling server use this package only during type checking.
Including the generated package here lets CI and container builds install it
without credentials for another private repository. Rust remains the source of
truth; do not edit or rebuild the declarations by hand.

To update it, use an account with read access to the source repository:

```sh
node scripts/update-reporting-types.mjs <full-commit-sha>
node scripts/update-reporting-types.mjs --check
node scripts/update-reporting-types.mjs --check-source
npm ci
npm test --workspace SFU
npm run build:cjs --workspace Common
npm test --workspace Signalling
```

Review and commit the archive, source metadata, and lockfile together. The
update script checks the shared Rust generator before packing its committed
declarations, without running npm lifecycle scripts. `--check` verifies archive
identity, SHA-256 and lockfile integrity offline. `--check-source` also checks out
the recorded source commit, runs its generator drift check and compares the
repacked archive. CI runs this source check with scoped read-only access;
container builds install only the checked-in archive and need no private credentials.
