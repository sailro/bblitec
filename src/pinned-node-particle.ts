/**
 * The frozen node-particle bake: the pin's own parser, graph builder and CPU
 * simulation, run at generation, with the particle state they produced baked.
 *
 * Why this one is EXECUTED rather than folded, stated once because it is the
 * whole argument for the family:
 *
 *   - The graph build is closures. `npe-build.ts` walks the document and
 *     dynamically imports one evaluator per block class, each of which
 *     installs getters and update steps onto the system as JavaScript
 *     functions. There is no shape to fold: the "shader" of a particle graph
 *     is a call tree assembled at load, and this compiler lowers no closures.
 *   - The simulation's value is fragile in the strongest sense the repository
 *     has met. Every corpus scene installs its own deterministic
 *     `Math.random` seeded through `Math.sin`, and the graph consumes that
 *     sequence in an order the block walk decides. `Math.sin` is not
 *     bit-portable between V8 and a native C++ library, so a lowered
 *     simulation would draw a different random sequence within a few
 *     hundred calls and diverge completely -- not by a rounding step, but
 *     into a different set of particles. Running the pin under the engine
 *     the golden runs it in is the only port that can agree.
 *
 * What is NOT executed is everything downstream: `createParticleBillboard`
 * and `syncParticleBillboard` are folded from their own pinned declarations
 * (`src/lowering/node-particle-lowerer.ts`), so the atlas, the blend and the
 * per-particle write stay the pin's shape and a change in either fails
 * generation instead of being baked over.
 *
 * The tradeoff is the drawn atlas's and the HDR prefilter's, and it is
 * recorded per scene as the `executed-node-particle-simulation` adaptation:
 * the baked state depends on the Chrome that ran it.
 */
import {
    createSuiteSceneServer,
    pinnedBrowserEntryUrl,
} from "./capture-suite-reference.js";
import {
    runPageGlobal,
    screenshotCaptureBrowserArgs,
} from "./browser-harness.js";
import {
    cachedJsonBake,
    moduleClosureBytes,
    moduleIdentity,
} from "./bake-cache.js";

/**
 * The graph a `parseNodeParticleSource` call reached.
 *
 * `normalized` records that the scene awaited `normalizeNodeParticleGraph`
 * between the parse and the build. The normalizer is graph plumbing: it
 * rewrites a reachable TeleportOut edge to its TeleportIn source and
 * compiles Elbow and Debug away as pass-throughs, so the five
 * Teleport-family class names the builders otherwise refuse become the
 * terminal sources they route to. It is the pin's own function, run in the
 * driver exactly where the scene ran it -- not restated here -- because the
 * graph it produces is read only by the executed build.
 */
export type NodeParticleGraphSource =
    | {
          kind: "literal";
          graph: Record<string, unknown>;
          normalized?: true;
      }
    | {
          kind: "module";
          module: string;
          exportName: string;
          /** The factory's own arguments, as the static JSON they are. */
          args: readonly unknown[];
          normalized?: true;
      };

/** The pinned builders a scene reaches, by their own export names. */
export type NodeParticleBuilder =
    | "buildNodeParticleSet"
    | "buildNodeParticleSetWithBlendModes"
    | "buildNodeParticleSetWithFlowMaps"
    | "buildNodeParticleSetWithNoiseTextures";

/**
 * One recorded call on the system, in the order the scene made it.
 *
 * The simulation is a sequence, so what travels to generation is the
 * sequence rather than a step count: `startParticleSystem` before N
 * `animateParticleSystem(system, ratio)` calls is a different frame from
 * the same calls in any other order, and a scene that stops halfway is a
 * third.
 */
export type NodeParticleStep =
    | { op: "start"; set: number; system: number }
    | { op: "stop"; set: number; system: number }
    | { op: "animate"; set: number; system: number; ratio: number }
    /**
     * A scalar the scene writes on the system between steps. The three the
     * corpus reaches are all inputs to `animateParticleSystem`, so the write
     * is part of the sequence rather than a property of the result --
     * `updateSpeed = 0` is exactly what freezes a set the scene then
     * registers.
     */
    | {
          op: "scalar";
          set: number;
          system: number;
          name: "emitRate" | "updateSpeed" | "targetStopDuration";
          value: number;
      }
    /**
     * The deterministic `Math.random` the scene installs before stepping.
     * Its text is the scene's own arrow, moved into the driver rather than
     * restated: the driver runs in the same engine the golden does, so an
     * identical arrow draws an identical sequence by construction. The
     * compiler refuses an arrow that captures anything but statically
     * numeric locals, and refuses the assignment outright if the scene
     * reaches `Math.random` anywhere the native runtime would answer.
     */
    | { op: "random"; declarations: readonly string[]; arrow: string }
    /**
     * `Math.random = original`, the scene closing its seeded window. The
     * driver holds the generator it replaced, so what follows draws from
     * the browser's own sequence exactly as the scene does.
     */
    | { op: "random-restore" }
    /**
     * `set.systems.push(other)`: the corpus composes two independently
     * built systems into one set so a single registration renders both.
     * The push is a step because it must land before the registration that
     * walks the list.
     */
    | {
          op: "push-system";
          set: number;
          fromSet: number;
          fromSystem: number;
      }
    /**
     * A particle buffer is generation-time state: the simulation runs at
     * generation, so a scene that writes a column afterwards is editing the
     * state the bake will read, and a scene that checks `alive` is
     * asserting about it. Both move to the driver, where the buffer exists,
     * and neither emits native code.
     */
    | {
          op: "buffer-write";
          set: number;
          system: number;
          column: string;
          index: number;
          value: number;
      }
    | {
          op: "expect-alive";
          set: number;
          system: number;
          operator: "===" | "!==";
          value: number;
      };

/**
 * The scene camera the build reads.
 *
 * `UpdateFlowMapBlock` derives a view-projection from `scene.camera` while
 * the graph is built, and a missing camera leaves its update a no-op -- so
 * a driver whose scene has no camera silently simulates something else.
 * The camera is the scene's own construction, replayed.
 */
export interface NodeParticleCamera {
    kind: "arc-rotate";
    alpha: number;
    beta: number;
    radius: number;
    target: readonly [number, number, number];
    /** The scalar properties written after creation, in write order. */
    properties: Array<readonly [string, number]>;
}

/** One `buildNodeParticleSet*` call: the graph and the options it passed. */
export interface NodeParticleSetRequest {
    graph: NodeParticleGraphSource;
    builder: NodeParticleBuilder;
    emitter: readonly [number, number, number];
    textureBaseUrl?: string;
    /** The scene's camera when the build ran, when it had one. */
    camera?: NodeParticleCamera;
    /**
     * `enableNodeParticleBlendModes(set)`, applied after the build.
     *
     * The blend-mode builder is that call over `buildNodeParticleSet`, so a
     * scene reaching either route ends with the same set; this records the
     * second spelling so the driver runs the chain the scene wrote.
     */
    enableBlendModes?: boolean;
}

/**
 * One `registerNodeParticleSet2D*` call: the pure-2D bridge's mapping, its
 * layer presentation options and whether it takes the exact blend modes.
 *
 * The layer's capacity, depth, blend and pivot are bridge-owned upstream, so
 * only the four presentation fields travel; `view` is unreached and refuses.
 */
export interface NodeParticleSprite2DRequest {
    set: number;
    exact: boolean;
    autoStart: boolean;
    pixelsPerUnit: number;
    originPx: readonly [number, number];
    invertY: boolean;
    opacity?: number;
    visible?: boolean;
    order?: number;
}

/**
 * One `registerNodeParticleSet` call, which the scene makes on a whole set
 * rather than on a system it named.
 *
 * How many systems the set has is the graph's answer, so the expansion
 * happens in the driver — the one place that has the built set.
 */
export interface NodeParticleRegistration {
    set: number;
    autoStart: boolean;
}

/**
 * One `system.texture = createTexture2DFromPixels(...)` the scene wrote.
 *
 * A graph whose texture block carries no URL leaves the system untextured,
 * and both `createParticleBillboard` and the Sprite2D bridge throw there —
 * so the assignment is part of the program, and the driver replays it by
 * calling the same module the native asset bakes from.
 */
export interface NodeParticleTextureRequest {
    set: number;
    system: number;
    /** `generated:pixels:<module>#<export>`, the executed-module source. */
    source: string;
    width: number;
    height: number;
    /** The sampler literals the call named, in the pin's own spelling. */
    options: Record<string, string>;
}

/**
 * What the scene's whole node-particle program asks generation to run.
 *
 * One request per SCENE rather than per set, because the deterministic seed
 * is global: a scene that seeds `Math.random` once and then steps two sets
 * draws one sequence across both, and replaying each set in its own run
 * would restart it.
 */
export interface NodeParticleBakeRequest {
    sets: readonly NodeParticleSetRequest[];
    steps: readonly NodeParticleStep[];
    /** Which (set, system) pairs a `createParticleBillboard` froze. */
    billboards: readonly { set: number; system: number }[];
    /** Which sets `registerNodeParticleSet` registered on the scene. */
    registrations?: readonly NodeParticleRegistration[];
    /** The textures scene code assigned onto systems, in reach order. */
    textures?: readonly NodeParticleTextureRequest[];
    /** The pure-2D bridges a scene registered on a SpriteRenderer. */
    sprite2d?: readonly NodeParticleSprite2DRequest[];
}

/** The pinned `loadTexture2D` call the graph's texture block made. */
export interface NodeParticleTexture {
    /** The URL the graph's own block loaded, or "" for a scene texture. */
    url: string;
    /** `loadTexture2D`'s own `invertY`, as the block passed it. */
    invertY: boolean;
    /**
     * Whether scene code assigned this texture. Its bytes are already a
     * generated asset and its sampler is the pixels loader's, so nothing
     * about it is packaged from a URL.
     */
    sceneAssigned: boolean;
    width: number;
    height: number;
}

/**
 * One frozen system: the columns `syncParticleBillboard` reads, one entry
 * per live particle, plus what `createParticleBillboard` reads off the
 * system to build its atlas and its blend.
 */
export interface NodeParticleSystemBake {
    /** Which set, and which of its systems, as the scene indexed them. */
    set: number;
    system: number;
    capacity: number;
    /** The pin's numeric `system.blendMode`; `blendForMode` maps it. */
    blendMode: number;
    /**
     * `system.updateSpeed` after the scene's own steps, and whether one more
     * `animateParticleSystem(system, 1)` left every column it reads
     * untouched.
     *
     * `registerNodeParticleSet` appends a callback that animates and
     * re-synchronizes every frame, which one frozen state cannot answer in
     * general. It CAN answer it for a system the scene froze, and that is a
     * measurement rather than an argument about the graph's blocks: the
     * driver takes the state, steps once more, and compares. Generation
     * refuses a registration where either half fails.
     */
    updateSpeed: number;
    stepIsIdentity: boolean;
    texture: NodeParticleTexture | null;
    spriteSheet: { cellWidth: number; cellHeight: number } | null;
    /** `buffer.alive` — the length of every column below. */
    alive: number;
    positions: number[];
    /** `size * scaleX`, `size * scaleY` — the product the pin writes. */
    sizes: number[];
    colors: number[];
    rotations: number[];
    /** `_spriteSheet.cellIndex` per particle, or null without a sheet. */
    frames: number[] | null;
}

/**
 * Which systems one registration walked, in the pin's own order.
 *
 * A set's system count is the graph's answer and `systems.push` can add one
 * from another set, so the list is observed rather than predicted: the
 * driver reads `set.systems` at the point the scene registered it.
 */
export interface NodeParticleExpansion {
    /** Index into the request's `registrations` or `sprite2d` list. */
    request: number;
    /** The request's own `autoStart`, which the identity probe replays. */
    autoStart: boolean;
    systems: Array<{ set: number; system: number }>;
}

export interface NodeParticleBake {
    systems: NodeParticleSystemBake[];
    /** `registerNodeParticleSet` expansions, in request order. */
    registrations: NodeParticleExpansion[];
    /** `registerNodeParticleSet2D*` expansions, in request order. */
    sprite2d: NodeParticleExpansion[];
}

/** The pinned package path the served driver imports. */
const pinnedPackage = pinnedBrowserEntryUrl;

function graphExpression(graph: NodeParticleGraphSource): string {
    if (graph.kind === "literal") {
        return JSON.stringify(graph.graph);
    }
    const args = graph.args.map((value) => JSON.stringify(value)).join(", ");
    return `${graph.exportName}(${args})`;
}

/**
 * The scene modules the driver imports, one line each, deduplicated: the
 * graph factories and the pixel-buffer factories a texture assignment names.
 *
 * The corpus writes `../shared/sceneNNN-npe.js`; the suite server transpiles
 * the `.ts` sibling on demand, which is the same resolution the reference
 * capture performs for the scene's own imports.
 */
function graphImports(request: NodeParticleBakeRequest): string {
    const lines = new Set<string>();
    const moduleImport = (module: string, exportName: string): void => {
        const specifier = `/${module.replace(/\.ts$/, ".js")}`;
        lines.add(
            `import { ${exportName} } from ` +
                `${JSON.stringify(specifier)};`,
        );
    };
    for (const set of request.sets) {
        if (set.graph.kind !== "module") continue;
        moduleImport(set.graph.module, set.graph.exportName);
    }
    for (const texture of request.textures ?? []) {
        const { module, exportName } = pixelsModule(texture.source);
        moduleImport(module, exportName);
    }
    return [...lines].join("\n");
}

/** The module and export a `generated:pixels:` source names. */
function pixelsModule(source: string): {
    module: string;
    exportName: string;
} {
    const prefix = "generated:pixels:";
    const separator = source.lastIndexOf("#");
    if (!source.startsWith(prefix) || separator < 0) {
        throw new Error(
            `A node-particle texture names '${source}', which is not an ` +
                "executed pixel-buffer module.",
        );
    }
    return {
        module: source.slice(prefix.length, separator),
        exportName: source.slice(separator + 1),
    };
}

/**
 * The scene's own texture assignments, replayed before anything reads a
 * system's texture. The options travel as the pin's own literals, so the
 * driver's call is the scene's call.
 */
function textureAssignments(
    textures: readonly NodeParticleTextureRequest[],
): string {
    return textures
        .map((texture) => {
            const { exportName } = pixelsModule(texture.source);
            const options = Object.entries(texture.options)
                .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
                .join(", ");
            return (
                `    systemAt(${texture.set}, ${texture.system}).texture = ` +
                `createTexture2DFromPixels(engine, ${exportName}(), ` +
                `${texture.width}, ${texture.height}` +
                `${options ? `, { ${options} }` : ""});`
            );
        })
        .join("\n");
}

function stepProgram(steps: readonly NodeParticleStep[]): string {
    const lines: string[] = [];
    for (const step of steps) {
        if (step.op === "push-system") {
            lines.push(
                `    sets[${step.set}].systems.push(` +
                    `systemAt(${step.fromSet}, ${step.fromSystem}));`,
            );
            continue;
        }
        if (step.op === "random-restore") {
            lines.push("    Math.random = originalRandom;");
            continue;
        }
        if (step.op === "random") {
            // The captures and the arrow go into a scope of their own. They
            // are the scene's own names, and the driver's top level already
            // holds the engine, the scene, the sets and every pinned import
            // -- a seed named `scene` would otherwise redeclare one of them
            // and throw from code the scene's author never wrote.
            lines.push(
                "    Math.random = (() => {",
                ...step.declarations.map(
                    (declaration) => `        ${declaration}`,
                ),
                `        return ${step.arrow};`,
                "    })();",
            );
            continue;
        }
        const system = `systemAt(${step.set}, ${step.system})`;
        if (step.op === "buffer-write") {
            lines.push(
                `    ${system}.buffer.${step.column}[${step.index}] = ` +
                    `${step.value};`,
            );
        } else if (step.op === "expect-alive") {
            // The scene's own message is a template over the very count it
            // rejects; the driver knows that count, so it reports the real
            // one rather than replaying text with an interpolation.
            const label =
                `node-particle bake: set ${step.set} system ` +
                `${step.system} has `;
            const tail =
                ` live particles, which the scene's own guard rejects ` +
                `(${step.operator} ${step.value}).`;
            lines.push(
                `    if (${system}.buffer.alive ${step.operator} ` +
                    `${step.value}) {`,
                `        throw new Error(${JSON.stringify(label)} + ` +
                    `${system}.buffer.alive + ${JSON.stringify(tail)});`,
                "    }",
            );
        } else if (step.op === "start") {
            lines.push(`    startParticleSystem(${system});`);
        } else if (step.op === "stop") {
            lines.push(`    stopParticleSystem(${system});`);
        } else if (step.op === "scalar") {
            lines.push(`    ${system}.${step.name} = ${step.value};`);
        } else {
            lines.push(
                `    animateParticleSystem(${system}, ${step.ratio});`,
            );
        }
    }
    return lines.join("\n");
}

function cameraLines(set: NodeParticleSetRequest): string[] {
    if (!set.camera) return [];
    const { alpha, beta, radius, target } = set.camera;
    return [
        `    scene.camera = createArcRotateCamera(${alpha}, ${beta}, ` +
            `${radius}, { x: ${target[0]}, y: ${target[1]}, ` +
            `z: ${target[2]} });`,
        ...set.camera.properties.map(
            ([name, value]) => `    scene.camera.${name} = ${value};`,
        ),
    ];
}

/**
 * The graph argument a build reads: the parse, wrapped in the pin's own
 * normalizer when the scene wrapped it. The composition is the pin's
 * documented one -- `normalizeNodeParticleGraph(parseNodeParticleSource(x))`
 * -- and it stays async because the normalizer fetches its heavy runtime
 * lazily, only for a graph that actually carries a Teleport-family block.
 */
function graphArgument(graph: NodeParticleGraphSource): string {
    const parsed = `parseNodeParticleSource(${graphExpression(graph)})`;
    return graph.normalized
        ? `await normalizeNodeParticleGraph(${parsed})`
        : parsed;
}

function buildCalls(sets: readonly NodeParticleSetRequest[]): string {
    return sets
        .map((set, index) =>
            [
                ...cameraLines(set),
                `    sets[${index}] = await ${set.builder}(engine, scene,`,
                `        ${graphArgument(set.graph)}, {`,
                `        emitter: { x: ${set.emitter[0]}, ` +
                    `y: ${set.emitter[1]}, z: ${set.emitter[2]} },`,
                ...(set.textureBaseUrl === undefined
                    ? []
                    : [
                          "        textureBaseUrl: " +
                              `${JSON.stringify(set.textureBaseUrl)},`,
                      ]),
                "    });",
                ...(set.enableBlendModes
                    ? [
                          `    sets[${index}] = ` +
                              `enableNodeParticleBlendModes(sets[${index}]);`,
                      ]
                    : []),
            ].join("\n"),
        )
        .join("\n");
}

/**
 * The pinned entry points the driver imports beyond the fixed set: the
 * builders the scene reached, and the enabler when one of them applied it.
 */
function driverImports(sets: readonly NodeParticleSetRequest[]): string[] {
    const names = new Set<string>(sets.map((set) => set.builder));
    if (sets.some((set) => set.enableBlendModes)) {
        names.add("enableNodeParticleBlendModes");
    }
    if (sets.some((set) => set.graph.normalized)) {
        names.add("normalizeNodeParticleGraph");
    }
    return [...names];
}

/**
 * The driver: the pinned chain, in the order the scene wrote it.
 *
 * It is a module the compiler assembles rather than the scene's own source
 * -- the compiler already lowered that source, so it knows the sequence --
 * which keeps generation out of the business of running arbitrary scene
 * code. What crosses from the scene is data (each graph, each emitter, each
 * ratio) plus the one function a deterministic seed has to be.
 */
function driverModule(request: NodeParticleBakeRequest): string {
    const builders = driverImports(request.sets).join(`,\n         `);
    return `import { createEngine, createSceneContext, enableDeviceLostSceneRecovery,
         createArcRotateCamera, parseNodeParticleSource, startParticleSystem,
         stopParticleSystem, animateParticleSystem, createParticleBillboard,
         syncParticleBillboard, createTexture2DFromPixels,
         ${builders} } from ${JSON.stringify(pinnedPackage)};
${graphImports(request)}

window.__bakeNodeParticles = async () => {
    const canvas = document.getElementById("renderCanvas");
    const engine = await createEngine(canvas);
    // The pin's own recovery capture records every loadTexture2D against the
    // texture it produced, so a graph's texture URL and its options are read
    // back from the pin rather than re-resolved here.
    enableDeviceLostSceneRecovery(engine);
    const scene = createSceneContext(engine);
    // Held so a scene that closes its seeded window puts back the same
    // generator the page started with.
    const originalRandom = Math.random;
    const sets = [];
${buildCalls(request.sets)}
    const systemAt = (setIndex, index) => {
        const system = sets[setIndex].systems[index];
        if (!system) {
            throw new Error("node-particle bake: set " + setIndex + " built " +
                sets[setIndex].systems.length +
                " system(s); the scene names index " + index);
        }
        return system;
    };
    // The (set, system) pair a system was BUILT as, stamped before any
    // systems.push can move it into another set's list.
    const origins = new Map();
    for (let setIndex = 0; setIndex < sets.length; setIndex++) {
        sets[setIndex].systems.forEach((system, index) => {
            if (!origins.has(system)) {
                origins.set(system, { set: setIndex, system: index });
            }
        });
    }
    const originOf = (system) => {
        const origin = origins.get(system);
        if (!origin) {
            throw new Error("node-particle bake: a registered system was not built by any set");
        }
        return origin;
    };
${textureAssignments(request.textures ?? [])}
${stepProgram(request.steps)}
    // A registration names a SET; how many systems it has is the graph's
    // answer, and systems.push can add one built elsewhere, so the
    // expansion happens here, in the pin's own order. Each system carries
    // the (set, system) pair it was BUILT as, which is the key the baked
    // table is looked up by.
    const frozen = ${JSON.stringify([...request.billboards])};
    const expand = (requests) =>
        requests.map(({ set: setIndex, autoStart }, request) => ({
            request,
            autoStart: autoStart ?? true,
            systems: sets[setIndex].systems.map((system) => {
                const origin = originOf(system);
                if (!frozen.some((entry) =>
                    entry.set === origin.set && entry.system === origin.system)) {
                    frozen.push({ set: origin.set, system: origin.system });
                }
                return origin;
            }),
        }));
    const registrationExpansions = expand(${JSON.stringify([
        ...(request.registrations ?? []),
    ])});
    const sprite2dExpansions = expand(${JSON.stringify([
        ...(request.sprite2d ?? []),
    ])});
    const sceneTextures = ${JSON.stringify(
        (request.textures ?? []).map(({ set, system }) => ({ set, system })),
    )};
    const systems = [];
    for (const { set: setIndex, system: index } of frozen) {
        const system = systemAt(setIndex, index);
        // The billboard is built and synced so the atlas the pin derives and
        // the count it writes are observed rather than predicted; the bake
        // itself is the buffer that sync reads.
        const billboard = createParticleBillboard(system);
        syncParticleBillboard(system, billboard);
        const buffer = system.buffer;
        const alive = buffer.alive;
        if (alive !== billboard.count) {
            throw new Error("node-particle bake: sync wrote " + billboard.count +
                " of " + alive + " live particles");
        }
        const sheet = system._spriteSheet;
        // A texture the SCENE assigned came from createTexture2DFromPixels,
        // whose bytes are already a generated asset; only a texture the
        // graph's own block loaded carries a URL to package.
        const sceneTextured = sceneTextures.some(
            (entry) => entry.set === setIndex && entry.system === index);
        const source = system.texture && !sceneTextured
            ? system.texture._recoverySource
            : null;
        if (system.texture && !sceneTextured && (!source || source.kind !== "url")) {
            throw new Error("node-particle bake: the system's texture is not a loaded image");
        }
        const positions = [];
        const sizes = [];
        const colors = [];
        const rotations = [];
        const frames = sheet ? [] : null;
        for (let i = 0; i < alive; i++) {
            positions.push(buffer.posX[i], buffer.posY[i], buffer.posZ[i]);
            sizes.push(buffer.size[i] * buffer.scaleX[i], buffer.size[i] * buffer.scaleY[i]);
            colors.push(buffer.colorR[i], buffer.colorG[i], buffer.colorB[i], buffer.colorA[i]);
            rotations.push(buffer.angle[i]);
            if (frames) frames.push(sheet.cellIndex[i]);
        }
        systems.push({
            set: setIndex,
            system: index,
            capacity: buffer.capacity,
            blendMode: system.blendMode,
            updateSpeed: system.updateSpeed,
            stepIsIdentity: false,
            texture: system.texture
                ? {
                      url: source ? source.url : "",
                      invertY: source ? source.opts.invertY === true : false,
                      sceneAssigned: sceneTextured,
                      width: system.texture.width,
                      height: system.texture.height,
                  }
                : null,
            spriteSheet: sheet
                ? { cellWidth: sheet.cellWidth, cellHeight: sheet.cellHeight }
                : null,
            alive,
            positions,
            sizes,
            colors,
            rotations,
            frames,
        });
    }
    // Every state is read before any probe runs: a probe step consumes the
    // seeded sequence, and a later system's extraction must not see it.
    // Only a REGISTERED system needs the probe -- it is the per-frame step
    // that has to be the identity -- and the step is a full simulation
    // frame, so a scene that registers nothing pays nothing.
    // A registration with autoStart starts its systems BEFORE the hook
    // runs, and an unstarted system leaves animateParticleSystem at its
    // first line -- so the probe replays the start it would have had.
    const hooked = new Map();
    for (const expansion of registrationExpansions.concat(sprite2dExpansions)) {
        for (const entry of expansion.systems) {
            const key = entry.set + ":" + entry.system;
            hooked.set(key, (hooked.get(key) ?? false) || expansion.autoStart);
        }
    }
    for (const baked of systems) {
        if (!hooked.has(baked.set + ":" + baked.system)) continue;
        const system = systemAt(baked.set, baked.system);
        if (hooked.get(baked.set + ":" + baked.system)) {
            startParticleSystem(system);
        }
        animateParticleSystem(system, 1);
        const buffer = system.buffer;
        const sheet = system._spriteSheet;
        let same = buffer.alive === baked.alive;
        for (let i = 0; same && i < buffer.alive; i++) {
            same =
                buffer.posX[i] === baked.positions[i * 3] &&
                buffer.posY[i] === baked.positions[i * 3 + 1] &&
                buffer.posZ[i] === baked.positions[i * 3 + 2] &&
                buffer.size[i] * buffer.scaleX[i] === baked.sizes[i * 2] &&
                buffer.size[i] * buffer.scaleY[i] === baked.sizes[i * 2 + 1] &&
                buffer.colorR[i] === baked.colors[i * 4] &&
                buffer.colorG[i] === baked.colors[i * 4 + 1] &&
                buffer.colorB[i] === baked.colors[i * 4 + 2] &&
                buffer.colorA[i] === baked.colors[i * 4 + 3] &&
                buffer.angle[i] === baked.rotations[i] &&
                (!sheet || sheet.cellIndex[i] === baked.frames[i]);
        }
        baked.stepIsIdentity = same;
    }
    return {
        systems,
        registrations: registrationExpansions,
        sprite2d: sprite2dExpansions,
    };
};
`;
}

function assertBake(value: unknown): NodeParticleBake {
    if (
        typeof value !== "object" ||
        value === null ||
        !Array.isArray((value as { systems?: unknown }).systems) ||
        !Array.isArray((value as { sprite2d?: unknown }).sprite2d)
    ) {
        throw new Error("The node-particle bake returned no systems.");
    }
    return value as NodeParticleBake;
}

/**
 * Run one reached node-particle set through the pin in headless Chromium and
 * return the frozen state it produced.
 *
 * The simulation is deterministic in its declared inputs — the driver
 * text (which carries every graph literal, step and seeded-random
 * arrow), the scene-adjacent modules the driver imports (graph
 * factories and pixel-buffer factories, with their sibling imports),
 * the pin, and the Chrome that runs it — so a repeat compile replays
 * the frozen state from the bake cache. The cached payload is exactly
 * the JSON that crossed the page boundary, and a request whose module
 * closure cannot be resolved is baked uncached rather than guessed at.
 */
export async function bakeNodeParticles(
    request: NodeParticleBakeRequest,
): Promise<NodeParticleBake> {
    const driver = driverModule(request);
    const bake = async (): Promise<NodeParticleBake> => {
        const server = createSuiteSceneServer(driver);
        const result = await runPageGlobal(server, "__bakeNodeParticles", {
            serverName: "node-particle bake server",
            browserRequirement:
                "Baking a node-particle simulation requires Chrome or Edge.",
            browserArgs: screenshotCaptureBrowserArgs,
            viewport: { width: 1280, height: 720 },
            pageErrorPrefix: "Node particle",
        });
        return assertBake(result);
    };
    const modules = new Set<string>();
    for (const set of request.sets) {
        if (set.graph.kind === "module") modules.add(set.graph.module);
    }
    for (const texture of request.textures ?? []) {
        modules.add(pixelsModule(texture.source).module);
    }
    const closure = moduleClosureBytes([...modules]);
    if (closure === undefined) return bake();
    return assertBake(
        await cachedJsonBake<NodeParticleBake>(
            {
                kind: "node-particle",
                version: "1",
                module: moduleIdentity(import.meta.url),
                browser: true,
                parameters: {},
                inputs: [Buffer.from(driver, "utf8"), ...closure],
            },
            bake,
        ),
    );
}
