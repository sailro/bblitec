import type { LoweringServices } from "../lowering-services.js";
// The node-particle family records graph builds and source lifecycle calls.
// Frozen systems execute the pin during generation, preserving V8-dependent
// random sequences. Live pure-2D bindings and provider-backed systems lower
// supported pinned evaluators into native simulation state. Providers also
// retain source callbacks and execute authored setup/step calls natively.
// Both paths share the pinned atlas, blend and particle-to-sprite bridges;
// unsupported combinations refuse where their source operation is reached.
// The node-particle family records graph builds and source lifecycle calls.
// Frozen systems execute the pin during generation, preserving V8-dependent
// random sequences. Live pure-2D bindings and provider-backed systems lower
// supported pinned evaluators into native simulation state. Providers also
// retain source callbacks and execute authored setup/step calls natively.
// Both paths share the pinned atlas, blend and particle-to-sprite bridges;
// unsupported combinations refuse where their source operation is reached.
import {
    createHash,
} from "node:crypto";
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import { requireParticleBakeWritable } from "../particle-buffer.js";
import {
    staticGraphDocument,
    type ExecutedModuleReferenceContext,
} from "../assets.js";
import {
    compileOptionalStaticBoolean,
    compileStaticNumber,
    notJson,
    staticJsonValue,
    staticNumberPair,
    staticVec3Value,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
    type StaticBooleanContext,
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
// The pin's own bridge defaults, read from the one table
// `node-particle-lowerer.ts` asserts against the pinned declarations —
// so the values resolved here cannot drift from the pin unseen.
// The pin's own bridge defaults, read from the one table
// `node-particle-lowerer.ts` asserts against the pinned declarations —
// so the values resolved here cannot drift from the pin unseen.
import {
    pinnedDefaultFlag,
    pinnedDefaultNumber,
    pinnedDefaultVec2,
} from "../../lowering/pinned-material-defaults.js";
import type { IntrinsicCallContext } from "./context.js";

export interface ParticleIntrinsicContext
    extends IntrinsicCallContext,
    ExecutedModuleReferenceContext,
    ObjectValidationContext,
    PositiveIntegerContext,
    StaticBooleanContext,
    Pick<LoweringServices,
        | "reachedNodeParticles"
        | "requireDefaultEngine"
        | "compileStaticString"
        | "lookupOptional"
        | "reachJsRandom"
        | "expectObjectLiteral"
        | "objectProperty"
        | "emit"
        | "allocateTemporaryCppName"
        | "compileForDataSink"
        | "compileNumber"
    > {}

/** The four builders the corpus reaches, by their own export names. */
const builders: Readonly<Record<string, NodeParticleBuilder>> = {
    buildNodeParticleSet: "buildNodeParticleSet",
    buildNodeParticleSetWithBlendModes:
        "buildNodeParticleSetWithBlendModes",
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
    // by the time it reaches here every field is a constant. A URL a
    // sibling module function drew at generation travels as that function,
    // which the driver runs in the same browser before the build.
    const urlArguments: Array<{ index: number; module: string; exportName: string }> = [];
    const args = (document.call?.arguments ?? []).map((argument, index) => {
        const unwrapped = context.unwrap(argument);
        const bound = ts.isIdentifier(unwrapped)
            ? context.lookupOptional(unwrapped)
            : undefined;
        if (bound?.kind === "executed-url" && bound.executedUrl) {
            urlArguments.push({ index, ...bound.executedUrl });
            return null;
        }
        return staticArgumentJson(context, argument);
    });
    return {
        kind: "module",
        module: document.module,
        exportName: document.exportName,
        args,
        ...(urlArguments.length > 0 ? { urlArguments } : {}),
    };
}

/** Whether a live pure-2D binding already took this set. */
function isLive(context: ParticleIntrinsicContext, set: number): boolean {
    return context.reachedNodeParticles.sprite2d.some(
        (binding) => binding.set === set && binding.live === true,
    );
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

/**
 * `RegisterNodeParticleSet2DOptions`, as the static record it is.
 *
 * Every field is a mapping constant the bridge reads per particle, so each
 * is resolved here and each default is the pin's own. `view` is refused: no
 * reached call names one, and a layer view moves every sprite.
 */
function sprite2dOptions(
    context: ParticleIntrinsicContext,
    expression: ts.Expression | undefined,
): {
    autoStart: boolean;
    pixelsPerUnit: number;
    originPx: readonly [number, number];
    invertY: boolean;
    opacity?: number;
    visible?: boolean;
    order?: number;
} {
    const resolved = {
        autoStart: pinnedDefaultFlag("sprite2dAutoStart"),
        pixelsPerUnit: pinnedDefaultNumber("sprite2dPixelsPerUnit"),
        originPx: pinnedDefaultVec2("sprite2dOriginPx"),
        invertY: pinnedDefaultFlag("sprite2dInvertY"),
    };
    if (!expression) return resolved;
    const options = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        options,
        ["autoStart", "pixelsPerUnit", "originPx", "invertY", "layer"],
        "A pure-2D node-particle binding takes autoStart, pixelsPerUnit, " +
            "originPx, invertY and layer.",
    );
    const flag = (name: "autoStart" | "invertY"): void => {
        resolved[name] = compileOptionalStaticBoolean(
            context,
            context.objectProperty(options, name),
            resolved[name],
            `A pure-2D node-particle binding's ${name}`,
        );
    };
    flag("autoStart");
    flag("invertY");
    const scale = context.objectProperty(options, "pixelsPerUnit");
    if (scale) {
        resolved.pixelsPerUnit = compileStaticNumber(
            context,
            scale,
            "pixelsPerUnit",
        );
    }
    const origin = context.objectProperty(options, "originPx");
    if (origin) {
        const pair = staticNumberPair(context, origin);
        if (!pair) {
            context.fail(
                origin,
                "originPx must be a static two-element number tuple.",
            );
        }
        resolved.originPx = pair;
    }
    const layer = context.objectProperty(options, "layer");
    if (!layer) return resolved;
    const layerOptions = context.expectObjectLiteral(layer);
    validateObjectProperties(
        context,
        layerOptions,
        ["opacity", "visible", "order"],
        "A bridge-owned layer takes opacity, visible and order; its " +
            "view is not lowered.",
    );
    const numeric = (name: "opacity" | "order"): number | undefined => {
        const named = context.objectProperty(layerOptions, name);
        return named
            ? compileStaticNumber(context, named, `layer ${name}`)
            : undefined;
    };
    const visibleNamed = context.objectProperty(
        layerOptions,
        "visible",
    );
    let visible: boolean | undefined;
    if (visibleNamed) {
        const value = context.compileValue(visibleNamed);
        if (value.cpp !== "true" && value.cpp !== "false") {
            context.fail(
                visibleNamed,
                "A bridge-owned layer's visible must be a static boolean.",
            );
        }
        visible = value.cpp === "true";
    }
    const opacity = numeric("opacity");
    const order = numeric("order");
    return {
        ...resolved,
        ...(opacity === undefined ? {} : { opacity }),
        ...(visible === undefined ? {} : { visible }),
        ...(order === undefined ? {} : { order }),
    };
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

function buildOptions(
    context: ParticleIntrinsicContext,
    expression: ts.Expression | undefined,
): { emitter: readonly [number, number, number]; textureBaseUrl?: string } {
    if (!expression) return { emitter: [0, 0, 0] };
    const options = context.expectObjectLiteral(expression);
    validateObjectProperties(context, options, ["emitter", "textureBaseUrl"],
        "Reached node-particle builds take 'emitter' and 'textureBaseUrl'; an emitter world matrix is not lowered.");
    const emitter = emitterVector(context, context.objectProperty(options, "emitter"));
    const base = context.objectProperty(options, "textureBaseUrl");
    return { emitter, ...(base ? { textureBaseUrl: context.compileStaticString(base) } : {}) };
}

/** Which set and system a call's first argument names, with its value. */
function systemOf(
    context: ParticleIntrinsicContext,
    call: ts.CallExpression,
): { value: Value; set: number; system: number } {
    const argument = call.arguments[0];
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
    requireParticleBakeWritable(context, { set, system }, node);
    if (isFrozen(context, set, system)) {
        context.fail(
            node,
            "This particle system was already frozen by " +
                "createParticleBillboard; the bake carries one state.",
        );
    }
    if (isLive(context, set)) {
        context.fail(
            node,
            "This particle system is animated every frame by its pure-2D " +
                "binding; a scene step on a live system is not lowered.",
        );
    }
}

export function compileParticleIntrinsic(
    context: ParticleIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "withNodeParticleEmitterProvider": {
            context.expectArgumentCount(call, 1, 2);
            context.reachedNodeParticles.nativeProvider = true;
            if (context.isRuntimeResourceConstruction()) {
                context.fail(call, "A native emitter provider must be constructed before recurring frame callbacks; its set has one native identity.");
            }
            if (context.reachedNodeParticles.steps.some((step) => step.op === "random")) {
                context.fail(call, "A native emitter provider cannot follow a generation-only Math.random override.");
            }
            const callback = context.compileForDataSink(argumentAt(call, 0), {
                kind: "function", parameters: [], result: { kind: "f32array" },
            });
            const callbackCpp = context.allocateTemporaryCppName("particle_provider");
            context.emit({ kind: "declaration", type: "auto", name: callbackCpp, initializer: callback });
            const initialMatrixCpp = context.allocateTemporaryCppName("particle_emitter_initial");
            context.emit({ kind: "declaration", type: "const auto", name: initialMatrixCpp, initializer: `bbl::upstream::sample_node_particle_emitter(${callbackCpp})` });
            context.reachFeature("particle:node", call);
            const options = buildOptions(context, call.arguments[1]);
            return { kind: "record", cpp: "", recordProperties: {},
                nodeParticleProvider: { callbackCpp, initialMatrixCpp, ...options } };
        }
        case "parseNodeParticleSource": {
            context.expectArgumentCount(call, 1, 1);
            return {
                kind: "node-particle-graph",
                cpp: "",
                nodeParticleGraph: graphSource(
                    context,
                    argumentAt(call, 0),
                ),
            };
        }

        case "normalizeNodeParticleGraph": {
            // Graph plumbing, and nothing else: the normalizer rewrites a
            // reachable TeleportOut edge to its TeleportIn source and
            // compiles Elbow and Debug away, so the builders' five
            // otherwise-refused class names resolve to the terminal sources
            // they route to. Nothing about it is folded here. The graph it
            // returns is read only by the executed build, so what travels is
            // the marker, and the driver runs the pin's own normalizer in
            // the same place the scene ran it. Marking twice is harmless for
            // the pin's own reason: a normalized graph carries an internal
            // marker and a second call returns it unchanged.
            context.expectArgumentCount(call, 1, 1);
            const graph = context.compileValue(argumentAt(call, 0));
            context.expectKind(
                graph,
                "node-particle-graph",
                argumentAt(call, 0),
            );
            return {
                kind: "node-particle-graph",
                cpp: "",
                nodeParticleGraph: {
                    ...graph.nodeParticleGraph!,
                    normalized: true,
                },
            };
        }

        case "buildNodeParticleSet":
        case "buildNodeParticleSetWithBlendModes":
        case "buildNodeParticleSetWithFlowMaps":
        case "buildNodeParticleSetWithNoiseTextures": {
            context.expectArgumentCount(call, 3, 4);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", argumentAt(call, 0));
            const scene = context.compileValue(argumentAt(call, 1));
            context.expectKind(scene, "scene", argumentAt(call, 1));
            const graph = context.compileValue(argumentAt(call, 2));
            context.expectKind(
                graph,
                "node-particle-graph",
                argumentAt(call, 2),
            );
            let emitter: readonly [number, number, number] = [0, 0, 0];
            let textureBaseUrl: string | undefined;
            let provider: Value["nodeParticleProvider"];
            const optionsArgument = call.arguments[3];
            if (optionsArgument) {
                const providerCall = context.unwrap(optionsArgument);
                const providerOptions = ts.isCallExpression(providerCall) &&
                    ts.isIdentifier(providerCall.expression) &&
                    context.symbols.importedName(providerCall.expression) === "withNodeParticleEmitterProvider"
                    ? context.compileValue(optionsArgument) :
                    ts.isIdentifier(providerCall) ? context.lookupOptional(providerCall) : undefined;
                provider = providerOptions?.nodeParticleProvider;
                const options = provider ?? buildOptions(context, optionsArgument);
                emitter = options.emitter;
                textureBaseUrl = options.textureBaseUrl;
            }
            if (provider && context.isRuntimeResourceConstruction()) {
                context.fail(call, "A provider-backed particle set must be built before recurring frame callbacks; each build needs its own native identity.");
            }
            if (context.reachedNodeParticles.sets.some((set) => !!set.native !== !!provider)) {
                context.fail(call, "Native provider-backed and generation-only particle sets cannot share one program; their simulations must observe one Math.random sequence.");
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
                    argumentAt(call, 1),
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
                ...(provider ? { native: true as const } : {}),
            });
            if (provider) {
                context.reachJsRandom();
                context.emit(`bbl::upstream::initialize_native_node_particle_set(${context.reachedNodeParticles.sets.length - 1}, ${provider.callbackCpp}, ${provider.initialMatrixCpp});`);
            }
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
            const { set, system } = systemOf(context, call);
            if (context.reachedNodeParticles.sets[set]?.native) {
                return { kind: "void", cpp: `bbl::upstream::${importedName === "startParticleSystem" ? "start" : "stop"}_native_node_particle_system(${set}, ${system})` };
            }
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
            const { set, system } = systemOf(context, call);
            if (context.reachedNodeParticles.sets[set]?.native) {
                return { kind: "void", cpp: `bbl::upstream::animate_native_node_particle_system(${set}, ${system}, ${context.compileNumber(argumentAt(call, 1), "double")})` };
            }
            requireUnbaked(context, set, system, call);
            const ratio = compileStaticNumber(
                context,
                argumentAt(call, 1),
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
            const { value, set, system } = systemOf(context, call);
            if (context.reachedNodeParticles.sets[set]?.native) {
                context.fail(call, "Provider-backed particle systems draw through registerNodeParticleSet; the explicit billboard bridge only carries frozen state.");
            }
            if (!isFrozen(context, set, system)) {
                context.reachedNodeParticles.billboards.push({ set, system });
            }
            const engineCpp =
                value.engineCpp ?? context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            context.reachFeature("particle:node", call);
            // Which program this system draws is the BAKE's answer: the
            // blend mode lives in the graph's own SystemBlock, and the exact
            // chain turns modes 3 and 4 into the pin's private Multiply
            // module. `cli.ts` records the plain and multiply programs from
            // the baked mode rather than from this call site.
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
            const { set, system } = systemOf(context, call);
            const billboard = context.compileValue(argumentAt(call, 1));
            context.expectKind(
                billboard,
                "billboard-system",
                argumentAt(call, 1),
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

        case "enableNodeParticleBlendModes": {
            // The pin's own enabler installs one `_registerBillboard` per
            // system and returns the same set, so the value passes straight
            // through and what is recorded is that the chain ran.
            context.expectArgumentCount(call, 1, 1);
            const set = context.compileValue(argumentAt(call, 0));
            context.expectKind(
                set,
                "node-particle-set",
                argumentAt(call, 0),
            );
            const request =
                context.reachedNodeParticles.sets[
                    set.nodeParticleSetIndex!
                ]!;
            if (request.native && (context.isRuntimeResourceConstruction() ||
                context.reachedNodeParticles.registrations.some((entry) => entry.set === set.nodeParticleSetIndex))) {
                context.fail(call, "Native particle blend modes must be enabled before registration and recurring frame callbacks; the enabler affects future billboards.");
            }
            request.enableBlendModes = true;
            return set;
        }

        case "registerNodeParticleSet": {
            context.expectArgumentCount(call, 2, 3);
            const scene = context.compileValue(argumentAt(call, 0));
            context.expectKind(scene, "scene", argumentAt(call, 0));
            const set = context.compileValue(argumentAt(call, 1));
            context.expectKind(
                set,
                "node-particle-set",
                argumentAt(call, 1),
            );
            let autoStart = pinnedDefaultFlag("nodeParticleAutoStart");
            const optionsArgument = call.arguments[2];
            if (optionsArgument) {
                const options =
                    context.expectObjectLiteral(optionsArgument);
                validateObjectProperties(
                    context,
                    options,
                    ["autoStart"],
                    "registerNodeParticleSet takes 'autoStart'.",
                );
                autoStart = compileOptionalStaticBoolean(
                    context,
                    context.objectProperty(options, "autoStart"),
                    autoStart,
                    "registerNodeParticleSet's autoStart",
                );
            }
            const index = set.nodeParticleSetIndex!;
            if (context.reachedNodeParticles.sets[index]?.native && context.isRuntimeResourceConstruction()) {
                context.fail(call, "A provider-backed particle set must be registered before recurring frame callbacks; repeated registration creates additional billboards and callbacks.");
            }
            if (
                context.reachedNodeParticles.registrations.some(
                    (entry) => entry.set === index,
                )
            ) {
                context.fail(
                    call,
                    "This node-particle set is already registered; the " +
                        "bake carries one state per system.",
                );
            }
            context.reachedNodeParticles.registrations.push({
                set: index,
                autoStart,
            });
            const engineCpp =
                set.engineCpp ?? context.requireDefaultEngine(call);
            context.reachFeature("sprite:billboard", call);
            context.reachFeature("particle:node", call);
            // A billboard system is a scene renderable, so a scene of
            // nothing but particles still compiles the scene renderer.
            context.reachFeature("renderer:scene", call);
            // The call is named by its own request index, not by the
            // set's: which systems it walks is what the bake observed.
            context.emit(
                "bbl::upstream::register_node_particle_set(" +
                    `${engineCpp}, ${scene.cpp}, ` +
                    `${context.reachedNodeParticles.registrations.length - 1});`,
            );
            return { kind: "void", cpp: "" };
        }

        case "registerNodeParticleSet2D":
        case "registerNodeParticleSet2DWithBlendModes": {
            context.expectArgumentCount(call, 2, 3);
            const renderer = context.compileValue(argumentAt(call, 0));
            context.expectKind(
                renderer,
                "sprite-renderer",
                argumentAt(call, 0),
            );
            const set = context.compileValue(argumentAt(call, 1));
            context.expectKind(
                set,
                "node-particle-set",
                argumentAt(call, 1),
            );
            const index = set.nodeParticleSetIndex!;
            if (context.reachedNodeParticles.sets[index]?.native) {
                context.fail(call, "Provider-backed particle systems draw through registerNodeParticleSet; the pure-2D provider bridge is not lowered.");
            }
            if (
                context.reachedNodeParticles.sprite2d.some(
                    (entry) => entry.set === index,
                )
            ) {
                context.fail(
                    call,
                    "This node-particle set already has a pure-2D " +
                        "binding; the bake carries one state per system.",
                );
            }
            // A set the scene never stepped or froze is LIVE: the pin's
            // registrar animates it every frame from the renderer's hook,
            // and the lowering simulates it natively from the graph
            // (`src/lowering/node-particle-live-lowerer.ts`). Its random
            // draws are then the pinned generator's, which the browser
            // reference must install too.
            const live =
                !context.reachedNodeParticles.steps.some(
                    (step) => "set" in step && step.set === index,
                ) &&
                !context.reachedNodeParticles.billboards.some(
                    (frozen) => frozen.set === index,
                );
            if (live) context.reachJsRandom();
            const sheet = context.reachedNodeParticles.buffers.some(
                (buffer) => buffer.set === index && buffer.sheet,
            );
            if (live && sheet) {
                context.fail(call, "A scene-supplied particle sprite sheet requires a frozen system; live sprite-sheet simulation is not lowered.");
            }
            if (live && context.reachedNodeParticles.buffers.some((buffer) => buffer.set === index)) {
                context.fail(call, "A frozen particle buffer read cannot be combined with live particle simulation.");
            }
            context.reachedNodeParticles.sprite2d.push({
                set: index,
                exact:
                    importedName ===
                    "registerNodeParticleSet2DWithBlendModes",
                ...sprite2dOptions(context, call.arguments[2]),
                ...(live ? { live: true as const } : {}),
                ...(sheet ? { retainFrozen: true as const } : {}),
            });
            context.reachFeature("sprite:2d", call);
            context.reachFeature("particle:node", call);
            const request = context.reachedNodeParticles.sprite2d.length - 1;
            context.emit(
                "bbl::upstream::register_node_particle_set_2d(" +
                    `${renderer.engineCpp ?? context.requireDefaultEngine(call)}, ` +
                    `${renderer.cpp}, ${request});`,
            );
            // The binding upstream owns the hook and the layers it attached,
            // and every operation on it -- disposal above all -- refuses at
            // its own intrinsic. What the corpus does with a FROZEN one is
            // report its state through the canvas dataset, so it binds as a
            // value the erasure carries: a read that reaches instrumentation
            // disappears with it, and a read that reaches anything else
            // fails as an undeterminable browser value rather than
            // compiling to something this port does not have. A live one
            // is marked, so `binding.bridges[k]` names the mapping the
            // generated registrar keeps for its request.
            return {
                kind: "node-particle-2d-binding",
                cpp: "",
                nodeParticleRequestIndex: request,
                nodeParticleSetIndex: index,
                ...(live ? { nodeParticleLive: true as const } : {}),
            };
        }

        case "buildNodeParticleSetWithTextureUpdates":
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
            ...(set.native ? { native: true as const } : {}),
        })),
        steps: program.steps.filter((step) => step.op === "animate").length,
        seeded: program.steps.some((step) => step.op === "random"),
        billboards: program.billboards.map(({ set, system }) => ({
            set,
            system,
        })),
    };
}
