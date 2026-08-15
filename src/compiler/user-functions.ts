import ts from "typescript";
import type { Value } from "./types.js";

type Fail = (node: ts.Node, message: string) => never;
export type SupportedFunction =
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction;

/**
 * Resolves an identifier to a reachable local function declaration and
 * validates the shared structural constraints (no generators, generics, or
 * rest parameters). Both the inline lowerer and the native data-function
 * lowerer resolve through this helper.
 */
export function resolveFunctionDeclaration(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
    fail: Fail,
): SupportedFunction | undefined {
    // A record property written in shorthand (`{ sync }`) resolves at
    // its own identifier to the literal's property symbol, so the
    // shorthand's value symbol is what names the function it refers to.
    const symbol =
        ts.isShorthandPropertyAssignment(
            identifier.parent,
        ) && identifier.parent.name === identifier
            ? checker.getShorthandAssignmentValueSymbol(
                  identifier.parent,
              )
            : checker.getSymbolAtLocation(identifier);
    if (!symbol) {
        return undefined;
    }
    const target =
        (symbol.flags & ts.SymbolFlags.Alias) !== 0
            ? checker.getAliasedSymbol(symbol)
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
            (ts.isArrowFunction(candidate.initializer) ||
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
    for (const parameter of declaration.parameters) {
        if (
            !ts.isIdentifier(parameter.name) ||
            parameter.dotDotDotToken
        ) {
            fail(
                parameter,
                "User-function parameters must be non-rest identifiers.",
            );
        }
    }
    return declaration;
}

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
    needsWrapper: boolean;
}

export interface UserFunctionContext {
    compileValue(expression: ts.Expression): Value;
    emitStatement(statement: ts.Statement): void;
    bindLocalValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    bindParameterValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateUserFunctionPrefix(): string;
    beginInlineFrame(wrapped: boolean): void;
    endInlineFrame(): void;
    emit(line: string): void;
    increaseIndent(): void;
    decreaseIndent(): void;
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

    /**
     * `inBodyScope` wraps only the body lowering. A record method
     * closes over the scope that built the record, but its arguments
     * are written at the call site and belong to the scope there, so
     * they are evaluated before the wrapper takes effect.
     */
    public compile(
        context: UserFunctionContext,
        call: ts.CallExpression,
        identifier: ts.Identifier,
        inBodyScope: <T>(work: () => T) => T = (work) =>
            work(),
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
        const argumentValues = call.arguments.map(
            (argument) =>
                this.argumentValue(context, argument),
        );
        return inBodyScope(() =>
            this.lower(context, ir, argumentValues, call),
        );
    }

    /**
     * Inline function-literal arguments bind as callback values; every
     * other argument compiles normally.
     */
    private argumentValue(
        context: UserFunctionContext,
        argument: ts.Expression,
    ): Value {
        if (
            ts.isArrowFunction(argument) ||
            ts.isFunctionExpression(argument)
        ) {
            return {
                kind: "callback",
                cpp: "",
                callbackDeclaration: argument,
            };
        }
        return context.compileValue(argument);
    }

    /**
     * Inlines a call whose target is a bound callback value (a function
     * literal passed as an argument to the enclosing user function).
     */
    public compileCallbackCall(
        context: UserFunctionContext,
        call: ts.CallExpression,
        declaration: SupportedFunction,
        inBodyScope: <T>(work: () => T) => T = (work) =>
            work(),
    ): Value {
        const ir = this.irFor(
            declaration,
            "callback",
            (node, message) =>
                context.fail(node, message),
        );
        this.validateCall(
            call,
            ir,
            (node, message) =>
                context.fail(node, message),
        );
        // As in `compile`: the arguments were written at the call site
        // and resolve in the scope there, so only the body runs in the
        // scope the callback closed over.
        const argumentValues = call.arguments.map(
            (argument) =>
                this.argumentValue(context, argument),
        );
        return inBodyScope(() =>
            this.lower(context, ir, argumentValues, call),
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
                context.bindParameterValue(
                    parameter.name,
                    value,
                );
            });
            if (ir.needsWrapper) {
                context.emit("do {");
                context.increaseIndent();
            }
            context.beginInlineFrame(ir.needsWrapper);
            try {
                for (const statement of ir.statements) {
                    context.emitStatement(statement);
                }
            } finally {
                context.endInlineFrame();
            }
            if (ir.needsWrapper) {
                context.decreaseIndent();
                context.emit("} while (false);");
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
        const declaration = resolveFunctionDeclaration(
            this.checker,
            identifier,
            fail,
        );
        if (!declaration) {
            return undefined;
        }
        return this.irFor(
            declaration,
            identifier.text,
            fail,
        );
    }

    private irFor(
        declaration: SupportedFunction,
        nameHint: string,
        fail: Fail,
    ): UserFunctionIr {
        const cached = this.cache.get(declaration);
        if (cached) {
            return cached;
        }
        const parameters = declaration.parameters.map(
            (parameter): UserFunctionParameterIr => {
                if (!ts.isIdentifier(parameter.name)) {
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
        if (!body) {
            fail(
                declaration,
                "Reached user functions require a body.",
            );
        }
        // A concise arrow body is exactly `{ return <expression>; }`, so
        // it lowers as the final value return with no statements before
        // it. `frameForIndex: (index) => 8 + (index % 16)` is that shape.
        if (!ts.isBlock(body)) {
            const conciseIr: UserFunctionIr = {
                declaration,
                name: nameHint,
                parameters,
                statements: [],
                needsWrapper: false,
                returnExpression: body,
            };
            this.cache.set(declaration, conciseIr);
            return conciseIr;
        }
        // The final statement may be a value return; earlier bare returns
        // lower through a breakable wrapper. Everything else is rejected.
        const finalStatement = body.statements.at(-1);
        const finalReturn =
            finalStatement &&
            ts.isReturnStatement(finalStatement)
                ? finalStatement
                : undefined;
        const statements = finalReturn
            ? body.statements.slice(0, -1)
            : body.statements;
        const needsWrapper = this.validateEarlyReturns(
            statements,
            fail,
        );
        if (needsWrapper && finalReturn?.expression) {
            fail(
                finalReturn,
                "Inlined functions cannot combine early returns with a final return value.",
            );
        }
        const ir: UserFunctionIr = {
            declaration,
            name:
                (ts.isFunctionDeclaration(declaration) ||
                ts.isFunctionExpression(declaration)
                    ? declaration.name?.text
                    : undefined) ?? nameHint,
            parameters,
            statements,
            needsWrapper,
            ...(finalReturn?.expression
                ? {
                      returnExpression:
                          finalReturn.expression,
                  }
                : {}),
        };
        this.cache.set(declaration, ir);
        return ir;
    }

    /**
     * Validates early returns in an inlined body: bare returns are allowed
     * outside loops and switches (they lower to a breakable wrapper);
     * value returns before the final statement are rejected.
     */
    private validateEarlyReturns(
        statements: readonly ts.Statement[],
        fail: Fail,
    ): boolean {
        let found = false;
        const visit = (
            node: ts.Node,
            insideBreakable: boolean,
        ): void => {
            if (ts.isFunctionLike(node)) {
                return;
            }
            if (ts.isReturnStatement(node)) {
                if (node.expression) {
                    fail(
                        node,
                        "Inlined functions support a value return only as the final statement.",
                    );
                }
                if (insideBreakable) {
                    fail(
                        node,
                        "Early returns inside loops or switches of inlined functions are not supported.",
                    );
                }
                found = true;
                return;
            }
            const breakable =
                insideBreakable ||
                ts.isIterationStatement(node, false) ||
                ts.isSwitchStatement(node);
            ts.forEachChild(node, (child) =>
                visit(child, breakable),
            );
        };
        for (const statement of statements) {
            visit(statement, false);
        }
        return found;
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
