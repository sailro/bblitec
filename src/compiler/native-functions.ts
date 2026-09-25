import {
    someAnalysisNode,
    findAnalysisNodeWithState,
} from "./analysis-walk.js";
import { EmissionSet, EmissionMap } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import ts from "typescript";
import { CompileError } from "./compile-error.js";
import {
    expressionMayRunCode,
    isAssignmentExpression,
    isUpdateExpression,
    unwrapExpression,
} from "./syntax.js";
import { emitReachableStatements } from "./loop-control.js";
import { arrayReturnStorage } from "./array-return-storage.js";
import { cppIdentifier, cppIdentifierPattern } from "../cpp-literals.js";
import {
    declaredSymbol,
    isNullishLiteral,
    libraryGlobal,
    resolvedSymbol,
} from "./symbols.js";
import {
    dataTypesEqual,
    isTypedArrayType,
    passesByReference,
    type DataType,
} from "./data-types.js";
import { MATH_MEMBERS, mathMemberCall } from "./math-intrinsics.js";
import { classMemberTable, classMethod } from "./class-members.js";
import type { Value } from "./types.js";
import {
    borrowsReferenceParameter,
    isSupportedFunction,
    parameterIsReadOnly,
    requiresDefaultParameterBinding,
    resolveFunctionDeclaration,
    type SupportedFunction,
} from "./user-functions.js";

export interface NativeFunctionContext extends Pick<
    LoweringServices,
    | "allocateTemporaryCppName"
    | "canReplaySharedCallEffects"
    | "checker"
    | "evaluationOrder"
    | "dataTypes"
    | "dataLowerer"
    | "sourceFiles"
    | "knownValueWithoutEvaluation"
    | "browserErasure"
    | "classOf"
    | "compileValue"
    | "probeEmission"
    | "useNativeValue"
    | "compileNumber"
    | "conditions"
    | "emitStatement"
    | "statementTerminatesAfterLowering"
    | "bindings"
    | "allocateUserFunctionPrefix"
    | "captureEmittedLines"
    | "nativeEmission"
    | "registerNativeTemporary"
    | "registerNativeBinding"
    | "registerNativeBindingType"
    | "registerNativeConstBinding"
    | "identifierIsRebound"
    | "beginNativeFunctionBody"
    | "endNativeFunctionBody"
    | "reachJsData"
    | "unwrap"
    | "emit"
    | "defineThis"
    | "activeThis"
    | "registerClassInstance"
    | "fail"
> {}

interface DataFunctionParameter {
    name: ts.Identifier;
    type: DataType;
    byReference: boolean;
    readOnly: boolean;
    borrowedWrapper: boolean;
}

interface NativeFunctionSignature {
    cppName: string;
    parameters: DataFunctionParameter[];
    returnType: DataType | undefined;
    declaration: SupportedFunction;
}

/**
 * One instance field a once-emitted method reaches. A class instance is a
 * compile-time record whose data fields are disjoint native locals, so the
 * emitted function takes each reached field as a mutable reference channel
 * and the call site passes that instance's field local. Passing every
 * channel mutably is always sound: the reference aliases the one object
 * JavaScript would alias, and constness would only document intent.
 */
interface MethodFieldChannel {
    readonly name: string;
    readonly type: DataType;
}

interface NativeMethodSignature {
    cppName: string;
    fields: MethodFieldChannel[];
    parameters: DataFunctionParameter[];
    returnType: DataType | undefined;
    method: ts.MethodDeclaration;
    classDeclaration: ts.ClassDeclaration;
    getters: Record<string, ts.GetAccessorDeclaration>;
}

/** The member shapes the method-closure body checks walk. */
type EligibleMember = SupportedFunction | ts.GetAccessorDeclaration;

/** The same-class members one method's emitted body can reach. */
interface MethodClosure {
    readonly methods: ReadonlySet<ts.MethodDeclaration>;
    readonly getters: ReadonlySet<ts.GetAccessorDeclaration>;
    readonly fieldNames: ReadonlySet<string>;
}

/**
 * Whether a class-field binding still is exactly the leaf value its native
 * storage was declared with. Any extra compile-time knowledge on the value
 * (a folded literal, optional resource storage, an engine binding, record
 * structure) means the inline path may treat reads of that field
 * differently from live native storage, so the method declines to the
 * inline path for that instance.
 */
function valueIsPlainLeaf(actual: Value, expected: Value): boolean {
    const actualRecord = actual as unknown as Record<string, unknown>;
    const expectedRecord = expected as unknown as Record<string, unknown>;
    const keys = new EmissionSet([
        ...Object.keys(actualRecord),
        ...Object.keys(expectedRecord),
    ]);
    for (const key of keys) {
        if (
            key === "dataType" ||
            key === "nativeLvalue" ||
            key === "sharedStorageCpp" ||
            key === "nativeCaptures" ||
            key === "nativeCompanionCaptures" ||
            key === "collectionCardinality"
        )
            continue;
        if (actualRecord[key] !== expectedRecord[key]) {
            return false;
        }
    }
    return (
        actual.dataType !== undefined &&
        expected.dataType !== undefined &&
        dataTypesEqual(actual.dataType, expected.dataType)
    );
}

/**
 * Binds one plain-data function signature and captures its lowered body.
 * Namespace functions, local recursive lambdas, and once-emitted class
 * methods differ only in the C++ declaration wrapped around this shared
 * body protocol — and, for methods, in the two optional hooks: leading
 * reference-channel declarations bound inside the scope before the
 * parameters, and a `this` binding installed after them, just before the
 * body is captured.
 */
export function captureDataFunctionBody(
    context: NativeFunctionContext,
    parameters: readonly DataFunctionParameter[],
    returnType: DataType | undefined,
    emitBody: () => void,
    channels?: {
        /** Runs inside the pushed scope before parameter binding; returns
         *  the leading parameter declarations (a method's field channels). */
        bindLeading?: () => string[];
        /** Runs after parameter binding, before the body capture (a
         *  method's synthetic `this` record). */
        beforeBody?: () => void;
        /** The definition is emitted at namespace scope. */
        namespaceScope?: boolean;
    },
): { parameterDeclarations: string[]; lines: string[] } {
    context.bindings.pushScope(context.allocateUserFunctionPrefix());
    try {
        const parameterDeclarations = [
            ...(channels?.bindLeading?.() ?? []),
            ...parameters.map((parameter) => {
                const cppName = context.bindings.cppIdentifier(
                    parameter.name.text,
                );
                const cppType = context.dataTypes.cppType(parameter.type);
                context.registerNativeBindingType(
                    cppName,
                    `${parameter.byReference && parameter.readOnly ? "const " : ""}${cppType}`,
                );
                if (parameter.borrowedWrapper)
                    context.registerNativeConstBinding(cppName, true);
                context.bindings.defineVariable(parameter.name, {
                    ...context.dataLowerer.leafValue(cppName, parameter.type),
                    ...(parameter.readOnly ? { readOnly: true as const } : {}),
                });
                if (
                    parameter.type.kind !== "number" &&
                    parameter.type.kind !== "boolean"
                ) {
                    context.dataLowerer.registerLocal(cppName, "owned");
                }
                return parameter.byReference
                    ? `${parameter.readOnly ? "const " : ""}${cppType}& ${cppName}`
                    : `${cppType} ${cppName}`;
            }),
        ];
        channels?.beforeBody?.();
        context.beginNativeFunctionBody(
            returnType,
            false,
            channels?.namespaceScope ? { namespaceScope: true } : {},
        );
        try {
            return {
                parameterDeclarations,
                lines: context.dataLowerer.captureStringIndexes(
                    parameters
                        .filter(
                            (parameter) =>
                                parameter.type.kind === "string" &&
                                parameter.readOnly &&
                                !parameter.byReference,
                        )
                        .map((parameter) => ({
                            cpp: context.bindings.cppIdentifier(
                                parameter.name.text,
                            ),
                            declaration: parameter.name.parent.parent,
                        })),
                    () => context.captureEmittedLines(emitBody),
                ),
            };
        } finally {
            context.endNativeFunctionBody();
        }
    } finally {
        context.bindings.popScope();
    }
}

/**
 * Emits reachable plain-data user functions as real C++ functions: every
 * parameter and the return type must map into the data model. Functions are
 * emitted once and called normally, so early returns and repeated calls are
 * native. Handle-touching helpers stay on the inline lowerer.
 */
export class NativeFunctionLowerer {
    private readonly generationTimeFetchCache = new EmissionMap<
        EligibleMember,
        boolean
    >();
    private readonly signatures = new EmissionMap<
        SupportedFunction,
        NativeFunctionSignature
    >();
    private readonly methodSignatures = new EmissionMap<
        ts.MethodDeclaration,
        NativeMethodSignature
    >();
    private readonly rejectedMethods = new EmissionSet<ts.MethodDeclaration>();
    private readonly emitted = new EmissionSet<SupportedFunction>();
    private readonly active = new EmissionSet<SupportedFunction>();
    private readonly rejected = new EmissionSet<SupportedFunction>();
    private readonly usedNames = new EmissionSet<string>();
    private readonly referenceStorageCache = new EmissionMap<string, boolean>();

    public constructor(private readonly context: NativeFunctionContext) {}

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
            (node, message) => this.context.fail(node, message),
        );
        if (!declaration) {
            return undefined;
        }
        if (
            call.arguments.some((argument) => {
                const value =
                    this.context.browserErasure.evaluateBrowserValue(argument);
                return (
                    value?.kind === "search-params" ||
                    (value?.kind === "object" && value.moduleUrl === true)
                );
            })
        )
            return undefined;
        if (
            requiresDefaultParameterBinding(
                this.context.checker,
                declaration,
                call,
            )
        )
            return undefined;
        const signature = this.resolveSignature(declaration, callee);
        if (!signature) {
            return undefined;
        }
        if (
            signature.parameters.some(
                (parameter, index) =>
                    parameter.type.kind === "union" &&
                    call.arguments[index] &&
                    (this.context.checker.getTypeAtLocation(
                        call.arguments[index],
                    ).flags &
                        (ts.TypeFlags.StringLiteral |
                            ts.TypeFlags.NumberLiteral |
                            ts.TypeFlags.BooleanLiteral)) !==
                        0,
            )
        ) {
            return undefined;
        }
        if (
            signature.returnType &&
            this.context.dataTypes.carriesFunction(signature.returnType)
        ) {
            // A closure-bearing result can capture the entry engine and any
            // locals selected while the factory runs. Keep the factory
            // specialized inline; a namespace data function has neither the
            // entry engine binding nor JavaScript closure lifetime.
            return undefined;
        }
        if (
            signature.returnType?.kind === "string" &&
            signature.parameters.every(
                (parameter) => parameter.type.kind === "string",
            ) &&
            signature.parameters.every((parameter, index) => {
                const argument =
                    call.arguments[index] ??
                    (ts.isParameter(parameter.name.parent)
                        ? parameter.name.parent.initializer
                        : undefined);
                if (!argument) return false;
                if (ts.isStringLiteralLike(argument)) return true;
                if (ts.isIdentifier(argument)) {
                    const bound =
                        this.context.bindings.lookupOptional(argument);
                    if (bound) return bound.staticString !== undefined;
                }
                return this.context.probeEmission(
                    () =>
                        this.context.compileValue(argument).staticString !==
                        undefined,
                    () => false,
                );
            })
        ) {
            // Closed string transforms retain their facts at the call site.
            // Inspect without emitting argument effects twice.
            return undefined;
        }
        if (call.arguments.some(ts.isSpreadElement)) {
            // A spread expands a compile-time tuple at the call site,
            // which is the inline lowerer's business.
            return undefined;
        }
        if (call.arguments.length > signature.parameters.length) {
            this.context.fail(
                call,
                `Function '${callee.text}' expects at most ${signature.parameters.length} plain arguments.`,
            );
        }
        if (
            signature.parameters.some(
                (parameter, index) =>
                    call.arguments[index] === undefined &&
                    ts.isParameter(parameter.name.parent) &&
                    parameter.name.parent.questionToken !== undefined &&
                    parameter.name.parent.initializer === undefined,
            )
        ) {
            // The inline path binds omitted optional parameters to undefined.
            // A native data parameter has no absent representation unless its
            // mapped type explicitly carries one.
            return undefined;
        }
        if (
            signature.parameters.some((parameter, index) => {
                if (!parameter.byReference || parameter.readOnly) {
                    return false;
                }
                const argument =
                    call.arguments[index] ??
                    (ts.isParameter(parameter.name.parent)
                        ? parameter.name.parent.initializer
                        : undefined);
                return argument ? !this.isAddressableArgument(argument) : false;
            })
        ) {
            // A conditional, constructor, or call result cannot bind to
            // the mutable native reference that preserves JavaScript
            // object aliasing. Keep that call on the inline path, where
            // the expression is evaluated into the callee's local binding.
            return undefined;
        }
        if (
            signature.parameters.some((parameter, index) => {
                const argument =
                    call.arguments[index] ??
                    (ts.isParameter(parameter.name.parent)
                        ? parameter.name.parent.initializer
                        : undefined);
                return argument
                    ? !this.argumentPreservesObjectIdentity(argument, parameter)
                    : false;
            })
        ) {
            // A structurally narrowed stored-object argument would be
            // materialized into a fresh copy by the sink conversion, so a
            // callee write or store would act on the copy. Same rule as
            // the method arm; the inline path aliases by construction.
            return undefined;
        }
        const canSpecialize = signature.parameters.some((parameter, index) => {
            const argument =
                call.arguments[index] ??
                (ts.isParameter(parameter.name.parent)
                    ? parameter.name.parent.initializer
                    : undefined);
            if (!argument) return false;
            const expression = unwrapExpression(argument);
            const value = ts.isIdentifier(expression)
                ? this.context.bindings.lookupOptional(expression)
                : undefined;
            return (
                !value ||
                value.kind === "record" ||
                value.kind === "tuple" ||
                value.staticString !== undefined ||
                value.staticNumber !== undefined ||
                value.staticBoolean !== undefined
            );
        });
        try {
            this.context.probeEmission(() => {
                this.ensureEmitted(signature.declaration, () =>
                    this.emitDefinition(signature),
                );
                return true;
            });
        } catch (error) {
            if (!(error instanceof CompileError)) throw error;
            if (
                error.reason === "entry-scope-required" ||
                error.reason === "dynamic-storage-required"
            ) {
                // The body reaches the entry's engine or stores a parsed
                // document as a record; the inliner keeps both as they are.
                this.signatures.delete(signature.declaration);
                this.rejected.add(signature.declaration);
                return undefined;
            }
            // A body may need facts unavailable to generic parameters.
            // Let specialization bind actual arguments before diagnosing it.
            if (
                canSpecialize &&
                !this.emitted.has(signature.declaration) &&
                error.reason === "static-value-required"
            )
                return undefined;
            throw error;
        }
        const ordered = this.context.evaluationOrder.operandsToPin(
            call.arguments,
        );
        const argumentsCpp = signature.parameters.map((parameter, index) => {
            const argument = call.arguments[index];
            if (!argument) {
                const initializer =
                    parameter.name.parent &&
                    ts.isParameter(parameter.name.parent)
                        ? parameter.name.parent.initializer
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
                    call.arguments,
                    index + 1,
                    signature.declaration,
                );
            }
            return this.inOrder(
                this.compileArgument(
                    argument,
                    parameter,
                    call.arguments,
                    index + 1,
                    signature.declaration,
                ),
                parameter,
                ordered[index] ?? false,
            );
        });
        const cpp = `bblscene::${signature.cppName}(${argumentsCpp.join(", ")})`;
        return this.callValue(cpp, signature.returnType);
    }

    /**
     * Compiles a call to a class-instance method through the native
     * data-function path: the method body is emitted once as a namespace
     * function whose leading parameters are mutable references to the
     * instance fields it reaches, and every call passes that instance's
     * field locals. Returns undefined whenever the method or this call
     * does not cleanly qualify — the class inliner then handles it
     * exactly as before.
     *
     * The call is hoisted into a named result local at the current
     * emission point, which is where the inline path emits the method's
     * value lambda today, so evaluation order across sibling calls in one
     * expression is unchanged.
     */
    public tryCompileMethodCall(
        call: ts.CallExpression,
        method: ts.MethodDeclaration,
        classDeclaration: ts.ClassDeclaration,
        instance: Value,
    ): Value | undefined {
        if (requiresDefaultParameterBinding(this.context.checker, method, call))
            return undefined;
        const signature = this.resolveMethodSignature(method, classDeclaration);
        if (!signature) {
            return undefined;
        }
        if (
            call.arguments.length > signature.parameters.length ||
            call.arguments.some(ts.isSpreadElement)
        ) {
            // The inline path owns the diagnostic for a malformed call.
            return undefined;
        }
        const argumentExpressions = signature.parameters.map(
            (parameter, index) =>
                call.arguments[index] ??
                (ts.isParameter(parameter.name.parent)
                    ? parameter.name.parent.initializer
                    : undefined),
        );
        if (argumentExpressions.some((argument) => argument === undefined)) {
            // An optional parameter without a default binds a null value
            // on the inline path; keep that shape there.
            return undefined;
        }
        if (
            signature.parameters.some((parameter, index) => {
                if (!parameter.byReference || parameter.readOnly) {
                    return false;
                }
                return !this.isAddressableArgument(argumentExpressions[index]!);
            })
        ) {
            return undefined;
        }
        if (
            signature.parameters.some(
                (parameter, index) =>
                    !this.argumentPreservesObjectIdentity(
                        argumentExpressions[index]!,
                        parameter,
                    ),
            )
        ) {
            return undefined;
        }
        const fieldArguments = this.instanceFieldArguments(signature, instance);
        if (!fieldArguments) {
            return undefined;
        }
        try {
            this.context.probeEmission(() => {
                this.ensureEmitted(signature.method, () =>
                    this.emitMethodDefinition(signature),
                );
                return true;
            });
        } catch (error) {
            if (
                !(error instanceof CompileError) ||
                (error.reason !== "entry-scope-required" &&
                    error.reason !== "dynamic-storage-required")
            )
                throw error;
            // The body reaches the entry's engine or stores a parsed
            // document as a record; the class inliner keeps both.
            this.methodSignatures.delete(signature.method);
            this.rejectedMethods.add(signature.method);
            return undefined;
        }
        const ordered = this.context.evaluationOrder.operandsToPin(
            argumentExpressions.map((argument) => argument!),
        );
        const argumentsCpp = signature.parameters.map((parameter, index) =>
            this.inOrder(
                this.compileArgument(
                    argumentExpressions[index]!,
                    parameter,
                    argumentExpressions,
                    index + 1,
                    signature.method,
                ),
                parameter,
                ordered[index] ?? false,
            ),
        );
        const callCpp = `bblscene::${signature.cppName}(${[
            ...fieldArguments,
            ...argumentsCpp,
        ].join(", ")})`;
        if (!signature.returnType) {
            this.context.emit(`${callCpp};`);
            return { kind: "void", cpp: "" };
        }
        const result = `bbl_method_${this.context.allocateUserFunctionPrefix()}result`;
        this.context.emit({
            kind: "declaration",
            type: "auto",
            name: result,
            initializer: callCpp,
            attributes: "[[maybe_unused]] ",
        });
        this.context.registerNativeTemporary(result, signature.returnType);
        return {
            ...this.context.dataLowerer.leafValue(result, signature.returnType),
            requiresExplicitDiscard: true,
        };
    }

    /**
     * The field locals this instance holds for a method signature's
     * channels, or undefined when any reached field is missing or is not
     * exactly the plain leaf its declared type stores natively.
     */
    private instanceFieldArguments(
        signature: NativeMethodSignature,
        instance: Value,
    ): string[] | undefined {
        const properties = instance.recordProperties;
        if (!properties) {
            return undefined;
        }
        const fieldValues: Value[] = [];
        for (const field of signature.fields) {
            const bound = properties[field.name];
            if (
                !bound ||
                (!cppIdentifierPattern.test(bound.cpp) && !bound.nativeLvalue)
            ) {
                return undefined;
            }
            const expected = this.context.dataLowerer.leafValue(
                bound.cpp,
                field.type,
            );
            if (!valueIsPlainLeaf(bound, expected)) {
                return undefined;
            }
            this.context.useNativeValue(bound);
            fieldValues.push(bound);
        }
        for (const value of fieldValues)
            this.context.dataLowerer.invalidateEscapingCollection(value);
        return fieldValues.map((value) => value.cpp);
    }

    /**
     * Whether passing this argument keeps the caller's JavaScript object
     * identity through the call boundary.
     *
     * A reference-struct parameter aliases by value only because the
     * shared pointer itself passes through, and a mutable by-reference
     * struct parameter binds only an argument of exactly its type; both
     * hold exactly when the argument's own checker type maps to the
     * parameter's data type. A structurally wider argument — a `Sector`
     * for a `{ floorHeight: number }` parameter — would instead be
     * materialized into a fresh copy by the sink conversion (or refused
     * outright on the mutable reference path), and a callee write or
     * store would then act on the copy while the caller's object never
     * moves. Such calls do not qualify; the inline path aliases by
     * construction, so it stays the lowering for them. A null or
     * undefined argument carries no object, so it always qualifies.
     */
    private argumentPreservesObjectIdentity(
        argument: ts.Expression,
        parameter: DataFunctionParameter,
    ): boolean {
        // Type annotations do not replace the representation of a parsed
        // object. Bind that actual value inline instead of materializing a
        // fixed native shape that would lose fields and object identity.
        // A member of a parsed object is itself parsed (`data.player`).
        const parsed = (expression: ts.Expression): boolean => {
            const node = this.context.unwrap(expression);
            const known = this.context.knownValueWithoutEvaluation(node);
            if (known) return known.dataType?.kind === "json";
            return (
                (ts.isPropertyAccessExpression(node) ||
                    ts.isElementAccessExpression(node)) &&
                parsed(node.expression)
            );
        };
        if (parsed(argument) && parameter.type.kind !== "json") {
            const target =
                parameter.type.kind === "optional"
                    ? parameter.type.inner
                    : parameter.type;
            if (
                target.kind === "struct" ||
                target.kind === "vector" ||
                target.kind === "tuple" ||
                target.kind === "map" ||
                target.kind === "enummap"
            )
                return false;
        }
        if (parameter.type.kind !== "struct") {
            return true;
        }
        const mutableReference = parameter.byReference && !parameter.readOnly;
        if (
            !mutableReference &&
            !this.context.dataTypes.isReferenceStruct(parameter.type.name)
        ) {
            return true;
        }
        const unwrapped = this.context.unwrap(argument);
        if (isNullishLiteral(this.context.checker, unwrapped)) {
            return true;
        }
        const argumentType = this.context.dataTypes.fromTsType(
            this.context.checker.getTypeAtLocation(argument),
            argument,
        );
        return (
            argumentType !== undefined &&
            dataTypesEqual(argumentType, parameter.type)
        );
    }

    private isAddressableArgument(expression: ts.Expression): boolean {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            const bound = this.context.bindings.lookupOptional(unwrapped);
            return !bound || bound.kind === "data";
        }
        return (
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
        );
    }

    private callValue(cpp: string, returnType: DataType | undefined): Value {
        if (!returnType) {
            return { kind: "void", cpp };
        }
        return {
            ...this.context.dataLowerer.leafValue(cpp, returnType),
            nativeOwnedRvalue: true,
        };
    }

    private compileArgument(
        expression: ts.Expression,
        parameter: NativeFunctionSignature["parameters"][number],
        laterArguments: readonly (ts.Expression | undefined)[] = [],
        firstLaterArgument = 0,
        directKernel?: SupportedFunction,
    ): string {
        const dataType = parameter.type;
        if (!dataType) {
            this.context.fail(
                expression,
                "Native function parameters require data types.",
            );
        }
        if (parameter.byReference) {
            if (parameter.borrowedWrapper) {
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
                    value.kind === "data" &&
                    value.dataType?.kind === "struct" &&
                    dataTypesEqual(value.dataType, dataType)
                ) {
                    if (
                        (value.nativeLvalue ||
                            value.sharedStorageCpp !== undefined ||
                            cppIdentifierPattern.test(value.cpp)) &&
                        directKernel !== undefined &&
                        this.directKernelCannotRunUserCode(directKernel) &&
                        laterArguments.every(
                            (argument, index) =>
                                index < firstLaterArgument ||
                                argument === undefined ||
                                this.expressionCannotRunUserCode(argument),
                        )
                    ) {
                        this.context.useNativeValue(value);
                        return value.cpp;
                    }
                    return this.context.bindings.pinValueToTemporary(
                        value,
                        "function_argument",
                        expression,
                    ).cpp;
                }
                return this.context.dataLowerer.compileForSink(
                    expression,
                    dataType,
                );
            }
            if (parameter.readOnly) {
                const rawPath = this.context.dataLowerer.compileDataPath(
                    expression,
                    "read",
                );
                const path = rawPath
                    ? this.context.dataLowerer.narrowOptional(
                          rawPath,
                          expression,
                      )
                    : undefined;
                if (path?.dataType && dataTypesEqual(path.dataType, dataType)) {
                    // A readonly parameter may return or retain the tuple.
                    if (dataType.kind === "tuple")
                        this.context.dataLowerer.invalidateEscapingCollection(
                            path,
                        );
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
                this.context.dataLowerer.compileDataPath(expression, "read") ??
                this.context.compileValue(expression);
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
            this.context.dataLowerer.invalidateEscapingCollection(value);
            if (dataType.kind === "struct")
                this.context.bindings.invalidateRecordProperties(value);
            return value.cpp;
        }
        // The sink materializes when the argument's type is not exactly
        // the parameter's -- correct for values, identity-severing for a
        // narrowed stored object. Both arms decline such calls before
        // reaching here (argumentPreservesObjectIdentity).
        return this.context.dataLowerer.compileForSink(expression, dataType);
    }

    /**
     * A by-value argument read into a temporary of its parameter's type when
     * a later argument touches its storage, either one writing it (see
     * `evaluation-order.ts`); a by-reference one passes the object itself.
     */
    private inOrder(
        cpp: string,
        parameter: NativeFunctionSignature["parameters"][number],
        pin: boolean,
    ): string {
        if (!pin || parameter.byReference || !parameter.type) return cpp;
        const name = this.context.allocateTemporaryCppName("native_argument");
        const type = `const ${this.context.dataTypes.cppType(parameter.type)}`;
        this.context.emit({
            kind: "declaration",
            type,
            name,
            initializer: cpp,
            attributes: "[[maybe_unused]] ",
        });
        this.context.registerNativeConstBinding(name);
        this.context.registerNativeBindingType(name, type);
        return name;
    }

    private readonly directKernelEffects = new EmissionMap<
        SupportedFunction,
        boolean
    >();

    private directKernelCannotRunUserCode(
        declaration: SupportedFunction,
        active = new Set<SupportedFunction>(),
    ): boolean {
        const cached = this.directKernelEffects.get(declaration);
        if (cached !== undefined) return cached;
        if (active.has(declaration)) return true;
        active.add(declaration);
        const locals = new Set<ts.Symbol>();
        if (declaration.body)
            someAnalysisNode(
                declaration.body,
                (node) => {
                    if (ts.isVariableDeclaration(node))
                        this.collectBindingSymbols(node.name, locals);
                    return false;
                },
                { functions: "skip", types: "skip" },
            );
        const result =
            declaration.body !== undefined &&
            this.nodeCannotRunUserCode(declaration.body, true, locals, active);
        active.delete(declaration);
        this.directKernelEffects.set(declaration, result);
        return result;
    }

    private expressionCannotRunUserCode(expression: ts.Expression): boolean {
        return (
            !expressionMayRunCode(expression) ||
            this.nodeCannotRunUserCode(expression, false, new Set(), new Set())
        );
    }

    private collectBindingSymbols(
        name: ts.BindingName,
        symbols: Set<ts.Symbol>,
    ): void {
        if (ts.isIdentifier(name)) {
            const symbol = declaredSymbol(this.context.checker, name);
            if (symbol) symbols.add(symbol);
            return;
        }
        for (const element of name.elements)
            if (!ts.isOmittedExpression(element))
                this.collectBindingSymbols(element.name, symbols);
    }

    private writesLocalOrNumericStorage(
        target: ts.Expression,
        locals: ReadonlySet<ts.Symbol>,
    ): boolean {
        const node = unwrapExpression(target);
        if (ts.isIdentifier(node)) {
            const symbol = declaredSymbol(this.context.checker, node);
            return symbol !== undefined && locals.has(symbol);
        }
        if (ts.isElementAccessExpression(node)) {
            const type = this.context.dataLowerer.dataTypeAt(node.expression);
            return (
                type !== undefined &&
                (type.kind === "numberindex" || isTypedArrayType(type))
            );
        }
        if (ts.isArrayLiteralExpression(node))
            return node.elements.every(
                (element) =>
                    ts.isOmittedExpression(element) ||
                    (!ts.isSpreadElement(element) &&
                        this.writesLocalOrNumericStorage(element, locals)),
            );
        return false;
    }

    private directCallCannotRunUserCode(
        call: ts.CallExpression,
        allowPureMath: boolean,
        active: Set<SupportedFunction>,
    ): boolean {
        if (allowPureMath) {
            const math = mathMemberCall(call, (expression) =>
                libraryGlobal(this.context.checker, expression),
            );
            const member =
                math === undefined ? undefined : MATH_MEMBERS.get(math.name);
            if (member !== undefined && member.reach !== "js-random")
                return true;
        }
        const called = this.directCallDeclaration(call);
        return (
            called !== undefined &&
            this.directKernelCannotRunUserCode(called, active)
        );
    }

    private directCallDeclaration(
        call: ts.CallExpression,
    ): SupportedFunction | undefined {
        const declared =
            this.context.checker.getResolvedSignature(call)?.declaration;
        if (declared && isSupportedFunction(declared)) return declared;
        const callee = unwrapExpression(call.expression);
        if (!ts.isPropertyAccessExpression(callee)) return undefined;
        const receiver = unwrapExpression(callee.expression);
        const value = ts.isIdentifier(receiver)
            ? this.context.bindings.lookupOptional(receiver)
            : this.context.knownValueWithoutEvaluation(receiver);
        const declaration =
            value &&
            (this.context.classOf(value) ??
                (value.dataType?.kind === "struct"
                    ? this.context.dataTypes.classStruct(value.dataType.name)
                          ?.declaration
                    : undefined));
        if (!declaration) return undefined;
        // A receiver of several classes runs whichever override its class
        // resolves; only one implementation shared by all of them is known.
        const hierarchy = this.context.dataTypes.classHierarchy;
        const candidates =
            value.classCandidates ??
            (value.kind === "data" && hierarchy.inHierarchy(declaration)
                ? hierarchy.concreteClasses(declaration)
                : [declaration]);
        const methods = new Set(
            candidates.map((candidate) =>
                classMethod(
                    classMemberTable(this.context.checker, candidate),
                    callee.name.text,
                ),
            ),
        );
        const [method] = methods;
        return methods.size === 1 && method?.body ? method : undefined;
    }

    private nodeCannotRunUserCode(
        root: ts.Node,
        allowPureMath: boolean,
        locals: ReadonlySet<ts.Symbol>,
        active: Set<SupportedFunction>,
    ): boolean {
        return !someAnalysisNode(
            root,
            (node) => {
                if (ts.isCallExpression(node)) {
                    return !this.directCallCannotRunUserCode(
                        node,
                        allowPureMath,
                        active,
                    );
                }
                if (
                    ts.isNewExpression(node) ||
                    ts.isDeleteExpression(node) ||
                    ts.isAwaitExpression(node) ||
                    ts.isYieldExpression(node) ||
                    ts.isThrowStatement(node)
                )
                    return true;
                if (isAssignmentExpression(node))
                    return !this.writesLocalOrNumericStorage(node.left, locals);
                if (isUpdateExpression(node))
                    return !this.writesLocalOrNumericStorage(
                        node.operand,
                        locals,
                    );
                if (ts.isPropertyAccessExpression(node)) {
                    if (
                        node !== root &&
                        ts.isCallExpression(node.parent) &&
                        node.parent.expression === node
                    )
                        return false;
                    const symbol = resolvedSymbol(this.context.checker, node);
                    return !symbol?.declarations?.every(
                        (declaration) =>
                            ts.isPropertySignature(declaration) ||
                            ts.isPropertyDeclaration(declaration),
                    );
                }
                if (ts.isElementAccessExpression(node)) {
                    const type = this.context.dataLowerer.dataTypeAt(
                        node.expression,
                    );
                    return !(
                        type &&
                        ([
                            "vector",
                            "span",
                            "tuple",
                            "product",
                            "table",
                            "enummap",
                            "numberindex",
                        ].includes(type.kind) ||
                            isTypedArrayType(type))
                    );
                }
                return false;
            },
            { functions: "skip", types: "skip" },
        );
    }

    /**
     * Maps one checker signature into the data model: the return type and
     * every parameter must map with no handles and no function kinds, and
     * struct types are marked as stored object references exactly as later
     * consumers will read them (`->` versus `.` must agree everywhere).
     * Returns undefined on the first lane that does not map; the caller
     * owns the disposal (the free arm retries on a later call, the method
     * arm memoizes the rejection).
     *
     * The two arms differ only in the declared deltas. A carried-function
     * return fails only the method arm, which has no inline fallback that
     * re-specializes closures; the free arm resolves the signature and its
     * call site keeps closure-bearing factories inline. Struct returns are
     * marked stored unconditionally only on the method arm — agreeing with
     * the class inline path, and only after every rejecting check so a
     * declining probe leaves no mark on the type registry — while the free
     * arm marks before its checks, but only when a source container
     * provably stores the type.
     */
    private mapDataSignature(
        declaration: SupportedFunction,
        checkerSignature: ts.Signature,
        options: {
            rejectCarriedFunctionReturn: boolean;
            markAllStructReturns: boolean;
        },
    ):
        | {
              parameters: DataFunctionParameter[];
              returnType: DataType | undefined;
          }
        | undefined {
        const returnTsType =
            this.context.checker.getReturnTypeOfSignature(checkerSignature);
        let returnType: DataType | undefined;
        let arrayStorage: ReturnType<typeof arrayReturnStorage>;
        if ((returnTsType.flags & ts.TypeFlags.Void) === 0) {
            let mapped = this.context.dataTypes.fromTsType(
                returnTsType,
                declaration,
            );
            if (mapped && this.context.dataTypes.returnsArray(mapped)) {
                arrayStorage = arrayReturnStorage(
                    this.context.checker,
                    declaration,
                    (root) =>
                        this.context.dataLowerer.materializeStaticTable(root)
                            ?.dataType?.kind === "table",
                );
                if (arrayStorage !== "static")
                    mapped = this.context.dataTypes.ownReturnedArray(mapped);
            }
            if (
                mapped?.kind === "struct" &&
                !options.markAllStructReturns &&
                this.typeRequiresReferenceStorage(returnTsType, mapped.name)
            ) {
                mapped =
                    this.context.dataTypes.markStoredObjectReferences(mapped);
            }
            if (
                !mapped ||
                mapped.kind === "function" ||
                this.context.dataTypes.carriesHandle(mapped) ||
                (options.rejectCarriedFunctionReturn &&
                    this.context.dataTypes.carriesFunction(mapped))
            ) {
                return undefined;
            }
            returnType =
                options.markAllStructReturns && mapped.kind === "struct"
                    ? this.context.dataTypes.markStoredObjectReferences(mapped)
                    : mapped;
        }
        const parameters: DataFunctionParameter[] = [];
        for (const parameter of declaration.parameters) {
            if (!ts.isIdentifier(parameter.name)) {
                return undefined;
            }
            const parameterTsType =
                this.context.checker.getTypeAtLocation(parameter);
            let parameterType = this.context.dataTypes.fromTsType(
                parameterTsType,
                parameter,
            );
            const freshMatchingArray =
                arrayStorage === "fresh" &&
                parameterType?.kind === "span" &&
                returnType?.kind === "vector" &&
                dataTypesEqual(parameterType.element, returnType.element);
            if (
                parameterType &&
                this.context.dataTypes.returnsArray(returnType) &&
                arrayStorage !== "static" &&
                !freshMatchingArray
            ) {
                parameterType =
                    this.context.dataTypes.ownReturnedArray(parameterType);
            }
            if (
                parameterType?.kind === "struct" &&
                (this.context.identifierIsRebound(parameter.name) ||
                    this.typeRequiresReferenceStorage(
                        parameterTsType,
                        parameterType.name,
                    ))
            ) {
                // Reference representation is a property of the source
                // object type, not the order in which native functions are
                // first reached. A type returned by one helper can be seen
                // first as another helper's parameter (Doom's Wad does
                // exactly this); mark it before emitting that parameter's
                // member accesses so the body and later call sites agree on
                // `->` versus `.`.
                parameterType =
                    this.context.dataTypes.markStoredObjectReferences(
                        parameterType,
                    );
            }
            if (
                !parameterType ||
                parameterType.kind === "function" ||
                this.context.dataTypes.carriesHandle(parameterType)
            ) {
                return undefined;
            }
            parameters.push({
                name: parameter.name,
                type: parameterType,
                ...(() => {
                    const rebound = this.context.identifierIsRebound(
                        parameter.name,
                    );
                    const borrowedWrapper = borrowsReferenceParameter(
                        this.context,
                        parameter.name,
                        parameterType,
                    );
                    return {
                        borrowedWrapper,
                        byReference:
                            borrowedWrapper ||
                            (passesByReference(
                                this.context.dataTypes,
                                parameterType,
                            ) &&
                                !rebound),
                        readOnly:
                            borrowedWrapper ||
                            parameterIsReadOnly(
                                this.context.checker,
                                declaration,
                                parameter.name,
                            ),
                    };
                })(),
            });
        }
        return { parameters, returnType };
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
        if (
            declaration.typeParameters?.length ||
            declaration.parameters.some(
                (parameter) =>
                    parameter.dotDotDotToken !== undefined ||
                    ts.isObjectBindingPattern(parameter.name),
            )
        ) {
            // A generic body is spelled per instantiation, a rest
            // parameter packed per call and an object pattern bound from
            // its argument: each is the inline lowerer's.
            this.rejected.add(declaration);
            return undefined;
        }
        const checkerSignature =
            this.context.checker.getSignatureFromDeclaration(declaration);
        if (!checkerSignature) {
            return undefined;
        }
        if (
            declaration.body &&
            this.context.canReplaySharedCallEffects(declaration.body)
        ) {
            this.rejected.add(declaration);
            return undefined;
        }
        if (this.capturesEnclosingBindings(declaration)) {
            // A closure over another function's locals (typically entry
            // engine handles) cannot become a namespace-scope function;
            // the inline lowerer keeps handling it.
            this.rejected.add(declaration);
            return undefined;
        }
        if (this.containsRetainedCallbackRegistration(declaration)) {
            // Each evaluation creates fresh JavaScript function identities.
            // Keep the body on the inliner, where the callback registry can
            // distinguish those evaluations by their concrete owner/scope.
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
        if (this.containsShaderMaterialCreation(declaration)) {
            // Shader source and fixed-function state are consumed while the
            // variant table is generated. Keep a wrapper that creates one
            // on the inline path so defaults and literal parameters remain
            // compile-time values instead of native function parameters.
            this.rejected.add(declaration);
            return undefined;
        }
        if (this.containsEntryEngineOperation(declaration)) {
            // Timers enqueue work on the entry engine. A namespace-scope
            // data helper has no engine parameter to use, so it must remain
            // inline where createEngine's binding is visible.
            this.rejected.add(declaration);
            return undefined;
        }
        // A helper that hands back a resource handle touches the engine
        // to produce it, so it stays on the inline path where the engine
        // binding is in scope; the mapper declines it.
        const mapped = this.mapDataSignature(declaration, checkerSignature, {
            rejectCarriedFunctionReturn: false,
            markAllStructReturns: false,
        });
        if (!mapped) {
            return undefined;
        }
        if (!ts.isBlock(declaration.body ?? declaration)) {
            return undefined;
        }
        const cppName = this.uniqueName(callee.text);
        const signature: NativeFunctionSignature = {
            cppName,
            parameters: mapped.parameters,
            returnType: mapped.returnType,
            declaration,
        };
        this.signatures.set(declaration, signature);
        return signature;
    }

    /**
     * Resolves the once-emitted signature for a class-instance method, or
     * undefined when it does not cleanly qualify. Every rejecting check
     * runs before the stored-reference marking below, so a probe that
     * declines leaves no mark on the type registry beyond what the class
     * inline path applies to the same method anyway.
     *
     * The gate, in full: the class has no heritage and no generics; the
     * method is a plain synchronous block-bodied method with identifier
     * parameters whose defaults reference neither `this` nor a sibling
     * parameter; the transitive same-class closure (methods it calls on
     * `this`, getters it reads) uses `this` only as a direct member
     * receiver, touches only plain-data property fields, calls no other
     * local class's methods, constructs no local class, and passes the
     * same body classification the free-function arm applies (no
     * generation-time fetch, no shader-material creation, no retained
     * callback registration, no entry-engine timers, no captured enclosing
     * bindings); the parameters and return type map into the plain-data model
     * with no handles and no carried functions.
     */
    private resolveMethodSignature(
        method: ts.MethodDeclaration,
        classDeclaration: ts.ClassDeclaration,
    ): NativeMethodSignature | undefined {
        const cached = this.methodSignatures.get(method);
        if (cached) {
            return cached;
        }
        if (this.rejectedMethods.has(method)) {
            return undefined;
        }
        const reject = (): undefined => {
            this.rejectedMethods.add(method);
            return undefined;
        };
        // A class in a hierarchy resolves `this` calls per run-time class,
        // which one emitted function over field channels cannot.
        if (
            classDeclaration.heritageClauses?.length ||
            this.context.dataTypes.classHierarchy.inHierarchy(
                classDeclaration,
            ) ||
            classDeclaration.typeParameters?.length ||
            Object.keys(
                classMemberTable(this.context.checker, classDeclaration)
                    .setters,
            ).length > 0
        ) {
            return reject();
        }
        if (!this.methodIsStructurallyEligible(method)) {
            return reject();
        }
        if (this.containsRetainedCallbackRegistration(method)) {
            return reject();
        }
        const closure = this.collectMethodClosure(method, classDeclaration);
        if (!closure) {
            return reject();
        }
        for (const member of [...closure.methods, ...closure.getters]) {
            if (
                member.body &&
                this.context.canReplaySharedCallEffects(member.body)
            )
                return reject();
            if (
                member !== method &&
                !this.methodIsStructurallyEligible(member)
            ) {
                return reject();
            }
            if (
                this.capturesEnclosingBindings(
                    member,
                    member,
                    new EmissionSet<EligibleMember>(),
                    true,
                ) ||
                this.containsGenerationTimeFetch(member) ||
                this.containsShaderMaterialCreation(member) ||
                this.containsRetainedCallbackRegistration(member) ||
                this.containsEntryEngineOperation(member)
            ) {
                return reject();
            }
        }
        // Field channels, in class declaration order so the emitted
        // signature is deterministic.
        const fields: MethodFieldChannel[] = [];
        for (const [name, member] of classMemberTable(
            this.context.checker,
            classDeclaration,
        ).fields) {
            if (!closure.fieldNames.has(name)) {
                continue;
            }
            const mappedFieldType = this.context.dataLowerer.dataTypeAt(
                member.name,
            );
            // Class fields own the JavaScript objects assigned to them even
            // when their declared surface is readonly. Match construction's
            // owning representation rather than exposing a Span channel to
            // a field backed by an Array.
            const fieldType = mappedFieldType
                ? this.context.dataTypes.markStoredObjectReferences(
                      mappedFieldType,
                  )
                : undefined;
            if (
                !fieldType ||
                fieldType.kind === "function" ||
                fieldType.kind === "handle" ||
                this.context.dataTypes.carriesHandle(fieldType) ||
                this.context.dataTypes.carriesFunction(fieldType)
            ) {
                return reject();
            }
            fields.push({ name, type: fieldType });
        }
        if (fields.length !== closure.fieldNames.size) {
            // A touched name without a plain property declaration —
            // a constructor parameter property, for instance — stays on
            // the inline path, where the instance record already carries
            // whatever binding construction gave it.
            return reject();
        }
        const checkerSignature =
            this.context.checker.getSignatureFromDeclaration(method);
        if (!checkerSignature) {
            return reject();
        }
        // The class inline path marks every struct method return as a
        // stored object reference; the once-emitted arm must agree so
        // `->` versus `.` member access matches at every consumer.
        const mapped = this.mapDataSignature(method, checkerSignature, {
            rejectCarriedFunctionReturn: true,
            markAllStructReturns: true,
        });
        if (!mapped) {
            return reject();
        }
        const { parameters, returnType } = mapped;
        // The field channels use `this_<field>` source names; a source
        // parameter spelled the same way would collide in the emitted
        // parameter list.
        const channelNames = new EmissionSet(
            fields.map((field) => `this_${field.name}`),
        );
        if (
            parameters.some((parameter) =>
                channelNames.has(parameter.name.text),
            ) ||
            channelNames.size !== fields.length
        ) {
            return reject();
        }
        const getters = {
            ...classMemberTable(this.context.checker, classDeclaration).getters,
        };
        const signature: NativeMethodSignature = {
            cppName: this.uniqueName(
                `${classDeclaration.name?.text ?? "Class"}_${method.name.getText()}`,
            ),
            fields,
            parameters,
            returnType,
            method,
            classDeclaration,
            getters,
        };
        this.methodSignatures.set(method, signature);
        return signature;
    }

    /** The plain synchronous method shape the once-emitted arm accepts. */
    private methodIsStructurallyEligible(member: EligibleMember): boolean {
        if (ts.isGetAccessorDeclaration(member)) {
            const statements = member.body?.statements;
            return (
                statements?.length === 1 &&
                ts.isReturnStatement(statements[0]!) &&
                statements[0].expression !== undefined
            );
        }
        if (!ts.isMethodDeclaration(member)) {
            return false;
        }
        if (
            !ts.isMemberName(member.name) ||
            !member.body ||
            !ts.isBlock(member.body) ||
            member.asteriskToken !== undefined ||
            member.questionToken !== undefined ||
            member.typeParameters?.length ||
            (ts.canHaveDecorators(member) && ts.getDecorators(member)?.length)
        ) {
            return false;
        }
        if (
            (ts.getCombinedModifierFlags(member) &
                (ts.ModifierFlags.Static |
                    ts.ModifierFlags.Abstract |
                    ts.ModifierFlags.Async)) !==
            0
        ) {
            return false;
        }
        for (const parameter of member.parameters) {
            if (
                !ts.isIdentifier(parameter.name) ||
                parameter.dotDotDotToken !== undefined ||
                parameter.name.text === "this"
            ) {
                return false;
            }
            if (
                parameter.initializer &&
                this.defaultReferencesMethodState(parameter.initializer, member)
            ) {
                // The native arm compiles a default at the call site, in
                // the caller's scope, where neither `this` nor a sibling
                // parameter resolves to the callee's binding.
                return false;
            }
        }
        return true;
    }

    private defaultReferencesMethodState(
        initializer: ts.Expression,
        method: ts.MethodDeclaration,
    ): boolean {
        const parameterSymbols = new EmissionSet(
            method.parameters
                .map((parameter) =>
                    ts.isIdentifier(parameter.name)
                        ? declaredSymbol(this.context.checker, parameter.name)
                        : undefined,
                )
                .filter((symbol): symbol is ts.Symbol => symbol !== undefined),
        );
        return someAnalysisNode(initializer, (node) => {
            if (node.kind === ts.SyntaxKind.ThisKeyword) {
                return true;
            }
            if (ts.isIdentifier(node)) {
                const symbol = declaredSymbol(this.context.checker, node);
                if (symbol && parameterSymbols.has(symbol)) {
                    return true;
                }
            }
            return false;
        });
    }

    /**
     * Walks the transitive same-class closure of one method: every method
     * it calls on `this`, every getter it reads, and every field either
     * touches. Returns undefined when any body uses `this` outside the
     * direct-member shapes this arm can parameterize, calls into another
     * local class, or constructs one.
     */
    private collectMethodClosure(
        method: ts.MethodDeclaration,
        classDeclaration: ts.ClassDeclaration,
    ): MethodClosure | undefined {
        const table = classMemberTable(this.context.checker, classDeclaration);
        const memberNamed = (
            name: string,
        ):
            | { kind: "method"; member: ts.MethodDeclaration }
            | { kind: "getter"; member: ts.GetAccessorDeclaration }
            | { kind: "field" }
            | undefined => {
            const called = table.methods.get(name);
            if (called) return { kind: "method", member: called };
            if (Object.hasOwn(table.getters, name)) {
                return { kind: "getter", member: table.getters[name]! };
            }
            return table.fields.has(name) ? { kind: "field" } : undefined;
        };
        const methods = new EmissionSet<ts.MethodDeclaration>();
        const getters = new EmissionSet<ts.GetAccessorDeclaration>();
        const fieldNames = new EmissionSet<string>();
        const pending: EligibleMember[] = [method];
        methods.add(method);
        let sound = true;
        const localClassConstruction = (node: ts.NewExpression): boolean => {
            const callee = this.context.unwrap(node.expression);
            if (!ts.isIdentifier(callee)) return true;
            const target = resolvedSymbol(this.context.checker, callee);
            return (target?.declarations ?? []).some(
                (candidate) =>
                    ts.isClassDeclaration(candidate) &&
                    !candidate.getSourceFile().isDeclarationFile,
            );
        };
        const invalid = (root: ts.Node) =>
            findAnalysisNodeWithState(
                root,
                false,
                (node, dynamicThis) => {
                    if (node.kind === ts.SyntaxKind.ThisKeyword) {
                        if (dynamicThis) {
                            return true;
                        }
                        const access = node.parent;
                        if (
                            !ts.isPropertyAccessExpression(access) ||
                            access.expression !== node ||
                            access.questionDotToken !== undefined ||
                            !ts.isMemberName(access.name)
                        ) {
                            return true;
                        }
                        const entry = memberNamed(access.name.text);
                        if (!entry) {
                            return true;
                        }
                        if (entry.kind === "method") {
                            const invocation = access.parent;
                            if (
                                !ts.isCallExpression(invocation) ||
                                invocation.expression !== access ||
                                invocation.questionDotToken !== undefined
                            ) {
                                return true;
                            }
                            if (!methods.has(entry.member)) {
                                methods.add(entry.member);
                                pending.push(entry.member);
                            }
                            return false;
                        }
                        if (entry.kind === "getter") {
                            if (!getters.has(entry.member)) {
                                getters.add(entry.member);
                                pending.push(entry.member);
                            }
                            return false;
                        }
                        fieldNames.add(access.name.text);
                        return false;
                    }
                    if (ts.isNewExpression(node)) {
                        if (localClassConstruction(node)) {
                            // Constructing a local class runs its constructor at
                            // the emission site; the closure checks do not cover
                            // that body, so it stays on the inline path.
                            return true;
                        }
                    }
                    if (ts.isCallExpression(node)) {
                        const callee = this.context.unwrap(node.expression);
                        if (
                            ts.isPropertyAccessExpression(callee) &&
                            callee.expression.kind !== ts.SyntaxKind.ThisKeyword
                        ) {
                            const called =
                                this.context.checker.getResolvedSignature(
                                    node,
                                )?.declaration;
                            if (
                                called &&
                                (ts.isMethodDeclaration(called) ||
                                    ts.isGetAccessorDeclaration(called)) &&
                                !called.getSourceFile().isDeclarationFile
                            ) {
                                // A method call on another instance needs that
                                // instance's compile-time record, which a
                                // namespace-scope body does not carry.
                                return true;
                            }
                        }
                    }
                    return false;
                },
                (node, dynamicThis) =>
                    dynamicThis ||
                    ts.isFunctionExpression(node) ||
                    ts.isFunctionDeclaration(node) ||
                    ts.isClassDeclaration(node) ||
                    ts.isClassExpression(node),
            );
        while (sound && pending.length > 0) {
            const member = pending.pop()!;
            if (!member.body) {
                sound = false;
                break;
            }
            sound = invalid(member.body) === undefined;
        }
        if (!sound) {
            return undefined;
        }
        return { methods, getters, fieldNames };
    }

    /**
     * Emits one method as a namespace function. The body is lowered with
     * `this` bound to a synthetic instance record whose fields are leaf
     * values over the reference channels, so every `this.<field>` read
     * and write lowers through the same data paths it takes today —
     * against the caller's own field local, through the reference.
     */
    private emitMethodDefinition(signature: NativeMethodSignature): void {
        this.context.reachJsData();
        const body = signature.method.body;
        if (!body || !ts.isBlock(body)) {
            this.context.fail(
                signature.method,
                "Native methods require a block body.",
            );
        }
        const returnCpp = signature.returnType
            ? this.context.dataTypes.cppType(signature.returnType)
            : "void";
        const previousThis = this.context.activeThis();
        let captured: {
            parameterDeclarations: string[];
            lines: string[];
        };
        try {
            const fieldProperties: Record<string, Value> = {};
            captured = captureDataFunctionBody(
                this.context,
                signature.parameters,
                signature.returnType,
                () => {
                    this.emitValueBody(body.statements, !!signature.returnType);
                },
                {
                    namespaceScope: true,
                    bindLeading: () =>
                        signature.fields.map((field) => {
                            const cppName = this.context.bindings.cppIdentifier(
                                `this_${field.name}`,
                            );
                            this.context.registerNativeBinding(
                                cppName,
                                false,
                                true,
                            );
                            fieldProperties[field.name] =
                                this.context.dataLowerer.leafValue(
                                    cppName,
                                    field.type,
                                );
                            if (
                                field.type.kind !== "number" &&
                                field.type.kind !== "boolean"
                            ) {
                                this.context.dataLowerer.registerLocal(
                                    cppName,
                                    "owned",
                                );
                            }
                            // A channel can go unread when its only touch
                            // sits in a branch generation folds away.
                            return `[[maybe_unused]] ${this.context.dataTypes.cppType(field.type)}& ${cppName}`;
                        }),
                    beforeBody: () => {
                        const synthetic: Value = {
                            kind: "record",
                            cpp: "",
                            recordProperties: fieldProperties,
                            recordGetters: signature.getters,
                        };
                        this.context.registerClassInstance(
                            synthetic,
                            signature.classDeclaration,
                        );
                        this.context.defineThis(synthetic);
                    },
                },
            );
        } finally {
            this.context.defineThis(previousThis);
        }
        this.registerDataFunction(
            signature.cppName,
            returnCpp,
            captured,
            signature.method,
        );
    }

    private containsGenerationTimeFetch(
        declaration: EligibleMember,
        active = new EmissionSet<EligibleMember>(),
    ): boolean {
        const cached = this.generationTimeFetchCache.get(declaration);
        if (cached !== undefined) return cached;
        if (active.has(declaration)) return false;
        active.add(declaration);

        const found = someAnalysisNode(
            declaration.body ?? declaration,
            (node) => {
                if (ts.isCallExpression(node)) {
                    if (
                        libraryGlobal(this.context.checker, node.expression) ===
                        "fetch"
                    ) {
                        return true;
                    }
                    const called =
                        this.context.checker.getResolvedSignature(
                            node,
                        )?.declaration;
                    if (
                        isSupportedFunction(called) &&
                        this.containsGenerationTimeFetch(called, active)
                    ) {
                        return true;
                    }
                }
                return false;
            },
        );

        active.delete(declaration);
        this.generationTimeFetchCache.set(declaration, found);
        return found;
    }

    private containsRetainedCallbackRegistration(
        declaration: EligibleMember,
    ): boolean {
        const immediateCallbackMethods = new EmissionSet([
            "every",
            "filter",
            "find",
            "findIndex",
            "flatMap",
            "forEach",
            "map",
            "reduce",
            "some",
            "sort",
        ]);
        const onlyCalledDirectly = (
            callback:
                | ts.ArrowFunction
                | ts.FunctionExpression
                | ts.FunctionDeclaration,
        ): boolean => {
            const name = ts.isFunctionDeclaration(callback)
                ? callback.name
                : ts.isVariableDeclaration(callback.parent) &&
                    ts.isIdentifier(callback.parent.name)
                  ? callback.parent.name
                  : undefined;
            const symbol = name
                ? declaredSymbol(this.context.checker, name)
                : undefined;
            if (!name || !symbol) return false;
            return !someAnalysisNode(declaration, (node) => {
                if (
                    ts.isIdentifier(node) &&
                    node !== name &&
                    declaredSymbol(this.context.checker, node) === symbol
                ) {
                    const parent = node.parent;
                    if (
                        !ts.isCallExpression(parent) ||
                        this.context.unwrap(parent.expression) !== node
                    ) {
                        return true;
                    }
                }
                return false;
            });
        };

        const found = someAnalysisNode(declaration, (node) => {
            if (
                node !== declaration &&
                (ts.isArrowFunction(node) ||
                    ts.isFunctionExpression(node) ||
                    ts.isFunctionDeclaration(node))
            ) {
                const parent = node.parent;
                const functionExpression =
                    ts.isArrowFunction(node) || ts.isFunctionExpression(node);
                const immediatelyInvoked =
                    ts.isCallExpression(parent) &&
                    this.context.unwrap(parent.expression) === node;
                const immediateMethodArgument =
                    functionExpression &&
                    ts.isCallExpression(parent) &&
                    parent.arguments.includes(node) &&
                    ts.isPropertyAccessExpression(parent.expression) &&
                    immediateCallbackMethods.has(parent.expression.name.text);
                if (
                    !immediatelyInvoked &&
                    !immediateMethodArgument &&
                    !onlyCalledDirectly(node)
                ) {
                    return true;
                }
            }
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "addEventListener" &&
                node.arguments.length >= 2
            ) {
                return true;
            }
            return false;
        });

        return found;
    }

    private containsShaderMaterialCreation(
        declaration: EligibleMember,
    ): boolean {
        const shaderFactories = new EmissionSet([
            "createShaderMaterial",
            "createSprite2DCustomShader",
            "createBillboardCustomShader",
        ]);

        const found = someAnalysisNode(
            declaration.body ?? declaration,
            (node) => {
                if (ts.isCallExpression(node)) {
                    if (
                        ts.isIdentifier(node.expression) &&
                        shaderFactories.has(node.expression.text)
                    ) {
                        return true;
                    }
                    const called =
                        this.context.checker.getResolvedSignature(
                            node,
                        )?.declaration;
                    if (
                        called?.getSourceFile().isDeclarationFile &&
                        ts.isFunctionDeclaration(called) &&
                        called.name &&
                        shaderFactories.has(called.name.text)
                    ) {
                        return true;
                    }
                }
                return false;
            },
        );

        return found;
    }

    /** Whether this otherwise plain-data helper needs the entry engine. */
    private containsEntryEngineOperation(declaration: EligibleMember): boolean {
        const found = someAnalysisNode(
            declaration.body ?? declaration,
            (node) => {
                if (ts.isCallExpression(node)) {
                    const callee = this.context.unwrap(node.expression);
                    // `requestAnimationFrame` joins `setTimeout` for the same
                    // reason and one more: a frame yield built on it is not a
                    // call at all in the lowered program, it is a CUT in the
                    // entry body's continuation. A once-emitted namespace
                    // function has no continuation to cut and no engine
                    // binding to queue against, and a counted wait through one
                    // would lose the count -- its body is emitted once for
                    // every call and every iteration.
                    const name = ts.isIdentifier(callee)
                        ? callee.text
                        : ts.isPropertyAccessExpression(callee)
                          ? callee.name.text
                          : undefined;
                    if (
                        name === "setTimeout" ||
                        name === "requestAnimationFrame"
                    ) {
                        return true;
                    }
                }
                return false;
            },
        );

        return found;
    }

    /** Establish object storage before emitting any native member accesses. */
    private typeRequiresReferenceStorage(
        sourceType: ts.Type,
        structName: string,
    ): boolean {
        const target = this.context.checker.getNonNullableType(sourceType);
        const cached = this.referenceStorageCache.get(structName);
        if (cached !== undefined) return cached;
        const sameType = (candidate: ts.Type): boolean => {
            const normalized =
                this.context.checker.getNonNullableType(candidate);
            return (
                normalized === target ||
                (normalized.aliasSymbol !== undefined &&
                    normalized.aliasSymbol === target.aliasSymbol) ||
                (normalized.symbol !== undefined &&
                    normalized.symbol === target.symbol) ||
                // The data registry coalesces structurally equal records.
                // A differently named equivalent type can therefore impose
                // the same storage requirement on this native parameter.
                (this.context.checker.isTypeAssignableTo(normalized, target) &&
                    this.context.checker.isTypeAssignableTo(target, normalized))
            );
        };
        const stored = this.context.sourceFiles().some(
            (source) =>
                !source.isDeclarationFile &&
                someAnalysisNode(source, (node) => {
                    let storedTypeNode: ts.TypeNode | undefined;
                    if (ts.isArrayTypeNode(node)) {
                        storedTypeNode = node.elementType;
                    } else if (
                        ts.isPropertyDeclaration(node) ||
                        ts.isPropertySignature(node) ||
                        ts.isMethodDeclaration(node)
                    ) {
                        // Fields own their object values, and native method returns
                        // use the same reference representation (mapSignature).
                        storedTypeNode = node.type;
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
                        storedTypeNode =
                            index >= 0
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
                        return true;
                    }
                    return false;
                }),
        );
        this.referenceStorageCache.set(structName, stored);
        return stored;
    }

    /**
     * True when the function body references a binding declared inside
     * another function (a captured closure variable). Module-scope
     * constants, functions, imports, and the function's own parameters and
     * locals are fine; captured bindings force the inline path.
     */
    private capturesEnclosingBindings(
        declaration: EligibleMember,
        root: EligibleMember = declaration,
        active = new EmissionSet<EligibleMember>(),
        skipMemberNames = false,
    ): boolean {
        if (active.has(declaration)) return false;
        active.add(declaration);
        const classify = (
            bindingDeclaration: ts.Node,
        ): "internal" | "module" | "captured" => {
            let node: ts.Node | undefined = bindingDeclaration.parent;
            let sawFunction = false;
            while (node) {
                if (node === declaration || node === root) {
                    return "internal";
                }
                if (ts.isFunctionLike(node)) {
                    sawFunction = true;
                }
                if (ts.isSourceFile(node)) {
                    return sawFunction ? "captured" : "module";
                }
                node = node.parent;
            }
            return "module";
        };
        const captured =
            declaration.body !== undefined &&
            someAnalysisNode(
                declaration.body,
                (node) => {
                    if (ts.isIdentifier(node)) {
                        const target = resolvedSymbol(
                            this.context.checker,
                            node,
                        );
                        const bindingDeclaration =
                            target?.valueDeclaration ??
                            target?.declarations?.[0];
                        if (bindingDeclaration) {
                            const shape = classify(bindingDeclaration);
                            if (shape === "captured") {
                                return true;
                            }
                            if (shape === "module") {
                                // Entry-file top-level bindings live as locals
                                // of the generated main. Compile-time bindings
                                // (static tuples, records, strings) still fold
                                // on any path; runtime bindings capture.
                                const bound =
                                    this.context.bindings.lookupOptional(node);
                                if (
                                    ts.isVariableDeclaration(
                                        bindingDeclaration,
                                    ) &&
                                    bindingDeclaration.initializer &&
                                    ts.isRegularExpressionLiteral(
                                        bindingDeclaration.initializer,
                                    )
                                ) {
                                    return true;
                                }
                                if (
                                    bound &&
                                    bound.kind !== "tuple" &&
                                    bound.kind !== "record" &&
                                    (bound.kind !== "string" ||
                                        bound.staticString === undefined) &&
                                    bound.kind !== "callback"
                                ) {
                                    return true;
                                }
                            }
                        }
                    }
                    if (ts.isCallExpression(node)) {
                        const called =
                            this.context.checker.getResolvedSignature(
                                node,
                            )?.declaration;
                        if (
                            isSupportedFunction(called) &&
                            this.capturesEnclosingBindings(
                                called,
                                root,
                                active,
                                skipMemberNames,
                            )
                        ) {
                            return true;
                        }
                    }
                    return false;
                },
                skipMemberNames ? { memberNames: "skip" } : {},
            );
        active.delete(declaration);
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

    /**
     * Emits one declaration's definition exactly once. Native data
     * functions and methods are declared before any definition is
     * emitted, so a direct or mutual-recursion back-edge can call the
     * signature already being generated and its call line is valid.
     * Inlined closures do not have that property and retain their
     * separate rejection.
     */
    private ensureEmitted(
        declaration: SupportedFunction,
        emitDefinition: () => void,
    ): void {
        if (this.active.has(declaration)) {
            return;
        }
        if (this.emitted.has(declaration)) {
            return;
        }
        this.active.add(declaration);
        this.emitted.add(declaration);
        try {
            emitDefinition();
        } catch (error) {
            this.emitted.delete(declaration);
            throw error;
        } finally {
            this.active.delete(declaration);
        }
    }

    private emitDefinition(signature: NativeFunctionSignature): void {
        this.context.reachJsData();
        const body = signature.declaration.body;
        if (!body || !ts.isBlock(body)) {
            this.context.fail(
                signature.declaration,
                "Native functions require a block body.",
            );
        }
        const returnCpp = signature.returnType
            ? this.context.dataTypes.cppType(signature.returnType)
            : "void";
        this.registerDataFunction(
            signature.cppName,
            returnCpp,
            captureDataFunctionBody(
                this.context,
                signature.parameters,
                signature.returnType,
                () => {
                    this.emitValueBody(body.statements, !!signature.returnType);
                },
                { namespaceScope: true },
            ),
            signature.declaration,
        );
    }

    private emitValueBody(
        statements: readonly ts.Statement[],
        returnsValue: boolean,
    ): void {
        const terminated = emitReachableStatements(this.context, statements);
        if (returnsValue && !terminated) {
            // An exhaustive source switch may lower to a native if/else chain.
            // Keep the impossible fallthrough defined on all native compilers.
            this.context.emit(
                'throw std::runtime_error("Native value function fell through without returning.");',
            );
        }
    }

    /**
     * Registers one captured definition as a namespace function. The
     * return spelling is computed by the caller before the body capture:
     * naming a type can register it, and the registry order must match
     * what streaming the definition would have produced.
     */
    private registerDataFunction(
        cppName: string,
        returnCpp: string,
        definition: {
            parameterDeclarations: string[];
            lines: string[];
        },
        source: ts.Node,
    ): void {
        const parameterList = definition.parameterDeclarations.join(", ");
        this.context.nativeEmission.registerNativeFunction(
            `${returnCpp} ${cppName}(${parameterList});`,
            [
                `${returnCpp} ${cppName}(${parameterList}) {`,
                ...definition.lines.map((line) => `    ${line}`),
                "}",
            ],
            source,
        );
    }
}
