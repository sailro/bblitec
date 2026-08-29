import ts from "typescript";
import { cppIdentifier } from "../cpp-literals.js";
import type { DataLowerer } from "./data-lowering.js";
import {
    dataTypesEqual,
    passesByReference,
    type DataType,
    type DataTypeRegistry,
} from "./data-types.js";
import type { Value } from "./types.js";
import {
    parameterIsReadOnly,
    resolveFunctionDeclaration,
    type SupportedFunction,
} from "./user-functions.js";

export interface NativeFunctionContext {
    readonly checker: ts.TypeChecker;
    readonly dataTypes: DataTypeRegistry;
    readonly dataLowerer: DataLowerer;
    sourceFiles(): readonly ts.SourceFile[];
    isEntrySourceFile(file: ts.SourceFile): boolean;
    lookupIdentifierValue(
        identifier: ts.Identifier,
    ): Value | undefined;
    compileValue(expression: ts.Expression): Value;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileCondition(expression: ts.Expression): string;
    emitStatement(statement: ts.Statement): void;
    statementTerminatesAfterLowering(statement: ts.Statement): boolean;
    defineVariable(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateUserFunctionPrefix(): string;
    cppLocalName(sourceName: string): string;
    captureEmittedLines(
        emitBody: () => void,
    ): string[];
    registerNativeFunction(
        prototype: string,
        definitionLines: string[],
    ): void;
    beginNativeFunctionBody(
        returnType: DataType | undefined,
    ): void;
    endNativeFunctionBody(): void;
    reachJsData(): void;
    unwrap(expression: ts.Expression): ts.Expression;
    fail(node: ts.Node, message: string): never;
}

export interface DataFunctionParameter {
    name: ts.Identifier;
    type: DataType;
    byReference: boolean;
    readOnly: boolean;
}

interface NativeFunctionSignature {
    cppName: string;
    parameters: DataFunctionParameter[];
    returnType: DataType | undefined;
    declaration: SupportedFunction;
}

/**
 * Binds one plain-data function signature and captures its lowered body.
 * Namespace functions and local recursive lambdas differ only in the C++
 * declaration wrapped around this shared body protocol.
 */
export function captureDataFunctionBody(
    context: NativeFunctionContext,
    parameters: readonly DataFunctionParameter[],
    returnType: DataType | undefined,
    emitBody: () => void,
): { parameterDeclarations: string[]; lines: string[] } {
    context.pushScope(
        context.allocateUserFunctionPrefix(),
    );
    try {
        const parameterDeclarations = parameters.map(
            (parameter) => {
                const cppName = context.cppLocalName(
                    parameter.name.text,
                );
                const cppType = context.dataTypes.cppType(
                    parameter.type,
                );
                context.defineVariable(parameter.name, {
                    ...context.dataLowerer.leafValue(
                        cppName,
                        parameter.type,
                    ),
                    ...(parameter.readOnly
                        ? { readOnly: true as const }
                        : {}),
                });
                if (
                    parameter.type.kind !== "number" &&
                    parameter.type.kind !== "boolean"
                ) {
                    context.dataLowerer.registerLocal(
                        cppName,
                        "owned",
                    );
                }
                return parameter.byReference
                    ? `${parameter.readOnly ? "const " : ""}${cppType}& ${cppName}`
                    : `${cppType} ${cppName}`;
            },
        );
        context.beginNativeFunctionBody(returnType);
        try {
            return {
                parameterDeclarations,
                lines: context.captureEmittedLines(
                    emitBody,
                ),
            };
        } finally {
            context.endNativeFunctionBody();
        }
    } finally {
        context.popScope();
    }
}

/**
 * Emits reachable plain-data user functions as real C++ functions: every
 * parameter and the return type must map into the data model. Functions are
 * emitted once and called normally, so early returns and repeated calls are
 * native. Handle-touching helpers stay on the inline lowerer.
 */
export class NativeFunctionLowerer {
    private readonly signatures = new Map<
        SupportedFunction,
        NativeFunctionSignature
    >();
    private readonly emitted =
        new Set<SupportedFunction>();
    private readonly active =
        new Set<SupportedFunction>();
    private readonly rejected =
        new Set<SupportedFunction>();
    private readonly usedNames = new Set<string>();

    public constructor(
        private readonly context: NativeFunctionContext,
    ) {}

    /**
     * Compiles a call to a local function through the native data-function
     * path. Returns undefined when the callee does not resolve or its
     * signature is not fully data-typed (the inliner then handles it).
     */
    public tryCompileCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        const declaration = resolveFunctionDeclaration(
            this.context.checker,
            callee,
            (node, message) =>
                this.context.fail(node, message),
        );
        if (!declaration) {
            return undefined;
        }
        const signature = this.resolveSignature(
            declaration,
            callee,
        );
        if (!signature) {
            return undefined;
        }
        if (
            call.arguments.length >
                signature.parameters.length ||
            call.arguments.some(ts.isSpreadElement)
        ) {
            this.context.fail(
                call,
                `Function '${callee.text}' expects at most ${signature.parameters.length} plain arguments.`,
            );
        }
        if (
            signature.parameters.some(
                (parameter, index) => {
                    if (
                        !parameter.byReference ||
                        parameter.readOnly
                    ) {
                        return false;
                    }
                    const argument =
                        call.arguments[index] ??
                        (ts.isParameter(parameter.name.parent)
                            ? parameter.name.parent.initializer
                            : undefined);
                    return argument
                        ? !this.isAddressableArgument(argument)
                        : false;
                },
            )
        ) {
            // A conditional, constructor, or call result cannot bind to
            // the mutable native reference that preserves JavaScript
            // object aliasing. Keep that call on the inline path, where
            // the expression is evaluated into the callee's local binding.
            return undefined;
        }
        this.ensureEmitted(signature);
        const argumentsCpp = signature.parameters.map(
            (parameter, index) => {
                const argument = call.arguments[index];
                if (!argument) {
                    const initializer =
                        parameter.name.parent &&
                        ts.isParameter(
                            parameter.name.parent,
                        )
                            ? parameter.name.parent
                                  .initializer
                            : undefined;
                    if (!initializer) {
                        this.context.fail(
                            call,
                            `Function '${callee.text}' requires argument '${parameter.name.text}'.`,
                        );
                    }
                    return this.compileArgument(
                        initializer,
                        parameter,
                    );
                }
                return this.compileArgument(
                    argument,
                    parameter,
                );
            },
        );
        const cpp = `bblscene::${signature.cppName}(${argumentsCpp.join(", ")})`;
        return this.callValue(cpp, signature.returnType);
    }

    private isAddressableArgument(
        expression: ts.Expression,
    ): boolean {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            const bound =
                this.context.lookupIdentifierValue(unwrapped);
            return !bound || bound.kind === "data";
        }
        return (
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
        );
    }

    private callValue(
        cpp: string,
        returnType: DataType | undefined,
    ): Value {
        if (!returnType) {
            return { kind: "void", cpp };
        }
        return this.context.dataLowerer.leafValue(cpp, returnType);
    }

    private compileArgument(
        expression: ts.Expression,
        parameter: NativeFunctionSignature["parameters"][number],
    ): string {
        const dataType = parameter.type;
        if (!dataType) {
            this.context.fail(
                expression,
                "Native function parameters require data types.",
            );
        }
        if (parameter.byReference) {
            if (parameter.readOnly) {
                const rawPath =
                    this.context.dataLowerer.compileDataPath(
                        expression,
                        "read",
                    );
                const path = rawPath
                    ? this.context.dataLowerer.narrowOptional(
                          rawPath,
                          expression,
                      )
                    : undefined;
                if (
                    path?.dataType &&
                    dataTypesEqual(path.dataType, dataType)
                ) {
                    return path.cpp;
                }
                return this.context.dataLowerer.compileForSink(
                    expression,
                    dataType,
                );
            }
            // JavaScript passes object references; the compiled subset
            // passes native references. Read access suffices here because
            // callee writes intentionally alias the caller's object.
            const rawValue =
                this.context.dataLowerer.compileDataPath(
                    expression,
                    "read",
                ) ?? this.context.compileValue(expression);
            const value =
                rawValue.kind === "data"
                    ? this.context.dataLowerer.narrowOptional(
                          rawValue,
                          expression,
                      )
                    : rawValue;
            if (
                value?.kind !== "data" ||
                !value.dataType ||
                !dataTypesEqual(value.dataType, dataType)
            ) {
                this.context.fail(
                    expression,
                    `By-reference data arguments require a matching addressable local or path; received ${value?.kind ?? "no value"} ${value?.dataType ? JSON.stringify(value.dataType) : "without a data type"}, expected ${JSON.stringify(dataType)}.`,
                );
            }
            return value.cpp;
        }
        return this.context.dataLowerer.compileForSink(
            expression,
            dataType,
        );
    }

    private resolveSignature(
        declaration: SupportedFunction,
        callee: ts.Identifier,
    ): NativeFunctionSignature | undefined {
        const cached = this.signatures.get(declaration);
        if (cached) {
            return cached;
        }
        if (this.rejected.has(declaration)) {
            return undefined;
        }
        const checkerSignature =
            this.context.checker.getSignatureFromDeclaration(
                declaration,
            );
        if (!checkerSignature) {
            return undefined;
        }
        if (this.capturesEnclosingBindings(declaration)) {
            // A closure over another function's locals (typically entry
            // engine handles) cannot become a namespace-scope function;
            // the inline lowerer keeps handling it.
            this.rejected.add(declaration);
            return undefined;
        }
        if (this.containsGenerationTimeFetch(declaration)) {
            // A statically known fetch is executed by the compiler, so its
            // URL is part of the call-site specialization. Hoisting the
            // helper into a native function would turn that URL into an
            // ordinary std::string parameter before the fetch is lowered.
            // Keep these helpers on the inliner so static strings continue
            // through wrapper parameters into the generation-time sink.
            this.rejected.add(declaration);
            return undefined;
        }
        const returnTsType =
            this.context.checker.getReturnTypeOfSignature(
                checkerSignature,
            );
        let returnType: DataType | undefined;
        if (
            (returnTsType.flags & ts.TypeFlags.Void) ===
            0
        ) {
            returnType = this.context.dataTypes.fromTsType(
                returnTsType,
                declaration,
            );
            if (
                returnType?.kind === "struct" &&
                this.returnTypeIsStored(returnTsType)
            ) {
                returnType =
                    this.context.dataTypes.markStoredObjectReferences(
                        returnType,
                    );
            }
            // A helper that hands back a resource handle touches the
            // engine to produce it, so it stays on the inline path
            // where the engine binding is in scope.
            if (
                !returnType ||
                this.context.dataTypes.carriesHandle(returnType)
            ) {
                return undefined;
            }
        }
        const parameters: NativeFunctionSignature["parameters"] =
            [];
        for (const parameter of declaration.parameters) {
            if (!ts.isIdentifier(parameter.name)) {
                return undefined;
            }
            const parameterType =
                this.context.dataTypes.fromTsType(
                    this.context.checker.getTypeAtLocation(
                        parameter,
                    ),
                    parameter,
                );
            if (
                !parameterType ||
                this.context.dataTypes.carriesHandle(parameterType)
            ) {
                return undefined;
            }
            parameters.push({
                name: parameter.name,
                type: parameterType,
                byReference: passesByReference(
                    this.context.dataTypes,
                    parameterType,
                ),
                readOnly: this.parameterIsReadOnly(
                    declaration,
                    parameter.name,
                ),
            });
        }
        if (!ts.isBlock(declaration.body ?? declaration)) {
            return undefined;
        }
        const cppName = this.uniqueName(callee.text);
        const signature: NativeFunctionSignature = {
            cppName,
            parameters,
            returnType,
            declaration,
        };
        this.signatures.set(declaration, signature);
        return signature;
    }

    private containsGenerationTimeFetch(
        declaration: SupportedFunction,
    ): boolean {
        let found = false;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "fetch"
            ) {
                found = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration.body ?? declaration);
        return found;
    }

    /** Whether callers place this returned object behind a JS container. */
    private returnTypeIsStored(returnType: ts.Type): boolean {
        const target = this.context.checker.getNonNullableType(returnType);
        const sameType = (candidate: ts.Type): boolean => {
            const normalized = this.context.checker.getNonNullableType(
                candidate,
            );
            return (
                normalized === target ||
                (normalized.aliasSymbol !== undefined &&
                    normalized.aliasSymbol === target.aliasSymbol) ||
                (normalized.symbol !== undefined &&
                    normalized.symbol === target.symbol)
            );
        };
        let stored = false;
        const visit = (node: ts.Node): void => {
            if (stored) return;
            let storedTypeNode: ts.TypeNode | undefined;
            if (ts.isArrayTypeNode(node)) {
                storedTypeNode = node.elementType;
            } else if (
                ts.isTypeReferenceNode(node) &&
                ts.isIdentifier(node.typeName)
            ) {
                const index = ["Map", "ReadonlyMap", "Record"].includes(
                    node.typeName.text,
                )
                    ? 1
                    : ["Array", "ReadonlyArray", "Set"].includes(
                          node.typeName.text,
                      )
                      ? 0
                      : -1;
                storedTypeNode = index >= 0
                    ? node.typeArguments?.[index]
                    : undefined;
            }
            if (
                storedTypeNode &&
                sameType(
                    this.context.checker.getTypeFromTypeNode(
                        storedTypeNode,
                    ),
                )
            ) {
                stored = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        for (const source of this.context.sourceFiles()) {
            if (!source.isDeclarationFile) visit(source);
            if (stored) break;
        }
        return stored;
    }

    private parameterIsReadOnly(
        declaration: SupportedFunction,
        parameter: ts.Identifier,
    ): boolean {
        return parameterIsReadOnly(
            this.context.checker,
            declaration,
            parameter,
        );
    }

    /**
     * True when the function body references a binding declared inside
     * another function (a captured closure variable). Module-scope
     * constants, functions, imports, and the function's own parameters and
     * locals are fine; captured bindings force the inline path.
     */
    private capturesEnclosingBindings(
        declaration: SupportedFunction,
    ): boolean {
        let captured = false;
        const classify = (
            bindingDeclaration: ts.Node,
        ): "internal" | "module" | "captured" => {
            let node: ts.Node | undefined =
                bindingDeclaration.parent;
            let sawFunction = false;
            while (node) {
                if (node === declaration) {
                    return "internal";
                }
                if (ts.isFunctionLike(node)) {
                    sawFunction = true;
                }
                if (ts.isSourceFile(node)) {
                    return sawFunction
                        ? "captured"
                        : "module";
                }
                node = node.parent;
            }
            return "module";
        };
        const visit = (node: ts.Node): void => {
            if (captured) {
                return;
            }
            if (ts.isIdentifier(node)) {
                const symbol =
                    this.context.checker.getSymbolAtLocation(
                        node,
                    );
                const target =
                    symbol &&
                    (symbol.flags &
                        ts.SymbolFlags.Alias) !==
                        0
                        ? this.context.checker.getAliasedSymbol(
                              symbol,
                          )
                        : symbol;
                const bindingDeclaration =
                    target?.valueDeclaration ??
                    target?.declarations?.[0];
                if (bindingDeclaration) {
                    const shape = classify(
                        bindingDeclaration,
                    );
                    if (shape === "captured") {
                        captured = true;
                        return;
                    }
                    if (shape === "module") {
                        // Entry-file top-level bindings live as locals
                        // of the generated main. Compile-time bindings
                        // (static tuples, records, strings) still fold
                        // on any path; runtime bindings capture.
                        const bound =
                            this.context.lookupIdentifierValue(
                                node,
                            );
                        if (
                            ts.isVariableDeclaration(bindingDeclaration) &&
                            bindingDeclaration.initializer &&
                            ts.isRegularExpressionLiteral(
                                bindingDeclaration.initializer,
                            )
                        ) {
                            captured = true;
                            return;
                        }
                        if (
                            bound &&
                            bound.kind !== "tuple" &&
                            bound.kind !== "record" &&
                            bound.kind !== "string" &&
                            bound.kind !== "browser" &&
                            bound.kind !== "callback"
                        ) {
                            captured = true;
                            return;
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        if (declaration.body) {
            visit(declaration.body);
        }
        return captured;
    }

    private uniqueName(preferred: string): string {
        const sanitized = cppIdentifier(preferred);
        let name = sanitized;
        let suffix = 1;
        while (this.usedNames.has(name)) {
            name = `${sanitized}_${++suffix}`;
        }
        this.usedNames.add(name);
        return name;
    }

    private ensureEmitted(
        signature: NativeFunctionSignature,
    ): void {
        if (this.active.has(signature.declaration)) {
            // Native data functions are declared before any definition is
            // emitted, so a direct or mutual-recursion back-edge can call
            // the signature already being generated. Inlined closures do
            // not have that property and retain their separate rejection.
            return;
        }
        if (this.emitted.has(signature.declaration)) {
            return;
        }
        this.active.add(signature.declaration);
        this.emitted.add(signature.declaration);
        try {
            this.emitDefinition(signature);
        } catch (error) {
            this.emitted.delete(signature.declaration);
            throw error;
        } finally {
            this.active.delete(signature.declaration);
        }
    }

    private emitDefinition(
        signature: NativeFunctionSignature,
    ): void {
        this.context.reachJsData();
        const body = signature.declaration.body;
        if (!body || !ts.isBlock(body)) {
            this.context.fail(
                signature.declaration,
                "Native functions require a block body.",
            );
        }
        const returnCpp = signature.returnType
            ? this.context.dataTypes.cppType(
                  signature.returnType,
              )
            : "void";
        const { parameterDeclarations, lines } =
            captureDataFunctionBody(
                this.context,
                signature.parameters,
                signature.returnType,
                () => {
                    for (const statement of body.statements) {
                        this.context.emitStatement(statement);
                        if (
                            this.context.statementTerminatesAfterLowering(
                                statement,
                            )
                        ) {
                            break;
                        }
                    }
                },
            );
        const parameterList =
            parameterDeclarations.join(", ");
        this.context.registerNativeFunction(
            `${returnCpp} ${signature.cppName}(${parameterList});`,
            [
                `${returnCpp} ${signature.cppName}(${parameterList}) {`,
                ...lines.map((line) => `    ${line}`),
                "}",
            ],
        );
    }

}
