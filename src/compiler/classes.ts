import {
    optionalPresentCpp,
    valueForKind,
    withNativeMetadata,
} from "./types.js";
import {
    EmissionSet,
    EmissionMap,
    EmissionWeakMap,
    writable,
} from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import { declaredSymbol, resolvedSymbol } from "./symbols.js";
import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import type { DataStructField, DataType } from "./data-types.js";
import {
    classTagMember,
    dataTypesEqual,
    passesByReference,
} from "./data-types.js";
import type { Value } from "./types.js";
import { sameCompiledValue } from "./types.js";
import {
    borrowsReferenceParameter,
    parameterIsReadOnly,
} from "./user-functions.js";
import { firstReturn } from "./loop-control.js";
import { someAnalysisNode } from "./analysis-walk.js";
import { pinOperand } from "./evaluation-order.js";
import type { NativeCaptureBinding } from "./closure-captures.js";
import {
    FunctionSpecializations,
    functionDependencies,
} from "./function-specializations.js";
import {
    type ClassMemberTable,
    classAccessors,
    classChain,
    classChainInstanceProperties,
    classExtends,
    classHasStaticState,
    classMemberTable,
    classMethod,
    effectiveConstructor,
    isStaticMember,
    staticClassMember,
} from "./class-members.js";

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

/** The `super(...)` call a constructor statement consists of. */
function superCallOf(statement: ts.Statement): ts.CallExpression | undefined {
    if (!ts.isExpressionStatement(statement)) return undefined;
    const expression = statement.expression;
    return ts.isCallExpression(expression) &&
        expression.expression.kind === ts.SyntaxKind.SuperKeyword
        ? expression
        : undefined;
}

/** The class whose body lexically contains `node`: the home of its `super`. */
function enclosingClass(node: ts.Node): ts.ClassDeclaration | undefined {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isClassDeclaration(current)) return current;
    }
    return undefined;
}

/** The private names one class body declares. */
function declaredPrivateNames(
    declaration: ts.ClassDeclaration,
): Map<string, ts.PrivateIdentifier> {
    const names = new Map<string, ts.PrivateIdentifier>();
    for (const member of declaration.members) {
        if (member.name && ts.isPrivateIdentifier(member.name)) {
            names.set(member.name.text, member.name);
        }
    }
    return names;
}

interface ClassLoweringContext extends Pick<
    LoweringServices,
    | "checker"
    | "evaluationOrder"
    | "options"
    | "compileAsyncCall"
    | "dataTypes"
    | "dataLowerer"
    | "nativeFunctions"
    | "functionEmissionScope"
    | "canShareFunctionBody"
    | "compileSharedMethod"
    | "registerNativeBinding"
    | "registerNativeBindingType"
    | "registerNativeConstBinding"
    | "registerNativeTemporary"
    | "cppString"
    | "sharedClosures"
    | "compileValue"
    | "emitStatement"
    | "bindings"
    | "bindClassParameterValue"
    | "compileClassParameterValue"
    | "bindClassField"
    | "bindNullableClassField"
    | "bindUninitializedClassDataField"
    | "bindOptionalResourceValue"
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
    | "classOf"
    | "compileRecordGetter"
    | "enterRuntimeControlFlow"
    | "leaveRuntimeControlFlow"
    | "probeEmission"
    | "useNativeValue"
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
    /**
     * Emitted recursive groups: the callable and the native binding a
     * closure calling it captures.
     */
    private readonly emittedRecursiveMethods = new FunctionSpecializations<{
        cpp: string;
        binding: NativeCaptureBinding;
    }>();
    /** Per receiver class, whether a method reaches itself through `this`. */
    private readonly recursiveMethods = new EmissionMap<
        ts.ClassDeclaration,
        Map<ts.MethodDeclaration, boolean>
    >();
    /**
     * Per shared class, the fields its layout hoisted and the value each
     * one was proven to hold at every construction.
     */
    private readonly hoistedClassFields = new EmissionMap<
        string,
        Map<string, Value>
    >();
    /** Per shared class, every field name the constructions so far declare. */
    private readonly hoistedClassDeclared = new EmissionMap<
        string,
        Set<string>
    >();
    private readonly activeRecursiveMethods = new EmissionMap<
        ts.MethodDeclaration,
        {
            instance: Value;
            cppName: string;
            parameters: readonly {
                declaration: ts.ParameterDeclaration;
                type: DataType;
                borrowedWrapper: boolean;
            }[];
            returnType: DataType | undefined;
            /** The group takes its receiver as its first argument. */
            overReceiver: boolean;
            /** The group's own `self`, which a closure calling it captures. */
            binding: NativeCaptureBinding;
        }
    >();

    /**
     * Per class without static storage, the record its static methods run
     * against: `this` inside them still names the class.
     */
    private readonly emptyStaticRecords = new EmissionMap<
        ts.ClassDeclaration,
        Value
    >();
    /**
     * Methods being inlined on a stored instance. Re-entering one of them
     * on another stored instance is recursion through run-time objects, which
     * inlining cannot unroll.
     */
    private readonly storedReceiverMethods =
        new EmissionSet<ts.MethodDeclaration>();

    public constructor(private readonly context: ClassLoweringContext) {}

    private table(declaration: ts.ClassDeclaration): ClassMemberTable {
        return classMemberTable(this.context.checker, declaration);
    }

    /**
     * Resolves the class declaration a `new` expression constructs, or
     * undefined when the callee is not a local class.
     */
    public resolveClass(
        expression: ts.NewExpression,
    ): ts.ClassDeclaration | undefined {
        const callee = this.context.unwrap(expression.expression);
        if (!ts.isIdentifier(callee)) {
            return undefined;
        }
        const target = resolvedSymbol(this.context.checker, callee);
        const declaration = (target?.declarations ?? []).find(
            ts.isClassDeclaration,
        );
        return declaration;
    }

    /** The class a static member access reads, through a class name or a static `this`. */
    private staticMember(
        access: ts.PropertyAccessExpression,
    ): { table: ClassMemberTable; name: string } | undefined {
        const owner = this.context.unwrap(access.expression);
        if (owner.kind === ts.SyntaxKind.ThisKeyword) {
            if (!this.context.activeThis()?.classStatics) return undefined;
            const member = resolvedSymbol(
                this.context.checker,
                access,
            )?.declarations?.find(
                (candidate): candidate is ts.ClassElement =>
                    ts.isClassElement(candidate) &&
                    isStaticMember(candidate) &&
                    ts.isClassDeclaration(candidate.parent),
            );
            return member && ts.isClassDeclaration(member.parent)
                ? { table: this.table(member.parent), name: access.name.text }
                : undefined;
        }
        return staticClassMember(this.context.checker, owner, access.name);
    }

    /** Resolve `ClassName.staticFactory(...)` to its local method body. */
    public resolveStaticMethod(
        callee: ts.PropertyAccessExpression,
    ): ts.MethodDeclaration | undefined {
        const found = this.staticMember(callee);
        return found?.table.staticMethods.get(found.name);
    }

    /** Resolve a generation-time `static readonly` scalar field. */
    public resolveStaticField(
        access: ts.PropertyAccessExpression,
    ): ts.PropertyDeclaration | undefined {
        const found = this.staticMember(access);
        return found?.table.staticConstants.get(found.name);
    }

    /**
     * Runs a static method's lowering with `this` bound to the class it was
     * called through: `Derived.create()` runs an inherited `create` with
     * `this` naming `Derived`, as JavaScript does.
     */
    public withStaticReceiver<T>(
        callee: ts.PropertyAccessExpression,
        work: () => T,
    ): T {
        const owner = this.context.unwrap(callee.expression);
        const receiver =
            owner.kind === ts.SyntaxKind.ThisKeyword
                ? this.context.activeThis()
                : this.staticRecord(owner);
        const previousThis = this.context.activeThis();
        this.context.defineThis(receiver);
        try {
            return work();
        } finally {
            this.context.defineThis(previousThis);
        }
    }

    /**
     * The record a class name reads its static fields from, or undefined
     * when `owner` names no local class.
     *
     * The class declaration binds it where it evaluates, so a class declared
     * in a function body has one per evaluation. A class with no static
     * storage evaluates to nothing and reads as an empty record; one whose
     * static storage was never evaluated refuses rather than reading fields
     * that do not exist yet.
     */
    public staticRecord(owner: ts.Expression): Value | undefined {
        if (!ts.isIdentifier(owner)) return undefined;
        const bound = this.context.bindings.lookupOptional(owner);
        if (bound?.classStatics) return bound;
        const declaration = resolvedSymbol(this.context.checker, owner)
            ?.getDeclarations()
            ?.find(ts.isClassDeclaration);
        if (!declaration || bound) return undefined;
        if (this.hasStaticState(declaration)) {
            this.context.fail(
                owner,
                `Class '${owner.text}' is used before its declaration ` +
                    "evaluated its static fields and blocks.",
            );
        }
        let record = this.emptyStaticRecords.get(declaration);
        if (!record) {
            record = {
                kind: "record",
                cpp: "",
                recordProperties: {},
                classStatics: declaration,
            };
            this.emptyStaticRecords.set(declaration, record);
        }
        return record;
    }

    /** Whether evaluating the class declaration runs or stores anything. */
    public hasStaticState(declaration: ts.ClassDeclaration): boolean {
        return classHasStaticState(this.context.checker, declaration);
    }

    /**
     * Evaluates a class declaration: its static fields and `static { ... }`
     * blocks run here, in declaration order, with `this` naming the class.
     *
     * The static fields become storage owned by the scope the declaration
     * sits in, gathered into one record bound to the class name, so `C.x`
     * and a static method's `this.x` read and write the same storage. A
     * subclass's record also reaches the static fields it inherits. A class
     * with no static state emits nothing: construction and member calls
     * lower where they are reached.
     */
    public emitDeclaration(declaration: ts.ClassDeclaration): void {
        if (!this.hasStaticState(declaration)) return;
        const table = this.table(declaration);
        if (!declaration.name) {
            this.context.fail(
                declaration,
                "A class with static state requires a name.",
            );
        }
        const baseName = table.base?.declaration.name;
        const inherited = baseName
            ? this.context.bindings.lookupOptional(baseName)
            : undefined;
        if (
            table.base &&
            !inherited?.classStatics &&
            this.hasStaticState(table.base.declaration)
        ) {
            this.context.fail(
                declaration,
                `Class '${declaration.name.text}' extends a class whose ` +
                    "static state is not evaluated in this scope.",
            );
        }
        const statics: Record<string, Value> = {
            ...(inherited?.classStatics ? inherited.recordProperties : {}),
        };
        const record: Value = {
            kind: "record",
            cpp: "",
            recordProperties: statics,
            classStatics: declaration,
        };
        this.context.bindings.bindCompileTimeValue(declaration.name, record);
        const previousThis = this.context.activeThis();
        this.context.defineThis(record);
        try {
            for (const element of table.staticElements) {
                if (ts.isClassStaticBlockDeclaration(element)) {
                    this.context.bindings.pushScope(
                        this.context.allocateUserFunctionPrefix(),
                    );
                    this.context.emit("{");
                    this.context.increaseIndent();
                    try {
                        for (const statement of element.body.statements) {
                            this.context.emitStatement(statement);
                        }
                    } finally {
                        this.context.decreaseIndent();
                        this.context.bindings.popScope();
                    }
                    this.context.emit("}");
                    continue;
                }
                statics[element.name.text] = this.bindStaticField(element);
            }
        } finally {
            this.context.defineThis(previousThis);
        }
    }

    /**
     * Storage for one static field, initialized where the class evaluates.
     * Any code can assign it later, so its declared type is a stored
     * position: a local class it names takes its shared representation.
     */
    private bindStaticField(
        field: ts.PropertyDeclaration & { name: ts.MemberName },
    ): Value {
        const declared = this.context.dataTypes.fromStoredTsType(
            this.context.checker.getTypeAtLocation(field.name),
            field.name,
        );
        if (field.initializer) {
            this.context.bindClassField(
                field.name,
                field.initializer,
                declared,
            );
            return this.context.compileValue(field.name);
        }
        const storage =
            this.context.bindNullableClassField(field.name) ??
            this.context.bindUninitializedClassDataField(field.name, declared);
        if (!storage) {
            this.context.fail(
                field,
                `Static field '${field.name.text}' has no initializer, so it ` +
                    "starts undefined; its type needs an optional representation.",
            );
        }
        return storage;
    }

    /**
     * Refuses a write through a subclass to a static field it inherits.
     *
     * JavaScript gives the subclass its own property at that write, which the
     * shared storage cannot express; reads through the subclass see the base
     * class's field and stay supported.
     */
    public refuseInheritedStaticWrite(
        access: ts.PropertyAccessExpression,
    ): void {
        const field = this.staticField(access);
        const statics = field?.owner?.classStatics;
        if (
            !field ||
            !statics ||
            this.table(statics).staticFields.has(field.name)
        )
            return;
        this.context.fail(
            access.name,
            `Static field '${field.name}' is inherited by class ` +
                `'${statics.name?.text ?? "?"}'; writing it through the ` +
                "subclass would create a separate property there.",
        );
    }

    /**
     * `C.x` or a static method's `this.x` for a static field with storage:
     * the storage the class's record holds, through the constructor chain.
     * Undefined when the access names no such field.
     */
    public readStaticField(
        access: ts.PropertyAccessExpression,
    ): Value | undefined {
        const field = this.staticField(access);
        if (!field) return undefined;
        const value = field.owner?.recordProperties?.[field.name];
        if (!value) {
            this.context.fail(
                access,
                `Static field '${field.name}' is read before its class declaration ` +
                    "evaluated it.",
            );
        }
        return value;
    }

    /**
     * The static field with storage a `C.x` or static `this.x` access names,
     * with the record of the class it is read through.
     */
    private staticField(
        access: ts.PropertyAccessExpression,
    ): { owner: Value | undefined; name: string } | undefined {
        const found = this.staticMember(access);
        if (
            !found ||
            !classChain(found.table).some((link) =>
                link.staticFields.has(found.name),
            )
        )
            return undefined;
        const owner = this.context.unwrap(access.expression);
        return {
            owner:
                owner.kind === ts.SyntaxKind.ThisKeyword
                    ? this.context.activeThis()
                    : this.staticRecord(owner),
            name: found.name,
        };
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
        const tryStatement = statements[0];
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
        const { constructorDeclaration, base } = this.table(owner);
        if (
            base ||
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
        const parameterNames = constructorDeclaration.parameters.map(
            (parameter) => parameter.name,
        );
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
        if (parameterNames.some((name) => !fieldByParameter.has(name.text))) {
            return undefined;
        }

        this.context.bindings.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        try {
            this.bindParameters(method, call.arguments, undefined, true);
            const instance = this.construct(fallback!, owner);
            const fields = instance.recordProperties!;
            const targets = parameterNames.map((parameter) => {
                const field = fieldByParameter.get(parameter.text)!;
                return (
                    fields[field] ??
                    this.context.fail(
                        parameter,
                        `Fallback construction did not bind field '${field}' (bound: ${Object.keys(fields).join(", ")}).`,
                    )
                );
            });
            if (targets.some((target) => !target.optionalStorageCpp)) {
                this.context.fail(
                    fallback!,
                    "A nullable-resource fallback factory requires optional storage for every constructor field.",
                );
            }
            this.context.emit("try {");
            this.context.increaseIndent();
            this.context.bindings.pushScope(
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
                        writable(target).engineCpp = value.engineCpp;
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
                this.context.bindings.pushScope(
                    this.context.allocateUserFunctionPrefix(),
                );
                const previousThis = this.context.activeThis();
                this.context.defineThis(instance);
                try {
                    parameterNames.forEach((parameter, index) => {
                        const value = values[index]!;
                        const target = targets[index]!;
                        const resourceValue =
                            successfulConstructorResourceKinds.has(value.kind);
                        this.context.bindings.bindParameterValue(
                            parameter,
                            resourceValue
                                ? {
                                      ...value,
                                      truthinessCpp: optionalPresentCpp(
                                          target.optionalStorageCpp!,
                                      ),
                                  }
                                : value,
                        );
                    });
                    for (const statement of constructorDeclaration.body
                        ?.statements ?? []) {
                        if (!constructorFieldWrites.has(statement)) {
                            this.context.emitStatement(statement);
                        }
                    }
                } finally {
                    this.context.defineThis(previousThis);
                    this.context.bindings.popScope();
                }
            } finally {
                this.context.bindings.popScope();
                this.context.decreaseIndent();
            }
            this.context.emit("} catch (...) {");
            this.context.emit(
                "    // The prebuilt all-null instance is the source fallback.",
            );
            this.context.emit("}");
            return instance;
        } finally {
            this.context.bindings.popScope();
        }
    }

    /**
     * Constructs an instance: declares each field's binding, then runs
     * the constructor body with `this` bound to the record under
     * construction. A subclass runs its base class's construction at its
     * `super(...)` call -- or first, when it declares no constructor -- so
     * one record carries the fields of the whole chain.
     */
    public construct(
        expression: ts.NewExpression,
        declaration: ts.ClassDeclaration,
    ): Value {
        this.rejectUnsupportedMembers(declaration);
        const members = this.table(declaration);
        const constructorDeclaration = effectiveConstructor(members);
        if (
            !constructorDeclaration &&
            (expression.arguments?.length ?? 0) > 0
        ) {
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
        const instanceType = this.context.checker.getTypeAtLocation(expression);
        const instanceTypeArguments = this.context.dataTypes.typeArgumentsOf(
            declaration,
            instanceType,
        );
        const accessors = classAccessors(members);
        const instance: Value = {
            kind: "record",
            cpp: "",
            recordProperties: fields,
            recordGetters: accessors.getters,
            recordSetters: accessors.setters,
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
            // One struct holds every class of a hierarchy; the tag records
            // which one this object is, for dispatch and `instanceof`.
            if (this.context.dataTypes.classStructTagged(structName)) {
                this.context.emit(
                    `${cpp}->${classTagMember} = ` +
                        `${this.context.dataTypes.classHierarchy.tag(declaration)};`,
                );
            }
            this.context.registerNativeBindingType(cpp, cppType);
            writable(instance).cpp = cpp;
            writable(instance).dataType = structType;
            for (const field of layout) {
                fields[field.source] = this.storedFieldValue(cpp, field);
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
        this.context.registerClassInstance(instance, declaration);

        const previousThis = this.context.activeThis();
        this.context.defineThis(instance);
        try {
            this.initialize(
                members,
                expression.arguments ?? [],
                evaluatedArguments,
                instance,
                instanceType,
            );
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
        }
        return instance;
    }

    /**
     * Runs one class's part of a construction with `this` already bound:
     * its field initializers, its parameter properties and its constructor
     * body, in JavaScript's order. A base class initializes first, then its
     * fields, then the body. A subclass binds its parameters, runs its body
     * up to `super(...)`, constructs the base with the arguments that call
     * evaluated, initializes its own fields and parameter properties, and
     * finishes the body. A subclass without a constructor passes its
     * arguments to the base unchanged.
     */
    private initialize(
        table: ClassMemberTable,
        argumentList: readonly ts.Expression[],
        evaluatedArguments: readonly Value[],
        instance: Value,
        instanceType: ts.Type,
    ): void {
        const fields = writable(instance.recordProperties!);
        const constructorDeclaration = table.constructorDeclaration;
        if (table.base && !constructorDeclaration) {
            this.initialize(
                table.base,
                argumentList,
                evaluatedArguments,
                instance,
                instanceType,
            );
        }
        this.context.bindings.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        try {
            if (!table.base || !constructorDeclaration) {
                // Field declarations with initializers bind first, so the
                // constructor body can already read them.
                this.initializeFields(table, instance, instanceType);
                if (constructorDeclaration) {
                    this.bindParameters(
                        constructorDeclaration,
                        argumentList,
                        fields,
                        false,
                        evaluatedArguments,
                    );
                    for (const statement of constructorDeclaration.body
                        ?.statements ?? []) {
                        this.context.emitStatement(statement);
                    }
                }
                return;
            }
            this.bindParameters(
                constructorDeclaration,
                argumentList,
                undefined,
                false,
                evaluatedArguments,
            );
            let constructed = false;
            for (const statement of constructorDeclaration.body?.statements ??
                []) {
                const superCall = superCallOf(statement);
                if (!superCall) {
                    this.context.emitStatement(statement);
                    continue;
                }
                if (constructed) {
                    this.context.fail(
                        superCall,
                        "A constructor calls super() once.",
                    );
                }
                constructed = true;
                const baseConstructor = effectiveConstructor(table.base);
                if (!baseConstructor && superCall.arguments.length > 0) {
                    this.context.fail(
                        superCall,
                        `Class '${table.base.declaration.name?.text ?? "?"}' has no constructor accepting arguments.`,
                    );
                }
                const baseArguments = baseConstructor
                    ? this.compileClassArguments(
                          baseConstructor,
                          superCall.arguments,
                          "constructor",
                      )
                    : [];
                this.initialize(
                    table.base,
                    superCall.arguments,
                    baseArguments,
                    instance,
                    instanceType,
                );
                this.initializeFields(table, instance, instanceType);
                for (const parameter of constructorDeclaration.parameters) {
                    if (
                        ts.isParameterPropertyDeclaration(
                            parameter,
                            constructorDeclaration,
                        ) &&
                        ts.isIdentifier(parameter.name)
                    ) {
                        this.initializeParameterProperty(
                            parameter.name,
                            fields,
                        );
                    }
                }
            }
            if (!constructed) {
                this.context.fail(
                    constructorDeclaration,
                    "A derived constructor must call super(...) as one of " +
                        "its top-level statements.",
                );
            }
        } finally {
            this.context.bindings.popScope();
        }
    }

    /** Binds one class body's own field declarations on the instance under construction. */
    private initializeFields(
        table: ClassMemberTable,
        instance: Value,
        instanceType: ts.Type,
    ): void {
        const fields = writable(instance.recordProperties!);
        const inherited = new Set(
            table.base
                ? classChainInstanceProperties(table.base).map(
                      (property) => property.name.text,
                  )
                : [],
        );
        for (const member of table.instanceProperties) {
            if (ts.isParameter(member)) continue;
            if (inherited.has(member.name.text) && !member.initializer) {
                // `declare` restates an inherited field's type and emits nothing.
                if (
                    (ts.getCombinedModifierFlags(member) &
                        ts.ModifierFlags.Ambient) !==
                    0
                )
                    continue;
                // Otherwise the redeclaration is redefined as `undefined`
                // after `super()` returns, discarding what the base stored.
                this.context.fail(
                    member,
                    `Field '${member.name.text}' redeclares an inherited field ` +
                        "without an initializer, which resets it to undefined; " +
                        "write `declare` to restate its type.",
                );
            }
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
                const nullable = this.context.bindNullableClassField(
                    member.name,
                );
                if (nullable) {
                    fields[member.name.text] = nullable;
                } else {
                    const data = this.context.bindUninitializedClassDataField(
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
                    const declared = this.context.checker.getTypeAtLocation(
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
                writable(bound).callbackRecordOwner = {
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
        for (const member of classChainInstanceProperties(
            this.table(declaration),
        )) {
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
    ): ReadonlyMap<string, { index: number; assignment: ts.BinaryExpression }> {
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
            classChainInstanceProperties(this.table(declaration)).map(
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
        writable(value).nativeLvalue = true;
        writable(value).borrowedData = true;
        writable(value).classStoredField = true;
        writable(value).nativeCaptures = [
            this.context.registerNativeBinding(instanceCpp, false, true),
        ];
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
     * inheriting the first one's. In a hierarchy's shared struct, a field
     * only the classes under one subclass declare is compared across the
     * constructions of those classes.
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
        const declared = new EmissionSet(
            classChainInstanceProperties(this.table(declaration)).map(
                (member) => member.name.text,
            ),
        );
        const known = this.hoistedClassFields.get(structName);
        const seen = this.hoistedClassDeclared.get(structName);
        if (!known || !seen) {
            this.hoistedClassFields.set(structName, hoisted);
            this.hoistedClassDeclared.set(structName, declared);
            return;
        }
        for (const [name, value] of hoisted) {
            const first = known.get(name);
            if (!first && !seen.has(name)) {
                known.set(name, value);
                continue;
            }
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
            if (!hoisted.has(name) && declared.has(name)) {
                this.context.fail(
                    node,
                    `Field '${name}' of shared class ` +
                        `'${declaration.name?.text ?? structName}' is bound at ` +
                        "one construction and not at another.",
                );
            }
        }
        for (const name of declared) seen.add(name);
    }

    /**
     * Turns a stored instance back into the record the class subset
     * inlines against: its fields are the slots of the `Ref` this value
     * names, plus the fields the layout proved uniform.
     *
     * The receiver is bound to a local first when repeating its expression
     * would repeat work or read a loop variable that has since moved on;
     * a plain name is already stable and is used as it stands.
     *
     * A hierarchy's struct holds every class under its root, so the record
     * is read as the class `node`'s type names and carries the concrete
     * classes that type admits; a member one of them overrides dispatches
     * on the stored tag.
     */
    public hydrate(value: Value, node?: ts.Node): Value | undefined {
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
            const source = this.context.allocateTemporaryCppName(
                `${structName.toLowerCase()}_receiver_source`,
            );
            const lifetime = this.context.allocateTemporaryCppName(
                `${structName.toLowerCase()}_receiver_lifetime`,
            );
            this.context.emit(`const auto& ${source} = ${instanceCpp};`);
            this.context.emit(
                `[[maybe_unused]] auto ${lifetime} = ${source}.lifetime_owner();`,
            );
            this.context.emit(
                `${this.context.dataTypes.cppType(value.dataType)} ` +
                    `${bound} = ${source};`,
            );
            this.context.registerNativeBindingType(
                bound,
                this.context.dataTypes.cppType(value.dataType),
            );
            instanceCpp = bound;
        }
        // A computed receiver's identity and presence spellings follow the
        // binding, or an optional call would spell the call a second time;
        // a storage read is stable and keeps its own.
        const receiver =
            instanceCpp === value.cpp || value.nativeLvalue
                ? value
                : withNativeMetadata(
                      this.context.dataValue(instanceCpp, value.dataType),
                      value,
                  );
        if (!this.context.dataTypes.classStructTagged(structName)) {
            return this.receiverRecord(
                { ...receiver, cpp: instanceCpp },
                binding.declaration,
                undefined,
                binding.type,
            );
        }
        return this.narrowedReceiver(
            { ...receiver, cpp: instanceCpp },
            this.staticCandidates(binding.declaration, node),
            node ?? binding.declaration,
        );
    }

    /**
     * The concrete classes a stored instance whose type `node` spells can be:
     * each class of that type (a union names several) and every class under
     * it. A type that names no class of the hierarchy -- a structural
     * interface -- admits all of them.
     */
    private staticCandidates(
        root: ts.ClassDeclaration,
        node: ts.Node | undefined,
    ): ts.ClassDeclaration[] {
        const hierarchy = this.context.dataTypes.classHierarchy;
        const all = hierarchy.concreteClasses(root);
        if (!node) return [...all];
        const type = this.context.checker.getNonNullableType(
            this.context.checker.getTypeAtLocation(node),
        );
        const classes: ts.ClassDeclaration[] = [];
        for (const member of type.isUnion() ? type.types : [type]) {
            const constraint =
                (member.flags & ts.TypeFlags.TypeParameter) !== 0
                    ? this.context.checker.getBaseConstraintOfType(member)
                    : member;
            const declaration = constraint?.symbol
                ?.getDeclarations()
                ?.find(ts.isClassDeclaration);
            if (!declaration || hierarchy.root(declaration) !== root) {
                return [...all];
            }
            classes.push(declaration);
        }
        const admitted = new Set(
            classes.flatMap((declaration) =>
                hierarchy.concreteClasses(declaration),
            ),
        );
        return all.filter((candidate) => admitted.has(candidate));
    }

    /** A stored receiver read as the most derived class all `candidates` share. */
    private narrowedReceiver(
        receiver: Value,
        candidates: readonly ts.ClassDeclaration[],
        node: ts.Node,
    ): Value {
        if (candidates.length === 0) {
            this.context.fail(
                node,
                "No concrete class can be an instance of this type.",
            );
        }
        return this.receiverRecord(
            receiver,
            this.context.dataTypes.classHierarchy.commonClass(candidates),
            candidates.length > 1 ? candidates : undefined,
            undefined,
        );
    }

    /** The record a stored receiver reads as `declaration`, over the slots it names. */
    private receiverRecord(
        receiver: Value,
        declaration: ts.ClassDeclaration,
        candidates: readonly ts.ClassDeclaration[] | undefined,
        type: ts.Type | undefined,
    ): Value {
        const structName = (receiver.dataType as { name: string }).name;
        const fields: Record<string, Value> = {};
        const hoisted = this.hoistedClassFields.get(structName);
        const members = this.table(declaration);
        for (const member of classChainInstanceProperties(members)) {
            const source = member.name.text;
            const stored = this.context.dataTypes.classStructField(
                structName,
                source,
            );
            const bound = stored
                ? this.storedFieldValue(receiver.cpp, stored)
                : hoisted?.get(source);
            if (bound) {
                fields[source] = bound;
            }
        }
        const typeArguments = type
            ? this.context.dataTypes.typeArgumentsOf(declaration, type)
            : undefined;
        const accessors = classAccessors(members);
        // A receiver narrowed from a wider one keeps only its own candidates.
        const base = writable<Value>({ ...receiver });
        delete base.classCandidates;
        return valueForKind("record", {
            ...base,

            recordProperties: fields,
            recordGetters: accessors.getters,
            recordSetters: accessors.setters,
            classDeclaration: declaration,
            ...(candidates ? { classCandidates: candidates } : {}),
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
        // An argument a later one touches the storage of, either one
        // writing it, is evaluated where JavaScript evaluates it (see
        // `evaluation-order.ts`).
        const ordered =
            this.context.evaluationOrder.operandsToPin(argumentList);
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
            const value = this.context.bindings.settleBuiltValue(
                this.context.compileClassParameterValue(
                    parameter.name,
                    argument,
                ),
                (built) =>
                    this.context.evaluationOrder.calleeChanges(
                        built,
                        declaration,
                    ),
            );
            return ordered[index] && value.kind !== "callback"
                ? pinOperand(this.context, value, argument, "class_argument")
                : value;
        });
    }

    /**
     * Compiles a method with `this` bound to its constructed instance.
     *
     * The method is the one the receiver's class resolves the name to
     * through its chain. A stored receiver typed as a base class can be an
     * instance of several classes; when they resolve the name to different
     * overrides, each runs on its own tag.
     */
    public compileMethodCall(
        instance: Value,
        methodName: string,
        call: ts.CallExpression,
        declaration: ts.ClassDeclaration,
    ): Value {
        const dispatched = this.dispatch(
            instance,
            (table) => classMethod(table, methodName),
            (receiver) =>
                this.compileMethodCall(
                    receiver,
                    methodName,
                    call,
                    receiver.classDeclaration!,
                ),
            call,
            ts.isExpressionStatement(call.parent)
                ? undefined
                : this.context.checker.getTypeAtLocation(call),
        );
        if (dispatched) return dispatched;
        return this.compileResolvedMethodCall(
            instance,
            classMethod(this.table(declaration), methodName),
            methodName,
            call,
            declaration,
        );
    }

    /**
     * `super.name(...)`: the method the enclosing class's base resolves the
     * name to, run on the current instance. `super` is never virtual.
     */
    public compileSuperMethodCall(
        call: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
    ): Value {
        const instance = this.superReceiver(call);
        const method = classMethod(instance.base, callee.name.text);
        return this.compileResolvedMethodCall(
            instance.receiver,
            method,
            callee.name.text,
            call,
            this.context.classOf(instance.receiver) ??
                instance.base.declaration,
        );
    }

    /** `super.name`: the accessor the enclosing class's base declares. */
    public compileSuperProperty(access: ts.PropertyAccessExpression): Value {
        const { receiver, base } = this.superReceiver(access);
        const getter = classAccessors(base).getters[access.name.text];
        if (!getter) {
            this.context.fail(
                access,
                `'super.${access.name.text}' reads a base class accessor; ` +
                    "fields live on the instance and read through `this`.",
            );
        }
        return this.context.compileRecordGetter(receiver, getter);
    }

    /** The instance `super` runs on and the class table its lookups start from. */
    private superReceiver(node: ts.Node): {
        receiver: Value;
        base: ClassMemberTable;
    } {
        const home = enclosingClass(node);
        const base = home ? this.table(home).base : undefined;
        if (!base) {
            this.context.fail(
                node,
                "'super' is lowered only inside a class that extends a local class.",
            );
        }
        const receiver = this.context.activeThis();
        if (!receiver?.recordProperties || receiver.classStatics) {
            this.context.fail(
                node,
                "'super' member access is lowered inside instance methods, " +
                    "accessors and constructors.",
            );
        }
        return { receiver, base };
    }

    /**
     * Lowers a getter read on a receiver that may be one of several classes
     * overriding it: once per override, on the stored tag. Undefined when
     * the getter is the one every candidate reads.
     */
    public dispatchGetter(
        owner: Value,
        accessor: ts.GetAccessorDeclaration,
        read: (receiver: Value, accessor: ts.GetAccessorDeclaration) => Value,
    ): Value | undefined {
        const name = accessor.name.getText();
        const node = accessor.name;
        const signature =
            this.context.checker.getSignatureFromDeclaration(accessor);
        return this.dispatch(
            owner,
            (table) => classAccessors(table).getters[name],
            (receiver) => {
                const selected = receiver.recordGetters?.[name];
                if (!selected) {
                    this.context.fail(
                        node,
                        `Class '${receiver.classDeclaration?.name?.text ?? "?"}' has no getter '${name}'.`,
                    );
                }
                return read(receiver, selected);
            },
            node,
            signature
                ? this.context.checker.getReturnTypeOfSignature(signature)
                : undefined,
        );
    }

    /**
     * Lowers the members a receiver of several classes reaches, once per
     * implementation its candidates resolve them to, selected by the tag the
     * shared struct stores. Each arm reads the receiver narrowed to the
     * classes it serves, so a virtual call inside the member dispatches only
     * over those. Undefined when the receiver is one class, or when every
     * candidate resolves the same implementation.
     */
    private dispatch(
        instance: Value,
        implementation: (table: ClassMemberTable) => ts.Node | undefined,
        lower: (receiver: Value) => Value,
        node: ts.Node,
        yielded: ts.Type | undefined,
    ): Value | undefined {
        const candidates = instance.classCandidates;
        if (!candidates || candidates.length < 2) return undefined;
        const groups = new EmissionMap<
            ts.Node | undefined,
            ts.ClassDeclaration[]
        >();
        for (const candidate of candidates) {
            const key = implementation(this.table(candidate));
            groups.set(key, [...(groups.get(key) ?? []), candidate]);
        }
        if (groups.size < 2) return undefined;
        const type = yielded;
        const resultType =
            !type || (type.flags & ts.TypeFlags.Void) !== 0
                ? undefined
                : (this.context.dataTypes.fromTsType(type, node) ??
                  this.context.fail(
                      node,
                      "A member several classes override yields a value " +
                          "outside the native data model, so one result " +
                          "cannot hold what each override returns.",
                  ));
        const result = resultType
            ? this.context.allocateTemporaryCppName("dispatch_result")
            : undefined;
        if (result) {
            this.context.emit(
                `${this.context.dataTypes.cppType(resultType!)} ${result}{};`,
            );
        }
        const hierarchy = this.context.dataTypes.classHierarchy;
        const tag = `${instance.cpp}->${classTagMember}`;
        const arms = [...groups.values()];
        arms.forEach((group, index) => {
            const test = group
                .map((candidate) => `${tag} == ${hierarchy.tag(candidate)}`)
                .join(" || ");
            this.context.emit(
                index === 0
                    ? `if (${test}) {`
                    : index === arms.length - 1
                      ? "} else {"
                      : `} else if (${test}) {`,
            );
            this.context.increaseIndent();
            this.context.enterRuntimeControlFlow();
            try {
                const value = lower(
                    this.narrowedReceiver(instance, group, node),
                );
                if (result) {
                    this.context.emit(
                        `${result} = ${this.context.dataLowerer.compileKnownValueForSink(
                            value,
                            resultType!,
                            node,
                        )};`,
                    );
                } else if (value.cpp) {
                    this.context.emit(
                        value.kind === "void"
                            ? `${value.cpp};`
                            : `static_cast<void>(${value.cpp});`,
                    );
                }
            } finally {
                this.context.leaveRuntimeControlFlow();
                this.context.decreaseIndent();
            }
        });
        this.context.emit("}");
        if (!result) return { kind: "void", cpp: "" };
        this.context.registerNativeTemporary(result, resultType);
        return {
            ...this.context.dataValue(result, resultType!),
            requiresExplicitDiscard: true,
        };
    }

    /**
     * Runs `work` as the inlined body of `method` on `instance`. A stored
     * instance's method that reaches itself again on another stored
     * instance recurses through run-time objects, which inlining cannot
     * unroll, so it refuses rather than expanding without end.
     */
    private inlineOnReceiver<T>(
        method: ts.MethodDeclaration,
        instance: Value,
        node: ts.Node,
        work: () => T,
    ): T {
        if (!this.isStoredInstance(instance)) return work();
        if (this.storedReceiverMethods.has(method)) {
            this.context.fail(
                node,
                `Method '${method.name.getText()}' calls itself on another ` +
                    "stored instance; recursion through run-time objects " +
                    "cannot be inlined.",
            );
        }
        this.storedReceiverMethods.add(method);
        try {
            return work();
        } finally {
            this.storedReceiverMethods.delete(method);
        }
    }

    /** Compiles the method a receiver's class resolved, with `this` bound to the receiver. */
    private compileResolvedMethodCall(
        instance: Value,
        method: ts.MethodDeclaration | undefined,
        methodName: string,
        call: ts.CallExpression,
        declaration: ts.ClassDeclaration,
    ): Value {
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
        if (
            this.context.options.workers &&
            method.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
            )
        ) {
            const arguments_ = this.compileClassArguments(
                method,
                call.arguments,
                "method",
            );
            const previousThis = this.context.activeThis();
            this.context.defineThis(instance);
            try {
                return this.context.compileAsyncCall(method, arguments_, call)!;
            } finally {
                this.context.defineThis(previousThis);
            }
        }
        const activeRecursive = this.activeRecursiveMethods.get(method);
        if (activeRecursive) {
            const overReceiver =
                activeRecursive.overReceiver && this.isStoredInstance(instance);
            if (!overReceiver && activeRecursive.instance !== instance) {
                this.context.fail(
                    call,
                    `Recursive method '${methodName}' cannot switch class instances.`,
                );
            }
            return this.compileRecursiveInvocation(
                call,
                activeRecursive.cppName,
                activeRecursive.binding,
                activeRecursive.parameters,
                activeRecursive.returnType,
                overReceiver ? instance.cpp : undefined,
            );
        }
        // A method whose reached fields, parameters, and return all map
        // into the plain-data model emits once as a namespace function
        // over field reference channels; anything that does not cleanly
        // qualify keeps the per-call-site inline lowering below.
        const nativeMethod = this.context.nativeFunctions.tryCompileMethodCall(
            call,
            method,
            declaration,
            instance,
        );
        if (nativeMethod) {
            return nativeMethod;
        }
        const signature =
            this.context.checker.getSignatureFromDeclaration(method);
        const checkerReturn = signature
            ? this.context.checker.getReturnTypeOfSignature(signature)
            : undefined;
        const effectiveReturn =
            checkerReturn &&
            method.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
            )
                ? (this.context.checker.getAwaitedType(checkerReturn) ??
                  checkerReturn)
                : checkerReturn;
        const returnsVoid =
            !effectiveReturn ||
            (effectiveReturn.flags & ts.TypeFlags.Void) !== 0;
        // A function argument is bound at generation, so the shared body is
        // specialized per callback like any other captured argument.
        const sharedBody =
            method.parameters.every(
                (parameter) =>
                    ts.isIdentifier(parameter.name) &&
                    !parameter.dotDotDotToken,
            ) && this.context.canShareFunctionBody(method.body);
        const mappedReturnType = returnsVoid
            ? undefined
            : sharedBody
              ? this.context.dataTypes.fromSharedReturnType(
                    effectiveReturn,
                    method,
                )
              : this.context.dataTypes.fromTsType(effectiveReturn, method);
        const returnType =
            mappedReturnType?.kind === "struct"
                ? this.context.dataTypes.markStoredObjectReferences(
                      mappedReturnType,
                  )
                : mappedReturnType
                  ? this.context.dataTypes.ownReturnedArray(mappedReturnType)
                  : undefined;
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
                const nullableRecord = this.compileGuardedNullableRecordMethod(
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
            this.context.bindings.pushScope(
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
                const result = this.inlineOnReceiver(
                    method,
                    instance,
                    call,
                    () => {
                        for (const statement of leading) {
                            this.context.emitStatement(statement);
                        }
                        return this.context.compileValue(
                            finalStatement.expression!,
                        );
                    },
                );
                return {
                    ...result,
                    requiresExplicitDiscard: true,
                };
            } finally {
                this.context.defineThis(previousThis);
                this.context.bindings.popScope();
            }
        }
        if (
            this.methodRecurses(declaration, method, instance.classCandidates)
        ) {
            return this.compileRecursiveMethod(
                instance,
                methodName,
                call,
                method,
                returnType,
                false,
            );
        }
        if (
            this.isStoredInstance(instance) &&
            this.recursesThroughReceivers(declaration, method)
        ) {
            return this.compileRecursiveMethod(
                instance,
                methodName,
                call,
                method,
                returnType,
                true,
            );
        }
        const shared =
            sharedBody &&
            (!returnType ||
                !this.context.dataTypes.carriesFunction(returnType));
        const argumentValues = this.compileClassArguments(
            method,
            call.arguments,
            "method",
        );
        if (shared) {
            const previousThis = this.context.activeThis();
            this.context.defineThis(instance);
            try {
                const result = this.inlineOnReceiver(
                    method,
                    instance,
                    call,
                    () =>
                        this.context.compileSharedMethod(
                            method,
                            call,
                            argumentValues,
                        ),
                );
                if (result) return result;
            } finally {
                this.context.defineThis(previousThis);
            }
        }
        this.context.bindings.pushScope(
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
            const needsFunctionScope =
                !returnsVoid ||
                firstReturn(method.body.statements) !== undefined;
            this.context.emit(
                returnsVoid
                    ? needsFunctionScope
                        ? "[&]() -> void {"
                        : "{"
                    : `[[maybe_unused]] auto ${result} = [&]() -> ${this.context.dataTypes.cppType(returnType!)} {`,
            );
            this.context.increaseIndent();
            this.context.beginNativeFunctionBody(returnType);
            try {
                this.inlineOnReceiver(method, instance, call, () => {
                    for (const statement of method.body!.statements) {
                        this.context.emitStatement(statement);
                    }
                });
            } finally {
                this.context.endNativeFunctionBody();
                this.context.decreaseIndent();
            }
            this.context.emit(needsFunctionScope ? "}();" : "}");
            if (result)
                this.context.registerNativeTemporary(result, returnType);
            return result
                ? {
                      ...this.context.dataValue(result, returnType!),
                      requiresExplicitDiscard: true,
                  }
                : { kind: "void", cpp: "" };
        } finally {
            this.context.defineThis(previousThis);
            this.context.bindings.popScope();
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
            this.compileClassArguments(setter, [value], "setter")[0]!;
        const name = setter.name.getText();
        const dispatched = this.dispatch(
            instance,
            (table) => classAccessors(table).setters[name],
            (receiver) => {
                const selected = receiver.recordSetters?.[name];
                if (!selected) {
                    this.context.fail(
                        value,
                        `Class '${receiver.classDeclaration?.name?.text ?? "?"}' has no setter '${name}'.`,
                    );
                }
                this.compileSetter(receiver, selected, value, argumentValue);
                return { kind: "void", cpp: "" };
            },
            value,
            undefined,
        );
        if (dispatched) return;
        this.context.bindings.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        const previousThis = this.context.activeThis();
        this.context.defineThis(instance);
        try {
            this.bindParameters(setter, [value], undefined, false, [
                argumentValue,
            ]);
            const needsFunctionScope =
                firstReturn(setter.body.statements) !== undefined;
            this.context.emit(needsFunctionScope ? "[&]() -> void {" : "{");
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
            this.context.emit(needsFunctionScope ? "}();" : "}");
        } finally {
            this.context.defineThis(previousThis);
            this.context.bindings.popScope();
        }
    }

    /** The recursive groups whose bodies are being emitted, by callable. */
    public activeRecursion(): readonly string[] {
        return [...this.activeRecursiveMethods.values()].map(
            (group) => group.cppName,
        );
    }

    /**
     * Emit one native callable for a plain-data class recursion.
     *
     * A method that reaches itself through `this` closes over its one
     * instance. One that reaches itself through other stored instances -- a
     * tree's `sum()` over its children -- takes its receiver as the first
     * argument, so every instance runs the one callable; its body reads the
     * receiver as each class that resolves the method to this declaration.
     */
    private compileRecursiveMethod(
        instance: Value,
        methodName: string,
        call: ts.CallExpression,
        method: ts.MethodDeclaration,
        returnType: DataType | undefined,
        overReceiver: boolean,
    ): Value {
        const parameters = method.parameters.map((parameter) => {
            if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) {
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
            return {
                declaration: parameter,
                identifier: parameter.name,
                type,
                borrowedWrapper: borrowsReferenceParameter(
                    this.context,
                    parameter.name,
                    type,
                ),
            };
        });
        if (returnType && this.context.dataTypes.carriesHandle(returnType)) {
            this.context.fail(
                method,
                `Recursive method '${methodName}' must return plain data or void.`,
            );
        }

        const receiverType = overReceiver ? instance.dataType : undefined;
        const receiverClasses =
            receiverType?.kind === "struct"
                ? this.receiverClasses(receiverType.name, method)
                : undefined;
        const specialization = this.emittedRecursiveMethods.key(
            this.context.functionEmissionScope(),
            [
                receiverClasses ?? instance,
                functionDependencies(this.context, [method]),
            ],
        );
        const receiverCpp = receiverClasses ? instance.cpp : undefined;
        const previous = this.emittedRecursiveMethods.get(
            method,
            specialization,
        );
        if (previous)
            return this.compileRecursiveInvocation(
                call,
                previous.cpp,
                previous.binding,
                parameters,
                returnType,
                receiverCpp,
            );
        const prefix = this.context.allocateUserFunctionPrefix();
        const cppName = `${prefix}recursive_method`;
        const self = `${prefix}recursive_self`;
        const receiver = `${prefix}receiver`;
        if (receiverType) {
            this.context.registerNativeBindingType(
                receiver,
                `const ${this.context.dataTypes.cppType(receiverType)}`,
            );
            this.context.registerNativeConstBinding(receiver, true);
        }
        const body =
            receiverType?.kind === "struct" && receiverClasses
                ? this.receiverRecord(
                      {
                          ...this.context.dataValue(receiver, receiverType),
                          nativeLvalue: true,
                      },
                      this.context.dataTypes.classHierarchy.commonClass(
                          receiverClasses,
                      ),
                      receiverClasses.length > 1 ? receiverClasses : undefined,
                      this.context.dataTypes.classStruct(receiverType.name)
                          ?.type,
                  )
                : instance;
        const returnCpp = returnType
            ? this.context.dataTypes.cppType(returnType)
            : "void";
        const cppParameters = parameters.map(
            ({ declaration, identifier, type, borrowedWrapper }, index) => {
                const cppType = this.context.dataTypes.cppType(type);
                const readOnly = parameterIsReadOnly(
                    this.context.checker,
                    method,
                    identifier,
                );
                const typeCpp =
                    passesByReference(this.context.dataTypes, type) ||
                    borrowedWrapper
                        ? `${readOnly || borrowedWrapper ? "const " : ""}${cppType}&`
                        : cppType;
                return {
                    name: `${prefix}arg_${index}`,
                    typeCpp,
                    declaration,
                    identifier,
                    type,
                    readOnly,
                    borrowedWrapper,
                };
            },
        );
        const lambdaParameters = [
            `[[maybe_unused]] auto& ${self}`,
            ...(receiverType
                ? [
                      `[[maybe_unused]] const ${this.context.dataTypes.cppType(receiverType)}& ${receiver}`,
                  ]
                : []),
            ...cppParameters.map(({ name, typeCpp }) => `${typeCpp} ${name}`),
        ];
        this.context.emit(
            `auto ${cppName} = bbl::js::make_recursive_group([&](${lambdaParameters.join(", ")}) -> ${returnCpp} {`,
        );
        this.context.increaseIndent();
        this.context.bindings.pushScope(prefix);
        const previousThis = this.context.activeThis();
        this.context.defineThis(body);
        this.activeRecursiveMethods.set(method, {
            instance: body,
            cppName: `${self}.template call<0>`,
            parameters,
            returnType,
            overReceiver,
            binding: this.context.registerNativeBinding(self, true, true),
        });
        this.context.beginNativeFunctionBody(returnType);
        try {
            for (const parameter of cppParameters) {
                if (parameter.borrowedWrapper)
                    this.context.registerNativeConstBinding(
                        parameter.name,
                        true,
                    );
                this.context.bindings.bindParameterValue(parameter.identifier, {
                    ...this.context.dataValue(parameter.name, parameter.type),
                    ...(parameter.readOnly ? { readOnly: true as const } : {}),
                });
            }
            for (const statement of method.body!.statements) {
                this.context.emitStatement(statement);
            }
        } finally {
            this.context.endNativeFunctionBody();
            this.activeRecursiveMethods.delete(method);
            this.context.defineThis(previousThis);
            this.context.bindings.popScope();
            this.context.decreaseIndent();
        }
        this.context.emit("});");
        const group = {
            cpp: `${cppName}.template call<0>`,
            binding: this.context.registerNativeBinding(cppName, true, true),
        };
        this.emittedRecursiveMethods.set(method, specialization, group);
        return this.compileRecursiveInvocation(
            call,
            group.cpp,
            group.binding,
            parameters,
            returnType,
            receiverCpp,
        );
    }

    /**
     * The concrete classes a stored struct holds that resolve `method`'s
     * name to `method` itself: every receiver a receiver-form recursion can
     * be called on.
     */
    private receiverClasses(
        structName: string,
        method: ts.MethodDeclaration,
    ): ts.ClassDeclaration[] {
        const stored = this.context.dataTypes.classStruct(structName);
        const hierarchy = this.context.dataTypes.classHierarchy;
        const name = method.name.getText();
        return stored
            ? hierarchy
                  .concreteClasses(stored.declaration)
                  .filter(
                      (candidate) =>
                          classMethod(this.table(candidate), name) === method,
                  )
            : [];
    }

    /** Whether an instance is a stored object: a `Ref` rather than a compile-time record. */
    private isStoredInstance(instance: Value): boolean {
        return (
            instance.dataType?.kind === "struct" &&
            this.context.dataTypes.isClassStruct(instance.dataType.name)
        );
    }

    /**
     * Whether `method` reaches itself through a receiver other than `this`
     * -- a call written on another instance, directly or in a callback its
     * body passes on, through the `this` methods it calls, or through the
     * methods it calls on other instances of local classes.
     */
    private recursesThroughReceivers(
        declaration: ts.ClassDeclaration,
        method: ts.MethodDeclaration,
    ): boolean {
        const table = this.table(declaration);
        const hierarchy = this.context.dataTypes.classHierarchy;
        const explored = new EmissionSet<ts.MethodDeclaration>();
        const reaches = (candidate: ts.MethodDeclaration): boolean => {
            if (explored.has(candidate) || !candidate.body) return false;
            explored.add(candidate);
            return someAnalysisNode(candidate.body, (node) => {
                if (
                    !ts.isCallExpression(node) ||
                    !ts.isPropertyAccessExpression(node.expression)
                )
                    return false;
                if (
                    node.expression.expression.kind ===
                    ts.SyntaxKind.ThisKeyword
                ) {
                    const called = classMethod(
                        table,
                        node.expression.name.text,
                    );
                    return called !== undefined && reaches(called);
                }
                const called =
                    this.context.checker.getResolvedSignature(
                        node,
                    )?.declaration;
                if (
                    node.expression.expression.kind ===
                    ts.SyntaxKind.SuperKeyword
                )
                    return (
                        called !== undefined &&
                        ts.isMethodDeclaration(called) &&
                        reaches(called)
                    );
                if (!called || !ts.isMethodDeclaration(called)) return false;
                // Another instance runs one of the implementations its
                // class resolves, which may come back to `method`.
                const implementations = hierarchy.implementations(called);
                return (
                    called === method ||
                    (implementations?.some(
                        (implementation) =>
                            implementation === method ||
                            (implementation !== undefined &&
                                reaches(implementation)),
                    ) ??
                        false)
                );
            });
        };
        return reaches(method);
    }

    private compileRecursiveInvocation(
        call: ts.CallExpression,
        cppName: string,
        binding: NativeCaptureBinding,
        parameters: readonly {
            declaration: ts.ParameterDeclaration;
            type: DataType;
            borrowedWrapper: boolean;
        }[],
        returnType: DataType | undefined,
        receiverCpp?: string,
    ): Value {
        if (call.arguments.length > parameters.length) {
            this.context.fail(
                call,
                "Recursive method received too many arguments.",
            );
        }
        const argumentsCpp = parameters.map(
            ({ declaration, type, borrowedWrapper }, index) => {
                const argument =
                    call.arguments[index] ?? declaration.initializer;
                if (!argument) {
                    this.context.fail(
                        call,
                        `Recursive method argument ${index + 1} is required.`,
                    );
                }
                if (borrowedWrapper) {
                    const rawValue =
                        this.context.dataLowerer.compileDataPath(
                            argument,
                            "read",
                        ) ?? this.context.compileValue(argument);
                    const value =
                        rawValue.kind === "data"
                            ? this.context.dataLowerer.narrowOptional(
                                  rawValue,
                                  argument,
                              )
                            : rawValue;
                    if (
                        value.kind === "data" &&
                        value.dataType &&
                        dataTypesEqual(value.dataType, type)
                    ) {
                        return this.context.bindings.pinValueToTemporary(
                            value,
                            "function_argument",
                            argument,
                        ).cpp;
                    }
                }
                return this.context.compileForDataSink(argument, type);
            },
        );
        const invocation = `${cppName}(${[
            ...(receiverCpp === undefined ? [] : [receiverCpp]),
            ...argumentsCpp,
        ].join(", ")})`;
        // A closure calling the group names it, so it captures the group.
        const value: Value = returnType
            ? {
                  ...this.context.dataValue(invocation, returnType),
                  requiresExplicitDiscard: true,
                  nativeCaptures: [binding],
              }
            : { kind: "void", cpp: invocation, nativeCaptures: [binding] };
        this.context.useNativeValue(value);
        return value;
    }

    /**
     * Whether `method` reaches itself through calls on `this`. A call
     * resolves through the receiver's classes -- each candidate of a stored
     * receiver read as a base class -- as it would run.
     */
    private methodRecurses(
        declaration: ts.ClassDeclaration,
        method: ts.MethodDeclaration,
        candidates: readonly ts.ClassDeclaration[] = [declaration],
    ): boolean {
        const exact = candidates.length === 1;
        const cache =
            this.recursiveMethods.get(declaration) ??
            new EmissionMap<ts.MethodDeclaration, boolean>();
        const cached = exact ? cache.get(method) : undefined;
        if (cached !== undefined) return cached;
        const tables = candidates.map((candidate) => this.table(candidate));
        const callees = (
            candidate: ts.MethodDeclaration,
        ): ts.MethodDeclaration[] => {
            const found = new EmissionSet<ts.MethodDeclaration>();
            const visit = (node: ts.Node): void => {
                if (node !== candidate && ts.isFunctionLike(node)) return;
                if (
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.expression.kind ===
                        ts.SyntaxKind.ThisKeyword
                ) {
                    for (const table of tables) {
                        const called = classMethod(
                            table,
                            node.expression.name.text,
                        );
                        if (called?.body) found.add(called);
                    }
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
                (called) => called === method || reachesStart(called),
            );
        };
        const recursive = reachesStart(method);
        if (exact) {
            cache.set(method, recursive);
            this.recursiveMethods.set(declaration, cache);
        }
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
            !guardedStatements[0].expression ||
            this.context.unwrap(guardedStatements[0].expression).kind !==
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
        this.context.bindings.pushScope(
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
            this.context.bindings.pushScope(
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
                    const value = success.recordProperties?.[descriptor.name];
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
                        writable(output).engineCpp = value.engineCpp;
                    }
                }
            } finally {
                this.context.bindings.popScope();
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
            this.context.bindings.popScope();
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
                    const symbol = declaredSymbol(this.context.checker, spread);
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
            const argument = argumentList[index] ?? parameter.initializer;
            const evaluatedArgument =
                index < argumentList.length
                    ? evaluatedArguments?.[index]
                    : undefined;
            if (!argument) {
                if (parameter.questionToken) {
                    const parameterType = this.context.dataTypes.fromTsType(
                        this.context.checker.getTypeAtLocation(parameter),
                        parameter,
                    );
                    if (parameterType?.kind === "optional") {
                        this.context.bindings.bindParameterValue(
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
                        this.context.bindings.bindParameterValue(
                            parameter.name,
                            this.context.dataValue(
                                `${this.context.dataTypes.cppType(parameterType)}{}`,
                                parameterType,
                            ),
                        );
                    } else {
                        this.context.bindings.bindParameterValue(
                            parameter.name,
                            {
                                kind: "json-null",
                                cpp: "",
                            },
                        );
                    }
                    if (
                        parameterProperties &&
                        ts.isParameterPropertyDeclaration(
                            parameter,
                            declaration,
                        )
                    ) {
                        this.initializeParameterProperty(
                            parameter.name,
                            parameterProperties,
                        );
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
            const parameterSymbol = declaredSymbol(
                this.context.checker,
                parameter.name,
            );
            const spreadUse =
                parameterSymbol !== undefined &&
                spreadParameters.has(parameterSymbol);
            const staticRecord =
                evaluatedArgument?.kind === "record"
                    ? evaluatedArgument
                    : preserveStaticRecords || spreadUse
                      ? this.context.compileValue(argument)
                      : undefined;
            if (staticRecord?.kind === "record") {
                this.context.bindings.bindParameterValue(
                    parameter.name,
                    staticRecord,
                );
            } else if (evaluatedArgument) {
                this.context.bindings.bindParameterValue(
                    parameter.name,
                    evaluatedArgument,
                );
            } else {
                this.context.bindClassParameterValue(parameter.name, argument);
            }
            if (
                parameterProperties &&
                ts.isParameterPropertyDeclaration(parameter, declaration)
            ) {
                this.initializeParameterProperty(
                    parameter.name,
                    parameterProperties,
                );
            }
        });
    }

    private initializeParameterProperty(
        name: ts.Identifier,
        properties: Record<string, Value>,
    ): void {
        const stored = properties[name.text];
        if (stored?.classStoredField) {
            this.context.emit(
                `${stored.cpp} = ${this.context.compileForDataSink(name, stored.dataType!)};`,
            );
        } else {
            writable(properties)[name.text] = this.context.compileValue(name);
        }
    }

    /**
     * The receiver `owner.name = value` runs a class setter on when the owner
     * is a stored instance: hydrated, so its class's setter -- or each
     * override of it -- runs. Undefined when `name` is no class setter or the
     * owner is not a stored instance, leaving nothing emitted.
     */
    public storedSetterOwner(
        target: ts.PropertyAccessExpression,
    ): Value | undefined {
        const setter = resolvedSymbol(
            this.context.checker,
            target,
        )?.declarations?.some(
            (declaration) =>
                ts.isSetAccessorDeclaration(declaration) &&
                ts.isClassDeclaration(declaration.parent) &&
                !declaration.getSourceFile().isDeclarationFile,
        );
        const stored =
            setter &&
            this.context.dataTypes.existingClassStruct(
                this.context.checker.getNonNullableType(
                    this.context.checker.getTypeAtLocation(target.expression),
                ),
            );
        if (!stored) return undefined;
        return this.context.probeEmission(() => {
            const hydrated = this.hydrate(
                this.context.compileValue(target.expression),
                target.expression,
            );
            return hydrated?.recordSetters?.[target.name.text]
                ? hydrated
                : undefined;
        });
    }

    /**
     * The method a structural view of a class instance binds for `name`: the
     * one its class resolves through the chain. A receiver of several classes
     * that override it differently has no single function to bind.
     */
    public viewMethod(
        value: Value,
        name: string,
        node: ts.Node,
    ): ts.MethodDeclaration | undefined {
        const declaration = value.classDeclaration;
        if (!declaration) return undefined;
        const methods = new Set(
            (value.classCandidates ?? [declaration]).map((candidate) =>
                classMethod(this.table(candidate), name),
            ),
        );
        if (methods.size > 1) {
            this.context.fail(
                node,
                `A structural view binds '${name}' once, but the classes this ` +
                    "instance can be override it differently.",
            );
        }
        return [...methods][0];
    }

    /**
     * `value instanceof declaration` for a class instance, as a C++
     * condition: settled at generation when the instance's class is known,
     * a test of the stored tag when it is one of several, and false for an
     * empty stored reference. Undefined when `value` is no class instance.
     */
    public instanceOf(
        value: Value,
        declaration: ts.ClassDeclaration,
        node: ts.Expression,
    ): string | undefined {
        const structName =
            value.kind === "data" && value.dataType?.kind === "struct"
                ? value.dataType.name
                : undefined;
        if (
            structName &&
            this.context.dataTypes.isClassStruct(structName) &&
            !this.context.dataTypes.classStructTagged(structName)
        ) {
            const stored = this.context.dataTypes.classStruct(structName)!;
            return classExtends(this.table(stored.declaration), declaration)
                ? `static_cast<bool>(${value.cpp})`
                : "false";
        }
        const record = this.hydrate(value, node) ?? value;
        if (record.kind !== "record" || !record.classDeclaration)
            return undefined;
        const candidates = record.classCandidates ?? [record.classDeclaration];
        const matching = candidates.filter((candidate) =>
            classExtends(this.table(candidate), declaration),
        );
        const stored =
            record.dataType?.kind === "struct" &&
            this.context.dataTypes.isClassStruct(record.dataType.name);
        if (matching.length === 0) return "false";
        const tested =
            matching.length === candidates.length
                ? undefined
                : `(${matching
                      .map(
                          (candidate) =>
                              `${record.cpp}->${classTagMember} == ` +
                              `${this.context.dataTypes.classHierarchy.tag(candidate)}`,
                      )
                      .join(" || ")})`;
        if (!stored) return tested ?? "true";
        const present = `static_cast<bool>(${record.cpp})`;
        return tested ? `(${present} && ${tested})` : present;
    }

    /**
     * `#name in value`: whether `value` carries the brand the class declaring
     * `#name` installs on every instance it -- or a subclass -- constructs.
     * A static private name brands the class itself.
     */
    public compileBrandCheck(expression: ts.BinaryExpression): string {
        const name = expression.left as ts.PrivateIdentifier;
        const member = resolvedSymbol(
            this.context.checker,
            name,
        )?.declarations?.find(ts.isClassElement);
        const owner = member?.parent;
        if (!member || !owner || !ts.isClassDeclaration(owner)) {
            this.context.fail(
                name,
                `Private name '${name.text}' does not resolve to a class member.`,
            );
        }
        const value = this.context.compileValue(expression.right);
        if (isStaticMember(member)) {
            if (value.kind === "record") {
                return value.classStatics === owner ? "true" : "false";
            }
        } else {
            if (value.classStatics) return "false";
            const branded = this.instanceOf(value, owner, expression.right);
            if (branded !== undefined) return branded;
            if (value.kind === "record") return "false";
        }
        this.context.fail(
            expression,
            `The brand check '${name.text} in ...' is decided for class ` +
                "instances and records; this value has no represented class.",
        );
    }

    private rejectUnsupportedMembers(declaration: ts.ClassDeclaration): void {
        const chain = classChain(this.table(declaration));
        const privateNames = new Map<string, ts.ClassDeclaration>();
        for (const link of chain) {
            if (link.unsupportedHeritage) {
                this.context.fail(
                    link.unsupportedHeritage,
                    `Class '${link.declaration.name?.text ?? "?"}' extends ` +
                        `'${link.unsupportedHeritage.expression.getText()}', ` +
                        "which is not a local class with a body; only " +
                        "inheritance between local classes is lowered.",
                );
            }
            for (const member of link.declaration.members) {
                if (
                    isStaticMember(member) &&
                    (ts.isGetAccessorDeclaration(member) ||
                        ts.isSetAccessorDeclaration(member))
                ) {
                    this.context.fail(
                        member,
                        "Static class accessors are outside the supported subset.",
                    );
                }
            }
            // One record holds the fields of the whole chain by name, and a
            // private name is private to the class that declares it: two
            // classes of one chain may each declare `#x`, which that record
            // could not keep apart.
            for (const [name, node] of declaredPrivateNames(link.declaration)) {
                const other = privateNames.get(name);
                if (other && other !== link.declaration) {
                    this.context.fail(
                        node,
                        `Private name '${name}' is declared by both ` +
                            `'${link.declaration.name?.text ?? "?"}' and ` +
                            `'${other.name?.text ?? "?"}'; the instance ` +
                            "record cannot keep the two apart.",
                    );
                }
                privateNames.set(name, link.declaration);
            }
        }
    }
}
