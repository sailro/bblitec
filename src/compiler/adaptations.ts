// The adaptations manifest: what the native build changed and why.
//
// Each entry names one deliberate divergence from browser semantics
// that this compilation actually took -- erased browser setup,
// synchronous awaits, materialized assets, the platform and renderer
// boundaries -- with its risk and the validation that covers it. The
// list is derived from what the compiler reached, so a scene that
// never touched a subsystem carries no entry for it.
import type { CompileAdaptation } from "../fidelity.js";
import { pixelsSourcePrefix } from "../executed-module-assets.js";
import { bakedDirectionMinimumLength } from "../lowering/pinned-vertex-normalization.js";
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
    readonly voxelFileStorageReached: boolean;
    /** The canvas-owning texture producers this compilation executed. */
    readonly browserTextureFunctions: ReadonlySet<string>;
    readonly assets: ReadonlyMap<string, CompileAsset>;
    readonly reachedShaderPrograms: readonly CompiledShaderProgram[];
    readonly geometryOutputTasks: readonly GeometryOutputTaskManifest[];
    readonly defaultRenderTaskAdapted: boolean;
    /** Style properties this scene reached that render degraded (AP-3). */
    readonly uiDegradedStyleProperties: ReadonlySet<string>;
    /** Descendant sheet selectors kept as typed, non-widened scopes. */
    readonly uiScopedSheetSelectors: ReadonlySet<string>;
    /** Fixed-grid shapes structurally substituted by wrapping flex. */
    readonly uiGridSubstitutions: ReadonlySet<string>;
}

export function compileAdaptations(
    context: AdaptationContext,
    features: Feature[],
): CompileAdaptation[] {
    const adaptations: CompileAdaptation[] = [];
    if(features.includes("renderer:text")) {
        adaptations.push({
            id:"native-standalone-text-bundles",category:"platform",risk:"medium",
            sourceSemantics:"Standalone text layers render in stable order through per-layer WebGPU bundles; target size, transforms, palette and glyph edits update their retained resources.",
            nativeSemantics:"Pinned AST lowers placement, uploads and bundle invalidation. Both PALs replay retained immutable command lists; SDL has no native bundle object. Bundles retain the exact buffer and binding leases recorded by the source.",
            validation:["text-renderer-lifecycle source/native command and byte differential","scene180 baseline and control captures on both backends"],
        });
    }
    if (features.includes("text:layout")) {
        adaptations.push({
            id: "native-live-text-shaping", category: "platform", risk: "medium",
            sourceSemantics: "The pinned text-shaper library shapes live text and extracts newly reached glyph curves into each DefaultTextData atlas.",
            nativeSemantics: "HarfBuzz shapes the packaged font at native runtime; layout and numeric packing use pinned AST. Generation executes the pinned curve extractor and atlas packer over the complete font repertoire. Atlas allocation and glyph indices are materialized ahead of input; DefaultTextData retains its single run, live slot allocator, palette and dimensions.",
            validation: ["text-layout native/pinned shaping differential", "text-data-update byte, slot and version differential", "scene181 text input, camera and resize observations on both backends"],
        });
    }
    if (features.includes("material:local-cubemap")) {
        adaptations.push({
            id: "static-local-cubemap-packets", category: "asset-materialization", risk: "medium",
            sourceSemantics: "Local environment setters and probe construction create per-material uniforms, grid buffers and cube-array resources at runtime.",
            nativeSemantics: "Static pre-registration configuration executes the pinned setters, validation, packers and UBO writer during generation. Native materials retain independent environment identities and replay the recorded texture copies. Live reconfiguration refuses. SDL transports the unchanged 64 KiB probe uniform as read-only storage because its push-uniform limit is 16 KiB; Dawn retains the uniform binding.",
            validation: ["local cubemap packing and ownership tests", "scene186 differential parity and camera observations"],
        });
    }
    if (features.includes("renderer:surface")) {
        adaptations.push({
            id: "retained-canvas-surfaces", category: "platform", risk: "medium",
            sourceSemantics: "Each canvas has its own swapchain, scene targets, projection and pointer controls on a shared device.",
            nativeSemantics: "Scene targets follow retained host canvas rectangles and are composed into one OS window. Mouse capture remains with the canvas where the drag began. Reviewed host companions provide layout and labels; native target resize follows layout each frame.",
            validation: ["surface admission tests", "scene227 and scene228 full-page/canvas gates and independent camera/resize replay"],
        });
    }
    if (features.includes("platform:workers")) {
        adaptations.push({
            id: "native-dedicated-worker-realms", category: "platform", risk: "medium",
            sourceSemantics: "Browser dedicated module workers have isolated globals, ordered messages, structured clone, task queues and termination.",
            nativeSemantics: "Local AOT module factories execute in isolated native realms with owner-thread promises, timers, copied message graphs and transferred canvas endpoints. Clone codecs admit typed plain data and copied buffers; source transfer lists currently admit OffscreenCanvas only. Compiled cancellation checks interrupt source busy loops. Classic workers, dynamic URLs, MessagePort transfer, shared memory and the complete browser Promise/WorkerGlobalScope API are not admitted.",
            validation: ["worker compilation, clone, promise, event-loop and service fixtures", "unchanged Offscreen application on SDL_GPU and Dawn"],
        });
    }
    if (features.includes("platform:window")) {
        adaptations.push({
            id: "native-window-canvas-host", category: "platform", risk: "medium",
            sourceSemantics: "The browser owns DOM layout, canvas presentation, ResizeObserver delivery and display-driven animation in Window and worker realms.",
            nativeSemantics: "The OS thread composes leased GPU canvas images through RmlUi. Application-owned document snapshots and layout polling bridge the admitted Window APIs; observer delivery polls at 16 ms rather than implementing the complete browser rendering algorithm. Source event callbacks run on the application realm. Independent renderers coalesce display notifications, with no CPU image transport. Allocation is bounded to 16384 pixels per dimension; placeholder sizing and source resize messages remain separate from the presentation mailbox.",
            validation: ["offscreen ownership/backpressure fixture", "two-engine deterministic full-page and canvas gates", "block/unblock and responsive resize replay"],
        });
    }
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
                "A splat entry point fetches its container and parses it " +
                "on the main thread into the 32-byte-per-splat row buffer, " +
                "taking a container-specific parser for each: a plain PLY " +
                "or .splat, a compressed or spherical-harmonic PLY, or an " +
                "SPZ.",
            nativeSemantics:
                "The pin's own parser runs at generation and the row buffer " +
                "is packaged, because a PLY header is a per-exporter " +
                "property list whose parsed VALUE is what must not drift. " +
                "Every one of the pin's parsers runs there, on the pin's " +
                "own container forks -- isPlyCompressedOrSH within " +
                "loadSplat, and loadSPZ's separate entry point. The " +
                "geometry build over that buffer stays a fold.",
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
                "differ, every one a covariance entry below 1e-19. The " +
                "transform bake reaches it again at a coarser sink -- its " +
                "quaternion renormalisation divides by one and the result " +
                "is rounded into a BYTE -- and scene 125 measures 0.000 on " +
                "both backends there.",
            risk: "low",
            validation: [
                "measured against the pinned builder on the packaged asset",
                "scene 125 parity against the browser golden",
            ],
        });
    }
    if (features.includes("loader:splat-bake") || features.includes("loader:splat-data")) {
        adaptations.push({
            id: "splat-rows-retained-on-reach",
            category: "asset-materialization",
            sourceSemantics:
                "Every GaussianSplattingMesh retains its 32-byte row " +
                "buffer as splatsData, matching BJS keepInRam: true.",
            nativeSemantics:
                "The loader retains a shared ArrayBuffer only for a scene " +
                "that reaches transform baking, splatsData or updateData. " +
                "The rows are about half the four float payloads again " +
                "(11 MB against 22 MB on scene 120), so a cloud nobody " +
                "reads or updates carries none of it -- the same reach boundary every " +
                "other generated capability draws.",
            risk: "low",
            validation: [
                "generated splat_loader.cpp differs by the one retention " +
                    "line between a scene reaching row data and a scene that does not",
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
    if (context.voxelFileStorageReached) {
        adaptations.push({
            id: "native-voxel-file-dialog",
            category: "browser-erasure",
            sourceSemantics:
                "Voxel Sandbox opens browser save/open pickers and falls back to a download or hidden file input.",
            nativeSemantics:
                "Ctrl+S and Ctrl+O open the host save/open dialog and write or read the same JSON payload, with world.voxelsave.json as the suggested name.",
            risk: "medium",
            validation: [
                "voxel file-boundary compiler test",
                "native SaveData JSON round-trip",
                "non-interactive file-dialog path override",
            ],
        });
    }
    if (
        features.includes("browser:file") &&
        !context.voxelFileStorageReached
    ) {
        adaptations.push({
            id: "native-browser-file-bridge",
            category: "platform",
            sourceSemantics:
                "Blob URLs retain in-memory bytes; an anchor download and a file input invoke asynchronous browser pickers, and the input dispatches change after selection.",
            nativeSemantics:
                "A generation-checked object-URL registry retains the same bytes. Anchor and file-input clicks synchronously wait on SDL's portable asynchronous dialogs without dispatching application events; an accepted open choice is bounded and snapshotted before native sets the one-file list and invokes change before click returns. Input, FileList, and File values share reclaimable immutable snapshots under a per-engine aggregate cap; cancellation preserves the previous list.",
            risk: "medium",
            validation: [
                "browser file bridge compiler tests",
                "native Blob/object-URL/file-input contract check with stub dialogs",
                "PAL bounded-snapshot and exclusive atomic-write check",
                "exact Sandblox compile",
            ],
        });
    }
    if (features.includes("data:json")) {
        adaptations.push({
            id: "json-data-bridge",
            category: "language",
            sourceSemantics:
                "JSON.stringify walks a live JavaScript object graph and JSON.parse answers a value of any shape, both decided entirely at run time.",
            nativeSemantics:
                "JSON.stringify writes through codecs generated for exactly the records it reaches, in their declaration order, with a generation-known indent and no replacer; a property the source declared optional is omitted when absent, as an undefined member is. JSON.parse answers one dynamic document value: a missing or wrong-typed field reads as undefined rather than throwing, so the source's own shape guards decide, and a malformed document throws where the browser's SyntaxError does. A record that reaches itself is refused at generation rather than recursing.",
            risk: "medium",
            validation: [
                "JSON bridge compiler tests",
                "native document round-trip check (exact compact and pretty bytes)",
                "generated-tree neutrality",
            ],
        });
    }
    if (features.includes("storage:local")) {
        adaptations.push({
            id: "native-web-storage",
            category: "browser-erasure",
            sourceSemantics:
                "localStorage is per-origin browser storage: getItem answers a string or null, and setItem throws when the origin's quota is exhausted or storage is unavailable.",
            nativeSemantics:
                "The three reached methods read and write one file per key under the host's own preference directory (SDL_GetPrefPath) in a bblitec namespace. Keys are encoded injectively, so no key names a path or collides with another; a write is staged and moved into place, so an interrupted save leaves the previous value; removing an absent key succeeds. A platform failure throws, which is the arm a scene's try/catch around a save already takes.",
            risk: "medium",
            validation: [
                "Web Storage compiler tests",
                "native storage contract check against a temporary root",
                "nullable getItem falsiness test",
            ],
        });
    }
    if (context.jsDataReached) {
        adaptations.push({
            id: "plain-data-value-model",
            category: "language",
            sourceSemantics: "JavaScript objects and arrays are heap references with garbage collection; sparse arrays read undefined.",
            nativeSemantics: "Plain-data values compile to native structs and identity-preserving containers. Arrays, maps, sets, recursive/stored records, const composite aliases, and composite function parameters retain shared or referenced storage; PAL-owned typed-array data is exposed as a borrowed span. Mutable aliases that cannot be represented safely reject writes. New Array elements zero-initialize, and resizing a container invalidates tracked element references so later use is a compile error rather than a dangling read.",
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
            (asset) => asset.source.startsWith(pixelsSourcePrefix),
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
            (asset) =>
                asset.kind === "pixels" &&
                asset.source.startsWith("generated:data-url:"),
        )
    ) {
        adaptations.push({
            id: "fetched-canvas-atlas",
            category: "asset-materialization",
            sourceSemantics:
                "The scene fetches its source-owned voxel PNG tiles, draws them into one Canvas2D atlas, and reads the resulting RGBA pixels at run time.",
            nativeSemantics:
                "Generation executes that bounded atlas path in headless Chromium against the exact tracked PNGs and packages the resulting RGBA bytes for both native backends.",
            risk: "medium",
            validation: [
                "Voxel Sandbox browser-golden parity",
                "transitive-input-keyed atlas bake cache",
            ],
        });
    }
    if (context.browserTextureFunctions.size > 0) {
        adaptations.push({
            id: "browser-produced-textures",
            category: "asset-materialization",
            sourceSemantics:
                "The scene builds a texture in a browser canvas at run time " +
                `(${[...context.browserTextureFunctions].sort().join(", ")}) ` +
                "and hands it to createTexture2DFromPixels, or encodes it to a " +
                "PNG blob and loads that object URL through loadTexture2D.",
            nativeSemantics:
                "Generation executes the same function in headless Chromium " +
                "against a stub that records only those two pinned factories, " +
                "and packages exactly what they were handed: the raw RGBA with " +
                "its width, height and sampler options, or the object URL's " +
                "blob byte-for-byte with its sampler, invertY and sRGB options. " +
                "Neither side is lowerable here -- a rasterized face is a " +
                "browser rasterizer's antialiasing, and the arithmetic tile " +
                "rounds through a Math.round this data model does not carry and " +
                "then crosses a browser PNG encode. Every other pinned import " +
                "throws if reached and the engine argument is a proxy that " +
                "throws on any property read, so an unbounded reach fails " +
                "generation. The bytes depend on the Chrome that compiled them, " +
                "exactly as the drawn atlas and the pinned GGX prefilter do.",
            risk: "medium",
            validation: [
                "browser-texture structural detection and refusal tests",
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

    // The frozen node-particle bake is recorded by generation
    // (`bakeNodeParticleSystems` in `cli.ts`), which is where the frozen
    // systems are known: a system a pure-2D binding took live is simulated
    // natively from the lowered graph and is no adaptation.
    if (
        (
            [
                "gizmo:axis-drag",
                "gizmo:axis-scale",
                "gizmo:plane-drag",
                "gizmo:plane-rotation",
                // The bounding-box cage splits the same way: everything
                // it draws is generated, and the drag half it hangs on
                // those same meshes is not reached.
                "gizmo:bounding-box",
            ] as const satisfies readonly Feature[]
        ).some((feature) => features.includes(feature) &&
            (!features.includes("gizmo:pointer-drag") ||
                (feature !== "gizmo:axis-drag" && feature !== "gizmo:plane-drag" && feature !== "gizmo:plane-rotation")))
    ) {
        adaptations.push({
            id: "display-only-editing-gizmo",
            category: "platform",
            sourceSemantics:
                "An editing gizmo builds a rendered widget and a " +
                "pointer-drag interaction over it: invisible collider " +
                "meshes give the widget a pick region, `registerPointerDrag` " +
                "binds pointer events on the canvas, and a drag swaps the " +
                "widget's hover material, shows the rotation gizmo's " +
                "sector readout and writes the attached node's position, " +
                "rotation or scaling.",
            nativeSemantics:
                "The rendered widget and its per-frame follow are " +
                "generated from the pinned factories; the drag is not " +
                "reached, because this runtime has no pointer-input " +
                "contract to bind one to. Every part whose only consumer " +
                "is that drag is therefore not built -- the collider " +
                "meshes, the hover and disabled materials, and the " +
                "rotation sector quad. For the MESHES, generation asserts " +
                "against the pin that each is hidden BEFORE any pointer " +
                "event -- the walk stops at a nested function, so the " +
                "second hide `createPlaneRotationGizmo` performs from its " +
                "drag callback cannot answer for the build-time one, and " +
                "`buildScaleArrow`'s `centered` arm cannot answer for the " +
                "arrow arm beside it: the two share their local names, so " +
                "each is asserted in its own scope. An upstream change " +
                "that made one " +
                "show fails generation by name rather than dropping it " +
                "silently. The two extra materials carry no such " +
                "assertion, and are simply not built because the pinned " +
                "body assigns neither to a mesh before a drag. The " +
                "widget's root is the transform node the camera and light " +
                "gizmos already use where the pin makes an invisible " +
                "zero-height cylinder for the same purpose, and that the " +
                "pinned root IS invisible is itself asserted -- it is what " +
                "makes the substitution sound. The BOUNDING-BOX cage " +
                "splits the same way and builds no collider of its own: " +
                "its drag hangs on the handles it already draws, so what " +
                "is absent there is the hover material nothing assigns " +
                "outside a drag callback, the disposer list, the " +
                "per-rotator world axis only the rotation drag rotates " +
                "around, and the local bounding diagonal only that drag " +
                "divides by. Its root is the same transform-node " +
                "substitution, asserted the same way, and generation also " +
                "asserts the pin's own zero extents on the cylinder it " +
                "stands in for.",
            risk: "medium",
            validation: [
                "scenes 221 and 222 parity against the browser golden, which draws the same widgets before any pointer event",
                "scene 224 parity against the same golden for the bounding-box cage, which the browser lays out before any pointer event too",
                "generation fails when a pinned collider mesh, sector quad or widget root stops being hidden at build time",
            ],
        });
    }
    if (features.includes("mesh:csg")) {
        adaptations.push({
            id: "executed-csg-solid",
            category: "asset-materialization",
            sourceSemantics:
                "The scene builds BSP solids from two meshes' CPU geometry, applies a boolean, and triangulates the result into a mesh at load.",
            nativeSemantics:
                "Generation replays the same calls against the pin's own csg.ts and mesh factories and bakes the geometry it handed createMeshFromData; the native runtime creates that mesh from data and runs no solid modeller. It is the value rather than the shape that has to hold: splitPolygon classifies every vertex against EPSILON = 1e-5, so a reassociated dot product changes the polygon count and with it the whole tree, and every normal is normalized through Math.hypot, which the specification leaves implementation-approximated (the same fact recorded as splat-hypot-approximation). The solid itself never reaches the runtime, so no shape downstream could catch a drift. The replay runs under Node rather than headless Chromium because the pinned module reaches no browser API -- the same split the node-material compiler takes -- so the baked geometry depends on the V8 that ran it.",
            risk: "medium",
            validation: [
                "scene 90 parity against the browser golden, which runs the same boolean at load",
                "the replay asserts each source mesh still starts at the identity world matrix",
                "byte-stable across repeated compilations",
            ],
        });
    }
    if (features.includes("mesh:csg2")) {
        adaptations.push({
            id: "executed-csg2-solid",
            category: "asset-materialization",
            sourceSemantics: "The scene initializes the pinned Manifold WASM runtime, builds solids from retained CPU mesh streams, applies booleans, and creates one mesh or one mesh per material slot.",
            nativeSemantics: "Generation executes unchanged csg2.ts and the package's bundled Manifold WASM in Chromium. Only identity-transform box/sphere inputs with generation-known options are accepted. Native code constructs the exact returned streams and retains the pin's partition ordering, names and material selection. Solids and their disposal remain generation-only; initialization and modelling failures happen during compilation.",
            risk: "medium",
            validation: [
                "pinned CSG2 boolean, material partition and refusal tests",
                "binary transport preserves the pin's float32 and index streams",
                "unchanged scene 91 is byte-identical to the browser golden on SDL_GPU and Dawn",
                "both-backend input replay observes camera orbit, changed images and window-close completion",
            ],
        });
    }
    if (features.includes("gizmo:pointer-drag")) {
        adaptations.push({
            id: "native-position-gizmo-pointer-drag",
            category: "platform",
            sourceSemantics: "A per-canvas dispatcher picks utility-layer colliders and converts pointer movement into axis/plane translation or rotation; camera controls defer to its active and pending state.",
            nativeSemantics: "Position drag registration and rotation widget factories reach host input, enlarged colliders, hover materials, disposal and live camera predicates. Canvas proxies retain their source listener code and callback identities. GPU readback completes synchronously against the picker's scene. Ray/plane intersection, axis projection, parent-space deltas, signed rotation angles and quaternion conjugation/update are translated from the pin. Custom drag observables, rotation sector readout, sibling-disable styling, scale dragging and multi-pointer/touch capture remain unsupported.",
            risk: "medium",
            validation: [
                "focused editor-pointer-drag compiler, lowering and native event/camera regressions",
                "Antigravity editor point selection and handle drag on SDL_GPU and Dawn",
                "editor to menu to editor to menu cleanup replay",
                "scene49 lazy widget creation, two live rotations and query marker updates on SDL_GPU and Dawn",
            ],
        });
    }
    if (features.includes("physics:queries")) {
        adaptations.push({
            id: "bullet-convex-shape-queries",
            category: "platform",
            sourceSemantics: "Havok returns the closest proximity/cast hit, local input contacts and world target contacts after trigger/mask and body-exclusion filtering.",
            nativeSemantics: "Bullet GJK/EPA and convex sweep supply the query results. Cylinder query rims use the measured Havok margin min(0.015, 0.1 * minimumHalfExtent). Parallel cylinder/capsule side contacts select the lower axial-overlap endpoint, preserving distance and normal. Concave/compound proximity targets refuse. These are measured solver adaptations; Havok internals are not ported.",
            risk: "medium",
            validation: [
                "scene49 full and foreground MAD 0.000 on SDL_GPU and Dawn",
                "four rotated query poses against Havok WASM; every result lane differs by less than 0.005",
                "live rotation markers against Havok at native captured quaternions, trigger/mask/excluded-body/no-hit controls",
            ],
        });
    }
    if (features.includes("mesh:thin-instance-gpu-culling")) {
        adaptations.push({
            id: "thin-instance-gpu-culling-omitted",
            category: "rendering",
            sourceSemantics:
                "`enableThinInstanceGpuCulling(mesh)` opts a pool into the " +
                "pin's compute frustum culler: a compute pass compacts the " +
                "in-frustum instances into a visible buffer and the mesh " +
                "draws them indirectly. It also marks the renderable " +
                "`_direct`, which takes it out of the cached opaque render " +
                "bundle -- which is what gives an application per-frame " +
                "thin-instance buffer sync on a Standard material. The " +
                "pin states the visible output is unchanged: culling is " +
                "conservative, and a pool it cannot cull falls back to " +
                "drawing every instance.",
            nativeSemantics:
                "The opt-in is recorded on the mesh and the culler is " +
                "omitted: every ACTIVE instance is drawn, which is the " +
                "pin's own fallback and therefore the same pixels. The " +
                "second effect needs nothing, because this port records no " +
                "render bundles at all -- both backends re-upload every " +
                "live pool from the record's version and bind the mesh's " +
                "buffers at the draw, every frame, whether or not culling " +
                "was asked for. What is given up is the performance: a " +
                "far-off-screen instance still costs a vertex fetch.",
            risk: "low",
            validation: [
                "the recorded flag keeps an opted-in pool distinguishable " +
                    "from one that never asked",
                "compiler thin-instance tests over the pinned enable body",
                "regression-thin-instance-pool on both backends: a pool " +
                    "that grows, shrinks and empties draws what its count says",
            ],
        });
    }
    if (features.includes("physics:viewer")) {
        adaptations.push({
            id: "materialized-physics-debug-geometry", category: "asset-materialization",
            sourceSemantics: "The pinned viewer asks Havok HP_Shape_CreateDebugDisplayGeometry for the body's current shape and follows its source node each frame.",
            nativeSemantics: "A compiler-generated startup construction entry records complete pre-solver HP_Shape inputs. A Node Havok WASM producer materializes only shape-local triangle geometry. The normal binary requires exact descriptor equality; body poses and motion stay live. Extraction refuses clocks, physics steps, renderer/input execution, external storage and observable debug membership. Unread direct instrumentation clocks are omitted; observed show/hide results and constraint overlays are not admitted.",
            risk: "high",
            validation: ["complete descriptor and producer drift/refusal tests", "viewer lifecycle and native constructor extraction controls", "both-backend image parity and live scene controls"],
        });
    }
    if (features.includes("physics:world")) {
        adaptations.push({
            id: "substituted-physics-solver",
            category: "platform",
            sourceSemantics:
                "`createHavokWorld(scene, hknp)` drives Havok Physics V2: " +
                "the scene loads the Havok WASM module and the pinned " +
                "physics layer calls its `HP_*` entry points to build " +
                "bodies and shapes and to integrate one step per frame.",
            nativeSemantics:
                "The pinned layer is generated unchanged -- the step " +
                "gate, the four phases of a frame, the aggregate's " +
                "ordering and the bounding-box shape sizing are lowered " +
                "from `src/physics/havok.ts` -- but the `HP_*` surface " +
                "behind it is implemented over Bullet in the PAL, " +
                "because the Havok module is a proprietary binary this " +
                "project cannot redistribute. The scene's own `await " +
                "HavokPhysics(...)` reaches nothing and emits nothing. " +
                "This is the one adaptation here that is not " +
                "bit-faithful by construction: two rigid-body solvers " +
                "integrate different contact models, so a body's pose " +
                "after N steps is a different number rather than a " +
                "rounding of the same one. A physics scene's threshold " +
                "therefore cannot be driven toward zero: scene 40 carries " +
                "one set just above the measured distance between the two " +
                "solvers, which gates this port's own solver rather than " +
                "asserting agreement with the pinned one. The trajectory " +
                "(`BBLITE_PHYSICS_TRACE`) is what grades the simulation " +
                "itself.",
            risk: "high",
            validation: [
                "free fall is exact: the measured pose after N steps " +
                    "matches the closed form of the semi-implicit Euler " +
                    "integration both solvers use, to float32 precision " +
                    "(examples/physics-drop.ts, 1e-7 at magnitude 4)",
                "a resting body settles at its geometric height " +
                    "(sphere radius 1 on a ground plane at y=0 rests at " +
                    "y=1.0 exactly), which is what the degenerate-box " +
                    "sink in pal_physics_bullet.cpp is measured against",
                "restitution is within 0.3% of the analytic rebound " +
                    "apex for the reached coefficient",
                "both GPU backends render the byte-identical frame from " +
                    "the identical simulated pose",
                "a `PhysicsShapeType.MESH` collider is the pin's own " +
                    "triangle soup rather than the hull of it, and the " +
                    "difference is measured where the two arms disagree: " +
                    "a sphere dropped down an uncapped tube falls through " +
                    "the mesh shape and rests on the hull four units " +
                    "higher (examples/regression-physics-mesh-shape.ts, " +
                    "byte-identical to the Havok golden on both backends " +
                    "through the mesh arm)",
                "multi-region floating origin is a fold rather than a " +
                    "second substitution, and it is gated where the " +
                    "mechanism is the only thing that can produce the " +
                    "pose: `examples/regression-physics-floating-origin" +
                    ".ts` drops a sphere at `5e6 + 0.3`, which float32 " +
                    "cannot hold at that magnitude, through a region " +
                    "migration and a region reclaim. Region-local it " +
                    "rests where it was dropped, byte-identical between " +
                    "the backends; simulated at raw world coordinates " +
                    "the same scene rests away from the drop in x and z " +
                    "(the current distances are in docs/status.md)",
                "an aggregate's `startAsleep` sleeps in Bullet the way " +
                    "`HP_World_AddBody`'s third argument sleeps in " +
                    "Havok, and wakes on the same contact: scene 44's " +
                    "two towers, frozen at the pin's own " +
                    "`?captureAfter=5` (physics step 300, one second " +
                    "after the dropped box wakes the sleeping tower, so " +
                    "the pose is mid-collapse), are graded against the " +
                    "browser golden identically on both backends (the " +
                    "current distances are in docs/status.md)",
            ],
        });
    }

    if (features.includes("audio:engine")) {
        adaptations.push({
            id: "substituted-audio-engine",
            category: "platform",
            sourceSemantics:
                "`createAudioEngineAsync` builds a Web Audio graph in the " +
                "browser: `new AudioContext()`, `GainNode`, `AudioParam` " +
                "and their siblings, implemented by whatever engine the " +
                "page runs on -- Blink's for the reference captures.",
            nativeSemantics:
                "The pinned engine's own output graph is folded from " +
                "`bus.ts`'s declarations (and `src/lowering/" +
                "audio-lowerer.ts` refuses generation if any of them " +
                "moves), but the Web Audio API under it is LabSound's, " +
                "reached through `bblite/pal_audio.hpp` over an SDL3 " +
                "device. LabSound is a fork of WebKit's own WebAudio " +
                "implementation with the copyleft code removed, so the " +
                "node graph, the parameter timeline and the panner math " +
                "are the same algorithms rather than a second design -- " +
                "the relationship navigation has with recastnavigation " +
                "rather than the one physics has with Bullet. It is " +
                "still a different codebase from the one that produced " +
                "the reference, and it has diverged from WebKit for a " +
                "decade, so agreement is expected rather than " +
                "guaranteed by construction. Two places are known to " +
                "need translation and are translated in the PAL: a " +
                "`StereoPannerNode`'s `pan` is declared with default 0.5 " +
                "over 0..1 where Web Audio specifies 0.0 over -1..1, and " +
                "the graph's sample rate and channel count are the " +
                "device's rather than a scene's.",
            risk: "high",
            validation: [
                "an offline capture of the same scene is byte-identical " +
                    "across runs (`BBLITE_AUDIO_CAPTURE`), which is what " +
                    "makes a PCM comparison against the browser's own " +
                    "`OfflineAudioContext` render a measurement",
                "compiler reachability and minimal-package checks verify " +
                    "that only requested audio node factories and their " +
                    "core runtime dependencies are linked",
            ],
        });
    }

    if (features.includes("ui:rml")) {
        const degraded = [...context.uiDegradedStyleProperties].sort();
        const scoped = [...context.uiScopedSheetSelectors].sort();
        const grids = [...context.uiGridSubstitutions].sort();
        adaptations.push({
            id: "substituted-ui-runtime",
            category: "platform",
            sourceSemantics:
                "The scene's retained DOM, CSS, and Canvas2D chrome is " +
                "laid out, styled, animated, and rasterized by the " +
                "browser -- Blink's DOM, cascade, Web Animations, and " +
                "font stack for the reference captures.",
            nativeSemantics:
                "The compiler lowers the reached UI surface into a typed " +
                "retained IR that the PAL projects through RmlUi over the " +
                "scene's own GPU backend. The projection is reviewed but " +
                "not the browser: platform fonts (DirectWrite, CoreText, " +
                "fontconfig) rasterize glyphs differently from the " +
                "browser's font stack; `element.animate()` and retained-UI " +
                "`element.removeEventListener()` lower to no-ops (CSS @keyframes " +
                "animation is projected, and retained records share the " +
                "engine lifetime); CSS `steps()`/`step-start`/`step-end` " +
                "easings play as `linear-in-out` and the `ease*` family " +
                "as `sine*`; canvas overlays composite below the DOM " +
                "chrome regardless of z-index; typed author rules retain " +
                "source order and specificity, and RmlUi evaluates reached " +
                ":hover and max-width state against the live viewport; " +
                "retained focus identity and host focus-visible outlines are " +
                "projected without a general DOM activeElement object; color " +
                "emoji use the platform face with explicit VS16 font runs, " +
                "not general ZWJ/emoji-sequence shaping" +
                (features.includes("renderer:canvas")
                    ? "; a source without a Babylon engine receives a native " +
                      "window and frame host for its primary Canvas2D surface; " +
                      "rectangle edges use analytic backing-pixel coverage " +
                      "through premultiplied UI meshes, with browser raster " +
                      "quantization differences"
                    : "") +
                (scoped.length > 0
                    ? `; the statically-proven descendant rule(s) ${scoped
                         .map((selector) => `'${selector}'`)
                         .join(", ")} remain scoped in the retained rule IR`
                    : "") +
                (grids.length > 0
                    ? `; RmlUi has no grid formatting context, so ${grids
                         .map((grid) => `'${grid}'`)
                         .join(", ")} use an equivalent fixed-width wrapping-flex child container`
                    : "") +
                (features.includes("ui:inline-svg")
                    ? "; bounded static svg/path/rect markup is rasterized " +
                      "by RmlUi's LunaSVG plugin, with inherited currentColor " +
                      "applied as the generated image tint"
                    : "") +
                (degraded.length > 0
                    ? `; and the reached style ${
                          degraded.length === 1
                              ? `property ${degraded[0]} is`
                              : `properties ${degraded.join(", ")} are`
                      } accepted without a native rendering.`
                    : "."),
            risk: "high",
            validation: [
                "full-page 1280x720 parity captures composite the retained UI over the scene on both backends",
                "canvas-only attribution runs (BBLITE_CAPTURE_UI=0) separate UI residuals from scene regressions",
                "compiler UI lowering and refusal tests",
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
    if (features.includes("renderer:scene")) {
        adaptations.push({
            id: "sdl-gpu-shader-backends",
            category: "rendering",
            sourceSemantics: "Babylon Lite composes WGSL and renders through WebGPU.",
            nativeSemantics: "The compiler emits native-specialized WGSL; pinned Tint produces the target-selected HLSL or MSL source, register normalization and DXC produce the selected SDL-compatible DXIL or SPIR-V artifact, and SDL_GPU selects the native backend.",
            risk: "high",
            validation: ["upstream formula marker tests", "renderer-fidelity.json", "CPU/GPU visual parity"],
        });
        adaptations.push({
            id: "guarded-cpu-vertex-normalization",
            category: "rendering",
            sourceSemantics: "Material vertex shaders normalize their normal/tangent directions with WGSL f32 arithmetic.",
            nativeSemantics: `The CPU vertex bake projects the pinned normalization through typed WGSL lowering after its world transform, retaining f32 intermediates and division. It returns zero unless the length is strictly above ${bakedDirectionMinimumLength}; this guard is a native adaptation, not the JavaScript tuple/object normalizer's epsilon or fallback.`,
            risk: "medium",
            validation: ["compiled normalization bit-pattern and threshold checks", "both-backend scene parity"],
        });
        adaptations.push({
            id: "shared-material-vertex-transport",
            category: "rendering",
            sourceSemantics: "Pinned material composers combine mesh worlds and optional skeleton, morph and instance resources in their vertex stages.",
            nativeSemantics: "The shared diagnostic/depth/background stage projects those computations through typed shader IR onto pre-baked worlds and fixed PAL bindings. Enabled deformation uses four bone influences in a 64-matrix uniform palette and either two-target attributes or the pinned storage-morph payload. The attribute path retains tangent deltas and a pre-morph bitangent; colour materials keep their own pinned composers.",
            risk: "medium",
            validation: ["executed-pin vertex transport and arithmetic-drift tests", "six Tint vertex permutations", "both-backend depth/background/deformation gates"],
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
            nativeSemantics: "The compiler validates reached WGSL, attributes, uniforms, and fixed-function state, lowers the supported WGSL subset into typed shader IR, reflects interfaces and uniform layouts, and emits native-specialized WGSL. Pinned Tint emits the target-selected HLSL or MSL source; register normalization and DXC emit the selected SDL-compatible DXIL or SPIR-V artifact.",
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
