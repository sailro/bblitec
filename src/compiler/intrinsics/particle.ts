// The node-particle family: a graph, the set built from it, and the frozen
// simulation a scene steps before its first frame.
//
// Upstream's `src/particle/` is a CPU simulation whose behaviour is
// assembled at load: `npe-build.ts` walks the graph and dynamically imports
// one evaluator per block class, each installing closures onto the system.
// There is no shape to fold there, and the value those closures produce is
// fragile -- the corpus seeds `Math.random` through `Math.sin`, which is not
// bit-portable off V8 -- so the simulation is EXECUTED at generation and its
// particle state baked (`src/pinned-node-particle.ts` carries the argument).
//
// Everything downstream stays folded. `createParticleBillboard` and
// `syncParticleBillboard` are lowered from their own pinned declarations, so
// the atlas the pin derives, the blend its mode selects and the per-particle
// write all keep the pin's shape; what this module records is the program
// the scene ran, nothing more.
//
// What refuses here, each by name: a snippet id (a network read at page
// load), a set registered on the scene (its `_beforeRender` hook animates
// per frame, which a frozen bake cannot answer), the blend-mode and
// Sprite2D-bridge builders, and a system stepped after its billboard was
// synced.
import { createHash } from "node:crypto";
import ts from "typescript";
import {
    staticGraphDocument,
    type ExecutedModuleReferenceContext,
} from "../assets.js";
import {
    compileStaticNumber,
    notJson,
    staticJsonValue,
    staticVec3Value,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";
import type {
    CompiledNodeParticles,
    NodeParticleManifest,
    Value,
} from "../types.js";
import type {
    NodeParticleBuilder,
    NodeParticleGraphSource,
} from "../../pinned-node-particle.js";
import type { IntrinsicCallContext } from "./context.js";

export interface ParticleIntrinsicContext
    extends
        IntrinsicCallContext,
        ExecutedModuleReferenceContext,
        ObjectValidationContext,
        PositiveIntegerContext {
    /** The scene's node-particle program; this module appends to it. */
    readonly reachedNodeParticles: CompiledNodeParticles;
    requireDefaultEngine(node: ts.Node): string;
    compileStaticString(expression: ts.Expression): string;
    /** One system built with the stock program, as the pin's own is. */
    recordPlainSpriteProgram(family: "sprite" | "billboard"): void;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    emit(line: string): void;
}

/** The three builders the corpus reaches, by their own export names. */
const builders: Readonly<Record<string, NodeParticleBuilder>> = {
    buildNodeParticleSet: "buildNodeParticleSet",
    buildNodeParticleSetWithFlowMaps: "buildNodeParticleSetWithFlowMaps",
    buildNodeParticleSetWithNoiseTextures:
        "buildNodeParticleSetWithNoiseTextures",
};

/**
 * The graph a `parseNodeParticleSource` call reached.
 *
 * The two routes are the node-material family's, because the corpus writes a
 * particle graph both ways too: a module exporting the document outright is
 * read as data (the fold, and a literal cannot drift), while a module that
 * BUILDS its document at load -- `structuredClone`, `Math.max` over ids,
 * arrays it pushes into -- is code this compiler does not lower, so the
 * driver imports and calls it.
 */
function graphSource(
    context: ParticleIntrinsicContext,
    expression: ts.Expression,
): NodeParticleGraphSource {
    const document = staticGraphDocument(
        context,
        expression,
        "node-particle",
        // A module that BUILDS its document at load -- `structuredClone`,
        // `Math.max` over ids, arrays it pushes into -- is code this
        // compiler does not lower, so the driver calls it.
        "factory",
    );
    if (document.kind === "literal") {
        return { kind: "literal", graph: document.graph };
    }
    // The factory's own arguments travel as the static JSON they are: the
    // corpus passes a flags record assembled from browser-folded values, so
    // by the time it reaches here every field is a constant.
    return {
        kind: "module",
        module: document.module,
        exportName: document.exportName,
        args: (document.call?.arguments ?? []).map((argument) =>
            staticArgumentJson(context, argument),
        ),
    };
}

/**
 * One argument a graph factory takes, as the static JSON it is.
 *
 * A literal reads straight through, and everything else the corpus writes
 * folds before it gets here: a flag derived from the URL is browser-erased
 * to a constant, and a conditional over one keeps only the branch that
 * survives. An explicit `undefined` is dropped rather than serialized,
 * which is what a factory reading `options.x ?? default` already sees.
 */
function staticArgumentJson(
    context: ParticleIntrinsicContext,
    expression: ts.Expression,
): unknown {
    const node = context.unwrap(expression);
    if (ts.isIdentifier(node) && node.text === "undefined") {
        return undefined;
    }
    if (ts.isObjectLiteralExpression(node)) {
        const record: Record<string, unknown> = {};
        for (const property of node.properties) {
            const value = ts.isShorthandPropertyAssignment(property)
                ? property.name
                : ts.isPropertyAssignment(property)
                    ? property.initializer
                    : undefined;
            const name = value
                ? context.propertyName(property.name!)
                : undefined;
            if (!value || name === undefined) {
                context.fail(
                    property,
                    "A node-particle graph factory's options are named " +
                        "properties with static values.",
                );
            }
            const member = staticArgumentJson(context, value);
            if (member === undefined) continue;
            record[name] = member;
        }
        return record;
    }
    if (ts.isArrayLiteralExpression(node)) {
        return node.elements.map((element) =>
            staticArgumentJson(context, element),
        );
    }
    if (ts.isConditionalExpression(node)) {
        const condition = staticArgumentJson(context, node.condition);
        if (typeof condition !== "boolean") {
            context.fail(
                node.condition,
                "A node-particle graph factory's option condition must " +
                    "fold to a static boolean.",
            );
        }
        return staticArgumentJson(
            context,
            condition ? node.whenTrue : node.whenFalse,
        );
    }
    const literal = staticJsonValue(context, node);
    if (literal !== notJson) return literal;
    // Not a literal: the compiled value is, which is where a browser-derived
    // flag has already folded to the constant it is.
    const value = context.compileValue(node);
    if (value.staticNumber !== undefined) return value.staticNumber;
    if (value.staticString !== undefined) return value.staticString;
    if (value.browserValue) {
        if (
            value.browserValue.kind === "boolean" ||
            value.browserValue.kind === "number"
        ) {
            return value.browserValue.value;
        }
        if (value.browserValue.kind === "null") return null;
    }
    if (value.kind === "boolean" && (value.cpp === "true" || value.cpp === "false")) {
        return value.cpp === "true";
    }
    context.fail(
        node,
        "A node-particle graph factory takes static arguments.",
    );
}

/** `{ x, y, z }` as the three static numbers the pin's own option is. */
function emitterVector(
    context: ParticleIntrinsicContext,
    expression: ts.Expression | undefined,
): readonly [number, number, number] {
    if (!expression) return [0, 0, 0];
    const vector = staticVec3Value(context, expression);
    if (!vector) {
        context.fail(
            expression,
            "A node-particle emitter is a static { x, y, z } record.",
        );
    }
    return vector;
}

/** Which set and system a call's argument names, with its value. */
function systemOf(
    context: ParticleIntrinsicContext,
    call: ts.CallExpression,
    argumentIndex: number,
): { value: Value; set: number; system: number } {
    const argument = call.arguments[argumentIndex];
    if (!argument) {
        context.fail(call, "A particle-system call needs its system.");
    }
    const value = context.compileValue(argument);
    context.expectKind(value, "node-particle-system", argument);
    if (
        value.nodeParticleSetIndex === undefined ||
        value.nodeParticleSystemIndex === undefined
    ) {
        context.fail(
            argument,
            "This particle system did not come from a built node-particle set.",
        );
    }
    return {
        value,
        set: value.nodeParticleSetIndex,
        system: value.nodeParticleSystemIndex,
    };
}

/** Whether a `createParticleBillboard` already froze this system. */
function isFrozen(
    context: ParticleIntrinsicContext,
    set: number,
    system: number,
): boolean {
    return context.reachedNodeParticles.billboards.some(
        (frozen) => frozen.set === set && frozen.system === system,
    );
}

/**
 * Refuse a step recorded after the system's state was already baked.
 *
 * `createParticleBillboard` folds the frozen state, so a scene that steps
 * the simulation again afterwards is asking for a second frame this port
 * does not carry -- and silently baking the earlier one would render the
 * wrong pose.
 */
function requireUnbaked(
    context: ParticleIntrinsicContext,
    set: number,
    system: number,
    node: ts.Node,
): void {
    if (isFrozen(context, set, system)) {
        context.fail(
            node,
            "This particle system was already frozen by " +
                "createParticleBillboard; the bake carries one state.",
        );
    }
}

export function compileParticleIntrinsic(
    context: ParticleIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "parseNodeParticleSource": {
            context.expectArgumentCount(call, 1, 1);
            return {
                kind: "node-particle-graph",
                cpp: "",
                nodeParticleGraph: graphSource(
                    context,
                    call.arguments[0]!,
                ),
            };
        }

        case "buildNodeParticleSet":
        case "buildNodeParticleSetWithFlowMaps":
        case "buildNodeParticleSetWithNoiseTextures": {
            context.expectArgumentCount(call, 3, 4);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const scene = context.compileValue(call.arguments[1]!);
            context.expectKind(scene, "scene", call.arguments[1]!);
            const graph = context.compileValue(call.arguments[2]!);
            context.expectKind(
                graph,
                "node-particle-graph",
                call.arguments[2]!,
            );
            let emitter: readonly [number, number, number] = [0, 0, 0];
            let textureBaseUrl: string | undefined;
            const optionsArgument = call.arguments[3];
            if (optionsArgument) {
                const options = context.expectObjectLiteral(optionsArgument);
                validateObjectProperties(
                    context,
                    options,
                    ["emitter", "textureBaseUrl"],
                    "Reached node-particle builds take 'emitter' and " +
                        "'textureBaseUrl'; an emitter world matrix is not " +
                        "lowered.",
                );
                emitter = emitterVector(
                    context,
                    context.objectProperty(options, "emitter"),
                );
                const base = context.objectProperty(
                    options,
                    "textureBaseUrl",
                );
                if (base) {
                    textureBaseUrl = context.compileStaticString(base);
                }
            }
            // A flow-map graph derives its view-projection from the
            // scene's camera during the build, so the driver replays that
            // camera; a builder that reaches the arm without a recordable
            // one refuses rather than simulating with the update disabled.
            const camera = scene.sceneCamera?.cameraProgram;
            if (
                importedName === "buildNodeParticleSetWithFlowMaps" &&
                !camera
            ) {
                context.fail(
                    call.arguments[1]!,
                    "A flow-map node-particle build reads the scene's " +
                        "camera; this scene's camera is not a static " +
                        "arc-rotate construction.",
                );
            }
            context.reachedNodeParticles.sets.push({
                graph: graph.nodeParticleGraph!,
                builder: builders[importedName]!,
                emitter,
                ...(textureBaseUrl === undefined ? {} : { textureBaseUrl }),
                ...(camera ? { camera } : {}),
            });
            return {
                kind: "node-particle-set",
                cpp: "",
                nodeParticleSetIndex:
                    context.reachedNodeParticles.sets.length - 1,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "startParticleSystem":
        case "stopParticleSystem": {
            context.expectArgumentCount(call, 1, 1);
            const { set, system } = systemOf(context, call, 0);
            requireUnbaked(context, set, system, call);
            context.reachedNodeParticles.steps.push({
                op: importedName === "startParticleSystem" ? "start" : "stop",
                set,
                system,
            });
            return { kind: "void", cpp: "" };
        }

        case "animateParticleSystem": {
            // The pin also takes a camera and a target size, which only its
            // billboard-free render paths read; no reached scene passes one.
            context.expectArgumentCount(call, 2, 2);
            const { set, system } = systemOf(context, call, 0);
            requireUnbaked(context, set, system, call);
            const ratio = compileStaticNumber(
                context,
                call.arguments[1]!,
                "animateParticleSystem's scaled ratio",
            );
            context.reachedNodeParticles.steps.push({
                op: "animate",
                set,
                system,
                ratio,
            });
            return { kind: "void", cpp: "" };
        }

        case "createParticleBillboard": {
            context.expectArgumentCount(call, 1, 1);
            const { value, set, system } = systemOf(context, call, 0);
            if (!isFrozen(context, set, system)) {
                context.reachedNodeParticles.billboards.push({ set, system });
            }
            const engineCpp =
                value.engineCpp ?? context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            context.reachFeature("particle:node", call);
            // createParticleBillboard builds a stock facing system: the
            // pin's own particle path installs no custom shader.
            context.recordPlainSpriteProgram("billboard");
            return {
                kind: "billboard-system",
                cpp:
                    "bbl::upstream::create_node_particle_billboard(" +
                    `${engineCpp}, ${set}, ${system})`,
                engineCpp,
            };
        }

        case "syncParticleBillboard": {
            context.expectArgumentCount(call, 2, 2);
            const { set, system } = systemOf(context, call, 0);
            const billboard = context.compileValue(call.arguments[1]!);
            context.expectKind(
                billboard,
                "billboard-system",
                call.arguments[1]!,
            );
            const frozen = context.reachedNodeParticles.billboards.find(
                (candidate) =>
                    candidate.set === set && candidate.system === system,
            );
            if (!frozen) {
                context.fail(
                    call,
                    "syncParticleBillboard writes the billboard " +
                        "createParticleBillboard made for this system.",
                );
            }
            // One frozen state, one write: the generated sync appends to a
            // system the generated create just made, so the pin's own
            // clearBillboardSprites is the identity there and a second call
            // would double every particle.
            if (frozen.synced) {
                context.fail(
                    call,
                    "This particle system was already synced; the bake " +
                        "carries one state.",
                );
            }
            frozen.synced = true;
            const engineCpp =
                billboard.engineCpp ?? context.requireDefaultEngine(call);
            context.emit(
                "bbl::upstream::sync_node_particle_billboard(" +
                    `${engineCpp}, ${set}, ${system}, ${billboard.cpp});`,
            );
            return { kind: "void", cpp: "" };
        }

        case "parseNodeParticleSetFromSnippet": {
            context.fail(
                call,
                "A node-particle snippet id fetches the graph from the " +
                    "snippet server at load; pass the graph to " +
                    "parseNodeParticleSource instead.",
            );
            break;
        }

        case "registerNodeParticleSet":
        case "registerNodeParticleSet2D":
        case "registerNodeParticleSet2DWithBlendModes":
        case "buildNodeParticleSetWithBlendModes":
        case "buildNodeParticleSetWithTextureUpdates":
        case "enableNodeParticleBlendModes":
        case "createParticleSprite2DBridge":
        case "createParticleSprite2DBridgeWithBlendModes":
        case "syncParticleSprite2DBridge":
        case "syncParticleSprite2DBridgeWithBlendModes": {
            context.fail(
                call,
                `'${importedName}' is not in the reached node-particle ` +
                    "slice: the frozen bake covers a stepped system drawn " +
                    "through createParticleBillboard.",
            );
            break;
        }

        default:
            return undefined;
    }
    return undefined;
}

/**
 * The summary `manifest.json` carries for a node-particle program.
 *
 * The program itself is the bake request -- the whole graph document and one
 * record per simulation step -- which generation consumes in process. What a
 * reader of the generated tree wants is what the scene asked for, and the
 * document's identity rather than its bytes: those live in the corpus module
 * the scene imported, and any change to them moves the baked state in
 * `upstream/src/node_particles.cpp`, which is what the neutrality proof
 * compares.
 */
export function nodeParticleManifest(
    program: CompiledNodeParticles,
): NodeParticleManifest {
    return {
        sets: program.sets.map((set) => ({
            builder: set.builder,
            graph: set.graph.kind === "module"
                ? `${set.graph.module}#${set.graph.exportName}`
                : createHash("sha256")
                      .update(JSON.stringify(set.graph.graph))
                      .digest("hex"),
            emitter: set.emitter,
            ...(set.textureBaseUrl === undefined
                ? {}
                : { textureBaseUrl: set.textureBaseUrl }),
        })),
        steps: program.steps.filter((step) => step.op === "animate").length,
        seeded: program.steps.some((step) => step.op === "random"),
        billboards: program.billboards.map(({ set, system }) => ({
            set,
            system,
        })),
    };
}
