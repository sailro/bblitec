import ts from "typescript";
import { sanitizeCppIdentifier } from "../cpp-literals.js";
import type { DataLowerer } from "./data-lowering.js";
import {
    dataTypesEqual,
    type DataType,
    type DataTypeRegistry,
} from "./data-types.js";
import type { Value } from "./types.js";
import {
    resolveFunctionDeclaration,
    type SupportedFunction,
} from "./user-functions.js";

export interface NativeFunctionContext {
    readonly checker: ts.TypeChecker;
    readonly dataTypes: DataTypeRegistry;
    readonly dataLowerer: DataLowerer;
    isEntrySourceFile(file: ts.SourceFile): boolean;
    lookupIdentifierValue(
        identifier: ts.Identifier,
    ): Value | undefined;
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

interface NativeFunctionSignature {
    cppName: string;
    parameters: {
        name: ts.Identifier;
        type: DataType | undefined;
        byReference: boolean;
        readOnly: boolean;
    }[];
    returnType: DataType | undefined;
    declaration: SupportedFunction;
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
        this.ensureEmitted(signature, callee);
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
        return (
            ts.isIdentifier(unwrapped) ||
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
        if (
            returnType.kind === "number" ||
            returnType.kind === "boolean"
        ) {
            return {
                kind: returnType.kind,
                cpp,
                dataType: returnType,
            };
        }
        return {
            kind: "data",
            cpp,
            dataType: returnType,
        };
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
                const path =
                    this.context.dataLowerer.compileDataPath(
                        expression,
                        "read",
                    );
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
            const value =
                this.context.dataLowerer.compileDataPath(
                    expression,
                    "read",
                );
            if (
                value?.kind !== "data" ||
                !value.dataType
            ) {
                this.context.fail(
                    expression,
                    "By-reference data arguments require addressable locals or paths.",
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
            // A helper that hands back a resource handle touches the
            // engine to produce it, so it stays on the inline path
            // where the engine binding is in scope.
            if (
                !returnType ||
                this.carriesHandle(returnType)
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
                this.carriesHandle(parameterType)
            ) {
                return undefined;
            }
            parameters.push({
                name: parameter.name,
                type: parameterType,
                byReference:
                    parameterType.kind === "struct" ||
                    parameterType.kind === "vector" ||
                    parameterType.kind === "optional" ||
                    parameterType.kind === "f32array" ||
                    parameterType.kind === "u16array" ||
                    parameterType.kind === "u32array",
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

    private parameterIsReadOnly(
        declaration: SupportedFunction,
        parameter: ts.Identifier,
    ): boolean {
        const symbol =
            this.context.checker.getSymbolAtLocation(
                parameter,
            );
        if (!symbol || !declaration.body) return false;
        const namesParameter = (node: ts.Node): boolean =>
            ts.isIdentifier(node) &&
            this.context.checker.getSymbolAtLocation(node) ===
                symbol;
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
            let current = this.context.unwrap(expression);
            while (
                ts.isPropertyAccessExpression(current) ||
                ts.isElementAccessExpression(current)
            ) {
                current = this.context.unwrap(
                    current.expression,
                );
            }
            return namesParameter(current);
        };
        const readOnlyMethods = new Set([
            "at",
            "concat",
            "entries",
            "every",
            "filter",
            "find",
            "findIndex",
            "findLast",
            "findLastIndex",
            "forEach",
            "includes",
            "indexOf",
            "join",
            "keys",
            "lastIndexOf",
            "map",
            "reduce",
            "reduceRight",
            "slice",
            "some",
            "values",
        ]);
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
                [
                    ts.SyntaxKind.PlusPlusToken,
                    ts.SyntaxKind.MinusMinusToken,
                ].includes(node.operator) &&
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
                    !readOnlyMethods.has(
                        node.expression.name.text,
                    )
                ) {
                    readOnly = false;
                    return;
                }
                if (
                    node.arguments.some(containsParameter)
                ) {
                    readOnly = false;
                    return;
                }
            }
            if (
                ts.isVariableDeclaration(node) &&
                node.initializer &&
                containsParameter(node.initializer)
            ) {
                // An alias can be mutated later. Keep the analysis
                // conservative instead of attempting an alias graph here.
                readOnly = false;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration.body);
        return readOnly;
    }

    /**
     * True when the function body references a binding declared inside
     * another function (a captured closure variable). Module-scope
     * constants, functions, imports, and the function's own parameters and
     * locals are fine; captured bindings force the inline path.
     */
    /**
     * True when a type holds a resource handle anywhere inside it.
     *
     * A namespace-scope function has no engine binding in scope, and
     * touching a handle always needs one. Checking only the outermost
     * type would miss a struct or array of meshes, which reads as
     * plain data here but still drives the engine at every use.
     */
    private carriesHandle(
        dataType: DataType,
        seen = new Set<string>(),
    ): boolean {
        switch (dataType.kind) {
            case "handle":
                return true;
            case "optional":
                return this.carriesHandle(
                    dataType.inner,
                    seen,
                );
            case "vector":
            case "span":
            case "enummap":
                return this.carriesHandle(
                    dataType.element,
                    seen,
                );
            case "struct": {
                if (seen.has(dataType.name)) {
                    return false;
                }
                seen.add(dataType.name);
                return this.context.dataTypes
                    .structFieldTypes(dataType.name)
                    .some((field) =>
                        this.carriesHandle(field, seen),
                    );
            }
            default:
                return false;
        }
    }

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
        const sanitized = sanitizeCppIdentifier(preferred);
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
        callee: ts.Identifier,
    ): void {
        if (this.active.has(signature.declaration)) {
            this.context.fail(
                callee,
                `Recursive call to '${callee.text}' is not supported.`,
            );
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
        this.context.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        const parameterDeclarations: string[] = [];
        let lines: string[];
        try {
            for (const parameter of signature.parameters) {
                const cppName = this.context.cppLocalName(
                    parameter.name.text,
                );
                const dataType = parameter.type!;
                const cppType =
                    this.context.dataTypes.cppType(
                        dataType,
                    );
                parameterDeclarations.push(
                    parameter.byReference
                        ? `${parameter.readOnly ? "const " : ""}${cppType}& ${cppName}`
                        : `${cppType} ${cppName}`,
                );
                this.context.defineVariable(
                    parameter.name,
                    this.parameterValue(
                        cppName,
                        dataType,
                    ),
                );
                if (
                    dataType.kind !== "number" &&
                    dataType.kind !== "boolean"
                ) {
                    this.context.dataLowerer.registerLocal(
                        cppName,
                        "owned",
                    );
                }
            }
            this.context.beginNativeFunctionBody(
                signature.returnType,
            );
            try {
                lines = this.context.captureEmittedLines(
                    () => {
                        for (const statement of body.statements) {
                            this.context.emitStatement(
                                statement,
                            );
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
            } finally {
                this.context.endNativeFunctionBody();
            }
        } finally {
            this.context.popScope();
        }
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

    private parameterValue(
        cppName: string,
        dataType: DataType,
    ): Value {
        if (
            dataType.kind === "number" ||
            dataType.kind === "boolean"
        ) {
            return {
                kind: dataType.kind,
                cpp: cppName,
                dataType,
            };
        }
        return {
            kind: "data",
            cpp: cppName,
            dataType,
        };
    }
}
