export interface SceneParityDefinition {
    reference: { kind: "source"; path: string };
    referenceTimeSeconds?: number;
    referenceFrameRate?: number;
    referenceAnimationGroups?: string[];
    actual: string;
    outputDirectory: string;
    maxFullMad?: number;
    maxForegroundMad?: number;
    cpuThresholds?: { maxFullMad: number; maxForegroundMad: number };
    // Tighter gates for the Dawn backend where it is structurally
    // closer to the golden than SDL_GPU (per-sample transmission,
    // browser-compiler parity); the shared thresholds above gate
    // SDL_GPU and any scene without an entry here.
    dawnThresholds?: { maxFullMad: number; maxForegroundMad: number };
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
    sourceOrigin?: "bblitec-regression";
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
        id: "scene1",
        name: "Scene 1 - BoomBox PBR",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene1.ts",
        output: "generated/scene1",
        title: "Babylon Lite Native - BoomBox",
        buildDirectory: "native/build-scene1-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene1/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene1-native.png",
            outputDirectory: "artifacts/parity/scene1",
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            cpuThresholds: { maxFullMad: 2.2, maxForegroundMad: 21.5 },
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            attribution: {
                specialization:
                    "generated/scene1/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
                diagnostics: true,
            },
        },
    },
    {
        id: "scene3",
        name: "Scene 3 - Fog Boxes",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene3.ts",
        output: "generated/scene3",
        title: "Babylon Lite Native - Fog Boxes",
        buildDirectory: "native/build-scene3-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene3/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene3-native.png",
            outputDirectory: "artifacts/parity/scene3",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [200, 200, 190],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene6",
        name: "Scene 6 - PBR Gold Sphere",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene6.ts",
        output: "generated/scene6",
        title: "Babylon Lite Native - PBR Gold Sphere",
        buildDirectory: "native/build-scene6-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene6/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene6-native.png",
            outputDirectory: "artifacts/parity/scene6",
            maxFullMad: 0.3,
            maxForegroundMad: 0.03,
            backgroundColor: [53, 53, 82],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene14",
        name: "Scene 14 - Flight Helmet",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene14.ts",
        output: "generated/scene14",
        title: "Babylon Lite Native - Flight Helmet",
        buildDirectory: "native/build-scene14-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene14/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene14-native.png",
            outputDirectory: "artifacts/parity/scene14",
            maxFullMad: 0.35,
            maxForegroundMad: 0.07,
            backgroundColor: [61, 61, 94],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene24",
        name: "Scene 24 - Hill Valley",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene24.ts",
        output: "generated/scene24",
        title: "Babylon Lite Native - Hill Valley",
        buildDirectory: "native/build-scene24-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene24/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene24-native.png",
            outputDirectory: "artifacts/parity/scene24",
            maxFullMad: 0.05,
            maxForegroundMad: 0.05,
            dawnThresholds: { maxFullMad: 0.03, maxForegroundMad: 0.03 },
            backgroundColor: [174, 129, 107],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene28",
        name: "Scene 28 - Clearcoat glTF",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene28.ts",
        output: "generated/scene28",
        title: "Babylon Lite Native - Clearcoat glTF",
        buildDirectory: "native/build-scene28-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene28/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene28-native.png",
            outputDirectory: "artifacts/parity/scene28",
            maxFullMad: 0.05,
            maxForegroundMad: 0.3,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene29",
        name: "Scene 29 - Sheen Cloth glTF",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene29.ts",
        output: "generated/scene29",
        title: "Babylon Lite Native - Sheen Cloth glTF",
        buildDirectory: "native/build-scene29-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene29/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene29-native.png",
            outputDirectory: "artifacts/parity/scene29",
            maxFullMad: 0.02,
            maxForegroundMad: 0.1,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene31",
        name: "Scene 31 - Emissive Strength",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene31.ts",
        output: "generated/scene31",
        title: "Babylon Lite Native - Emissive Strength",
        buildDirectory: "native/build-scene31-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene31/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene31-native.png",
            outputDirectory: "artifacts/parity/scene31",
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene33",
        name: "Scene 33 - Punctual Lights",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene33.ts",
        output: "generated/scene33",
        title: "Babylon Lite Native - Punctual Lights",
        buildDirectory: "native/build-scene33-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene33/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene33-native.png",
            outputDirectory: "artifacts/parity/scene33",
            maxFullMad: 0.08,
            maxForegroundMad: 1.7,
            dawnThresholds: { maxFullMad: 0.02, maxForegroundMad: 0.2 },
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene35",
        name: "Scene 35 - Simple Instancing",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene35.ts",
        output: "generated/scene35",
        title: "Babylon Lite Native - Simple Instancing",
        buildDirectory: "native/build-scene35-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene35/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene35-native.png",
            outputDirectory: "artifacts/parity/scene35",
            maxFullMad: 0.001,
            maxForegroundMad: 0.005,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene216",
        name: "Scene 216 - PBR Fog",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene216.ts",
        output: "generated/scene216",
        title: "Babylon Lite Native - PBR Fog",
        buildDirectory: "native/build-scene216-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene216/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene216-native.png",
            outputDirectory: "artifacts/parity/scene216",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [179, 191, 209],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene150",
        name: "Scene 150 - Property Position Animation",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene150.ts",
        output: "generated/scene150",
        title: "Babylon Lite Native - Property Position Animation",
        buildDirectory: "native/build-scene150-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene150/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 1,
            referenceFrameRate: 10,
            referenceAnimationGroups: ["group"],
            actual: "artifacts/parity/scene150-native.png",
            outputDirectory: "artifacts/parity/scene150",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "1",
            },
        },
    },
    {
        id: "scene178",
        name: "Scene 178 - Iridescence Abalone",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene178.ts",
        output: "generated/scene178",
        title: "Babylon Lite Native - Iridescence Abalone",
        buildDirectory: "native/build-scene178-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene178/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene178-native.png",
            outputDirectory: "artifacts/parity/scene178",
            maxFullMad: 0.05,
            maxForegroundMad: 0.05,
            backgroundColor: [160, 160, 160],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene210",
        name: "Scene 210 - XMP Metadata Rounded Cube",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene210.ts",
        output: "generated/scene210",
        title: "Babylon Lite Native - XMP Metadata Rounded Cube",
        buildDirectory: "native/build-scene210-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene210/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene210-native.png",
            outputDirectory: "artifacts/parity/scene210",
            maxFullMad: 0.05,
            maxForegroundMad: 0.25,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene212",
        name: "Scene 212 - Dispersion Test",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene212.ts",
        output: "generated/scene212",
        title: "Babylon Lite Native - Dispersion Test",
        buildDirectory: "native/build-scene212-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene212/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene212-native.png",
            outputDirectory: "artifacts/parity/scene212",
            maxFullMad: 0.25,
            maxForegroundMad: 0.28,
            dawnThresholds: { maxFullMad: 0.05, maxForegroundMad: 0.05 },
            backgroundColor: [255, 255, 255],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene243",
        name: "Scene 243 - Morph Stress Test",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene243.ts",
        output: "generated/scene243",
        title: "Babylon Lite Native - Morph Stress Test",
        buildDirectory: "native/build-scene243-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene243/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 0.5,
            actual: "artifacts/parity/scene243-native.png",
            outputDirectory: "artifacts/parity/scene243",
            maxFullMad: 0.01,
            maxForegroundMad: 0.02,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "0.5",
            },
        },
    },
    {
        id: "scene246",
        name: "Scene 246 - Simple Skin",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene246.ts",
        output: "generated/scene246",
        title: "Babylon Lite Native - Simple Skin",
        buildDirectory: "native/build-scene246-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene246/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 0.5,
            actual: "artifacts/parity/scene246-native.png",
            outputDirectory: "artifacts/parity/scene246",
            maxFullMad: 0.01,
            maxForegroundMad: 0.01,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "0.5",
            },
        },
    },
    {
        id: "scene247",
        name: "Scene 247 - Teapots Galore",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene247.ts",
        output: "generated/scene247",
        title: "Babylon Lite Native - Teapots Galore",
        buildDirectory: "native/build-scene247-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene247/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene247-native.png",
            outputDirectory: "artifacts/parity/scene247",
            maxFullMad: 0.01,
            maxForegroundMad: 0.05,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene254",
        name: "Scene 254 - Animation Sampler Type",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene254.ts",
        output: "generated/scene254",
        title: "Babylon Lite Native - Animation Sampler Type",
        buildDirectory: "native/build-scene254-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene254/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 2,
            actual: "artifacts/parity/scene254-native.png",
            outputDirectory: "artifacts/parity/scene254",
            maxFullMad: 0.01,
            maxForegroundMad: 0.01,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "2",
            },
        },
    },
    {
        id: "scene255",
        name: "Scene 255 - Animation Skin Type",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene255.ts",
        output: "generated/scene255",
        title: "Babylon Lite Native - Animation Skin Type",
        buildDirectory: "native/build-scene255-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene255/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 1,
            actual: "artifacts/parity/scene255-native.png",
            outputDirectory: "artifacts/parity/scene255",
            maxFullMad: 0.01,
            maxForegroundMad: 0.02,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "1",
            },
        },
    },
    {
        id: "scene258",
        name: "Scene 258 - Interleaved Buffer",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene258.ts",
        output: "generated/scene258",
        title: "Babylon Lite Native - Interleaved Buffer",
        buildDirectory: "native/build-scene258-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene258/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene258-native.png",
            outputDirectory: "artifacts/parity/scene258",
            maxFullMad: 0.01,
            maxForegroundMad: 0.01,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene259",
        name: "Scene 259 - Material Texture",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene259.ts",
        output: "generated/scene259",
        title: "Babylon Lite Native - Material Texture",
        buildDirectory: "native/build-scene259-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene259/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene259-native.png",
            outputDirectory: "artifacts/parity/scene259",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene265",
        name: "Scene 265 - Environment Test",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene265.ts",
        output: "generated/scene265",
        title: "Babylon Lite Native - Environment Test",
        buildDirectory: "native/build-scene265-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene265/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene265-native.png",
            outputDirectory: "artifacts/parity/scene265",
            maxFullMad: 0.01,
            maxForegroundMad: 0.1,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene2",
        name: "Scene 2 - Directional Light Sphere",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene2.ts",
        output: "generated/scene2",
        title: "Babylon Lite Native - Directional Light Sphere",
        buildDirectory: "native/build-scene2-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene2/babylon-lite-golden.png",
            },
            actual: "artifacts/parity/scene2-native.png",
            outputDirectory: "artifacts/parity/scene2",
            maxFullMad: 0.01,
            maxForegroundMad: 0.01,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene7",
        name: "Scene 7 - ChibiRex Default Camera",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene7.ts",
        output: "generated/scene7",
        title: "Babylon Lite Native - ChibiRex Default Camera",
        buildDirectory: "native/build-scene7-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene7/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 1,
            actual: "artifacts/parity/scene7-native.png",
            outputDirectory: "artifacts/parity/scene7",
            maxFullMad: 0.3,
            maxForegroundMad: 0.3,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "1",
            },
        },
    },
    {
        id: "scene8",
        name: "Scene 8 - HDR Glass Sphere",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene8.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene5.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene10.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene13.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene32.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene163.ts",
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
        id: "audit-shader-frame-graph",
        name: "Audit - Shader Frame Graph",
        source: "examples/audit-shader-frame-graph.ts",
        sourceOrigin: "bblitec-regression",
        output: "generated/audit-shader-frame-graph",
        title: "Babylon Lite Native - Shader Frame Graph",
        buildDirectory:
            "native/build-audit-shader-frame-graph-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/audit-shader-frame-graph/babylon-lite-golden.png",
            },
            actual:
                "artifacts/parity/audit-shader-frame-graph-native.png",
            outputDirectory:
                "artifacts/parity/audit-shader-frame-graph",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [9, 11, 18],
            backgroundThreshold: 30,
        },
    },
    {
        id: "regression-standard-fog",
        name: "Regression - Standard Fog",
        source: "examples/regression-standard-fog.ts",
        sourceOrigin: "bblitec-regression",
        output: "generated/regression-standard-fog",
        title: "Babylon Lite Native - Standard Fog",
        buildDirectory:
            "native/build-regression-standard-fog-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-standard-fog/babylon-lite-golden.png",
            },
            actual:
                "artifacts/parity/regression-standard-fog-native.png",
            outputDirectory:
                "artifacts/parity/regression-standard-fog",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "regression-instanced-ground",
        name: "Regression - Instanced Ground",
        source: "examples/regression-instanced-ground.ts",
        sourceOrigin: "bblitec-regression",
        output: "generated/regression-instanced-ground",
        title: "Babylon Lite Native - Instanced Ground",
        buildDirectory:
            "native/build-regression-instanced-ground-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-instanced-ground/babylon-lite-golden.png",
            },
            actual:
                "artifacts/parity/regression-instanced-ground-native.png",
            outputDirectory:
                "artifacts/parity/regression-instanced-ground",
            maxFullMad: 0.2,
            maxForegroundMad: 0.15,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "regression-morph-ground",
        name: "Regression - Morph Storage Ground",
        source: "examples/regression-morph-ground.ts",
        sourceOrigin: "bblitec-regression",
        output: "generated/regression-morph-ground",
        title: "Babylon Lite Native - Morph Storage Ground",
        buildDirectory:
            "native/build-regression-morph-ground-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-morph-ground/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 0.5,
            actual:
                "artifacts/parity/regression-morph-ground-native.png",
            outputDirectory:
                "artifacts/parity/regression-morph-ground",
            maxFullMad: 0.2,
            maxForegroundMad: 0.25,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "0.5",
            },
        },
    },
    {
        id: "regression-compiler-state",
        name: "Regression - Compiler State",
        source: "examples/regression-compiler-state.ts",
        sourceOrigin: "bblitec-regression",
        output: "generated/regression-compiler-state",
        title: "Babylon Lite Native - Compiler State",
        buildDirectory:
            "native/build-regression-compiler-state-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-compiler-state/babylon-lite-golden.png",
            },
            actual:
                "artifacts/parity/regression-compiler-state-native.png",
            outputDirectory:
                "artifacts/parity/regression-compiler-state",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [9, 11, 18],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene168",
        name: "Scene 168 - Mirrored Double-Sided Winding",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene168.ts",
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
            maxFullMad: 0.05,
            maxForegroundMad: 0.05,
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
            maxFullMad: 0.04,
            maxForegroundMad: 0.18,
            dawnThresholds: { maxFullMad: 0.01, maxForegroundMad: 0.01 },
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
            maxFullMad: 0.08,
            maxForegroundMad: 0.18,
            dawnThresholds: { maxFullMad: 0.01, maxForegroundMad: 0.01 },
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
            maxFullMad: 0.09,
            maxForegroundMad: 0.22,
            dawnThresholds: { maxFullMad: 0.01, maxForegroundMad: 0.01 },
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene176",
        name: "Scene 176 - Mosquito In Amber",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene176.ts",
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
            maxFullMad: 0.12,
            maxForegroundMad: 0.12,
            dawnThresholds: { maxFullMad: 0.06, maxForegroundMad: 0.06 },
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene213.ts",
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
        id: "scene151",
        name: "Scene 151 - Property Transform Animation",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene151.ts",
        output: "generated/scene151",
        title: "Babylon Lite Native - Property Transform Animation",
        buildDirectory: "native/build-scene151-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene151/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 0.5,
            referenceFrameRate: 12,
            referenceAnimationGroups: ["group"],
            actual: "artifacts/parity/scene151-native.png",
            outputDirectory: "artifacts/parity/scene151",
            maxFullMad: 0.05,
            maxForegroundMad: 0.2,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "0.5",
            },
        },
    },
    {
        id: "scene154",
        name: "Scene 154 - STEP Time Animation",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene154.ts",
        output: "generated/scene154",
        title: "Babylon Lite Native - STEP Time Animation",
        buildDirectory: "native/build-scene154-release",
        parity: {
            reference: {
                kind: "source",
                path: "reference/scene154/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 0.75,
            referenceFrameRate: 10,
            referenceAnimationGroups: [
                "linearGroup",
                "stepGroup",
            ],
            actual: "artifacts/parity/scene154-native.png",
            outputDirectory: "artifacts/parity/scene154",
            maxFullMad: 0.05,
            maxForegroundMad: 0.2,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "0.75",
            },
        },
    },
    {
        id: "scene240",
        name: "Scene 240 - Animated Triangle",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene240.ts",
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
        id: "regression-track-clamp",
        name: "Regression - glTF Track Clamp",
        source: "examples/regression-track-clamp.ts",
        sourceOrigin: "bblitec-regression",
        output: "generated/regression-track-clamp",
        title: "Babylon Lite Native - glTF Track Clamp",
        buildDirectory:
            "native/build-regression-track-clamp-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-track-clamp/babylon-lite-golden.png",
            },
            referenceTimeSeconds: 3,
            actual:
                "artifacts/parity/regression-track-clamp-native.png",
            outputDirectory:
                "artifacts/parity/regression-track-clamp",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [9, 11, 18],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "3",
            },
        },
    },
    {
        id: "scene116",
        name: "Scene 116 - No-Color Depth Views",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene116.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene145.ts",
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
            maxFullMad: 0.05,
            maxForegroundMad: 0.05,
            dawnThresholds: { maxFullMad: 0.02, maxForegroundMad: 0.02 },
            backgroundColor: [255, 255, 255],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene146",
        name: "Scene 146 - PBR Geometry Outputs",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene146.ts",
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
            maxFullMad: 0.04,
            maxForegroundMad: 0.04,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene248",
        name: "Scene 248 - Texture Settings",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene248.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene245.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene249.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene257.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene266.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene273.ts",
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
        source: "corpus/babylon-lite/lab/lite/src/lite/scene274.ts",
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
    {
        id: "tetris-blocks",
        name: "Tetris Blocks",
        source: "examples/tetris-blocks.ts",
        sourceOrigin: "bblitec-regression",
        output: "generated/tetris-blocks",
        title: "Babylon Lite Native - Tetris Blocks",
        buildDirectory:
            "native/build-tetris-blocks-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/tetris-blocks/babylon-lite-golden.png",
            },
            actual:
                "artifacts/parity/tetris-blocks-native.png",
            outputDirectory:
                "artifacts/parity/tetris-blocks",
            // A handful of rotated-silhouette pixels differ by one
            // shading step: unpinned std::cos/sin ULPs against V8 shift
            // the instanced-edge raster sub-pixel (same class as the
            // fdlibm Math.pow TODO). Measured 0.000 full / 0.001
            // foreground on both backends.
            maxFullMad: 0.001,
            maxForegroundMad: 0.004,
            backgroundColor: [5, 6, 13],
            backgroundThreshold: 30,
        },
    },
    {
        id: "tetris-logic",
        name: "Tetris Logic - Compiled Game Rules",
        source: "examples/tetris-logic.ts",
        sourceOrigin: "bblitec-regression",
        output: "generated/tetris-logic",
        title: "Babylon Lite Native - Tetris Logic",
        buildDirectory:
            "native/build-tetris-logic-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/tetris-logic/babylon-lite-golden.png",
            },
            actual:
                "artifacts/parity/tetris-logic-native.png",
            outputDirectory:
                "artifacts/parity/tetris-logic",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [5, 6, 13],
            backgroundThreshold: 30,
        },
    },
    {
        id: "tetris-well",
        name: "Tetris Well - Dynamic Thin Instances",
        source: "examples/tetris-well.ts",
        sourceOrigin: "bblitec-regression",
        output: "generated/tetris-well",
        title: "Babylon Lite Native - Tetris Well",
        buildDirectory:
            "native/build-tetris-well-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/tetris-well/babylon-lite-golden.png",
            },
            actual:
                "artifacts/parity/tetris-well-native.png",
            outputDirectory:
                "artifacts/parity/tetris-well",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [5, 6, 13],
            backgroundThreshold: 30,
            // The scripted tape ends at frame 168 and the scene flags
            // readiness at frame 176; capture past both so browser and
            // native both see the terminal board while the per-frame
            // pool rewrites keep exercising the dynamic upload path.
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "184",
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

export function isRegisteredScene(
    scene: SceneDefinition,
): boolean {
    return scenes.some(
        (candidate) =>
            candidate.id === scene.id &&
            resolve(candidate.source) === resolve(scene.source),
    );
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
    const relativeSource = relative(resolve("."), absoluteSource);
    if (
        isAbsolute(relativeSource) ||
        relativeSource === ".." ||
        relativeSource.startsWith(`..${sep}`)
    ) {
        throw new Error("Ad-hoc scene sources must be inside the repository.");
    }
    const source = relativeSource.replace(/\\/g, "/");
    const id = basename(absoluteSource, extname(absoluteSource))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    if (!id) throw new Error(`Unable to derive a scene id from '${idOrSource}'.`);
    if (scenes.some((candidate) => candidate.id === id)) {
        throw new Error(
            `Ad-hoc source '${source}' derives registered scene id '${id}'. Rename the source file.`,
        );
    }
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
import {
    basename,
    extname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from "node:path";
