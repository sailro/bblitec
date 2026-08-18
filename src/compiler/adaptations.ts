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
