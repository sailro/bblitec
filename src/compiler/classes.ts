import ts from "typescript";
import type {
    DataType,
    DataTypeRegistry,
} from "./data-types.js";
import type { Value } from "./types.js";

const successfulConstructorResourceKinds = new Set([
    "audio-context",
    "audio-engine",
    "audio-node",
    "audio-buffer",
]);

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
    bindNullableClassField(
        name: ts.Identifier,
    ): Value | undefined;
    bindOptionalResourceValue(
        name: ts.Identifier,
    ): Value | undefined;
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

    /** Resolve `ClassName.staticFactory(...)` to its local method body. */
    public resolveStaticMethod(
        callee: ts.PropertyAccessExpression,
    ): ts.MethodDeclaration | undefined {
        const owner = this.context.unwrap(callee.expression);
        if (!ts.isIdentifier(owner)) return undefined;
        const symbol = this.context.checker.getSymbolAtLocation(owner);
        const target =
            symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
                ? this.context.checker.getAliasedSymbol(symbol)
                : symbol;
        const declaration = (target?.declarations ?? []).find(
            ts.isClassDeclaration,
        );
        if (!declaration) return undefined;
        return declaration.members.find(
            (member): member is ts.MethodDeclaration =>
                ts.isMethodDeclaration(member) &&
                ts.isIdentifier(member.name) &&
                member.name.text === callee.name.text &&
                (ts.getCombinedModifierFlags(member) &
                    ts.ModifierFlags.Static) !==
                    0,
        );
    }

    /**
     * Lower a static factory whose try arm returns a resource-backed class
     * and whose catch arm returns the same class with every constructor
     * resource null. The instance fields are outer optionals: successful
     * creation fills them only after the whole try arm completes, while an
     * exception leaves the silent fallback instance intact.
     */
    public compileNullableResourceFactory(
        call: ts.CallExpression,
        method: ts.MethodDeclaration,
    ): Value | undefined {
        const owner = method.parent;
        if (!ts.isClassDeclaration(owner) || !method.body) return undefined;
        const statements = method.body.statements;
        if (statements.length !== 1 || !ts.isTryStatement(statements[0]!)) {
            return undefined;
        }
        const tryStatement = statements[0]!;
        if (!tryStatement.catchClause || tryStatement.finallyBlock) {
            return undefined;
        }
        const successStatement = tryStatement.tryBlock.statements.at(-1);
        const fallbackStatement =
            tryStatement.catchClause.block.statements.at(-1);
        const returnedNew = (
            statement: ts.Statement | undefined,
        ): ts.NewExpression | undefined => {
            if (
                !statement ||
                !ts.isReturnStatement(statement) ||
                !statement.expression
            ) {
                return undefined;
            }
            const expression = this.context.unwrap(statement.expression);
            return ts.isNewExpression(expression) ? expression : undefined;
        };
        const success = returnedNew(successStatement);
        const fallback = returnedNew(fallbackStatement);
        const namesOwner = (expression: ts.NewExpression | undefined) =>
            expression &&
            ts.isIdentifier(expression.expression) &&
            owner.name &&
            expression.expression.text === owner.name.text;
        if (
            !namesOwner(success) ||
            !namesOwner(fallback) ||
            !(fallback!.arguments ?? []).every(
                (argument) =>
                    this.context.unwrap(argument).kind ===
                    ts.SyntaxKind.NullKeyword,
            )
        ) {
            return undefined;
        }
        const constructorDeclaration = owner.members.find(
            ts.isConstructorDeclaration,
        );
        if (
            !constructorDeclaration ||
            constructorDeclaration.parameters.length !==
                (success!.arguments?.length ?? 0) ||
            constructorDeclaration.parameters.some(
                (parameter) => !ts.isIdentifier(parameter.name),
            )
        ) {
            return undefined;
        }
        const fieldByParameter = new Map<string, string>();
        const constructorFieldWrites = new Set<ts.Statement>();
        for (const statement of constructorDeclaration.body?.statements ?? []) {
            if (!ts.isExpressionStatement(statement)) continue;
            const expression = this.context.unwrap(statement.expression);
            if (
                !ts.isBinaryExpression(expression) ||
                expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
                !ts.isPropertyAccessExpression(expression.left) ||
                expression.left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
                !ts.isIdentifier(expression.right)
            ) {
                continue;
            }
            fieldByParameter.set(
                expression.right.text,
                expression.left.name.text,
            );
            constructorFieldWrites.add(statement);
        }
        if (
            constructorDeclaration.parameters.some(
                (parameter) =>
                    !fieldByParameter.has(
                        (parameter.name as ts.Identifier).text,
                    ),
            )
        ) {
            return undefined;
        }

        this.context.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        try {
            this.bindParameters(method, call.arguments, undefined, true);
            const instance = this.construct(fallback!, owner);
            const fields = instance.recordProperties!;
            const targets = constructorDeclaration.parameters.map(
                (parameter) => {
                    const field = fieldByParameter.get(
                        (parameter.name as ts.Identifier).text,
                    )!;
                    return fields[field] ??
                        this.context.fail(
                            parameter,
                            `Fallback construction did not bind field '${field}' (bound: ${Object.keys(fields).join(", ")}).`,
                        );
                },
            );
            if (targets.some((target) => !target.optionalStorageCpp)) {
                this.context.fail(
                    fallback!,
                    "A nullable-resource fallback factory requires optional storage for every constructor field.",
                );
            }
            const mainBus = this.context.allocateUserFunctionPrefix() +
                "audio_main_bus";
            this.context.emit(
                `bbl::pal::AudioNodeHandle ${mainBus}{};`,
            );
            this.context.emit("try {");
            this.context.increaseIndent();
            this.context.pushScope(
                this.context.allocateUserFunctionPrefix(),
            );
            try {
                for (const statement of tryStatement.tryBlock.statements.slice(
                    0,
                    -1,
                )) {
                    this.context.emitStatement(statement);
                }
                const values = (success!.arguments ?? []).map((argument) =>
                    this.context.compileValue(argument),
                );
                values.forEach((value, index) => {
                    const target = targets[index]!;
                    if (
                        value.kind === "data" &&
                        value.dataType?.kind === "optional" &&
                        value.dataType.inner.kind === "handle" &&
                        value.dataType.inner.handle === target.kind
                    ) {
                        this.context.emit(
                            `${target.optionalStorageCpp} = ${value.cpp};`,
                        );
                        return;
                    }
                    if (value.kind !== target.kind) {
                        this.context.fail(
                            success!.arguments![index]!,
                            `Nullable factory field expects ${target.kind}, received ${value.kind}.`,
                        );
                    }
                    if (value.optionalFoundCpp !== undefined) {
                        this.context.emit(
                            `if (${value.optionalFoundCpp}) {`,
                        );
                        this.context.emit(
                            `    ${target.optionalStorageCpp} = ${value.cpp};`,
                        );
                        this.context.emit("}");
                    } else {
                        this.context.emit(
                            `${target.optionalStorageCpp} = ${value.cpp};`,
                        );
                    }
                    if (value.audioMainBusCpp !== undefined) {
                        this.context.emit(
                            `${mainBus} = ${value.audioMainBusCpp};`,
                        );
                        target.audioMainBusCpp = mainBus;
                    }
                    if (value.engineCpp !== undefined) {
                        target.engineCpp = value.engineCpp;
                    }
                });
                const audioContext = targets.find(
                    (target) =>
                        target.kind === "audio-context" ||
                        target.kind === "audio-engine",
                );
                if (audioContext) {
                    for (const target of targets) {
                        if (
                            target.kind === "audio-node" ||
                            target.kind === "audio-buffer" ||
                            target.kind === "audio-engine"
                        ) {
                            target.audioContextCpp = audioContext.cpp;
                        }
                    }
                }
                // The fallback construction above deliberately runs the
                // constructor with null resources, so guarded setup such as
                // RacerAudio's input-unlock listeners folds away there. The
                // successful instance is wired field-by-field only after the
                // try arm completes; now run the constructor's remaining
                // statements against those live fields. Direct parameter-to-
                // field assignments are the wiring already emitted above and
                // must not run twice.
                this.context.pushScope(
                    this.context.allocateUserFunctionPrefix(),
                );
                const previousThis = this.context.activeThis();
                this.context.defineThis(instance);
                try {
                    constructorDeclaration.parameters.forEach(
                        (parameter, index) => {
                            const value = values[index]!;
                            const target = targets[index]!;
                            const resourceValue =
                                successfulConstructorResourceKinds.has(
                                    value.kind,
                                );
                            this.context.bindParameterValue(
                                parameter.name as ts.Identifier,
                                resourceValue
                                    ? {
                                          ...value,
                                          truthinessCpp:
                                              `${target.optionalStorageCpp}.has_value()`,
                                      }
                                    : value,
                            );
                        },
                    );
                    for (const statement of
                        constructorDeclaration.body?.statements ?? []) {
                        if (!constructorFieldWrites.has(statement)) {
                            this.context.emitStatement(statement);
                        }
                    }
                } finally {
                    this.context.defineThis(previousThis);
                    this.context.popScope();
                }
            } finally {
                this.context.popScope();
                this.context.decreaseIndent();
            }
            this.context.emit("} catch (...) {");
            this.context.emit("    // The prebuilt all-null instance is the source fallback.");
            this.context.emit("}");
            return instance;
        } finally {
            this.context.popScope();
        }
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
                    !member.initializer &&
                    ts.isIdentifier(member.name)
                ) {
                    const nullable =
                        this.context.bindNullableClassField(
                            member.name,
                        );
                    if (nullable) {
                        fields[member.name.text] = nullable;
                    }
                    continue;
                }
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
        const mappedReturnType = returnsVoid
            ? undefined
            : this.context.dataTypes.fromTsType(
                  effectiveReturn,
                  method,
              );
        const returnType =
            mappedReturnType?.kind === "struct"
                ? this.context.dataTypes.markStoredObjectReferences(
                      mappedReturnType,
                  )
                : mappedReturnType;
        if (!returnsVoid && !returnType) {
            const finalStatement = method.body.statements.at(-1);
            if (
                !finalStatement ||
                !ts.isReturnStatement(finalStatement) ||
                !finalStatement.expression
            ) {
                this.context.fail(
                    method,
                    `Method '${methodName}' returns a value outside the native data model and requires a final value return.`,
                );
            }
            const leading = method.body.statements.slice(0, -1);
            let earlierValueReturn: ts.ReturnStatement | undefined;
            const findReturn = (node: ts.Node): void => {
                if (earlierValueReturn || ts.isFunctionLike(node)) return;
                if (ts.isReturnStatement(node) && node.expression) {
                    earlierValueReturn = node;
                    return;
                }
                ts.forEachChild(node, findReturn);
            };
            leading.forEach(findReturn);
            if (earlierValueReturn) {
                const nullableRecord =
                    this.compileGuardedNullableRecordMethod(
                        instance,
                        method,
                        call,
                        finalStatement,
                        leading,
                    );
                if (nullableRecord) return nullableRecord;
                this.context.fail(
                    earlierValueReturn,
                    `Method '${methodName}' cannot select a compile-time record through an early value return.`,
                );
            }
            this.context.pushScope(
                this.context.allocateUserFunctionPrefix(),
            );
            const previousThis = this.context.activeThis();
            this.context.defineThis(instance);
            try {
                this.bindParameters(method, call.arguments);
                for (const statement of leading) {
                    this.context.emitStatement(statement);
                }
                const result = this.context.compileValue(
                    finalStatement.expression,
                );
                return {
                    ...result,
                    requiresExplicitDiscard: true,
                };
            } finally {
                this.context.defineThis(previousThis);
                this.context.popScope();
            }
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
     * Lower a method whose first statement rejects with `return null` and
     * whose successful final return is a compile-time record of resource
     * handles. Each returned property becomes optional native storage, so a
     * caller can retain the source's optional-chain/nullish-coalescing shape
     * without requiring runtime identity for the record wrapper itself.
     */
    private compileGuardedNullableRecordMethod(
        instance: Value,
        method: ts.MethodDeclaration,
        call: ts.CallExpression,
        finalStatement: ts.ReturnStatement,
        leading: readonly ts.Statement[],
    ): Value | undefined {
        const guard = leading[0];
        if (!guard || !ts.isIfStatement(guard) || guard.elseStatement) {
            return undefined;
        }
        const guardedStatements = ts.isBlock(guard.thenStatement)
            ? [...guard.thenStatement.statements]
            : [guard.thenStatement];
        if (
            guardedStatements.length !== 1 ||
            !ts.isReturnStatement(guardedStatements[0]!) ||
            !guardedStatements[0]!.expression ||
            this.context.unwrap(guardedStatements[0]!.expression).kind !==
                ts.SyntaxKind.NullKeyword
        ) {
            return undefined;
        }
        const returned = this.context.unwrap(finalStatement.expression!);
        if (!ts.isObjectLiteralExpression(returned)) return undefined;
        const descriptors: Array<{
            name: string;
            identifier: ts.Identifier;
        }> = [];
        for (const property of returned.properties) {
            if (ts.isShorthandPropertyAssignment(property)) {
                descriptors.push({
                    name: property.name.text,
                    identifier: property.name,
                });
                continue;
            }
            if (
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name) &&
                ts.isIdentifier(this.context.unwrap(property.initializer))
            ) {
                descriptors.push({
                    name: property.name.text,
                    identifier: this.context.unwrap(
                        property.initializer,
                    ) as ts.Identifier,
                });
                continue;
            }
            return undefined;
        }
        if (descriptors.length === 0) return undefined;

        this.context.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        const previousThis = this.context.activeThis();
        this.context.defineThis(instance);
        try {
            this.bindParameters(method, call.arguments);
            const properties: Record<string, Value> = {};
            for (const descriptor of descriptors) {
                const output = this.context.bindOptionalResourceValue(
                    descriptor.identifier,
                );
                if (!output) {
                    this.context.fail(
                        descriptor.identifier,
                        "A guarded record return currently requires nullable resource properties.",
                    );
                }
                properties[descriptor.name] = output;
            }
            const condition = this.context.compileValue(guard.expression);
            if (condition.kind !== "boolean") {
                this.context.fail(
                    guard.expression,
                    "A guarded record return requires a boolean null guard.",
                );
            }
            this.context.emit(`if (!(${condition.cpp})) {`);
            this.context.increaseIndent();
            this.context.pushScope(
                this.context.allocateUserFunctionPrefix(),
            );
            try {
                for (const statement of leading.slice(1)) {
                    this.context.emitStatement(statement);
                }
                const success = this.context.compileValue(returned);
                if (success.kind !== "record") {
                    this.context.fail(
                        returned,
                        "A guarded record success must remain a compile-time record.",
                    );
                }
                for (const descriptor of descriptors) {
                    const value = success.recordProperties?.[
                        descriptor.name
                    ];
                    const output = properties[descriptor.name]!;
                    if (!value || value.kind !== output.kind) {
                        this.context.fail(
                            descriptor.identifier,
                            `Guarded record property '${descriptor.name}' has an incompatible resource kind.`,
                        );
                    }
                    this.context.emit(
                        `${output.optionalStorageCpp} = ${value.cpp};`,
                    );
                    if (value.engineCpp !== undefined) {
                        output.engineCpp = value.engineCpp;
                    }
                    if (value.audioContextCpp !== undefined) {
                        output.audioContextCpp = value.audioContextCpp;
                    }
                    if (value.audioMainBusCpp !== undefined) {
                        output.audioMainBusCpp = value.audioMainBusCpp;
                    }
                }
            } finally {
                this.context.popScope();
                this.context.decreaseIndent();
            }
            this.context.emit("}");
            return {
                kind: "record",
                cpp: "",
                recordProperties: properties,
                requiresExplicitDiscard: true,
            };
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
        preserveStaticRecords = false,
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
            const staticRecord = preserveStaticRecords
                ? this.context.compileValue(argument)
                : undefined;
            if (staticRecord?.kind === "record") {
                this.context.bindParameterValue(
                    parameter.name,
                    staticRecord,
                );
            } else {
                this.context.bindClassParameterValue(
                    parameter.name,
                    argument,
                );
            }
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
                !ts.isMethodDeclaration(member) &&
                (ts.getCombinedModifierFlags(
                    member as ts.Declaration,
                ) & ts.ModifierFlags.Static) !== 0
            ) {
                this.context.fail(
                    member,
                    "Static class fields and accessors are outside the supported subset.",
                );
            }
        }
    }
}
