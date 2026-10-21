# Luvion receive-configuration example

This is the contract used by the public Luvion Console's receive-configuration
example, with a standalone test runner and a real Safe 1.5.0 comparison.
It is a source-inspection sample, not the full Luvion product or a production SDK.
Try the [browser demo](https://luvion-product-demo.onrender.com/bridge).
You can read every file here directly on GitHub; no download, wallet connection
or installation is needed to inspect the implementation.

This repository publishes selected source for reading, not an open-source
license or the full Luvion product. See the rights notice below before copying
or running the code. The instructions document how we reproduce the tests.

## Maintainer reproduction

These commands describe our test procedure, not a grant of usage rights.
For external evaluation permissions, contact Kevin@luvion.dev.

Requirements: Node.js 22.13+ and npm. No Rust toolchain, wallet, API token,
production credentials or public-chain RPC is required. Internet access is
needed to install the pinned npm dependencies. Tests start their own loopback
Hardhat chain with disposable, publicly known test keys. Never fund those keys.

```sh
git clone https://github.com/LuvionLabs/luvion-config-example.git
cd luvion-config-example
npm ci --ignore-scripts
node review/check.mjs
```

The runner compiles the supplied contracts, starts a new local chain, runs the
checks, writes `artifacts/review-report.json`, and stops the chain. A failed
assertion exits nonzero. No external RPC can be supplied to the runner. Test-only
time travel skips the 60-second delay locally; the public client does not skip it.

## What to inspect

- `contracts/LuvionConfigGate.sol`: exact configuration digest, named issuer and
  operator approval, local attester, delay, baseline check, replay and cancellation.
- `contracts/LuvionClientConfigGate.sol`: the hosted client's pre-schedule revocation.
- `contracts/Fixtures.sol`: unchanged upstream imports and synthetic fixtures.
- `review/check.mjs`: missing-party, changed-payload, timing, replay, cancellation,
  old-delegate and normal execution checks. Unexpected transport errors fail a test.
- `REFERENCE-REPORT.json`: our recorded test run and source SHA-256 hashes; compare contract hashes
  with the build hashes in exported public-demo evidence. Matching hashes are not
  an independent attestation of the hosted binary or deployment.

## The Safe comparison is intentionally fair

The runner deploys the actual pinned Safe contracts as a 2-of-2 Safe owned by the
issuer and operator. It demonstrates that Safe also rejects a missing signature
and changed calldata, and executes a valid change. Both parties can jointly
control this simple case with Safe alone. This sample does NOT establish that
Luvion is more secure, cheaper, or needed for that case.

The Luvion fixture adds a fixed configuration policy, a local-attester requirement
and a delay; the bare Safe baseline does not include guards/modules/timelocks.
That is a comparison boundary, not a missing capability claim about the Safe
ecosystem. Integration effort and operating cost have not been measured here.

## Important limitations

The standalone runner uses a SYNTHETIC ECDSA attestation. It does not run or prove
Luvion's FROST signing, authenticated API, role policy, evidence chain or browser.
The hosted demo separately runs controlled same-host FROST. Its Gate verifies
the local attester and business signatures, not the FROST certificate directly.
All demo identities are controlled on one host, not by independent institutions.

Only the fixed receive configuration is exercised. There are no cross-chain
messages, token transfers, customer integrations or real assets. The Gate is a
local prototype without production key rotation/recovery, a security audit or
exhaustive bypass review. LayerZero's effective readback normalizes the optional
DVN sentinel; tests compare decoded effective values, not raw submitted bytes.

One test deliberately demonstrates a migration gap: transferring OApp ownership
does NOT revoke the previous Endpoint delegate. The old delegate still works
before `activate()` replaces it. Do not copy this non-atomic migration to production.

To report an issue, include the changed test, expected result and actual output.
Do not test against other visitors' hosted sessions or any production deployment.
No bounty, audit engagement or reward is offered by this example.

Dependency scan on 2026-10-21: npm audit reported 15 low-severity affected package
entries (zero moderate/high/critical), including the transitive elliptic advisory
GHSA-848j-6mx2-7j84 through the upstream LayerZero/ethers-v5 dependency tree.
These are not 15 independently discovered contract vulnerabilities. The pinned
tree is retained for reproduction; do not treat it as a production-approved tree.
Run `npm audit` again when evaluating the dependencies, since advisories can change.

## Source and licensing

Only this selected sample is published for source reading. The parent repository,
core Rust implementation and server remain private. Luvion-authored contracts
retain their UNLICENSED SPDX markers. No open-source license or additional right
to use, modify, distribute or commercially deploy Luvion-authored code is granted
by this publication. Contact Kevin@luvion.dev to discuss evaluation permissions.
Upstream dependencies retain their respective licenses. Do not describe this
repository as the full product's open-source release. See RIGHTS.md.
