import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import { emitParticleAliveGuard } from "./particle-buffer.js";
import {
    isHandleKind,
    isDataTuple,
    tupleComponents,
    type DataIterationElement,
    type DataType,
} from "./data-types.js";
import type {
    CompileAsset,
    CompiledNodeParticles,
    Value,
    ValueKind,
} from "./types.js";
import { isTrsVectorName, lightVectorSetter } from "./assignments.js";
// The handle-collection concept owns the collection targets, the loop
// frame, and the recursive imported-mesh walk proof; the emitters here are
// the statement layer over the same resolutions.
import {
    emitHandleCollectionLoop,
    isRecursiveImportedMeshWalk,
    type HandleCollections,
    type HandleCollectionTarget,
} from "./handle-collections.js";

export interface StatementLoweringContext {
    /** The scene node-particle program; a buffer guard lands on it. */
    readonly reachedNodeParticles: CompiledNodeParticles;
    /** The handle-collection concept: every collection operation. */
    readonly handleCollections: HandleCollections;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    resolveStaticExpression(expression: ts.Expression): ts.Expression;
    /** Marks that a scene threw, so the generated main includes <stdexcept>. */
    reachThrow(): void;
    reachJsData(): void;
    cppString(value: string): string;
    emitDataAssignment(
        expression: ts.BinaryExpression,
    ): boolean;
    emitOptionalResourceAssignment(
        expression: ts.BinaryExpression,
        target: Value,
    ): boolean;
    emitDataPostfix(
        expression: ts.PostfixUnaryExpression,
    ): boolean;
    dataIterationTarget(
        expression: ts.Expression,
    ):
        | { container: Value; element: DataIterationElement }
        | undefined;
    assetEntitiesIterationTarget(
        expression: ts.Expression,
    ): Value | undefined;
    assetFlattenedMeshesIterationTarget(
        expression: ts.Expression,
    ):
        | { target: HandleCollectionTarget; asset: CompileAsset }
        | undefined;
    assetRootChildrenIterationTarget(
        expression: ts.Expression,
    ): HandleCollectionTarget | undefined;
    isFoldedFlattenLoop(statement: ts.Statement): boolean;
    handleCollectionIterationTarget(
        expression: ts.Expression,
    ): HandleCollectionTarget | undefined;
    bindDataIterationVariable(
        name: ts.BindingName,
        itemCpp: string,
        element: DataIterationElement,
    ): void;
    activeNativeReturnType():
        | DataType
        | "void"
        | undefined;
    activeInlineWrapper(): boolean;
    emitNativeReturn(
        statement: ts.ReturnStatement,
    ): void;
    /** The dirty entry appropriate to startup code or a live callback. */
    meshTransformDirtyEntry():
        | "mark_mesh_dirty"
        | "mark_mesh_runtime_transform";
    captureEmittedLines(emitBody: () => void): string[];
    /**
     * Runs a shape probe, keeping what it emitted only when it answers.
     * A probe that resolves a call compiles it, so one that declines has
     * to take its emission with it.
     */
    probeEmission<T>(
        probe: () => T,
        answered: (result: T) => boolean,
    ): T;
    allocateTemporaryCppName(label: string): string;
    bindDataTuple(
        value: Value,
        arity: number,
        label?: string,
    ): string;
    emitVariableDeclaration(
        declaration: ts.VariableDeclaration,
    ): void;
    emitAssignment(expression: ts.BinaryExpression): void;
    compileValue(expression: ts.Expression): Value;
    compileCondition(expression: ts.Expression): string;
    isBrowserOnlyExpression(expression: ts.Expression): boolean;
    isDeferredCallbackCall(call: ts.CallExpression): boolean;
    isDefaultLibraryIdentifier(identifier: ts.Identifier): boolean;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileEnumSwitchLabel(
        expression: ts.Expression,
        dataType: DataType & { kind: "enum" },
    ): string | undefined;
    expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression;
    probeStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined;
    bindLocalValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    bindCompileTimeValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    lookup(identifier: ts.Identifier): Value;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
    expectSameEngine(
        left: Value,
        right: Value,
        node: ts.Node,
    ): void;
    requireEngine(value: Value, node: ts.Node): string;
    assertAssetRootWritable(root: Value, node: ts.Node): void;
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    unwrap(expression: ts.Expression): ts.Expression;
    isFrameYield(expression: ts.Expression): boolean;
    /**
     * A frame yield lowered AFTER `startEngine` sits inside the hoisted
     * continuation, so "the frame's own work has already run" only stays
     * true if the statements after it wait for the NEXT frame boundary.
     * Emits the marker `hoistEngineContinuation` turns into a nested
     * re-queue; before the loop exists it emits nothing and the yield
     * stays erased.
     */
    emitFrameYieldRequeue(expression: ts.Expression): void;
    isBoundedNestedFrameYield(
        expression: ts.Expression,
    ): boolean;
    frameDrainCondition(
        expression: ts.Expression,
    ): ts.Expression | undefined;
    requireDefaultEngine(node: ts.Node): string;
    isBrowserInstrumentationCall(
        call: ts.CallExpression,
    ): boolean;
    emitPlatformEventListener(call: ts.CallExpression): boolean;
    eraseBrowserInstrumentation(position: number): void;
    /** Whether a loop body reaches pinned scene construction at generation. */
    requiresStaticIteration(statement: ts.Statement): boolean;
    snapshotAliasState(): Map<string, string>;
    restoreAliasState(snapshot: Map<string, string>): void;
    enterRuntimeControlFlow(): void;
    leaveRuntimeControlFlow(): void;
    isInRuntimeControlFlow(): boolean;
    emit(line: string): void;
    rebindVariable(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    increaseIndent(): void;
    decreaseIndent(): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateBlockPrefix(): string;
    fail(node: ts.Node, message: string): never;
}

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
    unrolled: readonly ts.IterationStatement[],
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
            if (!unrolled.includes(parent)) return true;
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
    let found = false;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (
            ts.isExpressionStatement(node) &&
            ts.isAwaitExpression(node.expression)
        ) {
            const awaited = context.unwrap(node.expression.expression);
            if (
                context.isFrameYield(awaited) ||
                context.isBoundedNestedFrameYield(awaited)
            ) {
                found = true;
                return;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(statement);
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

function isCppWordCharacter(character: string | undefined): boolean {
    return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

/**
 * Every stand-alone occurrence of one iteration's handle spelling in an
 * emitted line, replaced by the placeholder.
 *
 * "Stand-alone" is the identifier-boundary rule: a match whose word-shaped
 * edge touches another word character is part of a longer name —
 * `v_sphere1` inside `v_sphere17` — and is left alone. The replacement is
 * over the line's exact bytes, which is what makes the later uniformity
 * comparison a proof: two iterations are the same emission exactly when
 * their lines are equal after this substitution.
 */
function replaceHandleToken(line: string, token: string): string {
    let result = "";
    let from = 0;
    for (;;) {
        const found = line.indexOf(token, from);
        if (found === -1) {
            return result + line.slice(from);
        }
        const boundaryBefore = !(
            isCppWordCharacter(line[found - 1]) &&
            isCppWordCharacter(token[0])
        );
        const boundaryAfter = !(
            isCppWordCharacter(line[found + token.length]) &&
            isCppWordCharacter(token[token.length - 1])
        );
        if (boundaryBefore && boundaryAfter) {
            result += line.slice(from, found) + HANDLE_TOKEN_PLACEHOLDER;
            from = found + token.length;
        } else {
            result += line.slice(from, found + 1);
            from = found + 1;
        }
    }
}

// Small counted loops unroll because that keeps generation-known values
// available to scene composition. Large loops stay native when they are only
// data processing, but a body that reaches pinned scene construction must
// still run at generation: emitting such a body once inside C++ would record
// one AOT effect for many runtime iterations.
const MAX_STATIC_INDEX_ITERATIONS = 32;
const MAX_REQUIRED_STATIC_INDEX_ITERATIONS = 4096;
// A data-only nest can contain individually small loops whose Cartesian
// product is still large. Keep the outer layers native once that product
// exceeds the largest established static nest (16 * 16 * 4), so large
// voxel/grid walks do not duplicate their native inner body hundreds of
// times during compilation.
const MAX_DATA_STATIC_INDEX_NEST_PRODUCT = 1024;
// The per-loop caps above compose multiplicatively in a nest, and the
// generation-known-tuple `for...of` has no cap at all, so the emitted-text
// budget is the PRODUCT of every enclosing static unroll. Past this product
// the unrollers first run every iteration exactly as before — the
// generation-time effects of an unrolled body (handle facts, scene records,
// tuple growth) are the AOT model and must all still happen — and then fold
// the EMITTED TEXT into one native loop when the iterations' captured lines
// prove uniform. A body whose lines are not uniform keeps its unrolled
// emission byte for byte; nothing under this budget ever refuses.
const MAX_STATIC_UNROLL_PRODUCT = 256;
// Stands for the folded iteration's own handle spelling inside captured
// lines while they are compared and re-emitted. U+0001 cannot appear in
// emitted C++, so a replacement can never collide with scene text.
const HANDLE_TOKEN_PLACEHOLDER = "\u0001";
const BITWISE_ASSIGNMENT_HELPERS: Readonly<Record<string, string>> = {
    "&=": "bitwise_and",
    "|=": "bitwise_or",
    "^=": "bitwise_xor",
    "<<=": "shift_left",
    ">>=": "shift_right",
    ">>>=": "shift_right_unsigned",
};
const ASSIGNMENT_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
    [ts.SyntaxKind.EqualsToken, "="],
    [ts.SyntaxKind.PlusEqualsToken, "+="],
    [ts.SyntaxKind.MinusEqualsToken, "-="],
    [ts.SyntaxKind.AsteriskEqualsToken, "*="],
    [ts.SyntaxKind.SlashEqualsToken, "/="],
    [ts.SyntaxKind.AmpersandEqualsToken, "&="],
    [ts.SyntaxKind.BarEqualsToken, "|="],
    [ts.SyntaxKind.CaretEqualsToken, "^="],
    [ts.SyntaxKind.LessThanLessThanEqualsToken, "<<="],
    [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ">>="],
    [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ">>>="],
]);

/**
 * The control statement that would leave the enclosing loop, or undefined.
 *
 * Descent stops at a nested loop and at a function-like, because a control
 * statement there binds to that one; an unqualified `break` additionally
 * binds to a nested `switch`, so descent tracks that too. `returns` adds an
 * early `return`, which leaves the loop the same way for a caller folding
 * the loop away — the statement itself comes back so such a caller can
 * refuse at it by name.
 */
export function enclosingLoopControl(
    statement: ts.Statement,
    options: { returns?: boolean } = {},
): ts.Statement | undefined {
    let found: ts.Statement | undefined;
    const visit = (node: ts.Node, insideSwitch: boolean): void => {
        if (found) return;
        if (
            ts.isForStatement(node) ||
            ts.isWhileStatement(node) ||
            ts.isForOfStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isDoStatement(node) ||
            ts.isFunctionLike(node)
        ) {
            return;
        }
        if (ts.isBreakStatement(node)) {
            if (!insideSwitch) found = node;
            return;
        }
        if (ts.isContinueStatement(node)) {
            found = node;
            return;
        }
        if (options.returns && ts.isReturnStatement(node)) {
            found = node;
            return;
        }
        const nestedSwitch = insideSwitch || ts.isSwitchStatement(node);
        ts.forEachChild(node, (child) => visit(child, nestedSwitch));
    };
    visit(statement, false);
    return found;
}

export class StatementLowerer {
    private readonly loweredTerminators = new WeakSet<ts.Statement>();
    private readonly labels: Array<{ source: string; target: string }> = [];
    /** Source loops whose current iteration is being emitted statically. */
    private readonly staticUnrolledIterations: ts.IterationStatement[] = [];
    /**
     * The running product of enclosing static unroll counts. Each unroller
     * pushes its own count multiplied in, so a nested loop reads the number
     * of times its body will be emitted rather than only its own count.
     */
    private readonly staticUnrollProducts: number[] = [];

    /** How many times a body emitted here appears in the output. */
    private staticUnrollProduct(): number {
        return this.staticUnrollProducts.at(-1) ?? 1;
    }

    /** Runs one unroller's whole iteration sweep under its nest product. */
    private withStaticUnrollProduct<T>(
        iterations: number,
        emitIterations: () => T,
    ): T {
        this.staticUnrollProducts.push(
            this.staticUnrollProduct() * Math.max(1, iterations),
        );
        try {
            return emitIterations();
        } finally {
            this.staticUnrollProducts.pop();
        }
    }

    /**
     * Whether unrolling `iterations` more bodies here exceeds the emitted-
     * text budget. Exceeding it never refuses; it only licenses the
     * capture-and-fold attempt, whose fallback is today's emission.
     */
    private exceedsStaticUnrollBudget(iterations: number): boolean {
        return (
            iterations >= 2 &&
            iterations * this.staticUnrollProduct() >
                MAX_STATIC_UNROLL_PRODUCT
        );
    }

    /** Re-emits captured unrolled iterations exactly as they were emitted. */
    private emitCapturedIterations(
        context: StatementLoweringContext,
        captures: readonly (readonly string[])[],
    ): void {
        for (const lines of captures) {
            for (const line of lines) {
                context.emit(line);
            }
        }
    }

    /** Whether every capture matches the template's lines byte for byte. */
    private capturesAreIdentical(
        captures: readonly (readonly string[])[],
        template: readonly string[],
    ): boolean {
        return (
            template.length > 0 &&
            captures.every(
                (lines) =>
                    lines.length === template.length &&
                    lines.every(
                        (line, at) => line === template[at],
                    ),
            )
        );
    }

    /** Emits one native repeat loop around a proven-uniform template. */
    private emitRepeatedTemplate(
        context: StatementLoweringContext,
        count: number,
        templateLines: readonly string[],
    ): void {
        const counter =
            context.allocateTemporaryCppName("repeat_index");
        context.emit(
            `for (int ${counter} = 0; ${counter} < ${count}; ++${counter}) {`,
        );
        context.increaseIndent();
        for (const line of templateLines) {
            context.emit(line);
        }
        context.decreaseIndent();
        context.emit("}");
    }

    /** Compile one body whose effects occur only on a native runtime path. */
    private inRuntimeControlFlow<T>(
        context: StatementLoweringContext,
        emitBody: () => T,
    ): T {
        context.enterRuntimeControlFlow();
        try {
            return emitBody();
        } finally {
            context.leaveRuntimeControlFlow();
        }
    }

    /** Whether this continue binds one of the loops currently being unrolled. */
    private continueTargetsStaticIteration(
        statement: ts.ContinueStatement,
    ): boolean {
        for (
            let parent: ts.Node | undefined = statement.parent;
            parent;
            parent = parent.parent
        ) {
            if (ts.isFunctionLike(parent)) return false;
            if (ts.isIterationStatement(parent, false)) {
                return this.staticUnrolledIterations.includes(parent);
            }
        }
        return false;
    }

    /** Whether a subtree can continue one of the active static loops. */
    private containsStaticIterationContinue(statement: ts.Statement): boolean {
        let found = false;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (
                ts.isContinueStatement(node) &&
                !node.label &&
                this.continueTargetsStaticIteration(node)
            ) {
                found = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(statement);
        return found;
    }

    public terminatesAfterLowering(statement: ts.Statement): boolean {
        return (
            terminatesFlow(statement) ||
            this.loweredTerminators.has(statement)
        );
    }

    public emit(
        context: StatementLoweringContext,
        statement: ts.Statement,
    ): void {
        if (context.isFoldedFlattenLoop(statement)) {
            // The declaration above it already answered with the
            // container's flattened meshes; the loop that filled the list
            // is the other half of that one construct.
            return;
        }
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement
                .declarationList.declarations) {
                context.emitVariableDeclaration(declaration);
            }
            return;
        }
        if (ts.isExpressionStatement(statement)) {
            this.emitExpression(
                context,
                statement.expression,
            );
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
        if (ts.isForStatement(statement)) {
            this.emitFor(context, statement);
            return;
        }
        if (ts.isDoStatement(statement)) {
            this.emitDo(context, statement);
            return;
        }
        if (ts.isWhileStatement(statement)) {
            this.emitWhile(context, statement);
            return;
        }
        if (ts.isForOfStatement(statement)) {
            this.emitForOf(context, statement);
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
            this.labels.push({ source: statement.label.text, target });
            try {
                this.emit(context, statement.statement);
            } finally {
                this.labels.pop();
            }
            context.emit(`${target}:;`);
            return;
        }
        if (ts.isBreakStatement(statement)) {
            if (statement.label) {
                const label = this.labels.slice().reverse().find(
                    ({ source }) => source === statement.label!.text,
                );
                if (!label) {
                    context.fail(statement, "Labeled break has no active target.");
                }
                context.emit(`goto ${label.target};`);
                return;
            }
            context.emit("break;");
            return;
        }
        if (ts.isContinueStatement(statement)) {
            if (statement.label) {
                context.fail(
                    statement,
                    "Labeled continue is not supported; use a labeled break or an unlabeled continue.",
                );
            }
            if (this.continueTargetsStaticIteration(statement)) {
                return;
            }
            context.emit("continue;");
            return;
        }
        if (
            ts.isReturnStatement(statement) &&
            !statement.expression &&
            context.activeInlineWrapper()
        ) {
            // Early bare return of an inlined function: leave the
            // breakable wrapper emitted around the inline body.
            context.emit("break;");
            return;
        }
        if (
            ts.isReturnStatement(statement) &&
            context.activeNativeReturnType() !== undefined
        ) {
            context.emitNativeReturn(statement);
            return;
        }
        if (
            ts.isReturnStatement(statement) &&
            !statement.expression
        ) {
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
            // fields and each method inlines at its call site.
            return;
        }
        context.fail(
            statement,
            `Unsupported statement: ${ts.SyntaxKind[statement.kind]}.`,
        );
    }

    /**
     * True when the statement contains a break/continue that would bind to
     * the enclosing loop (not to a nested loop, and for break, not to a
     * nested switch). Such loops cannot be statically unrolled.
     */
    private bindsEnclosingLoop(
        statement: ts.Statement,
    ): boolean {
        return enclosingLoopControl(statement) !== undefined;
    }

    /** Whether the enclosing-loop control includes a break, not only continue. */
    private breaksEnclosingLoop(
        statement: ts.Statement,
    ): boolean {
        let found = false;
        const visit = (
            node: ts.Node,
            insideSwitch: boolean,
        ): void => {
            if (found) return;
            if (
                ts.isForStatement(node) ||
                ts.isWhileStatement(node) ||
                ts.isForOfStatement(node) ||
                ts.isForInStatement(node) ||
                ts.isDoStatement(node) ||
                ts.isFunctionLike(node)
            ) {
                return;
            }
            if (ts.isBreakStatement(node)) {
                if (!insideSwitch) found = true;
                return;
            }
            const nestedSwitch = insideSwitch || ts.isSwitchStatement(node);
            ts.forEachChild(node, (child) => visit(child, nestedSwitch));
        };
        visit(statement, false);
        return found;
    }

    private emitSwitch(
        context: StatementLoweringContext,
        statement: ts.SwitchStatement,
    ): void {
        const discriminant =
            context.allocateTemporaryCppName("switch");
        const value = context.compileValue(
            statement.expression,
        );
        const stringSwitch =
            value.kind === "string" ||
            (value.kind === "data" &&
                value.dataType?.kind === "string");
        const enumSwitch =
            value.kind === "data" &&
            value.dataType?.kind === "enum";
        if (
            !stringSwitch &&
            !enumSwitch &&
            value.kind !== "number" &&
            !(
                value.kind === "data" &&
                value.dataType?.kind === "number"
            )
        ) {
            context.fail(
                statement.expression,
                `Switch discriminants must be numbers or strings, received ${value.kind}.`,
            );
        }
        context.emit("{");
        context.increaseIndent();
        context.emit(
            stringSwitch
                ? `const std::string_view ${discriminant} = ${value.cpp};`
                : enumSwitch
                  ? `const auto ${discriminant} = ${value.cpp};`
                : `const double ${discriminant} = ${value.cpp};`,
        );
        const clauses =
            statement.caseBlock.clauses;
        const defaultIndex = clauses.findIndex(
            ts.isDefaultClause,
        );
        if (
            defaultIndex !== -1 &&
            defaultIndex !== clauses.length - 1
        ) {
            context.fail(
                clauses[defaultIndex]!,
                "A switch default clause must be last.",
            );
        }
        let emittedBranch = false;
        let pendingLabels: string[] = [];
        for (const clause of clauses) {
            if (ts.isDefaultClause(clause)) {
                // Empty cases immediately before the final default share
                // its body. The emitted final `else` already selects every
                // value not handled above, including those pending labels.
                pendingLabels = [];
                context.emit(
                    emittedBranch ? "} else {" : "{",
                );
                this.inRuntimeControlFlow(context, () =>
                    this.emitSwitchBody(
                        context,
                        clause,
                    ),
                );
                emittedBranch = true;
                continue;
            }
            const label = stringSwitch
                    ? this.compileStaticSwitchString(
                          context,
                          clause.expression,
                      )
                    : enumSwitch
                      ? context.compileEnumSwitchLabel(
                            clause.expression,
                            value.dataType as DataType & {
                                kind: "enum";
                            },
                        )
                    : context.compileNumber(
                          clause.expression,
                          "double",
                      );
            // An inlined function may receive a narrower string-literal
            // union than its declared parameter. Labels outside that union
            // are unreachable for this invocation.
            if (label === undefined) {
                continue;
            }
            pendingLabels.push(label);
            if (clause.statements.length === 0) {
                continue;
            }
            const condition = pendingLabels
                .map(
                    (label) =>
                        `${discriminant} == ${label}`,
                )
                .join(" || ");
            context.emit(
                `${emittedBranch ? "} else if" : "if"} (${condition}) {`,
            );
            this.inRuntimeControlFlow(context, () =>
                this.emitSwitchBody(context, clause),
            );
            emittedBranch = true;
            pendingLabels = [];
        }
        if (pendingLabels.length > 0) {
            context.fail(
                statement,
                "Trailing case clauses without a body are not supported.",
            );
        }
        if (emittedBranch) {
            context.emit("}");
        }
        context.decreaseIndent();
        context.emit("}");
    }

    private compileStaticSwitchString(
        context: StatementLoweringContext,
        expression: ts.Expression,
    ): string {
        const value = context.compileValue(expression);
        if (
            value.kind !== "string" ||
            value.staticString === undefined
        ) {
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
        const statements = [...clause.statements];
        let last = statements.at(-1);
        let terminalBreakRemoved = false;
        // A braced case body (`case x: { ... break; }`) gives its locals a
        // lexical scope but the break still belongs to the switch. Each
        // lowered branch already owns a scope, so flatten that final block
        // before applying the same terminal-break rule.
        if (last && ts.isBlock(last)) {
            const blockLast = last.statements.at(-1);
            if (blockLast && ts.isBreakStatement(blockLast)) {
                statements.pop();
                statements.push(
                    ...last.statements.slice(0, -1),
                );
                last = statements.at(-1);
                terminalBreakRemoved = true;
            }
        }
        if (last && ts.isBreakStatement(last)) {
            statements.pop();
        } else if (
            !terminalBreakRemoved &&
            (!last ||
                (!ts.isReturnStatement(last) &&
                    !ts.isContinueStatement(last) &&
                    !ts.isThrowStatement(last)))
        ) {
            context.fail(
                clause,
                "Non-empty switch cases must end with break or return.",
            );
        }
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
        context.pushScope(
            context.allocateBlockPrefix(),
        );
        try {
            if (nestedBreak) {
                // The switch itself was lowered to an if/else chain. A
                // single-iteration scope restores the one missing control
                // boundary so an early case `break` still skips the rest of
                // that case without escaping an enclosing loop.
                context.emit("do {");
                context.increaseIndent();
            }
            for (const statement of statements) {
                this.emit(context, statement);
            }
            if (nestedBreak) {
                context.decreaseIndent();
                context.emit("} while (false);");
            }
        } finally {
            context.popScope();
            context.decreaseIndent();
        }
    }

    /**
     * Finds a break that would bind to this switch (not to a nested loop or
     * nested switch). The if/else lowering cannot express those.
     */
    private findSwitchBoundBreak(
        statement: ts.Statement,
    ): ts.Node | undefined {
        let found: ts.Node | undefined;
        const visit = (node: ts.Node): void => {
            if (found) {
                return;
            }
            if (
                ts.isForStatement(node) ||
                ts.isWhileStatement(node) ||
                ts.isForOfStatement(node) ||
                ts.isForInStatement(node) ||
                ts.isDoStatement(node) ||
                ts.isSwitchStatement(node) ||
                ts.isFunctionLike(node)
            ) {
                return;
            }
            if (
                ts.isBreakStatement(node) &&
                !node.label
            ) {
                found = node;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(statement);
        return found;
    }

    /** A continue that crosses the switch and binds to an enclosing loop. */
    private findSwitchBoundContinue(
        statement: ts.Statement,
    ): ts.ContinueStatement | undefined {
        let found: ts.ContinueStatement | undefined;
        const visit = (node: ts.Node): void => {
            if (
                found ||
                ts.isIterationStatement(node, false) ||
                ts.isFunctionLike(node)
            ) {
                return;
            }
            if (ts.isContinueStatement(node) && !node.label) {
                found = node;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(statement);
        return found;
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
        if (
            context.isBrowserOnlyExpression(statement.expression) &&
            this.statementIsBrowserOnly(
                context,
                statement.thenStatement,
            ) &&
            (!statement.elseStatement ||
                this.statementIsBrowserOnly(
                    context,
                    statement.elseStatement,
                ))
        ) {
            // A DOM guard whose every branch is itself browser-only has no
            // native observable effect. This covers optional UI setup while
            // leaving mixed browser/native conditions to the established
            // condition lowerer and its pinned static deductions.
            return;
        }
        const condition = context.compileCondition(
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
                this.emitScopedBody(
                    context,
                    statement.thenStatement,
                );
            } else if (statement.elseStatement) {
                this.emitScopedBody(
                    context,
                    statement.elseStatement,
                );
            }
            if (selected && terminatesFlow(selected)) {
                this.loweredTerminators.add(statement);
            }
            return;
        }
        if (
            this.containsStaticIterationContinue(statement.thenStatement) ||
            (statement.elseStatement !== undefined &&
                this.containsStaticIterationContinue(
                    statement.elseStatement,
                ))
        ) {
            context.fail(
                statement.expression,
                "A continue in a statically unrolled loop requires a generation-known condition.",
            );
        }
        context.emit(`if (${condition}) {`);
        // Alias invalidation is path-sensitive: a branch that always
        // leaves the iteration cannot invalidate anything for the code
        // that follows the `if`, so its effects are rolled back.
        const beforeThen = context.snapshotAliasState();
        this.inRuntimeControlFlow(context, () =>
            this.emitScopedBody(
                context,
                statement.thenStatement,
            ),
        );
        if (terminatesFlow(statement.thenStatement)) {
            context.restoreAliasState(beforeThen);
        }
        if (statement.elseStatement) {
            context.emit("} else {");
            const beforeElse = context.snapshotAliasState();
            this.inRuntimeControlFlow(context, () =>
                this.emitScopedBody(
                    context,
                    statement.elseStatement!,
                ),
            );
            if (terminatesFlow(statement.elseStatement)) {
                context.restoreAliasState(beforeElse);
            }
        }
        context.emit("}");
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
            context.isBrowserOnlyExpression(effect)
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
            context.isBrowserOnlyExpression(expression)
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
                return context.lookupOptional(value)?.kind === "browser";
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
                ts.isIdentifier(value.expression) &&
                ["Boolean", "Number", "String"].includes(
                    value.expression.text,
                ) &&
                context.isDefaultLibraryIdentifier(value.expression) &&
                value.arguments.every(pure)
            );
        };
        if (
            ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            browserLocal(expression.left) &&
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
            pure(expression.arguments[0]!) &&
            (ts.isArrowFunction(expression.arguments[1]!) ||
                ts.isFunctionExpression(expression.arguments[1]!)) &&
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
     * to C++ `catch (...)`. Catch bindings remain outside the value model.
     *
     * A finally block is a scope guard, so it runs on normal completion,
     * early return, and exception just as the JavaScript block does.
     */
    private emitTry(
        context: StatementLoweringContext,
        statement: ts.TryStatement,
    ): void {
        const finallyGuard = statement.finallyBlock
            ? this.captureFinallyGuard(
                  context,
                  statement.finallyBlock,
              )
            : undefined;
        if (finallyGuard) {
            context.reachJsData();
            context.emit("{");
            context.increaseIndent();
            const guard = context.allocateTemporaryCppName("finally");
            context.emit(
                `[[maybe_unused]] auto ${guard} = bbl::js::finally([&]() {`,
            );
            context.increaseIndent();
            for (const line of finallyGuard) context.emit(line);
            context.decreaseIndent();
            context.emit("});");
        }
        if (statement.catchClause) {
            if (
                statement.catchClause.variableDeclaration &&
                !this.catchBindingIsErased(
                    context,
                    statement.catchClause,
                )
            ) {
                context.fail(
                    statement.catchClause.variableDeclaration,
                    "Native catch bindings are supported only when every read erases with browser-only instrumentation.",
                );
            }
            context.emit("try {");
            context.increaseIndent();
            context.pushScope(
                context.allocateBlockPrefix(),
            );
            try {
                for (const child of statement.tryBlock
                    .statements) {
                    this.emit(context, child);
                }
            } finally {
                context.popScope();
                context.decreaseIndent();
            }
            context.emit("} catch (...) {");
            context.increaseIndent();
            context.pushScope(
                context.allocateBlockPrefix(),
            );
            try {
                for (const child of statement.catchClause
                    .block.statements) {
                    this.emit(context, child);
                }
            } finally {
                context.popScope();
                context.decreaseIndent();
            }
            context.emit("}");
            if (finallyGuard) {
                context.decreaseIndent();
                context.emit("}");
            }
            return;
        }
        if (!statement.finallyBlock) {
            context.fail(
                statement,
                "A try statement is lowered only with a finally block " +
                    "that erases to nothing.",
            );
        }
        this.emitScopedBody(context, statement.tryBlock);
        if (finallyGuard) {
            context.decreaseIndent();
            context.emit("}");
        }
    }

    /** A caught JavaScript value needs no native representation when unread. */
    private catchBindingIsErased(
        context: StatementLoweringContext,
        clause: ts.CatchClause,
    ): boolean {
        const declaration = clause.variableDeclaration;
        if (!declaration || !ts.isIdentifier(declaration.name)) {
            return false;
        }
        const name = declaration.name.text;
        let erased = true;
        const visit = (node: ts.Node): void => {
            if (!erased) return;
            if (
                ts.isIdentifier(node) &&
                node !== declaration.name &&
                node.text === name
            ) {
                let statement: ts.Node = node;
                while (
                    statement.parent &&
                    statement.parent !== clause.block
                ) {
                    statement = statement.parent;
                }
                const directBrowserArgument =
                    ts.isCallExpression(node.parent) &&
                    node.parent.parent === statement &&
                    context.isBrowserOnlyExpression(node.parent);
                if (
                    !ts.isStatement(statement) ||
                    !(
                        directBrowserArgument ||
                        this.statementIsBrowserOnly(
                            context,
                            statement,
                        ) ||
                        (ts.isExpressionStatement(statement) &&
                            ts.isCallExpression(statement.expression) &&
                            context.isBrowserInstrumentationCall(
                                statement.expression,
                            ))
                    )
                ) {
                    erased = false;
                    return;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(clause.block);
        return erased;
    }

    private captureFinallyGuard(
        context: StatementLoweringContext,
        block: ts.Block,
    ): string[] {
        context.pushScope(context.allocateBlockPrefix());
        try {
            return context.captureEmittedLines(() => {
                for (const statement of block.statements) {
                    this.emit(context, statement);
                }
            });
        } finally {
            context.popScope();
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
        const message =
            ts.isNewExpression(thrown) &&
            ts.isIdentifier(thrown.expression) &&
            thrown.expression.text === "Error"
                ? thrown.arguments?.[0]
                : undefined;
        if (!message) {
            context.fail(
                statement,
                "A scene throws a new Error carrying a static message.",
            );
        }
        const value = context.compileValue(message);
        if (
            value.staticString === undefined &&
            !(
                value.kind === "data" &&
                value.dataType?.kind === "string"
            )
        ) {
            context.fail(
                message,
                "A thrown Error message must be a string.",
            );
        }
        context.reachThrow();
        context.emit(
            `throw std::runtime_error(${
                value.staticString !== undefined
                    ? context.cppString(value.staticString)
                    : value.cpp
            });`,
        );
    }

    private emitBlock(
        context: StatementLoweringContext,
        statement: ts.Block,
    ): void {
        context.emit("{");
        this.emitScopedBody(context, statement);
        context.emit("}");
    }

    private emitFor(
        context: StatementLoweringContext,
        statement: ts.ForStatement,
    ): void {
        if (
            !this.bindsEnclosingLoop(
                statement.statement,
            ) &&
            this.emitStaticIndexFor(context, statement)
        ) {
            return;
        }
        context.emit("{");
        context.increaseIndent();
        context.pushScope(
            context.allocateBlockPrefix(),
        );
        try {
            if (statement.initializer) {
                if (
                    ts.isVariableDeclarationList(
                        statement.initializer,
                    )
                ) {
                    for (const declaration of statement
                        .initializer.declarations) {
                        context.emitVariableDeclaration(
                            declaration,
                        );
                    }
                } else {
                    this.emitExpression(
                        context,
                        statement.initializer,
                    );
                }
            }
            const condition = statement.condition
                ? this.inRuntimeControlFlow(context, () =>
                      context.compileCondition(
                          statement.condition!,
                      ),
                  )
                : "";
            // The incrementor belongs in the for-header so `continue`
            // reaches it, matching JavaScript loop semantics.
            let header = "";
            if (statement.incrementor) {
                const lines = this.inRuntimeControlFlow(
                    context,
                    () =>
                        context.captureEmittedLines(() => {
                            this.emitExpression(
                                context,
                                statement.incrementor!,
                            );
                        }),
                );
                if (
                    lines.length !== 1 ||
                    !lines[0]!.endsWith(";")
                ) {
                    context.fail(
                        statement.incrementor,
                        "Loop incrementors must lower to one native statement.",
                    );
                }
                header = lines[0]!.slice(0, -1);
            }
            context.emit(
                `for (; ${condition}; ${header}) {`,
            );
            context.increaseIndent();
            context.pushScope(
                context.allocateBlockPrefix(),
            );
            try {
                const statements = ts.isBlock(
                    statement.statement,
                )
                    ? statement.statement.statements
                    : [statement.statement];
                this.inRuntimeControlFlow(context, () => {
                    for (const nested of statements) {
                        this.emit(context, nested);
                    }
                });
            } finally {
                context.popScope();
            }
            context.decreaseIndent();
            context.emit("}");
        } finally {
            context.popScope();
            context.decreaseIndent();
        }
        context.emit("}");
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
     * Shared by the three unrollers, because the reason is the loop's shape
     * rather than which collection it walked.
     */
    private emitUnrolledIteration(
        context: StatementLoweringContext,
        iteration: ts.IterationStatement,
        body: ts.Statement,
        bind: () => void,
    ): void {
        context.pushScope(context.allocateBlockPrefix());
        this.staticUnrolledIterations.push(iteration);
        try {
            bind();
            const statements = ts.isBlock(body)
                ? body.statements
                : [body];
            for (const nested of statements) {
                this.emit(context, nested);
                if (this.terminatesAfterLowering(nested)) break;
            }
        } finally {
            this.staticUnrolledIterations.pop();
            context.popScope();
        }
    }

    private emitStaticIndexFor(
        context: StatementLoweringContext,
        statement: ts.ForStatement,
    ): boolean {
        const shape = this.staticIndexLoopShape(statement);
        if (!shape) return false;
        const { indexBinding, start, end: endExpression } = shape;
        const indexName = indexBinding.text;
        const length = context.compileValue(endExpression);
        if (
            length.kind !== "number" ||
            length.staticNumber === undefined ||
            !Number.isInteger(length.staticNumber) ||
            length.staticNumber < 0
        ) {
            return false;
        }
        const requiresStaticIteration =
            context.requiresStaticIteration(statement.statement) ||
            containsFrameYield(context, statement.statement);
        // Once an enclosing runtime branch or loop owns execution, a
        // data-only counted loop gains nothing from generation-time
        // unrolling. Keeping it native also prevents small inner grid walks
        // from being duplicated inside each runtime iteration.
        if (
            context.isInRuntimeControlFlow() &&
            !requiresStaticIteration
        ) {
            return false;
        }
        if (
            length.staticNumber > MAX_STATIC_INDEX_ITERATIONS &&
            !requiresStaticIteration
        ) {
            return false;
        }
        if (
            length.staticNumber > MAX_REQUIRED_STATIC_INDEX_ITERATIONS
        ) {
            context.fail(
                endExpression,
                "A loop that reaches pinned scene construction must be " +
                    "statically iterated, but its count is too large.",
            );
        }
        let indexMutation: ts.Node | undefined;
        const findIndexMutation = (node: ts.Node): void => {
            if (indexMutation) {
                return;
            }
            if (
                ts.isBinaryExpression(node) &&
                ts.isIdentifier(node.left) &&
                node.left.text === indexName &&
                [
                    ts.SyntaxKind.EqualsToken,
                    ts.SyntaxKind.PlusEqualsToken,
                    ts.SyntaxKind.MinusEqualsToken,
                ].includes(node.operatorToken.kind)
            ) {
                indexMutation = node;
                return;
            }
            if (
                (ts.isPostfixUnaryExpression(node) ||
                    ts.isPrefixUnaryExpression(node)) &&
                [
                    ts.SyntaxKind.PlusPlusToken,
                    ts.SyntaxKind.MinusMinusToken,
                ].includes(node.operator) &&
                ts.isIdentifier(node.operand) &&
                node.operand.text === indexName
            ) {
                indexMutation = node;
                return;
            }
            ts.forEachChild(node, findIndexMutation);
        };
        findIndexMutation(statement.statement);
        if (indexMutation) {
            context.fail(
                indexMutation,
                "Static index-loop bodies cannot mutate the loop index.",
            );
        }
        const iterations = Math.max(
            0,
            length.staticNumber - start,
        );
        if (
            !requiresStaticIteration &&
            this.exceedsDataStaticIndexNest(
                context,
                statement.statement,
                iterations,
            )
        ) {
            return false;
        }
        const emitIndexIteration = (index: number): void => {
            this.emitUnrolledIteration(
                context,
                statement,
                statement.statement,
                () => {
                    context.bindCompileTimeValue(indexBinding, {
                        kind: "number",
                        cpp: `${index}.0`,
                        staticNumber: index,
                    });
                },
            );
        };
        if (
            !requiresStaticIteration &&
            this.exceedsStaticUnrollBudget(iterations)
        ) {
            this.emitBudgetedUniformIterations(
                context,
                iterations,
                (at) => emitIndexIteration(start + at),
            );
            return true;
        }
        const end = length.staticNumber;
        this.withStaticUnrollProduct(iterations, () => {
            for (
                let index = start;
                index < end;
                index += 1
            ) {
                emitIndexIteration(index);
            }
        });
        return true;
    }

    /** The exact counted-loop form supported by the static index unroller. */
    private staticIndexLoopShape(
        statement: ts.ForStatement,
    ):
        | {
              indexBinding: ts.Identifier;
              start: number;
              end: ts.Expression;
          }
        | undefined {
        if (
            !statement.initializer ||
            !ts.isVariableDeclarationList(statement.initializer) ||
            statement.initializer.declarations.length !== 1 ||
            !statement.condition ||
            !statement.incrementor
        ) {
            return undefined;
        }
        const declaration = statement.initializer.declarations[0]!;
        if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer ||
            !ts.isNumericLiteral(declaration.initializer) ||
            !ts.isBinaryExpression(statement.condition) ||
            statement.condition.operatorToken.kind !==
                ts.SyntaxKind.LessThanToken ||
            !ts.isIdentifier(statement.condition.left) ||
            statement.condition.left.text !== declaration.name.text ||
            !ts.isPostfixUnaryExpression(statement.incrementor) ||
            statement.incrementor.operator !==
                ts.SyntaxKind.PlusPlusToken ||
            !ts.isIdentifier(statement.incrementor.operand) ||
            statement.incrementor.operand.text !== declaration.name.text
        ) {
            return undefined;
        }
        const start = Number(declaration.initializer.text);
        if (!Number.isInteger(start) || start < 0) return undefined;
        return {
            indexBinding: declaration.name,
            start,
            end: statement.condition.right,
        };
    }

    /**
     * Whether statically counted loops below this body form a data walk too
     * large to duplicate at generation. Static constant resolution is
     * side-effect free. An unresolved or runtime-shaped nested iteration
     * has an unknown Cartesian product, so conservatively keep its enclosing
     * data-only loop native as well.
     */
    private exceedsDataStaticIndexNest(
        context: StatementLoweringContext,
        body: ts.Statement,
        iterations: number,
    ): boolean {
        let exceeded = false;
        const visit = (node: ts.Node, product: number): void => {
            if (exceeded || ts.isFunctionLike(node)) return;
            if (ts.isForStatement(node)) {
                const shape = this.staticIndexLoopShape(node);
                if (shape) {
                    const resolved = context.resolveStaticExpression(
                        shape.end,
                    );
                    if (ts.isNumericLiteral(resolved)) {
                        const end = Number(resolved.text);
                        if (Number.isInteger(end) && end >= 0) {
                            const count = Math.max(0, end - shape.start);
                            const nestedProduct = product * count;
                            if (
                                nestedProduct >
                                MAX_DATA_STATIC_INDEX_NEST_PRODUCT
                            ) {
                                exceeded = true;
                                return;
                            }
                            visit(node.statement, nestedProduct);
                            return;
                        }
                    }
                }
                exceeded = true;
                return;
            }
            if (
                ts.isForOfStatement(node) ||
                ts.isForInStatement(node) ||
                ts.isWhileStatement(node) ||
                ts.isDoStatement(node)
            ) {
                exceeded = true;
                return;
            }
            ts.forEachChild(node, (child) => visit(child, product));
        };
        visit(body, iterations);
        return exceeded;
    }

    /**
     * A statically unrolled loop past the nest budget: every iteration
     * still runs — its generation-time effects are the reason the loop
     * unrolls at all — but the emitted lines are captured per iteration,
     * and when every capture is byte-identical the text collapses to one
     * native repeat loop around a single copy. Identical captures mean
     * the per-iteration binding never reached the emission (a folded
     * constant would differ per iteration), so the repeated body has
     * nothing to parameterize; the loop runs the same statements the
     * same number of times in the same order.
     *
     * Anything short of identical re-emits the captures verbatim — the
     * unrolled bytes exactly as today — because a body this cannot prove
     * uniform (scene165's nest folds its indices into per-cell constants)
     * is precisely the one whose unrolled form is the trusted emission.
     *
     * Shared by the static index loop and the static array-literal
     * `for...of`, whose per-iteration bindings differ but whose fold
     * proof is the same byte identity.
     */
    private emitBudgetedUniformIterations(
        context: StatementLoweringContext,
        iterations: number,
        emitIteration: (at: number) => void,
    ): void {
        const captures: string[][] = [];
        this.withStaticUnrollProduct(iterations, () => {
            for (let at = 0; at < iterations; at += 1) {
                captures.push(
                    context.captureEmittedLines(() =>
                        emitIteration(at),
                    ),
                );
            }
        });
        const template = captures[0]!;
        if (!this.capturesAreIdentical(captures, template)) {
            this.emitCapturedIterations(context, captures);
            return;
        }
        this.emitRepeatedTemplate(
            context,
            iterations,
            template,
        );
    }

    private emitWhile(
        context: StatementLoweringContext,
        statement: ts.WhileStatement,
    ): void {
        context.emit(
            `while (${this.inRuntimeControlFlow(context, () =>
                context.compileCondition(statement.expression),
            )}) {`,
        );
        this.inRuntimeControlFlow(context, () =>
            this.emitScopedBody(
                context,
                statement.statement,
            ),
        );
        context.emit("}");
    }

    private emitDo(
        context: StatementLoweringContext,
        statement: ts.DoStatement,
    ): void {
        context.emit("do {");
        this.inRuntimeControlFlow(context, () =>
            this.emitScopedBody(
                context,
                statement.statement,
            ),
        );
        context.emit(
            `} while (${this.inRuntimeControlFlow(context, () =>
                context.compileCondition(statement.expression),
            )});`,
        );
    }

    private emitForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
    ): void {
        if (statement.awaitModifier) {
            context.fail(
                statement.awaitModifier,
                "for await...of is not supported.",
            );
        }
        if (
            !ts.isVariableDeclarationList(
                statement.initializer,
            ) ||
            statement.initializer.declarations.length !== 1
        ) {
            context.fail(
                statement.initializer,
                "for...of requires one variable declaration.",
            );
        }
        const declaration =
            statement.initializer.declarations[0]!;
        if (declaration.initializer) {
            context.fail(
                declaration,
                "for...of bindings cannot carry initializers.",
            );
        }
        // The engine-collection paths answer first: their expressions are
        // property reads (or a `?? []` over one), which the static probe
        // would try to resolve as a value and refuse.
        if (
            this.emitAssetEntitiesForOf(
                context,
                statement,
                declaration,
            )
        ) {
            return;
        }
        if (
            this.emitAssetRootChildrenForOf(
                context,
                statement,
                declaration,
            )
        ) {
            return;
        }
        if (
            this.emitAssetFlattenedMeshesForOf(
                context,
                statement,
                declaration,
            )
        ) {
            return;
        }
        if (
            this.emitHandleCollectionForOf(
                context,
                statement,
                declaration,
            )
        ) {
            return;
        }
        if (
            this.emitTupleForOf(
                context,
                statement,
                declaration,
            )
        ) {
            return;
        }
        // A handle vector whose static snapshot was invalidated by a spread
        // append (for example, an accumulated set of imported meshes) must
        // iterate its native contents. Looking only through the identifier
        // to its original `[]` initializer would incorrectly unroll zero
        // iterations and erase the body.
        const runtimeHandleTarget = ts.isIdentifier(
            context.unwrap(statement.expression),
        )
            ? context.dataIterationTarget(statement.expression)
            : undefined;
        if (
            runtimeHandleTarget?.element.kind === "handle" &&
            this.emitRuntimeForOf(
                context,
                statement,
                declaration,
            )
        ) {
            return;
        }
        const staticLiteral =
            !this.bindsEnclosingLoop(statement.statement)
                ? context.probeStaticArrayLiteral(
                      statement.expression,
                  )
                : undefined;
        // Preserve runtime iteration for destructured materialized tables.
        // Static destructuring is the fallback for tuples whose mixed or
        // optional lanes cannot be represented as one native container.
        if (
            (!staticLiteral ||
                ts.isArrayBindingPattern(declaration.name)) &&
            this.emitRuntimeForOf(
                context,
                statement,
                declaration,
            )
        ) {
            return;
        }
        if (
            this.bindsEnclosingLoop(statement.statement)
        ) {
            context.fail(
                statement,
                "break/continue in for...of requires a runtime data container.",
            );
        }
        const values = context.expectStaticArrayLiteral(
            statement.expression,
        );
        const emitElementIteration = (
            element: ts.Expression,
        ): void => {
            this.emitUnrolledIteration(
                context,
                statement,
                statement.statement,
                () => {
                    this.bindStaticIterationValue(
                        context,
                        declaration.name,
                        context.compileValue(element),
                    );
                },
            );
        };
        // The same budget-triggered fold as the static index loop: past
        // the nest budget the iterations are captured, and only a fully
        // uniform body collapses to one native repeat loop — anything
        // short of identical re-emits the unrolled bytes exactly. A body
        // reaching pinned scene construction keeps the flat unroll; that
        // is the AOT boundary the fold must not blur.
        if (
            !context.requiresStaticIteration(
                statement.statement,
            ) &&
            this.exceedsStaticUnrollBudget(
                values.elements.length,
            )
        ) {
            this.emitBudgetedUniformIterations(
                context,
                values.elements.length,
                (at) =>
                    emitElementIteration(
                        values.elements[at]!,
                    ),
            );
            return;
        }
        this.withStaticUnrollProduct(
            values.elements.length,
            () => {
                for (const element of values.elements) {
                    emitElementIteration(element);
                }
            },
        );
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
        const target = context.assetRootChildrenIterationTarget(
            statement.expression,
        );
        if (!target) {
            return false;
        }
        if (!ts.isIdentifier(declaration.name)) {
            context.fail(
                declaration.name,
                "Walking an imported root's children requires an identifier binding.",
            );
        }
        const materialAssignment = isRecursiveImportedMeshWalk(
            statement,
            declaration.name,
        );
        if (!materialAssignment) {
            context.fail(
                statement,
                "An imported root's children are lowered only for the effect-only recursive TransformNode material walk.",
            );
        }
        const material = context.compileValue(
            materialAssignment.right,
        );
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
        );
        return true;
    }

    /**
     * Lowers `for (const mesh of <walk>(container))`, where the walk is
     * proven to flatten the container to its renderables.
     *
     * The body runs once per renderable, over the meshes native loading
     * already flattened. `break`/`continue` would make the loop's order
     * observable, and a worklist reaches siblings in the reverse of the
     * loader's document order, so both are refused rather than lowered
     * against an order this walk never promised.
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
            context.assetFlattenedMeshesIterationTarget(
                statement.expression,
            );
        if (!resolved) {
            return false;
        }
        if (this.bindsEnclosingLoop(statement.statement)) {
            context.fail(
                statement,
                "break/continue in a container's mesh walk is not lowered: the walk collects a set, and stopping partway through would depend on an order it does not fix.",
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
        const target = context.assetEntitiesIterationTarget(
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
        context.pushScope(context.allocateBlockPrefix());
        try {
            context.bindLocalValue(declaration.name, target);
            for (const nested of bodyStatements(statement)) {
                this.emit(context, nested);
            }
        } finally {
            context.popScope();
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
                    ts.isArrayBindingPattern(
                        declaration.name,
                    ) &&
                    context.dataIterationTarget(
                        statement.expression,
                    )
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
        if (this.bindsEnclosingLoop(statement.statement)) {
            if (
                context.dataIterationTarget(
                    statement.expression,
                )
            ) {
                return false;
            }
            if (this.breaksEnclosingLoop(statement.statement)) {
                context.fail(
                    statement,
                    "break in for...of requires a runtime data container.",
                );
            }
        }
        if (
            this.emitStaticHandleTableForOf(
                context,
                statement,
                declaration,
                elements,
            )
        ) {
            return true;
        }
        this.withStaticUnrollProduct(elements.length, () => {
            for (const element of elements) {
                this.emitUnrolledIteration(
                    context,
                    statement,
                    statement.statement,
                    () => {
                        this.bindStaticIterationValue(
                            context,
                            declaration.name,
                            element,
                        );
                    },
                );
            }
        });
        return true;
    }

    /**
     * A `for...of` over a generation-known tuple of engine handles, past
     * the nest budget: the AOT walk still happens — every iteration is
     * compiled once with its real element, so handle facts learned in the
     * body land on the same Value objects, and any generation-time record
     * the body touches is touched per element exactly as before — but the
     * emitted lines are captured per iteration instead of streamed. When
     * every capture is the same bytes modulo that iteration's own handle
     * spelling, the text collapses to a native table of the handles plus
     * one loop over it.
     *
     * Why the substitution proof is sound: canonicalizing capture k
     * replaces ALL stand-alone occurrences of element k's spelling, so
     * equality of the canonical lines means capture k is exactly the
     * template with the loop binding set to element k — which is what the
     * emitted loop executes, in the same element order, through a const
     * by-value binding just like the handle-collection loop's. The table
     * is built at the statement's own position on every execution, so it
     * reads the handle variables at the same moment the unrolled
     * statements read them. A body that rebinds an element's own variable
     * cannot slip through: the rebinding line either carries that
     * iteration's token (declined by the placeholder-assignment guard) or
     * another iteration's spelling (unequal canonical lines). Everything
     * else — heterogeneous kinds, bodies doing pinned scene construction,
     * per-iteration folds, locals (their block prefixes differ per
     * iteration by construction) — fails uniformity and keeps the
     * unrolled emission byte for byte.
     */
    private emitStaticHandleTableForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
        elements: readonly Value[],
    ): boolean {
        if (!ts.isIdentifier(declaration.name)) {
            return false;
        }
        if (!this.exceedsStaticUnrollBudget(elements.length)) {
            return false;
        }
        const kind = elements[0]!.kind;
        const cppType =
            context.handleCollections.staticHandleTableCppType(
                kind,
            );
        // Every element must be spelled as a plain C++ identifier — a
        // handle local the scene bound before pushing. An element compiled
        // straight from its creation call carries that CALL as its
        // spelling, and a table repeating it would re-create the mesh per
        // execution; an identifier read is effect-free and reads the same
        // handle the unrolled statements read.
        if (
            cppType === undefined ||
            elements.some(
                (element) =>
                    element.kind !== kind ||
                    !cppIdentifierPattern.test(
                        element.cpp,
                    ),
            )
        ) {
            return false;
        }
        // A body that binds this loop's own control flow, or that reaches
        // pinned scene construction, keeps the unrolled arms above: the
        // first has its own continue/erasure semantics, and the second is
        // the AOT boundary this fold must not blur even when its text
        // would prove uniform.
        if (
            this.bindsEnclosingLoop(statement.statement) ||
            context.requiresStaticIteration(statement.statement)
        ) {
            return false;
        }
        // From here every iteration is consumed exactly once: captured,
        // then re-emitted either folded or verbatim. Falling back to the
        // caller's unroll after this point would run the generation-time
        // effects twice.
        const captures: string[][] = [];
        this.withStaticUnrollProduct(elements.length, () => {
            for (const element of elements) {
                captures.push(
                    context.captureEmittedLines(() =>
                        this.emitUnrolledIteration(
                            context,
                            statement,
                            statement.statement,
                            () => {
                                this.bindStaticIterationValue(
                                    context,
                                    declaration.name,
                                    element,
                                );
                            },
                        ),
                    ),
                );
            }
        });
        const canonical = captures.map((lines, at) =>
            lines.map((line) =>
                replaceHandleToken(line, elements[at]!.cpp),
            ),
        );
        const template = canonical[0]!;
        const uniform = this.capturesAreIdentical(
            canonical,
            template,
        );
        // The loop binding is a const copy, so a template line that would
        // assign through or alias the bound handle itself cannot take the
        // fold; the unrolled statements wrote the original variable.
        const assignsElement = new RegExp(
            `${HANDLE_TOKEN_PLACEHOLDER}\\s*=(?!=)`,
        );
        const aliasesElement = new RegExp(
            `&\\s*${HANDLE_TOKEN_PLACEHOLDER}`,
        );
        const unsafe = template.some(
            (line) =>
                assignsElement.test(line) ||
                aliasesElement.test(line),
        );
        if (!uniform || unsafe) {
            this.emitCapturedIterations(context, captures);
            return true;
        }
        if (
            !template.some((line) =>
                line.includes(HANDLE_TOKEN_PLACEHOLDER),
            )
        ) {
            // The element never reached the text, so a table would bind an
            // unreferenced loop variable; a plain repeat loop is the same
            // statements the same number of times.
            this.emitRepeatedTemplate(
                context,
                elements.length,
                template,
            );
            return true;
        }
        const table =
            context.allocateTemporaryCppName("handle_table");
        const member = context.allocateTemporaryCppName(
            "handle_table_member",
        );
        context.emit(
            `const ${cppType} ${table}[${elements.length}] = {`,
        );
        context.increaseIndent();
        const perLine = 16;
        for (
            let from = 0;
            from < elements.length;
            from += perLine
        ) {
            const row = elements
                .slice(from, from + perLine)
                .map((element) => element.cpp)
                .join(", ");
            context.emit(`${row},`);
        }
        context.decreaseIndent();
        context.emit("};");
        context.emit(
            `for (const ${cppType} ${member} : ${table}) {`,
        );
        context.increaseIndent();
        for (const line of template) {
            context.emit(
                line.replaceAll(
                    HANDLE_TOKEN_PLACEHOLDER,
                    member,
                ),
            );
        }
        context.decreaseIndent();
        context.emit("}");
        return true;
    }

    /** Binds one statically unrolled element, including tuple patterns. */
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
            if (isHandleKind(value.kind) || value.kind === "light") {
                context.bindCompileTimeValue(name, value);
            } else {
                context.bindLocalValue(name, value);
            }
            return;
        }
        if (!ts.isArrayBindingPattern(name)) {
            context.fail(
                name,
                "Static for...of destructuring requires an array pattern.",
            );
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
                context.bindLocalValue(
                    binding.name,
                    element,
                );
            } else {
                // JavaScript binds an omitted tuple lane to `undefined`;
                // optional trailing tuple members use that path routinely.
                context.bindCompileTimeValue(binding.name, {
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
        emitHandleCollectionLoop(
            context,
            target,
            declaration.name,
            (loopContext) => {
                this.inRuntimeControlFlow(loopContext, () => {
                    for (const nested of bodyStatements(statement)) {
                        this.emit(loopContext, nested);
                    }
                });
            },
            extraBinding,
        );
    }

    private emitHandleCollectionForOf(
        context: StatementLoweringContext,
        statement: ts.ForOfStatement,
        declaration: ts.VariableDeclaration,
    ): boolean {
        const target = context.handleCollectionIterationTarget(
            statement.expression,
        );
        if (!target) {
            return false;
        }
        this.emitCollectionForOfBody(
            context,
            statement,
            declaration,
            target,
        );
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
    ): boolean {
        const target = context.dataIterationTarget(
            statement.expression,
        );
        if (!target) {
            return false;
        }
        const item =
            context.allocateTemporaryCppName("item");
        context.emit(
            `for (auto&& ${item} : ${target.container.cpp}) {`,
        );
        context.increaseIndent();
        context.pushScope(
            context.allocateBlockPrefix(),
        );
        try {
            context.bindDataIterationVariable(
                declaration.name,
                item,
                target.element,
            );
            const statements = ts.isBlock(
                statement.statement,
            )
                ? statement.statement.statements
                : [statement.statement];
            this.inRuntimeControlFlow(context, () => {
                for (const nested of statements) {
                    this.emit(context, nested);
                }
            });
        } finally {
            context.popScope();
            context.decreaseIndent();
        }
        context.emit("}");
        return true;
    }

    private emitScopedBody(
        context: StatementLoweringContext,
        statement: ts.Statement,
    ): void {
        context.increaseIndent();
        context.pushScope(
            context.allocateBlockPrefix(),
        );
        try {
            const statements = ts.isBlock(statement)
                ? statement.statements
                : [statement];
            for (const nested of statements) {
                this.emit(context, nested);
                if (this.terminatesAfterLowering(nested)) break;
            }
        } finally {
            context.popScope();
            context.decreaseIndent();
        }
    }

    /**
     * One expression lowered as a statement. Public for a caller holding
     * an expression rather than an `ExpressionStatement` — a concise
     * arrow body, whose value the pin's callback contract discards.
     */
    public emitExpression(
        context: StatementLoweringContext,
        expression: ts.Expression,
    ): void {
        const unwrapped = context.unwrap(expression);
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
            this.emitExpression(
                context,
                operand,
            );
            return;
        }
        const assignmentOperator = ts.isBinaryExpression(unwrapped)
            ? ASSIGNMENT_OPERATORS.get(
                  unwrapped.operatorToken.kind,
              )
            : undefined;
        if (
            ts.isBinaryExpression(unwrapped) &&
            assignmentOperator !== undefined
        ) {
            if (ts.isIdentifier(unwrapped.left)) {
                const target = context.lookup(
                    unwrapped.left,
                );
                const operator = assignmentOperator;
                if (
                    operator === "=" &&
                    context.emitOptionalResourceAssignment(
                        unwrapped,
                        target,
                    )
                ) {
                    return;
                }
                const rightExpression = context.unwrap(unwrapped.right);
                if (
                    target.kind === "number" &&
                    operator === "=" &&
                    ts.isCallExpression(rightExpression) &&
                    context.isDeferredCallbackCall(rightExpression)
                ) {
                    const scheduled = context.compileValue(rightExpression);
                    if (scheduled.kind === "void") {
                        if (scheduled.cpp) context.emit(`${scheduled.cpp};`);
                        return;
                    }
                    context.expectKind(
                        scheduled,
                        "number",
                        rightExpression,
                    );
                    context.emit(`${target.cpp} = ${scheduled.cpp};`);
                    return;
                }
                if (target.kind === "number") {
                    const right = context.compileNumber(
                        unwrapped.right,
                        "double",
                    );
                    context.emit(
                        this.numericAssignmentCpp(
                            context,
                            target.cpp,
                            operator,
                            right,
                        ),
                    );
                } else if (
                    target.kind === "boolean" &&
                    operator === "="
                ) {
                    context.emit(
                        `${target.cpp} = ${context.compileCondition(unwrapped.right)};`,
                    );
                } else if (
                    target.kind === "string" &&
                    (operator === "=" || operator === "+=")
                ) {
                    const value = context.compileValue(
                        unwrapped.right,
                    );
                    if (
                        value.kind !== "string" &&
                        !(
                            value.kind === "data" &&
                            value.dataType?.kind === "string"
                        )
                    ) {
                        context.fail(
                            unwrapped.right,
                            `String assignment requires a string, received ${value.kind}.`,
                        );
                    }
                    context.emit(
                        `${target.cpp} ${operator} ${value.cpp};`,
                    );
                } else if (
                    target.kind === "audio-node" &&
                    operator === "="
                ) {
                    const value = context.compileValue(unwrapped.right);
                    context.expectKind(
                        value,
                        "audio-node",
                        unwrapped.right,
                    );
                    context.emit(`${target.cpp} = ${value.cpp};`);
                } else if (
                    target.kind === "data" &&
                    operator === "=" &&
                    context.emitDataAssignment(unwrapped)
                ) {
                    return;
                } else if (
                    isHandleKind(target.kind) &&
                    operator === "=" &&
                    ts.isIdentifier(context.unwrap(unwrapped.left)) &&
                    context.unwrap(unwrapped.right).kind !==
                        ts.SyntaxKind.NullKeyword
                ) {
                    // Point a handle name at a different handle of the
                    // same kind; `rebindVariable` carries what that means.
                    const right = context.compileValue(unwrapped.right);
                    if (right.kind !== target.kind) {
                        context.fail(
                            unwrapped.right,
                            `A ${target.kind} name takes another ` +
                                `${target.kind}, received ${right.kind}.`,
                        );
                    }
                    context.emit(`${target.cpp} = ${right.cpp};`);
                    context.rebindVariable(
                        context.unwrap(unwrapped.left) as ts.Identifier,
                        right,
                    );
                    return;
                } else if (
                    target.kind === "json-null" &&
                    operator === "=" &&
                    (context.isBrowserOnlyExpression(unwrapped.right) ||
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
            } else {
                context.emitAssignment(unwrapped);
            }
            return;
        }
        if (
            ts.isPostfixUnaryExpression(unwrapped) &&
            [
                ts.SyntaxKind.PlusPlusToken,
                ts.SyntaxKind.MinusMinusToken,
            ].includes(unwrapped.operator)
        ) {
            if (ts.isIdentifier(unwrapped.operand)) {
                const target = context.lookup(
                    unwrapped.operand,
                );
                context.expectKind(
                    target,
                    "number",
                    unwrapped.operand,
                );
                context.emit(
                    `${target.cpp}${unwrapped.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--"};`,
                );
                return;
            }
            if (context.emitDataPostfix(unwrapped)) {
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
            context.eraseBrowserInstrumentation(
                unwrapped.pos,
            );
            return;
        }
        if (context.isBoundedNestedFrameYield(unwrapped)) {
            // The exact two-RAF Promise carries no value and no callback may
            // interleave, so its continuation can stay in the native tail.
            // Its settling time still gates capture: the frame conductor
            // must draw the CPU mutation that follows before taking the
            // screenshot which `dataset.ready` guarded upstream.
            context.emit(
                `bbl::defer_capture_until(` +
                    `${context.requireDefaultEngine(unwrapped)}, ` +
                    `[frames = 0u]() mutable { ` +
                    `return ++frames >= 2u; });`,
            );
            return;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            context.isFrameYield(unwrapped)
        ) {
            // A zero-argument helper can carry the same one-frame Promise.
            // Recognize it before ordinary call inlining reaches the
            // browser-only constructor in the helper's return expression.
            if (
                frameYieldInsideLoop(
                    unwrapped,
                    this.staticUnrolledIterations,
                )
            ) {
                context.fail(
                    unwrapped,
                    "A frame yield inside a loop is a multi-frame wait, " +
                        "which this runtime does not lower; it renders the " +
                        "frame the scene asks for, not a count of them.",
                );
            }
            context.emitFrameYieldRequeue(unwrapped);
            return;
        }
        if (ts.isCallExpression(unwrapped)) {
            const value = context.compileValue(unwrapped);
            if (
                value.kind !== "engine" &&
                value.cpp.length > 0
            ) {
                context.emit(
                    value.kind !== "void" ||
                        value.requiresExplicitDiscard
                        ? `static_cast<void>(${value.cpp});`
                        : `${value.cpp};`,
                );
            }
            return;
        }
        const drain = context.frameDrainCondition(unwrapped);
        if (drain) {
            // A bounded multi-frame wait, which the single-frame yield
            // below deliberately refuses to stand in for. The condition is
            // the scene's own and it holds off the capture, because
            // upstream it holds off `canvas.dataset.ready` and the harness
            // screenshots on that.
            context.emit(
                `bbl::defer_capture_until(` +
                    `${context.requireDefaultEngine(unwrapped)}, ` +
                    `[&]() { return ` +
                    `${context.compileCondition(drain)}; });`,
            );
            return;
        }
        if (context.isFrameYield(unwrapped)) {
            // Before the frame loop exists, one frame's work has already
            // happened by the time this runtime reaches the statement after
            // it, so the yield erases; inside the hoisted continuation the
            // re-queue below keeps that claim true. A RUNTIME loop of these
            // is a different claim -- "let N frames elapse" -- and erasing
            // each iteration would silently turn it into none, so it
            // refuses; a written-out one is N sequential yields.
            if (
                frameYieldInsideLoop(
                    unwrapped,
                    this.staticUnrolledIterations,
                )
            ) {
                context.fail(
                    unwrapped,
                    "A frame yield inside a loop is a multi-frame wait, " +
                        "which this runtime does not lower; it renders the " +
                        "frame the scene asks for, not a count of them.",
                );
            }
            context.emitFrameYieldRequeue(unwrapped);
            return;
        }
        // `await <barrier property>` -- a read whose only meaning is the
        // wait, which this runtime satisfies by construction. Compiled
        // rather than skipped so the property still has to exist and the
        // owner still has to be the right kind.
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const value = context.compileValue(unwrapped);
            if (value.kind === "void" && value.cpp.length === 0) {
                return;
            }
        }
        context.fail(
            unwrapped,
            `Unsupported expression statement: ${ts.SyntaxKind[unwrapped.kind]}.`,
        );
    }

    private numericAssignmentCpp(
        context: StatementLoweringContext,
        target: string,
        operator: string,
        right: string,
    ): string {
        const helper = BITWISE_ASSIGNMENT_HELPERS[operator];
        if (!helper) {
            return `${target} ${operator} ${right};`;
        }
        context.reachJsData();
        return `${target} = bbl::js::${helper}(${target}, ${right});`;
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
        if (!ts.isPropertyAccessExpression(owner)) {
            return false;
        }
        // Identifier owners look up directly; anything else compiles as
        // a value so a mesh read out of the data model (a handle in a
        // struct or array) sets its transform like a mesh local.
        const target = ts.isIdentifier(owner.expression)
            ? context.lookup(owner.expression)
            : context.compileValue(owner.expression);
        if (
            target.kind === "camera" &&
            ["position", "target"].includes(
                owner.name.text,
            )
        ) {
            if (call.arguments.length !== 3) {
                context.fail(
                    call,
                    `${owner.name.text}.set expects exactly three numeric arguments.`,
                );
            }
            // The camera's own position and target are JavaScript
            // numbers upstream; the record keeps them as doubles so the
            // composed view matrix rounds where the pin's cache does.
            const vector = `bbl::Vec3d{${call.arguments
                .map((argument) =>
                    context.compileNumber(argument, "double"),
                )
                .join(", ")}}`;
            context.emit(
                `${context.requireEngine(target, call)}.cameras[${target.cpp}.value].${owner.name.text} = ${vector};`,
            );
            return true;
        }
        if (target.kind === "light") {
            return this.compileLightVectorSet(
                context,
                call,
                owner,
                target,
            );
        }
        if (
            target.kind === "asset-root" &&
            (owner.name.text === "position" ||
                owner.name.text === "rotation")
        ) {
            context.assertAssetRootWritable(target, call);
            const components = this.setCallComponents(
                context,
                call,
                3,
                `${owner.name.text}.set`,
            );
            const engine = context.requireEngine(target, call);
            components.forEach((component, axis) =>
                context.emit(
                    `bbl::set_asset_root_${owner.name.text}_component(` +
                        `${engine}, ${target.cpp}, ${axis}u, ${component});`,
                ),
            );
            return true;
        }
        if (target.kind === "transform-node") {
            // A node's TRS lanes are the same ObservableVec3/ObservableQuat
            // a mesh's are -- upstream a TransformNode IS a SceneNode -- so
            // each write moves the field and marks the node's local matrix
            // dirty. The version bump is what a child re-bakes against.
            const property = owner.name.text;
            const setters: Readonly<Record<string, {
                entry: string;
                components: number;
                wide: boolean;
            }>> = {
                position: {
                    entry: "set_transform_node_position",
                    components: 3,
                    wide: true,
                },
                scaling: {
                    entry: "set_transform_node_scaling",
                    components: 3,
                    wide: false,
                },
                rotation: {
                    entry: "set_transform_node_rotation",
                    components: 3,
                    wide: false,
                },
                rotationQuaternion: {
                    entry: "set_transform_node_rotation_quaternion",
                    components: 4,
                    wide: false,
                },
            };
            const setter = setters[property];
            if (!setter) return false;
            const type = setter.wide
                ? "bbl::Vec3d"
                : setter.components === 4
                  ? "bbl::Vec4"
                  : "bbl::Vec3";
            const vector = `${type}{${this.setCallComponents(
                context,
                call,
                setter.components,
                `${property}.set`,
                setter.wide ? "double" : undefined,
            ).join(", ")}}`;
            context.emit(
                `bbl::${setter.entry}(` +
                    `${context.requireEngine(target, call)}, ` +
                    `${target.cpp}, ${vector});`,
            );
            return true;
        }
        if (target.kind !== "mesh") {
            return false;
        }
        if (owner.name.text === "rotationQuaternion") {
            const components = this.setCallComponents(
                context,
                call,
                4,
                "rotationQuaternion.set",
                "float",
            );
            const engine = context.requireEngine(target, call);
            context.emit(
                `bbl::set_mesh_rotation_quaternion(${engine}, ${target.cpp}, ` +
                    `bbl::Vec4{${components.join(", ")}}, ` +
                    `${context.meshTransformDirtyEntry() === "mark_mesh_runtime_transform"});`,
            );
            return true;
        }
        if (!isTrsVectorName(owner.name.text)) {
            return false;
        }
        if (call.arguments.length !== 3) {
            context.fail(
                call,
                `${owner.name.text}.set expects exactly three numeric arguments.`,
            );
        }
        // A mesh's translation is kept at the pin's own width: upstream
        // holds three JavaScript numbers, and at large-world coordinates
        // the float32 ULP is half a unit -- enough to move a silhouette
        // before anything downstream can recover it. Rotation and scaling
        // stay float, which is the width every consumer reads them at.
        const wide = owner.name.text === "position";
        const vector = `${wide ? "bbl::Vec3d" : "bbl::Vec3"}{${call.arguments
            .map((argument) =>
                context.compileNumber(
                    argument,
                    wide ? "double" : undefined,
                ),
            )
            .join(", ")}}`;
        const engine = context.requireEngine(target, call);
        context.emit(
            `${engine}.meshes[${target.cpp}.value].${owner.name.text} = ${vector};`,
        );
        // Baked ordinary geometry includes its parent world matrix. Mark
        // the complete dependent subtree so parent-only motion re-uploads
        // children as well as the mesh directly written here.
        context.emit(
            `bbl::${context.meshTransformDirtyEntry()}(${engine}, ${target.cpp});`,
        );
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
        const setter = lightVectorSetter(target, property);
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
        context.emit(
            `bbl::${setter}(` +
                `${context.requireEngine(target, call)}, ` +
                `${target.cpp}, ` +
                `bbl::Vec3{${components.join(", ")}});`,
        );
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
            ts.isSpreadElement(call.arguments[0]!)
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
            return tupleComponents(
                context.bindDataTuple(value, arity, "spread"),
                arity,
            );
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
     * visibility cascade and cloning walk.
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
        if (node.kind !== "transform-node") {
            return false;
        }
        context.expectArgumentCount(call, 1, 1);
        const child = context.compileValue(call.arguments[0]!);
        context.expectKind(child, "mesh", call.arguments[0]!);
        context.expectSameEngine(node, child, call);
        context.emit(
            `bbl::push_transform_node_child(` +
                `${context.requireEngine(node, call)}, ` +
                `${node.cpp}, ${child.cpp});`,
        );
        return true;
    }

    private emitTaskMethodCall(
        context: StatementLoweringContext,
        call: ts.CallExpression,
    ): boolean {
        if (
            !ts.isPropertyAccessExpression(call.expression) ||
            !ts.isIdentifier(call.expression.expression)
        ) {
            return false;
        }
        const method = call.expression.name.text;
        if (method !== "addMesh" && method !== "updateUniforms") {
            return false;
        }
        const task = context.lookup(
            call.expression.expression,
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
            context.emit(
                `bbl::update_post_process_uniforms(${context.requireEngine(task, call)}, ${task.cpp});`,
            );
            return true;
        }
        context.expectArgumentCount(call, 1, 2);
        const mesh = context.compileValue(
            call.arguments[0]!,
        );
        context.expectKind(
            mesh,
            "mesh",
            call.arguments[0]!,
        );
        context.expectSameEngine(task, mesh, call);
        const engine = context.requireEngine(task, call);
        // The pin's own `opts.material ?? mesh.material`: a call with no
        // override draws the mesh with the material it already carries.
        let materialCpp = `${engine}.meshes[${mesh.cpp}.value].material`;
        if (call.arguments.length === 2) {
            const options = context.expectObjectLiteral(
                call.arguments[1]!,
            );
            const materialExpression = context.objectProperty(
                options,
                "material",
            );
            if (
                !materialExpression ||
                options.properties.length !== 1
            ) {
                context.fail(
                    options,
                    "Reached RenderTask.addMesh requires only a material override.",
                );
            }
            const material = context.compileValue(
                materialExpression,
            );
            context.expectKind(
                material,
                "material",
                materialExpression,
            );
            context.expectSameEngine(task, material, call);
            materialCpp = material.cpp;
        }
        context.emit(
            `bbl::add_render_task_mesh(${engine}, ${task.cpp}, ${mesh.cpp}, ${materialCpp});`,
        );
        return true;
    }
}

/**
 * True when a branch always leaves the surrounding iteration or
 * function, so code after the branch never observes its effects.
 */
function terminatesFlow(statement: ts.Statement): boolean {
    if (
        ts.isContinueStatement(statement) ||
        ts.isBreakStatement(statement) ||
        ts.isReturnStatement(statement) ||
        ts.isThrowStatement(statement)
    ) {
        return true;
    }
    if (ts.isBlock(statement)) {
        const last = statement.statements.at(-1);
        return last ? terminatesFlow(last) : false;
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
