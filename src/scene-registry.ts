export interface SceneParityDefinition {
    reference: { kind: "source"; path: string };
    referenceTimeSeconds?: number;
    actual: string;
    outputDirectory: string;
    maxFullMad?: number;
    maxForegroundMad?: number;
    cpuThresholds?: { maxFullMad: number; maxForegroundMad: number };
    backgroundColor: [number, number, number];
    backgroundThreshold: number;
    nativeEnvironment?: Record<string, string>;
    attribution?: {
        specialization: string;
        drawIds: boolean;
        triangleClusters: boolean;
        diagnostics: boolean;
    };
}

export interface SceneDefinition {
    id: string;
    name: string;
    source: string;
    output: string;
    title: string;
    buildDirectory: string;
    parity?: SceneParityDefinition;
}

export const scenes: readonly SceneDefinition[] = [
    {
        id: "primitives",
        name: "Primitives",
        source: "examples/primitives.ts",
        output: "generated/primitives",
        title: "Babylon Lite Native",
        buildDirectory: "native/build-sdl",
    },
    {
        id: "boombox",
        name: "BoomBox PBR",
        source: "examples/boombox.ts",
        output: "generated/boombox",
        title: "Babylon Lite Native - BoomBox",
        buildDirectory: "native/build-boombox-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/boombox/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/boombox-gpu.png",
            outputDirectory: "artifacts/parity",
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            cpuThresholds: { maxFullMad: 2.2, maxForegroundMad: 21.5 },
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/boombox/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
                diagnostics: true,
            },
        },
    },
    {
        id: "scene8",
        name: "Scene 8 - HDR Glass Sphere",
        source: "examples/scene8-hdr-glass.ts",
        output: "generated/scene8",
        title: "Babylon Lite Native - HDR Glass Sphere",
        buildDirectory: "native/build-scene8-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene8/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene8-native.png",
            outputDirectory: "artifacts/parity/scene8",
            maxFullMad: 0.2,
            maxForegroundMad: 0.2,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene5",
        name: "Scene 5 - Alien Morph and Skeleton",
        source: "examples/scene5-alien.ts",
        output: "generated/scene5",
        title: "Babylon Lite Native - Alien",
        buildDirectory: "native/build-scene5-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene5/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 2,
            actual: "artifacts/parity/scene5-native.png",
            outputDirectory: "artifacts/parity/scene5",
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "2",
            },
        },
    },
    {
        id: "scene10",
        name: "Scene 10 - PBR Rough Sphere",
        source: "examples/scene10-pbr-rough.ts",
        output: "generated/scene10",
        title: "Babylon Lite Native - PBR Rough Sphere",
        buildDirectory: "native/build-scene10-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene10/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene10-native.png",
            outputDirectory: "artifacts/parity/scene10",
            maxFullMad: 0.03,
            maxForegroundMad: 0.25,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene13",
        name: "Scene 13 - PBR Spheres Grid",
        source: "examples/scene13-pbr-spheres.ts",
        output: "generated/scene13",
        title: "Babylon Lite Native - PBR Spheres Grid",
        buildDirectory: "native/build-scene13-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene13/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene13-native.png",
            outputDirectory: "artifacts/parity/scene13",
            maxFullMad: 0.02,
            maxForegroundMad: 0.1,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene13/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
                diagnostics: true,
            },
        },
    },
    {
        id: "scene32",
        name: "Scene 32 - Unlit glTF",
        source: "examples/scene32-unlit.ts",
        output: "generated/scene32",
        title: "Babylon Lite Native - Unlit glTF",
        buildDirectory: "native/build-scene32-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene32/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene32-native.png",
            outputDirectory: "artifacts/parity/scene32",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene32/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
                diagnostics: false,
            },
        },
    },
    {
        id: "scene163",
        name: "Scene 163 - Shader Alpha Cutout",
        source: "examples/scene163-shader-alpha-cutout.ts",
        output: "generated/scene163",
        title: "Babylon Lite Native - Shader Alpha Cutout",
        buildDirectory: "native/build-scene163-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene163/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene163-native.png",
            outputDirectory: "artifacts/parity/scene163",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene163/upstream/gltf-specialization.json",
                drawIds: false,
                triangleClusters: false,
                diagnostics: false,
            },
        },
    },
    {
        id: "scene168",
        name: "Scene 168 - Mirrored Double-Sided Winding",
        source: "examples/scene168-mirrored-winding.ts",
        output: "generated/scene168",
        title: "Babylon Lite Native - Mirrored Double-Sided Winding",
        buildDirectory: "native/build-scene168-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene168/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene168-native.png",
            outputDirectory: "artifacts/parity/scene168",
            maxFullMad: 0.08,
            maxForegroundMad: 0.45,
            backgroundColor: [13, 15, 23],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene168/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
                diagnostics: false,
            },
        },
    },
    {
        id: "transmission-skybox",
        name: "Transmission Gate - PBR Skybox Mode",
        source: "examples/transmission-skybox-gate.ts",
        output: "generated/transmission-skybox",
        title: "Babylon Lite Native - PBR Skybox Mode",
        buildDirectory: "native/build-transmission-skybox-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/transmission-skybox/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/transmission-skybox-native.png",
            outputDirectory: "artifacts/parity/transmission-skybox",
            maxFullMad: 0.2,
            maxForegroundMad: 0.3,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "transmission-scene-color",
        name: "Transmission Gate - Scene Color",
        source: "examples/transmission-scene-color-gate.ts",
        output: "generated/transmission-scene-color",
        title: "Babylon Lite Native - Scene Color Transmission",
        buildDirectory: "native/build-transmission-scene-color-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/transmission-scene-color/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/transmission-scene-color-native.png",
            outputDirectory: "artifacts/parity/transmission-scene-color",
            maxFullMad: 0.1,
            maxForegroundMad: 0.3,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "transmission-ior",
        name: "Transmission Gate - IOR",
        source: "examples/transmission-ior-gate.ts",
        output: "generated/transmission-ior",
        title: "Babylon Lite Native - Transmission IOR",
        buildDirectory: "native/build-transmission-ior-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/transmission-ior/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/transmission-ior-native.png",
            outputDirectory: "artifacts/parity/transmission-ior",
            maxFullMad: 0.2,
            maxForegroundMad: 0.4,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "transmission-volume",
        name: "Transmission Gate - Volume",
        source: "examples/transmission-volume-gate.ts",
        output: "generated/transmission-volume",
        title: "Babylon Lite Native - Transmission Volume",
        buildDirectory: "native/build-transmission-volume-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/transmission-volume/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/transmission-volume-native.png",
            outputDirectory: "artifacts/parity/transmission-volume",
            maxFullMad: 0.25,
            maxForegroundMad: 0.6,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene176",
        name: "Scene 176 - Mosquito In Amber",
        source: "examples/scene176-mosquito-in-amber.ts",
        output: "generated/scene176",
        title: "Babylon Lite Native - Mosquito In Amber",
        buildDirectory: "native/build-scene176-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene176/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene176-native.png",
            outputDirectory: "artifacts/parity/scene176",
            maxFullMad: 0.5,
            maxForegroundMad: 0.5,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene176/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
                diagnostics: false,
            },
        },
    },
    {
        id: "scene213",
        name: "Scene 213 - Grid Material Ordering",
        source: "examples/scene213-grid-material.ts",
        output: "generated/scene213",
        title: "Babylon Lite Native - Grid Material Ordering",
        buildDirectory: "native/build-scene213-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene213/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene213-native.png",
            outputDirectory: "artifacts/parity/scene213",
            maxFullMad: 0.001,
            maxForegroundMad: 0.02,
            backgroundColor: [20, 20, 28],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene240",
        name: "Scene 240 - Animated Triangle",
        source: "examples/scene240-animated-triangle.ts",
        output: "generated/scene240",
        title: "Babylon Lite Native - Animated Triangle",
        buildDirectory: "native/build-scene240-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene240/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 0.5,
            actual: "artifacts/parity/scene240-native.png",
            outputDirectory: "artifacts/parity/scene240",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "0.5",
            },
        },
    },
    {
        id: "scene116",
        name: "Scene 116 - No-Color Depth Views",
        source: "examples/scene116-no-color-depth.ts",
        output: "generated/scene116",
        title: "Babylon Lite Native - No-Color Depth Views",
        buildDirectory: "native/build-scene116-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene116/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene116-native.png",
            outputDirectory: "artifacts/parity/scene116",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene145",
        name: "Scene 145 - Standard Geometry Outputs",
        source: "examples/scene145-standard-geometry-output.ts",
        output: "generated/scene145",
        title: "Babylon Lite Native - Standard Geometry Outputs",
        buildDirectory: "native/build-scene145-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene145/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene145-native.png",
            outputDirectory: "artifacts/parity/scene145",
            maxFullMad: 1.1,
            maxForegroundMad: 1.1,
            backgroundColor: [255, 255, 255],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene146",
        name: "Scene 146 - PBR Geometry Outputs",
        source: "examples/scene146-geometry-output.ts",
        output: "generated/scene146",
        title: "Babylon Lite Native - PBR Geometry Outputs",
        buildDirectory: "native/build-scene146-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene146/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene146-native.png",
            outputDirectory: "artifacts/parity/scene146",
            maxFullMad: 0.9,
            maxForegroundMad: 0.9,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene248",
        name: "Scene 248 - Texture Settings",
        source: "examples/scene248-texture-settings.ts",
        output: "generated/scene248",
        title: "Babylon Lite Native - Texture Settings",
        buildDirectory: "native/build-scene248-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene248/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene248-native.png",
            outputDirectory: "artifacts/parity/scene248",
            maxFullMad: 0.01,
            maxForegroundMad: 0.02,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene248/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
                diagnostics: false,
            },
        },
    },
    {
        id: "scene245",
        name: "Scene 245 - Recursive Skeletons",
        source: "examples/scene245-recursive-skeletons.ts",
        output: "generated/scene245",
        title: "Babylon Lite Native - Recursive Skeletons",
        buildDirectory: "native/build-scene245-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene245/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 1,
            actual: "artifacts/parity/scene245-native.png",
            outputDirectory: "artifacts/parity/scene245",
            maxFullMad: 0.01,
            maxForegroundMad: 0.01,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "1",
            },
        },
    },
    {
        id: "scene249",
        name: "Scene 249 - Vertex Alpha Clip",
        source: "examples/scene249-vertex-alpha-clip.ts",
        output: "generated/scene249",
        title: "Babylon Lite Native - Vertex Alpha Clip",
        buildDirectory: "native/build-scene249-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene249/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene249-native.png",
            outputDirectory: "artifacts/parity/scene249",
            maxFullMad: 0.01,
            maxForegroundMad: 0.05,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene249/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
                diagnostics: false,
            },
        },
    },
    {
        id: "scene257",
        name: "Scene 257 - Node Negative Scale",
        source: "examples/scene257-negative-scale.ts",
        output: "generated/scene257",
        title: "Babylon Lite Native - Node Negative Scale",
        buildDirectory: "native/build-scene257-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene257/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene257-native.png",
            outputDirectory: "artifacts/parity/scene257",
            maxFullMad: 0.01,
            maxForegroundMad: 0.02,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene257/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
                diagnostics: false,
            },
        },
    },
    {
        id: "scene266",
        name: "Scene 266 - Negative Scale Spheres",
        source: "examples/scene266-negative-scale-spheres.ts",
        output: "generated/scene266",
        title: "Babylon Lite Native - Negative Scale Spheres",
        buildDirectory: "native/build-scene266-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene266/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene266-native.png",
            outputDirectory: "artifacts/parity/scene266",
            maxFullMad: 0.17,
            maxForegroundMad: 0.32,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene266/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
                diagnostics: false,
            },
        },
    },
    {
        id: "scene273",
        name: "Scene 273 - Runtime Material Family",
        source: "examples/scene273-runtime-material-family.ts",
        output: "generated/scene273",
        title: "Babylon Lite Native - Runtime Material Family",
        buildDirectory: "native/build-scene273-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene273/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene273-native.png",
            outputDirectory: "artifacts/parity/scene273",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 15, 23],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "19",
            },
        },
    },
    {
        id: "scene274",
        name: "Scene 274 - Alpha to Coverage",
        source: "examples/scene274-alpha-to-coverage.ts",
        output: "generated/scene274",
        title: "Babylon Lite Native - Alpha to Coverage",
        buildDirectory: "native/build-scene274-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene274/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene274-native.png",
            outputDirectory: "artifacts/parity/scene274",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [9, 11, 18],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene274/upstream/gltf-specialization.json",
                drawIds: false,
                triangleClusters: false,
                diagnostics: false,
            },
        },
    },
] as const;

export function getScene(id: string): SceneDefinition {
    const scene = scenes.find((candidate) => candidate.id === id);
    if (!scene) {
        throw new Error(
            `Unknown scene '${id}'. Available scenes: ${scenes.map(({ id: sceneId }) => sceneId).join(", ")}.`,
        );
    }
    return scene;
}

function defaultSceneName(id: string): string {
    return id
        .split("-")
        .filter(Boolean)
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join(" ");
}

export function resolveScene(idOrSource: string): SceneDefinition {
    const registered = scenes.find(({ id }) => id === idOrSource);
    if (registered) return registered;

    const absoluteSource = resolve(idOrSource);
    const registeredSource = scenes.find(
        ({ source }) => resolve(source) === absoluteSource,
    );
    if (registeredSource) return registeredSource;
    if (
        !existsSync(absoluteSource) ||
        !statSync(absoluteSource).isFile() ||
        extname(absoluteSource).toLowerCase() !== ".ts"
    ) {
        throw new Error(
            `Unknown scene or TypeScript source '${idOrSource}'. Registered scenes: ` +
                scenes.map(({ id }) => id).join(", "),
        );
    }
    const source = relative(resolve("."), absoluteSource).replace(/\\/g, "/");
    if (source.startsWith("../")) {
        throw new Error("Ad-hoc scene sources must be inside the repository.");
    }
    const id = basename(absoluteSource, extname(absoluteSource))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    if (!id) throw new Error(`Unable to derive a scene id from '${idOrSource}'.`);
    const name = defaultSceneName(id);
    return {
        id,
        name,
        source,
        output: `generated/${id}`,
        title: `Babylon Lite Native - ${name}`,
        buildDirectory: `native/build-${id}-release`,
        parity: {
            reference: {
                kind: "source",
                path: `reference/${id}/babylon-lite-golden.png`,
            },
            actual: `artifacts/parity/${id}-native.png`,
            outputDirectory: `artifacts/parity/${id}`,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    };
}
import { existsSync, statSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
