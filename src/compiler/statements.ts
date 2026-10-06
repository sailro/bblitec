import { someAnalysisNode, forEachAnalysisNode } from "./analysis-walk.js";
import {
    emissionArray,
    EmissionMap,
    EmissionSet,
    EmissionWeakSet,
    journaled,
    writable,
} from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { traceSourceNode } from "./source-trace.js";
import { activeSurvey } from "./survey.js";
import { activeStorageDemandPlanner } from "./storage-demand-planner.js";
import {
    coverSourceStatement,
    sourceCoverageActive,
} from "./source-coverage.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { syntaxKindName } from "../source-location.js";
import { cppIdentifierPattern, doubleLiteral } from "../cpp-literals.js";
import { emitParticleAliveGuard } from "./particle-buffer.js";
import {
    isHandleKind,
    isDataTuple,
    tupleComponents,
    type DataType,
} from "./data-types.js";
import type { Value } from "./types.js";
import { lightSetter } from "./assignments.js";
import {
    sceneNodeTransformDescriptor,
    type SceneNodeTransformDescriptor,
} from "../scene-node-transform-descriptor.js";
import {
    staticIndexLoopShape,
    staticIndexLoopIterations,
    loopBoundMayChange,
    walkReachedLoopNodes,
} from "./resource-loops.js";
import { writesThroughTrackedRoot } from "./user-functions.js";
import {
    integerCounterRead,
    integerLoopConditionCpp,
    integerLoopCounter,
    integerLoopStepCpp,
} from "./integer-loops.js";
import { staticNumberValue } from "./option-helpers.js";
import {
    argumentAt,
    isLogicalAssignmentOperator,
    isUpdateExpression,
    iteratorMethodCall,
    unwrappedIdentifier,
} from "./syntax.js";
import {
    caughtErrorValue,
    authoredErrorValue,
    compileErrorConstruction,
    errorConstructor,
    errorValue,
    thrownMessage,
} from "./error-values.js";
import { emitStringAppend } from "./expressions.js";
import {
    commonResourceValue,
    isStringValue,
    optionalPresentCpp,
    optionalValueCpp,
    staticStringValue,
} from "./types.js";
import { isJsonValue } from "./json-bridge.js";
import { isNullishLiteral } from "./symbols.js";
import { absenceKind } from "./type-facts.js";
import {
    emitReachableStatements,
    enclosingLoopControl,
    firstReturn,
    callsNever,
    returnsNever,
} from "./loop-control.js";
// The handle-collection concept owns the collection targets, the loop
// frame, and the recursive imported-mesh walk proof; the emitters here are
// the statement layer over the same resolutions.
import {
    emitHandleCollectionLoop,
    isRecursiveImportedMeshWalk,
    type HandleCollectionTarget,
} from "./handle-collections.js";
import { recordAt } from "./record-access.js";
import { JS_BITWISE_FUNCTIONS } from "../lowering/pinned-operators.js";
import {
    nativeStatementCode,
    renderNativeEmission,
} from "./native-statements.js";

interface StatementLoweringContext extends Pick<
    LoweringServices,
    | "classLowerer"
    | "resolveRecordValue"
    | "admissions"
    | "asyncActivations"
    | "pageLoader"
    | "options"
    | "speculating"
    | "transaction"
    | "checker"
    | "symbols"
    | "dataTypes"
    | "sceneManifest"
    | "handleCollections"
    | "constructsLocalClass"
    | "bindings"
    | "resolveStaticExpression"
    | "reachThrow"
    | "reachFeature"
    | "reachJsData"
    | "reachJson"
    | "propertyName"
    | "cppString"
    | "dataLowerer"
    | "emitOptionalResourceAssignment"
    | "assignOptionalResourceValue"
    | "emitDataPostfix"
    | "dataIterationTarget"
    | "bindDataIterationVariable"
    | "registerNativeBindingType"
    | "activeNativeReturnType"
    | "prefersNativeDataIteration"
    | "activeInlineWrapper"
    | "trackResourceLoopEarlyReturn"
    | "isRuntimeResourceConstruction"
    | "emitNativeReturn"
    | "emitNativeYield"
    | "activeGeneratorType"
    | "emitNativeThrow"
    | "captureEmittedLines"
    | "captureEmittedStatements"
    | "emitCapturedStatements"
    | "reachesOnlyClosedEffects"
    | "useNativeValue"
    | "engineLifecycle"
    | "nativeBindingCheckpoint"
    | "registerNativeConstBinding"
    | "captureHoistedLines"
    | "probeEmission"
    | "allocateTemporaryCppName"
    | "declarations"
    | "emitAssignment"
    | "emitWindowLogicalAssignment"
    | "emitDelete"
    | "compileValue"
    | "compileTextMutation"
    | "compileNodeInputMutation"
    | "checkNodeGeometryMutation"
    | "emitDiscardedValue"
    | "conditions"
    | "browserErasure"
    | "libraryGlobal"
    | "compileNumber"
    | "compileEnumSwitchLabel"
    | "expectStaticArrayLiteral"
    | "probeStaticArrayLiteral"
    | "constArrayLiteral"
    | "expectKind"
    | "expectSameEngine"
    | "requireEngine"
    | "assetRegistry"
    | "expectArgumentCount"
    | "expectObjectLiteral"
    | "objectProperty"
    | "unwrap"
    | "requireDefaultEngine"
    | "isBrowserInstrumentationCall"
    | "emitPlatformEventListener"
    | "eraseBrowserInstrumentation"
    | "requiresStaticIteration"
    | "requiresStaticDataIteration"
    | "executedModuleConstantElements"
    | "emitNativeDataIteration"
    | "knownCollectionCardinality"
    | "runtimeCollectionCardinality"
    | "parameterizedResourceLoop"
    | "emitParameterizedResourceLoop"
    | "isInParameterizedResourceLoop"
    | "enterRuntimeControlFlow"
    | "leaveRuntimeControlFlow"
    | "isInRuntimeControlFlow"
    | "enterRuntimeIteration"
    | "leaveRuntimeIteration"
    | "enterStaticIteration"
    | "leaveStaticIteration"
    | "emit"
    | "increaseIndent"
    | "decreaseIndent"
    | "allocateBlockPrefix"
    | "fail"
> {}

/**
 * Whether a frame yield sits inside a loop this lowering did not write out,
 * walking out to the enclosing function.
 *
 * One yield means "the work queued before this has landed", which this
 * runtime satisfies by construction. N of them in a RUNTIME loop mean "let N
 * frames elapse", which it does not — so the shape has to be told apart from
 * the single one rather than erased per iteration.
 *
 * A loop whose trip count is generation-known is not that shape. Unrolling
 * writes its body out once per iteration, FLAT into the scope the loop stood
 * in (`emitUnrolledIteration`), so the yields become a run of sequential
 * yields — exactly the shape the continuation re-queue already lowers, one
 * nested `defer_start_continuation` per marker. `unrolled` is the set of
 * loops currently being emitted that way, so this asks the question the
 * emission answers rather than the one the source AST shows: every enclosing
 * loop written out is no loop at all by the time the marker lands.
 */
function frameYieldInsideLoop(
    node: ts.Node,
    unrolled: readonly { iteration: ts.IterationStatement }[],
): boolean {
    for (
        let parent: ts.Node | undefined = node.parent;
        parent && !ts.isFunctionLike(parent);
        parent = parent.parent
    ) {
        if (
            ts.isForStatement(parent) ||
            ts.isWhileStatement(parent) ||
            ts.isForOfStatement(parent) ||
            ts.isForInStatement(parent) ||
            ts.isDoStatement(parent)
        ) {
            if (!unrolled.some(({ iteration }) => iteration === parent))
                return true;
        }
    }
    return false;
}

/**
 * Whether a statement subtree reaches a frame yield the lowering would emit
 * a continuation cut for.
 *
 * A loop body that does forces the loop to be iterated statically, for the
 * same reason a body reaching pinned scene construction does: the yield is
 * generation-owned state — one frame boundary in the emitted continuation —
 * and emitting the body once inside a native loop would record ONE boundary
 * for many run-time iterations, which is the multi-frame wait this runtime
 * refuses to fake.
 */
function containsFrameYield(
    context: StatementLoweringContext,
    statement: ts.Statement,
): boolean {
    const found = someAnalysisNode(statement, (node) => {
        if (
            ts.isExpressionStatement(node) &&
            ts.isAwaitExpression(node.expression)
        ) {
            const awaited = context.unwrap(node.expression.expression);
            if (
                context.engineLifecycle.isFrameYield(awaited) ||
                context.engineLifecycle.isBoundedNestedFrameYield(awaited)
            ) {
                return true;
            }
        }
        return false;
    });

    return found;
}

/** A loop body's statements, whether or not it was written as a block. */
function bodyStatements(
    statement: ts.IterationStatement,
): readonly ts.Statement[] {
    return ts.isBlock(statement.statement)
        ? statement.statement.statements
        : [statement.statement];
}

/**
 * The compound assignments whose C++ operator would not mean the JavaScript
 * one, by spelling, with the `bbl::js` helper each lowers through: a bitwise
 * form applies its operator's `JS_BITWISE_FUNCTIONS` helper, and `%=` is
 * JavaScript's floating remainder.
 */
export const COMPOUND_ASSIGNMENT_HELPERS: ReadonlyMap<string, string> =
    new EmissionMap([
        ["%=", "remainder_js"],
        ["**=", "power_js"],
        ...[...JS_BITWISE_FUNCTIONS].map(([kind, helper]): [string, string] => [
            `${ts.tokenToString(kind)}=`,
            helper,
        ]),
    ]);

/** The number `previous op= right` stores; a helper form reaches JS data. */
export function compoundAssignmentValueCpp(
    operator: string,
    previous: string,
    right: string,
): string {
    const helper = COMPOUND_ASSIGNMENT_HELPERS.get(operator);
    return helper
        ? `bbl::js::${helper}(${previous}, ${right})`
        : `(${previous} ${operator.slice(0, -1)} ${right})`;
}

/** `=` and the compound assignments the lowerings accept, by spelling. */
export const ASSIGNMENT_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> =
    new EmissionMap([
        [ts.SyntaxKind.EqualsToken, "="],
        [ts.SyntaxKind.PlusEqualsToken, "+="],
        [ts.SyntaxKind.MinusEqualsToken, "-="],
        [ts.SyntaxKind.AsteriskEqualsToken, "*="],
        [ts.SyntaxKind.SlashEqualsToken, "/="],
        [ts.SyntaxKind.PercentEqualsToken, "%="],
        [ts.SyntaxKind.AsteriskAsteriskEqualsToken, "**="],
        [ts.SyntaxKind.AmpersandEqualsToken, "&="],
        [ts.SyntaxKind.BarEqualsToken, "|="],
        [ts.SyntaxKind.CaretEqualsToken, "^="],
        [ts.SyntaxKind.LessThanLessThanEqualsToken, "<<="],
        [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ">>="],
        [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ">>>="],
    ]);

/**
 * How an unrolled iteration ended at generation: on, by a break or continue
 * it settles, or by a jump only the running program takes.
 */
type StaticCompletion = "normal" | "break" | "continue" | "jumped";

/** One loop instance being unrolled. */
interface UnrolledLoop {
    readonly iteration: ts.IterationStatement;
    /** The label after the last iteration, once a runtime break needs it. */
    readonly breakLabel: string | undefined;
    /** Later iterations are scopes: a runtime break may pass over them. */
    readonly scoped: boolean;
    /** Whether the body may leave the loop under a runtime condition. */
    readonly runtimeExits: boolean;
}

/** The iteration of an unrolled loop being emitted. */
interface StaticIterationFrame {
    readonly iteration: ts.IterationStatement;
    readonly completion: StaticCompletion;
    readonly loop: UnrolledLoop;
    /**
     * `flat` writes statements into the enclosing scope; `probe` does so
     * speculatively and asks for a scope at the first runtime exit;
     * `scoped` is that scope, whose exits jump.
     */
    readonly mode: "flat" | "probe" | "scoped";
    /** Runtime branches open at the iteration's own level. */
    readonly runtimeDepth: number;
    /** A runtime exit was emitted: what follows is conditional. */
    readonly exited: boolean;
    readonly continueLabel: string | undefined;
}

/** The first runtime exit of a speculatively flat iteration. */
class RuntimeLoopExitRequired extends Error {
    public constructor(public readonly iteration: ts.IterationStatement) {
        super("An unrolled iteration takes a runtime exit.");
    }
}

/** Where labeled continues of an outer loop leave an inner one. */
interface ContinueTrampoline {
    readonly loop: ts.IterationStatement;
    readonly label: string;
    readonly used: boolean;
}

export class StatementLowerer {
    private readonly cleanupRegions = emissionArray<{
        node: ts.Node;
        returns: boolean;
        jumps: Set<ts.BreakStatement | ts.ContinueStatement>;
    }>();

    public needsReturnCompletion(statement: ts.ReturnStatement): boolean {
        const owner = ts.findAncestor(statement, ts.isFunctionLike);
        for (let index = this.cleanupRegions.length - 1; index >= 0; index--) {
            const region = this.cleanupRegions[index]!;
            if (ts.findAncestor(region.node, ts.isFunctionLike) !== owner)
                continue;
            writable(region).returns = true;
            return true;
        }
        return false;
    }

    private completeCleanupJump(
        context: StatementLoweringContext,
        statement: ts.BreakStatement | ts.ContinueStatement,
    ): boolean {
        const region = this.cleanupRegions.at(-1);
        if (!region) return false;
        for (
            let current: ts.Node | undefined = statement.parent;
            current;
            current = current.parent
        ) {
            if (ts.isFunctionLike(current)) return false;
            if (current === region.node) {
                if (!statement.label && ts.isIterationStatement(current, false))
                    return false;
                region.jumps.add(statement);
                context.emit({
                    kind: "control",
                    code: `throw bbl::js::LoopCompletion(${statement.pos + 1}u);`,
                    transfer: "throw",
                });
                return true;
            }
            if (statement.label) {
                if (
                    ts.isLabeledStatement(current) &&
                    current.label.text === statement.label.text
                )
                    return false;
            } else if (
                ts.isIterationStatement(current, false) ||
                (ts.isBreakStatement(statement) &&
                    ts.isSwitchStatement(current))
            )
                return false;
        }
        return false;
    }
    private readonly loweredTerminators = new EmissionWeakSet<ts.Statement>();
    /** Expression statements of a never-typed expression: they throw. */
    private readonly neverTerminators = new EmissionWeakSet<ts.Statement>();
    private readonly labels: Array<{
        readonly source: string;
        readonly target: string;
        /** A labeled break jumps to the label after the statement. */
        readonly used: boolean;
    }> = emissionArray([]);
    /** Source loops whose current iteration is being emitted statically. */
    private readonly staticIterationCompletions: StaticIterationFrame[] =
        emissionArray([]);
    /** Runtime branches being emitted: an exit below one is not settled. */
    @journaled private accessor runtimeBranchDepth = 0;

    private preferNativeDataIteration(
        context: StatementLoweringContext,
        statement: ts.IterationStatement,
    ): boolean {
        return !context.requiresStaticDataIteration(statement.statement);
    }

    private plainIterationData(
        context: StatementLoweringContext,
        value: Value,
    ): boolean {
        if (
            value.kind === "number" ||
            value.kind === "boolean" ||
            value.kind === "string" ||
            value.kind === "json-null"
        )
            return true;
        if (value.kind === "tuple") {
            return (
                value.tupleElements?.every((entry) =>
                    this.plainIterationData(context, entry),
                ) === true
            );
        }
        if (value.kind === "record") {
            return (
                value.recordProperties !== undefined &&
                Object.values(value.recordProperties).every((entry) =>
                    this.plainIterationData(context, entry),
                ) &&
                Object.keys(value.recordMethods ?? {}).length === 0 &&
                Object.keys(value.recordGetters ?? {}).length === 0 &&
                Object.keys(value.recordSetters ?? {}).length === 0
            );
        }
        return (
            value.kind === "data" &&
            value.dataType !== undefined &&
            !context.dataTypes.carriesHandle(value.dataType) &&
            !context.dataTypes.carriesFunction(value.dataType)
        );
    }

    /** Compile one body whose effects occur only on a native runtime path. */
    private inRuntimeControlFlow<T>(
        context: StatementLoweringContext,
        emitBody: () => T,
    ): T {
        context.enterRuntimeControlFlow();
        this.runtimeBranchDepth += 1;
        try {
            return emitBody();
        } finally {
            this.runtimeBranchDepth -= 1;
            context.leaveRuntimeControlFlow();
        }
    }

    /** Compile an expression/body that a native loop can evaluate repeatedly. */
    private inRuntimeIteration<T>(
        context: StatementLoweringContext,
        emitBody: () => T,
        iteration?: ts.IterationStatement,
    ): T {
        context.enterRuntimeIteration();
        if (iteration) this.nativeLoops.push(iteration);
        try {
            return iteration &&
                !context.isInParameterizedResourceLoop(iteration)
                ? context.emitNativeDataIteration(iteration, emitBody)
                : emitBody();
        } finally {
            if (iteration) this.nativeLoops.pop();
            context.leaveRuntimeIteration();
        }
    }

    /** The frame of the unrolled loop a break or continue binds, if any. */
    private staticIterationForControl(
        statement: ts.BreakStatement | ts.ContinueStatement,
    ): StaticIterationFrame | undefined {
        for (
            let parent: ts.Node | undefined = statement.parent;
            parent;
            parent = parent.parent
        ) {
            if (ts.isFunctionLike(parent)) return undefined;
            if (ts.isBreakStatement(statement) && ts.isSwitchStatement(parent))
                return undefined;
            if (ts.isIterationStatement(parent, false)) {
                return this.staticIterationCompletions.find(
                    ({ iteration }) => iteration === parent,
                );
            }
        }
        return undefined;
    }

    /**
     * A break or continue of a loop being unrolled. Reached on a path the
     * iteration settles, it completes the iteration at generation; under a
     * runtime branch, or after an exit the program decides, it jumps.
     */
    private completeStaticIteration(
        context: StatementLoweringContext,
        statement: ts.BreakStatement | ts.ContinueStatement,
    ): boolean {
        const frame = this.staticIterationForControl(statement);
        if (!frame) return false;
        const exit = ts.isBreakStatement(statement) ? "break" : "continue";
        if (this.runtimeBranchDepth <= frame.runtimeDepth && !frame.exited) {
            writable(frame).completion = exit;
            return true;
        }
        if (frame.mode === "probe")
            throw new RuntimeLoopExitRequired(frame.iteration);
        if (frame.mode === "flat")
            context.fail(
                statement,
                exit === "break"
                    ? "A break in a statically unrolled resource loop requires a generation-known condition."
                    : "A continue in a statically unrolled loop requires a generation-known condition.",
            );
        let label: string;
        if (exit === "break") {
            // Every later iteration is a scope the jump passes over.
            const loop = writable(frame.loop);
            label = loop.breakLabel ??=
                context.allocateTemporaryCppName("unrolled_break");
            loop.scoped = true;
        } else {
            label = writable(frame).continueLabel ??=
                context.allocateTemporaryCppName("unrolled_continue");
        }
        writable(frame).exited = true;
        // At the iteration's own level nothing after the jump runs.
        if (this.runtimeBranchDepth <= frame.runtimeDepth)
            writable(frame).completion = "jumped";
        context.emit({
            kind: "control",
            code: `goto ${label};`,
            transfer: "goto",
        });
        return true;
    }

    /** The loops a labeled jump leaves inside its target, innermost first. */
    private loopsLeftByLabeledJump(
        context: StatementLoweringContext,
        statement: ts.BreakStatement | ts.ContinueStatement,
    ): { loops: ts.IterationStatement[]; target: ts.Statement } {
        const loops: ts.IterationStatement[] = [];
        for (
            let parent: ts.Node | undefined = statement.parent;
            parent && !ts.isFunctionLike(parent);
            parent = parent.parent
        ) {
            if (
                ts.isLabeledStatement(parent) &&
                parent.label.text === statement.label?.text
            ) {
                let target = parent.statement;
                while (ts.isLabeledStatement(target)) target = target.statement;
                return {
                    loops: loops.filter((loop) => loop !== target),
                    target,
                };
            }
            if (ts.isIterationStatement(parent, false)) loops.push(parent);
        }
        context.fail(statement, "A labeled jump has no enclosing label.");
    }

    /**
     * A labeled break of the unrolled loop it stands in directly is that
     * loop's break; a jump past other unrolled iterations would skip their
     * statements' initialization, so it refuses.
     */
    private labeledBreakOfUnrolledLoop(
        context: StatementLoweringContext,
        statement: ts.BreakStatement,
    ): boolean {
        const { loops, target } = this.loopsLeftByLabeledJump(
            context,
            statement,
        );
        const unrolled = (loop: ts.Statement): boolean =>
            this.staticIterationCompletions.some(
                (frame) => frame.iteration === loop,
            );
        if (
            loops.length === 0 &&
            unrolled(target) &&
            this.staticIterationForControl(statement)?.iteration === target
        )
            return this.completeStaticIteration(context, statement);
        if ([...loops, target].some(unrolled))
            context.fail(
                statement,
                "A labeled break out of a statically unrolled loop is not lowered.",
            );
        return false;
    }

    /**
     * The trampoline a labeled continue from a nested loop jumps to, or
     * undefined when the label names the loop the continue stands in.
     */
    private labeledContinueTrampoline(
        context: StatementLoweringContext,
        statement: ts.ContinueStatement,
    ): ContinueTrampoline | undefined {
        const { loops, target } = this.loopsLeftByLabeledJump(
            context,
            statement,
        );
        if (!ts.isIterationStatement(target, false))
            context.fail(statement, "A labeled continue must name a loop.");
        if (loops.length === 0) return undefined;
        if (
            loops.some((loop) =>
                this.staticIterationCompletions.some(
                    (frame) => frame.iteration === loop,
                ),
            )
        )
            context.fail(
                statement,
                "A labeled continue out of a statically unrolled loop is not lowered.",
            );
        const outermost = loops.at(-1)!;
        return (
            this.continueTrampolines.find(
                (trampoline) => trampoline.loop === outermost,
            ) ??
            context.fail(
                statement,
                "A labeled continue has no trampoline after the loop it leaves.",
            )
        );
    }

    /** Source loops lowered as native C++ loops, innermost last. */
    private readonly nativeLoops = emissionArray<ts.IterationStatement>([]);

    /** Labeled continues of an outer loop, by the inner loop they leave. */
    private readonly continueTrampolines = emissionArray<ContinueTrampoline>(
        [],
    );

    /**
     * Emit a loop that labeled continues of its enclosing loop leave: they
     * jump past it to a `continue` of that loop. Nothing between the two
     * loops may hold its own breakable or cleanup scope.
     */
    private emitWithContinueTrampoline(
        context: StatementLoweringContext,
        loop: ts.IterationStatement,
        emitLoop: () => void,
    ): void {
        let enclosing: ts.IterationStatement | undefined;
        let crossed: ts.Node | undefined;
        for (
            let parent: ts.Node | undefined = loop.parent;
            parent && !ts.isFunctionLike(parent);
            parent = parent.parent
        ) {
            if (ts.isIterationStatement(parent, false)) {
                enclosing = parent;
                break;
            }
            if (ts.isSwitchStatement(parent) || ts.isTryStatement(parent))
                crossed ??= parent;
        }
        const labels = new Set<string>();
        for (
            let parent = enclosing?.parent;
            parent && ts.isLabeledStatement(parent);
            parent = parent.parent
        )
            labels.add(parent.label.text);
        const continues =
            labels.size > 0 &&
            someAnalysisNode(
                loop,
                (node) =>
                    ts.isContinueStatement(node) &&
                    node.label !== undefined &&
                    labels.has(node.label.text),
                { functions: "skip" },
            );
        if (!continues || !enclosing) {
            emitLoop();
            return;
        }
        if (crossed)
            context.fail(
                crossed,
                "A labeled continue cannot leave a switch or try statement.",
            );
        if (
            this.staticIterationCompletions.some(
                (frame) => frame.iteration === enclosing,
            )
        )
            context.fail(
                loop,
                "A labeled continue of a statically unrolled loop is not lowered.",
            );
        const trampoline: ContinueTrampoline = {
            loop,
            label: context.allocateTemporaryCppName("labeled_continue"),
            used: false,
        };
        this.continueTrampolines.push(trampoline);
        try {
            emitLoop();
        } finally {
            this.continueTrampolines.pop();
        }
        if (!trampoline.used) return;
        if (this.nativeLoops.at(-1) !== enclosing)
            context.fail(
                loop,
                "A labeled continue requires its loop to run as a native loop.",
            );
        const skip = context.allocateTemporaryCppName("labeled_continue_skip");
        context.emit({
            kind: "control",
            code: `goto ${skip};`,
            transfer: "goto",
        });
        context.emit(`${trampoline.label}:;`);
        context.emit({
            kind: "control",
            code: "continue;",
            transfer: "continue",
        });
        context.emit(`${skip}:;`);
    }

    private staticIterationCompleted(): boolean {
        return this.staticIterationCompletions.some(
            ({ completion }) => completion !== "normal",
        );
    }

    public terminatesAfterLowering(statement: ts.Statement): boolean {
        return terminatesFlow(statement, (node) =>
            this.loweredTerminators.has(node),
        );
    }

    private emitReachableBody(
        context: StatementLoweringContext,
        statements: readonly ts.Statement[],
    ): boolean {
        return emitReachableStatements(
            {
                emitStatement: (nested) => this.emit(context, nested),
                statementTerminatesAfterLowering: (nested) =>
                    this.terminatesAfterLowering(nested),
            },
            statements,
        );
    }

    public emit(
        context: StatementLoweringContext,
        statement: ts.Statement,
    ): void {
        // A discarded planner or survey wraps statement recovery in a
        // transaction; ordinary generation has neither active. Inside
        // a speculative probe the refusal belongs to the probe. A statement
        // that returns a value feeds it to the call that lowered the body,
        // so its refusal is the caller's statement to record: swallowing it
        // would hand the caller a binding with no value, and every later
        // read of that binding would count as a gap of its own.
        const recovery = activeStorageDemandPlanner() ?? activeSurvey();
        if (
            recovery === undefined ||
            context.speculating ||
            firstReturn([statement], { valued: true })
        ) {
            this.lowerStatement(context, statement);
            return;
        }
        recovery.attemptStatement(context, statement, () =>
            this.lowerStatement(context, statement),
        );
    }

    private lowerStatement(
        context: StatementLoweringContext,
        statement: ts.Statement,
    ): void {
        if (!sourceCoverageActive()) {
            this.lowerStatementCore(context, statement);
            return;
        }
        coverSourceStatement(statement, context.speculating, () =>
            this.lowerStatementCore(context, statement),
        );
    }

    private lowerStatementCore(
        context: StatementLoweringContext,
        statement: ts.Statement,
    ): void {
        context.asyncActivations.requirePendingActivationRealm(statement);
        if (
            ts.canHaveModifiers(statement) &&
            ts
                .getModifiers(statement)
                ?.some(
                    (modifier) =>
                        modifier.kind === ts.SyntaxKind.DeclareKeyword,
                )
        )
            return;
        if (context.handleCollections.isFoldedFlattenLoop(statement)) {
            // The declaration above it already answered with the
            // container's flattened meshes; the loop that filled the list
            // is the other half of that one construct.
            return;
        }
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                context.declarations.emitVariableDeclaration(declaration);
            }
            return;
        }
        if (ts.isExpressionStatement(statement)) {
            if (context.pageLoader?.lowerEntryImport(statement)) return;
            this.loweredTerminators.delete(statement);
            if (
                context.asyncActivations.emitActivationBoundary(statement, () =>
                    this.emitExpression(context, statement.expression),
                )
            ) {
                this.loweredTerminators.add(statement);
            }
            // A call typed never throws: nothing after it runs.
            if (callsNever(context.checker, statement.expression)) {
                this.loweredTerminators.add(statement);
                this.neverTerminators.add(statement);
            }
            return;
        }
        if (ts.isIfStatement(statement)) {
            // A guard over a particle buffer asserts about generation-time
            // state, so it is recorded rather than emitted.
            if (emitParticleAliveGuard(context, statement)) return;
            this.emitIf(context, statement);
            return;
        }
        if (ts.isBlock(statement)) {
            this.emitBlock(context, statement);
            return;
        }
        if (ts.isTryStatement(statement)) {
            this.emitTry(context, statement);
            return;
        }
        if (ts.isIterationStatement(statement, false)) {
            this.emitWithContinueTrampoline(context, statement, () => {
                if (ts.isForStatement(statement))
                    this.emitFor(context, statement);
                else if (ts.isDoStatement(statement))
                    this.emitDo(context, statement);
                else if (ts.isWhileStatement(statement))
                    this.emitWhile(context, statement);
                else if (ts.isForOfStatement(statement))
                    this.emitForOf(context, statement);
                else if (ts.isForInStatement(statement))
                    this.emitForIn(context, statement);
            });
            return;
        }
        if (ts.isSwitchStatement(statement)) {
            this.emitSwitch(context, statement);
            return;
        }
        if (ts.isLabeledStatement(statement)) {
            const target = context.allocateTemporaryCppName(
                `label_${statement.label.text}`,
            );
            const label = { source: statement.label.text, target, used: false };
            this.labels.push(label);
            try {
                this.emit(context, statement.statement);
            } finally {
                this.labels.pop();
            }
            if (label.used) context.emit(`${target}:;`);
            return;
        }
        if (ts.isBreakStatement(statement)) {
            if (this.completeCleanupJump(context, statement)) return;
            if (statement.label) {
                const label = this.labels
                    .slice()
                    .reverse()
                    .find(({ source }) => source === statement.label!.text);
                if (!label) {
                    context.fail(
                        statement,
                        "Labeled break has no active target.",
                    );
                }
                if (this.labeledBreakOfUnrolledLoop(context, statement)) return;
                writable(label).used = true;
                context.emit({
                    kind: "control",
                    code: `goto ${label.target};`,
                    transfer: "goto",
                });
                return;
            }
            const switchEnd = this.switchBreakTarget(statement);
            if (switchEnd) {
                writable(switchEnd).used = true;
                context.emit({
                    kind: "control",
                    code: `goto ${switchEnd.label};`,
                    transfer: "goto",
                });
                return;
            }
            if (this.completeStaticIteration(context, statement)) return;
            context.emit({
                kind: "control",
                code: "break;",
                transfer: "break",
            });
            return;
        }
        if (ts.isContinueStatement(statement)) {
            if (this.completeCleanupJump(context, statement)) return;
            // A labeled continue of the loop it stands in directly is an
            // unlabeled one; from a nested loop it jumps to the trampoline
            // after the outermost loop it leaves.
            const trampoline = statement.label
                ? this.labeledContinueTrampoline(context, statement)
                : undefined;
            if (trampoline) {
                writable(trampoline).used = true;
                context.emit({
                    kind: "control",
                    code: `goto ${trampoline.label};`,
                    transfer: "goto",
                });
                return;
            }
            if (this.completeStaticIteration(context, statement)) return;
            context.emit({
                kind: "control",
                code: "continue;",
                transfer: "continue",
            });
            return;
        }
        if (
            ts.isReturnStatement(statement) &&
            !statement.expression &&
            context.activeInlineWrapper()
        ) {
            // Early bare return of an inlined function: leave the
            // breakable wrapper emitted around the inline body.
            context.emit({
                kind: "control",
                code: "break;",
                transfer: "break",
            });
            return;
        }
        if (
            ts.isReturnStatement(statement) &&
            returnsNever(context.checker, statement)
        ) {
            // The returned expression throws; no value reaches the caller. A
            // native function still needs a path that leaves it, unless the
            // lowered expression already ends in one.
            const lowered = context.captureEmittedStatements(() =>
                this.emitExpression(context, statement.expression!),
            );
            context.emitCapturedStatements(lowered);
            const last = lowered.at(-1);
            if (
                context.activeNativeReturnType() !== undefined &&
                !(
                    last &&
                    (last.statement.kind === "control" ||
                        /^(?:throw |std::rethrow_exception\()/.test(
                            nativeStatementCode(last.statement),
                        ))
                )
            )
                context.emit({
                    kind: "control",
                    code: 'throw std::runtime_error("A never-returning call returned.");',
                    transfer: "throw",
                });
            return;
        }
        if (
            ts.isReturnStatement(statement) &&
            context.activeNativeReturnType() !== undefined
        ) {
            context.emitNativeReturn(statement);
            return;
        }
        if (ts.isReturnStatement(statement) && !statement.expression) {
            // A bare `return` at the very end of a body is the statement
            // it would have emitted anyway, so it drops. Anywhere else it
            // is control flow -- an early exit guarding what follows --
            // and dropping it keeps the guarded statements while removing
            // the guard. That reads as a working scene and is not one:
            // a `if (x === null) { return; }` ahead of a narrowed `*x`
            // becomes an empty `if` and an unguarded dereference.
            if (!isTrailingStatement(statement)) {
                context.fail(
                    statement,
                    "An early `return` is not lowered: the statements " +
                        "after it would still run. Write the remainder " +
                        "under an `else`, or invert the condition.",
                );
            }
            return;
        }
        if (ts.isThrowStatement(statement)) {
            this.emitThrow(context, statement);
            return;
        }
        if (ts.isEmptyStatement(statement)) {
            return;
        }
        if (
            ts.isTypeAliasDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement)
        ) {
            return;
        }
        if (ts.isFunctionDeclaration(statement)) {
            // Nested function declarations lower lazily at their call
            // sites (native data functions or the inline path).
            return;
        }
        if (ts.isClassDeclaration(statement)) {
            // Classes lower lazily too: construction expands the
            // fields and each method inlines at its call site. What the
            // declaration itself runs -- static fields and blocks -- runs
            // here.
            context.classLowerer.emitDeclaration(statement);
            return;
        }
        context.fail(
            statement,
            `Unsupported statement: ${syntaxKindName(statement.kind)}.`,
        );
    }

    /**
     * True when the statement contains a break/continue that would bind to
     * the enclosing loop (not to a nested loop, and for break, not to a
     * nested switch). Such loops cannot be statically unrolled.
     */
    private bindsEnclosingLoop(statement: ts.Statement): boolean {
        return enclosingLoopControl(statement) !== undefined;
    }

    private hasStaticLoopExits(
        context: StatementLoweringContext,
        body: ts.Statement,
        bindings: ReadonlySet<ts.Symbol>,
    ): boolean {
        const constant = (
            expression: ts.Expression,
            seen = new EmissionSet<ts.Symbol>(),
        ): boolean => {
            const node = context.unwrap(expression);
            if (ts.isIdentifier(node)) {
                const symbol = context.symbols.valueSymbol(node);
                if (!symbol || seen.has(symbol)) return false;
                if (bindings.has(symbol)) return true;
                const value = context.bindings.lookupOptional(node);
                if (value?.parameterBinding) return false;
                if (
                    value?.staticNumber !== undefined ||
                    value?.staticString !== undefined ||
                    value?.staticBoolean !== undefined
                )
                    return true;
                const resolved = context.resolveStaticExpression(node);
                return (
                    resolved !== node &&
                    constant(resolved, new EmissionSet([...seen, symbol]))
                );
            }
            if (
                ts.isLiteralExpression(node) ||
                node.kind === ts.SyntaxKind.TrueKeyword ||
                node.kind === ts.SyntaxKind.FalseKeyword ||
                node.kind === ts.SyntaxKind.NullKeyword
            )
                return true;
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind < ts.SyntaxKind.FirstAssignment
            ) {
                return constant(node.left, seen) && constant(node.right, seen);
            }
            return (
                ts.isPrefixUnaryExpression(node) &&
                !isUpdateExpression(node) &&
                constant(node.operand, seen)
            );
        };
        return !someAnalysisNode(
            body,
            (node) => {
                if (
                    (ts.isBreakStatement(node) ||
                        ts.isContinueStatement(node)) &&
                    node.label
                )
                    return true;
                if (
                    ts.isIfStatement(node) &&
                    (this.bindsEnclosingLoop(node.thenStatement) ||
                        (node.elseStatement &&
                            this.bindsEnclosingLoop(node.elseStatement))) &&
                    !constant(node.expression)
                )
                    return true;
                return ts.isSwitchStatement(node);
            },
            { functions: "skip", loops: "skip" },
        );
    }

    /** Whether the enclosing-loop control includes a break, not only continue. */
    private breaksEnclosingLoop(statement: ts.Statement): boolean {
        return (
            enclosingLoopControl(statement, { continues: false }) !== undefined
        );
    }

    private emitSwitch(
        context: StatementLoweringContext,
        statement: ts.SwitchStatement,
    ): void {
        const discriminant = context.allocateTemporaryCppName("switch");
        const value = context.compileValue(statement.expression);
        const clauses = statement.caseBlock.clauses;
        const nullishLabel = clauses.find(
            (clause) =>
                ts.isCaseClause(clause) &&
                isNullishLiteral(context.checker, clause.expression),
        );
        // A case label matches before the default wherever it stands;
        // labels evaluate in order until one matches. A generation-known
        // absent value matches only the label of its own absence, which its
        // declared type must name.
        const staticString = value.staticString;
        const absentLabelMatches = (
            clause: ts.CaseOrDefaultClause,
        ): boolean => {
            if (
                !ts.isCaseClause(clause) ||
                !isNullishLiteral(context.checker, clause.expression)
            )
                return false;
            const absence = absenceKind(
                context.checker,
                value,
                statement.expression,
            );
            if (absence === "either" || typeof absence === "object")
                context.fail(
                    clause,
                    "A null or undefined case label requires a discriminant that holds null and undefined apart.",
                );
            return (
                (context.unwrap(clause.expression).kind ===
                    ts.SyntaxKind.NullKeyword) ===
                (absence === "null")
            );
        };
        const staticSelection =
            staticString !== undefined
                ? clauses.findIndex(
                      (clause) =>
                          ts.isCaseClause(clause) &&
                          !isNullishLiteral(
                              context.checker,
                              clause.expression,
                          ) &&
                          this.compileStaticSwitchString(
                              context,
                              clause.expression,
                          ) === context.cppString(staticString),
                  )
                : value.kind === "json-null"
                  ? clauses.findIndex(absentLabelMatches)
                  : undefined;
        if (staticSelection !== undefined) {
            const selected =
                staticSelection === -1
                    ? clauses.findIndex(ts.isDefaultClause)
                    : staticSelection;
            // Empty labels fall through to the next body. Only the reached
            // bodies participate in feature selection and specialization.
            const run =
                selected === -1 ? [] : switchFallthroughRun(clauses, selected);
            if (run.length === 1) {
                context.emit({ kind: "open", code: "{" });
                this.emitSwitchBody(context, run[0]!);
                context.emit({ kind: "close", code: "}" });
            } else if (run.length > 1) {
                this.withSwitchBreakTarget(context, statement, () => {
                    context.emit({ kind: "open", code: "{" });
                    this.emitScopedStatements(
                        context,
                        run.flatMap((clause) => [...clause.statements]),
                    );
                    context.emit({ kind: "close", code: "}" });
                });
            }
            return;
        }
        // A maybe-absent discriminant never equals a present label: absent,
        // it takes the default clause. A document compares strictly with
        // each label, null and undefined included.
        const optional =
            value.kind === "data" &&
            value.dataType?.kind === "optional" &&
            value.optionalFoundCpp === undefined &&
            ["string", "enum", "number"].includes(value.dataType.inner.kind)
                ? value.dataType.inner
                : undefined;
        const document = isJsonValue(value);
        const stringSwitch =
            isStringValue(value) || optional?.kind === "string";
        const enumType =
            optional?.kind === "enum"
                ? optional
                : value.kind === "data" && value.dataType?.kind === "enum"
                  ? value.dataType
                  : undefined;
        if (
            !document &&
            !stringSwitch &&
            !enumType &&
            optional?.kind !== "number" &&
            value.kind !== "number" &&
            !(value.kind === "data" && value.dataType?.kind === "number")
        ) {
            context.fail(
                statement.expression,
                `Switch discriminants must be numbers or strings, received ${value.kind}.`,
            );
        }
        // Which absence an optional discriminant's empty storage stands for.
        const absence = optional
            ? absenceKind(context.checker, value, statement.expression)
            : undefined;
        if (
            nullishLabel &&
            !document &&
            (absence === undefined ||
                absence === "either" ||
                typeof absence === "object")
        )
            context.fail(
                nullishLabel,
                "A null or undefined case label requires a discriminant that holds null and undefined apart.",
            );
        context.emit({ kind: "open", code: "{" });
        context.increaseIndent();
        const storage = `${discriminant}_storage`;
        if (stringSwitch || optional || document) {
            // The view must not outlive its characters: a discriminant such
            // as `prefix + "x"` is a temporary, so its storage is bound first.
            context.emit({
                kind: "declaration",
                type: "const auto&",
                name: storage,
                initializer: value.cpp,
            });
        }
        if (stringSwitch && !optional) {
            context.emit({
                kind: "declaration",
                type: "const std::string_view",
                name: discriminant,
                initializer: storage,
            });
        } else if (!stringSwitch && !optional && !document) {
            context.emit(
                enumType
                    ? `const auto ${discriminant} = ${value.cpp};`
                    : `const double ${discriminant} = ${value.cpp};`,
            );
        }
        // The test that one clause's label matches, or undefined for a
        // label this invocation cannot hold.
        const labelTest = (clause: ts.CaseClause): string | undefined => {
            if (document) {
                return (
                    context.dataLowerer.jsonStrictEquality(
                        storage,
                        clause.expression,
                    ) ??
                    context.fail(
                        clause.expression,
                        "A switch over a document requires scalar or nullish case labels.",
                    )
                );
            }
            if (
                optional &&
                isNullishLiteral(context.checker, clause.expression)
            )
                // Empty storage is one absence; the other label never matches.
                return (context.unwrap(clause.expression).kind ===
                    ts.SyntaxKind.NullKeyword) ===
                    (absence === "null")
                    ? `!${optionalPresentCpp(storage)}`
                    : undefined;
            const label = stringSwitch
                ? this.compileStaticSwitchString(context, clause.expression)
                : enumType
                  ? context.compileEnumSwitchLabel(clause.expression, enumType)
                  : context.compileNumber(clause.expression, "double");
            if (label === undefined) return undefined;
            if (!optional) return `${discriminant} == ${label}`;
            return `(${optionalPresentCpp(storage)} && ${optionalValueCpp(storage)} == ${label})`;
        };
        const defaultIndex = clauses.findIndex(ts.isDefaultClause);
        if (
            (defaultIndex !== -1 && defaultIndex !== clauses.length - 1) ||
            clauses.some(
                (clause, index) =>
                    index < clauses.length - 1 &&
                    clause.statements.length > 0 &&
                    !switchClauseCompletes(clause),
            )
        ) {
            this.emitFallthroughSwitch(
                context,
                statement,
                discriminant,
                labelTest,
            );
            context.decreaseIndent();
            context.emit({ kind: "close", code: "}" });
            return;
        }
        let emittedBranch = false;
        let pendingTests: string[] = [];
        for (const clause of clauses) {
            if (ts.isDefaultClause(clause)) {
                // Empty cases immediately before the final default share
                // its body. The emitted final `else` already selects every
                // value not handled above, including those pending labels.
                pendingTests = [];
                context.emit(emittedBranch ? "} else {" : "{");
                this.inRuntimeControlFlow(context, () =>
                    this.emitSwitchBody(context, clause),
                );
                emittedBranch = true;
                continue;
            }
            const test = labelTest(clause);
            // An inlined function may receive a narrower string-literal
            // union than its declared parameter. Labels outside that union
            // are unreachable for this invocation.
            if (test === undefined) {
                continue;
            }
            pendingTests.push(test);
            if (clause.statements.length === 0) {
                continue;
            }
            context.emit(
                `${emittedBranch ? "} else if" : "if"} (${pendingTests.join(" || ")}) {`,
            );
            this.inRuntimeControlFlow(context, () =>
                this.emitSwitchBody(context, clause),
            );
            emittedBranch = true;
            pendingTests = [];
        }
        // Trailing labels without a body select nothing to run.
        if (emittedBranch) {
            context.emit({ kind: "close", code: "}" });
        }
        context.decreaseIndent();
        context.emit({ kind: "close", code: "}" });
    }

    private compileStaticSwitchString(
        context: StatementLoweringContext,
        expression: ts.Expression,
    ): string {
        const value = context.compileValue(expression);
        if (value.kind !== "string" || value.staticString === undefined) {
            context.fail(
                expression,
                "String switch case labels must be compile-time strings.",
            );
        }
        return context.cppString(value.staticString);
    }

    private emitSwitchBody(
        context: StatementLoweringContext,
        clause: ts.CaseClause | ts.DefaultClause,
    ): void {
        // The callers hand one clause that completes (or is the last, which
        // completes the switch by finishing); fallthrough is lowered apart.
        const statements = [...clause.statements];
        let last = statements.at(-1);
        // A braced case body (`case x: { ... break; }`) gives its locals a
        // lexical scope but the break still belongs to the switch. Each
        // lowered branch already owns a scope, so flatten that final block
        // before applying the same terminal-break rule.
        if (last && ts.isBlock(last)) {
            const blockLast = last.statements.at(-1);
            if (blockLast && ts.isBreakStatement(blockLast)) {
                statements.pop();
                statements.push(...last.statements.slice(0, -1));
                last = statements.at(-1);
            }
        }
        if (last && ts.isBreakStatement(last)) statements.pop();
        const nestedBreak = statements
            .map((statement) => this.findSwitchBoundBreak(statement))
            .find((candidate) => candidate !== undefined);
        if (nestedBreak) {
            const nestedContinue = statements
                .map((statement) => this.findSwitchBoundContinue(statement))
                .find((candidate) => candidate !== undefined);
            if (nestedContinue) {
                context.fail(
                    nestedContinue,
                    "A switch case with an early break cannot also continue an enclosing loop.",
                );
            }
        }
        context.increaseIndent();
        context.bindings.pushScope(context.allocateBlockPrefix());
        try {
            if (nestedBreak) {
                // The switch itself was lowered to an if/else chain. A
                // single-iteration scope restores the one missing control
                // boundary so an early case `break` still skips the rest of
                // that case without escaping an enclosing loop.
                context.emit({ kind: "open", code: "do {", breaks: true });
                context.increaseIndent();
            }
            for (const statement of statements) {
                this.emit(context, statement);
            }
            if (nestedBreak) {
                context.decreaseIndent();
                context.emit({ kind: "close", code: "} while (false);" });
            }
        } finally {
            context.bindings.popScope();
            context.decreaseIndent();
        }
    }

    /**
     * A switch whose clauses fall into one another, or whose default is not
     * last: the matching clause's index is selected first (case labels in
     * order, then the default), and every body from it onward runs in
     * source order until a break jumps to the switch's end.
     */
    private emitFallthroughSwitch(
        context: StatementLoweringContext,
        statement: ts.SwitchStatement,
        discriminant: string,
        labelTest: (clause: ts.CaseClause) => string | undefined,
    ): void {
        const clauses = statement.caseBlock.clauses;
        const defaultIndex = clauses.findIndex(ts.isDefaultClause);
        const tests: Array<{ condition: string; index: number }> = [];
        clauses.forEach((clause, index) => {
            if (!ts.isCaseClause(clause)) return;
            const condition = labelTest(clause);
            if (condition !== undefined) tests.push({ condition, index });
        });
        const selected = `${discriminant}_selected`;
        context.emit({
            kind: "declaration",
            type: "const int",
            name: selected,
            initializer: tests.reduceRight(
                (rest, { condition, index }) =>
                    `(${condition}) ? ${index} : ${rest}`,
                String(defaultIndex === -1 ? clauses.length : defaultIndex),
            ),
        });
        this.withSwitchBreakTarget(context, statement, () => {
            clauses.forEach((clause, index) => {
                if (clause.statements.length === 0) return;
                context.emit({
                    kind: "open",
                    code: `if (${selected} <= ${index}) {`,
                });
                this.inRuntimeControlFlow(context, () =>
                    this.emitScopedStatements(context, clause.statements),
                );
                context.emit({ kind: "close", code: "}" });
            });
        });
    }

    /** Unlabeled breaks of the switches lowered with an end label. */
    private readonly switchBreakTargets = emissionArray<{
        readonly statement: ts.SwitchStatement;
        readonly label: string;
        readonly used: boolean;
    }>([]);

    /** Emit a switch body whose breaks jump to a label after it. */
    private withSwitchBreakTarget(
        context: StatementLoweringContext,
        statement: ts.SwitchStatement,
        emitBody: () => void,
    ): void {
        const target = {
            statement,
            label: context.allocateTemporaryCppName("switch_end"),
            used: false,
        };
        this.switchBreakTargets.push(target);
        try {
            emitBody();
        } finally {
            this.switchBreakTargets.pop();
        }
        if (target.used) context.emit(`${target.label}:;`);
    }

    /** The end label an unlabeled break of a fallthrough switch jumps to. */
    private switchBreakTarget(
        statement: ts.BreakStatement,
    ): (typeof this.switchBreakTargets)[number] | undefined {
        for (
            let parent: ts.Node | undefined = statement.parent;
            parent;
            parent = parent.parent
        ) {
            if (
                ts.isFunctionLike(parent) ||
                ts.isIterationStatement(parent, false)
            )
                return undefined;
            if (ts.isSwitchStatement(parent))
                return this.switchBreakTargets.find(
                    (target) => target.statement === parent,
                );
        }
        return undefined;
    }

    /** One scope holding statements, emitted until one leaves it. */
    private emitScopedStatements(
        context: StatementLoweringContext,
        statements: readonly ts.Statement[],
    ): void {
        context.increaseIndent();
        context.bindings.pushScope(context.allocateBlockPrefix());
        try {
            this.emitReachableBody(context, statements);
        } finally {
            context.bindings.popScope();
            context.decreaseIndent();
        }
    }

    /**
     * Finds a break that would bind to this switch (not to a nested loop or
     * nested switch). The if/else lowering cannot express those.
     */
    private findSwitchBoundBreak(statement: ts.Statement): ts.Node | undefined {
        // An unqualified break under a nested switch binds to that switch,
        // which the shared walk expresses by not counting it there.
        return enclosingLoopControl(statement, {
            continues: false,
            labeled: false,
        });
    }

    /** A continue that crosses the switch and binds to an enclosing loop. */
    private findSwitchBoundContinue(
        statement: ts.Statement,
    ): ts.Node | undefined {
        return enclosingLoopControl(statement, {
            breaks: false,
            labeled: false,
        });
    }

    private emitIf(
        context: StatementLoweringContext,
        statement: ts.IfStatement,
    ): void {
        // Static loop unrolling lowers this same source node once per
        // element. Whether a folded branch terminates is therefore an
        // iteration-local result: a `continue` taken by one element must
        // not make a later element skip the statement following the `if`.
        this.loweredTerminators.delete(statement);
        const guard = context.unwrap(statement.expression);
        const identityRead = (expression: ts.Expression): boolean => {
            const value = context.unwrap(expression);
            return (
                context.libraryGlobal(value) !== undefined ||
                (ts.isIdentifier(value) &&
                    context.bindings.lookupOptional(value) !== undefined)
            );
        };
        const pureIdentity =
            ts.isBinaryExpression(guard) &&
            (guard.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken ||
                guard.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
            identityRead(guard.left) &&
            identityRead(guard.right);
        if (
            (pureIdentity ||
                context.browserErasure.isBrowserOnlyExpression(
                    statement.expression,
                )) &&
            this.statementIsBrowserOnly(context, statement.thenStatement) &&
            (!statement.elseStatement ||
                this.statementIsBrowserOnly(context, statement.elseStatement))
        ) {
            // A DOM guard whose every branch is itself browser-only has no
            // native observable effect. This covers optional UI setup while
            // leaving mixed browser/native conditions to the established
            // condition lowerer and its pinned static deductions.
            return;
        }
        const condition = context.conditions.compileCondition(
            statement.expression,
        );
        // A condition the compiler already settled leaves only the branch it
        // takes. The corpus guards a value this port folded — `!system` over
        // a particle system the bake resolved — and emitting
        // `if ((!(true) || !(true)))` would compile a body generation has
        // proved unreachable, dragging its own machinery in with it.
        if (condition === "true" || condition === "false") {
            const selected =
                condition === "true"
                    ? statement.thenStatement
                    : statement.elseStatement;
            if (condition === "true") {
                this.emitScopedBody(context, statement.thenStatement, true);
            } else if (statement.elseStatement) {
                this.emitScopedBody(context, statement.elseStatement, true);
            }
            if (
                selected &&
                terminatesFlow(selected, (node) =>
                    this.neverTerminators.has(node),
                )
            ) {
                this.loweredTerminators.add(statement);
            }
            return;
        }
        if (this.staticIterationCompletions.length > 0) {
            if (
                firstReturn([statement.thenStatement]) ||
                (statement.elseStatement &&
                    firstReturn([statement.elseStatement]))
            ) {
                context.trackResourceLoopEarlyReturn(statement.expression);
            }
        }
        context.emit({ kind: "open", code: `if (${condition}) {` });
        // Alias invalidation is path-sensitive: a branch that always
        // leaves the iteration cannot invalidate anything for the code
        // that follows the `if`, so its effects are rolled back.
        const emitBranch = (branch: ts.Statement): void => {
            const emit = (): void =>
                this.inRuntimeControlFlow(context, () =>
                    this.emitScopedBody(context, branch),
                );
            if (terminatesFlow(branch))
                context.dataLowerer.withPreservedAliasState(emit);
            else emit();
        };
        emitBranch(statement.thenStatement);
        if (statement.elseStatement) {
            context.emit({ kind: "branch", code: "} else {" });
            emitBranch(statement.elseStatement);
        }
        context.emit({ kind: "close", code: "}" });
    }

    private statementIsBrowserOnly(
        context: StatementLoweringContext,
        statement: ts.Statement,
    ): boolean {
        if (ts.isBlock(statement)) {
            return statement.statements.every((child) =>
                this.statementIsBrowserOnly(context, child),
            );
        }
        if (!ts.isExpressionStatement(statement)) return false;
        const expression = context.unwrap(statement.expression);
        const effect = ts.isVoidExpression(expression)
            ? context.unwrap(expression.expression)
            : expression;
        if (
            ts.isCallExpression(effect) &&
            effect.arguments.length === 0 &&
            context.browserErasure.isBrowserOnlyExpression(effect)
        ) {
            // Pointer-lock and similar zero-argument DOM effects are often
            // written behind their own browser-only state guard, sometimes
            // with `void` to discard the promise. The native input bridge has
            // no browser object on which that effect could be observed.
            return true;
        }
        if (
            ts.isCallExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            context.browserErasure.isBrowserOnlyExpression(expression)
        ) {
            return true;
        }

        // UI helpers commonly retain native state while guarding writes to
        // an optional DOM element. Erase those guarded writes only when the
        // receiver is a local already classified as a browser handle and all
        // values being written are side-effect-free. This deliberately does
        // not generalize to browser globals such as console/document: their
        // unresolved guards remain refusals rather than silently swallowing
        // arbitrary calls nested in an argument.
        const browserLocal = (candidate: ts.Expression): boolean => {
            const value = context.unwrap(candidate);
            if (ts.isIdentifier(value)) {
                const bound = context.bindings.lookupOptional(value);
                return (
                    bound?.kind === "browser" &&
                    bound.browserValue?.kind !== "search-params"
                );
            }
            return (
                (ts.isPropertyAccessExpression(value) ||
                    ts.isElementAccessExpression(value)) &&
                browserLocal(value.expression)
            );
        };
        const pure = (candidate: ts.Expression): boolean => {
            const value = context.unwrap(candidate);
            if (
                ts.isIdentifier(value) ||
                ts.isLiteralExpression(value) ||
                value.kind === ts.SyntaxKind.TrueKeyword ||
                value.kind === ts.SyntaxKind.FalseKeyword ||
                value.kind === ts.SyntaxKind.NullKeyword ||
                value.kind === ts.SyntaxKind.ThisKeyword
            ) {
                return true;
            }
            if (ts.isPrefixUnaryExpression(value)) {
                return pure(value.operand);
            }
            if (ts.isBinaryExpression(value)) {
                return (
                    !ASSIGNMENT_OPERATORS.has(value.operatorToken.kind) &&
                    pure(value.left) &&
                    pure(value.right)
                );
            }
            if (ts.isConditionalExpression(value)) {
                return (
                    pure(value.condition) &&
                    pure(value.whenTrue) &&
                    pure(value.whenFalse)
                );
            }
            if (ts.isTemplateExpression(value)) {
                return value.templateSpans.every((span) =>
                    pure(span.expression),
                );
            }
            if (
                ts.isPropertyAccessExpression(value) ||
                ts.isElementAccessExpression(value)
            ) {
                return (
                    pure(value.expression) &&
                    (!ts.isElementAccessExpression(value) ||
                        !value.argumentExpression ||
                        pure(value.argumentExpression))
                );
            }
            return (
                ts.isCallExpression(value) &&
                ["Boolean", "Number", "String"].includes(
                    context.libraryGlobal(value.expression) ?? "",
                ) &&
                value.arguments.every(pure)
            );
        };
        if (
            ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            (browserLocal(expression.left) ||
                context.libraryGlobal(expression.left) === "fetch" ||
                (ts.isPropertyAccessExpression(expression.left) &&
                    context.browserErasure.isBrowserOnlyExpression(
                        expression.left.expression,
                    ))) &&
            pure(expression.right)
        ) {
            return true;
        }
        if (
            ts.isCallExpression(expression) &&
            ts.isPropertyAccessExpression(expression.expression) &&
            browserLocal(expression.expression.expression) &&
            expression.expression.name.text === "addEventListener" &&
            expression.arguments.length >= 2 &&
            pure(argumentAt(expression, 0)) &&
            (ts.isArrowFunction(argumentAt(expression, 1)) ||
                ts.isFunctionExpression(argumentAt(expression, 1))) &&
            expression.arguments.slice(2).every(pure)
        ) {
            // The callback is reachable only through the browser handle that
            // owns this registration. Native has no such event source, so
            // mutations captured by the callback are unreachable too. Do not
            // require the callback body itself to be browser-only: UI handlers
            // often toggle native state that remains at its initialized value
            // when the control does not exist.
            return true;
        }
        return (
            ts.isCallExpression(expression) &&
            (ts.isPropertyAccessExpression(expression.expression) ||
                ts.isElementAccessExpression(expression.expression)) &&
            browserLocal(expression.expression.expression) &&
            expression.arguments.every(pure)
        );
    }

    /**
     * Native work may throw at runtime (for example, a platform service that
     * cannot initialize), so a binding-free JavaScript catch maps directly
     * to C++ `catch (...)`, as does a binding the block only reports. A read
     * binding catches `std::exception` and is the caught Error value.
     *
     * The body exception is retained before cleanup runs so a cleanup throw
     * can replace it without throwing during C++ stack unwinding.
     */
    private emitTry(
        context: StatementLoweringContext,
        statement: ts.TryStatement,
    ): void {
        const finallyBlock = statement.finallyBlock;
        if (!finallyBlock) {
            this.emitTryBody(context, statement);
            return;
        }
        if (
            context.asyncActivations.workerCheckpointCpp() &&
            someAnalysisNode(
                finallyBlock,
                (node) =>
                    ts.isAwaitExpression(node) ||
                    ts.isReturnStatement(node) ||
                    ts.isBreakStatement(node) ||
                    ts.isContinueStatement(node),
                {
                    functions: "skip",
                },
            )
        )
            return this.emitSuspendingFinally(context, statement);
        // Lower in source order so generation-only bindings and cleanup see
        // the try body's effects. Native cleanup still precedes the captured
        // body as a scope guard, covering early returns and exceptions.
        const beforeBody = context.nativeBindingCheckpoint();
        const body = context.captureEmittedLines(() =>
            this.emitTryBody(context, statement),
        );
        const abruptBody =
            context.activeNativeReturnType() !== undefined &&
            !this.staticIterationCompleted() &&
            this.terminatesAfterLowering(statement.tryBlock) &&
            (!statement.catchClause ||
                this.terminatesAfterLowering(statement.catchClause.block));
        const captureFinally = () =>
            this.captureFinallyGuard(context, finallyBlock, beforeBody);
        if (
            context.engineLifecycle.emitEngineFinally(
                body,
                captureFinally,
                statement,
            )
        )
            return;
        const capturedFinally = captureFinally();
        const finallyGuard = capturedFinally.length
            ? capturedFinally
            : undefined;
        if (finallyGuard) {
            context.emit({ kind: "open", code: "{" });
            context.increaseIndent();
            const guard =
                context.engineLifecycle.emitFinallyGuard(finallyGuard);
            const pending =
                context.allocateTemporaryCppName("finally_exception");
            context.emit(`std::exception_ptr ${pending};`);
            context.emit({ kind: "open", code: "try {" });
            context.increaseIndent();
            for (const line of body) context.emit(line);
            context.decreaseIndent();
            context.emit(
                `} catch (...) { ${pending} = std::current_exception(); }`,
            );
            context.emit({ kind: "expression", code: `${guard}.run();` });
            // A source body that cannot complete normally reaches this
            // boundary only through the catch above. Preserve that fact for
            // C++ return analysis, including non-void coroutine bodies.
            context.emit({
                kind: "expression",
                code: `${abruptBody ? "" : `if (${pending}) `}std::rethrow_exception(${pending});`,
            });
            context.decreaseIndent();
            context.emit({ kind: "close", code: "}" });
        } else for (const line of body) context.emit(line);
    }

    private emitSuspendingFinally(
        context: StatementLoweringContext,
        statement: ts.TryStatement,
    ): void {
        this.emitSuspendingCleanup(
            context,
            statement,
            () => this.emitTryBody(context, statement),
            () => this.emitBlock(context, statement.finallyBlock!),
        );
    }

    private emitSuspendingCleanup(
        context: StatementLoweringContext,
        statement: ts.Node,
        emitBody: () => void,
        emitCleanup: (pending: string) => void,
    ): void {
        const region = {
            node: statement,
            returns: false,
            jumps: new EmissionSet<ts.BreakStatement | ts.ContinueStatement>(),
        };
        const pending = context.allocateTemporaryCppName("cleanup_exception");
        this.cleanupRegions.push(region);
        let body: string[];
        try {
            body = context.captureEmittedLines(() => {
                context.emit(`std::exception_ptr ${pending};`);
                context.emit({ kind: "open", code: "try {" });
                context.increaseIndent();
                emitBody();
                context.decreaseIndent();
                context.emit(
                    `} ${context.options.workers ? "catch (const bbl::pal::WorkerTerminated&) { throw; } " : ""}catch (...) { ${pending} = std::current_exception(); }`,
                );
                emitCleanup(pending);
                context.emit(
                    `if (${pending}) std::rethrow_exception(${pending});`,
                );
            });
        } finally {
            this.cleanupRegions.pop();
        }
        context.emit({
            kind: "open",
            code: region.returns || region.jumps.size ? "try {" : "{",
        });
        context.increaseIndent();
        for (const line of body) context.emit(line);
        context.decreaseIndent();
        if (region.returns) {
            const type = context.activeNativeReturnType();
            const generator = context.activeGeneratorType();
            if (type === undefined && !generator)
                context.fail(
                    statement,
                    "Suspending cleanup requires a native completion type.",
                );
            const cpp =
                type === "void" || type === undefined
                    ? "bbl::js::PromiseVoid"
                    : context.dataTypes.cppType(type);
            const result = context.allocateTemporaryCppName("cleanup_return");
            context.emit(
                generator
                    ? "} catch (const bbl::js::GeneratorClose&) {"
                    : `} catch ([[maybe_unused]] const bbl::js::AsyncReturn<${cpp}>& ${result}) {`,
            );
            context.increaseIndent();
            const parent = this.cleanupRegions.at(-1);
            if (
                parent &&
                ts.findAncestor(parent.node, ts.isFunctionLike) ===
                    ts.findAncestor(statement, ts.isFunctionLike)
            ) {
                writable(parent).returns = true;
                context.emit("throw;");
            } else
                context.emit(generator ? "co_return;" : `co_return ${result};`);
            context.decreaseIndent();
        }
        if (region.jumps.size) {
            const jump = context.allocateTemporaryCppName("cleanup_jump");
            context.emit(`} catch (const bbl::js::LoopCompletion& ${jump}) {`);
            context.increaseIndent();
            for (const source of region.jumps) {
                context.emit({
                    kind: "open",
                    code: `if (${jump}.target == ${source.pos + 1}u) {`,
                });
                context.increaseIndent();
                this.lowerStatement(context, source);
                context.decreaseIndent();
                context.emit({ kind: "close", code: "}" });
            }
            context.emit("throw;");
            context.decreaseIndent();
        }
        context.emit({ kind: "close", code: "}" });
    }

    private emitTryBody(
        context: StatementLoweringContext,
        statement: ts.TryStatement,
    ): void {
        if (statement.catchClause) {
            const catchDeclaration = statement.catchClause.variableDeclaration;
            const erasedCatchBinding =
                catchDeclaration !== undefined &&
                ts.isIdentifier(catchDeclaration.name) &&
                this.catchBindingIsErased(
                    context,
                    catchDeclaration.name,
                    statement.catchClause.block,
                );
            if (
                catchDeclaration &&
                !erasedCatchBinding &&
                !ts.isIdentifier(catchDeclaration.name)
            ) {
                context.fail(
                    catchDeclaration,
                    "Native catch bindings require an identifier.",
                );
            }
            const suspendedCatch =
                context.asyncActivations.workerCheckpointCpp() &&
                someAnalysisNode(
                    statement.catchClause.block,
                    ts.isAwaitExpression,
                    { functions: "skip" },
                )
                    ? context.allocateTemporaryCppName("pending_exception")
                    : undefined;
            const protectedBody = context.captureEmittedStatements(() => {
                context.bindings.pushScope(context.allocateBlockPrefix());
                try {
                    for (const child of statement.tryBlock.statements) {
                        this.emit(context, child);
                        if (
                            this.terminatesAfterLowering(child) ||
                            this.staticIterationCompleted()
                        )
                            break;
                    }
                } finally {
                    context.bindings.popScope();
                }
            });
            // A protected block that lowers to nothing cannot throw, so its
            // handler is unreachable.
            if (protectedBody.length === 0) return;
            if (suspendedCatch)
                context.emit(`std::exception_ptr ${suspendedCatch};`);
            context.emit({ kind: "open", code: "try {" });
            context.increaseIndent();
            context.emitCapturedStatements(protectedBody);
            context.decreaseIndent();
            const catchCpp =
                catchDeclaration && !erasedCatchBinding
                    ? context.allocateTemporaryCppName("caught_error")
                    : undefined;
            context.emit("} catch (const bbl::js::AbruptCompletion&) { throw;");
            if (context.asyncActivations.workerCheckpointCpp())
                context.emit(
                    "} catch (const bbl::pal::WorkerTerminated&) { throw;",
                );
            else if (context.options.pendingActivations && !catchCpp)
                context.emit(
                    "} catch (const bbl::js::PendingActivation&) { throw;",
                );
            context.emit(
                suspendedCatch
                    ? `} catch (...) { ${suspendedCatch} = std::current_exception(); }\nif (${suspendedCatch}) {`
                    : catchCpp
                      ? `} catch (const std::exception& ${catchCpp}) {`
                      : "} catch (...) {",
            );
            context.increaseIndent();
            context.bindings.pushScope(context.allocateBlockPrefix());
            try {
                if (
                    catchCpp &&
                    catchDeclaration &&
                    ts.isIdentifier(catchDeclaration.name)
                ) {
                    context.bindings.bindLocalValue(
                        catchDeclaration.name,
                        suspendedCatch
                            ? errorValue(
                                  {
                                      kind: "data",
                                      dataType: { kind: "string" },
                                      cpp: `bbl::js::promise_error_message(${suspendedCatch})`,
                                  },
                                  "Error",
                                  context.cppString,
                                  {
                                      kind: "data",
                                      cpp: `bbl::js::Error(${suspendedCatch})`,
                                      dataType: { kind: "error" },
                                  },
                              )
                            : caughtErrorValue(context, catchCpp),
                    );
                }
                const handlerBody = context.captureEmittedStatements(() => {
                    for (const child of statement.catchClause!.block
                        .statements) {
                        this.emit(context, child);
                        if (
                            this.terminatesAfterLowering(child) ||
                            this.staticIterationCompleted()
                        )
                            break;
                    }
                });
                context.emitCapturedStatements(handlerBody);
                // A source handler that ignores its exception says so.
                if (handlerBody.length === 0 && !suspendedCatch)
                    context.emit({
                        kind: "expression",
                        code: "bbl::discard_exception();",
                    });
            } finally {
                context.bindings.popScope();
                context.decreaseIndent();
            }
            context.emit({ kind: "close", code: "}" });
            return;
        }
        if (!statement.finallyBlock) {
            context.fail(
                statement,
                "A try statement is lowered only with a finally block " +
                    "that erases to nothing.",
            );
        }
        context.bindings.pushScope(context.allocateBlockPrefix());
        try {
            for (const child of statement.tryBlock.statements) {
                this.emit(context, child);
                if (
                    this.terminatesAfterLowering(child) ||
                    this.staticIterationCompleted()
                )
                    break;
            }
        } finally {
            context.bindings.popScope();
        }
    }

    /**
     * A caught JavaScript value needs no native representation when the
     * handler `body` only reports it: a catch clause block or a rejection
     * callback's body.
     */
    public catchBindingIsErased(
        context: StatementLoweringContext,
        binding: ts.Identifier,
        body: ts.Node,
    ): boolean {
        const symbol = context.symbols.valueSymbol(binding);
        if (!symbol) return false;

        const erased = !someAnalysisNode(body, (node) => {
            if (
                ts.isIdentifier(node) &&
                node !== binding &&
                context.symbols.valueSymbol(node) === symbol
            ) {
                let statement: ts.Node = node;
                while (statement.parent && statement.parent !== body) {
                    statement = statement.parent;
                }
                const directBrowserArgument =
                    ts.isCallExpression(node.parent) &&
                    node.parent.parent === statement &&
                    context.browserErasure.isBrowserOnlyExpression(node.parent);
                if (
                    !ts.isStatement(statement) ||
                    !(
                        directBrowserArgument ||
                        this.statementIsBrowserOnly(context, statement) ||
                        (ts.isExpressionStatement(statement) &&
                            ts.isCallExpression(statement.expression) &&
                            context.isBrowserInstrumentationCall(
                                statement.expression,
                            ))
                    )
                ) {
                    return true;
                }
            }
            return false;
        });

        return erased;
    }

    private captureFinallyGuard(
        context: StatementLoweringContext,
        block: ts.Block,
        beforeBody: number,
    ): string[] {
        // A pending break/continue leaves the try only after every cleanup
        // statement runs. An abrupt cleanup completion can replace it.
        const completions = this.staticIterationCompletions.map((frame) => ({
            frame,
            completion: frame.completion,
        }));
        for (const { frame } of completions)
            writable(frame).completion = "normal";
        context.bindings.pushScope(context.allocateBlockPrefix());
        try {
            return context.captureHoistedLines(
                () => {
                    for (const statement of block.statements) {
                        this.emit(context, statement);
                        if (
                            this.terminatesAfterLowering(statement) ||
                            this.staticIterationCompleted()
                        )
                            break;
                    }
                },
                beforeBody,
                block,
            );
        } finally {
            context.bindings.popScope();
            for (const { frame, completion } of completions) {
                if (frame.completion === "normal")
                    writable(frame).completion = completion;
            }
        }
    }

    /**
     * A scene's own precondition, thrown.
     *
     * The corpus writes these as fixture guards — this graph must build two
     * systems, this loader must have returned a mesh — and the generated
     * main already catches and prints, so the native shape is the same
     * shape: a runtime error carrying the scene's own message. Only a
     * A runtime string travels too: plain-data functions already carry
     * `std::string`, and template interpolation preserves the diagnostic
     * values the source chose to report.
     */
    private emitThrow(
        context: StatementLoweringContext,
        statement: ts.ThrowStatement,
    ): void {
        const thrown = context.unwrap(statement.expression);
        // `throw new Error(message)` builds the Error value for this one
        // consumer, so its message stays an expression; a held Error value
        // or a string carries its message as a value.
        const errorName = ts.isNewExpression(thrown)
            ? errorConstructor(thrown, (callee) =>
                  context.libraryGlobal(callee),
              )
            : undefined;
        const sourceError =
            ts.isNewExpression(thrown) && errorName !== undefined
                ? compileErrorConstruction(context, thrown, errorName, "thrown")
                : context.compileValue(thrown);
        const error = authoredErrorValue(context, sourceError) ?? sourceError;
        if (error.dataType?.kind === "error") {
            context.reachThrow();
            context.emitNativeThrow(error.cpp, statement, true);
            return;
        }
        const value = thrownMessage(error);
        if (!value) {
            context.fail(
                statement,
                "A scene throws a new Error, a held Error value or a string.",
            );
        }
        if (value.staticString === undefined && !isStringValue(value)) {
            context.fail(thrown, "A thrown Error message must be a string.");
        }
        context.reachThrow();
        context.emitNativeThrow(
            `std::runtime_error(${
                value.staticString !== undefined
                    ? context.cppString(value.staticString)
                    : value.cpp
            })`,
            statement,
        );
    }

    private emitBlock(
        context: StatementLoweringContext,
        statement: ts.Block,
    ): void {
        context.emit({ kind: "open", code: "{" });
        this.emitScopedBody(context, statement);
        context.emit({ kind: "close", code: "}" });
    }

    private emitFor(
        context: StatementLoweringContext,
        statement: ts.ForStatement,
    ): void {
        const plan = context.parameterizedResourceLoop(statement);
        if (plan) {
            context.emitParameterizedResourceLoop(
                statement,
                plan.iterations,
                () => this.emitRuntimeFor(context, statement),
            );
            return;
        }
        const resourceLoop = context.requiresStaticIteration(
            statement.statement,
        );
        const needsSpecialization =
            resourceLoop &&
            context.requiresStaticDataIteration(statement.statement);
        const shape = staticIndexLoopShape(context.symbols, statement);
        const indexSymbol =
            shape && context.symbols.valueSymbol(shape.indexBinding);
        const staticExits =
            resourceLoop &&
            indexSymbol !== undefined &&
            this.hasStaticLoopExits(
                context,
                statement.statement,
                new EmissionSet([indexSymbol]),
            );
        if (needsSpecialization) {
            forEachAnalysisNode(
                statement.statement,
                (node) => {
                    if (ts.isReturnStatement(node)) {
                        context.fail(
                            node,
                            "A return from a resource loop changes its composition count; " +
                                "move the return outside the construction loop.",
                        );
                    }
                    if (
                        (ts.isBreakStatement(node) ||
                            ts.isContinueStatement(node)) &&
                        node.label
                    ) {
                        context.fail(
                            node,
                            "A labeled resource-loop exit cannot preserve static composition order.",
                        );
                    }
                },
                { functions: "skip" },
            );
        }
        if (
            (!this.bindsEnclosingLoop(statement.statement) ||
                needsSpecialization ||
                staticExits) &&
            this.emitStaticIndexFor(
                context,
                statement,
                this.bindsEnclosingLoop(statement.statement) && staticExits,
            )
        ) {
            return;
        }
        this.emitRuntimeFor(context, statement);
    }

    private emitRuntimeFor(
        context: StatementLoweringContext,
        statement: ts.ForStatement,
    ): void {
        context.emit({ kind: "open", code: "{" });
        context.increaseIndent();
        context.bindings.pushScope(context.allocateBlockPrefix());
        try {
            const counter = integerLoopCounter(context, statement);
            const counterCpp =
                counter && context.bindings.cppIdentifier(counter.binding.text);
            if (counter && counterCpp) {
                context.emit({
                    kind: "declaration",
                    type: "std::int64_t",
                    name: counterCpp,
                    initializer: String(counter.start),
                    attributes: "[[maybe_unused]] ",
                });
                context.bindings.defineVariable(counter.binding, {
                    kind: "number",
                    cpp: integerCounterRead(counterCpp),
                    nativeBinding: true,
                    integerCounterCpp: counterCpp,
                });
            } else if (statement.initializer) {
                if (ts.isVariableDeclarationList(statement.initializer)) {
                    for (const declaration of statement.initializer
                        .declarations) {
                        context.declarations.emitVariableDeclaration(
                            declaration,
                        );
                    }
                } else {
                    this.emitExpression(context, statement.initializer);
                }
            }
            this.inRuntimeIteration(
                context,
                () => {
                    const nativeCondition =
                        counter &&
                        counterCpp &&
                        integerLoopConditionCpp(counter, counterCpp);
                    const checkpoint =
                        context.asyncActivations.workerCheckpointCpp();
                    const condition = nativeCondition
                        ? checkpoint
                            ? `(${checkpoint}, ${nativeCondition})`
                            : nativeCondition
                        : statement.condition
                          ? this.compileRepeatedCondition(
                                context,
                                statement.condition,
                            )
                          : checkpoint
                            ? `(${checkpoint}, true)`
                            : "";
                    // The incrementor belongs in the for-header so `continue`
                    // reaches it, matching JavaScript loop semantics.
                    let header =
                        counter && counterCpp
                            ? integerLoopStepCpp(counter, counterCpp)
                            : "";
                    if (statement.incrementor && !counter) {
                        const emitted = this.inRuntimeControlFlow(context, () =>
                            context.captureEmittedStatements(() => {
                                this.emitExpression(
                                    context,
                                    statement.incrementor!,
                                );
                            }),
                        );
                        const lines = emitted.map(renderNativeEmission);
                        if (
                            lines.length === 0 ||
                            lines.some((line) => !line.endsWith(";")) ||
                            (lines.length > 1 &&
                                emitted.some(
                                    (item) =>
                                        item.statement.kind !== "expression",
                                ))
                        ) {
                            context.fail(
                                statement.incrementor,
                                "Loop incrementors must lower to native expressions.",
                            );
                        }
                        header = lines
                            .map((line) => line.slice(0, -1))
                            .join(", ");
                    }
                    let terminates = false;
                    const body = context.captureEmittedStatements(() => {
                        context.bindings.pushScope(
                            context.allocateBlockPrefix(),
                        );
                        try {
                            this.inRuntimeControlFlow(context, () => {
                                terminates = this.emitReachableBody(
                                    context,
                                    bodyStatements(statement),
                                );
                            });
                        } finally {
                            context.bindings.popScope();
                        }
                    });
                    // A specialized body may always leave the loop. A continue
                    // still reaches the incrementor, including inside a switch.
                    if (
                        terminates &&
                        !enclosingLoopControl(statement.statement, {
                            breaks: false,
                        })
                    )
                        header = "";
                    context.emit({
                        kind: "open",
                        code: `for (; ${condition}; ${header}) {`,
                        iteration: true,
                    });
                    context.increaseIndent();
                    context.emitCapturedStatements(body);
                    context.decreaseIndent();
                    context.emit({ kind: "close", code: "}" });
                },
                statement,
            );
        } finally {
            context.bindings.popScope();
            context.decreaseIndent();
        }
        context.emit({ kind: "close", code: "}" });
    }

    /**
     * One unrolled iteration, emitted FLAT into the scope the loop stands in.
     *
     * That is what unrolling a loop means: the statements are written out. A
     * C++ block would make each iteration's locals invisible to everything
     * after the loop, and a scene that collects what its body creates -- a
     * shadow-caster list built from `casters.push` -- names exactly those
     * locals. The generator scope pushed here already prefixes each
     * iteration's names uniquely, so flattening cannot collide two of them.
     *
     * Shared by the unrollers, because the reason is the loop's shape
     * rather than which collection it walked.
     *
     * A break or continue that only the running program decides cannot
     * leave flat statements: a jump past them would skip their
     * initialization. An iteration that takes one is emitted again as a
     * scope of its own, run as runtime control flow; its continue jumps to
     * the scope's end and its break past the loop, whose later iterations
     * are scopes too.
     */
    private emitUnrolledLoop(
        context: StatementLoweringContext,
        iteration: ts.IterationStatement,
        binds: Iterable<() => void>,
    ): void {
        const loop: UnrolledLoop = {
            iteration,
            breakLabel: undefined,
            scoped: false,
            runtimeExits: this.mayExitAtRuntime(context, iteration),
        };
        for (const bind of binds) {
            if (this.emitUnrolledIteration(context, loop, bind) === "break")
                break;
        }
        if (loop.breakLabel !== undefined) context.emit(`${loop.breakLabel}:;`);
    }

    private emitUnrolledIteration(
        context: StatementLoweringContext,
        loop: UnrolledLoop,
        bind: () => void,
    ): StaticCompletion {
        if (loop.scoped || !loop.runtimeExits)
            return this.emitIterationBody(
                context,
                loop,
                bind,
                loop.scoped ? "scoped" : "flat",
            );
        try {
            return context.probeEmission(
                () => this.emitIterationBody(context, loop, bind, "probe"),
                () => true,
            );
        } catch (error) {
            if (
                !(error instanceof RuntimeLoopExitRequired) ||
                error.iteration !== loop.iteration
            )
                // A refusal inside the attempt: lower the iteration again
                // where statement recovery sees each statement.
                return this.emitIterationBody(context, loop, bind, "flat");
        }
        return this.emitIterationBody(context, loop, bind, "scoped");
    }

    private emitIterationBody(
        context: StatementLoweringContext,
        loop: UnrolledLoop,
        bind: () => void,
        mode: StaticIterationFrame["mode"],
    ): StaticCompletion {
        context.bindings.pushScope(context.allocateBlockPrefix());
        const frame: StaticIterationFrame = {
            iteration: loop.iteration,
            completion: "normal",
            loop,
            mode,
            // A scope runs as runtime control flow; its own top level is
            // what this iteration decides.
            runtimeDepth: this.runtimeBranchDepth + (mode === "scoped" ? 1 : 0),
            exited: false,
            continueLabel: undefined,
        };
        this.staticIterationCompletions.push(frame);
        context.enterStaticIteration(loop.iteration);
        const body = loop.iteration.statement;
        const emitStatements = (): void => {
            bind();
            const statements = ts.isBlock(body) ? body.statements : [body];
            for (const nested of statements) {
                this.emit(context, nested);
                if (
                    this.terminatesAfterLowering(nested) ||
                    this.staticIterationCompleted()
                )
                    break;
            }
        };
        try {
            if (mode === "scoped") {
                context.emit({ kind: "open", code: "{" });
                context.increaseIndent();
                try {
                    this.inRuntimeControlFlow(context, emitStatements);
                } finally {
                    context.decreaseIndent();
                }
                context.emit({ kind: "close", code: "}" });
                if (frame.continueLabel !== undefined)
                    context.emit(`${frame.continueLabel}:;`);
            } else emitStatements();
        } finally {
            context.leaveStaticIteration();
            this.staticIterationCompletions.pop();
            context.bindings.popScope();
        }
        return frame.completion;
    }

    /**
     * Whether an unrolled body has a break or continue of its own loop under
     * a condition that is not visibly generation-known.
     */
    private mayExitAtRuntime(
        context: StatementLoweringContext,
        iteration: ts.IterationStatement,
    ): boolean {
        if (enclosingLoopControl(iteration.statement) === undefined)
            return false;
        const bindings = new EmissionSet<ts.Symbol>();
        const initializer =
            ts.isForStatement(iteration) ||
            ts.isForOfStatement(iteration) ||
            ts.isForInStatement(iteration)
                ? iteration.initializer
                : undefined;
        if (initializer && ts.isVariableDeclarationList(initializer))
            for (const declaration of initializer.declarations)
                forEachAnalysisNode(declaration.name, (node) => {
                    if (
                        !ts.isIdentifier(node) ||
                        (node !== declaration.name &&
                            !(
                                ts.isBindingElement(node.parent) &&
                                node.parent.name === node
                            ))
                    )
                        return;
                    const symbol = context.symbols.valueSymbol(node);
                    if (symbol) bindings.add(symbol);
                });
        return !this.hasStaticLoopExits(context, iteration.statement, bindings);
    }

    private emitStaticIndexFor(
        context: StatementLoweringContext,
        statement: ts.ForStatement,
        staticControl = false,
    ): boolean {
        const shape = staticIndexLoopShape(context.symbols, statement);
        if (!shape) return false;
        const { indexBinding, start, end: endExpression } = shape;
        const indexSymbol = context.symbols.valueSymbol(indexBinding);
        const reachesResource = context.requiresStaticIteration(
            statement.statement,
        );
        const requiresStaticIteration =
            staticControl ||
            (reachesResource &&
                !context.isRuntimeResourceConstruction() &&
                !context.prefersNativeDataIteration()) ||
            context.requiresStaticDataIteration(statement.statement) ||
            containsFrameYield(context, statement.statement);
        if (!requiresStaticIteration) return false;
        const length = context.compileValue(endExpression);
        const bound = context.unwrap(endExpression);
        const cardinality =
            reachesResource &&
            ts.isPropertyAccessExpression(bound) &&
            bound.name.text === "length"
                ? context.knownCollectionCardinality(bound.expression)
                : undefined;
        const end =
            length.staticNumber ??
            cardinality ??
            staticNumberValue(context, endExpression);
        const iterations =
            end === undefined
                ? undefined
                : staticIndexLoopIterations(shape, end);
        if (
            length.kind !== "number" ||
            end === undefined ||
            iterations === undefined
        ) {
            return false;
        }
        if (
            requiresStaticIteration &&
            loopBoundMayChange(context, statement.statement, endExpression)
        ) {
            context.fail(
                endExpression,
                "A static resource loop requires an invariant bound; " +
                    "the body or a called helper can change this bound.",
            );
        }
        let indexMutation: ts.Node | undefined;
        walkReachedLoopNodes(context, statement.statement, (node) => {
            if (indexMutation) return false;
            // A recursive call has its own loop binding, including its
            // incrementor. Only this body's lexical region can close over ours.
            if (
                node.getSourceFile() !== statement.getSourceFile() ||
                node.pos < statement.statement.pos ||
                node.end > statement.statement.end
            )
                return;
            if (
                writesThroughTrackedRoot(
                    node,
                    (target) =>
                        ts.isIdentifier(target) &&
                        context.symbols.valueSymbol(target) === indexSymbol,
                )
            ) {
                indexMutation = node;
                return false;
            }
        });
        if (indexMutation) {
            context.fail(
                indexMutation,
                "Static index-loop bodies cannot mutate the loop index.",
            );
        }
        this.emitUnrolledLoop(
            context,
            statement,
            Array.from({ length: iterations }, (_, offset) => () => {
                const index = start + offset;
                context.bindings.bindCompileTimeValue(indexBinding, {
                    kind: "number",
                    cpp: `${index}.0`,
                    staticNumber: index,
                });
            }),
        );
        return true;
    }

    private emitWhile(
        context: StatementLoweringContext,
        statement: ts.WhileStatement,
    ): void {
        this.inRuntimeIteration(
            context,
            () => {
                context.emit({
                    kind: "open",
                    code: `while (${this.compileRepeatedCondition(
                        context,
                        statement.expression,
                    )}) {`,
                    iteration: true,
                });
                this.inRuntimeControlFlow(context, () =>
                    this.emitScopedBody(context, statement.statement),
                );
                context.emit({ kind: "close", code: "}" });
            },
            statement,
        );
    }

    private emitDo(
        context: StatementLoweringContext,
        statement: ts.DoStatement,
    ): void {
        this.inRuntimeIteration(
            context,
            () => {
                context.emit({ kind: "open", code: "do {", iteration: true });
                this.inRuntimeControlFlow(context, () =>
                    this.emitScopedBody(context, statement.statement),
                );
                context.emit({
                    kind: "close",
                    code: `} while (${this.compileRepeatedCondition(
                        context,
                        statement.expression,
                    )});`,
                });
            },
            statement,
        );
    }

    /**
     * Keeps an inlined call's setup inside a loop condition so it runs on
     * every test rather than once before the loop.
     */
    private compileRepeatedCondition(
        context: StatementLoweringContext,
        expression: ts.Expression,
    ): string {
        let condition = "";
        const lines = this.inRuntimeControlFlow(context, () =>
            context.captureEmittedLines(() => {
                condition = context.conditions.compileCondition(expression);
            }),
        );
        const checkpoint = context.asyncActivations.workerCheckpointCpp();
        if (checkpoint) condition = `(${checkpoint}, ${condition})`;
        if (lines.length === 0) return condition;
        return `([&]() -> bool { ${lines.join(" ")} return ${condition}; }())`;
    }

    /**
     * `for (const key in object)`: the object's own enumerable keys, the
     * ones `Object.keys` lists, read once before the first iteration. A key
     * deleted before its turn is skipped. A compile-time record's keys are
     * known, so its loop is unrolled.
     */
    private emitForIn(
        context: StatementLoweringContext,
        statement: ts.ForInStatement,
    ): void {
        if (
            !ts.isVariableDeclarationList(statement.initializer) ||
            statement.initializer.declarations.length !== 1
        ) {
            context.fail(
                statement.initializer,
                "for...in requires one variable declaration naming its key.",
            );
        }
        const declaration = statement.initializer.declarations[0]!;
        if (!ts.isIdentifier(declaration.name))
            context.fail(
                declaration.name,
                "for...in requires one variable declaration naming its key.",
            );
        const binding = declaration.name;
        const raw = context.compileValue(statement.expression);
        const owner =
            raw.kind === "data"
                ? context.dataLowerer.narrowOptional(raw, statement.expression)
                : raw;
        if (owner.kind === "record") {
            this.emitUnrolledLoop(
                context,
                statement,
                Object.keys(owner.recordProperties ?? {}).map(
                    (key) => () =>
                        this.bindStaticIterationValue(
                            context,
                            binding,
                            staticStringValue(key, (text) =>
                                context.cppString(text),
                            ),
                        ),
                ),
            );
            return;
        }
        const ownKeys = this.forInOwnKeys(context, owner, statement.expression);
        context.reachJsData();
        const keys = context.allocateTemporaryCppName("own_keys");
        context.emit({
            kind: "declaration",
            type: "const bbl::js::Array<std::string>",
            name: keys,
            initializer: ownKeys.keysCpp,
        });
        const item = context.allocateTemporaryCppName("key");
        const lines = context.captureEmittedStatements(() => {
            context.bindings.pushScope(context.allocateBlockPrefix());
            try {
                context.bindDataIterationVariable(binding, item, {
                    kind: "string",
                });
                this.inRuntimeIteration(
                    context,
                    () =>
                        this.inRuntimeControlFlow(context, () => {
                            for (const nested of bodyStatements(statement))
                                this.emit(context, nested);
                        }),
                    statement,
                );
            } finally {
                context.bindings.popScope();
            }
        });
        context.emit({
            kind: "open",
            code: `for (const std::string& ${item} : ${keys}) {`,
            iteration: true,
        });
        context.increaseIndent();
        const present = ownKeys.presentCpp?.(item);
        if (present) {
            context.emit({ kind: "open", code: `if (!(${present})) {` });
            context.increaseIndent();
            context.emit({
                kind: "control",
                code: "continue;",
                transfer: "continue",
            });
            context.decreaseIndent();
            context.emit({ kind: "close", code: "}" });
        }
        context.emitCapturedStatements(lines);
        context.decreaseIndent();
        context.emit({ kind: "close", code: "}" });
    }

    /** The own keys a run-time `for...in` walks, and whether a key is still own. */
    private forInOwnKeys(
        context: StatementLoweringContext,
        owner: Value,
        node: ts.Expression,
    ): { keysCpp: string; presentCpp?: (key: string) => string } {
        if (isJsonValue(owner)) {
            const object = context.allocateTemporaryCppName("object");
            context.emit({
                kind: "declaration",
                type: "const bbl::js::JsonValue",
                name: object,
                initializer: owner.cpp,
            });
            return {
                keysCpp: `${object}.own_keys()`,
                presentCpp: (key) => `${object}.has_own(${key})`,
            };
        }
        const dataType = owner.kind === "data" ? owner.dataType : undefined;
        if (
            dataType?.kind === "map" &&
            dataType.dictionary &&
            dataType.key.kind === "string"
        ) {
            // The dictionary is read in place, as the loop body writes it.
            const object = context.bindings.pinValueToTemporary(
                owner,
                "object",
                node,
            ).cpp;
            context.reachJson();
            return {
                keysCpp: `bbl::js::property_names(${object})`,
                presentCpp: (key) => `${object}.has(${key})`,
            };
        }
        if (dataType?.kind === "struct") {
            // Keep this object's identity: later iterations observe field
            // deletions, while rebinding the source must not change its owner.
            context.dataTypes.markStoredObjectReferences(dataType);
            const fields = context.dataTypes.structFields(
                dataType.name,
                node,
                "accessors",
            );
            if (
                fields.some(
                    (field) => field.accessor && !field.accessorReceiver,
                )
            )
                context.dataTypes.structFields(dataType.name, node);
            const access = context.dataTypes.isReferenceStruct(dataType.name)
                ? "->"
                : ".";
            const object = context.bindings.pinValueToTemporary(
                owner,
                "object",
                node,
            ).cpp;
            const presence = fields.map((field) => ({
                field,
                present: context.dataTypes.ownPropertyPresentCpp(
                    dataType.name,
                    field,
                    `${object}${access}${field.name}`,
                    node,
                ),
            }));
            const optional = presence.filter(({ present }) => present);
            const pushes = presence.map(({ field, present }) => {
                const push = `own.push_back(${context.cppString(field.sourceName)});`;
                return present ? `if (${present}) ${push}` : push;
            });
            return {
                keysCpp: `[&] { bbl::js::Array<std::string> own; ${pushes.join(" ")} return own; }()`,
                ...(optional.length
                    ? {
                          presentCpp: (key: string) =>
                              optional
                                  .map(
                                      ({ field, present }) =>
                                          `(${key} != ${context.cppString(field.sourceName)} || ${present})`,
                                  )
                                  .join(" && "),
                      }
                    : {}),
            };
        }
        return context.fail(
            node,
            "for...in walks the own keys of a compile-time record, a string-keyed dictionary, a struct or a dynamic JSON object.",
        );
    }

    private emitForAwait(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
    ): void {
        if (!context.options.workers) throw new ApplicationRealmRequired();
        const iterator = context.compileValue(statement.expression);
        const type = iterator.dataType;
        if (type?.kind !== "iterator" || !type.asynchronous)
            context.fail(
                statement.expression,
                "for await requires an asynchronous iterator.",
            );
        this.emitIteratorLoop(context, statement, declaration, iterator, type);
    }

    private emitIteratorLoop(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
        iterator: Value,
        type: DataType<"iterator">,
    ): void {
        const source = context.allocateTemporaryCppName("iterator_source");
        const complete = context.allocateTemporaryCppName("iterator_complete");
        const next = context.allocateTemporaryCppName("iterator_result");
        context.emit({ kind: "open", code: "{" });
        context.increaseIndent();
        context.emit(`const auto ${source} = ${iterator.cpp};`);
        context.emit(`bool ${complete} = false;`);
        this.emitSuspendingCleanup(
            context,
            statement,
            () => {
                context.emit({
                    kind: "open",
                    code: "for (;;) {",
                    iteration: true,
                });
                context.increaseIndent();
                context.emit(
                    `auto ${next} = ${type.asynchronous ? "co_await " : ""}${source}.next();`,
                );
                context.emit(
                    `if (${next}.done) { ${complete} = true; break; }`,
                );
                context.bindings.pushScope(context.allocateBlockPrefix());
                try {
                    context.registerNativeBindingType(
                        next,
                        `typename ${context.dataTypes.cppType(type)}::Result`,
                    );
                    context.bindDataIterationVariable(
                        declaration.name,
                        `(*${next}.value)`,
                        type.element,
                    );
                    this.inRuntimeIteration(
                        context,
                        () =>
                            this.inRuntimeControlFlow(context, () => {
                                for (const nested of bodyStatements(
                                    statement,
                                )) {
                                    this.emit(context, nested);
                                    if (this.terminatesAfterLowering(nested))
                                        break;
                                }
                            }),
                        statement,
                    );
                } finally {
                    context.bindings.popScope();
                }
                context.decreaseIndent();
                context.emit({ kind: "close", code: "}" });
            },
            (pending) => {
                context.emit({ kind: "open", code: `if (!${complete}) {` });
                context.increaseIndent();
                context.emit(
                    `try { static_cast<void>(${type.asynchronous ? "co_await " : ""}${source}.return_()); } catch (...) { if (!bbl::js::is_throw_completion(${pending})) throw; }`,
                );
                context.decreaseIndent();
                context.emit({ kind: "close", code: "}" });
            },
        );
        context.decreaseIndent();
        context.emit({ kind: "close", code: "}" });
    }

    private emitForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
    ): void {
        if (
            !ts.isVariableDeclarationList(statement.initializer) ||
            statement.initializer.declarations.length !== 1
        ) {
            context.fail(
                statement.initializer,
                "for...of requires one variable declaration.",
            );
        }
        const declaration = statement.initializer.declarations[0]!;
        if (statement.awaitModifier)
            return this.emitForAwait(context, statement, declaration);
        if (declaration.initializer) {
            context.fail(
                declaration,
                "for...of bindings cannot carry initializers.",
            );
        }
        // A retained callback can run after another closure registers members.
        // Its initial empty cardinality is not a proof that its loop is empty.
        const subject = context.unwrap(statement.expression);
        const containerType = ts.isIdentifier(subject)
            ? (context.bindings.lookupOptional(subject)?.dataType ??
              context.dataLowerer.dataTypeAt(subject))
            : undefined;
        const liveElement =
            containerType && "element" in containerType
                ? containerType.element
                : undefined;
        if (
            liveElement?.kind === "function" &&
            this.emitRuntimeForOf(context, statement, declaration)
        )
            return;
        const runtimeCardinality = context.runtimeCollectionCardinality(
            statement.expression,
        );
        if (runtimeCardinality === 0) return;
        const plan = context.parameterizedResourceLoop(statement);
        if (plan) {
            let emitted = false;
            context.emitParameterizedResourceLoop(
                statement,
                plan.iterations,
                () => {
                    emitted = this.emitRuntimeForOf(
                        context,
                        statement,
                        declaration,
                    );
                },
            );
            if (emitted || plan.iterations === 0) return;
        }
        if (
            context.requiresStaticIteration(statement.statement) &&
            this.bindsEnclosingLoop(statement.statement) &&
            this.emitStaticResourceExitForOf(context, statement, declaration)
        ) {
            return;
        }
        // The engine-collection paths answer first: their expressions are
        // property reads (or a `?? []` over one), which the static probe
        // would try to resolve as a value and refuse.
        if (this.emitAssetEntitiesForOf(context, statement, declaration)) {
            return;
        }
        if (this.emitAssetRootChildrenForOf(context, statement, declaration)) {
            return;
        }
        if (
            this.emitAssetFlattenedMeshesForOf(context, statement, declaration)
        ) {
            return;
        }
        if (this.emitHandleCollectionForOf(context, statement, declaration)) {
            return;
        }
        if (
            this.emitTupleIteratorForOf(context, statement, declaration) ||
            this.emitTupleForOf(context, statement, declaration)
        ) {
            return;
        }
        // A handle vector whose static snapshot was invalidated by a spread
        // append (for example, an accumulated set of imported meshes) must
        // iterate its native contents. Looking only through the identifier
        // to its original `[]` initializer would incorrectly unroll zero
        // iterations and erase the body.
        if (
            liveElement?.kind === "handle" &&
            this.emitRuntimeForOf(context, statement, declaration)
        ) {
            return;
        }
        const probedStaticLiteral = !this.bindsEnclosingLoop(
            statement.statement,
        )
            ? context.probeStaticArrayLiteral(statement.expression)
            : undefined;
        // A spread is a runtime snapshot, even when the surrounding literal
        // is statically visible. Unrolling the literal would try to bind the
        // SpreadElement itself as one loop value and, more importantly, would
        // iterate the live source rather than the copy JavaScript made.
        const staticLiteral = probedStaticLiteral?.elements.some(
            ts.isSpreadElement,
        )
            ? undefined
            : probedStaticLiteral;
        // Preserve runtime iteration for destructured materialized tables.
        // Static destructuring is the fallback for tuples whose mixed or
        // optional lanes cannot be represented as one native container.
        if (
            (!staticLiteral || ts.isArrayBindingPattern(declaration.name)) &&
            this.emitRuntimeForOf(context, statement, declaration)
        ) {
            return;
        }
        // A module constant the program computes (`ORDER.map(...)`) runs
        // at generation, which states the elements a literal would.
        const executed = context.executedModuleConstantElements(
            statement.expression,
        );
        if (
            executed &&
            this.emitRuntimeForOf(context, statement, declaration, {
                kind: "tuple",
                cpp: "",
                tupleElements: executed,
            })
        )
            return;
        if (executed) {
            this.emitUnrolledLoop(
                context,
                statement,
                executed.map(
                    (value) => () =>
                        this.bindStaticIterationValue(
                            context,
                            declaration.name,
                            value,
                        ),
                ),
            );
            return;
        }
        if (
            this.bindsEnclosingLoop(statement.statement) &&
            !context.probeStaticArrayLiteral(statement.expression)
        ) {
            // An iterated value that does not lower names its own cause.
            context.compileValue(statement.expression);
            context.fail(
                statement,
                "break/continue in for...of requires a runtime data container.",
            );
        }
        const values = context.expectStaticArrayLiteral(statement.expression);
        const compiled = this.preferNativeDataIteration(context, statement)
            ? values.elements.map((element) => context.compileValue(element))
            : undefined;
        if (
            compiled?.every((value) =>
                this.plainIterationData(context, value),
            ) &&
            context.emitNativeDataIteration(statement, () =>
                this.emitRuntimeForOf(context, statement, declaration, {
                    kind: "tuple",
                    cpp: "",
                    tupleElements: compiled,
                }),
            )
        ) {
            return;
        }
        if (
            compiled &&
            this.emitNativeHandleTableForOf(
                context,
                statement,
                declaration,
                compiled,
            )
        ) {
            return;
        }
        this.emitUnrolledLoop(
            context,
            statement,
            values.elements.map((element, index) => () => {
                this.bindStaticIterationValue(
                    context,
                    declaration.name,
                    compiled?.[index] ?? context.compileValue(element),
                );
            }),
        );
    }

    private emitStaticResourceExitForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
    ): boolean {
        const bindingSymbol = ts.isIdentifier(declaration.name)
            ? context.symbols.valueSymbol(declaration.name)
            : undefined;
        if (
            !context.requiresStaticDataIteration(statement.statement) &&
            (!bindingSymbol ||
                !this.hasStaticLoopExits(
                    context,
                    statement.statement,
                    new EmissionSet([bindingSymbol]),
                ))
        ) {
            return false;
        }
        const expression = context.resolveStaticExpression(
            statement.expression,
        );
        const literal = ts.isArrayLiteralExpression(expression)
            ? expression
            : context.constArrayLiteral(expression);
        const binding = ts.isIdentifier(expression)
            ? context.bindings.lookupOptional(expression)
            : undefined;
        const bound =
            binding?.tupleElements ??
            binding?.staticElementsOwner?.staticElements ??
            binding?.staticElements;
        if (!literal && !bound) return false;
        if (
            literal?.elements.some(
                (element) =>
                    ts.isSpreadElement(element) ||
                    ts.isOmittedExpression(element),
            )
        )
            return false;
        const values =
            bound ??
            literal!.elements.map((element) => context.compileValue(element));
        const settled = (value: Value): boolean =>
            value.staticNumber !== undefined ||
            value.staticString !== undefined ||
            value.staticBoolean !== undefined ||
            value.kind === "json-null" ||
            (isHandleKind(value.kind) &&
                cppIdentifierPattern.test(value.cpp)) ||
            (value.kind === "tuple" &&
                value.tupleElements?.every(settled) === true) ||
            (value.kind === "record" &&
                value.cpp.length === 0 &&
                value.recordProperties !== undefined &&
                Object.keys(value.recordMethods ?? {}).length === 0 &&
                Object.keys(value.recordGetters ?? {}).length === 0 &&
                Object.keys(value.recordSetters ?? {}).length === 0 &&
                Object.values(value.recordProperties).every(settled));
        if (!values.every(settled)) {
            context.fail(
                statement.expression,
                "A static resource-loop exit requires settled iteration values.",
            );
        }
        this.emitUnrolledLoop(
            context,
            statement,
            values.map(
                (value) => () =>
                    this.bindStaticIterationValue(
                        context,
                        declaration.name,
                        value,
                    ),
            ),
        );
        return true;
    }

    /**
     * Lowers the pin's recursive `TransformNode.children` mesh walk over an
     * imported glTF root.
     *
     * Native loading has already flattened renderable descendants into the
     * asset's mesh handles. Flattening an arbitrary immediate-children loop
     * would be observably different, so this path accepts only the precise
     * recursive leaf walk the pin encourages: transform children recurse
     * with the same remaining arguments, mesh children take the `else` arm.
     * Under that proof, one native loop over all descendant meshes executes
     * exactly the source leaf arm once per renderable.
     */
    private emitAssetRootChildrenForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
    ): boolean {
        if (!ts.isIdentifier(declaration.name)) return false;
        const materialAssignment = isRecursiveImportedMeshWalk(
            statement,
            declaration.name,
        );
        if (!materialAssignment) return false;
        const target = context.probeEmission(
            () =>
                context.handleCollections.assetRootChildrenIterationTarget(
                    statement.expression,
                ),
            (value) => value !== undefined,
        );
        if (!target) return false;
        const material = context.compileValue(materialAssignment.right);
        if (material.scenePbrMaterialIndex === undefined) {
            context.fail(
                materialAssignment.right,
                "The imported hierarchy material walk currently accepts only a scene-created PBR material; other families do not all consume clone-root outer transforms.",
            );
        }
        emitHandleCollectionLoop(
            context,
            target,
            declaration.name,
            (loopContext) => {
                this.inRuntimeIteration(
                    loopContext,
                    () => {
                        this.inRuntimeControlFlow(loopContext, () => {
                            const branch = bodyStatements(
                                statement,
                            )[0] as ts.IfStatement;
                            this.emitScopedBody(
                                loopContext,
                                branch.elseStatement!,
                            );
                        });
                    },
                    statement,
                );
            },
        );
        return true;
    }

    /**
     * Lowers `for (const mesh of <walk>(container))`, where the walk is
     * proven to flatten the container to its renderables.
     *
     * The body runs in the source collector's observed order. `break` stays
     * refused because this specialization carries a complete-asset mutation
     * and resource-count proof; a partial traversal needs a weaker fact.
     * `continue` lowers to the range-for's native continuation.
     *
     * The binding carries the container itself, which is the licence a
     * setter with no per-material compile-time identity needs: the loop
     * demonstrably reaches every renderable, so a fact stamped from inside
     * it is the container's. That is why the licence is minted here rather
     * than on the collection — the same handles reached through
     * `getContainerMeshes(a)` or `a.meshes ?? []` carry no such proof.
     */
    private emitAssetFlattenedMeshesForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
    ): boolean {
        const resolved =
            context.handleCollections.assetFlattenedMeshesIterationTarget(
                statement.expression,
            );
        if (!resolved) {
            return false;
        }
        if (this.breaksEnclosingLoop(statement.statement)) {
            context.fail(
                statement,
                "break in a container's mesh walk is not lowered: partial traversal does not carry the complete-asset mutation and resource-count proof.",
            );
        }
        this.emitCollectionForOfBody(
            context,
            statement,
            declaration,
            resolved.target,
            { assetWholeMeshList: resolved.asset },
        );
        return true;
    }

    /**
     * Iterates an asset container's `entities`.
     *
     * The body is emitted once, with the binding standing for the
     * container's entities as a set: an entity value is accepted by
     * `addToScene` alone, and adding every entity of a container adds
     * exactly the meshes and lights its loader created. What the entity
     * walk adds is only that; the container's own wiring — its animation
     * groups, their per-frame tick, its camera and its clear colour —
     * belongs to `addToScene(scene, container)` and is exactly what a
     * scene iterating entities is avoiding.
     */
    private emitAssetEntitiesForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
    ): boolean {
        const target = context.handleCollections.assetEntitiesIterationTarget(
            statement.expression,
        );
        if (!target) {
            return false;
        }
        if (!ts.isIdentifier(declaration.name)) {
            context.fail(
                declaration.name,
                "Iterating entities requires an identifier binding.",
            );
        }
        if (this.bindsEnclosingLoop(statement.statement)) {
            context.fail(
                statement,
                "break/continue in an entity loop is not lowered; a container's entities are one root.",
            );
        }
        context.bindings.pushScope(context.allocateBlockPrefix());
        try {
            context.bindings.bindLocalValue(declaration.name, target);
            for (const nested of bodyStatements(statement)) {
                this.emit(context, nested);
            }
        } finally {
            context.bindings.popScope();
        }
        return true;
    }

    /**
     * Iterates an identifier bound to a compile-time tuple — a local like
     * `const activeGroups = [idle, sadPose]`. The elements are the values
     * the declaration already compiled, so the body unrolls once per
     * element with the binding standing for that value, exactly as the
     * inline static-array-literal unroll below does for its expressions.
     */
    /**
     * `for (const [index, value] of tuple.entries())`, `tuple.keys()` and
     * `tuple.values()` over a compile-time tuple: the loop unrolls once per
     * element as the plain tuple loop does, with the index a settled
     * number. A runtime container's iterator methods take the native
     * range-for instead.
     */
    private emitTupleIteratorForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
    ): boolean {
        const iterator = iteratorMethodCall(
            statement.expression,
            (receiver) => context.libraryGlobal(receiver),
            (node) => context.unwrap(node),
        );
        if (!iterator) {
            return false;
        }
        const { method, receiver } = iterator;
        // A compile-time tuple unrolls, as the plain tuple loop does, unless
        // its elements are plain data a native range represents exactly;
        // any other receiver takes the runtime loop, which resolves the
        // iterator method itself. The probe only asks and keeps nothing it
        // emitted while asking.
        const elements = context.probeEmission(
            () => context.handleCollections.tupleElements(receiver),
            (result) => result !== undefined,
        );
        if (!elements) {
            return this.emitRuntimeForOf(context, statement, declaration);
        }
        if (
            this.preferNativeDataIteration(context, statement) &&
            elements.every((value) =>
                this.plainIterationData(context, value),
            ) &&
            this.emitRuntimeForOf(context, statement, declaration)
        ) {
            return true;
        }
        this.emitUnrolledLoop(
            context,
            statement,
            elements.map((element, index) => () => {
                const indexValue: Value = {
                    kind: "number",
                    cpp: doubleLiteral(index),
                    staticNumber: index,
                    dataType: { kind: "number" },
                };
                const value: Value =
                    method === "keys"
                        ? indexValue
                        : method === "values"
                          ? element
                          : {
                                kind: "tuple",
                                cpp: "",
                                tupleElements: [indexValue, element],
                            };
                this.bindStaticIterationValue(context, declaration.name, value);
            }),
        );
        return true;
    }

    private emitTupleForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
    ): boolean {
        // Both questions below answer by RESOLVING the loop's subject, and
        // resolving a call compiles it. A probe that then declines must take
        // its emission with it, or the call's inlined body stays in the
        // stream unreachable and the shape that does answer compiles the
        // same call again.
        const elements = context.probeEmission(
            () => {
                if (
                    ts.isArrayBindingPattern(declaration.name) &&
                    context.dataIterationTarget(statement.expression)
                ) {
                    // A homogeneous static table already has an exact native
                    // row representation. Keep its established range-for
                    // lowering; tuple unrolling is needed only for
                    // heterogeneous/optional rows.
                    return undefined;
                }
                return context.handleCollections.tupleElements(
                    statement.expression,
                );
            },
            (result) => result !== undefined,
        );
        if (!elements) {
            return false;
        }
        if (elements.length === 0) return true;
        if (
            this.preferNativeDataIteration(context, statement) &&
            elements.every((value) =>
                this.plainIterationData(context, value),
            ) &&
            context.emitNativeDataIteration(statement, () =>
                this.emitRuntimeForOf(context, statement, declaration, {
                    kind: "tuple",
                    cpp: "",
                    tupleElements: [...elements],
                }),
            )
        ) {
            return true;
        }
        if (
            this.bindsEnclosingLoop(statement.statement) &&
            context.dataIterationTarget(statement.expression)
        ) {
            return false;
        }
        if (
            this.emitNativeHandleTableForOf(
                context,
                statement,
                declaration,
                elements,
            )
        ) {
            return true;
        }
        this.emitUnrolledLoop(
            context,
            statement,
            elements.map((element) => () => {
                this.bindStaticIterationValue(
                    context,
                    declaration.name,
                    element,
                );
            }),
        );
        return true;
    }

    /** Typed handle iteration preserves order and aliases without recompiling the body. */
    private emitNativeHandleTableForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
        elements: readonly Value[],
    ): boolean {
        if (!ts.isIdentifier(declaration.name) || elements.length === 0)
            return false;
        const binding = declaration.name;
        const first = elements[0]!;
        const kind = first.kind;
        if (
            kind !== "mesh" &&
            kind !== "material" &&
            kind !== "camera" &&
            kind !== "animation-group"
        )
            return false;
        const engineCpp = first.engineCpp;
        if (
            !engineCpp ||
            elements.some(
                (element) =>
                    element.kind !== kind || element.engineCpp !== engineCpp,
            ) ||
            this.bindsEnclosingLoop(statement.statement) ||
            !context.reachesOnlyClosedEffects(statement.statement)
        )
            return false;
        const cppType =
            context.handleCollections.staticHandleTableCppType(kind)!;
        const values = elements.map((element) =>
            context.bindings.pinValueToTemporary(element, "handle_element"),
        );
        for (const value of values) context.useNativeValue(value);
        const table = context.allocateTemporaryCppName("handle_table");
        context.emit(
            "const " + cppType + " " + table + "[" + values.length + "] = {",
        );
        context.increaseIndent();
        for (let index = 0; index < values.length; index += 16) {
            context.emit(
                values
                    .slice(index, index + 16)
                    .map((value) => value.cpp)
                    .join(", ") + ",",
            );
        }
        context.decreaseIndent();
        context.emit("};");
        return context.emitNativeDataIteration(statement, () => {
            emitHandleCollectionLoop(
                context,
                {
                    containerCpp: table,
                    elementKind: kind,
                    elementCppType: cppType,
                    engineCpp,
                    temporaryLabel: "handle_table_member",
                    elementTemplate: commonResourceValue(
                        elements[0]!,
                        elements,
                    ),
                },
                binding,
                () => this.emitScopedBody(context, statement.statement),
            );
            return true;
        });
    }

    /**
     * `{ a, b: alias }` over one unrolled element: each name takes the
     * element's property, a compile-time record's value or a struct's field.
     */
    private bindStaticObjectPattern(
        context: StatementLoweringContext,
        pattern: ts.ObjectBindingPattern,
        value: Value,
    ): void {
        const struct =
            value.kind === "data" && value.dataType?.kind === "struct"
                ? value.dataType
                : undefined;
        if (value.kind !== "record" && !struct)
            context.fail(
                pattern,
                "Object destructuring in static for...of requires record or struct elements.",
            );
        for (const element of pattern.elements) {
            const property = element.propertyName
                ? context.propertyName(element.propertyName)
                : ts.isIdentifier(element.name)
                  ? element.name.text
                  : undefined;
            if (
                element.dotDotDotToken ||
                element.initializer ||
                !ts.isIdentifier(element.name) ||
                property === undefined
            )
                context.fail(
                    element,
                    "Object destructuring in static for...of binds plain or renamed identifiers.",
                );
            const field = struct
                ? context.dataTypes.structField(struct.name, property, element)
                : undefined;
            const member =
                struct && field
                    ? context.dataLowerer.leafValue(
                          `${value.cpp}${context.dataTypes.isReferenceStruct(struct.name) ? "->" : "."}${field.name}`,
                          field.type,
                      )
                    : value.recordProperties?.[property];
            if (!member)
                context.fail(
                    element,
                    `The unrolled element has no property '${property}'.`,
                );
            context.bindings.bindLocalValue(element.name, member);
        }
    }

    /** Binds one statically unrolled element, including tuple and object patterns. */
    private bindStaticIterationValue(
        context: StatementLoweringContext,
        name: ts.BindingName,
        value: Value,
    ): void {
        if (ts.isIdentifier(name)) {
            // A statically unrolled handle loop aliases the same JavaScript
            // object stored in the tuple. Keep the Value object itself so
            // generation-time identity facts learned in the body (notably a
            // light's scene slot) are visible through every alias after the
            // loop. Plain-data lanes still get native iteration storage.
            if (isHandleKind(value.kind)) {
                context.bindings.bindCompileTimeValue(name, value);
            } else {
                context.bindings.bindLocalValue(name, value);
            }
            return;
        }
        if (ts.isObjectBindingPattern(name)) {
            this.bindStaticObjectPattern(context, name, value);
            return;
        }
        if (value.kind !== "tuple" || !value.tupleElements) {
            context.fail(
                name,
                "Array destructuring in static for...of requires tuple elements.",
            );
        }
        name.elements.forEach((binding, index) => {
            if (ts.isOmittedExpression(binding)) return;
            if (
                !ts.isIdentifier(binding.name) ||
                binding.initializer ||
                binding.dotDotDotToken
            ) {
                context.fail(
                    binding,
                    "Tuple destructuring supports plain identifiers.",
                );
            }
            const element = value.tupleElements![index];
            if (element) {
                context.bindings.bindLocalValue(binding.name, element);
            } else {
                // JavaScript binds an omitted tuple lane to `undefined`;
                // optional trailing tuple members use that path routinely.
                context.bindings.bindCompileTimeValue(binding.name, {
                    kind: "json-null",
                    cpp: "std::nullopt",
                });
            }
        });
    }

    /**
     * Iterates a collection an engine handle exposes — handles into the
     * engine, not a data container, so it binds a handle value instead of a
     * data element. Which collections exist is the table in `properties.ts`;
     * this holds the loop, the scope and the binding once. The count is a
     * run-time property of what the owner ended up holding — a loaded
     * asset's meshes and groups are added by the generated loader — so this
     * stays a real loop rather than being unrolled.
     */
    /**
     * The body both handle-collection `for...of` arms emit: the binding
     * check, the native loop, and the source body re-emitted once per
     * member. Only what licenses the loop differs between them.
     */
    private emitCollectionForOfBody(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
        target: HandleCollectionTarget,
        extraBinding?: Partial<Value>,
    ): void {
        if (!ts.isIdentifier(declaration.name)) {
            context.fail(
                declaration.name,
                `Iterating ${target.property} requires an identifier binding.`,
            );
        }
        const binding = declaration.name;
        const emitBody = (): void =>
            emitHandleCollectionLoop(
                context,
                target,
                binding,
                (loopContext) => {
                    this.inRuntimeIteration(
                        loopContext,
                        () => {
                            this.inRuntimeControlFlow(loopContext, () => {
                                this.emitReachableBody(
                                    loopContext,
                                    bodyStatements(statement),
                                );
                            });
                        },
                        statement,
                    );
                },
                extraBinding,
            );
        const repeatable = context.parameterizedResourceLoop(statement, 1);
        const count = repeatable
            ? context.handleCollections.collectionCardinality(
                  target,
                  statement.expression,
              )
            : undefined;
        if (count !== undefined) {
            context.emitParameterizedResourceLoop(statement, count, emitBody);
        } else {
            emitBody();
        }
    }

    private emitHandleCollectionForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
    ): boolean {
        const target = context.handleCollections.iterationTarget(
            statement.expression,
        );
        if (!target) {
            return false;
        }
        this.emitCollectionForOfBody(context, statement, declaration, target);
        return true;
    }

    /**
     * Emits a range-for over a runtime data container (vector, span, or
     * static-table rows). Returns false when the iterated expression is not
     * a data container, so the static-literal unroll can proceed.
     */
    private emitRuntimeForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
        knownTuple?: Value,
    ): boolean {
        const target = context.dataIterationTarget(
            statement.expression,
            knownTuple,
        );
        if (!target) {
            return false;
        }
        if (
            target.container.dataType?.kind === "iterator" &&
            target.container.dataType.asynchronous
        )
            context.fail(
                statement.expression,
                "An asynchronous iterator requires for await.",
            );
        if (
            target.container.dataType?.kind === "iterator" &&
            context.activeGeneratorType()
        ) {
            this.emitIteratorLoop(
                context,
                statement,
                declaration,
                target.container,
                target.container.dataType,
            );
            return true;
        }
        const count = context.runtimeCollectionCardinality(
            statement.expression,
        );
        // `entries()`/`keys()` walk the array by index: the counter is the
        // loop variable, and an entry's value is the element in place.
        const indexed =
            target.element.kind === "array-entry" ||
            target.element.kind === "array-index"
                ? target.element
                : undefined;
        if (
            !indexed &&
            !context.isInParameterizedResourceLoop(statement) &&
            count !== undefined &&
            (context.requiresStaticDataIteration(statement.statement) ||
                (count === 1 &&
                    context.requiresStaticIteration(statement.statement))) &&
            (!context.isInRuntimeControlFlow() ||
                context.isInParameterizedResourceLoop())
        ) {
            if (
                loopBoundMayChange(
                    context,
                    statement.statement,
                    statement.expression,
                )
            ) {
                context.fail(
                    statement.expression,
                    "A statically expanded resource iteration requires an unchanged array size.",
                );
            }
            const range = context.bindings.pinValueToTemporary(
                target.container,
                "resource_range",
                statement.expression,
            ).cpp;
            const iterator =
                context.allocateTemporaryCppName("resource_iterator");
            context.emit({
                kind: "declaration",
                type: "auto",
                name: iterator,
                initializer: `${range}.begin()`,
            });
            const unchangedSize = (): void => {
                if (
                    context.knownCollectionCardinality(statement.expression) !==
                    count
                ) {
                    context.fail(
                        statement.expression,
                        "A statically expanded resource iteration cannot resize its array.",
                    );
                }
            };
            this.emitUnrolledLoop(
                context,
                statement,
                Array.from({ length: count }, () => () => {
                    unchangedSize();
                    const member =
                        context.allocateTemporaryCppName("resource_member");
                    context.emit({
                        kind: "declaration",
                        type: "auto",
                        name: member,
                        initializer: `*${iterator}`,
                        attributes: "[[maybe_unused]] ",
                    });
                    context.emit({
                        kind: "expression",
                        code: `++${iterator};`,
                    });
                    context.bindDataIterationVariable(
                        declaration.name,
                        member,
                        target.element,
                        target.template,
                    );
                }),
            );
            unchangedSize();
            return true;
        }
        const item =
            indexed?.kind === "array-index"
                ? indexed.indexCpp
                : context.allocateTemporaryCppName("item");
        const container = target.container.dataType;
        // A span views a constant table: its items are constant, and a
        // closure capturing one borrows it as such.
        if (container?.kind === "span" && indexed?.kind !== "array-index")
            context.registerNativeBindingType(
                item,
                `const ${context.dataTypes.cppType(container.element)}`,
            );
        const lines = context.captureEmittedStatements(() => {
            context.bindings.pushScope(context.allocateBlockPrefix());
            try {
                context.bindDataIterationVariable(
                    declaration.name,
                    item,
                    target.element,
                    target.template,
                );
                const statements = ts.isBlock(statement.statement)
                    ? statement.statement.statements
                    : [statement.statement];
                this.inRuntimeIteration(
                    context,
                    () => {
                        this.inRuntimeControlFlow(context, () => {
                            this.emitReachableBody(context, statements);
                        });
                    },
                    statement,
                );
            } finally {
                context.bindings.popScope();
            }
        });
        if (indexed) {
            const indexCpp = indexed.indexCpp;
            const range = context.allocateTemporaryCppName("range");
            const span = target.container.dataType?.kind === "span";
            context.emit({
                kind: "declaration",
                type: span ? "auto" : "auto&&",
                name: range,
                initializer: span
                    ? `std::span{${target.container.cpp}}`
                    : target.container.cpp,
            });
            context.emit({
                kind: "open",
                code: `for (std::size_t ${indexCpp} = 0; ${indexCpp} < ${range}.size(); ++${indexCpp}) {`,
                iteration: true,
            });
            context.increaseIndent();
            if (indexed.kind === "array-entry") {
                context.emit({
                    kind: "declaration",
                    type: "auto&&",
                    name: item,
                    initializer: `${range}[${indexCpp}]`,
                    // `for (const [index] of list.entries())` binds no value.
                    attributes: "[[maybe_unused]] ",
                });
            }
            context.emitCapturedStatements(lines);
            context.decreaseIndent();
            context.emit({ kind: "close", code: "}" });
            return true;
        }
        const storedIterator = target.container.dataType?.kind === "iterator";
        if (storedIterator) {
            const source = context.allocateTemporaryCppName("iterator_source");
            const value = context.allocateTemporaryCppName("iterator_value");
            context.emit({ kind: "open", code: "{" });
            context.increaseIndent();
            context.emit({
                kind: "declaration",
                type: "const auto",
                name: source,
                initializer: target.container.cpp,
            });
            context.emit(
                `bbl::js::IteratorScope ${context.allocateTemporaryCppName("iterator_scope")}(${source});`,
            );
            context.emit({
                kind: "open",
                code: `while (auto ${value} = ${source}.next().value) {`,
                iteration: true,
            });
            context.increaseIndent();
            context.emit({
                kind: "declaration",
                type: "auto&&",
                name: item,
                initializer: `*${value}`,
                attributes: "[[maybe_unused]] ",
            });
        } else {
            // A span is a borrowed descriptor, so hold that descriptor by value.
            // Binding the range-for's hidden reference to a returned span makes
            // GCC 13 incorrectly tie it to temporary arguments of the source call.
            const span =
                target.container.dataType?.kind === "span"
                    ? context.allocateTemporaryCppName("range")
                    : undefined;
            context.emit({
                kind: "open",
                code: `for (${span ? `auto ${span} = std::span{${target.container.cpp}}; ` : ""}auto&& ${item} : ${span ?? target.container.cpp}) {`,
                iteration: true,
            });
            context.increaseIndent();
        }
        if (!storedIterator)
            context.emit({
                kind: "expression",
                code: `static_cast<void>(${item});`,
            });
        context.emitCapturedStatements(lines);
        context.decreaseIndent();
        context.emit({ kind: "close", code: "}" });
        if (storedIterator) {
            context.decreaseIndent();
            context.emit({ kind: "close", code: "}" });
        }
        return true;
    }

    private emitScopedBody(
        context: StatementLoweringContext,
        statement: ts.Statement,
        propagateRebindings = false,
    ): void {
        context.increaseIndent();
        context.bindings.pushScope(
            context.allocateBlockPrefix(),
            propagateRebindings,
        );
        try {
            const statements = ts.isBlock(statement)
                ? statement.statements
                : [statement];
            for (const nested of statements) {
                this.emit(context, nested);
                if (
                    this.terminatesAfterLowering(nested) ||
                    this.staticIterationCompleted()
                )
                    break;
            }
        } finally {
            context.bindings.popScope();
            context.decreaseIndent();
        }
    }

    /**
     * One expression lowered as a statement. Public for a caller holding
     * an expression rather than an `ExpressionStatement` — a concise
     * arrow body, whose value the pin's callback contract discards.
     */
    /**
     * `condition ? a() : b()` whose value is discarded: each arm is a
     * statement of its own branch, so arms of different value types (one
     * void) never meet in one native expression.
     */
    private emitConditionalStatement(
        context: StatementLoweringContext,
        expression: ts.ConditionalExpression,
    ): void {
        const condition = context.conditions.compileCondition(
            expression.condition,
        );
        const emitArm = (arm: ts.Expression): void => {
            if (this.emitExpression(context, arm))
                context.fail(
                    arm,
                    "A conditional expression statement cannot suspend in one arm.",
                );
        };
        if (condition === "true" || condition === "false") {
            emitArm(
                condition === "true"
                    ? expression.whenTrue
                    : expression.whenFalse,
            );
            return;
        }
        const emitBranch = (arm: ts.Expression): void => {
            context.increaseIndent();
            try {
                this.inRuntimeControlFlow(context, () => emitArm(arm));
            } finally {
                context.decreaseIndent();
            }
        };
        context.emit({ kind: "open", code: `if (${condition}) {` });
        emitBranch(expression.whenTrue);
        context.emit({ kind: "branch", code: "} else {" });
        emitBranch(expression.whenFalse);
        context.emit({ kind: "close", code: "}" });
    }

    public emitExpression(
        context: StatementLoweringContext,
        expression: ts.Expression,
    ): boolean | void {
        traceSourceNode(expression);
        if (ts.isYieldExpression(expression)) {
            context.emitNativeYield(expression);
            return;
        }
        context.checkNodeGeometryMutation(expression);
        const input = context.compileNodeInputMutation(expression);
        if (input) {
            context.emitDiscardedValue(input);
            return;
        }
        const text = context.compileTextMutation(expression);
        if (text) {
            context.emitDiscardedValue(text);
            return;
        }
        if (context.asyncActivations.emitAwaitExpression(expression)) return;
        const unwrapped = context.unwrap(expression);
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
        ) {
            if (this.emitExpression(context, unwrapped.left)) return true;
            return this.emitExpression(context, unwrapped.right);
        }
        if (ts.isVoidExpression(unwrapped)) {
            const operand = context.unwrap(unwrapped.expression);
            if (
                ts.isIdentifier(operand) ||
                operand.kind === ts.SyntaxKind.ThisKeyword
            ) {
                // Reading these values has no observable side effect. This is
                // the conventional `void unusedParameter;` spelling as well
                // as the JavaScript equivalent of an intentionally discarded
                // literal, so there is no native statement to emit.
                return;
            }
            // `void call()` preserves the call's side effects and discards
            // only its value. At a statement boundary the value was already
            // unused, so lower the operand through the same statement path.
            return this.emitExpression(context, operand);
        }
        if (ts.isConditionalExpression(unwrapped)) {
            this.emitConditionalStatement(context, unwrapped);
            return;
        }
        if (ts.isDeleteExpression(unwrapped)) {
            context.emitDelete(unwrapped);
            return;
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            isLogicalAssignmentOperator(unwrapped.operatorToken.kind)
        ) {
            if (context.emitWindowLogicalAssignment(unwrapped)) return;
            context.dataLowerer.emitLogicalAssignment(unwrapped);
            return;
        }
        const assignmentOperator = ts.isBinaryExpression(unwrapped)
            ? ASSIGNMENT_OPERATORS.get(unwrapped.operatorToken.kind)
            : undefined;
        if (
            ts.isBinaryExpression(unwrapped) &&
            assignmentOperator !== undefined
        ) {
            if (ts.isIdentifier(unwrapped.left)) {
                const target = context.bindings.lookup(unwrapped.left);
                const operator = assignmentOperator;
                if (
                    operator === "=" &&
                    context.emitOptionalResourceAssignment(unwrapped, target)
                ) {
                    return;
                }
                const rightExpression = context.unwrap(unwrapped.right);
                if (target.kind === "pending-let" && operator === "=") {
                    // `let set;` bound by its first assignment: a
                    // compile-time record, in the declaring scope.
                    context.bindings.bindPendingLet(
                        unwrapped.left,
                        context.compileValue(unwrapped.right),
                    );
                    return;
                }
                if (
                    target.kind === "number" &&
                    operator === "=" &&
                    ts.isCallExpression(rightExpression) &&
                    context.browserErasure.isDeferredCallbackCall(
                        rightExpression,
                    )
                ) {
                    const scheduled = context.compileValue(rightExpression);
                    if (scheduled.kind === "void") {
                        if (scheduled.cpp)
                            context.emit({
                                kind: "expression",
                                code: `${scheduled.cpp};`,
                            });
                        return;
                    }
                    context.expectKind(scheduled, "number", rightExpression);
                    context.emit({
                        kind: "expression",
                        code: `${target.cpp} = ${scheduled.cpp};`,
                    });
                    return;
                }
                if (target.kind === "number") {
                    const right = context.compileNumber(
                        unwrapped.right,
                        "double",
                    );
                    context.emit({
                        kind: "expression",
                        code: this.numericAssignmentCpp(
                            context,
                            target.cpp,
                            operator,
                            right,
                        ),
                    });
                } else if (target.kind === "boolean" && operator === "=") {
                    context.emit({
                        kind: "expression",
                        code: `${target.cpp} = ${context.conditions.compileCondition(unwrapped.right)};`,
                    });
                } else if (operator === "+=" && isStringValue(target)) {
                    emitStringAppend(context, target.cpp, unwrapped.right);
                } else if (target.kind === "string" && operator === "=") {
                    const value = context.compileValue(unwrapped.right);
                    if (!isStringValue(value)) {
                        context.fail(
                            unwrapped.right,
                            `String assignment requires a string, received ${value.kind}.`,
                        );
                    }
                    context.emit({
                        kind: "expression",
                        code: `${target.cpp} = ${value.cpp};`,
                    });
                } else if (target.kind === "audio-node" && operator === "=") {
                    const value = context.compileValue(unwrapped.right);
                    context.expectKind(value, "audio-node", unwrapped.right);
                    context.emit({
                        kind: "expression",
                        code: `${target.cpp} = ${value.cpp};`,
                    });
                } else if (
                    (target.kind === "data" || target.kind === "promise") &&
                    operator === "=" &&
                    context.dataLowerer.emitAssignment(unwrapped)
                ) {
                    return;
                } else if (
                    isHandleKind(target.kind) &&
                    operator === "=" &&
                    unwrappedIdentifier(unwrapped.left, (wrapped) =>
                        context.unwrap(wrapped),
                    ) !== undefined &&
                    context.unwrap(unwrapped.right).kind !==
                        ts.SyntaxKind.NullKeyword
                ) {
                    // Point a handle name at a different handle of the
                    // same kind; `rebindVariable` carries what that means.
                    // A nullable handle the source guarded is that handle.
                    const right = context.dataLowerer.narrowOptional(
                        context.compileValue(unwrapped.right),
                        unwrapped.right,
                    );
                    if (right.kind !== target.kind) {
                        context.fail(
                            unwrapped.right,
                            `A ${target.kind} name takes another ` +
                                `${target.kind}, received ${right.kind}.`,
                        );
                    }
                    context.emit({
                        kind: "expression",
                        code: `${target.cpp} = ${right.cpp};`,
                    });
                    const leftName = unwrappedIdentifier(
                        unwrapped.left,
                        (wrapped) => context.unwrap(wrapped),
                    );
                    if (leftName)
                        context.bindings.rebindVariable(leftName, right);
                    return;
                } else if (
                    target.kind === "json-null" &&
                    operator === "=" &&
                    (context.browserErasure.isBrowserOnlyExpression(
                        unwrapped.right,
                    ) ||
                        context.unwrap(unwrapped.right).kind ===
                            ts.SyntaxKind.NullKeyword)
                ) {
                    // Browser timer ids exist only to cancel their browser
                    // timers. When the timer call itself erases, its nullable
                    // bookkeeping erases with it.
                    return;
                } else {
                    context.fail(
                        unwrapped.left,
                        `Assignment operator '${operator}' is not supported for ${target.kind}.`,
                    );
                }
            } else if (
                assignmentOperator === "=" &&
                ts.isArrayLiteralExpression(unwrapped.left) &&
                !ts.isArrayLiteralExpression(context.unwrap(unwrapped.right))
            ) {
                if (
                    !context.dataLowerer.emitArrayDestructuringAssignment(
                        unwrapped,
                    )
                )
                    this.emitTupleResourceAssignment(context, unwrapped);
            } else {
                context.emitAssignment(unwrapped);
            }
            return;
        }
        if (isUpdateExpression(unwrapped)) {
            if (ts.isIdentifier(unwrapped.operand)) {
                const target = context.bindings.lookup(unwrapped.operand);
                context.expectKind(target, "number", unwrapped.operand);
                const operator =
                    unwrapped.operator === ts.SyntaxKind.PlusPlusToken
                        ? "++"
                        : "--";
                context.emit({
                    kind: "expression",
                    code: ts.isPrefixUnaryExpression(unwrapped)
                        ? `${operator}${target.cpp};`
                        : `${target.cpp}${operator};`,
                });
                return;
            }
            if (
                ts.isPostfixUnaryExpression(unwrapped) &&
                context.emitDataPostfix(unwrapped)
            ) {
                return;
            }
            if (ts.isPrefixUnaryExpression(unwrapped)) {
                context.emitDiscardedValue(context.compileValue(unwrapped));
                return;
            }
        }
        if (
            ts.isCallExpression(unwrapped) &&
            this.emitMemberSetCall(context, unwrapped)
        ) {
            return;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            this.emitTransformNodeChildPush(context, unwrapped)
        ) {
            return;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            this.emitTaskMethodCall(context, unwrapped)
        ) {
            return;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            context.emitPlatformEventListener(unwrapped)
        ) {
            return;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            context.isBrowserInstrumentationCall(unwrapped)
        ) {
            context.eraseBrowserInstrumentation(unwrapped.pos);
            return;
        }
        if (context.engineLifecycle.isBoundedNestedFrameYield(unwrapped)) {
            // The exact two-RAF Promise carries no value and no callback may
            // interleave, so its continuation can stay in the native tail.
            // Its settling time still gates capture: the frame conductor
            // must draw the CPU mutation that follows before taking the
            // screenshot which `dataset.ready` guarded upstream.
            context.emit({
                kind: "expression",
                code:
                    `bbl::defer_capture_until(` +
                    `${context.requireDefaultEngine(unwrapped)}, ` +
                    `[frames = 0u]() mutable { ` +
                    `return ++frames >= 2u; });`,
            });
            return;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            context.engineLifecycle.isFrameYield(unwrapped)
        ) {
            // A zero-argument helper can carry the same one-frame Promise.
            // Recognize it before ordinary call inlining reaches the
            // browser-only constructor in the helper's return expression.
            if (
                frameYieldInsideLoop(unwrapped, this.staticIterationCompletions)
            ) {
                context.fail(
                    unwrapped,
                    "A frame yield inside a loop is a multi-frame wait, " +
                        "which this runtime does not lower; it renders the " +
                        "frame the scene asks for, not a count of them.",
                );
            }
            context.engineLifecycle.emitFrameYieldRequeue(unwrapped);
            return;
        }
        if (ts.isCallExpression(unwrapped)) {
            if (
                ts.isAwaitExpression(expression) &&
                context.engineLifecycle.emitFramePollAwait(unwrapped)
            )
                return;
            const value = context.compileValue(unwrapped);
            context.emitDiscardedValue(value);
            return value.abruptCompletion;
        }
        if (ts.isAwaitExpression(expression)) {
            // `await <promise a scene callback resolves>`. Unlike the
            // frame waits below, nothing here counts boundaries: the
            // scene installed the callback that ends the wait, so the
            // rest of the continuation is parked until it runs.
            const latch =
                context.engineLifecycle.promiseLatchCondition(unwrapped);
            if (latch) {
                context.engineLifecycle.emitStartContinuationGate(
                    unwrapped,
                    latch,
                );
                return;
            }
        }
        if (ts.isNewExpression(unwrapped)) {
            // A constructed instance the source discards. It stays ahead of
            // nothing else: `await new Promise(...)` is a frame wait the
            // drain below owns, and only a local class reaches here.
            if (context.constructsLocalClass(unwrapped)) {
                const value = context.compileValue(unwrapped);
                if (value.cpp.length > 0) {
                    context.emit({
                        kind: "expression",
                        code: `static_cast<void>(${value.cpp});`,
                    });
                }
                return;
            }
        }
        const drain = context.browserErasure.frameDrainCondition(unwrapped);
        if (drain) {
            // A bounded multi-frame wait, which the single-frame yield
            // below deliberately refuses to stand in for. The condition is
            // the scene's own and it holds off the capture, because
            // upstream it holds off `canvas.dataset.ready` and the harness
            // screenshots on that.
            context.emit({
                kind: "expression",
                code:
                    `bbl::defer_capture_until(` +
                    `${context.requireDefaultEngine(unwrapped)}, ` +
                    `[&]() { return ` +
                    `${context.conditions.compileCondition(drain)}; });`,
            });
            return;
        }
        if (context.engineLifecycle.isFrameYield(unwrapped)) {
            // Before the frame loop exists, one frame's work has already
            // happened by the time this runtime reaches the statement after
            // it, so the yield erases; inside the hoisted continuation the
            // re-queue below keeps that claim true. A RUNTIME loop of these
            // is a different claim -- "let N frames elapse" -- and erasing
            // each iteration would silently turn it into none, so it
            // refuses; a written-out one is N sequential yields.
            if (
                frameYieldInsideLoop(unwrapped, this.staticIterationCompletions)
            ) {
                context.fail(
                    unwrapped,
                    "A frame yield inside a loop is a multi-frame wait, " +
                        "which this runtime does not lower; it renders the " +
                        "frame the scene asks for, not a count of them.",
                );
            }
            context.engineLifecycle.emitFrameYieldRequeue(unwrapped);
            return;
        }
        // `await <barrier property>` -- a read whose only meaning is the
        // wait, which this runtime satisfies by construction. Compiled
        // rather than skipped so the property still has to exist and the
        // owner still has to be the right kind; a value that names no
        // native expression (a barrier, a container's own list) discards
        // to nothing, as `emitDiscardedValue` discards it anywhere else.
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const value = context.compileValue(unwrapped);
            if (value.cpp.length === 0) {
                return;
            }
        }
        // Any supported value expression can be evaluated for effects alone,
        // including the value of a return in a contextually void function.
        context.emitDiscardedValue(context.compileValue(unwrapped));
    }

    /** Assigns a tuple result to definite-assignment resource bindings. */
    private emitTupleResourceAssignment(
        context: StatementLoweringContext,
        expression: ts.BinaryExpression,
    ): void {
        const left = context.unwrap(expression.left);
        if (!ts.isArrayLiteralExpression(left)) {
            context.fail(left, "Tuple assignment requires an array target.");
        }
        const value = context.compileValue(expression.right);
        if (
            value.kind !== "tuple" ||
            !value.tupleElements ||
            value.tupleElements.length !== left.elements.length
        ) {
            context.fail(
                expression.right,
                "Array destructuring assignment requires a matching tuple-producing expression.",
            );
        }
        const targets = left.elements.map((element) => {
            if (!ts.isIdentifier(element)) {
                context.fail(
                    element,
                    "Tuple resource assignment supports identifier targets.",
                );
            }
            const target = context.bindings.lookup(element);
            if (!target.optionalStorageCpp) {
                context.fail(
                    element,
                    "Tuple resource assignment requires predeclared resource storage.",
                );
            }
            return { identifier: element, value: target };
        });
        const temporaries = value.tupleElements.map((element, index) => {
            const target = targets[index]!.value;
            if (element.kind !== target.kind) {
                context.fail(
                    expression.right,
                    `Tuple resource target expects ${target.kind}, received ${element.kind}.`,
                );
            }
            const name = context.allocateTemporaryCppName(
                "destructure_resource",
            );
            context.emit({
                kind: "declaration",
                type: "const auto",
                name: name,
                initializer: element.cpp,
            });
            return { ...element, cpp: name };
        });
        targets.forEach((target, index) => {
            context.assignOptionalResourceValue(
                target.value,
                temporaries[index]!,
                target.identifier,
            );
        });
    }

    private numericAssignmentCpp(
        context: StatementLoweringContext,
        target: string,
        operator: string,
        right: string,
    ): string {
        const helper = COMPOUND_ASSIGNMENT_HELPERS.get(operator);
        if (!helper) {
            return `${target} ${operator} ${right};`;
        }
        context.reachJsData();
        return `${target} = bbl::js::${helper}(${target}, ${right});`;
    }

    private emitCameraVectorSet(
        context: StatementLoweringContext,
        call: ts.CallExpression,
        vector: NonNullable<Value["cameraVector"]>,
    ): boolean {
        if (call.arguments.length !== 3)
            context.fail(
                call,
                "Camera vector.set expects exactly three numeric arguments.",
            );
        context.admissions.noteCameraVectorSet(vector, call);
        const handle = context.allocateTemporaryCppName("camera_set_owner");
        context.emit({
            kind: "declaration",
            type: "const auto",
            name: handle,
            initializer: vector.owner.cpp,
        });
        const values = call.arguments.map((argument) => {
            const value = context.allocateTemporaryCppName("camera_set_value");
            context.emit({
                kind: "declaration",
                type: "const double",
                name: value,
                initializer: context.compileNumber(argument, "double"),
            });
            return value;
        });
        context.emit({
            kind: "expression",
            code: `bbl::set_camera_vector(${recordAt(`${vector.owner.engineCpp}.cameras`, handle)}, &bbl::CameraRecord::${vector.field}, bbl::Vec3d{${values.join(", ")}});`,
        });
        return true;
    }

    private emitMemberSetCall(
        context: StatementLoweringContext,
        call: ts.CallExpression,
    ): boolean {
        if (
            !ts.isPropertyAccessExpression(call.expression) ||
            call.expression.name.text !== "set"
        ) {
            return false;
        }
        const owner = call.expression.expression;
        const cameraAlias = context.resolveRecordValue(owner)?.cameraVector;
        if (cameraAlias)
            return this.emitCameraVectorSet(context, call, cameraAlias);
        const alias = ts.isIdentifier(owner)
            ? context.bindings.lookupOptional(owner)?.sceneNodeVector
            : undefined;
        if (alias) {
            return this.emitSceneNodeVectorSet(
                context,
                call,
                alias.owner,
                alias.transform,
            );
        }
        if (!ts.isPropertyAccessExpression(owner)) {
            return false;
        }
        // Value compilation also applies the checker's non-null narrowing
        // to a handle destructured from a retained record.
        const target = context.compileValue(owner.expression);
        if (
            target.kind === "camera" &&
            ["position", "target", "upVector"].includes(owner.name.text)
        ) {
            return this.emitCameraVectorSet(context, call, {
                owner: {
                    ...target,
                    engineCpp: context.requireEngine(target, call),
                },
                field:
                    owner.name.text === "upVector"
                        ? "up_vector"
                        : owner.name.text === "position"
                          ? "position"
                          : "target",
            });
        }
        if (target.kind === "light") {
            return this.compileLightVectorSet(context, call, owner, target);
        }
        const transform = sceneNodeTransformDescriptor(owner.name.text);
        return transform
            ? this.emitSceneNodeVectorSet(context, call, target, transform)
            : false;
    }

    private emitSceneNodeVectorSet(
        context: StatementLoweringContext,
        call: ts.CallExpression,
        target: Value,
        transform: SceneNodeTransformDescriptor,
    ): boolean {
        if (target.kind === "asset-root") {
            context.assetRegistry.assertAssetRootWritable(target, call);
            const components = this.setCallComponents(
                context,
                call,
                transform.components.length,
                transform.sourceProperty + ".set",
                "double",
            );
            context.emit({
                kind: "expression",
                code: `bbl::${transform.assetSetter}(${context.requireEngine(target, call)}, ${target.cpp}, bbl::${components.length === 4 ? "Vec4d" : "Vec3d"}{${components.join(", ")}});`,
            });
            return true;
        }
        if (target.kind === "transform-node" || target.kind === "scene-node") {
            // A node's TRS lanes are the same ObservableVec3/ObservableQuat
            // a mesh's are -- upstream a TransformNode IS a SceneNode -- so
            // each write moves the field and marks the node's local matrix
            // dirty. The version bump is what a child re-bakes against.
            if (target.kind === "scene-node") {
                context.reachFeature("scene:node-transforms", call);
            }
            const targetCpp =
                target.kind === "scene-node"
                    ? context.bindings.retainedValue(
                          target,
                          "scene_node_transform_target",
                      ).cpp
                    : target.cpp;
            const vector = `${transform.cppType}{${this.setCallComponents(
                context,
                call,
                transform.components.length,
                `${transform.sourceProperty}.set`,
                transform.precision,
            ).join(", ")}}`;
            context.emit({
                kind: "expression",
                code:
                    `bbl::${
                        target.kind === "scene-node"
                            ? transform.sceneNodeSetter
                            : transform.transformNodeSetter
                    }(` +
                    `${context.requireEngine(target, call)}, ` +
                    `${targetCpp}, ${vector});`,
            });
            return true;
        }
        if (target.kind !== "mesh") {
            return false;
        }
        const components = this.setCallComponents(
            context,
            call,
            transform.components.length,
            `${transform.sourceProperty}.set`,
            transform.precision,
        );
        const vector = `${transform.cppType}{${components.join(", ")}}`;
        const engine = context.requireEngine(target, call);
        if (transform.meshSetter) {
            context.emit({
                kind: "expression",
                code:
                    `bbl::${transform.meshSetter}(` +
                    `${engine}, ${target.cpp}, ${vector});`,
            });
            return true;
        }
        context.emit({
            kind: "expression",
            code:
                `${recordAt(`${engine}.meshes`, target.cpp)}.` +
                `${transform.nativeField} = ${vector};`,
        });
        // The world-matrix state's `markLocalDirty`, pushed through the
        // subtree the parent setter registered.
        context.emit({
            kind: "expression",
            code: `bbl::mark_mesh_dirty(${engine}, ${target.cpp});`,
        });
        return true;
    }

    /**
     * `light.position.set(x, y, z)` and `light.direction.set(...)`.
     *
     * Both vectors are `ObservableVec3` upstream, so a write does two
     * things: it moves the field and it marks the light's local matrix
     * dirty, which the next read rebuilds. The emitted entry point is
     * that pair, lowered beside its own kind's factory from the pin's
     * own local-matrix closure — the compiler names the kind because it
     * already knows it, so a scene reaching no light of a kind links no
     * setter for it.
     *
     * Which vectors a kind carries is `assignments.ts`'s table, beside the
     * scalar and colour properties it already owns for the same four kinds;
     * a vector no reached scene writes stays unlowered and fails by name
     * rather than moving a record field nothing rebuilds from.
     */
    private compileLightVectorSet(
        context: StatementLoweringContext,
        call: ts.CallExpression,
        owner: ts.PropertyAccessExpression,
        target: Value,
    ): boolean {
        const property = owner.name.text;
        if (property !== "position" && property !== "direction") {
            return false;
        }
        if (!target.lightKind) {
            // A light read out of the data model carries no static kind, and
            // the entry point is named by it. Nothing reached asks for this,
            // so it takes the generic unsupported-statement path rather than
            // a message that would name the wrong cause.
            return false;
        }
        const setter = lightSetter(target, property, "vector");
        if (!setter) {
            context.fail(
                call,
                `A ${target.lightKind} light has no '${property}' to set.`,
            );
        }
        const components = this.setCallComponents(
            context,
            call,
            3,
            `${property}.set`,
        );
        context.emit({
            kind: "expression",
            code:
                `bbl::${setter}(` +
                `${context.requireEngine(target, call)}, ` +
                `${target.cpp}, ` +
                `bbl::Vec3{${components.join(", ")}});`,
        });
        return true;
    }

    /**
     * The numeric components a `.set` call passes.
     *
     * A caller may write them out, or spread a tuple a helper returned —
     * which is a plain-data `bbl::js::Tuple<N>`, so the spread binds it once
     * and indexes it rather than evaluating the call per component.
     */
    private setCallComponents(
        context: StatementLoweringContext,
        call: ts.CallExpression,
        arity: number,
        label: string,
        // A translation is a JavaScript number upstream and reaches a
        // matrix column, so its lane is double where a rotation's and a
        // scale's are float.
        precision?: "float" | "double",
    ): string[] {
        if (
            call.arguments.length === 1 &&
            ts.isSpreadElement(argumentAt(call, 0))
        ) {
            const spread = call.arguments[0] as ts.SpreadElement;
            const value = context.compileValue(spread.expression);
            if (
                value.kind === "tuple" &&
                value.tupleElements?.length === arity &&
                value.tupleElements.every(
                    (element) => element.kind === "number",
                )
            ) {
                return value.tupleElements.map((element) =>
                    precision === "float"
                        ? `static_cast<float>(${element.cpp})`
                        : element.cpp,
                );
            }
            if (!isDataTuple(value, arity)) {
                context.fail(
                    spread,
                    `${label} spreads a value that is not a ${arity}-element numeric tuple.`,
                );
            }
            const components = tupleComponents(
                context.bindings.bindDataTuple(value, arity, "spread"),
                arity,
            );
            return precision === "float"
                ? components.map(
                      (component) => `static_cast<float>(${component})`,
                  )
                : components;
        }
        if (call.arguments.length !== arity) {
            context.fail(
                call,
                `${label} expects exactly ${arity} numeric arguments.`,
            );
        }
        return call.arguments.map((argument) =>
            context.compileNumber(argument, precision),
        );
    }

    /**
     * `node.children.push(child)`, the traversal half of a reparent.
     *
     * The pin keeps the two halves apart and says so: a direct
     * `child.parent = node` write "drives the transform math but does not
     * touch `children`", and `setParent` is what syncs both. So a scene
     * that writes the link and pushes the child is performing two
     * operations, and this is the second -- the list `collectMeshes`, the
     * visibility cascade and cloning walk. SceneNode.children is one ordered
     * mixed list, so mesh and transform-node entries share this path.
     */
    private emitTransformNodeChildPush(
        context: StatementLoweringContext,
        call: ts.CallExpression,
    ): boolean {
        if (
            !ts.isPropertyAccessExpression(call.expression) ||
            call.expression.name.text !== "push" ||
            !ts.isPropertyAccessExpression(call.expression.expression) ||
            call.expression.expression.name.text !== "children"
        ) {
            return false;
        }
        const node = context.compileValue(
            call.expression.expression.expression,
        );
        if (node.kind !== "transform-node" && node.kind !== "mesh") {
            return false;
        }
        context.expectArgumentCount(call, 1, 1);
        const child = context.compileValue(argumentAt(call, 0));
        // MeshRecord::children is a mesh list -- the visibility cascade
        // that walks it takes a MeshHandle -- while a transform node's is
        // the pin's own mixed list. So what a receiver accepts is a
        // question about the record that holds the list, and a transform
        // node pushed under a mesh names a record this port does not have
        // rather than a call it declines.
        const accepted =
            node.kind === "mesh" ? ["mesh"] : ["mesh", "transform-node"];
        if (!accepted.includes(child.kind)) {
            context.fail(
                argumentAt(call, 0),
                `${node.kind === "mesh" ? "Mesh" : "TransformNode"} ` +
                    "children.push supports exactly " +
                    `${accepted.join(" and ")} values, ` +
                    `received ${child.kind}.`,
            );
        }
        context.expectSameEngine(node, child, call);
        if (node.kind === "mesh") {
            context.reachFeature("mesh:parenting", call);
            context.emit({
                kind: "expression",
                code:
                    `bbl::push_mesh_child(` +
                    `${context.requireEngine(node, call)}, ` +
                    `${node.cpp}, ${child.cpp});`,
            });
            return true;
        }
        context.emit({
            kind: "expression",
            code:
                `bbl::push_transform_node_child(` +
                `${context.requireEngine(node, call)}, ` +
                `${node.cpp}, ${child.cpp});`,
        });
        return true;
    }

    private emitTaskMethodCall(
        context: StatementLoweringContext,
        call: ts.CallExpression,
    ): boolean {
        const exported =
            context.symbols.importedName(call.expression) === "addMeshToTask";
        const member = ts.isPropertyAccessExpression(call.expression)
            ? call.expression
            : undefined;
        if (!exported && (!member || !ts.isIdentifier(member.expression)))
            return false;
        const method = exported ? "addMesh" : member!.name.text;
        if (method !== "addMesh" && method !== "updateUniforms") {
            return false;
        }
        const task = context.compileValue(
            exported ? argumentAt(call, 0) : member!.expression,
        );
        if (task.kind !== "task") {
            return false;
        }
        if (method === "updateUniforms") {
            if (!task.postProcessTask && !task.postProcessComposite) {
                context.fail(
                    call,
                    "updateUniforms is a post-process pass method.",
                );
            }
            context.expectArgumentCount(call, 0, 0);
            // The pin recomputes the pass's uniform block and uploads it;
            // native marks the record so the backend rewrites it from the
            // parameters before the next frame it records.
            context.emit({
                kind: "expression",
                code: `bbl::update_post_process_uniforms(${context.requireEngine(task, call)}, ${task.cpp});`,
            });
            return true;
        }
        const offset = exported ? 1 : 0;
        context.expectArgumentCount(call, 1 + offset, 2 + offset);
        const mesh = context.compileValue(argumentAt(call, offset));
        context.expectKind(mesh, "mesh", argumentAt(call, offset));
        context.expectSameEngine(task, mesh, call);
        const engine = context.requireEngine(task, call);
        // The pin's own `opts.material ?? mesh.material`: a call with no
        // override draws the mesh with the material it already carries.
        let materialCpp = `${recordAt(`${engine}.meshes`, mesh.cpp)}.material`;
        let materialOverride = false;
        if (call.arguments.length === 2 + offset) {
            const options = context.expectObjectLiteral(
                argumentAt(call, 1 + offset),
            );
            const materialExpression = context.objectProperty(
                options,
                "material",
            );
            if (!materialExpression || options.properties.length !== 1) {
                context.fail(
                    options,
                    "Reached RenderTask.addMesh requires only a material override.",
                );
            }
            const material = context.compileValue(materialExpression);
            context.expectKind(material, "material", materialExpression);
            context.expectSameEngine(task, material, call);
            materialCpp = material.cpp;
            materialOverride = true;
        }
        context.emit({
            kind: "expression",
            code: `bbl::add_render_task_mesh(${engine}, ${task.cpp}, ${mesh.cpp}, ${materialCpp}, ${materialOverride});`,
        });
        return true;
    }
}

/**
 * True when a branch always leaves the surrounding iteration or
 * function, so code after the branch never observes its effects.
 */
/** Whether a case clause leaves the switch at its end instead of falling on. */
function switchClauseCompletes(clause: ts.CaseOrDefaultClause): boolean {
    const last = clause.statements.at(-1);
    return last !== undefined && terminatesFlow(last);
}

/** The non-empty clauses a match at `start` runs: through one that completes. */
function switchFallthroughRun(
    clauses: readonly ts.CaseOrDefaultClause[],
    start: number,
): ts.CaseOrDefaultClause[] {
    const run: ts.CaseOrDefaultClause[] = [];
    for (const clause of clauses.slice(start)) {
        if (clause.statements.length === 0) continue;
        run.push(clause);
        if (switchClauseCompletes(clause)) break;
    }
    return run;
}

function terminatesFlow(
    statement: ts.Statement,
    lowered: (node: ts.Statement) => boolean = () => false,
    breakLeaves = true,
): boolean {
    if (
        lowered(statement) ||
        ts.isContinueStatement(statement) ||
        ts.isReturnStatement(statement) ||
        ts.isThrowStatement(statement)
    ) {
        return true;
    }
    if (ts.isBreakStatement(statement)) return breakLeaves;
    if (ts.isBlock(statement)) {
        const last = statement.statements.at(-1);
        return last ? terminatesFlow(last, lowered, breakLeaves) : false;
    }
    if (ts.isIfStatement(statement)) {
        return (
            !!statement.elseStatement &&
            terminatesFlow(statement.thenStatement, lowered, breakLeaves) &&
            terminatesFlow(statement.elseStatement, lowered, breakLeaves)
        );
    }
    if (ts.isTryStatement(statement)) {
        return (
            (!!statement.finallyBlock &&
                terminatesFlow(statement.finallyBlock, lowered, breakLeaves)) ||
            (terminatesFlow(statement.tryBlock, lowered, breakLeaves) &&
                (!statement.catchClause ||
                    terminatesFlow(
                        statement.catchClause.block,
                        lowered,
                        breakLeaves,
                    )))
        );
    }
    const endlessLoop =
        ts.isWhileStatement(statement) || ts.isDoStatement(statement)
            ? statement.expression.kind === ts.SyntaxKind.TrueKeyword
                ? statement
                : undefined
            : ts.isForStatement(statement) &&
                (statement.condition === undefined ||
                    statement.condition.kind === ts.SyntaxKind.TrueKeyword)
              ? statement
              : undefined;
    if (endlessLoop) {
        // `while (true)` / `for (;;)` is left only by a `break`; without one
        // the code after it never runs.
        return !enclosingLoopControl(endlessLoop.statement, {
            continues: false,
        });
    }
    if (ts.isSwitchStatement(statement)) {
        // Every path leaves when a `default` exists and each clause ends
        // in control that leaves: an empty clause falls into the next one,
        // and a `break` there leaves only the switch itself.
        const clauses = statement.caseBlock.clauses;
        return (
            clauses.some(ts.isDefaultClause) &&
            clauses.every((clause, index) => {
                const last = clause.statements.at(-1);
                return last
                    ? terminatesFlow(last, lowered, false)
                    : index < clauses.length - 1;
            })
        );
    }
    return false;
}

/**
 * Whether nothing would run after this statement anyway.
 *
 * A bare `return` that trails its whole body is the statement the body
 * would have ended with, so it drops. Anywhere else it is control flow --
 * an early exit guarding what follows -- and dropping it keeps the
 * guarded statements while removing the guard. That reads as a working
 * scene and is not one.
 *
 * The walk climbs out of every construct, not just blocks: a `return`
 * that is last inside an `if` is NOT last in the body, because the
 * statements after the `if` still run. A `return` anywhere inside a loop
 * is control flow whatever its position, since it exits the loop as well.
 */
function isTrailingStatement(statement: ts.Statement): boolean {
    let node: ts.Node = statement;
    for (;;) {
        const parent: ts.Node | undefined = node.parent;
        if (!parent) {
            return true;
        }
        if (
            ts.isFunctionDeclaration(parent) ||
            ts.isFunctionExpression(parent) ||
            ts.isArrowFunction(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isSourceFile(parent)
        ) {
            return true;
        }
        if (ts.isBlock(parent)) {
            const statements = parent.statements;
            if (statements[statements.length - 1] !== node) {
                return false;
            }
            node = parent;
            continue;
        }
        // Leaving a loop early is control flow at any position.
        if (ts.isIterationStatement(parent, false)) {
            return false;
        }
        if (
            ts.isIfStatement(parent) ||
            ts.isLabeledStatement(parent) ||
            ts.isTryStatement(parent) ||
            ts.isCaseClause(parent) ||
            ts.isDefaultClause(parent) ||
            ts.isCaseBlock(parent) ||
            ts.isSwitchStatement(parent)
        ) {
            node = parent;
            continue;
        }
        // An enclosing construct this walk does not model: refuse rather
        // than assume the return is inert.
        return false;
    }
}
