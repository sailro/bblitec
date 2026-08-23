// The adaptations manifest: what the native build changed and why.
//
// Each entry names one deliberate divergence from browser semantics
// that this compilation actually took -- erased browser setup,
// synchronous awaits, materialized assets, the platform and renderer
// boundaries -- with its risk and the validation that covers it. The
// list is derived from what the compiler reached, so a scene that
// never touched a subsystem carries no entry for it.
import type { CompileAdaptation } from "../fidelity.js";
import type {
    CompileAsset,
    CompiledShaderProgram,
    Feature,
    GeometryOutputTaskManifest,
} from "./types.js";

export interface AdaptationContext {
    readonly hasMainEntry: boolean;
    readonly erasedBrowserExpressions: ReadonlySet<number>;
    readonly erasedBrowserInstrumentation: ReadonlySet<number>;
    readonly unwrappedAwaitExpressions: ReadonlySet<number>;
    readonly jsDataReached: boolean;
    readonly jsRandomReached: boolean;
    readonly assets: ReadonlyMap<string, CompileAsset>;
    readonly reachedShaderPrograms: readonly CompiledShaderProgram[];
    readonly geometryOutputTasks: readonly GeometryOutputTaskManifest[];
    readonly defaultRenderTaskAdapted: boolean;
}

export function compileAdaptations(
    context: AdaptationContext,
    features: Feature[],
): CompileAdaptation[] {
    const adaptations: CompileAdaptation[] = [];
    if (context.hasMainEntry) {
        adaptations.push({
            id: "entry-main-wrapper-erasure",
            category: "browser-erasure",
            sourceSemantics: "The TypeScript scene setup is wrapped in a browser-facing main function.",
            nativeSemantics: "The compiler emits the body of main into the native entry point and omits the browser promise wrapper.",
            risk: "low",
            validation: ["compiler entry-order tests", "source-located unsupported syntax errors"],
        });
    }
    const erasedBrowserCount =
        context.erasedBrowserExpressions.size + context.erasedBrowserInstrumentation.size;
    if (erasedBrowserCount > 0) {
        adaptations.push({
            id: "browser-setup-erasure",
            category: "browser-erasure",
            sourceSemantics: `${erasedBrowserCount} DOM, performance, or dataset instrumentation expression(s) execute in the browser.`,
            nativeSemantics: "Those expressions are erased because window creation, timing, and diagnostics are provided by PAL.",
            risk: "medium",
            validation: ["compiler browser-erasure tests", "generated main.cpp inspection"],
        });
    }
    if (features.includes("loader:splat")) {
        adaptations.push({
            id: "splat-parse-at-generation",
            category: "asset-materialization",
            sourceSemantics:
                "loadSplat fetches a .ply and parses it on the main thread " +
                "into the 32-byte-per-splat row buffer.",
            nativeSemantics:
                "The pin's own parser runs at generation and the row buffer " +
                "is packaged, because a PLY header is a per-exporter " +
                "property list whose parsed VALUE is what must not drift. " +
                "The geometry build over that buffer stays a fold.",
            risk: "low",
            validation: [
                "packaged rows are byte-identical to the pin's own .splat",
                "lowered build_splat_geometry checksums match the pinned JS",
            ],
        });
        adaptations.push({
            id: "splat-synchronous-sort",
            category: "async",
            sourceSemantics:
                "The splat depth sort runs in a worker; a frame draws " +
                "whichever order has arrived, and mesh.firstSortReady " +
                "resolves once the first one has.",
            nativeSemantics:
                "The sort runs on the frame's own thread before the draw " +
                "that reads it, so every frame is already the state that " +
                "promise waits for. The pinned kernel and its re-sort " +
                "epsilon are unchanged.",
            risk: "low",
            validation: [
                "scene 120 parity against the browser golden",
                "lowered sort_splats_back_to_front from the pinned AST",
            ],
        });
        adaptations.push({
            id: "splat-hypot-approximation",
            category: "determinism",
            sourceSemantics:
                "The quaternion normalisation divides by Math.hypot, which " +
                "ECMAScript specifies as implementation-approximated.",
            nativeSemantics:
                "The root of the sum of squares, since no port can match an " +
                "unspecified approximation by construction. Measured over " +
                "scene 120's 345,217 splats: 10 of 2,785,280 emitted floats " +
                "differ, every one a covariance entry below 1e-19.",
            risk: "low",
            validation: [
                "measured against the pinned builder on the packaged asset",
            ],
        });
    }
    if (context.unwrappedAwaitExpressions.size > 0) {
        adaptations.push({
            id: "synchronous-aot-await",
            category: "async",
            sourceSemantics: `${context.unwrappedAwaitExpressions.size} await expression(s) suspend JavaScript promises.`,
            nativeSemantics: "Reachable asset promises resolve immediately because remote data is materialized during compilation.",
            risk: "medium",
            validation: ["typed Promise<T> runtime", "local asset manifest", "generated glTF loader tests"],
        });
    }
    if (context.jsDataReached) {
        adaptations.push({
            id: "plain-data-value-model",
            category: "language",
            sourceSemantics: "JavaScript objects and arrays are heap references with garbage collection; sparse arrays read undefined.",
            nativeSemantics: "Plain-data objects compile to structs and vectors: a const local bound to an element or member binds a native reference, so writes through it reach the container, while a mutable local stays a copy that rejects writes; function object parameters pass by native reference; new Array elements zero-initialize. A structural mutation of a container makes references taken into it unusable, and later use is a compile error rather than a dangling read.",
            risk: "medium",
            validation: ["compiler data-model tests", "differential logic parity gates"],
        });
    }
    if (context.jsRandomReached) {
        adaptations.push({
            id: "deterministic-seeded-random",
            category: "determinism",
            sourceSemantics: "Math.random draws from the host's nondeterministic generator.",
            nativeSemantics: "Math.random lowers to a pinned mulberry32 sequence (seed 1); the browser reference capture installs the identical generator before module load.",
            risk: "medium",
            validation: ["seeded-random unit tests", "deterministic parity gates"],
        });
    }
    if (context.assets.size > 0) {
        adaptations.push({
            id: "compile-time-asset-materialization",
            category: "asset-materialization",
            sourceSemantics: `${context.assets.size} asset URL(s) are fetched at runtime by Babylon Lite.`,
            nativeSemantics: "The compiler downloads them into the generated asset directory and generated code performs deterministic local reads.",
            risk: "medium",
            validation: ["asset paths in manifest.json", "typed asset specialization tests"],
        });
    }
    if (
        [...context.assets.values()].some(
            (asset) => asset.kind === "sprite-atlas",
        )
    ) {
        adaptations.push({
            id: "drawn-sprite-atlas",
            category: "asset-materialization",
            sourceSemantics:
                "The atlas is drawn at run time with canvas2D and handed to loadSpriteAtlas as a data URL.",
            nativeSemantics:
                "Generation runs the same module in headless Chromium and bakes the PNG it returns, so the pixels are a browser rasterizer's rather than a reimplementation. The bytes depend on the Chrome that compiled them, exactly as the pinned GGX prefilter already does.",
            risk: "medium",
            validation: [
                "scene 50 parity against the browser golden",
                "byte-stable across repeated compilations",
            ],
        });
    }
    if (
        [...context.assets.values()].some(
            (asset) => asset.kind === "pixels",
        )
    ) {
        adaptations.push({
            id: "computed-pixel-buffer",
            category: "asset-materialization",
            sourceSemantics:
                "The scene computes a texture's bytes at run time and hands them to createTexture2DFromPixels.",
            nativeSemantics:
                "Generation runs the same module in headless Chromium and bakes the bytes it returns. This is a larger adaptation than the drawn atlas beside it: those pixels are a rasterizer's and could never be lowered, while these are arithmetic. They are frozen because the module memoizes through a module-level binding the data model does not carry, and because the palette they build lands three of its 768 channel values 2.8e-14 under a rounding boundary -- one ulp of sin -- so any change in how the expression evaluates would flip an entry and with it a pixel. The bytes depend on the Chrome that compiled them.",
            risk: "medium",
            validation: [
                "scenes 93 and 95 parity against the browser golden, which computes the same bytes at run time",
                "byte-stable across repeated compilations",
            ],
        });
    }
    if (
        [...context.assets.values()].some(
            (asset) => asset.kind === "basis",
        )
    ) {
        adaptations.push({
            id: "executed-basis-transcode",
            category: "asset-materialization",
            sourceSemantics:
                "loadBasisTexture2D fetches the Binomial transcoder from a CDN at run time, transcodes the .basis file to the first compressed format the device reports, and uploads the mip chain it produced.",
            nativeSemantics:
                "Generation runs the pin's own loader in headless Chromium and packages what the transcoder uploaded, as the KTX1 container the runtime's one compressed-texture reader takes. The transcoder is a WebAssembly module the page injects with a script tag, so a native runtime would carry a decompressor it has no other use for -- the reason Draco and meshopt decode at generation too -- and the target format is a device question both the reference and the compiled backends answer with BC7 on D3D12. The baked bytes depend on the Chrome that compiled them, as the drawn atlas and the pinned GGX prefilter already do.",
            risk: "medium",
            validation: [
                "scene 36 parity against the browser golden, which transcodes the same file at load",
                "byte-stable across repeated compilations",
            ],
        });
    }

    if (features.includes("material:tracking")) {
        adaptations.push({
            id: "material-tracking-observers-dropped",
            category: "browser-erasure",
            sourceSemantics:
                "The scene installs the pin's material tracking, which " +
                "defines value-preserving accessors over the UBO-backed " +
                "properties so that any later write marks the material's " +
                "UBO dirty and it re-uploads.",
            nativeSemantics:
                "Nothing is installed. Generation already knows which " +
                "properties the scene writes and emits the re-upload for " +
                "them, so the run-time observer has nothing left to " +
                "observe. Installing changes no value, so the frame the " +
                "install itself produces is unchanged.",
            risk: "low",
            validation: [
                "the installer's own primitives are value-preserving: " +
                    "tracking-primitives.ts defines each property with a " +
                    "getter returning the captured value and a setter whose " +
                    "only effect is markMaterialUboDirty",
                "a scene that writes a tracked property is covered by the " +
                    "per-frame material regression gates, which measure the " +
                    "re-upload the compiler emits",
            ],
        });
    }

    if (features.includes("particle:node")) {
        adaptations.push({
            id: "executed-node-particle-simulation",
            category: "asset-materialization",
            sourceSemantics:
                "The scene builds a node-particle graph and steps its CPU simulation a fixed number of times before the first frame, drawing from the deterministic Math.random it installs.",
            nativeSemantics:
                "Generation runs the pin's own parser, graph builder and simulation in headless Chromium and bakes the particle state they produced; the native runtime draws that state and never simulates. The graph build is closures the compiler does not lower, and the value is fragile beyond a rounding step: the seed is drawn through Math.sin, which is not bit-portable off V8, so a native simulation would diverge into a different set of particles rather than a slightly different one. Everything downstream of the state -- the atlas, the blend and the per-particle write -- stays folded from the pinned declarations. The baked state depends on the Chrome that ran it, as the drawn atlas and the pinned GGX prefilter already do.",
            risk: "medium",
            validation: [
                "scenes 262, 263, 264, 276, 277, 280 and 281 parity against the browser golden, which runs the same simulation at load",
                "byte-stable across repeated compilations",
            ],
        });
    }
    if (features.includes("backend:sdl")) {
        adaptations.push({
            id: "sdl-platform-boundary",
            category: "platform",
            sourceSemantics: "Canvas, pointer, keyboard, timing, and presentation use browser platform APIs.",
            nativeSemantics: "SDL implements the platform boundary and translates input into generated Babylon camera state.",
            risk: "medium",
            validation: ["ArcRotate constant extraction tests", "native input smoke tests"],
        });
    }
    if (features.includes("renderer:pbr")) {
        adaptations.push({
            id: "sdl-gpu-shader-backends",
            category: "rendering",
            sourceSemantics: "Babylon Lite composes WGSL and renders through WebGPU.",
            nativeSemantics: "The compiler emits native-specialized WGSL; pinned Tint produces HLSL/MSL, register normalization and DXC produce SDL-compatible DXIL/SPIR-V, and SDL_GPU selects the native backend.",
            risk: "high",
            validation: ["upstream formula marker tests", "renderer-fidelity.json", "CPU/GPU visual parity"],
        });
    }
    if (features.includes("renderer:transmission")) {
        adaptations.push({
            id: "sdl-gpu-scene-transmission",
            category: "rendering",
            sourceSemantics: "Babylon Lite copies scene color before transmissive draws and applies KHR_materials_transmission, IOR Fresnel, and KHR_materials_volume attenuation.",
            nativeSemantics: "Generated render stages copy opaque scene color into an SDL_GPU sampled texture; Tint WGSL applies dielectric F0 ((ior-1)/(ior+1))^2 and Beer-Lambert exp(log(color)/distance*thickness) attenuation.",
            risk: "high",
            validation: [
                "independent skybox/transmission/IOR/volume gates",
                "scene 176 MosquitoInAmber parity",
                "Tint binding reflection",
            ],
        });
    }
    if (features.includes("environment:hdr")) {
        adaptations.push({
            id: "compile-time-hdr-cubemap",
            category: "asset-materialization",
            sourceSemantics: "Babylon Lite decodes RGBE, converts the equirectangular panorama to RGBA16F cubemap faces, and generates a GGX-prefiltered mip chain on the GPU.",
            nativeSemantics: "The compiler performs the pinned RGBE decode, spherical-harmonics integration, and cubemap projection, preserves mip zero exactly, then uses the pinned 1024-sample GGX WebGPU prefilter to store a deterministic RGBA16F mip chain for native upload.",
            risk: "high",
            validation: [
                "pinned HDR parser and cubemap marker tests",
                "generated HDR package validation",
                "scene 8 native/reference parity",
            ],
        });
    }
    if (features.includes("material:grid")) {
        adaptations.push({
            id: "grid-tint-specialization",
            category: "rendering",
            sourceSemantics: "Babylon Lite composes GridMaterial WGSL variants from antialias, max-line, transparency, premultiplication, and opacity-texture features, with world/view/projection system uniforms.",
            nativeSemantics: "The compiler emits one generated native WGSL program parameterized by the reached GridMaterial controls, uses the native view-projection matrix plus local position/normal attributes, and compiles it through pinned Tint.",
            risk: "medium",
            validation: [
                "pinned GridMaterial formula marker tests",
                "Tint binding reflection",
                "scene 213 native/reference parity",
            ],
        });
    }
    if (context.reachedShaderPrograms.length > 0) {
        adaptations.push({
            id: "typed-reached-shader-variants",
            category: "rendering",
            sourceSemantics: `Babylon Lite composes the reached custom WGSL shader variant(s): ${context.reachedShaderPrograms.map(({ name }) => name).join(", ")}.`,
            nativeSemantics: "The compiler validates reached WGSL, attributes, uniforms, and fixed-function state, lowers the supported WGSL subset into typed shader IR, reflects interfaces and uniform layouts, and emits native-specialized WGSL. Pinned Tint emits HLSL/MSL; register normalization and DXC emit SDL-compatible DXIL/SPIR-V.",
            risk: "high",
            validation: [
                "shader variant compiler tests",
                "typed WGSL IR and reflection tests",
                "portable shader compilation",
                "scene 163/274 native/reference parity",
            ],
        });
    }
    if (features.includes("renderer:geometry-output")) {
        adaptations.push({
            id: "sdl-gpu-frame-graph",
            category: "rendering",
            sourceSemantics: `Babylon Lite frame-graph tasks execute with ${context.geometryOutputTasks.length} typed geometry renderer task(s), explicit render lists, render-target textures, and ordered copy/resolve tasks.`,
            nativeSemantics: "Generated task records preserve cameras, material overrides, geometry attachment order, depth-only targets, shader semantics, and source-derived integer viewport/scissor bounds while PAL executes SDL_GPU passes, reverse-depth views, MSAA resolve, and viewport blits.",
            risk: "high",
            validation: [
                "geometry task compiler tests",
                "pinned geometry shader marker tests",
                "scene 116/145/146 native/reference parity",
            ],
        });
    }
    if (context.defaultRenderTaskAdapted) {
        adaptations.push({
            id: "readable-default-render-task",
            category: "rendering",
            sourceSemantics:
                "Babylon Lite creates a default scene render task that resolves directly to the swapchain.",
            nativeSemantics:
                "The compiler creates an equivalent readable MSAA target, resolves it to a single-sample target, then presents it so SDL_GPU screenshot capture never reads the swapchain.",
            risk: "medium",
            validation: [
                "default render-task compiler test",
                "scene 116 exact-source parity",
            ],
        });
    }
    return adaptations;
}
