export interface SceneParityDefinition {
    reference:
        | { kind: "playground"; path: string; url: string }
        | { kind: "source"; path: string };
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
                kind: "playground",
                path: "reference/boombox/babylon-ref-golden.png",
                url: "https://playground.babylonjs.com/#QCU8DJ#800",
            },
            actual: "artifacts/parity/boombox-gpu.png",
            outputDirectory: "artifacts/parity",
            maxFullMad: 1,
            maxForegroundMad: 8,
            cpuThresholds: { maxFullMad: 4.6, maxForegroundMad: 21.5 },
            backgroundColor: [51, 51, 77],
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
            maxFullMad: 0.7,
            maxForegroundMad: 0.4,
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
