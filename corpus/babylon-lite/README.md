# Babylon Lite pinned corpus

These files are byte-identical scene inputs from:

- repository: `BabylonJS/Babylon-Lite`
- package: `@babylonjs/lite@1.24.0`
- source commit: `5866c28478c137abcd33f315c8eed5cea8664598`
- upstream path: `lab/lite/src`

The snapshot contains all 233 numbered scenes. The 58 registered curated
scenes and their SHA-256 hashes are recorded in
`upstream/babylon-lite-scenes.json`. The corpus is immutable evidence; update
it only as part of an explicit upstream-pin migration.

Shared modules reached by registered scenes are copied byte-identically and
hash-recorded in the same manifest.

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
