# Babylon Lite Native

`bblitec` compiles a reachable, statically analyzable subset of Babylon Lite
TypeScript into C++20, with SDL3 platform services and SDL_GPU/Dawn renderers.
It materializes assets and composes shaders during generation, while native
scene state, input, animation and draw submission remain live.

The [upstream pin](upstream/babylon-lite.json) names the supported package and
commit. This is a bounded compiler, not a general JavaScript runtime.
[Features](docs/features.md) defines support and
[fidelity](docs/fidelity.md) records intentional adaptations.

| [<img src="docs/images/scenes/scene1.png" alt="BoomBox" width="170">](docs/status.md#curated-parity-scenes) | [<img src="docs/images/scenes/scene14.png" alt="Flight Helmet" width="170">](docs/status.md#curated-parity-scenes) | [<img src="docs/images/scenes/sandblox.png" alt="Sandblox" width="170">](docs/status.md#upstream-application-gates) | [<img src="docs/images/scenes/minecraft.png" alt="Voxel Sandbox" width="170">](docs/status.md#upstream-application-gates) |
| :-: | :-: | :-: | :-: |
| [<img src="docs/images/scenes/doom.png" alt="Doom" width="170">](docs/status.md#upstream-application-gates) | [<img src="docs/images/scenes/racer.png" alt="Racer" width="170">](docs/status.md#upstream-application-gates) | [<img src="docs/images/scenes/quake.png" alt="LibreQuake" width="170">](docs/status.md#upstream-application-gates) | [<img src="docs/images/scenes/freeciv.png" alt="Freeciv" width="170">](docs/status.md#upstream-application-gates) |

Click a frame for the published measurements. Both GPU backends must pass a
scene's gates; image agreement does not establish complete language coverage.

## Quick start

Install the prerequisites in [development](docs/development.md), including
Node.js, native build tools and a WebGPU browser. A built scene requires a GPU.

```powershell
git clone https://github.com/sailro/bblitec.git
cd bblitec
npm ci
npm run dev:setup
npm run doctor
npm run scene -- process scene1
npm run scene -- parity scene1 --differential
```

`process` generates code/assets, compiles scene-local shaders and builds native
code. The same command accepts an unregistered repository-local TypeScript
path. Build configuration, minimal packages and the full validation workflow
are documented once in development.

## Documentation

Read these pages before feature work in a fresh session:

| Page | Owns |
| --- | --- |
| [Repository instructions](.github/copilot-instructions.md) | Working rules |
| [Architecture](docs/architecture.md) | Pipeline, source ownership and memory model |
| [Features](docs/features.md) | Supported surface and feature activation |
| [Development](docs/development.md) | Setup, commands, builds and validation |
| [Debugging](docs/debugging.md) | Scene analysis and diagnostic ladder |
| [Fidelity](docs/fidelity.md) | Adaptations and source/native contracts |
| [Backends](docs/backends.md) | GPU implementation and binding boundaries |
| [UI](docs/ui.md) | Retained DOM/CSS/Canvas2D compatibility |
| [Status](docs/status.md) | Published measurements |
| [TODO](TODO.md) | Unfinished capabilities and maintenance |
| [Audit](audit.md) | Current audit defects, fixes and evidence |

## Acknowledgements

This project is not affiliated with or endorsed by Babylon.js. Babylon Lite
and third-party libraries/assets retain their respective licenses and
attribution; see the repository and packaged notices.
