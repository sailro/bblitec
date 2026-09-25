import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    emissionArray,
    EmissionMap,
    EmissionSet,
    journaled,
    writable,
} from "./emission-transaction.js";
import { persistContinuationLocals } from "./continuation-storage.js";
import ts from "typescript";
import { framePollExecutor } from "./frame-poll.js";
import { resolvedSymbol } from "./symbols.js";
import {
    resolveFunctionDeclaration,
    tryResolveFunctionDeclaration,
} from "./user-functions.js";
import { argumentAt, isDeclaredInside } from "./syntax.js";
import { soleReturnedExpression } from "./syntax.js";
import type { Value } from "./types.js";
import type { NativeCaptureBinding } from "./closure-captures.js";
import type { NativeDeclaration } from "./native-declarations.js";
import type { UiProjection } from "./ui-projection.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    renderNativeEmission,
    verbatimEmission,
    type NativeEmission,
} from "./native-statements.js";

/** What the engine lifecycle reads of the compiler. */
interface EngineLifecycleContext extends Pick<
    LoweringServices,
    | "allocateBlockPrefix"
    | "allocateTemporaryCppName"
    | "bindings"
    | "browserErasure"
    | "captureEmittedLines"
    | "checker"
    | "compileCallbackWithValues"
    | "compileValue"
    | "conditions"
    | "decreaseIndent"
    | "emit"
    | "emitDiscardedValue"
    | "emitStatement"
    | "expectArgumentCount"
    | "expectKind"
    | "fail"
    | "increaseIndent"
    | "isRuntimeResourceConstruction"
    | "libraryGlobal"
    | "options"
    | "reachFeature"
    | "reachJsData"
    | "registerNativeConstBinding"
    | "symbols"
    | "unwrap"
    | "asyncActivations"
> {
    readonly body: NativeEmission[];
    readonly indentLevel: number;
    readonly nativeDeclarations: EmissionMap<string, NativeDeclaration>;
    readonly program: ts.Program;
    readonly statementDependencies: Set<NativeCaptureBinding>[];
    readonly ui: UiProjection;
    useNativeBinding(binding: NativeCaptureBinding): void;
}

/**
 * The entry's lifecycle around startEngine: the mark where the engine starts, the continuation
 * hoisted behind it with its persisted locals, the finally guard, frame yields and the promise
 * latches that park the continuation, and the device-recovery callbacks.
 */
export class EngineLifecycle {
    constructor(private readonly context: EngineLifecycleContext) {}

    public readonly continuationUses = new EmissionMap<string, Set<number>>();
    public readonly continuationLocals = new EmissionMap<string, number>();
    @journaled public accessor continuationSequence = 0;

    /**
     * Recognize either the pinned two-RAF Promise directly or the exact
     * zero-argument local helper that returns it. The call itself must be
     * awaited and discarded as an expression statement; a returned timestamp
     * used as data is a different contract and must continue through ordinary
     * Promise lowering (which currently refuses it).
     */
    public isBoundedNestedFrameYield(expression: ts.Expression): boolean {
        const awaited = expression.parent;
        if (
            !ts.isAwaitExpression(awaited) ||
            awaited.expression !== expression ||
            !ts.isExpressionStatement(awaited.parent)
        ) {
            return false;
        }
        if (this.context.browserErasure.isBoundedNestedFrameYield(expression)) {
            return this.requireClosedBoundedFrameYield(expression);
        }
        if (
            !ts.isCallExpression(expression) ||
            expression.arguments.length !== 0 ||
            !ts.isIdentifier(expression.expression)
        ) {
            return false;
        }
        const declaration = resolveFunctionDeclaration(
            this.context.checker,
            expression.expression,
            (node, message) => this.context.fail(node, message),
        );
        if (
            !declaration ||
            declaration.parameters.length !== 0 ||
            !declaration.body ||
            !ts.isBlock(declaration.body)
        ) {
            return false;
        }
        const returned = soleReturnedExpression(declaration.body);
        if (
            returned === undefined ||
            !this.context.browserErasure.isBoundedNestedFrameYield(returned)
        ) {
            return false;
        }
        return this.requireClosedBoundedFrameYield(returned);
    }

    /**
     * Erasing a wait is sound only while its two callbacks are the complete
     * user RAF set. Another callback can mutate state between the current
     * turn and the continuation even when the wait's timestamp is discarded.
     * Scan every non-declaration module in this program and refuse that
     * interleaving instead of silently moving the continuation earlier.
     */
    private requireClosedBoundedFrameYield(allowed: ts.Expression): true {
        let other: ts.CallExpression | undefined;
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (other) return "skip";
                if (
                    ts.isCallExpression(node) &&
                    this.context.browserErasure.isDefaultRequestAnimationFrameCall(
                        node,
                    ) &&
                    !isDeclaredInside(node, allowed)
                ) {
                    other = node;
                    return "skip";
                }
            });
        for (const source of this.context.program.getSourceFiles()) {
            if (!source.isDeclarationFile) visit(source);
        }
        if (other) {
            this.context.fail(
                other,
                "A bounded nested frame yield cannot be erased while " +
                    "another requestAnimationFrame callback can interleave.",
            );
        }
        return true;
    }

    public isFrameYield(expression: ts.Expression): boolean {
        if (this.context.browserErasure.isFrameYield(expression)) {
            return true;
        }
        // A zero-argument helper whose whole body returns the same closed
        // Promise is the same yield, not a general async call. Keep the
        // proof structural so a helper with setup, cleanup, parameters, or
        // any other Promise body still takes ordinary lowering and refuses.
        if (
            !ts.isCallExpression(expression) ||
            expression.arguments.length !== 0 ||
            !ts.isIdentifier(expression.expression)
        ) {
            return false;
        }
        const declaration = resolveFunctionDeclaration(
            this.context.checker,
            expression.expression,
            (node, message) => this.context.fail(node, message),
        );
        if (
            !declaration ||
            declaration.parameters.length !== 0 ||
            !declaration.body
        ) {
            return false;
        }
        const returned = soleReturnedExpression(declaration.body);
        return Boolean(
            returned && this.context.browserErasure.isFrameYield(returned),
        );
    }

    public emitFramePollAwait(call: ts.CallExpression): boolean {
        if (!ts.isIdentifier(call.expression)) return false;
        const declaration = tryResolveFunctionDeclaration(
            this.context.checker,
            call.expression,
        );
        if (
            !declaration?.body ||
            !ts.isBlock(declaration.body) ||
            declaration.body.statements.length !== 1
        )
            return false;
        const returned = soleReturnedExpression(declaration.body);
        if (!returned) return false;
        const poll = framePollExecutor(
            this.context.unwrap(returned),
            this.context.checker,
            (callee) => this.context.libraryGlobal(callee),
        );
        if (!poll) return false;
        if (!this.engineStartMark)
            this.context.fail(
                call,
                "A polling Promise requires a running engine.",
            );
        const args = call.arguments.map((argument) =>
            this.context.compileValue(argument),
        );
        this.context.bindings.pushScope(this.context.allocateBlockPrefix());
        let condition: string;
        try {
            for (const [index, parameter] of declaration.parameters.entries()) {
                if (
                    !ts.isIdentifier(parameter.name) ||
                    parameter.dotDotDotToken
                )
                    this.context.fail(
                        parameter,
                        "Polling helper requires ordinary named parameters.",
                    );
                const argument =
                    args[index] ??
                    (parameter.initializer
                        ? this.context.compileValue(parameter.initializer)
                        : undefined);
                if (!argument)
                    this.context.fail(
                        call,
                        "Polling helper argument is missing.",
                    );
                this.context.bindings.bindLocalValue(parameter.name, argument);
            }
            for (const statement of poll.setup)
                this.context.emitStatement(statement);
            let conditionCpp = "";
            const lines = this.context.captureEmittedLines(() => {
                conditionCpp = this.context.conditions.compileCondition(
                    poll.condition,
                );
            });
            condition =
                lines.length === 0
                    ? conditionCpp
                    : `([&]() { ${lines.join(" ")} return ${conditionCpp}; }())`;
        } finally {
            this.context.bindings.popScope();
        }
        this.emitStartContinuationGate(call, condition);
        return true;
    }

    /**
     * The line `hoistEngineContinuation` cuts the continuation at. Spelled
     * as a C++-invalid statement so a marker that ever escaped the hoist
     * would refuse to build rather than ship silently; `renderCpp` also
     * fails generation if one survives.
     */
    public static readonly frameYieldRequeueMarker =
        "__bblite_frame_yield_requeue__;";

    /**
     * The line a gated continuation cut leaves behind, carrying the latch
     * the rest of the continuation waits on. Spelled the same
     * C++-invalid way as the yield marker and checked the same way, so
     * one that escaped the hoist refuses rather than shipping.
     */
    public static readonly startContinuationGatePrefix =
        "__bblite_start_continuation_until__(";

    /**
     * A frame yield lowered after `startEngine` sits inside the hoisted
     * continuation, which `finish_frame` drains at the END of a frame --
     * after that frame's uploads and render. Erasing the yield there would
     * run the statements after it at the same boundary as the ones before
     * it, so "one more frame has drawn" would be a claim about nothing.
     * Instead the continuation is cut here: `hoistEngineContinuation`
     * turns the marker into a nested `defer_start_continuation`, whose
     * body the conductor runs at the NEXT frame's drain -- the queue is
     * moved out before draining, so a callback queued during a drain
     * always waits a full frame. That makes the yield (and the
     * `firstSortReady` barrier a splat scene pairs it with) truthful by
     * construction. Before the loop exists the yield stays erased: entry
     * code runs before the first frame's own work, which is the original
     * claim, still true there.
     */
    public emitFrameYieldRequeue(expression: ts.Expression): void {
        const mark = this.engineStartMark;
        if (!mark) {
            return;
        }
        // The re-queue is a cut between EMITTED LINES: `hoistEngineContinuation`
        // splits the tail at each marker and wraps the parts, so a marker at
        // any other depth would cut a C++ block in half. The proof is
        // therefore over the emission rather than over the source AST --
        // where lowering stands when the marker lands, which is exactly
        // where `startEngine` itself landed. That accepts the shapes whose
        // statements are written out FLAT at that level (an inlined helper's
        // body, a statically unrolled loop's iterations) without asking this
        // to re-derive which of them applied, and still refuses a yield
        // inside an emitted block, a value lambda, a callback body, or any
        // other captured region, because none of those is at this depth.
        if (this.context.indentLevel !== mark.indentLevel) {
            this.context.fail(
                expression,
                "A frame yield after startEngine re-queues the rest of " +
                    "the continuation to the next frame boundary, which " +
                    "needs the yield to lower at the entry body's own " +
                    "level; inside a block there is no statement " +
                    "boundary to cut at.",
            );
        }
        this.context.emit(EngineLifecycle.frameYieldRequeueMarker);
        this.continuationSequence += 1;
    }

    /**
     * The latch a `new Promise` binding waits on, keyed by the binding's
     * symbol. Empty for every scene but the one that writes the escaping
     * handshake, and the reason the promise value itself has no native
     * representation: what a scene can do with one of these is await it.
     */
    private readonly promiseLatches = new EmissionMap<ts.Symbol, string>();

    /**
     * Declare the latch behind `const p = new Promise((resolve) => {
     * target = resolve; })` and bind `resolve` to it.
     *
     * The executor runs synchronously in JavaScript, so running it here is
     * the faithful reading: after this statement the target holds a
     * callable, and calling it is what the await ends on. The callable is
     * emitted rather than routed through the stored-callback path on
     * purpose -- a stored callback closes over its captures BY VALUE
     * (`plain-data-value-model`), so a generic lowering would latch a copy
     * and the wait would never end.
     */
    public emitEscapingResolvePromise(
        declaration: ts.VariableDeclaration,
        cppName: string,
    ): boolean {
        if (this.context.options.workers) return false;
        if (!declaration.initializer) return false;
        const target = this.context.browserErasure.escapingResolveTarget(
            declaration.initializer,
        );
        if (!target) return false;
        if (this.engineStartMark) {
            this.context.fail(
                declaration,
                "A promise a scene callback resolves is the handshake " +
                    "installed before startEngine; after it the " +
                    "continuation is already running at frame boundaries.",
            );
        }
        const bound = this.context.bindings.lookupOptional(target);
        if (!bound) {
            this.context.fail(
                target,
                `Unable to resolve the binding '${target.text}' the ` +
                    "promise's resolve escapes into.",
            );
        }
        const symbol = ts.isIdentifier(declaration.name)
            ? this.context.symbols.valueSymbol(declaration.name)
            : undefined;
        if (!symbol) {
            this.context.fail(
                declaration,
                "A promise a scene callback resolves needs a named binding.",
            );
        }
        this.context.emit({
            kind: "declaration",
            type: "bool",
            name: cppName,
            initializer: "false",
        });
        this.context.emit({
            kind: "expression",
            code: `${bound.cpp} = [&${cppName}]() { ${cppName} = true; };`,
        });
        this.promiseLatches.set(symbol, cppName);
        return true;
    }

    /**
     * The latch `await <binding>` waits on, or undefined when the awaited
     * expression is not one of this scene's handshake promises.
     */
    public promiseLatchCondition(
        expression: ts.Expression,
    ): string | undefined {
        if (!ts.isIdentifier(expression)) return undefined;
        const symbol = this.context.symbols.valueSymbol(expression);
        return symbol ? this.promiseLatches.get(symbol) : undefined;
    }

    /**
     * `await <handshake promise>`: park the rest of the continuation until
     * the scene's own callback resolves it.
     *
     * This is the frame-yield cut with a condition on it. A yield names a
     * COUNT of boundaries; this names none -- the scene installed a
     * callback and the wait ends when that callback runs -- so the
     * re-queue repeats until the latch is set instead of once. The
     * capture gate rides along unchanged, because a start continuation
     * that has not run yet already holds it.
     */
    public emitStartContinuationGate(
        expression: ts.Expression,
        latch: string,
    ): void {
        const mark = this.engineStartMark;
        if (!mark) {
            this.context.fail(
                expression,
                "A promise a scene callback resolves is awaited after " +
                    "startEngine, where the frame boundaries that run " +
                    "that callback exist.",
            );
        }
        if (this.context.indentLevel !== mark.indentLevel) {
            this.context.fail(
                expression,
                "Awaiting a scene-resolved promise parks the rest of the " +
                    "continuation, which needs the await to lower at the " +
                    "entry body's own level; inside a block there is no " +
                    "statement boundary to cut at.",
            );
        }
        this.context.emit(
            `${EngineLifecycle.startContinuationGatePrefix}${latch});`,
        );
        this.continuationSequence += 1;
        for (const binding of this.context.statementDependencies.at(-1) ?? [])
            this.context.useNativeBinding(binding);
    }

    public engineHasStarted(): boolean {
        return this.engineStartMark !== undefined;
    }

    /**
     * Where `startEngine` lands in the entry body.
     *
     * Upstream `startEngine` schedules the render loop and RETURNS, so the
     * rest of `main` runs interleaved with the frames it started -- which is
     * how a scene picks, reads the result and mutates the scene before the
     * capture. `pal::run_engine` does not return until the loop ends, so the
     * same statements emitted in place would run after the capture and
     * decide nothing. They are the browser's continuation, and the frame
     * conductor already has the boundary it wants: the deferred-callback
     * queue `finish_frame` drains at the end of each frame, after that
     * frame's uploads and render.
     */
    @journaled public accessor engineStartMark:
        | {
              readonly index: number;
              readonly engine: string;
              readonly node: ts.Node;
              readonly indentLevel: number;
          }
        | undefined;

    @journaled public accessor continuationStorageReached = false;

    private readonly deviceRecoveryCallbacks: Array<{
        cpp: string;
        options: Value;
        node: ts.Expression;
    }> = emissionArray([]);

    public compileDeviceRecoveryIntrinsic(
        name: string,
        call: ts.CallExpression,
    ): Value | undefined {
        if (
            ![
                "enableDeviceLostSceneRecovery",
                "forceWebGpuDeviceLossForTesting",
                "disposeEngine",
            ].includes(name)
        )
            return undefined;
        this.context.expectArgumentCount(
            call,
            1,
            name === "enableDeviceLostSceneRecovery" ? 2 : 1,
        );
        const engine = this.context.compileValue(argumentAt(call, 0));
        this.context.expectKind(engine, "engine", argumentAt(call, 0));
        this.context.reachFeature(
            name === "disposeEngine"
                ? "engine:dispose"
                : "engine:device-recovery",
            call,
        );
        if (name === "enableDeviceLostSceneRecovery") {
            if (
                this.engineHasStarted() ||
                this.context.isRuntimeResourceConstruction()
            )
                this.context.fail(
                    call,
                    "Device recovery registration requires unconditional construction before engine startup.",
                );
            const cpp =
                this.context.allocateTemporaryCppName("device_recovery");
            this.context.emit({
                kind: "declaration",
                type: "auto",
                name: cpp,
                initializer: `bbl::enable_device_lost_scene_recovery(${engine.cpp})`,
            });
            if (call.arguments[1]) {
                const node = call.arguments[1];
                const options = this.context.compileValue(node);
                this.context.expectKind(options, "record", node);
                const allowed = new EmissionSet([
                    "onLost",
                    "onRecovered",
                    "onRecoveryFailed",
                ]);
                for (const key of [
                    ...Object.keys(options.recordProperties ?? {}),
                    ...Object.keys(options.recordMethods ?? {}),
                ]) {
                    if (!allowed.has(key))
                        this.context.fail(
                            node,
                            `Unrepresented device recovery option '${key}'.`,
                        );
                }
                this.deviceRecoveryCallbacks.push({ cpp, options, node });
            }
            return {
                kind: "device-recovery",
                cpp,
                engineCpp: engine.cpp,
                dataType: { kind: "handle", handle: "device-recovery" },
            };
        }
        return {
            kind: "void",
            cpp:
                name === "disposeEngine"
                    ? `bbl::dispose_engine(${engine.cpp})`
                    : `bbl::force_device_loss(${engine.cpp})`,
        };
    }

    private emitDeviceRecoveryCallbacks(): void {
        for (const registration of this.deviceRecoveryCallbacks.splice(0)) {
            const options = registration.options;
            for (const [source, target] of [
                ["onLost", "on_lost"],
                ["onRecovered", "on_recovered"],
                ["onRecoveryFailed", "on_failed"],
            ] as const) {
                const callback =
                    options.recordMethods?.[source] ??
                    options.recordProperties?.[source]?.callbackDeclaration;
                if (!callback) {
                    if (options.recordProperties?.[source])
                        this.context.fail(
                            registration.node,
                            `Device recovery '${source}' requires a callback declaration.`,
                        );
                    continue;
                }
                const declaration = ts.isIdentifier(callback)
                    ? tryResolveFunctionDeclaration(
                          this.context.checker,
                          callback,
                      )
                    : callback;
                if (
                    !declaration ||
                    declaration.parameters.length >
                        (target === "on_failed" ? 1 : 0)
                )
                    this.context.fail(
                        callback,
                        `The recovery '${source}' callback parameters are not represented.`,
                    );
                const error =
                    target === "on_failed"
                        ? this.context.allocateTemporaryCppName(
                              "recovery_error",
                          )
                        : undefined;
                const parameter =
                    target === "on_failed"
                        ? ({
                              kind: "record",
                              cpp: "",
                              nativeError: true,
                              truthinessCpp: "true",
                              recordProperties: {
                                  message: {
                                      kind: "string",
                                      cpp: error!,
                                      dataType: { kind: "string" },
                                  },
                              },
                          } satisfies Value)
                        : undefined;
                const lines = this.context.captureEmittedLines(() => {
                    if (error)
                        this.context.registerNativeConstBinding(error, true);
                    const result = this.context.compileCallbackWithValues(
                        callback,
                        parameter ? [parameter] : [],
                        registration.node,
                    );
                    this.context.emitDiscardedValue(result);
                });
                this.context.emit(
                    `${registration.cpp}->${target} = [&](${error ? `[[maybe_unused]] const std::string& ${error}` : ""}) {`,
                );
                this.context.increaseIndent();
                for (const line of lines) this.context.emit(line);
                this.context.decreaseIndent();
                this.context.emit("};");
            }
        }
    }

    public markEngineStart(engineCpp: string, node: ts.Node): void {
        this.emitDeviceRecoveryCallbacks();
        if (this.context.ui.primaryCanvasReadyGate)
            this.context.emit({
                kind: "expression",
                code: `bbl::defer_capture_until(${engineCpp}, [&]() { return bbl::canvas_dataset(${engineCpp}, "ready") == "true"; });`,
            });
        if (this.engineStartMark) {
            this.context.fail(
                node,
                "A second startEngine is a restart this runtime does not " +
                    "lower; the first one already owns the continuation.",
            );
        }
        this.engineStartMark = {
            index: this.context.body.length,
            engine: engineCpp,
            node,
            indentLevel: this.context.indentLevel,
        };
    }

    /** Emit the same worker-aware cleanup for synchronous and suspended scopes. */
    public emitFinallyGuard(cleanup: readonly string[]): string {
        this.context.reachJsData();
        const guard = this.context.allocateTemporaryCppName("finally");
        this.context.emit(
            `[[maybe_unused]] auto ${guard} = bbl::js::finally([&]() {`,
        );
        this.context.increaseIndent();
        const workerAbort = this.context.asyncActivations.workerAbortCpp();
        if (workerAbort) this.context.emit(`if (${workerAbort}) return;`);
        else if (this.context.options.pendingActivations)
            this.context.emit("if (bbl::js::activation_abandoned()) return;");
        for (const line of cleanup) this.context.emit(line);
        this.context.decreaseIndent();
        this.context.emit("});");
        return guard;
    }

    /** Keep a flat try/finally alive across the startEngine continuation. */
    public emitEngineFinally(
        body: readonly string[],
        cleanup: () => readonly string[],
        site: ts.TryStatement,
    ): boolean {
        const mark = this.engineStartMark;
        if (!mark || site.catchClause) return false;
        const start = body.findIndex((line) =>
            line.startsWith("bbl::start_engine("),
        );
        if (start < 0) return false;
        // The two lifetime guards can run while C++ is unwinding. A second
        // exception would terminate rather than replace the source exception.
        // Until finally has explicit completion lowering, admit plain cleanup
        // writes and refuse calls/accessors whose exception effects are unknown.
        const checkCleanup = (node: ts.Node): void => {
            if (ts.isFunctionLike(node)) return;
            // Erased browser calls with no arguments have no native cleanup
            // effects. Platform-backed calls remain outside browser erasure.
            if (
                ts.isCallExpression(node) &&
                node.arguments.length === 0 &&
                this.context.browserErasure.isBrowserOnlyExpression(node)
            )
                return;
            const properties = ts.isPropertyAccessExpression(node)
                ? [resolvedSymbol(this.context.checker, node)]
                : ts.isElementAccessExpression(node)
                  ? this.context.checker
                        .getTypeAtLocation(node.expression)
                        .getProperties()
                  : [];
            const accessor = properties.some((property) =>
                property?.declarations?.some(
                    (declaration) =>
                        ts.isGetAccessorDeclaration(declaration) ||
                        ts.isSetAccessorDeclaration(declaration),
                ),
            );
            if (
                ts.isThrowStatement(node) ||
                ts.isCallExpression(node) ||
                ts.isNewExpression(node) ||
                accessor
            ) {
                this.context.fail(
                    node,
                    "A finally block spanning startEngine requires non-throwing cleanup; calls, accessors and throw are not admitted.",
                );
            }
            ts.forEachChild(node, checkCleanup);
        };
        if (site.finallyBlock) checkCleanup(site.finallyBlock);
        if (
            body
                .slice(start + 1)
                .some(
                    (line) =>
                        line.trim() ===
                            EngineLifecycle.frameYieldRequeueMarker ||
                        line
                            .trim()
                            .startsWith(
                                EngineLifecycle.startContinuationGatePrefix,
                            ),
                )
        ) {
            this.context.fail(
                site,
                "A finally block spanning startEngine cannot also span a later frame yield.",
            );
        }
        const cleanupLines = cleanup();
        const guard = cleanupLines.length
            ? this.emitFinallyGuard(cleanupLines)
            : undefined;
        for (const line of body.slice(0, start)) this.context.emit(line);
        const started = writable(mark);
        started.index = this.context.body.length;
        started.indentLevel = this.context.indentLevel;
        this.context.emit(body[start]!);
        if (!guard) {
            for (const line of body.slice(start + 1)) this.context.emit(line);
            return true;
        }
        // The outer guard covers setup/start failures. The continuation
        // guard finishes cleanup on its own normal, return or exception
        // completion, while the outer guard remains safe to destroy later.
        const completion =
            this.context.allocateTemporaryCppName("finally_completion");
        this.context.emit({
            kind: "declaration",
            type: "auto",
            name: completion,
            initializer: `bbl::js::finally([&]() { ${guard}.run(); })`,
        });
        for (const line of body.slice(start + 1)) this.context.emit(line);
        this.context.emit({ kind: "expression", code: `${completion}.run();` });
        return true;
    }

    /** Move the post-start body to frame drains, counting consecutive empty waits. */
    public hoistEngineContinuation(): void {
        const mark = this.engineStartMark;
        if (!mark) {
            return;
        }
        let index = mark.index;
        while (
            index < this.context.body.length &&
            !renderNativeEmission(this.context.body[index]!).includes(
                "bbl::start_engine(",
            )
        ) {
            index += 1;
        }
        if (index >= this.context.body.length) {
            return;
        }
        const tail = this.context.body
            .splice(index + 1)
            .map(renderNativeEmission);
        if (tail.length === 0) {
            return;
        }
        // The continuation has to be a run of statements at the call's own
        // depth. A `startEngine` inside a block would leave that block's
        // closing brace in the tail at a shallower indent, and moving it
        // into the lambda would emit unbalanced C++ -- so the shape is
        // checked here, where the emitted lines say what it is, rather
        // than guessed from the lowering scope.
        const depth = (line: string): number =>
            line.length - line.trimStart().length;
        const startDepth = depth(
            renderNativeEmission(this.context.body[index]!),
        );
        const escapes = tail.find(
            (line) => line.trim().length > 0 && depth(line) < startDepth,
        );
        if (escapes !== undefined) {
            this.context.fail(
                mark.node,
                "startEngine is lowered at the entry body's top level " +
                    "alone: the statements after it become the frame " +
                    "conductor's deferred callback, and a block that " +
                    "closes after it has no boundary for one.",
            );
        }
        const indent = " ".repeat(startDepth);
        // A part runs after its frame count or promise gate. Statement-bearing
        // parts stay nested so later parts can name earlier persistent locals.
        let sequence = 0;
        const parts: {
            gate?: string;
            frames: number;
            lines: string[];
            sequence: number;
        }[] = [{ frames: 1, lines: [], sequence }];
        for (const line of tail) {
            const trimmed = line.trim();
            if (trimmed === EngineLifecycle.frameYieldRequeueMarker) {
                sequence += 1;
                const previous = parts.at(-1)!;
                if (
                    previous.lines.length === 0 &&
                    previous.gate === undefined
                ) {
                    previous.frames += 1;
                    previous.sequence = sequence;
                } else {
                    parts.push({ frames: 1, lines: [], sequence });
                }
            } else if (
                trimmed.startsWith(
                    EngineLifecycle.startContinuationGatePrefix,
                ) &&
                trimmed.endsWith(");")
            ) {
                parts.push({
                    frames: 1,
                    sequence: ++sequence,
                    gate: trimmed.slice(
                        EngineLifecycle.startContinuationGatePrefix.length,
                        -2,
                    ),
                    lines: [],
                });
            } else {
                parts.at(-1)!.lines.push(line);
            }
        }
        const storage = this.context.allocateTemporaryCppName(
            "continuation_storage",
        );
        const retainsLocals = persistContinuationLocals(
            parts,
            this.context.nativeDeclarations,
            this.continuationUses,
            this.continuationLocals,
            startDepth,
            storage,
        );
        this.continuationStorageReached = retainsLocals;
        const captures = retainsLocals ? `[&, ${storage}]` : "[&]";
        let nested: string[] = [];
        // Bound indentation for continuations with many statement-bearing parts.
        const maxIndentedDepth = 8;
        for (let part = parts.length - 1; part >= 0; part -= 1) {
            const step = parts.length - part <= maxIndentedDepth ? "    " : "";
            const { gate, frames } = parts[part]!;
            const resolved =
                gate !== undefined
                    ? `${captures}() { return ${gate}; }`
                    : frames > 1
                      ? `[remaining = ${frames}u]() mutable { return --remaining == 0; }`
                      : undefined;
            nested = [
                resolved === undefined
                    ? `${indent}bbl::defer_start_continuation(` +
                      `${mark.engine}, ${captures}() {`
                    : `${indent}bbl::defer_start_continuation_until(` +
                      `${mark.engine}, ${resolved}, ` +
                      `${captures}() {`,
                ...[...parts[part]!.lines, ...nested].map(
                    (line) => `${step}${line}`,
                ),
                `${indent}});`,
            ];
        }
        if (retainsLocals)
            nested.unshift(
                `${indent}auto ${storage} = std::make_shared<bbl::ContinuationStorage>();`,
            );
        this.context.body.splice(index, 0, ...nested.map(verbatimEmission));
    }
}
