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
    // The draw-id and triangle-cluster attribution buffers; the PBR
    // diagnostics instrument retired with the transcribed fragment it
    // rendered through.
    attribution?: {
        specialization: string;
        drawIds: boolean;
        triangleClusters: boolean;
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

/**
 * A registry entry as written. Every path a scene id implies is optional
 * here and filled in by `withDerivedPaths`, so an entry carries only what
 * is genuinely its own: the id, its name and source, its thresholds, and
 * any real override.
 */
interface SceneInput
    extends Omit<
        SceneDefinition,
        "output" | "buildDirectory" | "parity"
    > {
    output?: string;
    buildDirectory?: string;
    parity?: Omit<
        SceneParityDefinition,
        "reference" | "actual" | "outputDirectory"
    > & {
        reference?: { kind: "source"; path: string };
        actual?: string;
        outputDirectory?: string;
    };
}

const sceneInputs: readonly SceneInput[] = [
    {
        id: "primitives",
        name: "Primitives",
        source: "examples/primitives.ts",
        title: "Babylon Lite Native",
        buildDirectory: "native/build-sdl",
    },
    {
        id: "scene1",
        name: "Scene 1 - BoomBox PBR",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene1.ts",
        title: "Babylon Lite Native - BoomBox",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.015,
            cpuThresholds: { maxFullMad: 2.2, maxForegroundMad: 21.5 },
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            attribution: {
                specialization:
                    "generated/scene1/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
            },
        },
    },
    {
        id: "scene3",
        name: "Scene 3 - Fog Boxes",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene3.ts",
        title: "Babylon Lite Native - Fog Boxes",
        parity: {
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
        title: "Babylon Lite Native - PBR Gold Sphere",
        parity: {
            maxFullMad: 0.005,
            maxForegroundMad: 0.02,
            backgroundColor: [53, 53, 82],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene14",
        name: "Scene 14 - Flight Helmet",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene14.ts",
        title: "Babylon Lite Native - Flight Helmet",
        parity: {
            maxFullMad: 0.09,
            maxForegroundMad: 0.012,
            dawnThresholds: { maxFullMad: 0.09, maxForegroundMad: 0.008 },
            backgroundColor: [61, 61, 94],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene24",
        name: "Scene 24 - Hill Valley",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene24.ts",
        title: "Babylon Lite Native - Hill Valley",
        parity: {
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
        title: "Babylon Lite Native - Clearcoat glTF",
        parity: {
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
        title: "Babylon Lite Native - Sheen Cloth glTF",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.01,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene31",
        name: "Scene 31 - Emissive Strength",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene31.ts",
        title: "Babylon Lite Native - Emissive Strength",
        parity: {
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
        title: "Babylon Lite Native - Punctual Lights",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.012,
            dawnThresholds: { maxFullMad: 0.001, maxForegroundMad: 0.008 },
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene35",
        name: "Scene 35 - Simple Instancing",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene35.ts",
        title: "Babylon Lite Native - Simple Instancing",
        parity: {
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
        title: "Babylon Lite Native - PBR Fog",
        parity: {
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
        title: "Babylon Lite Native - Property Position Animation",
        parity: {
            referenceTimeSeconds: 1,
            referenceFrameRate: 10,
            referenceAnimationGroups: ["group"],
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
        title: "Babylon Lite Native - Iridescence Abalone",
        parity: {
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
        title: "Babylon Lite Native - XMP Metadata Rounded Cube",
        parity: {
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
        title: "Babylon Lite Native - Dispersion Test",
        parity: {
            maxFullMad: 0.03,
            maxForegroundMad: 0.035,
            dawnThresholds: { maxFullMad: 0.025, maxForegroundMad: 0.03 },
            backgroundColor: [255, 255, 255],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene243",
        name: "Scene 243 - Morph Stress Test",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene243.ts",
        title: "Babylon Lite Native - Morph Stress Test",
        parity: {
            referenceTimeSeconds: 0.5,
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
        title: "Babylon Lite Native - Simple Skin",
        parity: {
            referenceTimeSeconds: 0.5,
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
        title: "Babylon Lite Native - Teapots Galore",
        parity: {
            maxFullMad: 0.01,
            maxForegroundMad: 0.05,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene252",
        name: "Scene 252 - Standard Morph Target",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene252.ts",
        title: "Babylon Lite Native - Standard Morph Target",
        parity: {
            maxFullMad: 0.01,
            maxForegroundMad: 0.02,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene254",
        name: "Scene 254 - Animation Sampler Type",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene254.ts",
        title: "Babylon Lite Native - Animation Sampler Type",
        parity: {
            referenceTimeSeconds: 2,
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
        title: "Babylon Lite Native - Animation Skin Type",
        parity: {
            referenceTimeSeconds: 1,
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
        title: "Babylon Lite Native - Interleaved Buffer",
        parity: {
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
        title: "Babylon Lite Native - Material Texture",
        parity: {
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
        title: "Babylon Lite Native - Environment Test",
        parity: {
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
        title: "Babylon Lite Native - Directional Light Sphere",
        parity: {
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
        title: "Babylon Lite Native - ChibiRex Default Camera",
        parity: {
            referenceTimeSeconds: 1,
            // The sky is byte-identical; what is left is the ground, whose
            // root position differs from the pin's by one ULP on two axes
            // (the sizing entry in TODO.md), and the foreground's sub-pixel
            // silhouette epsilon.
            maxFullMad: 0.06,
            maxForegroundMad: 0.16,
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
        title: "Babylon Lite Native - HDR Glass Sphere",
        parity: {
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
        title: "Babylon Lite Native - Alien",
        parity: {
            referenceTimeSeconds: 2,
            maxFullMad: 0.001,
            maxForegroundMad: 0.002,
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
        title: "Babylon Lite Native - PBR Rough Sphere",
        parity: {
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
        title: "Babylon Lite Native - PBR Spheres Grid",
        parity: {
            maxFullMad: 0.02,
            maxForegroundMad: 0.1,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            attribution: {
                specialization: "generated/scene13/upstream/gltf-specialization.json",
                drawIds: true,
                triangleClusters: true,
            },
        },
    },
    {
        id: "scene32",
        name: "Scene 32 - Unlit glTF",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene32.ts",
        title: "Babylon Lite Native - Unlit glTF",
        parity: {
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
        id: "scene159",
        name: "Scene 159 - Shader Flat Color",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene159.ts",
        title: "Babylon Lite Native - Shader Flat Color",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene161",
        name: "Scene 161 - Shader Custom Uniforms",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene161.ts",
        title: "Babylon Lite Native - Shader Custom Uniforms",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene163",
        name: "Scene 163 - Shader Alpha Cutout",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene163.ts",
        title: "Babylon Lite Native - Shader Alpha Cutout",
        parity: {
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
        id: "regression-runtime-sweep",
        name: "Regression - Runtime Sweep",
        source: "examples/regression-runtime-sweep.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - Runtime Sweep",
        buildDirectory:
            "native/build-regression-runtime-sweep-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-runtime-sweep/babylon-lite-golden.png",
            },
            actual:
                "artifacts/parity/regression-runtime-sweep-native.png",
            outputDirectory:
                "artifacts/parity/regression-runtime-sweep",
            maxFullMad: 0.001,
            maxForegroundMad: 0.004,
            backgroundColor: [5, 6, 13],
            backgroundThreshold: 30,
            // The lattice, the preview count and the spark sweep all stop
            // at frame 24 and readiness is flagged at 32, so both sides
            // capture the same still state.
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "36",
            },
        },
    },
    {
        id: "regression-instanced-ground",
        name: "Regression - Instanced Ground",
        source: "examples/regression-instanced-ground.ts",
        sourceOrigin: "bblitec-regression",
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
            maxFullMad: 0.1,
            maxForegroundMad: 0.06,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "regression-morph-ground",
        name: "Regression - Morph Storage Ground",
        source: "examples/regression-morph-ground.ts",
        sourceOrigin: "bblitec-regression",
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
            maxFullMad: 0.05,
            maxForegroundMad: 0.07,
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
        title: "Babylon Lite Native - Mirrored Double-Sided Winding",
        parity: {
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
        id: "scene176",
        name: "Scene 176 - Mosquito In Amber",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene176.ts",
        title: "Babylon Lite Native - Mosquito In Amber",
        parity: {
            maxFullMad: 0.018,
            maxForegroundMad: 0.018,
            dawnThresholds: { maxFullMad: 0.016, maxForegroundMad: 0.016 },
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
        title: "Babylon Lite Native - Grid Material Ordering",
        parity: {
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
        title: "Babylon Lite Native - Property Transform Animation",
        parity: {
            referenceTimeSeconds: 0.5,
            referenceFrameRate: 12,
            referenceAnimationGroups: ["group"],
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
        title: "Babylon Lite Native - STEP Time Animation",
        parity: {
            referenceTimeSeconds: 0.75,
            referenceFrameRate: 10,
            referenceAnimationGroups: [
                "linearGroup",
                "stepGroup",
            ],
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
        title: "Babylon Lite Native - Animated Triangle",
        parity: {
            referenceTimeSeconds: 0.5,
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
        title: "Babylon Lite Native - No-Color Depth Views",
        parity: {
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
        title: "Babylon Lite Native - Standard Geometry Outputs",
        parity: {
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
        title: "Babylon Lite Native - PBR Geometry Outputs",
        parity: {
            maxFullMad: 0.016,
            maxForegroundMad: 0.014,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene248",
        name: "Scene 248 - Texture Settings",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene248.ts",
        title: "Babylon Lite Native - Texture Settings",
        parity: {
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
        title: "Babylon Lite Native - Recursive Skeletons",
        parity: {
            referenceTimeSeconds: 1,
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
        title: "Babylon Lite Native - Vertex Alpha Clip",
        parity: {
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
        title: "Babylon Lite Native - Node Negative Scale",
        parity: {
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
        title: "Babylon Lite Native - Negative Scale Spheres",
        parity: {
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
        id: "scene267",
        name: "Scene 267 - Standard Vertex Colors",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene267.ts",
        title: "Babylon Lite Native - Standard Vertex Colors",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [8, 10, 18],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene268",
        name: "Scene 268 - Orthographic Camera",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene268.ts",
        title: "Babylon Lite Native - Orthographic Camera",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [15, 18, 26],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene30",
        name: "Scene 30 - Volume Testing",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene30.ts",
        title: "Babylon Lite Native - Volume Testing",
        parity: {
            // SDL_GPU carries the transmission scene's per-sample
            // image-processing gap (the same one scene 33 measures), so it
            // gates looser than Dawn, which runs the pinned pass.
            maxFullMad: 0.055,
            maxForegroundMad: 0.07,
            dawnThresholds: { maxFullMad: 0.05, maxForegroundMad: 0.065 },
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene256",
        name: "Scene 256 - Normal Tangent Test",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene256.ts",
        title: "Babylon Lite Native - Normal Tangent Test",
        parity: {
            maxFullMad: 0.01,
            maxForegroundMad: 0.09,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene260",
        name: "Scene 260 - Triangle Strip Primitive",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene260.ts",
        title: "Babylon Lite Native - Triangle Strip Primitive",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene34",
        name: "Scene 34 - Node Visibility",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene34.ts",
        title: "Babylon Lite Native - Node Visibility",
        parity: {
            // 0.75 s sits strictly inside a STEP interval where the
            // animated cube is hidden, so the golden discriminates both
            // extensions at once: a static read of the pointer target
            // would draw the blue cube, and ignoring KHR_node_visibility
            // would draw the red ones.
            referenceTimeSeconds: 0.75,
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "0.75",
            },
        },
    },
    {
        id: "scene9",
        name: "Scene 9 - Sponza",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene9.ts",
        title: "Babylon Lite Native - Sponza",
        parity: {
            maxFullMad: 0.35,
            maxForegroundMad: 0.35,
            backgroundColor: [79, 170, 255],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene242",
        name: "Scene 242 - Emissive Fireflies",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene242.ts",
        title: "Babylon Lite Native - Emissive Fireflies",
        parity: {
            // 6.5 s falls between two keys near the emissive peak, so the
            // capture reads an interpolated value on all nine pointer
            // channels rather than a keyframe either side could hit by
            // rounding.
            referenceTimeSeconds: 6.5,
            maxFullMad: 0.001,
            maxForegroundMad: 0.01,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "6.5",
            },
        },
    },
    {
        id: "scene273",
        name: "Scene 273 - Runtime Material Family",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene273.ts",
        title: "Babylon Lite Native - Runtime Material Family",
        parity: {
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
        title: "Babylon Lite Native - Alpha to Coverage",
        parity: {
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
        id: "scene244",
        name: "Scene 244 - Pot of Coals",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene244.ts",
        title: "Babylon Lite Native - Pot of Coals",
        parity: {
            // Both pointer channels are LINEAR over 0..4 s and neither has a
            // key at 1.0, so the capture reads an interpolated rotation on
            // each: the normal map at t*PI/2 and the volume thickness at
            // 2*PI*(1 - t/4). They rotate in opposite directions, so a single
            // shared material transform cannot produce this frame.
            referenceTimeSeconds: 1.0,
            maxFullMad: 0.002,
            maxForegroundMad: 0.02,
            // The SDL_GPU column carries the recorded per-sample image
            // processing gap on a multisampled transmission target, which is
            // why its residual sits on the dome's edges; Dawn runs the pinned
            // per-sample pass and lands within one channel step everywhere.
            dawnThresholds: { maxFullMad: 0.002, maxForegroundMad: 0.015 },
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "1.0",
            },
        },
    },
    {
        id: "scene37",
        name: "Scene 37 - Sheen Wood Leather Sofa",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene37.ts",
        title: "Babylon Lite Native - Sheen Wood Leather Sofa",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.01,
            dawnThresholds: { maxFullMad: 0.002, maxForegroundMad: 0.008 },
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene253",
        name: "Scene 253 - Animate All The Things",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene253.ts",
        title: "Babylon Lite Native - Animate All The Things",
        parity: {
            // Seek 1.0 s reads interpolated values on every family this scene
            // animates at once: node transforms, light colour and cone, and
            // the material factors and extensions.
            referenceTimeSeconds: 1.0,
            // The Transparency sphere's double-applied alpha is closed — an
            // animated base colour factor with no base colour image bakes a
            // white texel upstream, not the factor — which took Dawn from
            // 0.086/1.328 to 0.002/0.030 and SDL_GPU from 0.128/1.936 to
            // 0.047/0.681.
            //
            // What that uncovers is a backend split this scene did not show
            // before: the two backends agreed to one channel step while the
            // alpha defect dominated both, and now disagree at MAD 0.044.
            // Scene 33 documents the same shape — SDL_GPU cannot sample a
            // multisampled texture, so its transmission pass processes the
            // resolved pixel once where the pin processes each sample — and
            // this scene transmits, so the SDL_GPU threshold stays looser
            // than Dawn's for that reason rather than for a defect.
            maxFullMad: 0.005,
            maxForegroundMad: 0.04,
            dawnThresholds: { maxFullMad: 0.005, maxForegroundMad: 0.035 },
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "1.0",
            },
        },
    },
    {
        id: "scene39",
        name: "Scene 39 - Animated Waterfall",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene39.ts",
        title: "Babylon Lite Native - Animated Waterfall",
        parity: {
            referenceTimeSeconds: 1.0,
            maxFullMad: 0.001,
            maxForegroundMad: 0.01,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_ANIMATION_SEEK_SECONDS: "1.0",
            },
        },
    },
    {
        id: "scene21",
        name: "Scene 21 - PBR Sheen Cloth",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene21.ts",
        title: "Babylon Lite Native - PBR Sheen Cloth",
        parity: {
            // The frame is a photographic HDR skybox behind a cloth, so
            // almost every pixel is foreground and the two figures track each
            // other. Both sit with the other environment-backed scenes.
            maxFullMad: 0.34,
            maxForegroundMad: 0.34,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene19",
        name: "Scene 19 - PBR Clearcoat",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene19.ts",
        title: "Babylon Lite Native - PBR Clearcoat",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.002,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene15",
        name: "Scene 15 - Two Spot Lights",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene15.ts",
        title: "Babylon Lite Native - Two Spot Lights",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene50",
        name: "Scene 50 - Sprite Grid",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene50.ts",
        title: "Babylon Lite Native - Sprite Grid",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [18, 20, 31],
            backgroundThreshold: 30,
        },
    },
];

/**
 * Apply the paths a scene id implies. Every one of these is derivable
 * from the id, and the ad-hoc path below derives the same set for an
 * unregistered source, so restating them per entry only created a place
 * for them to disagree.
 */
function withDerivedPaths(scene: SceneInput): SceneDefinition {
    const { parity, output, buildDirectory, ...rest } = scene;
    const resolved: SceneDefinition = {
        ...rest,
        output: output ?? `generated/${scene.id}`,
        buildDirectory:
            buildDirectory ?? `native/build-${scene.id}-release`,
    };
    if (!parity) {
        return resolved;
    }
    return {
        ...resolved,
        parity: {
            ...parity,
            reference: parity.reference ?? {
                kind: "source",
                path: `reference/${scene.id}/babylon-lite-golden.png`,
            },
            actual:
                parity.actual ??
                `artifacts/parity/${scene.id}-native.png`,
            outputDirectory:
                parity.outputDirectory ??
                `artifacts/parity/${scene.id}`,
        },
    };
}

export const scenes: readonly SceneDefinition[] =
    sceneInputs.map(withDerivedPaths);

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
