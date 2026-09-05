# Pinned Babylon Lite corpus

Scene and application inputs come from `BabylonJS/Babylon-Lite`. The package
and commit are recorded once in [the upstream pin](../../upstream/babylon-lite.json).
[The corpus catalog](../../upstream/babylon-lite-corpus.json) records every
adopted or staged file, its origin and SHA-256; `npm run corpus:verify` checks
the catalog. [Status](../../docs/status.md) lists the integrated gates.

These files are immutable evidence. Fix integrations in the compiler,
lowerers, generated runtime or PAL. An explicit upstream migration updates
the source graph and hashes together. An external integration probe must
likewise preserve its complete reached source/assets graph and pinned origin.

Babylon Lite is Apache-2.0; see `LICENSE` and `NOTICE.txt`. Third-party assets
retain their recorded licenses and attribution.
