import ts from "typescript";
import type { Value } from "./types.js";

export interface ClassLoweringContext {
    readonly checker: ts.TypeChecker;
    compileValue(expression: ts.Expression): Value;
    emitStatement(statement: ts.Statement): void;
    bindLocalValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
    bindClassField(
        name: ts.Identifier,
        initializer: ts.Expression,
    ): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    allocateUserFunctionPrefix(): string;
    defineThis(instance: Value | undefined): void;
    activeThis(): Value | undefined;
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
        const declaration = (
            symbol?.declarations ?? []
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
        const instance: Value = {
            kind: "record",
            cpp: "",
            recordProperties: fields,
        };

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
        // Methods lower as inlined statements, so a value-returning
        // method has nowhere to put its result. The reached classes are
        // all command methods; say so rather than failing later on the
        // return statement itself.
        const returnsValue = method.body?.statements.some(
            (statement) =>
                ts.isReturnStatement(statement) &&
                statement.expression !== undefined,
        );
        if (returnsValue) {
            this.context.fail(
                call,
                `Method '${methodName}' returns a value; the reached class subset lowers void methods only.`,
            );
        }
        this.context.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        const previousThis = this.context.activeThis();
        this.context.defineThis(instance);
        try {
            this.bindParameters(method, call.arguments);
            for (const statement of method.body?.statements ??
                []) {
                this.context.emitStatement(statement);
            }
        } finally {
            this.context.defineThis(previousThis);
            this.context.popScope();
        }
        return { kind: "void", cpp: "" };
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
            this.declareLocal(parameter.name, argument);
        });
    }

    /**
     * Binds a parameter or field name to its initializer value. The
     * real identifier is reused so the binding resolves through the
     * checker and diagnostics keep pointing at source.
     */
    private declareLocal(
        name: ts.Identifier,
        initializer: ts.Expression,
    ): void {
        this.context.bindLocalValue(
            name,
            this.context.compileValue(initializer),
        );
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
            if (
                ts.isGetAccessorDeclaration(member) ||
                ts.isSetAccessorDeclaration(member)
            ) {
                this.context.fail(
                    member,
                    "Class accessors are outside the supported subset.",
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
