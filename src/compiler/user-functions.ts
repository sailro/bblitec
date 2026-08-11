import ts from "typescript";
import type { Value } from "./types.js";

type Fail = (node: ts.Node, message: string) => never;
type SupportedFunction =
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction;

export interface UserFunctionParameterIr {
    declaration: ts.ParameterDeclaration;
    name: ts.Identifier;
    type: ts.Type;
}

export interface UserFunctionIr {
    declaration: SupportedFunction;
    name: string;
    parameters: UserFunctionParameterIr[];
    statements: readonly ts.Statement[];
    returnExpression?: ts.Expression | undefined;
}

export interface UserFunctionContext {
    compileValue(expression: ts.Expression): Value;
    emitStatement(statement: ts.Statement): void;
    bindLocalValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateUserFunctionPrefix(): string;
    fail(node: ts.Node, message: string): never;
}

export class UserFunctionLowerer {
    private readonly cache = new Map<
        SupportedFunction,
        UserFunctionIr
    >();
    private readonly active =
        new Set<SupportedFunction>();

    public constructor(
        private readonly checker: ts.TypeChecker,
    ) {}

    public compile(
        context: UserFunctionContext,
        call: ts.CallExpression,
        identifier: ts.Identifier,
    ): Value | undefined {
        const ir = this.resolve(
            identifier,
            (node, message) =>
                context.fail(node, message),
        );
        if (!ir) {
            return undefined;
        }
        this.validateCall(
            call,
            ir,
            (node, message) =>
                context.fail(node, message),
        );
        return this.lower(
            context,
            ir,
            call.arguments.map((argument) =>
                context.compileValue(argument),
            ),
            call,
        );
    }

    public compileReference(
        context: UserFunctionContext,
        identifier: ts.Identifier,
    ): Value | undefined {
        const ir = this.resolve(
            identifier,
            (node, message) =>
                context.fail(node, message),
        );
        if (!ir) {
            return undefined;
        }
        if (
            ir.parameters.some(
                ({ declaration }) =>
                    !declaration.initializer,
            )
        ) {
            context.fail(
                identifier,
                `Callback '${ir.name}' requires arguments.`,
            );
        }
        return this.lower(
            context,
            ir,
            [],
            identifier,
        );
    }

    private lower(
        context: UserFunctionContext,
        ir: UserFunctionIr,
        arguments_: readonly Value[],
        callNode: ts.Node,
    ): Value {
        if (this.active.has(ir.declaration)) {
            context.fail(
                callNode,
                `Recursive call to '${ir.name}' is not supported.`,
            );
        }
        this.active.add(ir.declaration);
        context.pushScope(
            context.allocateUserFunctionPrefix(),
        );
        try {
            ir.parameters.forEach((parameter, index) => {
                const argument = arguments_[index];
                const value =
                    argument ??
                    (parameter.declaration.initializer
                        ? context.compileValue(
                              parameter.declaration
                                  .initializer,
                          )
                        : context.fail(
                              parameter.declaration,
                              `Optional parameter '${parameter.name.text}' requires a default value in reached user functions.`,
                          ));
                context.bindLocalValue(
                    parameter.name,
                    value,
                );
            });
            for (const statement of ir.statements) {
                context.emitStatement(statement);
            }
            return ir.returnExpression
                ? context.compileValue(ir.returnExpression)
                : { kind: "void", cpp: "" };
        } finally {
            context.popScope();
            this.active.delete(ir.declaration);
        }
    }

    private resolve(
        identifier: ts.Identifier,
        fail: Fail,
    ): UserFunctionIr | undefined {
        const symbol =
            this.checker.getSymbolAtLocation(identifier);
        if (!symbol) {
            return undefined;
        }
        const target =
            (symbol.flags & ts.SymbolFlags.Alias) !== 0
                ? this.checker.getAliasedSymbol(symbol)
                : symbol;
        let declaration: SupportedFunction | undefined;
        for (const candidate of target.declarations ?? []) {
            if (
                ts.isFunctionDeclaration(candidate) &&
                candidate.body
            ) {
                declaration = candidate;
                break;
            }
            if (
                ts.isVariableDeclaration(candidate) &&
                candidate.initializer &&
                (ts.isArrowFunction(
                    candidate.initializer,
                ) ||
                    ts.isFunctionExpression(
                        candidate.initializer,
                    ))
            ) {
                declaration = candidate.initializer;
                break;
            }
        }
        if (!declaration) {
            return undefined;
        }
        const cached = this.cache.get(declaration);
        if (cached) {
            return cached;
        }
        if (
            (ts.isFunctionExpression(declaration) ||
                ts.isFunctionDeclaration(declaration)) &&
            declaration.asteriskToken
        ) {
            fail(
                declaration.asteriskToken,
                "Generator functions are not supported.",
            );
        }
        if (declaration.typeParameters?.length) {
            fail(
                declaration.typeParameters[0]!,
                "Generic user functions are not supported.",
            );
        }
        const parameters = declaration.parameters.map(
            (parameter): UserFunctionParameterIr => {
                if (
                    !ts.isIdentifier(parameter.name) ||
                    parameter.dotDotDotToken
                ) {
                    fail(
                        parameter,
                        "User-function parameters must be non-rest identifiers.",
                    );
                }
                return {
                    declaration: parameter,
                    name: parameter.name,
                    type: this.checker.getTypeAtLocation(
                        parameter,
                    ),
                };
            },
        );
        const body = declaration.body;
        if (!body || !ts.isBlock(body)) {
            fail(
                body ?? declaration,
                "User arrow functions require a block body.",
            );
        }
        const returns = body.statements.filter(
            (
                statement,
            ): statement is ts.ReturnStatement =>
                ts.isReturnStatement(statement),
        );
        if (returns.length > 1) {
            fail(
                returns[1]!,
                "User functions support one final return statement.",
            );
        }
        const returned = returns[0];
        if (
            returned &&
            body.statements.at(-1) !== returned
        ) {
            fail(
                returned,
                "A user-function return must be the final statement.",
            );
        }
        const ir: UserFunctionIr = {
            declaration,
            name:
                (ts.isFunctionDeclaration(declaration) ||
                ts.isFunctionExpression(declaration)
                    ? declaration.name?.text
                    : undefined) ?? target.getName(),
            parameters,
            statements: returned
                ? body.statements.slice(0, -1)
                : body.statements,
            ...(returned?.expression
                ? {
                      returnExpression:
                          returned.expression,
                  }
                : {}),
        };
        this.cache.set(declaration, ir);
        return ir;
    }

    private validateCall(
        call: ts.CallExpression,
        ir: UserFunctionIr,
        fail: Fail,
    ): void {
        if (call.arguments.some(ts.isSpreadElement)) {
            fail(
                call,
                "Spread arguments are not supported for user functions.",
            );
        }
        const minimum = ir.parameters.filter(
            ({ declaration }) =>
                !declaration.initializer &&
                !declaration.questionToken,
        ).length;
        if (
            call.arguments.length < minimum ||
            call.arguments.length > ir.parameters.length
        ) {
            fail(
                call,
                `Function '${ir.name}' expects ${minimum}-${ir.parameters.length} arguments, received ${call.arguments.length}.`,
            );
        }
        call.arguments.forEach((argument, index) => {
            const parameter = ir.parameters[index];
            if (!parameter) {
                return;
            }
            const argumentType =
                this.checker.getTypeAtLocation(argument);
            if (
                !this.checker.isTypeAssignableTo(
                    argumentType,
                    parameter.type,
                )
            ) {
                fail(
                    argument,
                    `Argument ${index + 1} of '${ir.name}' is ${this.checker.typeToString(argumentType)}, not ${this.checker.typeToString(parameter.type)}.`,
                );
            }
        });
    }

}
