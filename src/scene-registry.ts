export interface SceneParityDefinition {
    reference: { kind: "source"; path: string };
    referenceTimeSeconds?: number;
    referenceAnimationGroups?: string[];
    /**
     * Freeze the browser RAF scheduler on this exact positive native frame and
     * derive the native screenshot frame from the same value. Live
     * application shaders must use this instead of a wall-clock settle.
     */
    referenceFrame?: number;
    /**
     * The query string the pinned parity spec serves this scene at, when it
     * serves one (`"?seekTime=0"`). The reference page is navigated with it
     * and the compiler folds `window.location.search` to the same text, so
     * both sides take the branch the pin's own test takes. A scene the pin
     * serves bare leaves this unset, and the query reads as empty.
     */
    referenceSearch?: string;
    // The native actual lands in `outputDirectory` as
    // `native-{gpu,dawn}.png` — suffixed per backend so an SDL_GPU
    // run and a Dawn run cannot overwrite each other's evidence.
    outputDirectory: string;
    maxFullMad?: number;
    maxForegroundMad?: number;
    // Tighter gates for the Dawn backend where it is structurally
    // closer to the golden than SDL_GPU (per-sample transmission,
    // browser-compiler parity); the shared thresholds above gate
    // SDL_GPU and any scene without an entry here.
    dawnThresholds?: { maxFullMad: number; maxForegroundMad: number };
    /**
     * Gates for the canvas-only lane of a UI-dominated application whose
     * full-page thresholds sit at the platform font-rasterization floor
     * (docs/ui.md): loose enough for a genuine 3D regression of a few
     * tenths MAD to hide under. A canonical parity run of a scene
     * declaring this also measures the `BBLITE_CAPTURE_UI=0` pair into
     * `artifacts/parity-canvas/` — the same artifacts the manual
     * attribution run writes — and gates it. One pair gates both
     * backends, and only declaring scenes pay the extra native run and
     * canvas reference capture.
     */
    canvasThresholds?: { maxFullMad: number; maxForegroundMad: number };
    backgroundColor: [number, number, number];
    backgroundThreshold: number;
    nativeEnvironment?: Record<string, string>;
    // The draw-id and triangle-cluster attribution buffers.
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
    sourceOrigin?: "bblitec-regression" | "babylon-lite-application";
    output: string;
    title: string;
    buildDirectory: string;
    /** Audited host-page UI that exists outside the immutable scene module. */
    nativeHostUi?: string;
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
        "reference" | "outputDirectory"
    > & {
        reference?: { kind: "source"; path: string };
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
            maxFullMad: 0.015,
            maxForegroundMad: 0.010,
            dawnThresholds: { maxFullMad: 0.015, maxForegroundMad: 0.007 },
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
            maxFullMad: 0.007,
            maxForegroundMad: 0.008,
            // Dawn sits at the golden since the .babylon camera reads at
            // the pin's JavaScript-number width (measured 0.000014 full
            // and foreground); the ceiling guards the next regression at
            // well under one display step.
            dawnThresholds: { maxFullMad: 0.0002, maxForegroundMad: 0.0002 },
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
            referenceAnimationGroups: ["group"],
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
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
        backgroundColor: [51, 51, 76],
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
            maxFullMad: 0.002,
            maxForegroundMad: 0.011,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
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
        id: "scene12",
        name: "Scene 12 - PBR Shader Balls",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene12.ts",
        title: "Babylon Lite Native - PBR Shader Balls",
        parity: {
            referenceSearch: "?seekTime=0.5",
            maxFullMad: 0.001,
            maxForegroundMad: 0.004,
            backgroundColor: [20, 20, 25],
            backgroundThreshold: 30,
            // The query branch seeks on its tenth before-render callback.
            // Hold native capture until that branch has applied the pose.
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "10",
            },
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
        id: "scene160",
        name: "Scene 160 - Shader Texture Sampler",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene160.ts",
        title: "Babylon Lite Native - Shader Texture Sampler",
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
        id: "scene162",
        name: "Scene 162 - Shader Defines",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene162.ts",
        title: "Babylon Lite Native - Shader Defines",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene165",
        name: "Scene 165 - Shader Material Thin Instances",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene165.ts",
        title: "Babylon Lite Native - Shader Material Thin Instances",
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
        id: "regression-sprite-layer-arms",
        name: "Regression - Sprite Layer Arms",
        source: "examples/regression-sprite-layer-arms.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - Sprite Layer Arms",
        buildDirectory:
            "native/build-regression-sprite-layer-arms-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-sprite-layer-arms/babylon-lite-golden.png",
            },
            outputDirectory:
                "artifacts/parity/regression-sprite-layer-arms",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 15, 26],
            backgroundThreshold: 30,
            // The layer list settles inside the zero-delay timeout the
            // engine drains after frame zero, so anything past frame one
            // captures the same still state on both sides.
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "8",
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
            outputDirectory:
                "artifacts/parity/regression-instanced-ground",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
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
            outputDirectory:
                "artifacts/parity/regression-morph-ground",
            maxFullMad: 0.001,
            maxForegroundMad: 0.002,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        // Retires when a corpus scene visibly executes post-creation spot
        // direction, angle and exponent writes. Position and range already
        // have corpus coverage; the remaining writes do not.
        id: "regression-light-setters",
        name: "Regression - Light Vector Setters",
        source: "examples/regression-light-setters.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - Light Vector Setters",
        buildDirectory: "native/build-regression-light-setters-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-light-setters/babylon-lite-golden.png",
            },
            outputDirectory: "artifacts/parity/regression-light-setters",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        // Retires when a corpus scene names a component path other than
        // `position.x`; none does today, so this is the only thing that
        // measures the rest of the pin's own path surface.
        id: "regression-property-animation-paths",
        name: "Regression - Property Animation Paths",
        source: "examples/regression-property-animation-paths.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - Property Animation Paths",
        buildDirectory:
            "native/build-regression-property-animation-paths-release",
        parity: {
            referenceTimeSeconds: 1.3,
            referenceAnimationGroups: [
                "drifting",
                "stretching",
                "turning",
            ],
            reference: {
                kind: "source",
                path:
                    "reference/regression-property-animation-paths/babylon-lite-golden.png",
            },
            outputDirectory:
                "artifacts/parity/regression-property-animation-paths",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        // Retires when a corpus scene writing both flags compiles: 102, 103
        // and 118 reach the pair, each behind physics or billboard picking.
        id: "regression-mesh-flags",
        name: "Regression - Mesh Visible and Pickable",
        source: "examples/regression-mesh-flags.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - Mesh Visible and Pickable",
        buildDirectory:
            "native/build-regression-mesh-flags-release",
        parity: {
            // The pick runs on the setTimeout-0 continuation, which
            // `finish_frame` drains at the END of a frame -- after that
            // frame's capture check. So frame 0 can be captured before the
            // drain this scene registers exists, and the pick's marker never
            // reaches the picture. Holding the native capture past the
            // continuation is what makes the gate deterministic rather than
            // a race it wins most of the time.
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "8",
            },
            reference: {
                kind: "source",
                path:
                    "reference/regression-mesh-flags/babylon-lite-golden.png",
            },
            outputDirectory:
                "artifacts/parity/regression-mesh-flags",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        // Retires when a corpus scene writing a material property over
        // `scene.meshes` compiles: 166 and 179 both do, each behind the
        // clustered light container.
        id: "regression-material-falloff",
        name: "Regression - Material Falloff Write",
        source: "examples/regression-material-falloff.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - Material Falloff Write",
        buildDirectory:
            "native/build-regression-material-falloff-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-material-falloff/babylon-lite-golden.png",
            },
            outputDirectory:
                "artifacts/parity/regression-material-falloff",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
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
            referenceAnimationGroups: ["group"],
            maxFullMad: 0.05,
            maxForegroundMad: 0.2,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene154",
        name: "Scene 154 - STEP Time Animation",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene154.ts",
        title: "Babylon Lite Native - STEP Time Animation",
        parity: {
            referenceTimeSeconds: 0.75,
            referenceAnimationGroups: [
                "linearGroup",
                "stepGroup",
            ],
            maxFullMad: 0.05,
            maxForegroundMad: 0.2,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene152",
        name: "Scene 152 - Managed Animation Groups",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene152.ts",
        title: "Babylon Lite Native - Managed Animation Groups",
        parity: {
            referenceTimeSeconds: 1,
            // The scene's own manager drives both a glTF clip and a
            // camera property clip, and each group converts the pinned
            // pose through its own frame rate.
            referenceAnimationGroups: [
                "cameraGroup",
                "...(shark.animationGroups ?? [])",
            ],
            // Same shark, same pose, same residual as scene 11: the
            // skinned pose, measured 0.010/0.281 on both backends with
            // the two agreeing to one LSB, and minimal exactly at this
            // seek (0.069 at 0.98 s, 0.067 at 1.02 s), so the clock is
            // right and the difference is the palette.
            maxFullMad: 0.02,
            maxForegroundMad: 0.3,
            backgroundColor: [36, 36, 36],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene157",
        name: "Scene 157 - Weighted Skeleton Blending",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene157.ts",
        title: "Babylon Lite Native - Weighted Skeleton Blending",
        parity: {
            referenceTimeSeconds: 0.5,
            referenceAnimationGroups: ["walk", "run"],
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene158",
        name: "Scene 158 - Additive Pose Blending",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene158.ts",
        title: "Babylon Lite Native - Additive Pose Blending",
        parity: {
            // The scene's own `?seekTime=` branch freezes it: both groups
            // are written and paused, so the folded branch IS the pose on
            // both sides and no time seek is registered.
            referenceSearch: "?seekTime=1.25",
            maxFullMad: 0.001,
            maxForegroundMad: 0.004,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene155",
        name: "Scene 155 - Weighted Property Blending",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene155.ts",
        title: "Babylon Lite Native - Weighted Property Blending",
        parity: {
            referenceTimeSeconds: 0.5,
            referenceAnimationGroups: [
                "positiveGroup",
                "negativeGroup",
            ],
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene156",
        name: "Scene 156 - Manual Cross-Fade Animation",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene156.ts",
        title: "Babylon Lite Native - Manual Cross-Fade Animation",
        parity: {
            // The scene's own query branch advances the manager through the
            // fade and pauses both groups at the requested deterministic pose.
            referenceSearch: "?seekTime=1.25",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
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
        },
    },
    {
        id: "scene250",
        name: "Scene 250 - VirtualCity Cameras",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene250.ts",
        title: "Babylon Lite Native - VirtualCity Cameras",
        parity: {
            // The scene seeks itself: at its tenth frame it reads
            // `?seekTime=5` — the pin's own parity query — multiplies by
            // 60, and goToFrame-freezes every group on both sides. The
            // native run needs to reach that frame, so the capture is
            // taken at frame 10.
            referenceSearch: "?seekTime=5",
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "10",
            },
            // Measured 0.004 / 0.003 (SDL_GPU / Dawn), 99% exact and every
            // region pixel within one count on both backends — the
            // texture-interpolation floor of a fully textured cityscape.
            // Dawn's full-image max is 1; SDL_GPU's masked border carries
            // a few antialiased sky-dome edge pixels up to 22.
            maxFullMad: 0.005,
            maxForegroundMad: 0.005,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene170",
        name: "Scene 170 - Navigation Crowd",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene170.ts",
        title: "Babylon Lite Native - Navigation Crowd",
        parity: {
            // Byte-identical on both backends: the navmesh, the crowd's
            // own placement snap and the debug overlay all run the same
            // pinned recastnavigation commit, and the scene never steps
            // the crowd — so the agent sits where `addAgent` put it on
            // both sides.
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        // Retires when a corpus scene drives a crowd without depending on
        // wall-clock time: 171 and 174 both reach the calls, and both
        // register frozen because their step takes the frame delta.
        id: "regression-nav-crowd",
        name: "Regression - Navigation Crowd Step",
        source: "examples/regression-nav-crowd.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - Navigation Crowd Step",
        buildDirectory:
            "native/build-regression-nav-crowd-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-nav-crowd/babylon-lite-golden.png",
            },
            outputDirectory:
                "artifacts/parity/regression-nav-crowd",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene171",
        name: "Scene 171 - Navigation Crowd Path",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene171.ts",
        title: "Babylon Lite Native - Navigation Crowd Path",
        parity: {
            // The scene's own frozen pose; `regression-nav-crowd` carries
            // why, and measures the crowd this folds away.
            referenceSearch: "?freeze=1",
            // 0.013 / 0.028 on both backends, every region pixel within
            // one count -- scene 175's floor over a wider overlay: the
            // navmesh build runs the same pinned recastnavigation commit
            // on both sides, so the debug triangulation is identical and
            // what is left is the blended overlay's rounding.
            maxFullMad: 0.02,
            maxForegroundMad: 0.03,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene172",
        name: "Scene 172 - Navigation Tile Cache Obstacles",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene172.ts",
        title: "Babylon Lite Native - Navigation Tile Cache Obstacles",
        parity: {
            // The scene's own frozen pose, as 171 and 174 take: without
            // it the agent is mid-walk and the two sides sample the
            // crowd a different number of milliseconds in.
            referenceSearch: "?freeze=1",
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene173",
        name: "Scene 173 - Navigation Obstacle Toggle",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene173.ts",
        title: "Babylon Lite Native - Navigation Obstacle Toggle",
        parity: {
            // Frozen for the crowd, as 172 is -- and the freeze also
            // withholds the one-second obstacle toggle, so the pose both
            // sides measure is the pre-toggle navmesh the scene's own
            // header names as its reference.
            referenceSearch: "?freeze=1",
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        // Retires when a corpus scene removes an obstacle without depending
        // on wall-clock time: 173 reaches `removeObstacle` and the nullable
        // handle it holds one in, but only inside the branch its own
        // `?freeze=1` pose folds away.
        id: "regression-nav-obstacles",
        name: "Regression - Navigation Obstacle Removal",
        source: "examples/regression-nav-obstacles.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - Navigation Obstacle Removal",
        buildDirectory:
            "native/build-regression-nav-obstacles-release",
        parity: {
            reference: {
                kind: "source",
                path:
                    "reference/regression-nav-obstacles/" +
                    "babylon-lite-golden.png",
            },
            outputDirectory:
                "artifacts/parity/regression-nav-obstacles",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene174",
        name: "Scene 174 - Navigation Off-Mesh Connections",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene174.ts",
        title: "Babylon Lite Native - Navigation Off-Mesh Connections",
        parity: {
            referenceSearch: "?freeze=1",
            // 0.006 / 0.023, the same floor and the same reason as 175.
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene175",
        name: "Scene 175 - Navigation Raycast",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene175.ts",
        title: "Babylon Lite Native - Navigation Raycast",
        parity: {
            // Measured 0.006 / 0.023 on both backends, every region
            // pixel within one count: the navmesh build runs the same
            // pinned recastnavigation commit on both sides, so the
            // debug overlay triangulates identically and the residual
            // is the blended overlay's rounding floor.
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
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
            outputDirectory:
                "artifacts/parity/regression-track-clamp",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [9, 11, 18],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene110",
        name: "Scene 110 - Render Target Diffuse Texture",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene110.ts",
        title: "Babylon Lite Native - Render Target Diffuse Texture",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene120",
        name: "Scene 120 - Gaussian Splatting",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene120.ts",
        title: "Babylon Lite Native - Gaussian Splatting",
        // Dawn measures 0.001/0.003. SDL_GPU measures 0.024/0.071, and its
        // whole excess is the backend differential (SDL-vs-Dawn 0.024,
        // max 3) -- see TODO for what has been eliminated. The threshold
        // carries the SDL number because one pair covers both backends.
        parity: {
            maxFullMad: 0.03,
            maxForegroundMad: 0.08,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene125",
        name: "Scene 125 - Gaussian Splat Transform Bake",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene125.ts",
        title: "Babylon Lite Native - Gaussian Splat Transform Bake",
        // Both backends measure 0.000/0.000. What is left is the
        // multisampled splat band the other clouds carry: SDL_GPU peaks at
        // one more byte than Dawn, and the two backends differ from each
        // other by the same max as each differs from the golden, which puts
        // it on the GPU side rather than in the bake.
        parity: {
            maxFullMad: 0.01,
            maxForegroundMad: 0.01,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene126",
        name: "Scene 126 - Gaussian Splat Shader Plugin",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene126.ts",
        title: "Babylon Lite Native - Gaussian Splat Shader Plugin",
        // Not bit-stable from run to run, and the widest of the four scenes
        // that are not: `stability` measures the Dawn foreground alternating
        // between 0.001 and 0.005 across consecutive runs at 4x and every
        // run byte-identical at one sample, so the mover is multisampling
        // (SDL_GPU wobbles too, at 0.000081). The thresholds clear the band
        // rather than the median, because a gate that fails on the coin flip
        // measures nothing; `scene-neutrality.ts` carries the measurement.
        parity: {
            maxFullMad: 0.003,
            maxForegroundMad: 0.007,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene127",
        name: "Scene 127 - Gaussian Splat Linear Depth",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene127.ts",
        title: "Babylon Lite Native - Gaussian Splat Linear Depth",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [255, 255, 255],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene128",
        name: "Scene 128 - Gaussian Splat Alpha-Blended Depth",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene128.ts",
        title: "Babylon Lite Native - Gaussian Splat Alpha-Blended Depth",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [255, 255, 255],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene129",
        name: "Scene 129 - Gaussian Splat GPU Picking",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene129.ts",
        title: "Babylon Lite Native - Gaussian Splat GPU Picking",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.005,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
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
        id: "scene117",
        name: "Scene 117 - 2D Sprite Picking",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene117.ts",
        title: "Babylon Lite Native - 2D Sprite Picking",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [18, 20, 31],
            backgroundThreshold: 30,
            // The post-start continuation applies the CPU pick after native
            // frame zero. Let that callback register its bounded settle gate
            // before capture becomes eligible.
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "1",
            },
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
        id: "scene269",
        name: "Scene 269 - Mirrored Transform Reparenting",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene269.ts",
        title: "Babylon Lite Native - Mirrored Transform Reparenting",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.01,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene270",
        name: "Scene 270 - Mirrored Standard Meshes",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene270.ts",
        title: "Babylon Lite Native - Mirrored Standard Meshes",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [38, 41, 56],
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
        },
    },
    {
        id: "scene23",
        name: "Scene 23 - PBR Anisotropy",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene23.ts",
        title: "Babylon Lite Native - PBR Anisotropy",
        parity: {
            // The pin's own spec serves this scene at `?seekTime=0`, which
            // freezes the animated intensity at one and skips the
            // per-frame writer. Both sides read the same query.
            referenceSearch: "?seekTime=0",
            // Measured 0.002 / 0.017 on both backends, every differing
            // pixel within one byte and all of them on the sphere. A
            // mirror-metal material samples the specular cube at mip 0
            // through a derivative-derived reflection, which resolves a
            // last-bit difference in the interpolated frame as a
            // one-step colour difference.
            maxFullMad: 0.003,
            maxForegroundMad: 0.02,
            backgroundColor: [53, 53, 82],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene40",
        name: "Scene 40 - Havok Sphere Drop",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene40.ts",
        title: "Babylon Lite Native - Physics Sphere Drop",
        parity: {
            // The pin's own spec (`tests/lite/parity/scenes/
            // scene40-physics.spec.ts`) serves this scene at
            // `?captureFrame=120` and waits for the `captureReady` flag
            // the scene raises when its 120th physics step lands. Both
            // sides read the same query, and both freeze themselves: the
            // browser through `stopEngine` in a zero-delay `setTimeout`,
            // and the native run through the same lowered call.
            referenceSearch: "?captureFrame=120",
            // MEASURED, and the number is a solver difference rather than
            // a port defect -- see docs/fidelity.md#physics-contract. This
            // is the one gate in the repository whose threshold does not
            // assert agreement with the pinned engine: Bullet and Havok
            // integrate different contact models, so at a moving pose
            // they place the sphere differently by construction. The
            // ceiling is set just above what was measured, which makes it
            // a REGRESSION gate on this port's own solver -- it catches
            // the sphere landing somewhere new -- and nothing more.
            maxFullMad: 0.333,
            maxForegroundMad: 0.778,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                // The scene stops its own engine at step 120, so this only
                // has to name a frame after the freeze: the run reaches it
                // with nothing advancing, captures, and ends. The parity
                // runner derives the frame limit from this, so there is no
                // BBLITE_MAX_FRAMES to set beside it.
                BBLITE_SCREENSHOT_FRAME: "130",
            },
        },
    },
    {
        id: "scene179",
        name: "Scene 179 - Clustered Sponza Lights",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene179.ts",
        title: "Babylon Lite Native - Clustered Sponza Lights",
        parity: {
            // A thousand clustered point lights over Khronos Sponza, binned
            // into 64x64 screen tiles and 16 depth slices every frame. Both
            // backends render it byte-identically to the browser, so the
            // ceilings sit just above zero.
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene166",
        name: "Scene 166 - Clustered Sponza Spot Lights",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene166.ts",
        title: "Babylon Lite Native - Clustered Sponza Spot Lights",
        parity: {
            // The spot arm of the same field: each light adds the pin's
            // glTF-style smooth cone on top of the shared range falloff, and
            // the container's stride widens from two texels to three, which
            // is what makes it a different composed fragment.
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene100",
        name: "Scene 100 - Havok Collision Event",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene100.ts",
        title: "Babylon Lite Native - Physics Collision Event",
        parity: {
            // Scene 40 plus a registered collision event, and the pin's own
            // spec (`tests/lite/parity/scenes/
            // scene100-physics-collision.spec.ts`) says so: "the collision
            // event is non-visual, so the captured frame is identical to
            // scene 40". It serves the same `?captureFrame=120` and waits on
            // the same `captureReady` flag. This row is what puts the
            // collision surface -- `setPhysicsBodyCollisionEventsEnabled` and
            // an `onPhysicsCollision` handler whose whole body erases -- under
            // a corpus gate rather than only under Racer's.
            referenceSearch: "?captureFrame=120",
            // The golden is byte-identical to scene 40's, which is why the
            // ceiling is: it is the same measurement, and the same
            // solver-distance reasoning -- docs/fidelity.md#physics-contract.
            // The file is kept separate rather than pointed at scene 40's
            // because `parity --recapture-reference` writes through this path,
            // and a shared one would let a scene 100 refresh overwrite scene
            // 40's evidence. `reference/exact-corpus-manifest.json` records
            // both digests, so the identity stays checked.
            maxFullMad: 0.333,
            maxForegroundMad: 0.778,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "130",
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
        },
    },
    {
        id: "scene16",
        name: "Scene 16 - Thin Instances",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene16.ts",
        title: "Babylon Lite Native - Thin Instances",
        parity: {
            // Served bare. The scene's own `?culling` arm reaches
            // `enableThinInstanceGpuCulling`, which is not lowered, so the
            // registered pose is the one the pin serves with no query.
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene43",
        name: "Scene 43 - Parametric Proximity Path",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene43.ts",
        title: "Babylon Lite Native - Parametric Proximity Path",
        parity: {
            // The scene animates a ball around a 480-frame circle and is
            // only deterministic at a named frame, which its own
            // `?captureFrame=` branch stops the engine on. 120 is the
            // quarter turn; both sides read the same query, so the pose is
            // the scene's own rather than whichever frame a harness
            // happened to reach.
            referenceSearch: "?captureFrame=120",
            // The browser stops itself on that frame; the native driver has
            // to be told to hold its capture until the same one, or it
            // screenshots frame 0 and measures a different quarter turn.
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "120",
            },
            maxFullMad: 0.001,
            maxForegroundMad: 0.004,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene38",
        name: "Scene 38 - Mesh Builder Gallery",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene38.ts",
        title: "Babylon Lite Native - Mesh Builders",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
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
    {
        id: "scene51",
        name: "Scene 51 - Soft-Edged Sprite Grid",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene51.ts",
        title: "Babylon Lite Native - Soft-Edged Sprite Grid",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [18, 20, 31],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene52",
        name: "Scene 52 - HUD on 3D",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene52.ts",
        title: "Babylon Lite Native - HUD on 3D",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene53",
        name: "Scene 53 - Depth-Hosted Sprites",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene53.ts",
        title: "Babylon Lite Native - Depth-Hosted Sprites",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene56",
        name: "Scene 56 - Axis-Locked Billboards",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene56.ts",
        title: "Babylon Lite Native - Axis-Locked Billboards",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [36, 41, 51],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene57",
        name: "Scene 57 - Cutout Billboards",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene57.ts",
        title: "Babylon Lite Native - Cutout Billboards",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [23, 28, 36],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene92",
        name: "Scene 92 - Sprite Custom Shader",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene92.ts",
        title: "Babylon Lite Native - Sprite Custom Shader",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [18, 20, 31],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene93",
        name: "Scene 93 - Sprite Palette Shader",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene93.ts",
        title: "Babylon Lite Native - Sprite Palette Shader",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 15, 23],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene94",
        name: "Scene 94 - Billboard Custom Shader",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene94.ts",
        title: "Babylon Lite Native - Billboard Custom Shader",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [41, 46, 56],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene95",
        name: "Scene 95 - Billboard Palette Shader",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene95.ts",
        title: "Babylon Lite Native - Billboard Palette Shader",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [41, 46, 56],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene96",
        name: "Scene 96 - Sprite UV Scroll",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene96.ts",
        title: "Babylon Lite Native - Sprite UV Scroll",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 15, 23],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene97",
        name: "Scene 97 - Sprite Multiply Blend",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene97.ts",
        title: "Babylon Lite Native - Sprite Multiply Blend",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [209, 204, 219],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene54",
        name: "Scene 54 - Facing Billboards",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene54.ts",
        title: "Babylon Lite Native - Facing Billboards",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [41, 46, 56],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene55",
        name: "Scene 55 - Billboard Field",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene55.ts",
        title: "Babylon Lite Native - Billboard Field",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene98",
        name: "Scene 98 - Billboard Sprites",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene98.ts",
        title: "Babylon Lite Native - Billboard Sprites",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene99",
        name: "Scene 99 - Bone Control",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene99.ts",
        title: "Babylon Lite Native - Bone Control",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene177",
        name: "Scene 177 - Iridescence Sphere",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene177.ts",
        title: "Babylon Lite Native - Iridescence Sphere",
        parity: {
            maxFullMad: 0.025,
            maxForegroundMad: 0.025,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene26",
        name: "Scene 26 - PBR Subsurface",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene26.ts",
        title: "Babylon Lite Native - PBR Subsurface",
        parity: {
            // The pin's parity test freezes the orbit at three seconds by
            // serving this exact query. Compilation folds the same search
            // string, so browser and native both execute updateOrbit once
            // at the identical 180-step pose.
            referenceSearch: "?seekTime=3",
            // Measured 0.000107 / 0.000107 on SDL_GPU and 0.000104 /
            // 0.000104 on Dawn; the two native backends differ by
            // 0.000003 MAD and every cross-backend pixel is within one.
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene27",
        name: "Scene 27 - Material Variants",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene27.ts",
        title: "Babylon Lite Native - Material Variants",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.005,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene142",
        name: "Scene 142 - Post-Process Viewports",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene142.ts",
        title: "Babylon Lite Native - Post-Process Viewports",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [31, 59, 107],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene143",
        name: "Scene 143 - Post-Process Chain",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene143.ts",
        title: "Babylon Lite Native - Post-Process Chain",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene147",
        name: "Scene 147 - Circle of Confusion",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene147.ts",
        title: "Babylon Lite Native - Circle of Confusion",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [255, 255, 255],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene11",
        name: "Scene 11 - Spec-Gloss Shark",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene11.ts",
        title: "Babylon Lite Native - Spec-Gloss Shark",
        parity: {
            // Animated: the swim cycle is pinned to one frame on both sides,
            // or the browser and the native run free-run to different poses.
            referenceTimeSeconds: 1,
            // The residual is the skinned pose, not the material: the
            // composed fragment is byte-identical to the browser's, and
            // `scene -- diff` names two bone-palette matrices the browser
            // never uploaded. Measured at several seeks; one second is where
            // the two agree most closely.
            maxFullMad: 0.02,
            maxForegroundMad: 0.3,
            backgroundColor: [36, 36, 36],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene148",
        name: "Scene 148 - Depth of Field",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene148.ts",
        title: "Babylon Lite Native - Depth of Field",
        parity: {
            maxFullMad: 0.003,
            maxForegroundMad: 0.003,
            backgroundColor: [255, 255, 255],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene58",
        name: "Scene 58 - Sprite2D Frame Animation",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene58.ts",
        title: "Babylon Lite Native - Sprite2D Animation",
        parity: {
            // The scene's own frozen pose, which its pinned parity spec
            // drives it at: the manager steps on a counted loop of fixed
            // 1/60 s steps, so both sides land on the same frame.
            referenceSearch: "?seekTime=0.72",
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            backgroundColor: [18, 23, 31],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene59",
        name: "Scene 59 - Billboard Sprite Frame Animation",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene59.ts",
        title: "Babylon Lite Native - Billboard Sprite Animation",
        parity: {
            referenceSearch: "?seekTime=0.72",
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            backgroundColor: [18, 23, 31],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene60",
        name: "Scene 60 - NME Flat Colour",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene60.ts",
        title: "Babylon Lite Native - NME Flat Colour",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene64",
        name: "Scene 64 - NME Morph Targets",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene64.ts",
        title: "Babylon Lite Native - NME Morph Targets",
        parity: {
            referenceSearch: "?freeze=1",
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene61",
        name: "Scene 61 - NME Normal Colour",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene61.ts",
        title: "Babylon Lite Native - NME Normal Colour",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene77",
        name: "Scene 77 - NME Pass-Through Blocks",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene77.ts",
        title: "Babylon Lite Native - NME Pass-Through Blocks",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene78",
        name: "Scene 78 - NME Math Blocks",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene78.ts",
        title: "Babylon Lite Native - NME Math Blocks",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene79",
        name: "Scene 79 - NME Curves and Waves",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene79.ts",
        title: "Babylon Lite Native - NME Curves and Waves",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene80",
        name: "Scene 80 - NME Colour Blocks",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene80.ts",
        title: "Babylon Lite Native - NME Colour Blocks",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene82",
        name: "Scene 82 - NME Procedural Noise",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene82.ts",
        title: "Babylon Lite Native - NME Procedural Noise",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene83",
        name: "Scene 83 - NME Normals",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene83.ts",
        title: "Babylon Lite Native - NME Normals",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene85",
        name: "Scene 85 - NME Matrix Blocks",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene85.ts",
        title: "Babylon Lite Native - NME Matrix Blocks",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [5, 5, 9],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene88",
        name: "Scene 88 - NME Loop Block",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene88.ts",
        title: "Babylon Lite Native - NME Loop Block",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene89",
        name: "Scene 89 - NME Storage Blocks",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene89.ts",
        title: "Babylon Lite Native - NME Storage Blocks",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene63",
        name: "Scene 63 - NME Directional Light",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene63.ts",
        title: "Babylon Lite Native - NME Directional Light",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene67",
        name: "Scene 67 - NME PBR Core",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene67.ts",
        title: "Babylon Lite Native - NME PBR Core",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.003,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene68",
        name: "Scene 68 - NME PBR Clearcoat",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene68.ts",
        title: "Babylon Lite Native - NME PBR Clearcoat",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.005,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene69",
        name: "Scene 69 - NME PBR Sheen",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene69.ts",
        title: "Babylon Lite Native - NME PBR Sheen",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.010,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene70",
        name: "Scene 70 - NME PBR Anisotropy",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene70.ts",
        title: "Babylon Lite Native - NME PBR Anisotropy",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.025,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene71",
        name: "Scene 71 - NME PBR Subsurface",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene71.ts",
        title: "Babylon Lite Native - NME PBR Subsurface",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.010,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene84",
        name: "Scene 84 - NME Fragment Depth",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene84.ts",
        title: "Babylon Lite Native - NME Fragment Depth",
        parity: {
            maxFullMad: 0.010,
            maxForegroundMad: 0.010,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene62",
        name: "Scene 62 - NME Diffuse Texture",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene62.ts",
        title: "Babylon Lite Native - NME Diffuse Texture",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene81",
        name: "Scene 81 - NME UV Projection",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene81.ts",
        title: "Babylon Lite Native - NME UV Projection",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene87",
        name: "Scene 87 - NME Iridescence and Image Processing",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene87.ts",
        title: "Babylon Lite Native - NME Iridescence",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [4, 4, 6],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene74",
        name: "Scene 74 - Effect Renderer",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene74.ts",
        title: "Babylon Lite Native - Effect Renderer",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            // The effect covers the frame, so the renderer's own clear
            // colour reaches no pixel and the whole image is foreground.
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene75",
        name: "Scene 75 - Effect Render Target",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene75.ts",
        title: "Babylon Lite Native - Effect Render Target",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene76",
        name: "Scene 76 - Effect Texture",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene76.ts",
        title: "Babylon Lite Native - Effect Texture",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene262",
        name: "Scene 262 - NPE Particle Size",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene262.ts",
        title: "Babylon Lite Native - Particle Size",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            // The particle field is drawn over a black clear; every lit
            // pixel is a billboard.
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene263",
        name: "Scene 263 - NPE Particle Gravity",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene263.ts",
        title: "Babylon Lite Native - Particle Gravity",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            // The particle field is drawn over a black clear; every lit
            // pixel is a billboard.
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene264",
        name: "Scene 264 - NPE Particle Sphere Emitter",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene264.ts",
        title: "Babylon Lite Native - Particle Sphere Emitter",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            // The particle field is drawn over a black clear; every lit
            // pixel is a billboard.
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene276",
        name: "Scene 276 - NPE Sprite Sheet Particles",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene276.ts",
        title: "Babylon Lite Native - Particle Sprite Sheet",
        parity: {
            maxFullMad: 0.001,
            // One LSB on 0.31% of the sprite pixels, and only on SDL_GPU:
            // the offline DXC compile rounds where the browser's own
            // compiler does not. Dawn, which runs that compiler, is exact.
            maxForegroundMad: 0.003,
            dawnThresholds: {
                maxFullMad: 0.001,
                maxForegroundMad: 0.001,
            },
            // The particle field is drawn over a black clear; every lit
            // pixel is a billboard.
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene277",
        name: "Scene 277 - NPE Attractor Update",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene277.ts",
        title: "Babylon Lite Native - Particle Attractor",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            // The particle field is drawn over a black clear; every lit
            // pixel is a billboard.
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene280",
        name: "Scene 280 - NPE Flow Map Update",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene280.ts",
        title: "Babylon Lite Native - Particle Flow Map",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            // The particle field is drawn over a black clear; every lit
            // pixel is a billboard.
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene281",
        name: "Scene 281 - NPE Noise Update",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene281.ts",
        title: "Babylon Lite Native - Particle Noise",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            // The particle field is drawn over a black clear; every lit
            // pixel is a billboard.
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene283",
        name: "Scene 283 - NPE Multiply Blend",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene283.ts",
        title: "Babylon Lite Native - Particle Multiply",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            // The warm destination the Multiply pass darkens; a fully
            // transparent texel has to leave it untouched.
            backgroundColor: [166, 115, 64],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene284",
        name: "Scene 284 - NPE MultiplyAdd Blend",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene284.ts",
        title: "Babylon Lite Native - Particle MultiplyAdd",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [166, 115, 64],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene278",
        name: "Scene 278 - Line System",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene278.ts",
        title: "Babylon Lite Native - Line System",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [6, 9, 17],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene279",
        name: "Scene 279 - Line System Update",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene279.ts",
        title: "Babylon Lite Native - Line System Update",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [5, 6, 13],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene301",
        name: "Scene 301 - NPE Sprite2D Blend Modes",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene301.ts",
        title: "Babylon Lite Native - Particle Sprite2D",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [166, 115, 64],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene282",
        name: "Scene 282 - Standard UV Transform",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene282.ts",
        title: "Babylon Lite Native - Standard UV Transform",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [9, 11, 18],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene220",
        name: "Scene 220 - Quantized Duck",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene220.ts",
        title: "Babylon Lite Native - Quantized Duck",
        parity: {
            maxFullMad: 0.002,
            maxForegroundMad: 0.003,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene211",
        name: "Scene 211 - BrainStem Meshopt",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene211.ts",
        title: "Babylon Lite Native - BrainStem Meshopt",
        parity: {
            referenceSearch: "?seekTime=0.5",
            // The scene applies its deterministic pose on its tenth
            // before-render callback, so native capture must reach it too.
            nativeEnvironment: {
                BBLITE_SCREENSHOT_FRAME: "10",
            },
            // Measured 0.000064 / 0.001888 on both backends, whose
            // captures are byte-identical. The residual is confined to
            // the skinned silhouette's antialiased edge.
            maxFullMad: 0.001,
            maxForegroundMad: 0.003,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene229",
        name: "Scene 229 - Triangle Without Indices",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene229.ts",
        title: "Babylon Lite Native - Triangle Without Indices",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene25",
        name: "Scene 25 - KTX Compressed Texture",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene25.ts",
        title: "Babylon Lite Native - KTX Compressed Texture",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene36",
        name: "Scene 36 - Basis Universal Texture",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene36.ts",
        title: "Babylon Lite Native - Basis Universal Texture",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene251",
        name: "Scene 251 - Animation Group Mask",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene251.ts",
        title: "Babylon Lite Native - Animation Group Mask",
        parity: {
            // The scene poses itself: it stops every clip, masks the walk's
            // lower body, and calls goToFrame with the engine so the stopped
            // group's controller still ticks. Nothing free-runs, so the gate
            // needs no seek of its own.
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene18",
        name: "Scene 18 - PCF Spotlight Shadows",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene18.ts",
        title: "Babylon Lite Native - PCF Spotlight Shadows",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene4",
        name: "Scene 4 - ESM Directional and PCF Spot Shadows",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene4.ts",
        title: "Babylon Lite Native - Shadows",
        parity: {
            maxFullMad: 0.3,
            maxForegroundMad: 0.3,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene203",
        name: "Scene 203 - Floating Origin Spot Light",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene203.ts",
        title: "Babylon Lite Native - Large World Spot",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 13, 20],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene205",
        name: "Scene 205 - Floating Origin Facing Billboards",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene205.ts",
        title: "Babylon Lite Native - Large World Billboards",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [41, 46, 56],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene204",
        name: "Scene 204 - Floating Origin Thin Instances",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene204.ts",
        title: "Babylon Lite Native - Large World Thin Instances",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 13, 20],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene206",
        name: "Scene 206 - Floating Origin Cutout Billboards",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene206.ts",
        title: "Babylon Lite Native - Large World Cutout Billboards",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [23, 28, 36],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene207",
        name: "Scene 207 - Floating Origin Directional Shadows",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene207.ts",
        title: "Babylon Lite Native - Large World Directional Shadows",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 13, 20],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene200",
        name: "Scene 200 - High-Precision Matrix Off",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene200.ts",
        title: "Babylon Lite Native - HPM Jitter",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 13, 20],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene201",
        name: "Scene 201 - High-Precision Matrix On",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene201.ts",
        title: "Babylon Lite Native - HPM Jitter",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 13, 20],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene202",
        name: "Scene 202 - Floating Origin Point Light",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene202.ts",
        title: "Babylon Lite Native - Large World Rendering",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 13, 20],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene65",
        name: "Scene 65 - Node Material Shadow Receiver",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene65.ts",
        title: "Babylon Lite Native - Node Material Shadows",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene141",
        name: "Scene 141 - Node, Standard and PBR ESM Casters",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene141.ts",
        title: "Babylon Lite Native - Mixed ESM Casters",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene22",
        name: "Scene 22 - PBR Shadow Receiver",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene22.ts",
        title: "Babylon Lite Native - PBR Shadows",
        parity: {
            maxFullMad: 0.3,
            maxForegroundMad: 0.3,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "regression-gltf-sparse",
        name: "Regression - glTF Sparse Accessors",
        source: "examples/regression-gltf-sparse.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - glTF Sparse Accessors",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 15, 23],
            backgroundThreshold: 30,
        },
    },
    {
        id: "regression-gltf-uv-sets",
        name: "Regression - glTF UV Sets",
        source: "examples/regression-gltf-uv-sets.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - glTF UV Sets",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [13, 15, 23],
            backgroundThreshold: 30,
        },
    },
    {
        id: "regression-gltf-topology",
        name: "Regression - glTF Primitive Topology",
        source: "examples/regression-gltf-topology.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - glTF Primitive Topology",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [10, 13, 20],
            backgroundThreshold: 30,
        },
    },
    {
        id: "regression-gltf-step-animation",
        name: "Regression - glTF STEP Animation",
        source: "examples/regression-gltf-step-animation.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - glTF STEP Animation",
        parity: {
            // Inside the second STEP span, where a LINEAR reading would be
            // halfway to the third key rather than holding the second.
            referenceTimeSeconds: 0.75,
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [10, 13, 20],
            backgroundThreshold: 30,
        },
    },
    {
        // Retires when a corpus scene casts a shadow from a PBR mesh with
        // no Standard material in the scene.
        id: "regression-shadow-pbr-only",
        name: "Regression - PBR Shadow Receiver Without Standard",
        source: "examples/regression-shadow-pbr-only.ts",
        sourceOrigin: "bblitec-regression",
        title: "Babylon Lite Native - PBR Shadows Without Standard",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene144",
        name: "Scene 144 - Bloom",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene144.ts",
        title: "Babylon Lite Native - Bloom",
        parity: {
            maxFullMad: 0.01,
            maxForegroundMad: 0.03,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene217",
        name: "Scene 217 - Material Plugins",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene217.ts",
        title: "Babylon Lite Native - Material Plugins",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [89, 115, 153],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene17",
        name: "Scene 17 - PBR and Standard Thin Instances",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene17.ts",
        title: "Babylon Lite Native - PBR and Standard Thin Instances",
        parity: {
            // 0.000053 / 0.000366 on SDL_GPU and 0.000052 / 0.000357
            // on Dawn. Every differing channel is one count; keep the gate
            // just above that measured envelope.
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene20",
        name: "Scene 20 - PBR Emissive Sphere Grid",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene20.ts",
        title: "Babylon Lite Native - PBR Emissive Sphere Grid",
        parity: {
            // The scene owns its deterministic parity pose: this query makes
            // its first before-render callback freeze before rotating any of
            // the 2,500 parented spheres. The compiler folds the same search.
            referenceSearch: "?seekTime=0",
            // 0.001978 / 0.006782 on SDL_GPU and 0.001976 / 0.006774
            // on Dawn, with every differing channel within one count.
            maxFullMad: 0.003,
            maxForegroundMad: 0.008,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene66",
        name: "Scene 66 - NME Full Playground",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene66.ts",
        title: "Babylon Lite Native - NME Full Playground",
        parity: {
            referenceSearch: "?freeze=1",
            // 0.000017 / 0.000133 on SDL_GPU and 0.000013 / 0.000097
            // on Dawn; every differing channel is within one count.
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene72",
        name: "Scene 72 - NME PBR Full",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene72.ts",
        title: "Babylon Lite Native - NME PBR Full",
        parity: {
            // 0.001272 / 0.010768 on SDL_GPU and 0.001272 / 0.010775
            // on Dawn; every differing channel is within two counts.
            maxFullMad: 0.002,
            maxForegroundMad: 0.012,
            backgroundColor: [153, 204, 255],
            backgroundThreshold: 30,
        },
    },
    {
        id: "scene271",
        name: "Scene 271 - Shadow Light Rebuild",
        source: "corpus/babylon-lite/lab/lite/src/lite/scene271.ts",
        title: "Babylon Lite Native - Shadow Light Rebuild",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 76],
            backgroundThreshold: 30,
        },
    },
    {
        id: "tetris",
        name: "Tetris",
        source: "corpus/babylon-lite/lab/lite/src/demos/tetris.ts",
        sourceOrigin: "babylon-lite-application",
        title: "Babylon Lite Native - Tetris",
        parity: {
            maxFullMad: 1.4,
            maxForegroundMad: 1.1,
            // Canvas-only lane: 0.093 / 0.101 on both backends
            // (docs/status.md row note). The gate is the exact pair the
            // canvas-golden era enforced before the full-page promotion,
            // so a 3D regression cannot hide under the UI font residual
            // the composite thresholds above must absorb.
            canvasThresholds: { maxFullMad: 0.15, maxForegroundMad: 0.15 },
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            nativeEnvironment: adHocCaptureEnvironment(),
        },
    },
    {
        id: "doom",
        name: "Doom",
        source: "corpus/babylon-lite/lab/lite/src/demos/doom.ts",
        sourceOrigin: "babylon-lite-application",
        title: "Babylon Lite Native - Doom",
        parity: {
            maxFullMad: 0.6,
            maxForegroundMad: 0.6,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            nativeEnvironment: adHocCaptureEnvironment(),
        },
    },
    {
        id: "quake",
        name: "LibreQuake",
        source: "corpus/babylon-lite/lab/lite/src/demos/quake.ts",
        sourceOrigin: "babylon-lite-application",
        title: "Babylon Lite Native - LibreQuake",
        parity: {
            maxFullMad: 0.1,
            maxForegroundMad: 0.1,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            nativeEnvironment: adHocCaptureEnvironment(),
        },
    },
    {
        id: "torus-states",
        name: "Torus States",
        source: "corpus/babylon-lite/lab/lite/src/demos/torus-states.ts",
        sourceOrigin: "babylon-lite-application",
        title: "Babylon Lite Native - Torus States",
        parity: {
            maxFullMad: 0.25,
            maxForegroundMad: 0.25,
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 8,
            nativeEnvironment: {
                ...adHocCaptureEnvironment(),
                // The immutable browser reference reaches its measured
                // post-start settle pose on this fixed-rate frame.
                BBLITE_SCREENSHOT_FRAME: "185",
            },
        },
    },
    {
        id: "platformer",
        name: "Platformer",
        source: "corpus/babylon-lite/lab/lite/src/demos/platformer.ts",
        sourceOrigin: "babylon-lite-application",
        title: "Babylon Lite Native - Platformer",
        parity: {
            referenceFrame: 180,
            maxFullMad: 1.1,
            maxForegroundMad: 1.1,
            // Canvas-only lane: 0.013 / 0.013 SDL_GPU and 0.010 / 0.010
            // Dawn (docs/status.md row note); the canvas-golden era's own
            // enforced pair.
            canvasThresholds: { maxFullMad: 0.05, maxForegroundMad: 0.05 },
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            nativeEnvironment: fixedCaptureEnvironment(),
        },
    },
    {
        id: "break-meshes",
        name: "Break Meshes",
        source: "corpus/babylon-lite/lab/lite/src/demos/break-meshes.ts",
        sourceOrigin: "babylon-lite-application",
        title: "Babylon Lite Native - Break Meshes",
        parity: {
            maxFullMad: 0.001,
            maxForegroundMad: 0.001,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            nativeEnvironment: adHocCaptureEnvironment(),
        },
    },
    {
        id: "racer",
        name: "Racer",
        source: "corpus/babylon-lite/lab/lite/src/demos/racer.ts",
        sourceOrigin: "babylon-lite-application",
        title: "Babylon Lite Native - Racer",
        nativeHostUi: "ui/racer-host.json",
        parity: {
            referenceFrame: 180,
            maxFullMad: 1.2,
            maxForegroundMad: 1.2,
            // Canvas-only lane: 0.455 / 0.455 on both backends
            // (docs/status.md row note); the canvas-golden era's own
            // enforced pair.
            canvasThresholds: { maxFullMad: 0.5, maxForegroundMad: 0.5 },
            backgroundColor: [158, 204, 235],
            backgroundThreshold: 30,
            nativeEnvironment: fixedCaptureEnvironment(),
        },
    },
    {
        id: "littlest-tokyo",
        name: "Littlest Tokyo",
        source: "corpus/babylon-lite/lab/lite/src/demos/littlest-tokyo.ts",
        sourceOrigin: "babylon-lite-application",
        title: "Babylon Lite Native - Littlest Tokyo",
        nativeHostUi: "ui/littlest-tokyo-host.json",
        parity: {
            referenceFrame: 180,
            maxFullMad: 0.2,
            maxForegroundMad: 0.2,
            backgroundColor: [213, 204, 195],
            backgroundThreshold: 30,
            nativeEnvironment: fixedCaptureEnvironment(),
        },
    },
    {
        id: "bath-day",
        name: "Bath Day",
        source: "corpus/babylon-lite/lab/lite/src/demos/bath-day.ts",
        sourceOrigin: "babylon-lite-application",
        title: "Babylon Lite Native - Bath Day",
        nativeHostUi: "ui/bath-day-host.json",
        parity: {
            referenceFrame: 180,
            maxFullMad: 0.2,
            maxForegroundMad: 0.2,
            backgroundColor: [184, 151, 115],
            backgroundThreshold: 30,
            nativeEnvironment: fixedCaptureEnvironment(),
        },
    },
    {
        id: "freeciv",
        name: "Freeciv",
        source: "corpus/babylon-lite/lab/lite/src/demos/freeciv.ts",
        sourceOrigin: "babylon-lite-application",
        title: "Babylon Lite Native - Freeciv",
        parity: {
            referenceFrame: 180,
            maxFullMad: 0.5,
            maxForegroundMad: 0.5,
            backgroundColor: [38, 74, 115],
            backgroundThreshold: 30,
            nativeEnvironment: fixedCaptureEnvironment(),
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
    const parityWithSeek = {
        ...parity,
        ...derivedSeekEnvironment(scene.id, parity),
    };
    const parityWithFrame = {
        ...parityWithSeek,
        ...derivedReferenceFrameEnvironment(
            scene.id,
            parityWithSeek,
        ),
    };
    return {
        ...resolved,
        parity: {
            ...parityWithFrame,
            reference: parity.reference ?? {
                kind: "source",
                path: `reference/${scene.id}/babylon-lite-golden.png`,
            },
            outputDirectory:
                parity.outputDirectory ??
                `artifacts/parity/${scene.id}`,
        },
    };
}

/** One frame index for the deterministic browser RAF and native capture. */
function derivedReferenceFrameEnvironment(
    sceneId: string,
    parity: NonNullable<SceneInput["parity"]>,
): { nativeEnvironment?: Record<string, string> } {
    const frame = parity.referenceFrame;
    const explicit =
        parity.nativeEnvironment?.BBLITE_SCREENSHOT_FRAME;
    if (frame === undefined) return {};
    if (!Number.isInteger(frame) || frame < 1) {
        throw new Error(
            `Scene '${sceneId}' has invalid referenceFrame=${frame}.`,
        );
    }
    if (explicit !== undefined && Number(explicit) !== frame) {
        throw new Error(
            `Scene '${sceneId}' spells its capture frame twice and they disagree: ` +
                `referenceFrame=${frame} but BBLITE_SCREENSHOT_FRAME='${explicit}'.`,
        );
    }
    return {
        nativeEnvironment: {
            ...parity.nativeEnvironment,
            BBLITE_SCREENSHOT_FRAME: String(frame),
        },
    };
}

/**
 * The measured pose, spelled once. `referenceTimeSeconds` is where the
 * registry pins it (the browser capture and `capture --native`/`diff`
 * read it), and the native parity run reads
 * `nativeEnvironment.BBLITE_ANIMATION_SEEK_SECONDS` — 23 entries used to
 * hand-pair the two with nothing enforcing the pairing, and drift would
 * have split rung 1 from rung 3 silently. The env var is derived here;
 * an entry that still spells it must agree numerically (a different
 * spelling of the same number, `"1.0"` for 1, is kept as written) and a
 * disagreement refuses loudly rather than letting either copy win.
 */
function derivedSeekEnvironment(
    sceneId: string,
    parity: NonNullable<SceneInput["parity"]>,
): { nativeEnvironment?: Record<string, string> } {
    const pose = parity.referenceTimeSeconds;
    const explicit =
        parity.nativeEnvironment?.BBLITE_ANIMATION_SEEK_SECONDS;
    if (pose === undefined) {
        if (explicit !== undefined) {
            throw new Error(
                `Scene '${sceneId}' sets BBLITE_ANIMATION_SEEK_SECONDS=${explicit} ` +
                    "with no referenceTimeSeconds: the native side would render a pose " +
                    "the browser capture never sees. Pin referenceTimeSeconds instead.",
            );
        }
        return {};
    }
    if (explicit !== undefined && Number(explicit) !== pose) {
        throw new Error(
            `Scene '${sceneId}' spells its pose twice and they disagree: ` +
                `referenceTimeSeconds=${pose} but ` +
                `BBLITE_ANIMATION_SEEK_SECONDS='${explicit}'. One pose, one spelling.`,
        );
    }
    return {
        nativeEnvironment: {
            ...parity.nativeEnvironment,
            BBLITE_ANIMATION_SEEK_SECONDS: explicit ?? String(pose),
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
            outputDirectory: `artifacts/parity/${id}`,
            backgroundColor: [51, 51, 77],
            backgroundThreshold: 30,
            // Browser captures settle for a fixed wall-clock span. Simulate
            // the same span deterministically without asking an external
            // source to carry harness-only timing edits.
            nativeEnvironment: adHocCaptureEnvironment(),
        },
    };
}
import { existsSync, statSync } from "node:fs";
import {
    adHocCaptureEnvironment,
    fixedCaptureEnvironment,
} from "./capture-timing.js";
import {
    basename,
    extname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from "node:path";
