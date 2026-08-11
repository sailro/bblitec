import ts from "typescript";
import type {
    Value,
    ValueKind,
} from "./types.js";

export interface StatementLoweringContext {
    emitVariableDeclaration(
        declaration: ts.VariableDeclaration,
    ): void;
    emitAssignment(expression: ts.BinaryExpression): void;
    compileValue(expression: ts.Expression): Value;
    compileCondition(expression: ts.Expression): string;
    compileNumber(expression: ts.Expression): string;
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
        if (
            ts.isReturnStatement(statement) &&
            !statement.expression
        ) {
            return;
        }
        if (ts.isEmptyStatement(statement)) {
            return;
        }
        context.fail(
            statement,
            `Unsupported statement: ${ts.SyntaxKind[statement.kind]}.`,
        );
    }

    private emitIf(
        context: StatementLoweringContext,
        statement: ts.IfStatement,
    ): void {
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
            ].includes(unwrapped.operatorToken.kind)
        ) {
            context.emitAssignment(unwrapped);
            return;
        }
        if (
            ts.isPostfixUnaryExpression(unwrapped) &&
            unwrapped.operator ===
                ts.SyntaxKind.PlusPlusToken &&
            ts.isIdentifier(unwrapped.operand)
        ) {
            const target = context.lookup(unwrapped.operand);
            context.expectKind(
                target,
                "number",
                unwrapped.operand,
            );
            context.emit(`${target.cpp}++;`);
            return;
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
