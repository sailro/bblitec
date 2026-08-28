import ts from "typescript";
import type {
    DataType,
    DataTypeRegistry,
} from "./data-types.js";
import type { Value } from "./types.js";

export interface ClassLoweringContext {
    readonly checker: ts.TypeChecker;
    readonly dataTypes: DataTypeRegistry;
    compileValue(expression: ts.Expression): Value;
    emitStatement(statement: ts.Statement): void;
    bindParameterValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    bindClassParameterValue(
        identifier: ts.Identifier,
        argument: ts.Expression,
    ): void;
    bindClassField(
        name: ts.Identifier,
        initializer: ts.Expression,
    ): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateUserFunctionPrefix(): string;
    emit(line: string): void;
    increaseIndent(): void;
    decreaseIndent(): void;
    beginNativeFunctionBody(
        returnType: DataType | undefined,
    ): void;
    endNativeFunctionBody(): void;
    dataValue(cpp: string, dataType: DataType): Value;
    defineThis(instance: Value | undefined): void;
    activeThis(): Value | undefined;
    registerClassInstance(
        instance: Value,
        declaration: ts.ClassDeclaration,
    ): void;
    unwrap(expression: ts.Expression): ts.Expression;
    fail(node: ts.Node, message: string): never;
}

/**
 * Lowers the reached class subset: a class is a compile-time record of
 * per-field bindings rather than a runtime object.
 *
 * Each field becomes its own binding — data fields (numbers, arrays,
 * structs, handles) are ordinary locals the enclosing scope owns, and
 * resource fields (the engine, the scene, a material) bind the value
 * they were constructed with. Methods inline at their call sites with
 * `this` bound to that record, exactly like the function-literal
 * arguments the inline path already lowers, so a field write inside a
 * method reaches the same local a field read outside it does.
 *
 * The subset deliberately stops short of runtime object identity: an
 * instance cannot be stored in plain data, put in an array, or selected
 * between at runtime. Reaching for any of those is a compile error
 * rather than a silently different program.
 */
export class ClassLowerer {
    public constructor(
        private readonly context: ClassLoweringContext,
    ) {}

    /**
     * Resolves the class declaration a `new` expression constructs, or
     * undefined when the callee is not a local class.
     */
    public resolveClass(
        expression: ts.NewExpression,
    ): ts.ClassDeclaration | undefined {
        const callee = this.context.unwrap(
            expression.expression,
        );
        if (!ts.isIdentifier(callee)) {
            return undefined;
        }
        const symbol =
            this.context.checker.getSymbolAtLocation(callee);
        const target =
            symbol &&
            (symbol.flags & ts.SymbolFlags.Alias) !== 0
                ? this.context.checker.getAliasedSymbol(
                      symbol,
                  )
                : symbol;
        const declaration = (
            target?.declarations ?? []
        ).find(ts.isClassDeclaration);
        return declaration;
    }

    /**
     * Constructs an instance: declares each field's binding, then runs
     * the constructor body with `this` bound to the record under
     * construction.
     */
    public construct(
        expression: ts.NewExpression,
        declaration: ts.ClassDeclaration,
    ): Value {
        this.rejectUnsupportedMembers(declaration);
        const fields: Record<string, Value> = {};
        const getters: Record<
            string,
            ts.GetAccessorDeclaration
        > = {};
        for (const member of declaration.members) {
            if (
                ts.isGetAccessorDeclaration(member) &&
                ts.isIdentifier(member.name)
            ) {
                getters[member.name.text] = member;
            }
        }
        const instance: Value = {
            kind: "record",
            cpp: "",
            recordProperties: fields,
            recordGetters: getters,
        };
        // Constructor bodies may call another method on `this`. Make the
        // declaration discoverable as soon as the instance record exists,
        // rather than only after construction has already returned.
        this.context.registerClassInstance(
            instance,
            declaration,
        );

        this.context.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        const previousThis = this.context.activeThis();
        this.context.defineThis(instance);
        try {
            // Field declarations with initializers bind first, so the
            // constructor body can already read them.
            for (const member of declaration.members) {
                if (
                    ts.isPropertyDeclaration(member) &&
                    member.initializer &&
                    ts.isIdentifier(member.name)
                ) {
                    // Declaring a local gives array and numeric fields
                    // real storage; the record then names that local.
                    this.context.bindClassField(
                        member.name,
                        member.initializer,
                    );
                    fields[member.name.text] =
                        this.context.compileValue(
                            member.name,
                        );
                }
            }
            const constructorDeclaration =
                declaration.members.find(
                    ts.isConstructorDeclaration,
                );
            if (constructorDeclaration) {
                this.bindParameters(
                    constructorDeclaration,
                    expression.arguments ?? [],
                    fields,
                );
                for (const statement of constructorDeclaration
                    .body?.statements ?? []) {
                    this.context.emitStatement(statement);
                }
            }
        } finally {
            this.context.defineThis(previousThis);
            this.context.popScope();
        }
        return instance;
    }

    /**
     * Inlines a method call on a constructed instance, binding `this`
     * to the instance record for the duration of the body.
     */
    public compileMethodCall(
        instance: Value,
        methodName: string,
        call: ts.CallExpression,
        declaration: ts.ClassDeclaration,
    ): Value {
        const method = declaration.members.find(
            (member): member is ts.MethodDeclaration =>
                ts.isMethodDeclaration(member) &&
                ts.isIdentifier(member.name) &&
                member.name.text === methodName,
        );
        if (!method) {
            this.context.fail(
                call,
                `Class '${declaration.name?.text ?? "?"}' has no reached method '${methodName}'.`,
            );
        }
        if (!method.body) {
            this.context.fail(
                method,
                `Reached method '${methodName}' requires a body.`,
            );
        }
        const signature =
            this.context.checker.getSignatureFromDeclaration(
                method,
            );
        const checkerReturn = signature
            ? this.context.checker.getReturnTypeOfSignature(
                  signature,
              )
            : undefined;
        const effectiveReturn =
            checkerReturn &&
            method.modifiers?.some(
                (modifier) =>
                    modifier.kind === ts.SyntaxKind.AsyncKeyword,
            )
                ? (this.context.checker.getAwaitedType(
                      checkerReturn,
                  ) ?? checkerReturn)
                : checkerReturn;
        const returnsVoid =
            !effectiveReturn ||
            (effectiveReturn.flags & ts.TypeFlags.Void) !== 0;
        const returnType = returnsVoid
            ? undefined
            : this.context.dataTypes.fromTsType(
                  effectiveReturn,
                  method,
              );
        if (!returnsVoid && !returnType) {
            this.context.fail(
                method,
                `Method '${methodName}' returns a value outside the native data model.`,
            );
        }
        this.context.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        const previousThis = this.context.activeThis();
        this.context.defineThis(instance);
        try {
            this.bindParameters(method, call.arguments);
            const result = returnsVoid
                ? undefined
                : `bbl_class_${this.context.allocateUserFunctionPrefix()}result`;
            this.context.emit(
                returnsVoid
                    ? "[&]() -> void {"
                    : `const auto ${result} = [&]() -> ${this.context.dataTypes.cppType(returnType!)} {`,
            );
            this.context.increaseIndent();
            this.context.beginNativeFunctionBody(
                returnType,
            );
            try {
                for (const statement of method.body.statements) {
                    this.context.emitStatement(statement);
                }
            } finally {
                this.context.endNativeFunctionBody();
                this.context.decreaseIndent();
            }
            this.context.emit("}();");
            return result
                ? {
                      ...this.context.dataValue(
                          result,
                          returnType!,
                      ),
                      requiresExplicitDiscard: true,
                  }
                : { kind: "void", cpp: "" };
        } finally {
            this.context.defineThis(previousThis);
            this.context.popScope();
        }
    }

    /**
     * Binds a method or constructor parameter list to its arguments by
     * declaring locals, so the inlined body reads them by name.
     */
    private bindParameters(
        declaration:
            | ts.ConstructorDeclaration
            | ts.MethodDeclaration,
        argumentList: readonly ts.Expression[],
        parameterProperties?: Record<string, Value>,
    ): void {
        declaration.parameters.forEach((parameter, index) => {
            if (!ts.isIdentifier(parameter.name)) {
                this.context.fail(
                    parameter,
                    "Class parameters must be plain identifiers.",
                );
            }
            const argument =
                argumentList[index] ??
                parameter.initializer;
            if (!argument) {
                this.context.fail(
                    parameter,
                    `Parameter '${parameter.name.text}' requires an argument or a default.`,
                );
            }
            // The declared parameter type is the sink. A compile-time
            // object record passed to a struct parameter must materialize
            // as that struct before constructor field wiring observes it.
            this.context.bindClassParameterValue(
                parameter.name,
                argument,
            );
            if (
                parameterProperties &&
                ts.isParameterPropertyDeclaration(
                    parameter,
                    declaration,
                )
            ) {
                // TypeScript initializes a parameter-property before the
                // constructor body. Expose that implicit field on the same
                // compile-time instance record as an explicit declaration.
                parameterProperties[parameter.name.text] =
                    this.context.compileValue(
                        parameter.name,
                    );
            }
        });
    }

    private rejectUnsupportedMembers(
        declaration: ts.ClassDeclaration,
    ): void {
        if (declaration.heritageClauses?.length) {
            this.context.fail(
                declaration,
                "Class inheritance is outside the supported subset.",
            );
        }
        for (const member of declaration.members) {
            if (ts.isSetAccessorDeclaration(member)) {
                this.context.fail(
                    member,
                    "Class setters are outside the supported subset.",
                );
            }
            if (
                ts.getCombinedModifierFlags(
                    member as ts.Declaration,
                ) & ts.ModifierFlags.Static
            ) {
                this.context.fail(
                    member,
                    "Static class members are outside the supported subset.",
                );
            }
        }
    }
}
