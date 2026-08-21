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
import { createSuiteSceneServer } from "./capture-suite-reference.js";
import {
    gotoScenePage,
    screenshotCaptureBrowserArgs,
    withBrowserPage,
} from "./browser-harness.js";

/** The graph a `parseNodeParticleSource` call reached. */
export type NodeParticleGraphSource =
    | { kind: "literal"; graph: Record<string, unknown> }
    | {
          kind: "module";
          module: string;
          exportName: string;
          /** The factory's own arguments, as the static JSON they are. */
          args: readonly unknown[];
      };

/** The pinned builders a scene reaches, by their own export names. */
export type NodeParticleBuilder =
    | "buildNodeParticleSet"
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
     * The deterministic `Math.random` the scene installs before stepping.
     * Its text is the scene's own arrow, moved into the driver rather than
     * restated: the driver runs in the same engine the golden does, so an
     * identical arrow draws an identical sequence by construction. The
     * compiler refuses an arrow that captures anything but statically
     * numeric locals, and refuses the assignment outright if the scene
     * reaches `Math.random` anywhere the native runtime would answer.
     */
    | { op: "random"; declarations: readonly string[]; arrow: string };

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
}

/** The pinned `loadTexture2D` call the graph's texture block made. */
export interface NodeParticleTexture {
    url: string;
    /** `loadTexture2D`'s own `invertY`, as the block passed it. */
    invertY: boolean;
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

export interface NodeParticleBake {
    systems: NodeParticleSystemBake[];
}

/** The pinned package path the served driver imports. */
const pinnedPackage = "/node_modules/@babylonjs/lite/lib/index.js";

function graphExpression(graph: NodeParticleGraphSource): string {
    if (graph.kind === "literal") {
        return JSON.stringify(graph.graph);
    }
    const args = graph.args.map((value) => JSON.stringify(value)).join(", ");
    return `${graph.exportName}(${args})`;
}

/**
 * The graph modules the driver imports, one line each, deduplicated.
 *
 * The corpus writes `../shared/sceneNNN-npe.js`; the suite server transpiles
 * the `.ts` sibling on demand, which is the same resolution the reference
 * capture performs for the scene's own imports.
 */
function graphImports(sets: readonly NodeParticleSetRequest[]): string {
    const lines = new Set<string>();
    for (const set of sets) {
        if (set.graph.kind !== "module") continue;
        const specifier = `/${set.graph.module.replace(/\.ts$/, ".js")}`;
        lines.add(
            `import { ${set.graph.exportName} } from ` +
                `${JSON.stringify(specifier)};`,
        );
    }
    return [...lines].join("\n");
}

function stepProgram(steps: readonly NodeParticleStep[]): string {
    const lines: string[] = [];
    for (const step of steps) {
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
        if (step.op === "start") {
            lines.push(`    startParticleSystem(${system});`);
        } else if (step.op === "stop") {
            lines.push(`    stopParticleSystem(${system});`);
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

function buildCalls(sets: readonly NodeParticleSetRequest[]): string {
    return sets
        .map((set, index) =>
            [
                ...cameraLines(set),
                `    sets[${index}] = await ${set.builder}(engine, scene,`,
                `        parseNodeParticleSource(${graphExpression(set.graph)}), {`,
                `        emitter: { x: ${set.emitter[0]}, ` +
                    `y: ${set.emitter[1]}, z: ${set.emitter[2]} },`,
                ...(set.textureBaseUrl === undefined
                    ? []
                    : [
                          "        textureBaseUrl: " +
                              `${JSON.stringify(set.textureBaseUrl)},`,
                      ]),
                "    });",
            ].join("\n"),
        )
        .join("\n");
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
    const builders = [
        ...new Set(request.sets.map((set) => set.builder)),
    ].join(`,\n         `);
    return `import { createEngine, createSceneContext, enableDeviceLostSceneRecovery,
         createArcRotateCamera, parseNodeParticleSource, startParticleSystem,
         stopParticleSystem, animateParticleSystem, createParticleBillboard,
         syncParticleBillboard,
         ${builders} } from ${JSON.stringify(pinnedPackage)};
${graphImports(request.sets)}

window.__bakeNodeParticles = async () => {
    const canvas = document.getElementById("renderCanvas");
    const engine = await createEngine(canvas);
    // The pin's own recovery capture records every loadTexture2D against the
    // texture it produced, so a graph's texture URL and its options are read
    // back from the pin rather than re-resolved here.
    enableDeviceLostSceneRecovery(engine);
    const scene = createSceneContext(engine);
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
${stepProgram(request.steps)}
    const systems = [];
    for (const { set: setIndex, system: index } of ${JSON.stringify([...request.billboards])}) {
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
        const source = system.texture ? system.texture._recoverySource : null;
        if (system.texture && (!source || source.kind !== "url")) {
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
            texture: system.texture
                ? {
                      url: source.url,
                      invertY: source.opts.invertY === true,
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
    return { systems };
};
`;
}

function assertBake(value: unknown): NodeParticleBake {
    if (
        typeof value !== "object" ||
        value === null ||
        !Array.isArray((value as { systems?: unknown }).systems)
    ) {
        throw new Error("The node-particle bake returned no systems.");
    }
    return value as NodeParticleBake;
}

/**
 * Run one reached node-particle set through the pin in headless Chromium and
 * return the frozen state it produced.
 */
export async function bakeNodeParticles(
    request: NodeParticleBakeRequest,
): Promise<NodeParticleBake> {
    const server = createSuiteSceneServer(driverModule(request));
    const result = await withBrowserPage(
        server,
        {
            serverName: "node-particle bake server",
            browserRequirement:
                "Baking a node-particle simulation requires Chrome or Edge.",
            browserArgs: screenshotCaptureBrowserArgs,
            viewport: { width: 1280, height: 720 },
            pageErrorPrefix: "Node particle",
        },
        async (page, origin) => {
            await gotoScenePage(page, origin);
            await page.waitForFunction(
                "typeof window.__bakeNodeParticles === 'function'",
                null,
                { timeout: 60_000 },
            );
            return page.evaluate("window.__bakeNodeParticles()");
        },
    );
    return assertBake(result);
}
