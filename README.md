# Babylon Lite Native

`bblitec` compiles a bounded, reachable subset of Babylon Lite TypeScript into
C++20. Assets and shaders materialize during generation; scene state, input,
animation and rendering remain native through SDL3, SDL_GPU and Dawn.

The supported package/source commit is defined in
[upstream/babylon-lite.json](upstream/babylon-lite.json).

## Quick start

```powershell
npm ci
npm run dev:setup
npm run doctor
npm run scene -- process scene1
npm run scene -- parity scene1 --differential
```

See [development](docs/development.md#setup) for prerequisites and the Windows
CMake path. A built scene requires a GPU.

## Documentation

Read these canonical pages before feature work. Each fact has one owner; link
to that page instead of repeating its content.

| Page | Owns |
| --- | --- |
| [Repository instructions](.github/copilot-instructions.md) | Working rules |
| [Architecture](docs/architecture.md) | Pipeline, code ownership and memory |
| [Features](docs/features.md) | Supported source surface and admission limits |
| [Development](docs/development.md) | Setup, commands, builds and validation |
| [Debugging](docs/debugging.md) | Diagnosis, capture tools and observation limits |
| [Fidelity](docs/fidelity.md) | Source/native adaptations and semantic boundaries |
| [Backends](docs/backends.md) | GPU resource/binding/encoding implementation |
| [UI](docs/ui.md) | DOM/CSS/Canvas2D support and browser compatibility |
| [Status](docs/status.md) | Published measurements and scene previews |
| [TODO](TODO.md) | Unfinished work |
| [Audit](audit.md) | Verified findings and their status |

## Acknowledgements

This project is not affiliated with or endorsed by Babylon.js. Babylon Lite and
third-party libraries/assets retain their licenses and attribution; see packaged
notices.
