import ts from "typescript";
import { sanitizeCppIdentifier } from "../cpp-literals.js";
import {
    passesByReference,
    type DataType,
    type DataTypeRegistry,
} from "./data-types.js";
import type { Value } from "./types.js";
import {
    readOnlyDataMethods,
    storingDataMethods,
} from "./data-methods.js";

type Fail = (node: ts.Node, message: string) => never;
export type SupportedFunction =
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration;

/** Conservatively determines whether a function leaves a parameter unchanged. */
export function parameterIsReadOnly(
    checker: ts.TypeChecker,
    declaration: SupportedFunction,
    parameter: ts.Identifier,
    active = new Set<ts.Symbol>(),
): boolean {
    const symbol = checker.getSymbolAtLocation(parameter);
    if (!symbol || !declaration.body) return false;
    if (active.has(symbol)) return true;
    active.add(symbol);
    const aliases = new Set<ts.Symbol>([symbol]);
    const unwrap = (expression: ts.Expression): ts.Expression => {
        let current = expression;
        while (
            ts.isParenthesizedExpression(current) ||
            ts.isAsExpression(current) ||
            ts.isTypeAssertionExpression(current) ||
            ts.isNonNullExpression(current) ||
            ts.isSatisfiesExpression(current)
        ) {
            current = current.expression;
        }
        return current;
    };
    const namesParameter = (node: ts.Node): boolean =>
        ts.isIdentifier(node) &&
        aliases.has(checker.getSymbolAtLocation(node)!);
    const containsParameter = (node: ts.Node): boolean => {
        let found = false;
        const visit = (candidate: ts.Node): void => {
            if (found) return;
            if (namesParameter(candidate)) {
                found = true;
                return;
            }
            ts.forEachChild(candidate, visit);
        };
        visit(node);
        return found;
    };
    const rootNamesParameter = (
        expression: ts.Expression,
    ): boolean => {
        let current = unwrap(expression);
        while (
            ts.isPropertyAccessExpression(current) ||
            ts.isElementAccessExpression(current)
        ) {
            current = unwrap(current.expression);
        }
        return namesParameter(current);
    };
    let readOnly = true;
    const visit = (node: ts.Node): void => {
        if (!readOnly) return;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind >=
                ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <=
                ts.SyntaxKind.LastAssignment &&
            rootNamesParameter(node.left)
        ) {
            readOnly = false;
            return;
        }
        if (
            (ts.isPrefixUnaryExpression(node) ||
                ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken ||
                node.operator ===
                    ts.SyntaxKind.MinusMinusToken) &&
            rootNamesParameter(node.operand)
        ) {
            readOnly = false;
            return;
        }
        if (ts.isCallExpression(node)) {
            if (
                ts.isPropertyAccessExpression(
                    node.expression,
                ) &&
                rootNamesParameter(
                    node.expression.expression,
                ) &&
                !readOnlyDataMethods.has(
                    node.expression.name.text,
                )
            ) {
                readOnly = false;
                return;
            }
            const signature = checker.getResolvedSignature(node);
            const called = signature?.declaration;
            for (const [index, argument] of node.arguments.entries()) {
                if (!containsParameter(argument)) continue;
                if (
                    ts.isPropertyAccessExpression(
                        node.expression,
                    ) &&
                    !rootNamesParameter(
                        node.expression.expression,
                    ) &&
                    storingDataMethods.has(
                        node.expression.name.text,
                    )
                ) {
                    continue;
                }
                const calledParameter = called?.parameters[index];
                if (
                    !called ||
                    !(
                        ts.isFunctionDeclaration(called) ||
                        ts.isFunctionExpression(called) ||
                        ts.isArrowFunction(called)
                    ) ||
                    !calledParameter ||
                    !ts.isIdentifier(calledParameter.name) ||
                    !parameterIsReadOnly(
                        checker,
                        called,
                        calledParameter.name,
                        active,
                    )
                ) {
                    readOnly = false;
                    return;
                }
            }
        }
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isIdentifier(node.name) &&
            rootNamesParameter(node.initializer)
        ) {
            const alias = checker.getSymbolAtLocation(
                node.name,
            );
            if (alias) aliases.add(alias);
            return;
        }
        if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            containsParameter(node.initializer) &&
            (checker.getTypeAtLocation(node.initializer)
                .flags &
                ts.TypeFlags.Object) !==
                0
        ) {
            // A composite wrapper can retain the parameter and expose a
            // second mutation path that this local alias set cannot follow.
            readOnly = false;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration.body);
    active.delete(symbol);
    return readOnly;
}

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
    needsValueLambda: boolean;
    needsLocalNative: boolean;
}

export interface UserFunctionContext {
    readonly dataTypes: DataTypeRegistry;
    compileValue(expression: ts.Expression): Value;
    isBrowserOnlyExpression(expression: ts.Expression): boolean;
    compileForDataSink(
        expression: ts.Expression,
        dataType: DataType,
    ): string;
    dataValue(cpp: string, dataType: DataType): Value;
    emitStatement(statement: ts.Statement): void;
    bindLocalValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    bindCompileTimeValue(
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
    reachJsData(): void;
    beginInlineFrame(wrapped: boolean): void;
    endInlineFrame(): void;
    beginNativeFunctionBody(returnType: DataType | undefined): void;
    endNativeFunctionBody(): void;
    emit(line: string): void;
    increaseIndent(): void;
    decreaseIndent(): void;
    fail(node: ts.Node, message: string): never;
}

export class UserFunctionLowerer {
    private readonly directCallCache = new Map<
        SupportedFunction,
        ReadonlySet<SupportedFunction>
    >();
    private readonly recursiveGroupCache = new Map<
        SupportedFunction,
        readonly SupportedFunction[] | null
    >();

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
            true,
        );
        const argumentValues = call.arguments.map(
            (argument) =>
                this.argumentValue(context, argument),
        );
        const recursiveGroup = this.recursiveGroup(
            ir.declaration,
            (node, message) => context.fail(node, message),
        );
        if (recursiveGroup) {
            return this.lowerRecursiveGroup(
                context,
                ir,
                call,
                argumentValues,
                recursiveGroup,
            );
        }
        if (ir.needsLocalNative) {
            return this.lowerRecursiveGroup(
                context,
                ir,
                call,
                argumentValues,
                [ir.declaration],
            );
        }
        return inBodyScope(() =>
            this.lower(context, ir, argumentValues, call),
        );
    }

    /**
     * Inline function-literal arguments and local names bound to function
     * declarations bind as callback values; every other argument compiles
     * normally.
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
        if (ts.isIdentifier(argument)) {
            const declaration = resolveFunctionDeclaration(
                this.checker,
                argument,
                (node, message) => context.fail(node, message),
            );
            if (declaration) {
                return {
                    kind: "callback",
                    cpp: "",
                    callbackDeclaration: declaration,
                };
            }
        }
        if (
            context.isBrowserOnlyExpression(argument) &&
            !ts.isCallExpression(argument)
        ) {
            return { kind: "browser", cpp: "" };
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
            true,
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

    /**
     * Invokes a local `std::function` produced for a recursive function
     * specialization. Data arguments remain runtime parameters; values
     * outside the data model are captured and must stay identical for every
     * call in the specialization.
     */
    public compileNativeCallbackCall(
        context: UserFunctionContext,
        call: ts.CallExpression,
        bound: Value,
    ): Value | undefined {
        const parameterTypes = bound.nativeCallbackParameterTypes;
        const declaration = bound.callbackDeclaration;
        if (!declaration) {
            return undefined;
        }
        if (ts.isIdentifier(declaration)) {
            if (bound.cpp.length > 0) {
                context.fail(
                    declaration,
                    "Native callback is missing its function signature.",
                );
            }
            return undefined;
        }
        if (!parameterTypes) {
            if (bound.cpp.length === 0) {
                return undefined;
            }
            const signature = this.checker.getSignatureFromDeclaration(
                declaration,
            );
            if (!signature) {
                context.fail(
                    declaration,
                    "Native callback is missing its function signature.",
                );
            }
            if (call.arguments.length > declaration.parameters.length) {
                context.fail(
                    call,
                    "Native callback received too many arguments.",
                );
            }
            const argumentsCpp = declaration.parameters.map(
                (parameter, index) => {
                    const argument =
                        call.arguments[index] ??
                        parameter.initializer;
                    if (!argument) {
                        context.fail(
                            call,
                            `Native callback requires argument ${index + 1}.`,
                        );
                    }
                    const type = context.dataTypes.fromTsType(
                        this.checker.getTypeAtLocation(parameter),
                        parameter,
                    );
                    if (!type) {
                        context.fail(
                            parameter,
                            "Native callback parameters must have plain-data types.",
                        );
                    }
                    return context.compileForDataSink(
                        argument,
                        type,
                    );
                },
            );
            const cpp = `${bound.cpp}(${argumentsCpp.join(", ")})`;
            const returnTsType =
                this.checker.getReturnTypeOfSignature(signature);
            if ((returnTsType.flags & ts.TypeFlags.Void) !== 0) {
                return { kind: "void", cpp };
            }
            const returnType = context.dataTypes.fromTsType(
                returnTsType,
                declaration,
            );
            if (!returnType) {
                context.fail(
                    declaration,
                    "Native callback return type must be plain data or void.",
                );
            }
            return context.dataValue(cpp, returnType);
        }
        if (call.arguments.length > declaration.parameters.length) {
            context.fail(call, "Recursive function received too many arguments.");
        }
        const captured = bound.nativeCallbackStaticArguments;
        if (!captured) {
            context.fail(call, "Recursive function is missing its captured arguments.");
        }
        const runtimeArguments: string[] = [];
        declaration.parameters.forEach((parameter, index) => {
            const argument = call.arguments[index] ?? parameter.initializer;
            if (!argument) {
                context.fail(
                    call,
                    `Recursive function requires argument ${index + 1}.`,
                );
            }
            const type = parameterTypes[index];
            if (type) {
                runtimeArguments.push(
                    context.compileForDataSink(argument, type),
                );
                return;
            }
            const value = this.argumentValue(context, argument);
            const existing = captured[index];
            if (existing && !this.sameCapturedValue(existing, value)) {
                context.fail(
                    argument,
                    "A recursive function was called with a different compile-time argument; separate runtime class/resource specializations are not supported at one call site.",
                );
            }
            captured[index] = existing ?? value;
        });
        const cpp = `${bound.cpp}(${runtimeArguments.join(", ")})`;
        return bound.nativeCallbackReturnType
            ? context.dataValue(cpp, bound.nativeCallbackReturnType)
            : { kind: "void", cpp };
    }

    private sameCapturedValue(left: Value, right: Value): boolean {
        return (
            left === right ||
            (left.kind === right.kind &&
                left.cpp === right.cpp &&
                left.objectIdentityCpp === right.objectIdentityCpp &&
                left.recordProperties === right.recordProperties)
        );
    }

    /** Finds the strongly connected call-graph component containing root. */
    private recursiveGroup(
        root: SupportedFunction,
        fail: Fail,
    ): readonly SupportedFunction[] | undefined {
        const cached = this.recursiveGroupCache.get(root);
        if (cached !== undefined) return cached ?? undefined;
        const direct = (declaration: SupportedFunction) =>
            this.directCalls(declaration, fail);
        const reachable = new Set<SupportedFunction>();
        const collect = (declaration: SupportedFunction): void => {
            if (reachable.has(declaration)) return;
            reachable.add(declaration);
            for (const called of direct(declaration)) collect(called);
        };
        collect(root);
        const callers = new Map<
            SupportedFunction,
            Set<SupportedFunction>
        >();
        for (const declaration of reachable) {
            for (const called of direct(declaration)) {
                if (!reachable.has(called)) continue;
                const entries = callers.get(called) ?? new Set();
                entries.add(declaration);
                callers.set(called, entries);
            }
        }
        const reachesRoot = new Set<SupportedFunction>([
            root,
        ]);
        const pending = [root];
        while (pending.length > 0) {
            const current = pending.pop()!;
            for (const caller of callers.get(current) ?? []) {
                if (reachesRoot.has(caller)) continue;
                reachesRoot.add(caller);
                pending.push(caller);
            }
        }
        const group = [...reachable].filter((declaration) =>
            reachesRoot.has(declaration),
        );
        if (group.length === 1 && !direct(root).has(root)) {
            this.recursiveGroupCache.set(root, null);
            return undefined;
        }
        const ordered = [
            root,
            ...group.filter((declaration) => declaration !== root),
        ];
        this.recursiveGroupCache.set(root, ordered);
        return ordered;
    }

    private directCalls(
        declaration: SupportedFunction,
        fail: Fail,
    ): ReadonlySet<SupportedFunction> {
        const cached = this.directCallCache.get(declaration);
        if (cached) return cached;
        const callees = new Set<SupportedFunction>();
        const body = declaration.body;
        const visit = (node: ts.Node): void => {
            if (node !== body && ts.isFunctionLike(node)) return;
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression)
            ) {
                const called = resolveFunctionDeclaration(
                    this.checker,
                    node.expression,
                    fail,
                );
                if (called) callees.add(called);
            }
            ts.forEachChild(node, visit);
        };
        if (body) visit(body);
        this.directCallCache.set(declaration, callees);
        return callees;
    }

    private lowerRecursiveGroup(
        context: UserFunctionContext,
        root: UserFunctionIr,
        call: ts.CallExpression,
        rootArguments: readonly Value[],
        declarations: readonly SupportedFunction[],
    ): Value {
        const entries = declarations.map((declaration) => {
            const ir = this.recursiveIrFor(
                declaration,
                this.declarationName(declaration),
                (node, message) => context.fail(node, message),
            );
            const signature = this.checker.getSignatureFromDeclaration(declaration);
            if (!signature) {
                context.fail(declaration, "Recursive function has no callable signature.");
            }
            const returnTsType = this.checker.getReturnTypeOfSignature(signature);
            const returnType =
                (returnTsType.flags & ts.TypeFlags.Void) !== 0
                    ? undefined
                    : context.dataTypes.fromTsType(returnTsType, declaration);
            if ((returnTsType.flags & ts.TypeFlags.Void) === 0 && !returnType) {
                context.fail(
                    declaration,
                    "Recursive function return type must be plain data or void.",
                );
            }
            const parameterTypes = ir.parameters.map(({ type, declaration: parameter }) => {
                const mapped = context.dataTypes.fromTsType(type, parameter);
                return mapped && !context.dataTypes.carriesHandle(mapped)
                    ? mapped
                    : undefined;
            });
            const parameterReadOnly = ir.parameters.map(
                ({ name: parameter }) =>
                    parameterIsReadOnly(
                        this.checker,
                        declaration,
                        parameter,
                    ),
            );
            const cppName =
                `bbl_recursive_${context.allocateUserFunctionPrefix()}` +
                sanitizeCppIdentifier(this.declarationName(declaration));
            const captured: (Value | undefined)[] = new Array(
                parameterTypes.length,
            );
            const value: Value = {
                kind: "callback",
                cpp: cppName,
                callbackDeclaration: declaration,
                nativeCallbackParameterTypes: parameterTypes,
                nativeCallbackStaticArguments: captured,
                ...(returnType ? { nativeCallbackReturnType: returnType } : {}),
            };
            return {
                ir,
                declaration,
                returnType,
                parameterTypes,
                parameterReadOnly,
                cppName,
                captured,
                value,
            };
        });
        const entryByDeclaration = new Map(
            entries.map((entry) => [entry.declaration, entry]),
        );
        const rootEntry = entryByDeclaration.get(root.declaration)!;
        root.parameters.forEach((parameter, index) => {
            if (rootEntry.parameterTypes[index]) return;
            const value =
                rootArguments[index] ??
                (parameter.declaration.initializer
                    ? context.compileValue(parameter.declaration.initializer)
                    : context.fail(
                          parameter.declaration,
                          `Recursive function requires argument '${parameter.name.text}'.`,
                      ));
            rootEntry.captured[index] = value;
        });

        context.reachJsData();
        for (const entry of entries) {
            const returnCpp = entry.returnType
                ? context.dataTypes.cppType(entry.returnType)
                : "void";
            const parametersCpp = entry.parameterTypes
                .map((type, index) =>
                    type
                        ? this.recursiveParameterCpp(
                              context.dataTypes,
                              type,
                              entry.parameterReadOnly[index]!,
                          )
                        : undefined,
                )
                .filter((type): type is string => type !== undefined);
            context.emit(
                `std::function<${returnCpp}(${parametersCpp.join(", ")})> ${entry.cppName};`,
            );
        }

        // These symbol bindings exist only while the specialized bodies are
        // generated. A later source call may observe different compile-time
        // class/resource arguments and receives its own local specialization.
        context.pushScope(context.allocateUserFunctionPrefix());
        try {
            for (const entry of entries) {
                const identifier = this.declarationIdentifier(entry.declaration);
                context.bindLocalValue(identifier, entry.value);
            }
            const pending = new Set(entries);
            while (pending.size > 0) {
                const entry = [...pending].find((candidate) =>
                    candidate.parameterTypes.every(
                        (type, index) =>
                            type !== undefined ||
                            candidate.captured[index] !== undefined,
                    ),
                );
                if (!entry) {
                    context.fail(
                        call,
                        "Recursive function group has a compile-time parameter that no reached call supplies.",
                    );
                }
                pending.delete(entry);
                this.emitRecursiveFunctionBody(context, entry);
            }
        } finally {
            context.popScope();
        }
        return this.compileNativeCallbackCall(context, call, rootEntry.value)!;
    }

    /** Recursive bodies run as real lambdas, so all return statements stay. */
    private recursiveIrFor(
        declaration: SupportedFunction,
        name: string,
        fail: Fail,
    ): UserFunctionIr {
        const body = declaration.body;
        if (!body) {
            fail(declaration, "Recursive function requires a body.");
        }
        const parameters = declaration.parameters.map(
            (parameter): UserFunctionParameterIr => {
                if (!ts.isIdentifier(parameter.name)) {
                    fail(
                        parameter,
                        "Recursive function parameters must be identifiers.",
                    );
                }
                return {
                    declaration: parameter,
                    name: parameter.name,
                    type: this.checker.getTypeAtLocation(parameter),
                };
            },
        );
        return {
            declaration,
            name,
            parameters,
            statements: ts.isBlock(body) ? body.statements : [],
            needsWrapper: false,
            needsValueLambda: false,
            needsLocalNative: false,
            ...(!ts.isBlock(body) ? { returnExpression: body } : {}),
        };
    }

    private emitRecursiveFunctionBody(
        context: UserFunctionContext,
        entry: {
            ir: UserFunctionIr;
            declaration: SupportedFunction;
            returnType: DataType | undefined;
            parameterTypes: readonly (DataType | undefined)[];
            parameterReadOnly: readonly boolean[];
            cppName: string;
            captured: readonly (Value | undefined)[];
        },
    ): void {
        const returnCpp = entry.returnType
            ? context.dataTypes.cppType(entry.returnType)
            : "void";
        context.pushScope(context.allocateUserFunctionPrefix());
        try {
            const parameterDeclarations: string[] = [];
            const parameterBindings: Array<{
                parameter: UserFunctionParameterIr;
                value: Value;
            }> = [];
            let runtimeIndex = 0;
            entry.ir.parameters.forEach((parameter, index) => {
                const type = entry.parameterTypes[index];
                if (!type) {
                    parameterBindings.push({
                        parameter,
                        value: entry.captured[index]!,
                    });
                    return;
                }
                const cppName = `bbl_recursive_arg_${runtimeIndex++}`;
                parameterDeclarations.push(
                    `${this.recursiveParameterCpp(context.dataTypes, type, entry.parameterReadOnly[index]!)} ${cppName}`,
                );
                parameterBindings.push({
                    parameter,
                    value: context.dataValue(cppName, type),
                });
            });
            context.emit(
                `${entry.cppName} = [&](${parameterDeclarations.join(", ")}) -> ${returnCpp} {`,
            );
            context.increaseIndent();
            context.beginNativeFunctionBody(entry.returnType);
            try {
                for (const { parameter, value } of parameterBindings) {
                    context.bindParameterValue(
                        parameter.name,
                        value,
                    );
                }
                const body = entry.declaration.body;
                if (!body) {
                    context.fail(entry.declaration, "Recursive function requires a body.");
                }
                if (ts.isBlock(body)) {
                    for (const statement of body.statements) {
                        context.emitStatement(statement);
                    }
                } else {
                    if (!entry.returnType) {
                        context.fail(body, "A concise recursive function must return data.");
                    }
                    context.emit(
                        `return ${context.compileForDataSink(body, entry.returnType)};`,
                    );
                }
            } finally {
                context.endNativeFunctionBody();
                context.decreaseIndent();
            }
            context.emit("};");
        } finally {
            context.popScope();
        }
    }

    private recursiveParameterCpp(
        dataTypes: DataTypeRegistry,
        type: DataType,
        readOnly: boolean,
    ): string {
        const cpp = dataTypes.cppType(type);
        return passesByReference(dataTypes, type)
            ? `${readOnly ? "const " : ""}${cpp}&`
            : cpp;
    }

    private declarationIdentifier(declaration: SupportedFunction): ts.Identifier {
        if (
            (ts.isFunctionDeclaration(declaration) ||
                ts.isFunctionExpression(declaration)) &&
            declaration.name
        ) {
            return declaration.name;
        }
        if (
            ts.isMethodDeclaration(declaration) &&
            ts.isIdentifier(declaration.name)
        ) {
            return declaration.name;
        }
        const parent = declaration.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
            return parent.name;
        }
        throw new Error("Recursive function must have a stable identifier.");
    }

    private declarationName(declaration: SupportedFunction): string {
        return this.declarationIdentifier(declaration).text;
    }

    /** Invokes a callback over values supplied by a lowering operation. */
    public compileCallbackWithValues(
        context: UserFunctionContext,
        declaration:
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        arguments_: readonly Value[],
        callNode: ts.Node,
    ): Value {
        const ir = ts.isIdentifier(declaration)
            ? this.resolve(
                  declaration,
                  (node, message) => context.fail(node, message),
              )
            : this.irFor(
                  declaration,
                  "callback",
                  (node, message) => context.fail(node, message),
              );
        if (!ir) {
            context.fail(
                declaration,
                "Compile-time callback does not resolve to a local function.",
            );
        }
        if (
            ir.parameters.length > arguments_.length &&
            ir.parameters
                .slice(arguments_.length)
                .some(({ declaration: parameter }) => !parameter.initializer)
        ) {
            context.fail(
                declaration,
                `Callback '${ir.name}' declares more parameters than the operation supplies.`,
            );
        }
        return this.lower(
            context,
            ir,
            arguments_.slice(0, ir.parameters.length),
            callNode,
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
                        : parameter.declaration.questionToken
                          ? { kind: "json-null" as const, cpp: "" }
                        : context.fail(
                              parameter.declaration,
                              `Optional parameter '${parameter.name.text}' requires a default value in reached user functions.`,
                          ));
                context.bindParameterValue(
                    parameter.name,
                    value,
                );
            });
            if (ir.needsValueLambda) {
                const returnType = this.valueLambdaReturnType(
                    context,
                    ir,
                    callNode,
                );
                const result = `bbl_fn_${context.allocateUserFunctionPrefix()}result`;
                context.emit(
                    `const auto ${result} = [&]() -> ${context.dataTypes.cppType(returnType)} {`,
                );
                context.increaseIndent();
                context.beginNativeFunctionBody(returnType);
                try {
                    for (const statement of ir.statements) {
                        context.emitStatement(statement);
                    }
                    context.emit(
                        'throw std::runtime_error("Native value function fell through without returning.");',
                    );
                } finally {
                    context.endNativeFunctionBody();
                    context.decreaseIndent();
                }
                context.emit("}();");
                return context.dataValue(
                    result,
                    returnType,
                );
            }
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
                ? {
                      ...context.compileValue(
                          ir.returnExpression,
                      ),
                      requiresExplicitDiscard: true,
                  }
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
                needsValueLambda: false,
                needsLocalNative: false,
                returnExpression: body,
            };
            this.cache.set(declaration, conciseIr);
            return conciseIr;
        }
        // The final statement may be a value return. An earlier value return
        // needs actual function control flow, so the call lowers through an
        // immediately-invoked native lambda. Earlier bare returns in a void
        // helper retain the lighter breakable-wrapper path.
        const finalStatement = body.statements.at(-1);
        const finalReturn =
            finalStatement &&
            ts.isReturnStatement(finalStatement)
                ? finalStatement
                : undefined;
        const leadingStatements = finalReturn
            ? body.statements.slice(0, -1)
            : body.statements;
        const needsValueLambda =
            this.containsValueReturn(leadingStatements);
        const statements = needsValueLambda
            ? body.statements
            : leadingStatements;
        const earlyReturns = needsValueLambda
            ? "none"
            : this.classifyEarlyReturns(
                  statements,
                  fail,
              );
        const needsWrapper = earlyReturns === "wrapper";
        const needsLocalNative = earlyReturns === "native";
        if (needsWrapper && finalReturn?.expression) {
            fail(
                finalReturn,
                "Inlined functions cannot combine a bare early return with a final return value.",
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
            needsValueLambda,
            needsLocalNative,
            ...(!needsValueLambda && finalReturn?.expression
                ? {
                      returnExpression:
                          finalReturn.expression,
                  }
                : {}),
        };
        this.cache.set(declaration, ir);
        return ir;
    }

    private containsValueReturn(
        statements: readonly ts.Statement[],
    ): boolean {
        let found = false;
        const visit = (node: ts.Node): void => {
            if (found || ts.isFunctionLike(node)) return;
            if (ts.isReturnStatement(node) && node.expression) {
                found = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        for (const statement of statements) visit(statement);
        return found;
    }

    private valueLambdaReturnType(
        context: UserFunctionContext,
        ir: UserFunctionIr,
        callNode: ts.Node,
    ): DataType {
        const signature =
            this.checker.getSignatureFromDeclaration(
                ir.declaration,
            );
        const type = signature
            ? context.dataTypes.fromTsType(
                  this.checker.getReturnTypeOfSignature(signature),
                  ir.declaration,
              )
            : undefined;
        if (!type) {
            context.fail(
                callNode,
                `Function '${ir.name}' uses early value returns but its return type is outside the native data model.`,
            );
        }
        return type;
    }

    /**
     * Validates early returns in an inlined body: bare returns are allowed
     * outside loops and switches (they lower to a breakable wrapper).
     */
    private classifyEarlyReturns(
        statements: readonly ts.Statement[],
        fail: Fail,
    ): "none" | "wrapper" | "native" {
        let found = false;
        let needsNative = false;
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
                        "Internal error: value return was not assigned to a native lambda.",
                    );
                }
                if (insideBreakable) {
                    needsNative = true;
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
        return needsNative
            ? "native"
            : found
              ? "wrapper"
              : "none";
    }

    private validateCall(
        call: ts.CallExpression,
        ir: UserFunctionIr,
        fail: Fail,
        allowExtraArguments = false,
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
            (!allowExtraArguments &&
                call.arguments.length >
                    ir.parameters.length)
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
