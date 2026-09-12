import { valueForKind } from "./types.js";
import { EmissionSet, EmissionMap, EmissionWeakMap } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import type {
    DataStructField,
    DataType,
} from "./data-types.js";
import { passesByReference } from "./data-types.js";
import type { Value } from "./types.js";
import { sameCompiledValue } from "./types.js";
import { parameterIsReadOnly } from "./user-functions.js";
import { firstReturn } from "./loop-control.js";
import { FunctionSpecializations, functionDependencies } from "./function-specializations.js";
import { classInstanceProperties } from "./class-properties.js";

const successfulConstructorResourceKinds = new EmissionSet([
    "audio-context",
    "audio-engine",
    "audio-node",
    "audio-buffer",
]);

/** One property a shared class instance stores inside its `Ref`. */
interface StoredClassField extends DataStructField {
    /** The property name in the source. */
    source: string;
}

/** A class body's own instance property declarations, named plainly. */
type InstanceProperty = (ts.PropertyDeclaration | ts.ParameterDeclaration) & { name: ts.Identifier };

/** The instance property declarations a class body writes, in order. */
function instanceProperties(
    declaration: ts.ClassDeclaration,
): InstanceProperty[] {
    return classInstanceProperties(declaration).filter(
        (member): member is InstanceProperty =>
            ts.isIdentifier(member.name),
    );
}

/** A class body's accessors, by property name. */
function accessorsOf(declaration: ts.ClassDeclaration): {
    getters: Record<string, ts.GetAccessorDeclaration>;
    setters: Record<string, ts.SetAccessorDeclaration>;
} {
    const getters: Record<string, ts.GetAccessorDeclaration> = {};
    const setters: Record<string, ts.SetAccessorDeclaration> = {};
    for (const member of declaration.members) {
        if (
            ts.isGetAccessorDeclaration(member) &&
            ts.isIdentifier(member.name)
        ) {
            getters[member.name.text] = member;
        }
        if (
            ts.isSetAccessorDeclaration(member) &&
            ts.isIdentifier(member.name)
        ) {
            setters[member.name.text] = member;
        }
    }
    return { getters, setters };
}

interface ClassLoweringContext
    extends Pick<LoweringServices,
        | "checker"
        | "dataTypes"
        | "nativeFunctions"
        | "functionEmissionScope"
        | "canShareFunctionBody"
        | "compileSharedMethod"
        | "registerNativeBinding"
        | "lookupIdentifierValue"
        | "compileValue"
        | "emitStatement"
        | "bindParameterValue"
        | "bindClassParameterValue"
        | "compileClassParameterValue"
        | "bindClassField"
        | "bindNullableClassField"
        | "bindUninitializedClassDataField"
        | "bindOptionalResourceValue"
        | "pushScope"
        | "popScope"
        | "allocateUserFunctionPrefix"
        | "allocateTemporaryCppName"
        | "reachJsData"
        | "emit"
        | "increaseIndent"
        | "decreaseIndent"
        | "beginNativeFunctionBody"
        | "endNativeFunctionBody"
        | "dataValue"
        | "compileForDataSink"
        | "assignOptionalResourceValue"
        | "defineThis"
        | "activeThis"
        | "registerClassInstance"
        | "unwrap"
        | "fail"
    > {}

/**
 * Lowers the reached class subset: a class is a compile-time record of
 * per-field bindings rather than a runtime object.
 *
 * Each field becomes its own binding — data fields (numbers, arrays,
 * structs, handles) are ordinary locals the enclosing scope owns, and
 * resource fields (the engine, the scene, a material) bind the value
 * they were constructed with. A method whose reached fields,
 * parameters, and return all map into the plain-data model emits once
 * as a namespace function taking each field as a mutable reference
 * channel (`NativeFunctionLowerer.tryCompileMethodCall`); every other
 * method inlines at its call sites with `this` bound to that record,
 * exactly like the function-literal arguments the inline path already
 * lowers, so a field write inside a method reaches the same local a
 * field read outside it does.
 *
 * The subset deliberately stops short of runtime object identity: an
 * instance cannot be stored in plain data, put in an array, or selected
 * between at runtime. Reaching for any of those is a compile error
 * rather than a silently different program.
 */
export class ClassLowerer {
    private readonly emittedRecursiveMethods = new FunctionSpecializations<string>();
    private readonly recursiveMethods = new EmissionMap<
        ts.MethodDeclaration,
        boolean
    >();
    /**
     * Per shared class, the fields its layout hoisted and the value each
     * one was proven to hold at every construction.
     */
    private readonly hoistedClassFields = new EmissionMap<
        string,
        Map<string, Value>
    >();
    private readonly activeRecursiveMethods = new EmissionMap<
        ts.MethodDeclaration,
        {
            instance: Value;
            cppName: string;
            parameters: readonly {
                declaration: ts.ParameterDeclaration;
                type: DataType;
            }[];
            returnType: DataType | undefined;
        }
    >();

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

    /** Resolve a generation-time `static readonly` scalar field. */
    public resolveStaticField(
        access: ts.PropertyAccessExpression,
    ): ts.PropertyDeclaration | undefined {
        const owner = this.context.unwrap(access.expression);
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
            (member): member is ts.PropertyDeclaration =>
                ts.isPropertyDeclaration(member) &&
                ts.isIdentifier(member.name) &&
                member.name.text === access.name.text &&
                member.initializer !== undefined &&
                (ts.getCombinedModifierFlags(member) &
                    (ts.ModifierFlags.Static |
                        ts.ModifierFlags.Readonly)) ===
                    (ts.ModifierFlags.Static |
                        ts.ModifierFlags.Readonly),
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
        const fieldByParameter = new EmissionMap<string, string>();
        const parameterNames = constructorDeclaration.parameters.map(parameter => parameter.name);
        if (!parameterNames.every(ts.isIdentifier)) return undefined;
        const constructorFieldWrites = new EmissionSet<ts.Statement>();
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
            parameterNames.some(
                (name) =>
                    !fieldByParameter.has(
                        name.text,
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
            const targets = parameterNames.map(
                (parameter) => {
                    const field = fieldByParameter.get(
                        parameter.text,
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
                    this.context.assignOptionalResourceValue(
                        target,
                        value,
                        success!.arguments![index]!,
                    );
                    if (value.engineCpp !== undefined) {
                        target.engineCpp = value.engineCpp;
                    }
                });
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
                    parameterNames.forEach(
                        (parameter, index) => {
                            const value = values[index]!;
                            const target = targets[index]!;
                            const resourceValue =
                                successfulConstructorResourceKinds.has(
                                    value.kind,
                                );
                            this.context.bindParameterValue(
                                parameter,
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
        const constructorDeclaration =
            declaration.members.find(
                ts.isConstructorDeclaration,
            );
        if (!constructorDeclaration && (expression.arguments?.length ?? 0) > 0) {
            this.context.fail(
                expression,
                `Class '${declaration.name?.text ?? "?"}' has no constructor accepting arguments.`,
            );
        }
        // JavaScript evaluates every explicit constructor argument in the
        // caller before the new instance becomes `this` and before instance
        // field initializers run. Preserve that ordering for arguments such
        // as `new Child(this)` inside another constructor.
        const evaluatedArguments = constructorDeclaration
            ? this.compileClassArguments(
                  constructorDeclaration,
                  expression.arguments ?? [],
                  "constructor",
              )
            : [];
        const fields: Record<string, Value> = {};
        const { getters, setters } = accessorsOf(declaration);
        const instanceType =
            this.context.checker.getTypeAtLocation(expression);
        const instanceTypeArguments =
            this.context.dataTypes.typeArgumentsOf(
                declaration,
                instanceType,
            );
        const instance: Value = {
            kind: "record",
            cpp: "",
            recordProperties: fields,
            recordGetters: getters,
            recordSetters: setters,
            ...(instanceTypeArguments
                ? { classTypeArguments: instanceTypeArguments }
                : {}),
        };
        // A class something already demanded in a native data position is
        // one shared object rather than a bag of locals: it allocates its
        // `Ref<XData>` here, and every field the layout keeps names a slot
        // inside it instead of a local of its own.
        const structName =
            this.context.dataTypes.existingClassStruct(instanceType);
        if (structName) {
            const layout = this.runtimeLayout(declaration, structName);
            const cpp = this.context.allocateTemporaryCppName(
                `${structName.toLowerCase()}_instance`,
            );
            this.context.reachJsData();
            const structType: DataType = { kind: "struct", name: structName };
            const cppType = this.context.dataTypes.cppType(structType);
            this.context.emit(
                `${cppType} ${cpp} = ` +
                    `bbl::js::make_ref<bblscene::${structName}Data>();`,
            );
            instance.cpp = cpp;
            instance.dataType = structType;
            for (const field of layout) {
                fields[field.source] = this.storedFieldValue(
                    cpp,
                    field,
                );
            }
            // What the layout left out has to come from somewhere every
            // instance shares. The one shape that can: a constructor
            // parameter, bound here to the value the CALLER evaluated
            // rather than to a local of this construction, so the proof
            // below compares what the sites passed.
            if (constructorDeclaration) {
                for (const [name, hoist] of this.hoistedParameterFields(
                    declaration,
                    constructorDeclaration,
                    layout,
                )) {
                    const argument = evaluatedArguments[hoist.index];
                    if (argument) {
                        // The body's own `this.x = p` has nothing left to
                        // do; marking the binding with that exact assignment
                        // is what tells the assignment path so, instead of
                        // it re-deriving the same fact by comparing values.
                        fields[name] = {
                            ...argument,
                            classHoistedAssignment: hoist.assignment,
                        };
                    }
                }
            }
        }
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
            for (const member of instanceProperties(declaration)) {
                if (ts.isParameter(member)) continue;
                const stored = fields[member.name.text];
                // A slot the layout already allocated inside the shared
                // object is storage; its declaration initializer is a
                // store into that slot rather than a second binding.
                if (stored?.classStoredField) {
                    if (member.initializer) {
                        this.context.emit(
                            `${stored.cpp} = ` +
                                `${this.context.compileForDataSink(
                                    member.initializer,
                                    stored.dataType!,
                                )};`,
                        );
                    }
                    continue;
                }
                if (!member.initializer) {
                    const nullable =
                        this.context.bindNullableClassField(
                            member.name,
                        );
                    if (nullable) {
                        fields[member.name.text] = nullable;
                    } else {
                        const data =
                            this.context.bindUninitializedClassDataField(
                                member.name,
                                this.context.dataTypes.classFieldDataType(
                                    instanceType,
                                    member.name,
                                ),
                            );
                        if (data) {
                            fields[member.name.text] = data;
                            continue;
                        }
                        const declared =
                            this.context.checker.getTypeAtLocation(
                                member.name,
                            );
                        const members =
                            (declared.flags & ts.TypeFlags.Union) !== 0
                                ? (declared as ts.UnionType).types
                                : [declared];
                        if (
                            members.some(
                                (candidate) =>
                                    candidate.getCallSignatures().length > 0,
                            )
                        ) {
                            // An optional callback is compile-time wiring. Keep
                            // its initial absence on the instance record so a
                            // later property assignment can install the reached
                            // function and an optional call can dispatch it.
                            fields[member.name.text] = {
                                kind: "json-null",
                                cpp: "",
                            };
                        }
                    }
                    continue;
                }
                // Declaring a local gives array and numeric fields
                // real storage; the record then names that local.
                this.context.bindClassField(
                    member.name,
                    member.initializer,
                    this.context.dataTypes.classFieldDataType(
                        instanceType,
                        member.name,
                    ),
                );
                const bound = this.context.compileValue(member.name);
                if (
                    bound.kind === "callback" &&
                    !bound.callbackRecordOwner?.recordProperties
                ) {
                    // A handler written in the class body closes over the
                    // instance as well as over the enclosing scope. Keeping
                    // both is what lets a later `on(this._handler)`
                    // materialize the body with the same `this` -- and the
                    // same captured locals -- the declaration had.
                    bound.callbackRecordOwner = {
                        ...instance,
                        ...(bound.callbackRecordOwner?.recordScopes
                            ? {
                                  recordScopes:
                                      bound.callbackRecordOwner.recordScopes,
                                  recordTypeArguments:
                                      bound.callbackRecordOwner.recordTypeArguments,
                              }
                            : {}),
                    };
                }
                fields[member.name.text] = bound;
            }
            if (constructorDeclaration) {
                this.bindParameters(
                    constructorDeclaration,
                    expression.arguments ?? [],
                    fields,
                    false,
                    evaluatedArguments,
                );
                for (const statement of constructorDeclaration
                    .body?.statements ?? []) {
                    this.context.emitStatement(statement);
                }
            }
            if (structName) {
                this.proveHoistedFields(
                    structName,
                    declaration,
                    fields,
                    expression,
                );
            }
        } finally {
            this.context.defineThis(previousThis);
            this.context.popScope();
        }
        return instance;
    }

    /**
     * Which of a class's properties the shared object stores, paired with
     * the source names they came from.
     *
     * The layout itself belongs to the registry, which settles it when the
     * struct is minted; this only pairs each slot back with the property
     * name the class wrote, so field bindings are keyed by that name.
     */
    private runtimeLayout(
        declaration: ts.ClassDeclaration,
        structName: string,
    ): readonly StoredClassField[] {
        const layout: StoredClassField[] = [];
        for (const member of instanceProperties(declaration)) {
            const source = member.name.text;
            const field = this.context.dataTypes.classStructField(
                structName,
                source,
            );
            if (field) {
                layout.push({ ...field, source });
            }
        }
        return layout;
    }

    /**
     * Fields the layout does not store and the constructor assigns straight
     * from one of its own parameters, paired with that parameter's index
     * and with the exact assignment that proves it.
     *
     * This is the whole grammar a hoist is allowed to take: `this.x = p`
     * with `p` a parameter, at the top of the constructor body. A field
     * computed from something else has no value the sites could be compared
     * on, so it is left out here and the proof refuses it by name.
     *
     * The assignment travels with the pair because it is the only write the
     * binding covers. A conditional one further down the constructor, or a
     * retarget in a method, is a different node and stays a rebind.
     */
    private hoistedParameterFields(
        declaration: ts.ClassDeclaration,
        constructorDeclaration: ts.ConstructorDeclaration,
        layout: readonly StoredClassField[],
    ): ReadonlyMap<
        string,
        { index: number; assignment: ts.BinaryExpression }
    > {
        const hoisted = new EmissionMap<
            string,
            { index: number; assignment: ts.BinaryExpression }
        >();
        const parameterIndex = new EmissionMap<string, number>();
        constructorDeclaration.parameters.forEach((parameter, index) => {
            if (ts.isIdentifier(parameter.name)) {
                parameterIndex.set(parameter.name.text, index);
            }
        });
        const stored = new EmissionSet(layout.map((field) => field.source));
        const declared = new EmissionSet(
            instanceProperties(declaration).map(
                (member) => member.name.text,
            ),
        );
        for (const statement of constructorDeclaration.body?.statements ?? []) {
            if (
                !ts.isExpressionStatement(statement) ||
                !ts.isBinaryExpression(statement.expression) ||
                statement.expression.operatorToken.kind !==
                    ts.SyntaxKind.EqualsToken
            ) {
                continue;
            }
            const { left, right } = statement.expression;
            if (
                !ts.isPropertyAccessExpression(left) ||
                left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
                !ts.isIdentifier(left.name) ||
                !ts.isIdentifier(right) ||
                stored.has(left.name.text) ||
                !declared.has(left.name.text)
            ) {
                continue;
            }
            const index = parameterIndex.get(right.text);
            if (index !== undefined) {
                hoisted.set(left.name.text, {
                    index,
                    assignment: statement.expression,
                });
            }
        }
        return hoisted;
    }

    /** The lvalue one stored field of a shared instance names. */
    private storedFieldValue(
        instanceCpp: string,
        field: DataStructField,
    ): Value {
        const value = this.context.dataValue(
            `${instanceCpp}->${field.name}`,
            field.type,
        );
        value.nativeLvalue = true;
        value.borrowedData = true;
        value.classStoredField = true;
        value.nativeCaptures = [this.context.registerNativeBinding(instanceCpp, false, true)];
        return value;
    }

    /**
     * Checks that every field the layout hoisted holds the same value at
     * this construction as at the first one.
     *
     * This is what makes a hoisted field sound at all: a method inlined on a
     * receiver read out of a container cannot know which instance it has, so
     * a field that is not stored must be the same for all of them. The proof
     * is over every reached construction rather than the first -- a second
     * site with a different renderer fails generation instead of silently
     * inheriting the first one's.
     */
    private proveHoistedFields(
        structName: string,
        declaration: ts.ClassDeclaration,
        fields: Record<string, Value>,
        node: ts.Node,
    ): void {
        const hoisted = new EmissionMap<string, Value>();
        for (const [name, value] of Object.entries(fields)) {
            if (value.classStoredField) continue;
            hoisted.set(name, value);
        }
        const known = this.hoistedClassFields.get(structName);
        if (!known) {
            this.hoistedClassFields.set(structName, hoisted);
            return;
        }
        for (const [name, value] of hoisted) {
            const first = known.get(name);
            if (!first || !sameCompiledValue(first, value)) {
                this.context.fail(
                    node,
                    `Field '${name}' of shared class ` +
                        `'${declaration.name?.text ?? structName}' is not the ` +
                        "same at every construction, so a method inlined on a " +
                        `stored instance could not name it ` +
                        `(${first?.kind ?? "unbound"} ${first?.cpp ?? ""} then ` +
                        `${value.kind} ${value.cpp}).`,
                );
            }
        }
        for (const name of known.keys()) {
            if (!hoisted.has(name)) {
                this.context.fail(
                    node,
                    `Field '${name}' of shared class ` +
                        `'${declaration.name?.text ?? structName}' is bound at ` +
                        "one construction and not at another.",
                );
            }
        }
    }

    /**
     * Turns a stored instance back into the record the class subset
     * inlines against: its fields are the slots of the `Ref` this value
     * names, plus the fields the layout proved uniform.
     *
     * The receiver is bound to a local first when repeating its expression
     * would repeat work or read a loop variable that has since moved on;
     * a plain name is already stable and is used as it stands.
     */
    public hydrate(value: Value): Value | undefined {
        if (
            value.kind !== "data" ||
            value.dataType?.kind !== "struct" ||
            !this.context.dataTypes.isClassStruct(value.dataType.name)
        ) {
            return undefined;
        }
        const structName = value.dataType.name;
        const binding = this.context.dataTypes.classStruct(structName);
        if (!binding) return undefined;
        // Every field read repeats the receiver's spelling. A plain name
        // repeats for free; anything else -- a call, an indexed read, a
        // member of another record -- is bound once so the instance the
        // method runs on is the one the call named.
        let instanceCpp = value.cpp;
        if (!cppIdentifierPattern.test(instanceCpp)) {
            const bound = this.context.allocateTemporaryCppName(
                `${structName.toLowerCase()}_receiver`,
            );
            this.context.emit(
                `${this.context.dataTypes.cppType(value.dataType)} ` +
                    `${bound} = ${instanceCpp};`,
            );
            instanceCpp = bound;
        }
        const fields: Record<string, Value> = {};
        const hoisted = this.hoistedClassFields.get(structName);
        for (const member of instanceProperties(binding.declaration)) {
            const source = member.name.text;
            const stored = this.context.dataTypes.classStructField(
                structName,
                source,
            );
            const bound = stored
                ? this.storedFieldValue(instanceCpp, stored)
                : hoisted?.get(source);
            if (bound) {
                fields[source] = bound;
            }
        }
        const { getters, setters } = accessorsOf(binding.declaration);
        const typeArguments = this.context.dataTypes.typeArgumentsOf(
            binding.declaration,
            binding.type,
        );
        return valueForKind("record", {
            ...value,
            cpp: instanceCpp,

            recordProperties: fields,
            recordGetters: getters,
            recordSetters: setters,
            classDeclaration: binding.declaration,
            ...(typeArguments ? { classTypeArguments: typeArguments } : {}),
        });
    }

    /** Evaluate explicit class-call arguments while the caller owns `this`. */
    private compileClassArguments(
        declaration:
            | ts.ConstructorDeclaration
            | ts.MethodDeclaration
            | ts.SetAccessorDeclaration,
        argumentList: readonly ts.Expression[],
        callable: "constructor" | "method" | "setter",
    ): Value[] {
        return argumentList.map((argument, index) => {
            const parameter = declaration.parameters[index];
            if (!parameter || !ts.isIdentifier(parameter.name)) {
                this.context.fail(
                    argument,
                    parameter
                        ? "Class parameters must be plain identifiers."
                        : `Class ${callable} received too many arguments.`,
                );
            }
            return this.context.compileClassParameterValue(
                parameter.name,
                argument,
            );
        });
    }

    /**
     * Compiles a method with `this` bound to its constructed instance.
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
        const activeRecursive = this.activeRecursiveMethods.get(method);
        if (activeRecursive) {
            if (activeRecursive.instance !== instance) {
                this.context.fail(
                    call,
                    `Recursive method '${methodName}' cannot switch class instances.`,
                );
            }
            return this.compileRecursiveInvocation(
                call,
                activeRecursive.cppName,
                activeRecursive.parameters,
                activeRecursive.returnType,
            );
        }
        // A method whose reached fields, parameters, and return all map
        // into the plain-data model emits once as a namespace function
        // over field reference channels; anything that does not cleanly
        // qualify keeps the per-call-site inline lowering below.
        const nativeMethod =
            this.context.nativeFunctions.tryCompileMethodCall(
                call,
                method,
                declaration,
                instance,
            );
        if (nativeMethod) {
            return nativeMethod;
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
        const sharedBody = method.parameters.every(parameter => {
            const type = this.context.dataTypes.fromTsType(this.context.checker.getTypeAtLocation(parameter), parameter);
            return ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken &&
                (!type || !this.context.dataTypes.carriesFunction(type));
        }) && this.context.canShareFunctionBody(method.body);
        const mappedReturnType = returnsVoid
            ? undefined
            : sharedBody ? this.context.dataTypes.fromSharedReturnType(effectiveReturn, method)
              : this.context.dataTypes.fromTsType(effectiveReturn, method);
        const returnType =
            mappedReturnType?.kind === "struct"
                ? this.context.dataTypes.markStoredObjectReferences(
                      mappedReturnType,
                  )
                : mappedReturnType ? this.context.dataTypes.ownReturnedArray(mappedReturnType) : undefined;
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
            const earlierValueReturn = firstReturn(leading, { valued: true });
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
            const argumentValues = this.compileClassArguments(
                method,
                call.arguments,
                "method",
            );
            this.context.pushScope(
                this.context.allocateUserFunctionPrefix(),
            );
            const previousThis = this.context.activeThis();
            this.context.defineThis(instance);
            try {
                this.bindParameters(
                    method,
                    call.arguments,
                    undefined,
                    false,
                    argumentValues,
                );
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
        if (this.methodRecurses(declaration, method)) {
            return this.compileRecursiveMethod(instance, methodName, call, method, returnType);
        }
        const shared = sharedBody && (!returnType || !this.context.dataTypes.carriesFunction(returnType));
        const argumentValues = this.compileClassArguments(
            method,
            call.arguments,
            "method",
        );
        if (shared) {
            const previousThis = this.context.activeThis();
            this.context.defineThis(instance);
            try {
                const result = this.context.compileSharedMethod(method, call, argumentValues);
                if (result) return result;
            } finally {
                this.context.defineThis(previousThis);
            }
        }
        this.context.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        const previousThis = this.context.activeThis();
        this.context.defineThis(instance);
        try {
            this.bindParameters(
                method,
                call.arguments,
                undefined,
                false,
                argumentValues,
            );
            const result = returnsVoid
                ? undefined
                : `bbl_class_${this.context.allocateUserFunctionPrefix()}result`;
            this.context.emit(
                returnsVoid
                    ? "[&]() -> void {"
                    : `[[maybe_unused]] const auto ${result} = [&]() -> ${this.context.dataTypes.cppType(returnType!)} {`,
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

    /** Inline a class setter with `this` bound to its compile-time instance. */
    public compileSetter(
        instance: Value,
        setter: ts.SetAccessorDeclaration,
        value: ts.Expression,
        evaluatedArgument?: Value,
    ): void {
        if (!setter.body || setter.parameters.length !== 1) {
            this.context.fail(
                setter,
                "A reached class setter requires one parameter and a body.",
            );
        }
        const argumentValue =
            evaluatedArgument ??
            this.compileClassArguments(
                setter,
                [value],
                "setter",
            )[0]!;
        this.context.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        const previousThis = this.context.activeThis();
        this.context.defineThis(instance);
        try {
            this.bindParameters(
                setter,
                [value],
                undefined,
                false,
                [argumentValue],
            );
            this.context.emit("[&]() -> void {");
            this.context.increaseIndent();
            this.context.beginNativeFunctionBody(undefined);
            try {
                for (const statement of setter.body.statements) {
                    this.context.emitStatement(statement);
                }
            } finally {
                this.context.endNativeFunctionBody();
                this.context.decreaseIndent();
            }
            this.context.emit("}();");
        } finally {
            this.context.defineThis(previousThis);
            this.context.popScope();
        }
    }

    /** Emit one native callable for a direct plain-data class recursion. */
    private compileRecursiveMethod(
        instance: Value,
        methodName: string,
        call: ts.CallExpression,
        method: ts.MethodDeclaration,
        returnType: DataType | undefined,
    ): Value {
        const parameters = method.parameters.map((parameter) => {
            if (
                !ts.isIdentifier(parameter.name) ||
                parameter.dotDotDotToken
            ) {
                this.context.fail(
                    parameter,
                    `Recursive method '${methodName}' requires non-rest identifier parameters.`,
                );
            }
            let type = this.context.dataTypes.fromTsType(
                this.context.checker.getTypeAtLocation(parameter),
                parameter,
            );
            if (type && this.context.dataTypes.returnsArray(returnType)) {
                type = this.context.dataTypes.ownReturnedArray(type);
            }
            if (!type || this.context.dataTypes.carriesHandle(type)) {
                this.context.fail(
                    parameter,
                    `Recursive method '${methodName}' parameters must contain only plain data.`,
                );
            }
            return { declaration: parameter, identifier: parameter.name, type };
        });
        if (
            returnType &&
            this.context.dataTypes.carriesHandle(returnType)
        ) {
            this.context.fail(
                method,
                `Recursive method '${methodName}' must return plain data or void.`,
            );
        }

        const specialization = this.emittedRecursiveMethods.key(this.context.functionEmissionScope(), [
            instance, functionDependencies(this.context, [method]),
        ]);
        const previous = this.emittedRecursiveMethods.get(method, specialization);
        if (previous) return this.compileRecursiveInvocation(call, previous, parameters, returnType);
        const prefix = this.context.allocateUserFunctionPrefix();
        const cppName = `${prefix}recursive_method`;
        const self = `${prefix}recursive_self`;
        const returnCpp = returnType
            ? this.context.dataTypes.cppType(returnType)
            : "void";
        const cppParameters = parameters.map(
            ({ declaration, identifier, type }, index) => {
                const cppType = this.context.dataTypes.cppType(type);
                const readOnly = parameterIsReadOnly(
                    this.context.checker,
                    method,
                    identifier,
                );
                const typeCpp = passesByReference(
                    this.context.dataTypes,
                    type,
                )
                    ? `${readOnly ? "const " : ""}${cppType}&`
                    : cppType;
                return {
                    name: `${prefix}arg_${index}`,
                    typeCpp,
                    declaration,
                    identifier,
                    type,
                    readOnly,
                };
            },
        );
        this.context.emit(
            `auto ${cppName} = bbl::js::make_recursive_group([&]([[maybe_unused]] auto& ${self}${cppParameters.length ? ", " : ""}${cppParameters.map(({ name, typeCpp }) => `${typeCpp} ${name}`).join(", ")}) -> ${returnCpp} {`,
        );
        this.context.increaseIndent();
        this.context.pushScope(prefix);
        const previousThis = this.context.activeThis();
        this.context.defineThis(instance);
        this.activeRecursiveMethods.set(method, {
            instance,
            cppName: `${self}.template call<0>`,
            parameters,
            returnType,
        });
        this.context.beginNativeFunctionBody(returnType);
        try {
            for (const parameter of cppParameters) {
                this.context.bindParameterValue(
                    parameter.identifier,
                    {
                        ...this.context.dataValue(
                            parameter.name,
                            parameter.type,
                        ),
                        ...(parameter.readOnly
                            ? { readOnly: true as const }
                            : {}),
                    },
                );
            }
            for (const statement of method.body!.statements) {
                this.context.emitStatement(statement);
            }
        } finally {
            this.context.endNativeFunctionBody();
            this.activeRecursiveMethods.delete(method);
            this.context.defineThis(previousThis);
            this.context.popScope();
            this.context.decreaseIndent();
        }
        this.context.emit("});");
        this.emittedRecursiveMethods.set(method, specialization, `${cppName}.template call<0>`);
        return this.compileRecursiveInvocation(
            call,
            `${cppName}.template call<0>`,
            parameters,
            returnType,
        );
    }

    private compileRecursiveInvocation(
        call: ts.CallExpression,
        cppName: string,
        parameters: readonly {
            declaration: ts.ParameterDeclaration;
            type: DataType;
        }[],
        returnType: DataType | undefined,
    ): Value {
        if (call.arguments.length > parameters.length) {
            this.context.fail(
                call,
                "Recursive method received too many arguments.",
            );
        }
        const argumentsCpp = parameters.map(
            ({ declaration, type }, index) => {
                const argument =
                    call.arguments[index] ?? declaration.initializer;
                if (!argument) {
                    this.context.fail(
                        call,
                        `Recursive method argument ${index + 1} is required.`,
                    );
                }
                return this.context.compileForDataSink(
                    argument,
                    type,
                );
            },
        );
        const invocation = `${cppName}(${argumentsCpp.join(", ")})`;
        if (!returnType) {
            return { kind: "void", cpp: invocation };
        }
        return {
            ...this.context.dataValue(invocation, returnType),
            requiresExplicitDiscard: true,
        };
    }

    private methodRecurses(
        declaration: ts.ClassDeclaration,
        method: ts.MethodDeclaration,
    ): boolean {
        const cached = this.recursiveMethods.get(method);
        if (cached !== undefined) return cached;
        const methods = new EmissionMap<string, ts.MethodDeclaration>();
        for (const member of declaration.members) {
            if (
                ts.isMethodDeclaration(member) &&
                ts.isIdentifier(member.name) &&
                member.body
            ) {
                methods.set(member.name.text, member);
            }
        }
        const callees = (candidate: ts.MethodDeclaration): ts.MethodDeclaration[] => {
            const found = new EmissionSet<ts.MethodDeclaration>();
            const visit = (node: ts.Node): void => {
                if (node !== candidate && ts.isFunctionLike(node)) return;
                if (
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.expression.kind ===
                        ts.SyntaxKind.ThisKeyword
                ) {
                    const called = methods.get(node.expression.name.text);
                    if (called) found.add(called);
                }
                ts.forEachChild(node, visit);
            };
            visit(candidate.body!);
            return [...found];
        };
        const explored = new EmissionSet<ts.MethodDeclaration>();
        const reachesStart = (candidate: ts.MethodDeclaration): boolean => {
            if (explored.has(candidate)) return false;
            explored.add(candidate);
            return callees(candidate).some(
                (called) =>
                    called === method || reachesStart(called),
            );
        };
        const recursive = reachesStart(method);
        this.recursiveMethods.set(method, recursive);
        return recursive;
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
                ts.isIdentifier(property.name)
            ) {
                const identifier = this.context.unwrap(property.initializer);
                if (!ts.isIdentifier(identifier)) return undefined;
                descriptors.push({
                    name: property.name.text,
                    identifier,
                });
                continue;
            }
            return undefined;
        }
        if (descriptors.length === 0) return undefined;

        const argumentValues = this.compileClassArguments(
            method,
            call.arguments,
            "method",
        );
        this.context.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        const previousThis = this.context.activeThis();
        this.context.defineThis(instance);
        try {
            this.bindParameters(
                method,
                call.arguments,
                undefined,
                false,
                argumentValues,
            );
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
                    this.context.assignOptionalResourceValue(
                        output,
                        value,
                        descriptor.identifier,
                    );
                    if (value.engineCpp !== undefined) {
                        output.engineCpp = value.engineCpp;
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
    /** The symbols a body spreads into an object literal, one walk per body. */
    private spreadParameterSymbols(
        declaration:
            | ts.ConstructorDeclaration
            | ts.MethodDeclaration
            | ts.SetAccessorDeclaration,
    ): Set<ts.Symbol> {
        const cached = this.spreadSymbolsByDeclaration.get(declaration);
        if (cached) return cached;
        const symbols = new EmissionSet<ts.Symbol>();
        const visit = (node: ts.Node): void => {
            if (ts.isFunctionLike(node)) return;
            if (ts.isSpreadAssignment(node)) {
                const spread = this.context.unwrap(node.expression);
                if (ts.isIdentifier(spread)) {
                    const symbol =
                        this.context.checker.getSymbolAtLocation(spread);
                    if (symbol) symbols.add(symbol);
                }
            }
            ts.forEachChild(node, visit);
        };
        for (const statement of declaration.body?.statements ?? []) {
            visit(statement);
        }
        this.spreadSymbolsByDeclaration.set(declaration, symbols);
        return symbols;
    }

    private readonly spreadSymbolsByDeclaration = new EmissionWeakMap<
        ts.Node,
        Set<ts.Symbol>
    >();

    private bindParameters(
        declaration:
            | ts.ConstructorDeclaration
            | ts.MethodDeclaration
            | ts.SetAccessorDeclaration,
        argumentList: readonly ts.Expression[],
        parameterProperties?: Record<string, Value>,
        preserveStaticRecords = false,
        evaluatedArguments?: readonly Value[],
    ): void {
        const spreadParameters = this.spreadParameterSymbols(declaration);
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
            const evaluatedArgument =
                index < argumentList.length
                    ? evaluatedArguments?.[index]
                    : undefined;
            if (!argument) {
                if (parameter.questionToken) {
                    const parameterType =
                        this.context.dataTypes.fromTsType(
                            this.context.checker.getTypeAtLocation(
                                parameter,
                            ),
                            parameter,
                        );
                    if (parameterType?.kind === "optional") {
                        this.context.bindParameterValue(
                            parameter.name,
                            this.context.dataValue(
                                `${this.context.dataTypes.cppType(parameterType)}{std::nullopt}`,
                                parameterType,
                            ),
                        );
                    } else if (
                        parameterType?.kind === "struct" &&
                        this.context.dataTypes.isReferenceStruct(
                            parameterType.name,
                        )
                    ) {
                        this.context.bindParameterValue(
                            parameter.name,
                            this.context.dataValue(
                                `${this.context.dataTypes.cppType(parameterType)}{}`,
                                parameterType,
                            ),
                        );
                    } else {
                        this.context.bindParameterValue(
                            parameter.name,
                            { kind: "json-null", cpp: "" },
                        );
                    }
                    if (
                        parameterProperties &&
                        ts.isParameterPropertyDeclaration(
                            parameter,
                            declaration,
                        )
                    ) {
                        this.initializeParameterProperty(parameter.name, parameterProperties);
                    }
                    return;
                }
                this.context.fail(
                    parameter,
                    `Parameter '${parameter.name.text}' requires an argument or a default.`,
                );
            }
            // The declared parameter type is the sink. A compile-time
            // object record passed to a struct parameter must materialize
            // as that struct before constructor field wiring observes it.
            const parameterSymbol = this.context.checker.getSymbolAtLocation(
                parameter.name,
            );
            const spreadUse =
                parameterSymbol !== undefined &&
                spreadParameters.has(parameterSymbol);
            const staticRecord = evaluatedArgument?.kind === "record"
                ? evaluatedArgument
                : preserveStaticRecords || spreadUse
                  ? this.context.compileValue(argument)
                  : undefined;
            if (staticRecord?.kind === "record") {
                this.context.bindParameterValue(
                    parameter.name,
                    staticRecord,
                );
            } else if (evaluatedArgument) {
                this.context.bindParameterValue(
                    parameter.name,
                    evaluatedArgument,
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
                this.initializeParameterProperty(parameter.name, parameterProperties);
            }
        });
    }

    private initializeParameterProperty(name: ts.Identifier, properties: Record<string, Value>): void {
        const stored = properties[name.text];
        if (stored?.classStoredField) {
            this.context.emit(`${stored.cpp} = ${this.context.compileForDataSink(name, stored.dataType!)};`);
        } else {
            properties[name.text] = this.context.compileValue(name);
        }
    }

    private rejectUnsupportedMembers(
        declaration: ts.ClassDeclaration,
    ): void {
        if (
            declaration.heritageClauses?.some(
                (clause) =>
                    clause.token === ts.SyntaxKind.ExtendsKeyword,
            )
        ) {
            this.context.fail(
                declaration,
                "Class inheritance is outside the supported subset.",
            );
        }
        for (const member of declaration.members) {
            if (
                !ts.isMethodDeclaration(member) &&
                (ts.getCombinedModifierFlags(
                    member as ts.Declaration,
                ) & ts.ModifierFlags.Static) !== 0
            ) {
                if (
                    ts.isPropertyDeclaration(member) &&
                    member.initializer &&
                    (ts.getCombinedModifierFlags(member) &
                        ts.ModifierFlags.Readonly) !==
                        0
                ) {
                    continue;
                }
                this.context.fail(
                    member,
                    "Static class fields and accessors are outside the supported subset.",
                );
            }
        }
    }
}
