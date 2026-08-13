import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type {
    DataType,
    DataTypeRegistry,
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
        this.ensureEmitted(signature, callee);
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
            if (!returnType) {
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
            if (!parameterType) {
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
                    parameterType.kind === "u32array",
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
        const sanitized = preferred.replace(
            /[^A-Za-z0-9_]/g,
            "_",
        );
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
                        ? `${cppType}& ${cppName}`
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
