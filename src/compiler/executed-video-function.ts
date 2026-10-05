// Closed video producers execute in Chromium; the bake records the video's frame as WebGPU imports it.
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { cachedBakeSync, moduleIdentity, type BakeKey } from "../bake-cache.js";
import {
    pageBase64Script,
    screenshotCaptureBrowserArgs,
} from "../browser-harness.js";
import type { ClosureModule } from "../executed-module-graph.js";
import { findRepositoryRoot } from "../upstream-source.js";
import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    browserTextureTargetExport,
    closureBakeInputs,
    closureModuleLoaderScript,
    closureModules,
    createsElement,
    importsAreExecutable,
    sameFileClosure,
    singleReturnedExpression,
} from "./browser-texture-function.js";
import { EmissionWeakMap } from "./emission-transaction.js";
import { evaluateInSharedPage } from "./generation-child.js";
import type { LoweringServices } from "./lowering-services.js";
import { resolvedSymbol } from "./symbols.js";
import type { Value } from "./types.js";
import { tryResolveFunctionDeclaration } from "./user-functions.js";

/** The source shape a call site matched, before anything is executed. */
export interface ExecutedVideoFunctionShape {
    name: string;
    sourceFile: ts.SourceFile;
    /** The returned record's video member; absent when it returns the video. */
    member?: string;
    /** The returned record's one method. */
    method?: string;
    /** Why a producer of this shape cannot be reproduced, reported at its call. */
    refusal?: string;
}

export interface ExecutedVideoBake {
    /** The video as the scene first observes it; RGBA8 as WebGPU's import yields it. */
    video: {
        readyState: number;
        width: number;
        height: number;
        frame: Uint8Array;
    };
    /** The readyState the method leaves the video at. */
    methodReadyState?: number;
}

/**
 * The first name a method body reaches beyond the producer's own locals.
 * Generation reproduces only the method's effect on the produced video, so
 * a body that touches anything else -- the document, storage, a listener
 * that runs later -- would lose that effect natively.
 */
function methodReach(
    checker: ts.TypeChecker,
    producer: ts.FunctionDeclaration,
    method: ts.MethodDeclaration,
): string | undefined {
    const body = producer.body!;
    let reached: string | undefined;
    forEachAnalysisNode(
        method.body!,
        (node) => {
            if (reached !== undefined) return;
            if (ts.isFunctionLike(node)) {
                reached = "a nested function";
            } else if (
                ts.isIdentifier(node) &&
                !(
                    ts.isPropertyAccessExpression(node.parent) &&
                    node.parent.name === node
                ) &&
                !resolvedSymbol(checker, node)?.declarations?.some(
                    (declaration) =>
                        declaration.pos >= body.pos &&
                        declaration.end <= body.end &&
                        !(
                            declaration.pos >= method.pos &&
                            declaration.end <= method.end
                        ),
                )
            ) {
                reached = `'${node.text}'`;
            }
        },
        { includeRoot: false, types: "skip" },
    );
    return reached;
}

/**
 * Whether a declaration is a bounded video producer: zero parameters, a
 * same-file closure that creates a video element and reaches neither the
 * pin nor a foreign function, and one top-level return.
 *
 * A function without that shape returns undefined: it is an ordinary local
 * call, and the inliner owns it. One with it whose result generation cannot
 * reproduce carries the refusal its call reports.
 */
export function executedVideoFunctionShape(
    checker: ts.TypeChecker,
    declaration: ts.Node,
): ExecutedVideoFunctionShape | undefined {
    if (
        !ts.isFunctionDeclaration(declaration) ||
        !declaration.body ||
        declaration.parameters.length !== 0 ||
        !declaration.name ||
        !ts.isSourceFile(declaration.parent)
    ) {
        return undefined;
    }
    const sourceFile = declaration.parent;
    if (!sourceFile.text.includes("createElement")) return undefined;
    if (!importsAreExecutable(sourceFile)) return undefined;
    const closure = sameFileClosure(checker, declaration, () => false);
    if (!closure?.some((member) => createsElement(member, checker, "video")))
        return undefined;
    const returned = singleReturnedExpression(declaration);
    if (!returned) return undefined;
    const name = declaration.name.text;
    const shape: ExecutedVideoFunctionShape = { name, sourceFile };
    if (!ts.isObjectLiteralExpression(returned)) return shape;
    const refuse = (reason: string): ExecutedVideoFunctionShape => ({
        ...shape,
        refusal: `Video producer '${name}' ${reason}`,
    });
    const members = returned.properties.filter(
        (property) =>
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property),
    );
    const methods = returned.properties.filter(ts.isMethodDeclaration);
    if (members.length + methods.length !== returned.properties.length)
        return refuse(
            "returns accessors or spreads; its record carries a video and one method.",
        );
    if (members.length !== 1 || !ts.isIdentifier(members[0]!.name))
        return refuse(
            `returns ${members.length} members; its record carries one video.`,
        );
    shape.member = members[0]!.name.text;
    if (methods.length === 0) return shape;
    const [method] = methods;
    if (
        methods.length !== 1 ||
        !ts.isIdentifier(method!.name) ||
        method!.parameters.length !== 0 ||
        method!.asteriskToken ||
        (ts.getCombinedModifierFlags(method!) & ts.ModifierFlags.Async) !== 0
    )
        return refuse(
            "returns methods generation cannot measure: it measures one synchronous, parameterless method.",
        );
    shape.method = method!.name.text;
    const reached = methodReach(checker, declaration, method!);
    return reached === undefined
        ? shape
        : refuse(
              `method '${shape.method}' reaches ${reached}; generation reproduces only its effect on the produced video.`,
          );
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * The page-side driver, a function from the closure to the bake's JSON. It
 * runs the producer, captures the video through `importExternalTexture`
 * exactly as a shader binding samples it, and measures what the native
 * record must reproduce: that the frame and state hold still once the
 * producer returned, and what the method leaves the readyState at --
 * synchronously and idempotently.
 */
function videoDriverSource(): string {
    return `async (input) => {
        const { modules: __bblModules, entry: __bblEntry, member, method } = JSON.parse(input);
        ${pageBase64Script}
        ${closureModuleLoaderScript(
            "video producer",
            `(() => { throw new Error("A generation-time video producer reaches no babylon-lite export."); })()`,
        )}
        const settle = () =>
            new Promise((resolve) => setTimeout(resolve, 100)).then(
                () => new Promise((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("The video bake has no WebGPU adapter.");
        const device = await adapter.requestDevice();
        // A compute pass reads every texel into a storage buffer, so no copy
        // row alignment applies, and the import's own size is read back
        // beside them. A validation error fails the bake rather than leaving
        // the buffer's zeros as a frame.
        const pipeline = device.createComputePipeline({
            layout: "auto",
            compute: {
                entryPoint: "main",
                module: device.createShaderModule({ code:
                    "@group(0) @binding(0) var frame: texture_external;" +
                    "@group(0) @binding(1) var<storage, read_write> texels: array<vec4f>;" +
                    "@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {" +
                    "  let size = textureDimensions(frame);" +
                    "  if (all(id.xy == vec2u(0))) { texels[size.x * size.y] = vec4f(vec2f(size), 0, 0); }" +
                    "  if (id.x < size.x && id.y < size.y) {" +
                    "    texels[id.y * size.x + id.x] = textureLoad(frame, id.xy); } }" }),
            },
        });
        const capture = async (video) => {
            const state = {
                readyState: video.readyState,
                width: video.videoWidth,
                height: video.videoHeight,
            };
            if (video.readyState < video.HAVE_CURRENT_DATA) return state;
            const { width, height } = state;
            const size = (width * height + 1) * 16;
            const storage = device.createBuffer({
                size,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            });
            const buffer = device.createBuffer({
                size,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            device.pushErrorScope("validation");
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: device.importExternalTexture({ source: video }) },
                    { binding: 1, resource: { buffer: storage } },
                ],
            }));
            pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            pass.end();
            encoder.copyBufferToBuffer(storage, 0, buffer, 0, size);
            device.queue.submit([encoder.finish()]);
            const failure = await device.popErrorScope();
            if (failure) throw new Error("The video frame import failed: " + failure.message);
            await buffer.mapAsync(GPUMapMode.READ);
            const read = new Float32Array(buffer.getMappedRange().slice(0));
            buffer.destroy();
            storage.destroy();
            const texels = width * height * 4;
            if (read[texels] !== width || read[texels + 1] !== height) {
                throw new Error(
                    "The imported frame is " + read[texels] + "x" + read[texels + 1] +
                        ", not the video's " + width + "x" + height + ".");
            }
            const bytes = new Uint8Array(texels);
            for (let index = 0; index < texels; index += 1) {
                const level = read[index] * 255;
                const rounded = Math.round(level);
                if (Math.abs(level - rounded) > 1e-3 || rounded < 0 || rounded > 255) {
                    throw new Error(
                        "The imported video frame holds a value between 8-bit levels (" +
                            read[index] + "), which RGBA8 texels cannot carry.");
                }
                bytes[index] = rounded;
            }
            state.frame = bblBase64(bytes);
            return state;
        };
        const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
        const target = loadModule(__bblEntry)[${JSON.stringify(browserTextureTargetExport)}];
        if (typeof target !== "function") {
            throw new Error("The bake driver did not expose the target function.");
        }
        // The returned video, where the source's shape says it is.
        const produce = async () => {
            const value = await target();
            const record = member === null ? null : value;
            const video = member === null ? value : value?.[member];
            if (!(video instanceof HTMLVideoElement)) {
                throw new Error("The video producer returned no video element where its source does.");
            }
            return { record, video };
        };
        const first = await produce();
        const initial = await capture(first.video);
        if (initial.frame === undefined) {
            throw new Error(
                "The video producer returns before its video has a frame (readyState " +
                    initial.readyState + ").");
        }
        await settle();
        if (!same(initial, await capture(first.video))) {
            throw new Error(
                "The produced video changed after the producer returned, so no one baked " +
                    "frame and state stand for it.");
        }
        if (method === null) return JSON.stringify({ video: initial });
        const fixture = await produce();
        const call = () => {
            if (fixture.record[method]() !== undefined) {
                throw new Error("Method '" + method + "' returned a value.");
            }
        };
        call();
        const readyState = fixture.video.readyState;
        await settle();
        const settled = await capture(fixture.video);
        if (settled.readyState !== readyState) {
            throw new Error("Method '" + method + "' changes the video's readyState after it returns.");
        }
        if (settled.frame !== undefined && settled.frame !== initial.frame) {
            throw new Error("Method '" + method + "' changes the video's frame.");
        }
        call();
        await settle();
        if (!same(settled, await capture(fixture.video))) {
            throw new Error("Method '" + method + "' does not settle when called again.");
        }
        return JSON.stringify({ video: initial, readyState });
    }`;
}

/** What the driver reports; the bake key holds its own text. */
type VideoDriver = (input: {
    modules: Record<string, ClosureModule>;
    entry: string;
    member: string | null;
    method: string | null;
}) => string;

function runVideoProducerInChromium(input: Parameters<VideoDriver>[0]): string {
    return evaluateInSharedPage({
        label: "Generation-time video producer bake",
        serverName: "video producer bake server",
        requirement:
            "Baking a scene's browser-produced video requires Chromium.",
        browserArgs: screenshotCaptureBrowserArgs,
        navigate: true,
        evaluate: videoDriverSource(),
        input: JSON.stringify(input),
    });
}

/**
 * Run one bounded video producer in headless Chromium and return what it
 * produced. `run` is injectable so decoding is testable without a browser.
 */
export function bakeExecutedVideoFunction(
    shape: ExecutedVideoFunctionShape,
    repositoryRoot: string,
    run: VideoDriver = runVideoProducerInChromium,
): ExecutedVideoBake {
    const graph = closureModules(
        shape.sourceFile.fileName,
        shape.name,
        repositoryRoot,
    );
    if (!graph) {
        throw new Error(
            `Video producer '${shape.name}' reaches a module its closure ` +
                "cannot be built from: a relative import that does not " +
                "resolve, or a file outside the repository.",
        );
    }
    const input = {
        modules: graph.modules,
        entry: graph.entry,
        member: shape.member ?? null,
        method: shape.method ?? null,
    };
    const key: BakeKey = {
        kind: "executed-video-function",
        version: "2",
        module: moduleIdentity(import.meta.url),
        browser: true,
        parameters: {
            module: graph.entry,
            function: shape.name,
            member: input.member,
            method: input.method,
            browserArgs: screenshotCaptureBrowserArgs,
        },
        // The driver's text includes the shared loader this module does not own.
        inputs: [
            ...closureBakeInputs(graph),
            Buffer.from(videoDriverSource(), "utf8"),
        ],
    };
    const text = Buffer.from(
        cachedBakeSync(key, () => Buffer.from(run(input), "utf8")),
    ).toString("utf8");
    return decodeExecutedVideoBake(shape, text);
}

/** The driver's JSON, validated into the typed bake the compiler consumes. */
export function decodeExecutedVideoBake(
    shape: ExecutedVideoFunctionShape,
    text: string,
): ExecutedVideoBake {
    const refuse: (message: string) => never = (message) => {
        throw new Error(`Video producer '${shape.name}': ${message}`);
    };
    const payload = JSON.parse(text) as {
        video?: Record<string, unknown>;
        readyState?: unknown;
    };
    const isCount = (value: unknown): value is number =>
        typeof value === "number" && Number.isInteger(value) && value >= 0;
    const { readyState, width, height, frame } = payload.video ?? {};
    if (!isCount(readyState) || !isCount(width) || !isCount(height))
        refuse("its video's readyState and size must be settled integers.");
    if (typeof frame !== "string") refuse("its video carries no frame.");
    const texels = new Uint8Array(Buffer.from(frame, "base64"));
    if (width === 0 || height === 0 || texels.length !== width * height * 4)
        refuse(`a ${width}x${height} frame carried ${texels.length} bytes.`);
    const video = { readyState, width, height, frame: texels };
    if (shape.method === undefined) return { video };
    if (!isCount(payload.readyState))
        refuse(`method '${shape.method}' has no measured readyState.`);
    return { video, methodReadyState: payload.readyState };
}

// ── Lowering ─────────────────────────────────────────────────────────────────

interface ExecutedVideoCallContext extends Pick<
    LoweringServices,
    | "checker"
    | "options"
    | "executedVideoFunctions"
    | "assetRegistry"
    | "allocateTemporaryCppName"
    | "cppString"
    | "reachFeature"
    | "emit"
    | "fail"
> {}

const producerShapes = new EmissionWeakMap<
    ts.Node,
    ExecutedVideoFunctionShape | null
>();

/**
 * Lower `await f()` when `f` is a bounded video producer.
 *
 * Returns undefined when the call is not that shape, so ordinary inlining
 * owns it. Once the shape matches, every later refusal fails: the source
 * produces a video, and a driver that could not reproduce it is a
 * generation error, not a fallback.
 */
export function compileExecutedVideoFunctionCall(
    context: ExecutedVideoCallContext,
    call: ts.CallExpression,
    callee: ts.Identifier,
): Value | undefined {
    const declaration = tryResolveFunctionDeclaration(context.checker, callee);
    if (!declaration) return undefined;
    let shape = producerShapes.get(declaration);
    if (shape === undefined) {
        shape =
            executedVideoFunctionShape(context.checker, declaration) ?? null;
        producerShapes.set(declaration, shape);
    }
    if (!shape) return undefined;
    if (shape.refusal) context.fail(call, shape.refusal);
    if (call.arguments.length !== 0) {
        context.fail(
            call,
            `'${shape.name}' produces its video in the browser at generation and takes no arguments.`,
        );
    }
    let bake: ExecutedVideoBake;
    try {
        bake = bakeExecutedVideoFunction(
            shape,
            findRepositoryRoot(dirname(resolve(context.options.fileName))),
        );
    } catch (error) {
        context.fail(call, (error as Error).message);
    }
    context.executedVideoFunctions.add(shape.name);
    context.reachFeature("material:shader-external-texture", call);
    const frame = context.assetRegistry.registerAsset(
        `data:application/octet-stream;base64,${Buffer.from(
            bake.video.frame,
        ).toString("base64")}`,
        "pixels",
    );
    const cpp = context.allocateTemporaryCppName(`${shape.name}_video`);
    context.emit({
        kind: "declaration",
        type: "const bbl::VideoHandle",
        name: cpp,
        initializer: `bbl::create_baked_video(bbl::asset_path(${context.cppString(frame.output)}), ${bake.video.width}u, ${bake.video.height}u, ${bake.video.readyState})`,
    });
    const video: Value = {
        kind: "video",
        dataType: { kind: "handle", handle: "video" },
        cpp,
    };
    if (shape.member === undefined) return video;
    const recordProperties: Record<string, Value> = { [shape.member]: video };
    if (shape.method !== undefined) {
        // The method writes the readyState generation measured it to leave;
        // the bake refuses one that changes the frame, so the frame needs
        // nothing.
        const method = context.allocateTemporaryCppName(
            `${shape.name}_${shape.method}`,
        );
        context.emit({
            kind: "declaration",
            type: "const bbl::js::Callback<void()>",
            name: method,
            initializer: `[${cpp}]() { ${cpp}->ready_state = ${bake.methodReadyState}; }`,
        });
        recordProperties[shape.method] = {
            kind: "data",
            cpp: method,
            dataType: {
                kind: "function",
                parameters: [],
                undefinedCompletion: true,
            },
        };
    }
    return { kind: "record", cpp: "", recordProperties };
}
