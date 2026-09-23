# Babylon Lite Native

`bblitec` compiles a bounded Babylon Lite TypeScript subset to C++20.
Assets/shaders are generated; state, input, animation and rendering run natively on SDL3, SDL_GPU and Dawn.

| [<img src="docs/images/scenes/scene1.png" alt="BoomBox" width="170">](docs/status.md#curated-parity-scenes) | [<img src="docs/images/scenes/scene14.png" alt="Flight Helmet" width="170">](docs/status.md#curated-parity-scenes) | [<img src="docs/images/scenes/sandblox.png" alt="Sandblox" width="170">](docs/status.md#upstream-application-gates) | [<img src="docs/images/scenes/minecraft.png" alt="Voxel Sandbox" width="170">](docs/status.md#upstream-application-gates) |
| :-: | :-: | :-: | :-: |
| [<img src="docs/images/scenes/doom.png" alt="Doom" width="170">](docs/status.md#upstream-application-gates) | [<img src="docs/images/scenes/racer.png" alt="Racer" width="170">](docs/status.md#upstream-application-gates) | [<img src="docs/images/scenes/quake.png" alt="LibreQuake" width="170">](docs/status.md#upstream-application-gates) | [<img src="docs/images/scenes/freeciv.png" alt="Freeciv" width="170">](docs/status.md#upstream-application-gates) |

Source/package pin: [upstream/babylon-lite.json](upstream/babylon-lite.json).

## Quick start

```powershell
npm ci
npm run dev:setup
npm run doctor
npm run scene -- process scene1
npm run scene -- parity scene1 --differential
```

See [development](docs/development.md#setup) for Windows, Linux and macOS prerequisites
and the Windows CMake path. A built scene requires a GPU.
Build and package Android APKs with the [Android workflow](docs/development.md#android).
iOS app bundles use the [iOS workflow](docs/development.md#ios).

## Documentation

Canonical facts and current state. One owner per fact; no session logs.

| Page | Owns |
| --- | --- |
| [Repository instructions](.github/copilot-instructions.md) | Working rules |
| [Architecture](docs/architecture.md) | Pipeline, code ownership and memory |
| [Features](docs/features.md) | Supported source surface; capability gaps (Limits) |
| [Development](docs/development.md) | Setup, commands, builds and validation |
| [Debugging](docs/debugging.md) | Diagnosis, capture tools and observation limits |
| [Fidelity](docs/fidelity.md) | Source/native adaptations and semantic boundaries |
| [Backends](docs/backends.md) | GPU resource/binding/encoding implementation |
| [UI](docs/ui.md) | DOM/CSS/Canvas2D support, limits and browser compatibility |
| [Status](docs/status.md) | Published measurements and scene previews |
| [TODO](TODO.md) | Internal work, qualification, performance and refusal defects |
| [Audit](audit.md) | Open audit findings |

## Acknowledgements

This project is not affiliated with or endorsed by Babylon.js. Babylon Lite and
third-party libraries/assets retain their licenses and attribution; see packaged
notices.
