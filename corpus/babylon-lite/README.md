# Babylon Lite pinned corpus

These files are byte-identical scene inputs from:

- repository: `BabylonJS/Babylon-Lite`
- package: `@babylonjs/lite@1.25.0`
- source commit: `286525f8041dd9adc72b2c9962e8bff4d9aeb764`
- upstream path: `lab/lite/src`

The snapshot contains all 233 numbered scenes. The 157 registered curated
scenes and their SHA-256 hashes are recorded in
`upstream/babylon-lite-corpus.json`. The corpus is immutable evidence; update
it only as part of an explicit upstream-pin migration.

Shared modules reached by registered scenes are copied byte-identically and
hash-recorded in the same catalog, along with adopted upstream applications
and their complete reached file graphs.

## External golden applications

Any golden application temporarily copied here for an integration probe must
include its complete local TypeScript module graph and reached assets, copied
byte-for-byte from a recorded upstream commit and hash-checked before use.

Do not edit those files, including to work around an unsupported browser API
or compiler construct. Every golden must compile as written; all integration
changes belong in bblitec's compiler, lowerers, generated runtime, or PAL. A
snapshot may change only during an explicit upstream-pin migration that
updates its provenance and hashes together. A probe is not part of the
curated corpus unless it is deliberately adopted with durable provenance.

Babylon Lite is distributed under Apache License 2.0. See `LICENSE` and
`NOTICE.txt` in this directory.
