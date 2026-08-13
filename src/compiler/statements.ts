import ts from "typescript";
import type { DataType } from "./data-types.js";
import type {
    Value,
    ValueKind,
} from "./types.js";

export interface StatementLoweringContext {
    emitDataAssignment(
        expression: ts.BinaryExpression,
    ): boolean;
    emitDataPostfix(
        expression: ts.PostfixUnaryExpression,
    ): boolean;
    dataIterationTarget(
        expression: ts.Expression,
    ):
        | { container: Value; element: DataType }
        | undefined;
    bindDataIterationVariable(
        name: ts.BindingName,
        itemCpp: string,
        element: DataType,
    ): void;
    activeNativeReturnType():
        | DataType
        | "void"
        | undefined;
    emitNativeReturn(
        statement: ts.ReturnStatement,
    ): void;
    captureEmittedLines(emitBody: () => void): string[];
    allocateTemporaryCppName(label: string): string;
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
    isBrowserInstrumentationCall(
        call: ts.CallExpression,
    ): boolean;
    isBrowserOnlyExpression(
        expression: ts.Expression,
    ): boolean;
    evaluateBrowserCondition(
        expression: ts.Expression,
    ): boolean | undefined;
    eraseBrowserInstrumentation(position: number): void;
    emit(line: string): void;
    increaseIndent(): void;
    decreaseIndent(): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateBlockPrefix(): string;
    fail(node: ts.Node, message: string): never;
}

export class StatementLowerer {
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
            this.emitIf(context, statement);
            return;
        }
        if (ts.isBlock(statement)) {
            this.emitBlock(context, statement);
            return;
        }
        if (ts.isForStatement(statement)) {
            this.emitFor(context, statement);
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
            context.activeNativeReturnType() !== undefined
        ) {
            context.emitNativeReturn(statement);
            return;
        }
        if (
            ts.isReturnStatement(statement) &&
            !statement.expression
        ) {
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
        context.emit("{");
        context.increaseIndent();
        context.emit(
            `const double ${discriminant} = ${context.compileNumber(statement.expression, "double")};`,
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
                if (pendingLabels.length > 0) {
                    context.fail(
                        clause,
                        "Case fallthrough into default is not supported.",
                    );
                }
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
            pendingLabels.push(
                context.compileNumber(
                    clause.expression,
                    "double",
                ),
            );
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

    private emitSwitchBody(
        context: StatementLoweringContext,
        clause: ts.CaseClause | ts.DefaultClause,
    ): void {
        const statements = [...clause.statements];
        const last = statements.at(-1);
        if (last && ts.isBreakStatement(last)) {
            statements.pop();
        } else if (
            !last ||
            (!ts.isReturnStatement(last) &&
                !ts.isContinueStatement(last) &&
                !ts.isThrowStatement(last))
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
        if (
            context.isBrowserOnlyExpression(
                statement.expression,
            )
        ) {
            const condition =
                context.evaluateBrowserCondition(
                    statement.expression,
                );
            if (condition === undefined) {
                context.fail(
                    statement.expression,
                    "Browser-dependent condition cannot be determined for native AOT lowering.",
                );
            }
            context.eraseBrowserInstrumentation(
                statement.pos,
            );
            if (condition) {
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
            return;
        }
        context.emit(
            `if (${context.compileCondition(statement.expression)}) {`,
        );
        this.emitScopedBody(
            context,
            statement.thenStatement,
        );
        if (statement.elseStatement) {
            context.emit("} else {");
            this.emitScopedBody(
                context,
                statement.elseStatement,
            );
        }
        context.emit("}");
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
        const indexName = declaration.name.text;
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
            context.emit("{");
            context.increaseIndent();
            context.pushScope(
                context.allocateBlockPrefix(),
            );
            try {
                context.bindLocalValue(
                    declaration.name,
                    {
                        kind: "number",
                        cpp: `${index}.0`,
                        staticNumber: index,
                    },
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
        const staticLiteral =
            ts.isIdentifier(declaration.name) &&
            !this.bindsEnclosingLoop(statement.statement)
                ? context.probeStaticArrayLiteral(
                      statement.expression,
                  )
                : undefined;
        if (
            !staticLiteral &&
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
        if (!ts.isIdentifier(declaration.name)) {
            context.fail(
                declaration,
                "Static for...of requires an identifier binding.",
            );
        }
        const values = context.expectStaticArrayLiteral(
            statement.expression,
        );
        for (const element of values.elements) {
            context.emit("{");
            context.increaseIndent();
            context.pushScope(
                context.allocateBlockPrefix(),
            );
            try {
                context.bindLocalValue(
                    declaration.name,
                    context.compileValue(element),
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
        }
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
            `for (const auto& ${item} : ${target.container.cpp}) {`,
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

    private emitExpression(
        context: StatementLoweringContext,
        expression: ts.Expression,
    ): void {
        const unwrapped = context.unwrap(expression);
        if (
            ts.isBinaryExpression(unwrapped) &&
            [
                ts.SyntaxKind.EqualsToken,
                ts.SyntaxKind.PlusEqualsToken,
                ts.SyntaxKind.MinusEqualsToken,
                ts.SyntaxKind.AsteriskEqualsToken,
                ts.SyntaxKind.SlashEqualsToken,
            ].includes(unwrapped.operatorToken.kind)
        ) {
            if (ts.isIdentifier(unwrapped.left)) {
                const target = context.lookup(
                    unwrapped.left,
                );
                const operator = new Map<
                    ts.SyntaxKind,
                    string
                >([
                    [ts.SyntaxKind.EqualsToken, "="],
                    [ts.SyntaxKind.PlusEqualsToken, "+="],
                    [ts.SyntaxKind.MinusEqualsToken, "-="],
                    [
                        ts.SyntaxKind.AsteriskEqualsToken,
                        "*=",
                    ],
                    [
                        ts.SyntaxKind.SlashEqualsToken,
                        "/=",
                    ],
                ]).get(unwrapped.operatorToken.kind)!;
                if (target.kind === "number") {
                    context.emit(
                        `${target.cpp} ${operator} ${context.compileNumber(unwrapped.right, "double")};`,
                    );
                } else if (
                    target.kind === "boolean" &&
                    operator === "="
                ) {
                    context.emit(
                        `${target.cpp} = ${context.compileCondition(unwrapped.right)};`,
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
                context.emit(`${value.cpp};`);
            }
            return;
        }
        context.fail(
            unwrapped,
            `Unsupported expression statement: ${ts.SyntaxKind[unwrapped.kind]}.`,
        );
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
        if (
            !ts.isPropertyAccessExpression(owner) ||
            !ts.isIdentifier(owner.expression)
        ) {
            return false;
        }
        const target = context.lookup(owner.expression);
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
            const vector = `bbl::Vec3{${call.arguments
                .map((argument) =>
                    context.compileNumber(argument),
                )
                .join(", ")}}`;
            context.emit(
                `${context.requireEngine(target, call)}.cameras[${target.cpp}.value].${owner.name.text} = ${vector};`,
            );
            return true;
        }
        if (target.kind !== "mesh") {
            return false;
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
        const vector = `bbl::Vec3{${call.arguments
            .map((argument) =>
                context.compileNumber(argument),
            )
            .join(", ")}}`;
        context.emit(
            `${context.requireEngine(target, call)}.meshes[${target.cpp}.value].${owner.name.text} = ${vector};`,
        );
        return true;
    }

    private emitTaskMethodCall(
        context: StatementLoweringContext,
        call: ts.CallExpression,
    ): boolean {
        if (
            !ts.isPropertyAccessExpression(call.expression) ||
            call.expression.name.text !== "addMesh" ||
            !ts.isIdentifier(call.expression.expression)
        ) {
            return false;
        }
        const task = context.lookup(
            call.expression.expression,
        );
        if (task.kind !== "task") {
            return false;
        }
        context.expectArgumentCount(call, 2, 2);
        const mesh = context.compileValue(
            call.arguments[0]!,
        );
        context.expectKind(
            mesh,
            "mesh",
            call.arguments[0]!,
        );
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
        context.expectSameEngine(task, mesh, call);
        context.expectSameEngine(task, material, call);
        context.emit(
            `bbl::add_render_task_mesh(${context.requireEngine(task, call)}, ${task.cpp}, ${mesh.cpp}, ${material.cpp});`,
        );
        return true;
    }
}
