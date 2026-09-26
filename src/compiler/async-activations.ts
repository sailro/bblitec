import { journaled } from "./emission-transaction.js";
import ts from "typescript";
import { framePollExecutor } from "./frame-poll.js";
import { PendingActivations } from "./pending-activations.js";
import type { DataType } from "./data-types.js";
import type { SupportedFunction } from "./user-functions.js";
import { unwrapExpression } from "./syntax.js";
import type { Value } from "./types.js";
import type {
    LoweringServices,
    NativeReturnValueCompiler,
} from "./lowering-services.js";
import type { AsyncLowerer } from "./async.js";

/** What the async activations read of the compiler. */
interface AsyncActivationContext extends Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
    | "assetRegistry"
    | "browserErasure"
    | "captureEmittedLines"
    | "captureEmittedStatements"
    | "checker"
    | "callbacks"
    | "compileValue"
    | "decreaseIndent"
    | "emit"
    | "emitCapturedStatements"
    | "fail"
    | "increaseIndent"
    | "isRuntimeResourceConstruction"
    | "libraryGlobal"
    | "options"
    | "sourceFiles"
    | "symbols"
    | "unwrap"
    | "withOwnedCallbackBody"
> {
    readonly asyncLowerer: AsyncLowerer;
    /** The engine-creation bootstrap being executed, if any. */
    readonly engineCreationExecution: object | undefined;
    /** How many runtime control-flow constructs enclose the current emission. */
    readonly runtimeControlFlowDepth: number;
}

/**
 * Async activations: awaits and async calls in a worker realm, constructed synchronous promises,
 * the pending-activation analysis and the statement boundaries where an abandoned activation ends,
 * engine bootstrap and awaited setup ordering, and the worker event loop's checkpoint, abort and
 * event callbacks.
 */
export class AsyncActivations {
    constructor(private readonly context: AsyncActivationContext) {}

    public emitAwaitExpression(expression: ts.Expression): boolean {
        if (!this.context.options.workers) return false;
        const node = unwrapExpression(expression);
        if (!ts.isAwaitExpression(node)) return false;
        this.context.compileValue(expression);
        return true;
    }

    public withAsyncActivation<T>(work: () => T): T {
        return this.context.asyncLowerer.withActivation(work);
    }

    public compileAsyncCall(
        declaration: SupportedFunction,
        arguments_: readonly Value[],
        node: ts.Node,
    ): Value | undefined {
        return this.context.options.workers
            ? this.context.asyncLowerer.compileCall(
                  declaration,
                  arguments_,
                  node,
              )
            : undefined;
    }

    public compileSynchronousPromise(node: ts.NewExpression): Value {
        return this.context.asyncLowerer.compileSynchronousConstructor(node);
    }

    /** @unjournaled A whole-program analysis of compiler inputs, built on first use. */
    private pendingActivationAnalysis: PendingActivations | undefined;

    /** Built once a reached constructed promise sets `pendingActivations`. */
    public pendingActivations(): PendingActivations {
        this.pendingActivationAnalysis ??= new PendingActivations(
            this.context.checker,
            this.context.sourceFiles(),
            (construction) =>
                this.context.browserErasure.isFrameYield(construction) ||
                this.context.browserErasure.isBoundedNestedFrameYield(
                    construction,
                ) ||
                this.context.browserErasure.frameDrainCondition(
                    construction,
                ) !== undefined ||
                framePollExecutor(
                    construction,
                    this.context.checker,
                    (expression) => this.context.libraryGlobal(expression),
                ) !== undefined,
        );
        return this.pendingActivationAnalysis;
    }

    /** Refuses a reached use of a waiting function that needs a pending promise value. */
    public refusePendingActivationUse(node: ts.Node): void {
        if (this.context.options.pendingActivations)
            this.pendingActivations().refuseReached(node, (site, message) =>
                this.context.fail(site, message),
            );
    }

    /**
     * An expression statement that discards the promise of an activation
     * which can end at a pending await is where that ending stops: the
     * statements after it run, as they do after JavaScript's suspension.
     */
    public emitActivationBoundary(
        statement: ts.ExpressionStatement,
        emit: () => boolean | void,
    ): boolean | void {
        if (
            !this.context.options.pendingActivations ||
            !this.pendingActivations().discards(statement)
        )
            return emit();
        const body = this.context.captureEmittedStatements(() => {
            emit();
        });
        this.context.emit({ kind: "open", code: "try {" });
        this.context.increaseIndent();
        this.context.emitCapturedStatements(body);
        this.context.decreaseIndent();
        this.context.emit({
            kind: "branch",
            code: "} catch (const bbl::js::PendingActivation&) {",
            outlineInterior: false,
        });
        this.context.emit({
            kind: "expression",
            code: "    bbl::js::end_abandoned_activation();",
        });
        this.context.emit({ kind: "close", code: "}" });
        return false;
    }

    public withEngineBootstrap<T>(
        declaration: SupportedFunction,
        work: () => T,
    ): T {
        // Worker bootstrap helpers can run under a message guard. Their own
        // unconditional pre-engine setup remains fixed for every invocation.
        const ownsEngine =
            declaration.body &&
            ts.isBlock(declaration.body) &&
            declaration.body.statements.some(
                (statement) =>
                    ts.isVariableStatement(statement) &&
                    statement.declarationList.declarations.some((variable) => {
                        const call =
                            variable.initializer &&
                            this.context.unwrap(variable.initializer);
                        return (
                            call &&
                            ts.isCallExpression(call) &&
                            ts.isIdentifier(call.expression) &&
                            this.context.symbols.importedName(
                                call.expression,
                            ) === "createEngine"
                        );
                    }),
            );
        if (ownsEngine)
            this.context.assetRegistry.decoderBootstrapDepths.push(
                this.context.runtimeControlFlowDepth,
            );
        try {
            return work();
        } finally {
            if (ownsEngine)
                this.context.assetRegistry.decoderBootstrapDepths.pop();
        }
    }

    public compileAsyncReturn(
        expression: ts.Expression,
        type: DataType | undefined,
        compileResult?: NativeReturnValueCompiler,
    ): string {
        return this.context.asyncLowerer.compileReturn(
            expression,
            type,
            compileResult,
        );
    }

    @journaled public accessor awaitedSetupDepth = 0;

    /** Immediately awaited helpers preserve their new engine's resource order. */
    public withAsyncInvocation<T>(node: ts.Node, body: () => T): T {
        let consumer = node;
        while (
            consumer.parent &&
            (ts.isParenthesizedExpression(consumer.parent) ||
                ts.isAsExpression(consumer.parent) ||
                ts.isNonNullExpression(consumer.parent))
        )
            consumer = consumer.parent;
        if (consumer.parent && ts.isArrayLiteralExpression(consumer.parent)) {
            const array = consumer.parent;
            const all = array.parent;
            if (
                ts.isCallExpression(all) &&
                all.arguments[0] === array &&
                ts.isPropertyAccessExpression(all.expression) &&
                all.expression.name.text === "all" &&
                this.context.libraryGlobal(all.expression.expression) ===
                    "Promise"
            )
                consumer = all;
        }
        const ordered =
            this.context.engineCreationExecution !== undefined &&
            ts.isAwaitExpression(consumer.parent) &&
            !this.context.isRuntimeResourceConstruction();
        if (ordered) this.awaitedSetupDepth++;
        try {
            return this.context.withOwnedCallbackBody(body);
        } finally {
            if (ordered) this.awaitedSetupDepth--;
        }
    }

    public workerCheckpointCpp(): string | undefined {
        return this.context.options.workers
            ? "bbl::pal::EventLoop::current().checkpoint()"
            : undefined;
    }

    public workerAbortCpp(): string | undefined {
        return this.context.options.workers
            ? "bbl::pal::EventLoop::current().aborting()"
            : undefined;
    }

    public compileAsyncEngineStart(
        engine: Value,
        node: ts.Node,
    ): Value | undefined {
        if (!this.context.options.workers) return undefined;
        if (!engine.ownedEngineCpp)
            this.context.fail(
                node,
                "Asynchronous engine startup requires an owned engine.",
            );
        return {
            kind: "promise",
            cpp: `bbl::pal::start_realm_engine(${engine.ownedEngineCpp})`,
            promiseResult: { kind: "void", cpp: "" },
            promiseType: "bbl::js::PromiseVoid",
        };
    }

    public compileWorkerCallback(
        expression: ts.Expression,
        event: "message" | "error",
    ): string {
        const name = this.context.allocateTemporaryCppName("worker_event");
        const type =
            event === "message"
                ? "const bbl::pal::WorkerMessage&"
                : "bbl::pal::WorkerErrorEvent&";
        const callback = this.context.callbacks.compilePlatformCallback(
            expression,
            { name, cppType: type },
            [
                {
                    kind:
                        event === "message"
                            ? "worker-message-event"
                            : "worker-error-event",
                    cpp: name,
                },
            ],
        );
        return `bbl::js::Callback<void(${type})>(${callback.identity}, ${callback.cpp})`;
    }
}
