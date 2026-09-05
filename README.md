# RmlUi reduced-case comparison images

These images support [RmlUi #1003](https://github.com/mikke89/RmlUi/issues/1003), [#1004](https://github.com/mikke89/RmlUi/issues/1004), and [#1005](https://github.com/mikke89/RmlUi/issues/1005). The issue bodies contain the reduced examples, numeric results, source links, and limitations. Captured September 5, 2026.

- `browser/`: actual Chrome screenshots of equivalent HTML/CSS specimens.
- `unpatched/` and `patched/`: diagnostic views reconstructed from recorded RmlUi flat-color triangles and monochrome glyph atlases. These are **not native GPU screenshots**.
- RmlUi baseline: clean isolated build of `b7b4a0688262832eacf3b9abb41f8bbe73868af8`. Both native variants use Windows clang-cl Release and Segoe UI at 16 px.
- The patched variant applies fractional letter-spacing preservation, the two discussed box-model changes, and corrected premultiplied alpha rounding. The recorded native library SHA-256 is `ccde722911d18201d231d1ec3b040f4dd58de4b61a5362bdeaa440004d04cd27`; unpatched is `f3e233dc6843c468e9dac8c9fbcae892b382137e0caaa7ccc64e3eed992cc8b7`.
- JPEG illustrations are for geometry and qualitative appearance, not one-byte color comparisons. The spacing rows are 0px, 0.25px, -0.25px, and 2.5px. Baseline font metrics differ between Chrome and RmlUi, so compare spacing deltas.
- There is no corrected rounding-only visual A/B here; [#1006](https://github.com/mikke89/RmlUi/issues/1006) records arithmetic evidence separately.

AI helped investigate and prepare these reduced cases. The author supervised and personally verified the original application behavior; the newer automated checks are identified separately in the issues.
