import ts from "typescript";
import { emitParticleAliveGuard } from "./particle-buffer.js";
import {
    isDataTuple,
    tupleComponents,
    type DataIterationElement,
    type DataType,
} from "./data-types.js";
import type {
    CompiledNodeParticles,
    Value,
    ValueKind,
} from "./types.js";
import { lightVectorSetter } from "./assignments.js";
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
    assetRootChildrenIterationTarget(
        expression: ts.Expression,
    ): HandleCollectionTarget | undefined;
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
    captureEmittedLines(emitBody: () => void): string[];
    allocateTemporaryCppName(label: string): string;
    /** How many lines have been emitted, for a caller that may undo. */
    /** Drop every line emitted after `count`. */
    emitVariableDeclaration(
        declaration: ts.VariableDeclaration,
    ): void;
    emitAssignment(expression: ts.BinaryExpression): void;
    compileValue(expression: ts.Expression): Value;
    compileCondition(expression: ts.Expression): string;
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
    isBrowserInstrumentationCall(
        call: ts.CallExpression,
    ): boolean;
    emitPlatformEventListener(call: ts.CallExpression): boolean;
    eraseBrowserInstrumentation(position: number): void;
    /** Whether a loop body reaches pinned scene construction at generation. */
    requiresStaticIteration(statement: ts.Statement): boolean;
    snapshotAliasState(): Map<string, string>;
    restoreAliasState(snapshot: Map<string, string>): void;
    emit(line: string): void;
    increaseIndent(): void;
    decreaseIndent(): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateBlockPrefix(): string;
    fail(node: ts.Node, message: string): never;
}

/**
 * Whether a frame yield sits inside a loop, walking out to the enclosing
 * function.
 *
 * One yield means "the work queued before this has landed", which this
 * runtime satisfies by construction. N of them in a loop mean "let N frames
 * elapse", which it does not — so the shape has to be told apart from the
 * single one rather than erased per iteration.
 */
function frameYieldInsideLoop(node: ts.Node): boolean {
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
            return true;
        }
    }
    return false;
}

/** A loop body's statements, whether or not it was written as a block. */
function bodyStatements(
    statement: ts.IterationStatement,
): readonly ts.Statement[] {
    return ts.isBlock(statement.statement)
        ? statement.statement.statements
        : [statement.statement];
}

// Small counted loops unroll because that keeps generation-known values
// available to scene composition. Large loops stay native when they are only
// data processing, but a body that reaches pinned scene construction must
// still run at generation: emitting such a body once inside C++ would record
// one AOT effect for many runtime iterations.
const MAX_STATIC_INDEX_ITERATIONS = 32;
const MAX_REQUIRED_STATIC_INDEX_ITERATIONS = 4096;
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

export class StatementLowerer {
    private readonly loweredTerminators = new WeakSet<ts.Statement>();

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
        if (ts.isBreakStatement(statement)) {
            if (statement.label) {
                context.fail(
                    statement,
                    "Labeled break is not supported.",
                );
            }
            context.emit("break;");
            return;
        }
        if (ts.isContinueStatement(statement)) {
            if (statement.label) {
                context.fail(
                    statement,
                    "Labeled continue is not supported.",
                );
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
        let found = false;
        const visit = (
            node: ts.Node,
            insideSwitch: boolean,
        ): void => {
            if (found) {
                return;
            }
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
                if (!insideSwitch) {
                    found = true;
                }
                return;
            }
            if (ts.isContinueStatement(node)) {
                found = true;
                return;
            }
            const nestedSwitch =
                insideSwitch || ts.isSwitchStatement(node);
            ts.forEachChild(node, (child) =>
                visit(child, nestedSwitch),
            );
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
                this.emitSwitchBody(
                    context,
                    clause,
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
            this.emitSwitchBody(context, clause);
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
        for (const statement of statements) {
            const nested =
                this.findSwitchBoundBreak(statement);
            if (nested) {
                context.fail(
                    nested,
                    "A switch break is only supported as the final case statement.",
                );
            }
        }
        context.increaseIndent();
        context.pushScope(
            context.allocateBlockPrefix(),
        );
        try {
            for (const statement of statements) {
                this.emit(context, statement);
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

    private emitIf(
        context: StatementLoweringContext,
        statement: ts.IfStatement,
    ): void {
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
        context.emit(`if (${condition}) {`);
        // Alias invalidation is path-sensitive: a branch that always
        // leaves the iteration cannot invalidate anything for the code
        // that follows the `if`, so its effects are rolled back.
        const beforeThen = context.snapshotAliasState();
        this.emitScopedBody(
            context,
            statement.thenStatement,
        );
        if (terminatesFlow(statement.thenStatement)) {
            context.restoreAliasState(beforeThen);
        }
        if (statement.elseStatement) {
            context.emit("} else {");
            const beforeElse = context.snapshotAliasState();
            this.emitScopedBody(
                context,
                statement.elseStatement,
            );
            if (terminatesFlow(statement.elseStatement)) {
                context.restoreAliasState(beforeElse);
            }
        }
        context.emit("}");
    }

    /**
     * Native work may throw at runtime (for example, a platform service that
     * cannot initialize), so a binding-free JavaScript catch maps directly
     * to C++ `catch (...)`. Catch bindings remain outside the value model.
     *
     * A finally block is still accepted only when it erases. Emitting one
     * faithfully on every normal, caught, and exceptional exit needs a scope
     * guard; the existing erasing cleanup cases need no such machinery.
     */
    private emitTry(
        context: StatementLoweringContext,
        statement: ts.TryStatement,
    ): void {
        if (statement.catchClause) {
            if (
                statement.catchClause.variableDeclaration
            ) {
                context.fail(
                    statement.catchClause.variableDeclaration,
                    "Native catch bindings are not supported; use a binding-free catch block.",
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
            if (statement.finallyBlock) {
                const finalizer = context.captureEmittedLines(() => {
                    this.emitScopedBody(
                        context,
                        statement.finallyBlock!,
                    );
                });
                const finalEmission = finalizer.find(
                    (line) => line.trim().length > 0,
                );
                if (finalEmission !== undefined) {
                    context.fail(
                        statement.finallyBlock,
                        "A finally block is lowered only when it erases to " +
                            `nothing; this one emits '${finalEmission.trim()}'.`,
                    );
                }
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
        const finalizer = context.captureEmittedLines(() => {
            this.emitScopedBody(
                context,
                statement.finallyBlock!,
            );
        });
        const emitted = finalizer.find((line) => line.trim().length > 0);
        if (emitted !== undefined) {
            context.fail(
                statement.finallyBlock,
                "A finally block is lowered only when it erases to " +
                    `nothing; this one emits '${emitted.trim()}'.`,
            );
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
                ? context.compileCondition(
                      statement.condition,
                  )
                : "";
            // The incrementor belongs in the for-header so `continue`
            // reaches it, matching JavaScript loop semantics.
            let header = "";
            if (statement.incrementor) {
                const lines =
                    context.captureEmittedLines(() => {
                        this.emitExpression(
                            context,
                            statement.incrementor!,
                        );
                    });
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
                for (const nested of statements) {
                    this.emit(context, nested);
                }
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
        body: ts.Statement,
        bind: () => void,
    ): void {
        context.pushScope(context.allocateBlockPrefix());
        try {
            bind();
            const statements = ts.isBlock(body)
                ? body.statements
                : [body];
            for (const nested of statements) {
                this.emit(context, nested);
            }
        } finally {
            context.popScope();
        }
    }

    private emitStaticIndexFor(
        context: StatementLoweringContext,
        statement: ts.ForStatement,
    ): boolean {
        if (
            !statement.initializer ||
            !ts.isVariableDeclarationList(
                statement.initializer,
            ) ||
            statement.initializer.declarations.length !== 1 ||
            !statement.condition ||
            !statement.incrementor
        ) {
            return false;
        }
        const declaration =
            statement.initializer.declarations[0]!;
        if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer ||
            !ts.isNumericLiteral(
                declaration.initializer,
            ) ||
            Number(declaration.initializer.text) !== 0 ||
            !ts.isBinaryExpression(statement.condition) ||
            statement.condition.operatorToken.kind !==
                ts.SyntaxKind.LessThanToken ||
            !ts.isIdentifier(statement.condition.left) ||
            statement.condition.left.text !==
                declaration.name.text ||
            !ts.isPostfixUnaryExpression(
                statement.incrementor,
            ) ||
            statement.incrementor.operator !==
                ts.SyntaxKind.PlusPlusToken ||
            !ts.isIdentifier(
                statement.incrementor.operand,
            ) ||
            statement.incrementor.operand.text !==
                declaration.name.text
        ) {
            return false;
        }
        const indexBinding = declaration.name;
        const indexName = indexBinding.text;
        const length = context.compileValue(
            statement.condition.right,
        );
        if (
            length.kind !== "number" ||
            length.staticNumber === undefined ||
            !Number.isInteger(length.staticNumber) ||
            length.staticNumber < 0
        ) {
            return false;
        }
        const requiresStaticIteration =
            context.requiresStaticIteration(statement.statement);
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
                statement.condition.right,
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
        for (
            let index = 0;
            index < length.staticNumber;
            index += 1
        ) {
            this.emitUnrolledIteration(
                context,
                statement.statement,
                () => {
                    context.bindCompileTimeValue(indexBinding, {
                        kind: "number",
                        cpp: `${index}.0`,
                        staticNumber: index,
                    });
                },
            );
        }
        return true;
    }

    private emitWhile(
        context: StatementLoweringContext,
        statement: ts.WhileStatement,
    ): void {
        context.emit(
            `while (${context.compileCondition(statement.expression)}) {`,
        );
        this.emitScopedBody(
            context,
            statement.statement,
        );
        context.emit("}");
    }

    private emitDo(
        context: StatementLoweringContext,
        statement: ts.DoStatement,
    ): void {
        context.emit("do {");
        this.emitScopedBody(
            context,
            statement.statement,
        );
        context.emit(
            `} while (${context.compileCondition(statement.expression)});`,
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
        for (const element of values.elements) {
            this.emitUnrolledIteration(
                context,
                statement.statement,
                () => {
                    this.bindStaticIterationValue(
                        context,
                        declaration.name,
                        context.compileValue(element),
                    );
                },
            );
        }
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
                const branch = bodyStatements(
                    statement,
                )[0] as ts.IfStatement;
                this.emitScopedBody(
                    loopContext,
                    branch.elseStatement!,
                );
            },
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
        if (
            ts.isArrayBindingPattern(declaration.name) &&
            context.dataIterationTarget(statement.expression)
        ) {
            // A homogeneous static table already has an exact native row
            // representation. Keep its established range-for lowering;
            // tuple unrolling is needed only for heterogeneous/optional rows.
            return false;
        }
        const elements =
            context.handleCollections.tupleElements(
                statement.expression,
            );
        if (!elements) {
            return false;
        }
        if (this.bindsEnclosingLoop(statement.statement)) {
            context.fail(
                statement,
                "break/continue in for...of requires a runtime data container.",
            );
        }
        for (const element of elements) {
            this.emitUnrolledIteration(
                context,
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
        return true;
    }

    /** Binds one statically unrolled element, including tuple patterns. */
    private bindStaticIterationValue(
        context: StatementLoweringContext,
        name: ts.BindingName,
        value: Value,
    ): void {
        if (ts.isIdentifier(name)) {
            context.bindLocalValue(name, value);
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
                for (const nested of bodyStatements(statement)) {
                    this.emit(loopContext, nested);
                }
            },
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
            for (const nested of statements) {
                this.emit(context, nested);
            }
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
            // `void call()` preserves the call's side effects and discards
            // only its value. At a statement boundary the value was already
            // unused, so lower the operand through the same statement path.
            this.emitExpression(
                context,
                unwrapped.expression,
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
                    target.kind === "data" &&
                    operator === "=" &&
                    context.emitDataAssignment(unwrapped)
                ) {
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
        if (ts.isCallExpression(unwrapped)) {
            const value = context.compileValue(unwrapped);
            if (
                value.kind !== "engine" &&
                value.cpp.length > 0
            ) {
                context.emit(
                    value.requiresExplicitDiscard
                        ? `static_cast<void>(${value.cpp});`
                        : `${value.cpp};`,
                );
            }
            return;
        }
        if (context.isFrameYield(unwrapped)) {
            // One frame's work has already happened by the time this
            // runtime reaches the statement after it. A LOOP of these is a
            // different claim -- "let N frames elapse" -- and erasing each
            // iteration would silently turn it into none, so it refuses.
            if (frameYieldInsideLoop(unwrapped)) {
                context.fail(
                    unwrapped,
                    "A frame yield inside a loop is a multi-frame wait, " +
                        "which this runtime does not lower; it renders the " +
                        "frame the scene asks for, not a count of them.",
                );
            }
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
        if (target.kind !== "mesh") {
            return false;
        }
        if (owner.name.text === "rotationQuaternion") {
            const components = this.setCallComponents(
                context,
                call,
                4,
                "rotationQuaternion.set",
            );
            const engine = context.requireEngine(target, call);
            context.emit(
                `${engine}.meshes[${target.cpp}.value].rotation_quaternion = bbl::Vec4{${components.join(", ")}};`,
            );
            // The pinned mesh composes its world matrix from the quaternion
            // once one is set; the flag is what selects that path over the
            // Euler rotation, exactly as the property-animation writer does.
            context.emit(
                `${engine}.meshes[${target.cpp}.value].has_rotation_quaternion = true;`,
            );
            context.emit(
                `++${engine}.meshes[${target.cpp}.value].transform_version;`,
            );
            return true;
        }
        if (
            !["position", "rotation", "scaling"].includes(
                owner.name.text,
            )
        ) {
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
        // Mark the baked vertex data dirty the way the pinned
        // property-animation evaluator does; the backends re-upload a
        // mesh's transformed vertices only when this version moves.
        context.emit(
            `++${engine}.meshes[${target.cpp}.value].transform_version;`,
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
    ): string[] {
        if (
            call.arguments.length === 1 &&
            ts.isSpreadElement(call.arguments[0]!)
        ) {
            const spread = call.arguments[0] as ts.SpreadElement;
            const value = context.compileValue(spread.expression);
            if (!isDataTuple(value, arity)) {
                context.fail(
                    spread,
                    `${label} spreads a value that is not a ${arity}-element numeric tuple.`,
                );
            }
            const binding = context.allocateTemporaryCppName(
                "spread",
            );
            context.emit(
                `const bbl::js::Tuple<${arity}> ${binding} = ${value.cpp};`,
            );
            return tupleComponents(binding, arity);
        }
        if (call.arguments.length !== arity) {
            context.fail(
                call,
                `${label} expects exactly ${arity} numeric arguments.`,
            );
        }
        return call.arguments.map((argument) =>
            context.compileNumber(argument),
        );
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
