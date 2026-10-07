import { requireWindowHost } from "./window-events.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { compileGpuAdapterCall } from "./gpu-adapter.js";
import { devicePixelRatioValue } from "./device-pixel-ratio.js";
import { mayCompileDataMethodCall } from "./data-methods.js";
import { compileBoundCollectionMethod } from "./collection-functions.js";
import { EmissionMap, EmissionSet, writable } from "./emission-transaction.js";
import { traceSourceNode } from "./source-trace.js";
import type { LoweringServices } from "./lowering-services.js";
// Expression lowering: the value switch and its call dispatch.
//
// `compileValue` is the one door every value position goes through. It
// recognizes the expression's syntactic shape and hands each shape to
// the module that owns it -- data paths and constructors to the data
// lowerer, local classes to the class lowerer, property reads to the
// compiler's property path, and calls to `compileCall`, whose order
// (immediate promises, math and data methods, scene collection pushes,
// record and class methods, bound callbacks, registered intrinsics,
// native functions, user functions) is the resolution order a call site
// observes.
// Expression lowering: the value switch and its call dispatch.
//
// `compileValue` is the one door every value position goes through. It
// recognizes the expression's syntactic shape and hands each shape to
// the module that owns it -- data paths and constructors to the data
// lowerer, local classes to the class lowerer, property reads to the
// compiler's property path, and calls to `compileCall`, whose order
// (immediate promises, math and data methods, scene collection pushes,
// record and class methods, bound callbacks, registered intrinsics,
// native functions, user functions) is the resolution order a call site
// observes.
import ts from "typescript";
import { projectAssetContainer } from "./data-sinks/resources.js";
import { arrayFunctionValue } from "./native-function-values.js";
import { hasDynamicObjectSpread, isJsonValue } from "./json-bridge.js";
import {
    isHandleKind,
    isUndefinedDataType,
    TYPED_ARRAY_KINDS,
} from "./data-types.js";
import {
    DynamicBindingStorageRequired,
    initializedVariableDeclaration,
} from "./dynamic-binding-storage.js";
import { requireAbsenceTag } from "./absence-tag-storage.js";

import { doubleLiteral } from "../cpp-literals.js";
import { syntaxKindName } from "../source-location.js";
import {
    accessedPropertySymbol,
    declaredSymbol,
    enumMemberConstant,
    isAbsentTypeofIdentifier,
    resolvedSymbol,
} from "./symbols.js";
import {
    compileNumberPredicate,
    numberConstant,
    numberConstantValue,
    numberPredicateFunction,
} from "./number-intrinsics.js";
import {
    compileAudioMethodCall,
    compileAudioConstructor,
    audioPrototypeValue,
    audioTypeof,
} from "./audio-surface.js";
import { compileVatMethodCall } from "./intrinsics/vat.js";
import { compilePhysicsMethodCall } from "./physics-surface.js";
import { compileCustomEventConstructor } from "./custom-events.js";
import { compileSyntheticEventConstructor } from "./synthetic-events.js";
import {
    compileBrowserFileCall,
    compileBrowserFileConstructor,
    compileBrowserFileElementAccess,
} from "./browser-file.js";
import { isNumberParserCallee, isParseFloatCallee } from "./browser-erasure.js";
import {
    hasNonNullAssertion,
    argumentAt,
    isLogicalAssignmentOperator,
    isAssignmentExpression,
    isUpdateExpression,
    expressionHasEffects,
    expressionMayRunCode,
    regularExpressionParts,
    unwrapExpression,
    wrappedParent,
} from "./syntax.js";
import {
    compileErrorConstruction,
    errorConstructor,
    refuseErrorReflection,
} from "./error-values.js";
import {
    OBJECT_STATIC_HANDLERS,
    compileObjectPrototypeCall,
    ownArray,
    ownKeysKnown,
    ownObjectEntries,
    recordPropertyKeys,
    structOwnEntries,
} from "./object-statics.js";
import { compileWindowIdentity } from "./window-events.js";
import { compileDateTimeFormat } from "./dates.js";
import {
    compileIntlConstruction,
    compileNumberLocaleString,
} from "./locale.js";
import { compileSearchParams } from "./search-params.js";
import { compileHttpFunction, compileHttpCall } from "./http.js";
import { compileWindowServiceCall } from "./window-events.js";
import { CompileError } from "./compile-error.js";
import { firstReturn } from "./loop-control.js";
import { regexpCaptureCount } from "./string-replacement.js";
import { compileAtomicsCall } from "./atomics.js";
import { compileEnumElementAccess, enumObjectSymbol } from "./enum-objects.js";
import {
    namespaceMemberName,
    namespaceSymbol,
} from "./namespace-declarations.js";
import { templateParts } from "./tagged-templates.js";
import { compileSymbolCall } from "./symbol-values.js";
import { compileBigIntUpdate, compileBigIntValue } from "./bigint-values.js";
import { unicodeUnitPattern } from "./regexp-unicode.js";
import {
    FORMATTED_MATH_FOLDS,
    mathConstantAccess,
    mathFunctionValue,
    mathMemberCall,
} from "./math-intrinsics.js";
import {
    compileCompressedJsonCall,
    compileCompressedJsonPromiseThen,
} from "./compressed-json.js";
import { compileArrayPredicateOverData } from "./data-methods.js";
import { dataTypesEqual, type DataType } from "./data-types.js";
import { readCallableProperty } from "./properties.js";
import {
    compileJsonCall,
    compileJsonRead,
    compileJsonTypeOf,
} from "./json-bridge.js";
import {
    compileWebStorageCall,
    compileWebStorageValue,
} from "./web-storage.js";
import {
    browserEnvironmentValue,
    constInitializer,
} from "./browser-erasure.js";
import {
    compileImmediatePromise,
    type PromiseLoweringContext,
} from "./promises.js";
import { staticNumberValue } from "./option-helpers.js";
import { readFrozenParticleElement } from "./particle-buffer.js";
import { pickedMeshHandleCpp } from "./properties.js";
import { absenceKind, nullability } from "./type-facts.js";
import type { Value } from "./types.js";
import type { UserFunctionContext } from "./user-functions.js";
import {
    tryResolveFunctionDeclaration,
    functionUsesDynamicThis,
} from "./user-functions.js";
import {
    booleanValue,
    commonResourceValue,
    isCompileTimeOnlyValue,
    isStringValue,
    objectTruthinessCpp,
    presenceCpp,
    presenceFlagCpp,
    staticStringValue,
} from "./types.js";
import { recordAt } from "./record-access.js";
import { pinOperand } from "./evaluation-order.js";
import { someAnalysisNode } from "./analysis-walk.js";
import type { NativeExpression } from "./closure-captures.js";

/**
 * Number formatters the language owns rather than the scene.
 *
 * What `containsEvaluatedCall` is really asking is "could dropping this
 * argument drop an effect the program still needs" -- a user function's
 * body may mutate state, so it has to run. `Number.prototype.toFixed` and
 * its siblings cannot: they read one number and return a string. Treating
 * them as calls made an erased `console.log` emit its whole formatted
 * template as a discarded statement, which is dead work whose only visible
 * trace is the compiler rejecting the discard.
 */
export const PURE_NUMBER_FORMATTERS = new EmissionSet([
    "toFixed",
    "toPrecision",
    "toExponential",
]);

/** The global URI and base64 codecs, each a runtime function of its argument's ToString. */
const URI_FUNCTIONS: ReadonlyMap<string, string> = new EmissionMap([
    ["encodeURIComponent", "encode_uri_component"],
    ["encodeURI", "encode_uri"],
    ["decodeURIComponent", "decode_uri_component"],
    ["decodeURI", "decode_uri"],
    ["btoa", "string_to_base64"],
    ["atob", "string_from_base64"],
]);

/**
 * Calls in an argument are evaluated before their enclosing call. Stop at a
 * nested function boundary because creating a callback does not execute its
 * body.
 */
function containsEvaluatedCall(node: ts.Node): boolean {
    if (ts.isFunctionLike(node)) {
        return false;
    }
    if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        PURE_NUMBER_FORMATTERS.has(node.expression.name.text)
    ) {
        // The receiver may still hold one -- `advance().toFixed(1)`.
        return containsEvaluatedCall(node.expression.expression);
    }
    if (
        ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        isAssignmentExpression(node) ||
        isUpdateExpression(node)
    ) {
        return true;
    }
    return ts.forEachChild(node, containsEvaluatedCall) ?? false;
}

export interface ExpressionContext
    extends
        PromiseLoweringContext,
        UserFunctionContext,
        Pick<
            LoweringServices,
            | "compileWorkerValue"
            | "audioSessionCpp"
            | "checker"
            | "program"
            | "sourceFile"
            | "evaluationOrder"
            | "hasStableNativeBinding"
            | "options"
            | "moduleNamespaces"
            | "recordProxies"
            | "referenceSearch"
            | "evaluator"
            | "sceneManifest"
            | "deferredCapabilities"
            | "dataLowerer"
            | "classLowerer"
            | "userFunctions"
            | "nativeFunctions"
            | "symbols"
            | "bindings"
            | "unwrap"
            | "expectArgumentCount"
            | "isInRuntimeControlFlow"
            | "emitUiDatasetProperty"
            | "refuseBorrowedPlatformEventEscape"
            | "resolveRecordValue"
            | "expectKind"
            | "expectSameEngine"
            | "activeThis"
            | "defineThis"
            | "resolveThisField"
            | "resolveStaticExpression"
            | "canvasSizeValue"
            | "propertyAccess"
            | "registerClassInstance"
            | "classOf"
            | "withRecordScopes"
            | "captureRecordScopes"
            | "captureNativeDependencies"
            | "captureNativeExpression"
            | "useNativeValue"
            | "captureEmittedStatements"
            | "emitCapturedStatements"
            | "probeEmission"
            | "nativeEmission"
            | "requireEngine"
            | "conditions"
            | "compileNumber"
            | "castNumber"
            | "compileBoolean"
            | "compileStringLiteral"
            | "assetRegistry"
            | "moduleRelativeAssetUrl"
            | "compileDynamicModuleRelativeAssetUrl"
            | "propertyName"
            | "namesLocalFunction"
            | "cppString"
            | "browserErasure"
            | "libraryGlobal"
            | "callbacks"
            | "requireDefaultEngine"
            | "defaultEngine"
            | "handleCollections"
            | "compileRegisteredConstant"
            | "compileRegisteredIntrinsic"
            | "compileThinInstanceUploadHelper"
            | "compilePixelsTextureUpload"
            | "compileStaticFetch"
            | "asyncActivations"
            | "compileBrowserTextureFunctionCall"
            | "compileExecutedUrlFunctionCall"
            | "compileExecutedVideoFunctionCall"
            | "compileStaticFetchMethod"
            | "compilePlatformCall"
            | "reachJson"
            | "reachLocalStorage"
            | "reachFileReader"
            | "compileAnimationFrameCall"
            | "compileBrowserGeneratedString"
            | "reachFeature"
            | "resolveRecordMember"
            | "compileRecordGetter"
            | "reachJsData"
            | "reachJsRandom"
            | "admissions"
            | "enterRuntimeControlFlow"
            | "leaveRuntimeControlFlow"
            | "isInRuntimeIteration"
            | "isInNativeFunctionBody"
            | "isLocalCallbackEvaluationRepeated"
            | "callbackEvaluationIdentity"
        > {}

/**
 * Whether an expression's value is an object spread's operand, directly or
 * as an arm of a conditional that is one.
 */
function spreadsItsValue(expression: ts.Expression): boolean {
    let current: ts.Expression = expression;
    for (;;) {
        const parent = wrappedParent(current);
        if (ts.isSpreadAssignment(parent)) return true;
        if (
            !ts.isConditionalExpression(parent) ||
            unwrapExpression(parent.condition) === current
        )
            return false;
        current = parent;
    }
}

/**
 * Whether a prepared conditional arm's value is read after its preparation
 * runs (`hoistedArmValue`): a record or tuple's members, or a data value's
 * found flag or identity beside its storage.
 */
function hoistsPreparedArm(value: Value): boolean {
    return value.kind === "record" || value.kind === "tuple"
        ? value.optionalFoundCpp === undefined &&
              value.objectIdentityCpp === undefined
        : value.kind === "data" &&
              (value.optionalFoundCpp !== undefined ||
                  value.objectIdentityCpp !== undefined);
}

/**
 * One operand of a string concatenation, spelled as what `bbl::js::concat`
 * appends: a literal for a generation-known text or number, `NumberPart`
 * for a runtime number, the two spellings of a boolean, an enum's name,
 * and `null`.
 */
function staticStringCoercion(value: Value): string | undefined {
    if (value.parameterBinding) return undefined;
    if (value.staticString !== undefined) return value.staticString;
    if (value.staticNumber !== undefined) return String(value.staticNumber);
    if (value.staticBoolean !== undefined) return String(value.staticBoolean);
    if (value.kind === "json-null")
        return value.cpp === "std::nullopt" ? "undefined" : "null";
    return undefined;
}

/**
 * `target += right` on string storage, wherever that storage lives. The
 * operand is spelled exactly as a concatenation part, so a chain of known
 * parts appends as one literal and a number as its JavaScript spelling,
 * and the runtime's append joins a surrogate pair split across the two
 * strings, which a plain `+=` on the native string would not.
 */
export function emitStringAppend(
    context: Pick<
        LoweringServices,
        | "absenceTags"
        | "checker"
        | "compileValue"
        | "cppString"
        | "dataTypes"
        | "fail"
        | "emit"
        | "reachJsData"
    >,
    targetCpp: string,
    right: ts.Expression,
): void {
    const value = context.compileValue(right);
    context.reachJsData();
    context.emit({
        kind: "expression",
        code: `bbl::js::concat_append(${targetCpp}, ${stringConcatPart(context, value, right)});`,
    });
}

export function stringConcatPart(
    context: Pick<
        LoweringServices,
        "checker" | "cppString" | "dataTypes" | "fail" | "absenceTags"
    >,
    value: Value,
    node: ts.Node,
): string {
    const constant = staticStringCoercion(value);
    if (constant !== undefined) return context.cppString(constant);
    // A read that may have missed its slot spells `undefined` when it did.
    if (value.slotFoundCpp && value.dataType?.kind !== "optional") {
        const { slotFoundCpp, ...read } = value;
        const present = stringConcatPart(context, read, node);
        const text = isStringValue(read)
            ? present
            : `bbl::js::concat(${present})`;
        return `(${slotFoundCpp} ? ${text} : std::string("undefined"))`;
    }
    if (isJsonValue(value)) return `${value.cpp}.to_string()`;
    if (isUndefinedDataType(value.dataType))
        return `(static_cast<void>(${value.cpp}), "undefined")`;
    if (
        value.nativeError &&
        value.recordProperties?.name &&
        value.recordProperties.message
    ) {
        return `bbl::js::error_to_string(bbl::js::concat(${stringConcatPart(context, value.recordProperties.name, node)}), bbl::js::concat(${stringConcatPart(context, value.recordProperties.message, node)}))`;
    }
    if (value.kind === "string") {
        return value.cpp;
    }
    if (value.kind === "number") {
        return `bbl::js::NumberPart(${value.cpp})`;
    }
    if (value.kind === "boolean") {
        return `(${value.cpp} ? "true" : "false")`;
    }
    if (value.kind === "data" && value.dataType?.kind === "enum") {
        return context.dataTypes.enumToStringCpp(
            value.dataType,
            value.cpp,
            node,
        );
    }
    if (value.kind === "data" && value.dataType?.kind === "string") {
        return value.cpp;
    }
    if (value.kind === "data" && value.dataType?.kind === "bigint")
        return `(${value.cpp}).to_string(10)`;
    if (value.kind === "data" && value.dataType?.kind === "symbol")
        return context.fail(
            node,
            "A symbol converts to text only through String(symbol) or its toString(); an implicit conversion throws a TypeError.",
        );
    if (value.dataType?.kind === "optional") {
        const inner = value.dataType.inner;
        const present = stringConcatPart(
            context,
            {
                kind:
                    inner.kind === "number" ||
                    inner.kind === "boolean" ||
                    inner.kind === "string"
                        ? inner.kind
                        : "data",
                cpp: "(*present)",
                dataType: inner,
            },
            node,
        );
        const absence = absenceKind(context.checker, value, node);
        if (absence === "either") {
            requireAbsenceTag(
                context.checker,
                context.absenceTags,
                node,
                value,
            );
            return context.fail(
                node,
                'A value that may be null or undefined is spelled only once one of them is ruled out (`value ?? "undefined"`).',
            );
        }
        // A read that knows whether its slot existed spells a stored `null`
        // and a missing slot apart.
        const absent =
            typeof absence === "object"
                ? `(${absence.slotFoundCpp} ? "null" : "undefined")`
                : context.cppString(
                      absence !== "unconstrained"
                          ? absence
                          : value.dataType.undefinedOnly
                            ? "undefined"
                            : "null",
                  );
        // A present string is already text; any other part is joined into one.
        const text =
            inner.kind === "string" ? present : `bbl::js::concat(${present})`;
        return `([&]() -> std::string { const auto& present = ${value.cpp}; return present.has_value() ? ${text} : std::string(${absent}); }())`;
    }
    if (
        value.dataType?.kind === "union" &&
        value.dataType.members.every(
            (member) =>
                member.kind === "number" ||
                member.kind === "boolean" ||
                member.kind === "string",
        )
    ) {
        return (
            `std::visit([](const auto& member) -> std::string { ` +
            `using T = std::decay_t<decltype(member)>; ` +
            `if constexpr (std::is_same_v<T, double>) return bbl::js::number_to_string(member); ` +
            `else if constexpr (std::is_same_v<T, bool>) return member ? "true" : "false"; ` +
            `else return member; }, ${value.cpp})`
        );
    }
    return context.fail(
        node,
        "String concatenation supports string, number, boolean, enum and null values, and absent ones of those kinds.",
    );
}

/** The properties Number.prototype, Boolean.prototype and Object.prototype define. */
const PRIMITIVE_PROTOTYPE_MEMBERS: ReadonlySet<string> = new Set([
    "constructor",
    "toExponential",
    "toFixed",
    "toPrecision",
    "toString",
    "toLocaleString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
]);

export class ExpressionLowerer {
    public constructor(private readonly context: ExpressionContext) {}

    private inRuntimeControlFlow<T>(compile: () => T): T {
        this.context.enterRuntimeControlFlow();
        try {
            return compile();
        } finally {
            this.context.leaveRuntimeControlFlow();
        }
    }

    public compileValue(expression: ts.Expression): Value {
        traceSourceNode(expression);
        // An operand already evaluated once (an assigned right side, a held
        // store key) reads back wherever the lowering reaches it.
        const held = this.context.dataLowerer.assignedValue(expression);
        if (held) return held;
        if (
            this.context.options.workers &&
            ts.isAwaitExpression(unwrapExpression(expression))
        ) {
            const awaited = this.context.compileWorkerValue(expression);
            if (awaited) return awaited;
        }
        let assertedValue: Value | undefined;
        if (
            (ts.isAsExpression(expression) ||
                ts.isTypeAssertionExpression(expression)) &&
            this.assertedTypeIncludesImportedName(expression.type, "Mesh")
        ) {
            const asserted = this.compileValue(expression.expression);
            assertedValue = asserted;
            if (asserted.kind === "scene-node") {
                return {
                    kind: "mesh",
                    cpp: `std::get<bbl::MeshHandle>(${asserted.cpp})`,
                    ...(asserted.engineCpp
                        ? { engineCpp: asserted.engineCpp }
                        : {}),
                    dataType: { kind: "handle", handle: "mesh" },
                };
            }
            if (asserted.kind === "picked-node") {
                return {
                    kind: "mesh",
                    cpp: pickedMeshHandleCpp(
                        this.context,
                        asserted,
                        expression,
                    ),
                    ...(asserted.engineCpp
                        ? { engineCpp: asserted.engineCpp }
                        : {}),
                    optionalFoundCpp:
                        `(${asserted.cpp}.picked_kind == ` +
                        `bbl::PickedNodeKind::mesh)`,
                };
            }
        }
        if (
            ts.isAsExpression(expression) ||
            ts.isTypeAssertionExpression(expression)
        ) {
            const sourceType = this.context.dataLowerer.dataTypeAt(
                expression.expression,
            );
            const assertedType =
                this.context.dataLowerer.dataTypeAt(expression);
            if (
                sourceType?.kind === "optional" &&
                assertedType &&
                dataTypesEqual(sourceType.inner, assertedType)
            ) {
                return this.context.dataLowerer.narrowOptional(
                    assertedValue ?? this.compileValue(expression.expression),
                    expression,
                );
            }
        }
        if (assertedValue) return assertedValue;
        const assertedNonNull = hasNonNullAssertion(expression);
        const unwrapped = this.context.unwrap(expression);

        if (ts.isCallExpression(unwrapped) || ts.isNewExpression(unwrapped)) {
            const formatter = compileDateTimeFormat(
                this.context.dataLowerer,
                unwrapped,
            );
            if (formatter) return formatter;
            const collator = compileIntlConstruction(
                this.context.dataLowerer,
                unwrapped,
            );
            if (collator) return collator;
        }
        const storage = compileWebStorageValue(this.context, unwrapped);
        if (storage) return storage;
        const deferredFunction =
            this.context.deferredCapabilities.functionValue(unwrapped);
        if (deferredFunction) return deferredFunction;
        const ratio = devicePixelRatioValue(this.context, unwrapped);
        if (ratio) {
            if (ratio.staticNumber === undefined)
                requireWindowHost(this.context, unwrapped);
            return ratio;
        }
        const environment = browserEnvironmentValue(this.context, unwrapped);
        if (environment) return environment;
        const http = compileHttpFunction(this.context, unwrapped);
        if (http) return http;
        const window = compileWindowIdentity(this.context, unwrapped);
        if (window) return window;
        if (this.context.browserErasure.isAbsentGlobalMember(unwrapped))
            return { kind: "json-null", cpp: "std::nullopt" };

        if (
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
        ) {
            const imported = this.context.symbols.importedName(unwrapped);
            if (imported)
                return (
                    this.context.compileRegisteredConstant(imported) ?? {
                        kind: "callback",
                        cpp: "",
                        intrinsicName: imported,
                    }
                );
        }

        if (unwrapped.kind === ts.SyntaxKind.NullKeyword) {
            return { kind: "json-null", cpp: "" };
        }
        const bigint = compileBigIntValue(this.context, unwrapped);
        if (bigint) return bigint;

        if (ts.isVoidExpression(unwrapped)) {
            // Reading a name or a literal (`void 0`) observes nothing.
            const inert = this.context.unwrap(unwrapped.expression);
            if (
                ts.isIdentifier(inert) ||
                inert.kind === ts.SyntaxKind.ThisKeyword ||
                ts.isLiteralExpression(inert) ||
                inert.kind === ts.SyntaxKind.TrueKeyword ||
                inert.kind === ts.SyntaxKind.FalseKeyword ||
                inert.kind === ts.SyntaxKind.NullKeyword
            )
                return { kind: "void", cpp: "" };
            const operand = this.compileValue(unwrapped.expression);
            return {
                kind: "void",
                cpp: operand.cpp,
            };
        }

        if (
            ts.isArrowFunction(unwrapped) ||
            ts.isFunctionExpression(unwrapped)
        ) {
            const evaluationIdentity =
                this.context.callbackEvaluationIdentity();
            const lexicalThis = ts.isArrowFunction(unwrapped)
                ? this.context.activeThis()
                : undefined;
            return {
                kind: "callback",
                cpp: "",
                callbackDeclaration: unwrapped,
                callbackRecordOwner: {
                    ...(lexicalThis ?? {
                        kind: "record" as const,
                        cpp: "",
                    }),
                    ...this.context.captureRecordScopes(),
                    ...(this.context.isInRuntimeIteration() ||
                    this.context.isInNativeFunctionBody()
                        ? { repeatedCallbackEvaluation: true }
                        : {}),
                    ...(evaluationIdentity
                        ? {
                              callbackEvaluationIdentity: evaluationIdentity,
                          }
                        : {}),
                },
            };
        }

        if (ts.isBinaryExpression(unwrapped)) {
            const assignment =
                this.context.dataLowerer.compileAssignmentValue(unwrapped);
            if (assignment) return assignment;
            if (
                this.context.browserErasure.isBrowserOnlyExpression(
                    unwrapped,
                ) &&
                this.context.browserErasure.evaluateBrowserValue(unwrapped) !==
                    undefined
            ) {
                // A chain the deployment answers (`qs.get("drive") ||
                // "Studio"`) is its folded constant wherever it is read,
                // as a name or call answering the same way already is
                // below; the native operator arms never see its null half.
                return this.compileBrowserValue(unwrapped);
            }
        }

        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
            // An engine handle collection first: the materialized asset
            // decides `container.animationGroups ?? []`, generalizing the
            // static-record rule to asset-derived collections.
            const collection =
                this.context.handleCollections.resolveNullishCollection(
                    unwrapped,
                );
            if (collection) {
                return collection;
            }
            // A static record settles the question at compile time: the
            // winning expression re-compiles with its precision kept.
            const folded = this.context.evaluator.tryResolveNullish(unwrapped);
            if (folded) {
                return this.compileSelectedOperand(folded);
            }
            // The general operator over the data model: an optional
            // selects natively with the right side lazy, and a left the
            // model proves non-nullish is the result.
            const general =
                this.context.dataLowerer.compileNullishCoalesce(unwrapped);
            if (general) {
                return general;
            }
            this.context.fail(
                unwrapped.operatorToken,
                "'??' lowers over a static record property, an " +
                    "asset-derived handle collection, a handle a " +
                    "search produced, or a data-model value (an " +
                    "optional selects at run time; a non-nullish left " +
                    "is the result). This operand is none of those.",
            );
        }
        if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) {
            const instance = this.context.activeThis();
            if (!instance) {
                this.context.fail(
                    unwrapped,
                    "'this' is only reached inside a class constructor or method.",
                );
            }
            return instance;
        }
        if (ts.isMemberName(unwrapped)) {
            // A private name is an expression only as the left operand of a
            // brand check, which nothing represents, and as the read-back of
            // a class field the constructor just bound.
            if (
                ts.isPrivateIdentifier(unwrapped) &&
                ts.isBinaryExpression(unwrapped.parent) &&
                unwrapped.parent.operatorToken.kind === ts.SyntaxKind.InKeyword
            ) {
                this.context.fail(
                    unwrapped.parent,
                    "A private brand check is lowered only as a condition.",
                );
            }
            const value = this.context.bindings.lookupOptional(unwrapped);
            if (value) {
                const narrowed =
                    value.kind === "data"
                        ? this.context.dataLowerer.narrowOptional(
                              value,
                              unwrapped,
                          )
                        : value;
                return this.materializeBrowserPrimitive(unwrapped, narrowed);
            }
            if (ts.isPrivateIdentifier(unwrapped)) {
                this.context.fail(
                    unwrapped,
                    `Private name '${unwrapped.text}' is a member, not a value.`,
                );
            }
            if (this.context.symbols.isGlobalUndefined(unwrapped)) {
                return { kind: "json-null", cpp: "std::nullopt" };
            }
            const numeric = this.context.libraryGlobal(unwrapped);
            if (numeric === "Infinity" || numeric === "NaN") {
                return {
                    kind: "number",
                    cpp: this.context.compileNumber(unwrapped, "double"),
                };
            }
            // A typed-array class as a value: what its instances' `constructor` reads.
            const typedArrayClass =
                numeric === undefined
                    ? undefined
                    : TYPED_ARRAY_KINDS.get(numeric);
            if (typedArrayClass)
                return {
                    kind: "typed-array-constructor",
                    cpp: "",
                    typedArrayConstructor: typedArrayClass,
                };
            const resolved = this.context.resolveStaticExpression(unwrapped);
            if (resolved !== unwrapped) {
                const value = this.compileValue(resolved);
                return value.kind === "regexp"
                    ? this.context.nativeEmission.materializeStaticNativeValue(
                          unwrapped,
                          value,
                      )
                    : value;
            }
            // A pinned constant a scene imports by name -- pure data the
            // intrinsic families own, not a local.
            const importedName = this.context.symbols.importedName(unwrapped);
            const constant = importedName
                ? this.context.compileRegisteredConstant(importedName)
                : undefined;
            if (constant) {
                return constant;
            }
            if (importedName)
                return {
                    kind: "callback",
                    cpp: "",
                    intrinsicName: importedName,
                    callbackDeclaration: unwrapped,
                };
            const callback = tryResolveFunctionDeclaration(
                this.context.checker,
                unwrapped,
            );
            if (callback) {
                return {
                    kind: "callback",
                    cpp: "",
                    callbackDeclaration: callback,
                    callbackRecordOwner: {
                        kind: "record",
                        cpp: "",
                        ...this.context.captureRecordScopes(),
                        ...(this.context.isLocalCallbackEvaluationRepeated(
                            callback,
                        )
                            ? {
                                  repeatedCallbackEvaluation: true as const,
                              }
                            : {}),
                    },
                };
            }
            const namespace = this.compileModuleNamespace(unwrapped);
            if (namespace) return namespace;
            if (enumObjectSymbol(this.context.checker, unwrapped))
                this.context.fail(
                    unwrapped,
                    `Enum object '${unwrapped.text}' is a value only as the receiver of a member or computed-key read.`,
                );
            if (namespaceSymbol(this.context.checker, unwrapped))
                this.context.fail(
                    unwrapped,
                    `Namespace object '${unwrapped.text}' is a value only as the receiver of a member read.`,
                );
            return this.context.bindings.lookup(unwrapped);
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const namespaceMember = namespaceMemberName(
                this.context.checker,
                unwrapped,
            );
            if (namespaceMember) return this.compileValue(namespaceMember);
            if (
                unwrapped.name.text === "url" &&
                ts.isMetaProperty(unwrapped.expression) &&
                unwrapped.expression.keywordToken ===
                    ts.SyntaxKind.ImportKeyword &&
                unwrapped.expression.name.text === "meta"
            )
                return this.compileBrowserValue(unwrapped);
            const mathFunction = mathFunctionValue(this.context, unwrapped);
            const arrayFunction = arrayFunctionValue(this.context, unwrapped);
            if (arrayFunction) return arrayFunction;
            if (mathFunction) return mathFunction;
            const audioPrototype = audioPrototypeValue(this.context, unwrapped);
            if (audioPrototype) return audioPrototype;
            const constant = enumMemberConstant(
                this.context.checker,
                unwrapped,
            );
            if (typeof constant === "string")
                return staticStringValue(constant, (text) =>
                    this.context.cppString(text),
                );
            if (typeof constant === "number")
                return numberConstantValue(constant);
            const numericConstant = numberConstant(unwrapped, (owner) =>
                this.context.libraryGlobal(owner),
            );
            if (numericConstant !== undefined)
                return numberConstantValue(numericConstant);
            const predicate = numberPredicateFunction(unwrapped, (owner) =>
                this.context.libraryGlobal(owner),
            );
            if (predicate) {
                this.context.reachJsData();
                return predicate;
            }
            // A read that descends into a parsed document has no static
            // shape to consult, so it is answered before the typed data
            // path tries to give it one.
            const json = compileJsonRead(this.context, unwrapped);
            if (json) {
                return this.context.dataLowerer.narrowOptional(
                    json,
                    expression,
                );
            }
            if (
                mathConstantAccess(unwrapped, (expression) =>
                    this.context.libraryGlobal(expression),
                )
            ) {
                const staticNumber = staticNumberValue(this.context, unwrapped);
                return {
                    kind: "number",
                    cpp: this.context.compileNumber(unwrapped, "double"),
                    ...(staticNumber === undefined ? {} : { staticNumber }),
                    dataType: { kind: "number" },
                };
            }
            const canvasSize = this.context.canvasSizeValue(unwrapped);
            if (canvasSize) {
                return canvasSize;
            }
            const data = this.context.probeEmission(() =>
                this.context.dataLowerer.compileDataPath(unwrapped, "read"),
            );
            const property =
                data ??
                this.context.propertyAccess.compilePropertyAccess(unwrapped);
            if (isJsonValue(property))
                return this.context.dataLowerer.narrowOptional(
                    property,
                    expression,
                );
            if (
                assertedNonNull &&
                property.kind === "data" &&
                property.dataType?.kind === "optional"
            ) {
                return this.context.dataLowerer.narrowOptional(
                    property,
                    expression,
                    true,
                );
            }
            if (data) {
                return data.kind === "data" &&
                    !ts.isPropertyAccessChain(unwrapped) &&
                    !data.preserveUncheckedLookup
                    ? this.context.dataLowerer.narrowOptional(data, unwrapped)
                    : data;
            }
            return property;
        }
        if (ts.isNewExpression(unwrapped)) {
            const proxy = this.context.recordProxies.construct(unwrapped);
            if (proxy) return proxy;
            const deferred =
                this.context.deferredCapabilities.compileConstructor(unwrapped);
            if (deferred) return deferred;
            const query = this.context.browserErasure.evaluateBrowserValue(
                unwrapped,
            )
                ? undefined
                : compileSearchParams(this.context.dataLowerer, unwrapped);
            if (query) return query;
            const audio = compileAudioConstructor(this.context, unwrapped);
            if (audio) return audio;
            const browserFile = compileBrowserFileConstructor(
                this.context,
                unwrapped,
            );
            if (browserFile) {
                return browserFile;
            }
            if (this.context.libraryGlobal(unwrapped.expression) === "RegExp") {
                const arguments_ = unwrapped.arguments ?? [];
                if (arguments_.length < 1 || arguments_.length > 2) {
                    this.context.fail(
                        unwrapped,
                        "RegExp expects a pattern and optional flags.",
                    );
                }
                const patternValue = this.compileValue(arguments_[0]!);
                const pattern =
                    this.context.dataLowerer.compileKnownValueForSink(
                        patternValue,
                        { kind: "string" },
                        arguments_[0]!,
                    );
                const flags = arguments_[1]
                    ? this.compileValue(arguments_[1]).staticString
                    : "";
                if (flags === undefined) {
                    this.context.fail(
                        arguments_[1]!,
                        "Reached RegExp constructor flags must be static.",
                    );
                }
                if (flags.includes("u")) {
                    if (patternValue.staticString === undefined)
                        this.context.fail(
                            arguments_[0]!,
                            "A u-flag RegExp constructor needs a pattern known at generation.",
                        );
                    return this.compileRegExp(
                        patternValue.staticString,
                        flags,
                        arguments_[1] ?? unwrapped,
                        "constructors",
                    );
                }
                for (const flag of flags) {
                    if (flag !== "g" && flag !== "i") {
                        this.context.fail(
                            arguments_[1] ?? unwrapped,
                            `Reached RegExp constructors support the g, i and u flags, not '${flag}'.`,
                        );
                    }
                }
                this.context.reachJsData();
                return {
                    kind: "regexp",
                    ...(patternValue.staticString !== undefined
                        ? {
                              regexpCaptureCount: regexpCaptureCount(
                                  patternValue.staticString,
                              ),
                          }
                        : {}),
                    cpp:
                        `bbl::js::RegExp(${pattern}, ` +
                        `${flags.includes("g") ? "true" : "false"}, ` +
                        `${flags.includes("i") ? "true" : "false"})`,
                };
            }
            const errorName = errorConstructor(unwrapped, (callee) =>
                this.context.libraryGlobal(callee),
            );
            if (errorName) {
                return compileErrorConstruction(
                    this.context,
                    unwrapped,
                    errorName,
                );
            }
            const customEvent = compileCustomEventConstructor(
                this.context,
                unwrapped,
            );
            if (customEvent) return customEvent;
            const syntheticEvent = compileSyntheticEventConstructor(
                this.context,
                unwrapped,
            );
            if (syntheticEvent) return syntheticEvent;
            const constructed =
                this.context.dataLowerer.compileNewExpression(unwrapped);
            if (constructed) {
                return constructed;
            }
            const classDeclaration =
                this.context.classLowerer.resolveClass(unwrapped);
            if (classDeclaration) {
                if (this.context.dataTypes.hasDynamicJsonStorage)
                    this.context.dataTypes.fromSharedReturnType(
                        this.context.checker.getTypeAtLocation(unwrapped),
                        unwrapped,
                    );
                const instance = this.context.classLowerer.construct(
                    unwrapped,
                    classDeclaration,
                );
                this.context.registerClassInstance(instance, classDeclaration);
                return instance;
            }
            if (
                this.context.browserErasure.isBrowserOnlyExpression(unwrapped)
            ) {
                return this.compileBrowserValue(unwrapped);
            }
            if (
                !this.context.options.workers &&
                this.context.libraryGlobal(unwrapped.expression) === "Promise"
            )
                return this.context.asyncActivations.compileSynchronousPromise(
                    unwrapped,
                );
            this.context.fail(unwrapped, "Unsupported constructor expression.");
        }
        if (ts.isElementAccessExpression(unwrapped)) {
            // `Tone["Soft"]` names an enum member as `Tone.Soft` does.
            const member = enumMemberConstant(this.context.checker, unwrapped);
            if (typeof member === "string")
                return staticStringValue(member, (text) =>
                    this.context.cppString(text),
                );
            if (typeof member === "number") return numberConstantValue(member);
            const enumLookup = compileEnumElementAccess(
                this.context,
                unwrapped,
            );
            if (enumLookup)
                return assertedNonNull
                    ? this.context.dataLowerer.narrowOptional(
                          enumLookup,
                          expression,
                          true,
                      )
                    : enumLookup;
            const value = this.compileIndexedValue(
                unwrapped,
                expression,
                assertedNonNull,
            );
            if (value) return value;
        }
        if (ts.isCallExpression(unwrapped)) {
            const joined = ts.isPropertyAccessExpression(unwrapped.expression)
                ? this.context.unwrap(unwrapped.expression.expression)
                : undefined;
            // A literal with spreads joins the array it builds at run time.
            if (
                ts.isPropertyAccessExpression(unwrapped.expression) &&
                unwrapped.expression.name.text === "join" &&
                unwrapped.arguments.length <= 1 &&
                joined &&
                ts.isArrayLiteralExpression(joined) &&
                !joined.elements.some(ts.isSpreadElement)
            ) {
                const value =
                    this.context.evaluator.compileStringLiteral(unwrapped);
                return {
                    kind: "string",
                    cpp: this.context.cppString(value),
                    staticString: value,
                    dataType: { kind: "string" },
                };
            }
            // A pure module-URL helper remains a compile-time string even
            // though its implementation uses browser URL objects. Recognize
            // it before the general browser-erasure gate so the value can
            // travel through ordinary inlined parameters into an asset sink.
            const moduleAsset = this.context.moduleRelativeAssetUrl(unwrapped);
            if (moduleAsset !== undefined) {
                return {
                    kind: "string",
                    cpp: this.context.cppString(moduleAsset),
                    staticString: moduleAsset,
                };
            }
            if (this.isNavigatorGetGamepadsCall(unwrapped)) {
                return this.compileCall(unwrapped);
            }
            if (
                this.context.browserErasure.isBrowserOnlyExpression(unwrapped)
            ) {
                return this.compileBrowserValue(unwrapped);
            }
        }
        if (ts.isCallExpression(unwrapped)) {
            const value = this.compileCall(unwrapped);
            return assertedNonNull
                ? this.context.dataLowerer.narrowOptional(
                      value,
                      expression,
                      true,
                  )
                : value;
        }
        if (ts.isConditionalExpression(unwrapped)) {
            const value = this.compileConditionalValue(unwrapped);
            if (value) return value;
        }
        if (ts.isArrayLiteralExpression(unwrapped)) {
            if (unwrapped.elements.some(ts.isSpreadElement)) {
                const expected =
                    this.context.checker.getContextualType(unwrapped);
                const destination = expected
                    ? this.context.dataTypes.fromTsType(expected, unwrapped)
                    : undefined;
                const dataType =
                    destination?.kind === "span" ||
                    destination?.kind === "vector"
                        ? {
                              kind: "vector" as const,
                              element: destination.element,
                          }
                        : this.context.dataLowerer.dataTypeAt(unwrapped);
                if (dataType?.kind !== "vector" && dataType?.kind !== "tuple")
                    return {
                        kind: "tuple",
                        cpp: "",
                        tupleElements: this.context.dataLowerer
                            .spreadLaneValues(
                                unwrapped.elements,
                                (element) =>
                                    this.builtLane(
                                        this.laneValue(element),
                                        element,
                                    ),
                                "Array spread requires a concrete native array element type.",
                            )
                            .map(({ value }) => value),
                    };
                return {
                    kind: "data",
                    cpp: this.context.dataLowerer.compileForSink(
                        unwrapped,
                        dataType,
                    ),
                    dataType,
                };
            }
            const pins = this.context.evaluationOrder.operandsToPin(
                unwrapped.elements,
            );
            return {
                kind: "tuple",
                cpp: "",
                tupleElements: unwrapped.elements.map((element, index) => {
                    const value = this.laneValue(element);
                    return pins[index]
                        ? pinOperand(
                              this.context,
                              value,
                              element,
                              "array_member",
                          )
                        : this.builtLane(value, element);
                }),
            };
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            const value = this.compileObjectValue(unwrapped);
            if (value) return value;
        }
        if (isUpdateExpression(unwrapped)) {
            const bigintUpdate = compileBigIntUpdate(this.context, unwrapped);
            if (bigintUpdate) return bigintUpdate;
            const updated =
                this.context.dataLowerer.compileUpdateValue(unwrapped);
            if (updated) return updated;
            // An operand that does not lower names its own cause first.
            this.context.compileValue(unwrapped.operand);
            this.context.fail(
                unwrapped,
                "An increment or decrement requires a number, optional number or dictionary entry.",
            );
        }
        if (ts.isTemplateExpression(unwrapped)) {
            return this.compileTemplate(unwrapped);
        }
        if (ts.isRegularExpressionLiteral(unwrapped)) {
            const { pattern, flags } =
                regularExpressionParts(unwrapped) ??
                this.context.fail(
                    unwrapped,
                    "Malformed regular expression literal.",
                );
            return this.compileRegExp(pattern, flags, unwrapped, "literals");
        }
        if (
            ts.isStringLiteral(unwrapped) ||
            ts.isNoSubstitutionTemplateLiteral(unwrapped)
        ) {
            const value = this.context.compileStringLiteral(unwrapped);
            return {
                kind: "string",
                cpp: this.context.cppString(value),
                staticString: value,
            };
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            (this.context.checker.getTypeAtLocation(unwrapped).flags &
                ts.TypeFlags.StringLike) !==
                0
        ) {
            const operands: ts.Expression[] = [];
            this.collectStringPlusOperands(unwrapped, operands);
            const pins = this.context.evaluationOrder.operandsToPin(operands);
            const values = operands.map((operand, index) => {
                const value = this.compileValue(operand);
                return pins[index]
                    ? pinOperand(this.context, value, operand, "concat_operand")
                    : value;
            });
            const parts = values.map((value, index) =>
                stringConcatPart(this.context, value, operands[index]!),
            );
            const constants = values.map(staticStringCoercion);
            const known = constants.every((value) => value !== undefined);
            this.context.reachJsData();
            return {
                kind: known ? "string" : "data",
                cpp: `bbl::js::concat(${parts.join(", ")})`,
                dataType: { kind: "string" },
                ...(known ? { staticString: constants.join("") } : {}),
            };
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            (this.context.checker.getTypeAtLocation(unwrapped).flags &
                ts.TypeFlags.Any) !==
                0
        ) {
            // Library callback rest arguments can be inferred as any even when their
            // supplied native values are concrete strings. Preserve ordinary + semantics.
            const concatenated = this.context.probeEmission(() => {
                const left = this.context.bindings.pinValueToTemporary(
                    this.compileValue(unwrapped.left),
                    "plus_left",
                    unwrapped.left,
                );
                const right = this.context.bindings.pinValueToTemporary(
                    this.compileValue(unwrapped.right),
                    "plus_right",
                    unwrapped.right,
                );
                const string = (value: Value): boolean =>
                    value.kind === "string" ||
                    value.dataType?.kind === "string" ||
                    value.dataType?.kind === "enum";
                if (!string(left) && !string(right)) return undefined;
                this.context.reachJsData();
                return this.context.dataLowerer.leafValue(
                    `bbl::js::concat(${stringConcatPart(this.context, left, unwrapped.left)}, ${stringConcatPart(this.context, right, unwrapped.right)})`,
                    { kind: "string" },
                );
            });
            if (concatenated) return concatenated;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            if (this.context.dataLowerer.pairedAbsence(unwrapped))
                return this.compileBooleanValue(unwrapped);
            const logical =
                this.context.dataLowerer.compileRecordLogicalValue(unwrapped);
            if (logical) return logical;
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            (unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken ||
                unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
            !containsEvaluatedCall(unwrapped.left)
        ) {
            let leftValue: Value | undefined;
            const truthiness = this.context.probeEmission(
                () => {
                    leftValue = this.compileValue(unwrapped.left);
                    return this.context.dataLowerer.truthinessCondition(
                        leftValue,
                    );
                },
                (condition) => condition === "true" || condition === "false",
            );
            if (truthiness === "true" || truthiness === "false") {
                const isAnd =
                    unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.AmpersandAmpersandToken;
                const selectsRight = isAnd
                    ? truthiness === "true"
                    : truthiness === "false";
                return selectsRight
                    ? this.compileValue(unwrapped.right)
                    : leftValue!;
            }
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            (unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.AmpersandAmpersandToken)
        ) {
            const logical =
                this.context.dataLowerer.compileOptionalScalarLogicalValue(
                    unwrapped,
                );
            if (logical) return logical;
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            (unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.AmpersandAmpersandToken) &&
            (this.context.checker.getTypeAtLocation(unwrapped).flags &
                ts.TypeFlags.StringLike) !==
                0
        ) {
            return this.context.dataLowerer.compileStringLogicalValue(
                unwrapped,
            );
        }
        if (this.context.evaluator.isNumberExpression(unwrapped)) {
            const staticNumber = ts.isNumericLiteral(unwrapped)
                ? Number(unwrapped.text)
                : undefined;
            return {
                kind: "number",
                // A value-position number still has JavaScript's double
                // precision. Concrete float sinks narrow it explicitly.
                cpp: this.context.compileNumber(unwrapped, "double"),
                ...(staticNumber === undefined ? {} : { staticNumber }),
            };
        }
        if (ts.isTypeOfExpression(unwrapped)) {
            const browser =
                this.context.browserErasure.evaluateBrowserValue(unwrapped);
            if (browser?.kind === "string") {
                return staticStringValue(browser.value, (text) =>
                    this.context.cppString(text),
                );
            }
            const expression = this.context.unwrap(unwrapped.expression);
            const audio = audioTypeof(this.context, expression);
            if (audio)
                return staticStringValue(audio, (text) =>
                    this.context.cppString(text),
                );
            if (expression.kind === ts.SyntaxKind.NullKeyword) {
                return {
                    kind: "string",
                    cpp: this.context.cppString("object"),
                    staticString: "object",
                };
            }
            if (
                this.context.symbols.isGlobalUndefined(expression) ||
                (ts.isIdentifier(expression) &&
                    isAbsentTypeofIdentifier(
                        this.context.checker,
                        expression,
                    ) &&
                    !this.context.bindings.lookupOptional(expression))
            ) {
                return {
                    kind: "string",
                    cpp: this.context.cppString("undefined"),
                    staticString: "undefined",
                };
            }
            const compiledOperand = this.context.compileValue(expression);
            // An unchecked tuple lookup can be absent even when TypeScript's
            // flow type lists only its declared lanes. typeof observes the
            // stored value before narrowing it to one of those lanes.
            const storedOperand = ts.isIdentifier(expression)
                ? this.context.bindings.lookupOptional(expression)
                : undefined;
            const operand = storedOperand?.preserveUncheckedLookup
                ? storedOperand
                : compiledOperand;
            if (isUndefinedDataType(operand.dataType)) {
                this.context.emitDiscardedValue(operand);
                return staticStringValue("undefined", (text) =>
                    this.context.cppString(text),
                );
            }
            if (operand.kind === "json-null") {
                return staticStringValue(
                    operand.cpp === "std::nullopt" ? "undefined" : "object",
                    (text) => this.context.cppString(text),
                );
            }
            const checked = nullability(
                this.context.checker.getTypeAtLocation(expression),
            );
            // An absent null is an "object"; which absent value this is
            // follows the one rule (`absenceKind`), asked only where the
            // operand can be absent. A run-time answer reads the slot flag.
            const absentType = (): { cpp: string; runtime: boolean } => {
                const absence = absenceKind(
                    this.context.checker,
                    operand,
                    expression,
                );
                if (absence === "either") {
                    requireAbsenceTag(
                        this.context.checker,
                        this.context.absenceTags,
                        expression,
                        operand,
                    );
                    return this.context.fail(
                        expression,
                        "typeof a value that may be null or undefined answers only once one of them is ruled out (narrow the type).",
                    );
                }
                return typeof absence === "object"
                    ? {
                          cpp: `(${absence.slotFoundCpp} ? "object" : "undefined")`,
                          runtime: true,
                      }
                    : {
                          cpp: this.context.cppString(
                              absence === "null" ? "object" : "undefined",
                          ),
                          runtime: false,
                      };
            };
            const unionType =
                operand.dataType?.kind === "optional"
                    ? operand.dataType.inner
                    : operand.dataType;
            if (unionType?.kind === "union") {
                const names = unionType.members.map((member) =>
                    this.context.cppString(
                        member.kind === "number" ||
                            member.kind === "boolean" ||
                            member.kind === "symbol" ||
                            member.kind === "bigint"
                            ? member.kind
                            : member.kind === "string" || member.kind === "enum"
                              ? "string"
                              : member.kind === "function"
                                ? "function"
                                : "object",
                    ),
                );
                const table = `std::array<const char*, ${names.length}>{${names.join(", ")}}`;
                const absent =
                    operand.dataType?.kind === "optional"
                        ? absentType()
                        : undefined;
                return {
                    kind: "string",
                    cpp: absent
                        ? `([${absent.runtime ? "&" : ""}](const auto& value) -> std::string { return value.has_value() ? ${table}[(*value).index()] : ${absent.cpp}; }(${operand.cpp}))`
                        : `std::string(${table}[(${operand.cpp}).index()])`,
                };
            }
            const documentType = compileJsonTypeOf(operand);
            if (documentType) {
                return documentType;
            }
            const dataType =
                operand.dataType?.kind === "optional"
                    ? operand.dataType.inner
                    : operand.dataType;
            const type =
                operand.kind === "number" || dataType?.kind === "number"
                    ? "number"
                    : operand.kind === "boolean" || dataType?.kind === "boolean"
                      ? "boolean"
                      : operand.kind === "string" ||
                          dataType?.kind === "string" ||
                          dataType?.kind === "enum"
                        ? "string"
                        : operand.kind === "callback" ||
                            operand.builtinConstructor !== undefined ||
                            dataType?.kind === "function" ||
                            (dataType?.kind === "struct" &&
                                this.context.dataTypes.structCall(
                                    dataType.name,
                                ) !== undefined)
                          ? "function"
                          : operand.kind === "void"
                            ? "undefined"
                            : dataType?.kind === "symbol" ||
                                dataType?.kind === "bigint"
                              ? dataType.kind
                              : "object";
            let present = presenceCpp(operand);
            if (operand.dataType?.kind === "function") {
                const callable = `static_cast<bool>(${operand.cpp})`;
                present =
                    present === undefined
                        ? callable
                        : `(${present} && ${callable})`;
            } else if (
                operand.parameterBinding &&
                !checked.undefined &&
                operand.kind !== "record"
            )
                present = undefined;
            if (present !== undefined) {
                return {
                    kind: "data",
                    cpp:
                        `(${present} ? ` +
                        `${this.context.cppString(type)} : ` +
                        `${absentType().cpp})`,
                    dataType: { kind: "string" },
                };
            }
            return {
                kind: "string",
                cpp: this.context.cppString(type),
                staticString: type,
            };
        }
        if (this.context.evaluator.isBooleanExpression(unwrapped)) {
            const staticBoolean =
                unwrapped.kind === ts.SyntaxKind.TrueKeyword
                    ? true
                    : unwrapped.kind === ts.SyntaxKind.FalseKeyword
                      ? false
                      : undefined;
            return {
                // Value position still needs the full runtime condition
                // dispatcher: a concise callback commonly returns
                // `!set.has(value)`, which is boolean but not a static
                // literal expression.
                ...this.compileBooleanValue(unwrapped),
                ...(staticBoolean === undefined ? {} : { staticBoolean }),
            };
        }
        // A comparison in value position is the same expression a
        // condition position already lowers; only where it lands differs.
        if (this.context.evaluator.isComparisonExpression(unwrapped)) {
            return this.compileBooleanValue(unwrapped);
        }
        if (this.context.browserErasure.isBrowserOnlyExpression(unwrapped)) {
            return this.compileBrowserValue(unwrapped);
        }
        // `(a, b)`: the left side runs for its effects and the value is
        // the right side's.
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
        ) {
            this.context.emitExpressionAsStatement(unwrapped.left);
            return this.compileValue(unwrapped.right);
        }
        // `(cache[key] ??= [])` in value position: the store happens as a
        // statement and the value is the target read back afterwards,
        // which after `??=` the checker already types as present.
        if (
            ts.isBinaryExpression(unwrapped) &&
            isLogicalAssignmentOperator(unwrapped.operatorToken.kind)
        ) {
            this.context.dataLowerer.emitLogicalAssignment(unwrapped);
            const target = this.context.compileValue(unwrapped.left);
            return target.kind === "data"
                ? this.context.dataLowerer.narrowOptional(
                      target,
                      unwrapped,
                      unwrapped.operatorToken.kind ===
                          ts.SyntaxKind.QuestionQuestionEqualsToken,
                  )
                : target;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const selected =
                this.context.dataLowerer.compileLogicalAndValue(unwrapped);
            if (selected) return selected;
        }

        if (ts.isTaggedTemplateExpression(unwrapped))
            return this.compileTaggedTemplate(unwrapped);
        if (ts.isClassExpression(unwrapped))
            this.context.fail(
                unwrapped,
                "A class expression is lowered as the initializer of a const it names.",
            );

        this.context.fail(
            unwrapped,
            `Unsupported value expression: ${syntaxKindName(unwrapped.kind)}.`,
        );
    }

    /** One strings-array accessor per tagged template site. */
    private readonly templateSites = new EmissionMap<
        ts.TaggedTemplateExpression,
        string
    >();

    /**
     * `tag\`...\`` calls the tag with the site's strings array, then the
     * substitutions; `String.raw` joins the raw strings and substitutions.
     */
    private compileTaggedTemplate(
        expression: ts.TaggedTemplateExpression,
    ): Value {
        const parts =
            templateParts(expression.template) ??
            this.context.fail(
                expression.template,
                "A template escape without a cooked value leaves an undefined string, which the strings array does not store.",
            );
        const tag = this.context.unwrap(expression.tag);
        if (
            ts.isPropertyAccessExpression(tag) &&
            tag.name.text === "raw" &&
            this.context.libraryGlobal(tag.expression) === "String"
        )
            return this.compileTemplateText(
                parts.raw[0]!,
                parts.substitutions.map((substitution, index) => ({
                    expression: substitution,
                    text: parts.raw[index + 1]!,
                })),
            );
        const callee = namespaceMemberName(this.context.checker, tag) ?? tag;
        if (!ts.isIdentifier(callee))
            this.context.fail(
                expression.tag,
                "A template tag is a function named by an identifier.",
            );
        this.context.reachFeature("data:tagged-template", expression);
        let accessor = this.templateSites.get(expression);
        if (!accessor) {
            const strings = (texts: readonly string[]): string =>
                `{${texts.map((text) => `std::string(${this.context.cppString(text)})`).join(", ")}}`;
            accessor =
                this.context.allocateTemporaryCppName("template_strings");
            this.context.nativeEmission.registerNativeTemplate(
                accessor,
                [
                    `inline bbl::js::Array<std::string>& ${accessor}() {`,
                    `    static thread_local bbl::js::Array<std::string> ${accessor}_value = bbl::js::template_strings(${strings(parts.cooked)}, ${strings(parts.raw)});`,
                    `    return ${accessor}_value;`,
                    "}",
                ],
                `inline bbl::js::Array<std::string>& ${accessor}();`,
            );
            this.templateSites.set(expression, accessor);
        }
        this.context.reachJsData();
        const stringsValue = this.context.dataValue(`bblscene::${accessor}()`, {
            kind: "vector",
            element: { kind: "string" },
        });
        // Substitutions run left to right before the call; one a later
        // substitution may change is read where it stands.
        let lastEffect = parts.substitutions.length - 1;
        while (
            lastEffect >= 0 &&
            !expressionMayRunCode(parts.substitutions[lastEffect]!)
        )
            lastEffect--;
        const substitutions = parts.substitutions.map((substitution, index) => {
            const value = this.compileValue(substitution);
            return index < lastEffect
                ? this.context.bindings.pinValueToTemporary(
                      value,
                      "template_substitution",
                      substitution,
                  )
                : value;
        });
        // A rest parameter takes the substitutions from its position on.
        const signature = this.context.checker.getResolvedSignature(expression);
        const parameters = signature?.getDeclaration()?.parameters ?? [];
        const rest = parameters.findIndex(
            (parameter) => parameter.dotDotDotToken !== undefined,
        );
        const arguments_: Value[] = [stringsValue, ...substitutions];
        const values =
            rest > 0
                ? [
                      ...arguments_.slice(0, rest),
                      ...(arguments_.length >= rest
                          ? [
                                {
                                    kind: "tuple" as const,
                                    cpp: "",
                                    tupleElements: arguments_.slice(rest),
                                },
                            ]
                          : []),
                  ]
                : arguments_;
        return this.context.userFunctions.compileCallbackWithValues(
            this.context,
            callee,
            values,
            expression,
        );
    }

    private assertedTypeIncludesImportedName(
        type: ts.TypeNode,
        importedName: string,
    ): boolean {
        if (ts.isParenthesizedTypeNode(type)) {
            return this.assertedTypeIncludesImportedName(
                type.type,
                importedName,
            );
        }
        if (ts.isUnionTypeNode(type)) {
            return type.types.some((member) =>
                this.assertedTypeIncludesImportedName(member, importedName),
            );
        }
        return (
            ts.isTypeReferenceNode(type) &&
            ts.isIdentifier(type.typeName) &&
            this.context.symbols.importedName(type.typeName) === importedName
        );
    }

    /**
     * A Number method's receiver. A number an asserted empty object may lack
     * stays optional for arithmetic (`undefined` reads NaN there), but a
     * method call on it reads it present: the dereference throws the
     * TypeError JavaScript throws for a method of `undefined`.
     */
    private numberMethodReceiver(expression: ts.Expression): Value {
        const value = this.compileValue(expression);
        return value.kind === "data" &&
            value.preserveUncheckedLookup &&
            value.dataType?.kind === "optional" &&
            value.dataType.inner.kind === "number"
            ? this.context.dataLowerer.narrowOptional(value, expression, true)
            : value;
    }

    /**
     * Evaluates the reached transcendental constants only when JavaScript
     * immediately formats them into generation-time source text. Ordinary
     * numeric expressions remain native so their runtime width and library
     * semantics are unchanged.
     */
    private generationTimeNumber(
        expression: ts.Expression,
    ): number | undefined {
        const staticValue = staticNumberValue(this.context, expression);
        if (staticValue !== undefined) {
            return staticValue;
        }
        const unwrapped = this.context.unwrap(expression);
        const node = this.context.resolveStaticExpression(unwrapped);
        if (node !== unwrapped) {
            const resolved = this.generationTimeNumber(node);
            if (resolved !== undefined) return resolved;
        }
        const mathCall = mathMemberCall(node, (expression) =>
            this.context.libraryGlobal(expression),
        );
        const formatted = mathCall && FORMATTED_MATH_FOLDS.get(mathCall.name);
        if (!mathCall || !formatted) {
            return undefined;
        }
        const values = mathCall.call.arguments.map((argument) =>
            this.generationTimeNumber(argument),
        );
        const numbers = values.filter(
            (value): value is number => value !== undefined,
        );
        return numbers.length === values.length &&
            numbers.length === formatted.arity
            ? formatted.fold(...numbers)
            : undefined;
    }

    private compileTemplate(expression: ts.TemplateExpression): Value {
        return this.compileTemplateText(
            expression.head.text,
            expression.templateSpans.map((span) => ({
                expression: span.expression,
                text: span.literal.text,
            })),
        );
    }

    /** A template's text: each substitution's string between the literal parts. */
    private compileTemplateText(
        head: string,
        spans: readonly { expression: ts.Expression; text: string }[],
    ): Value {
        const parts: string[] = [this.context.cppString(head)];
        let compiledStaticText = head;
        let allCompiledValuesAreStatic = true;
        let lastEffect = spans.length - 1;
        while (
            lastEffect >= 0 &&
            !expressionMayRunCode(spans[lastEffect]!.expression)
        ) {
            lastEffect--;
        }
        spans.forEach((span, index) => {
            // Resolve each substitution after its predecessors' effects. A
            // closed numeric expression keeps its fact alongside helper results.
            const known = this.context.evaluator.staticTextValue(
                span.expression,
            );
            const compiled =
                known === undefined
                    ? this.compileValue(span.expression)
                    : staticStringValue(known, (text) =>
                          this.context.cppString(text),
                      );
            const value =
                known === undefined && index <= lastEffect
                    ? this.context.bindings.pinValueToTemporary(
                          compiled,
                          "template_part",
                          span.expression,
                      )
                    : compiled;
            const staticText = staticStringCoercion(value);
            if (staticText === undefined) {
                allCompiledValuesAreStatic = false;
            } else {
                compiledStaticText += staticText;
            }
            parts.push(stringConcatPart(this.context, value, span.expression));
            parts.push(this.context.cppString(span.text));
            compiledStaticText += span.text;
        });
        if (allCompiledValuesAreStatic) {
            return {
                kind: "string",
                cpp: this.context.cppString(compiledStaticText),
                staticString: compiledStaticText,
            };
        }
        this.context.reachJsData();
        return {
            kind: "data",
            cpp: `bbl::js::concat(${parts.join(", ")})`,
            dataType: { kind: "string" },
        };
    }

    /**
     * The operands of one string concatenation, flattened: `a + b + c`
     * parses left-nested, and every nested `+` whose own type is a string
     * joins the same `bbl::js::concat` call, which builds the result in one
     * buffer. A nested numeric `+` -- `1 + 2 + "x"` -- stays an operand,
     * because its sum is what JavaScript spells.
     */
    private collectStringPlusOperands(
        node: ts.Expression,
        operands: ts.Expression[],
    ): void {
        const unwrapped = this.context.unwrap(node);
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            (this.context.checker.getTypeAtLocation(unwrapped).flags &
                ts.TypeFlags.StringLike) !==
                0
        ) {
            this.collectStringPlusOperands(unwrapped.left, operands);
            this.collectStringPlusOperands(unwrapped.right, operands);
            return;
        }
        operands.push(node);
    }

    /**
     * `binding.member(...)` through an imported module's variable whose
     * initializer stayed on the static path, which has no object for a
     * member to run against. Demand the binding's storage: its module then
     * evaluates the initializer once, in module order, and every call
     * reaches that one object.
     */
    private requireModuleReceiverStorage(callee: ts.Expression): void {
        if (!ts.isPropertyAccessExpression(callee)) return;
        const receiver = this.context.unwrap(callee.expression);
        if (
            !ts.isIdentifier(receiver) ||
            this.context.bindings.lookupOptional(receiver) ||
            this.context.resolveStaticExpression(receiver) === receiver
        )
            return;
        const declaration = initializedVariableDeclaration(
            this.context.checker,
            receiver,
        );
        const module = declaration?.parent.parent.parent;
        if (
            declaration &&
            module &&
            ts.isSourceFile(module) &&
            module !== this.context.sourceFile &&
            !this.context.program.isSourceFileFromExternalLibrary(module) &&
            !this.context.dataLowerer.context.dynamicBindings.has(declaration)
        )
            throw new DynamicBindingStorageRequired(declaration, "source");
    }

    /** A local module namespace exposes value exports in lexical key order. */
    private compileModuleNamespace(
        identifier: ts.Identifier,
    ): Value | undefined {
        return this.context.moduleNamespaces.fromIdentifier(identifier);
    }

    /** Project own keys or values, materializing vector results in source order. */
    private compileObjectProjection(
        call: ts.CallExpression,
        projection: "keys" | "values",
    ): Value {
        this.context.expectArgumentCount(call, 1, 1);
        const object = this.compileValue(argumentAt(call, 0));
        const resultType = this.context.dataLowerer.dataTypeAt(call);
        if (object.moduleNamespace && projection === "keys") {
            this.context.emitDiscardedValue(object);
            return {
                kind: "data",
                cpp: `bbl::js::Array<std::string>{${(object.recordOwnKeys ?? []).map((key) => this.context.cppString(key)).join(", ")}}`,
                dataType: { kind: "vector", element: { kind: "string" } },
                freshData: true,
            };
        }
        if (isJsonValue(object)) {
            return {
                kind: "data",
                cpp: `${object.cpp}.own_${projection}()`,
                dataType: {
                    kind: "vector",
                    element: {
                        kind: projection === "keys" ? "string" : "json",
                    },
                },
                freshData: true,
            };
        }
        const enumOrder =
            object.dataType?.kind === "enummap"
                ? this.context.dataTypes.enumMembers(object.dataType.enumName)
                : undefined;
        if (
            projection === "values" &&
            object.kind === "data" &&
            object.dataType?.kind === "enummap" &&
            (!object.recordOwnKeys ||
                object.recordOwnKeys.every(
                    (key, index) => key === enumOrder![index],
                )) &&
            resultType?.kind === "vector"
        ) {
            this.context.reachJsData();
            return {
                kind: "data",
                cpp:
                    `bbl::js::Array<${this.context.dataTypes.cppType(resultType.element)}>` +
                    `(${object.cpp}.begin(), ${object.cpp}.end())`,
                dataType: resultType,
            };
        }
        if (object.kind === "data" && object.dataType?.kind === "map") {
            // A string-keyed dictionary projects its native entries in
            // insertion order, the order JavaScript enumerates them.
            this.context.reachJsData();
            const element =
                projection === "keys"
                    ? object.dataType.key
                    : object.dataType.value;
            return {
                kind: "data",
                cpp: `bbl::js::map_${projection}(${object.cpp})`,
                dataType: { kind: "vector", element },
                freshData: true,
            };
        }
        const array =
            resultType?.kind === "vector"
                ? ownArray(this.context, object, resultType, projection, call)
                : undefined;
        if (array) return array;
        const pairs = ownObjectEntries(this.context, object, call);
        if (!pairs) {
            this.context.fail(
                argumentAt(call, 0),
                `Object.${projection} currently expects a compile-time record.`,
            );
        }
        const entries: Value[] =
            projection === "keys"
                ? pairs.map(([key]) => ({
                      kind: "string" as const,
                      cpp: this.context.cppString(key),
                      staticString: key,
                  }))
                : pairs.map(([, value]) => value);
        if (resultType?.kind === "vector") {
            this.context.reachJsData();
            return {
                kind: "data",
                cpp:
                    `bbl::js::Array<${this.context.dataTypes.cppType(resultType.element)}>{` +
                    entries
                        .map((entry) =>
                            this.context.dataLowerer.compileKnownValueForSink(
                                entry,
                                resultType.element,
                                call,
                            ),
                        )
                        .join(", ") +
                    `}`,
                dataType: resultType,
            };
        }
        return {
            kind: "tuple",
            cpp: "",
            tupleElements: entries,
        };
    }

    private compileBrowserValue(expression: ts.Expression): Value {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isCallExpression(unwrapped)) {
            for (const argument of unwrapped.arguments) {
                if (
                    !containsEvaluatedCall(argument) &&
                    !someAnalysisNode(
                        argument,
                        (node) =>
                            (ts.isPropertyAccessExpression(node) ||
                                ts.isElementAccessExpression(node)) &&
                            (accessedPropertySymbol(
                                this.context.checker,
                                node,
                            )?.declarations?.some(
                                ts.isGetAccessorDeclaration,
                            ) ??
                                false),
                        { functions: "skip", types: "skip" },
                    )
                ) {
                    continue;
                }
                const value = this.compileValue(argument);
                this.context.emitDiscardedValue(value);
            }
        }
        const browserValue =
            this.context.browserErasure.evaluateBrowserValue(expression);
        return this.materializeBrowserPrimitive(expression, {
            kind: "browser",
            cpp: "",
            ...(browserValue ? { browserValue } : {}),
        });
    }

    private materializeBrowserPrimitive(
        expression: ts.Expression,
        value: Value,
    ): Value {
        if (value.kind !== "browser" || !value.browserValue) {
            return value;
        }
        switch (value.browserValue.kind) {
            case "number":
                return {
                    kind: "number",
                    cpp: this.context.compileNumber(expression),
                    ...(Number.isFinite(value.browserValue.value)
                        ? {
                              staticNumber: value.browserValue.value,
                          }
                        : {}),
                };
            case "boolean":
                return {
                    kind: "boolean",
                    cpp: value.browserValue.value ? "true" : "false",
                };
            case "string":
                return {
                    kind: "string",
                    cpp: this.context.cppString(value.browserValue.value),
                    staticString: value.browserValue.value,
                };
            case "null":
                return { kind: "json-null", cpp: "" };
            case "undefined":
                return { kind: "json-null", cpp: "std::nullopt" };
            case "dom-rect":
            case "object":
            case "search-params":
                return value;
        }
    }

    /**
     * `setTimeout(callback, 0)` uses the deferred queue the engine drains at
     * the next frame boundary. A generation-known non-zero delay uses the
     * conductor's one-shot timer queue, preserving elapsed-time semantics
     * without introducing a timer thread or a JavaScript-thread marshal.
     */
    private compileDeferredCallback(call: ts.CallExpression): Value {
        this.context.expectArgumentCount(call, 2, 2);
        if (!this.context.defaultEngine() && !this.context.options.workers)
            throw new ApplicationRealmRequired();
        const delay = staticNumberValue(this.context, argumentAt(call, 1));
        if (delay !== 0) {
            if (
                this.context.browserErasure.isBrowserOnlyHandler(
                    this.context.unwrap(argumentAt(call, 0)),
                )
            ) {
                return { kind: "void", cpp: "" };
            }

            if (delay === undefined || !Number.isFinite(delay) || delay < 0) {
                this.context.fail(
                    argumentAt(call, 1),
                    "setTimeout delay must be a generation-known finite non-negative number.",
                );
            }
            const engine = this.context.requireDefaultEngine(call);
            const callback = this.context.callbacks.compileFrameCallback(
                argumentAt(call, 0),
                "void",
            );
            return {
                kind: "number",
                cpp: `bbl::set_timeout(${engine}, ${callback}, ${delay})`,
                impure: true,
            };
        }
        const engine = this.context.requireDefaultEngine(call);
        const callback = this.context.callbacks.compileFrameCallback(
            argumentAt(call, 0),
            "void",
        );
        return {
            kind: "void",
            cpp: `bbl::defer_callback(${engine}, ${callback})`,
        };
    }

    /**
     * One lane of a tuple or static record.
     *
     * A lane outlives the expression that produced it: it is stored on the
     * record and read back later, by a sink this position cannot see. Its
     * `cpp` is compiled once, at the default float width, so a lane that
     * carries only text hands a double sink a value already rounded — at
     * large-world coordinates that is half a unit, enough to move a
     * silhouette. Recording the static value generation can fold is what
     * lets `castNumber` write the lane at each sink's own width instead.
     *
     * Only lanes take this, and the boundary is load-bearing rather than
     * merely tidy. `staticNumber` is also what `compileCondition` and
     * `staticTextValue` read to decide a value is a compile-time constant,
     * and an unrolled loop's index binding carries one — so recording the
     * fold on EVERY number Value additionally folds conditions over a loop
     * index. Measured: it collapses `index % 11 === 0 ? 40 : 28` per
     * iteration across scenes 50, 92, 93 and 97, and elides a function in
     * `regression-runtime-sweep`. Those folds are not wrong, but they are a
     * different change with their own measurement, so this one stops at the
     * position whose width is genuinely undecided: a lane, which is stored
     * and read back by a sink it cannot see. A number in an ordinary
     * expression position is consumed where it is written, already at the
     * width that position asked for.
     * `test/compiler.test.ts` pins both halves.
     */
    private laneValue(expression: ts.Expression): Value {
        const raw = this.context.compileValue(expression);
        const value =
            raw.kind === "data" && !raw.preserveUncheckedLookup
                ? this.context.dataLowerer.narrowOptional(raw, expression)
                : raw;
        // Array/object members retain the result of a resource-producing call.
        // Reusing the member must never execute its factory again.
        if (
            isHandleKind(value.kind) &&
            containsEvaluatedCall(expression) &&
            !value.nativeBinding
        ) {
            return this.context.bindings.pinValueToTemporary(
                value,
                "resource_member",
                expression,
            );
        }
        if (value.kind !== "number" || value.staticNumber !== undefined) {
            return value;
        }
        const staticNumber = staticNumberValue(this.context, expression);
        return staticNumber === undefined ? value : { ...value, staticNumber };
    }

    /**
     * A lane holds the value its initializer had when the tuple or record is
     * built. The compile-time value keeps no storage of its own -- each use
     * re-emits the lane's expression -- so a lane whose expression reads
     * storage some code writes, or repeats an effect (`Math.random()`),
     * records that expression: the lane is read into a temporary once the
     * aggregate outlives the statement that builds it
     * (`BindingScopes.settleBuiltValue`), while a sink consuming it in that
     * statement reads it in place.
     */
    private builtLane(value: Value, node: ts.Expression): Value {
        const holdsItsValue =
            value.cpp === "" ||
            value.kind === "callback" ||
            value.kind === "record" ||
            value.kind === "tuple" ||
            isCompileTimeOnlyValue(value.kind) ||
            this.context.hasStableNativeBinding(value);
        return holdsItsValue ||
            !this.context.evaluationOrder.touchesStorage(node)
            ? value
            : { ...value, builtFrom: { node, cpp: value.cpp } };
    }

    /**
     * `condition ? whenTrue : whenFalse` for two already-compiled values.
     * Both branches must name the same kind of native expression, since
     * the result has to be one expression the caller can use.
     */
    /**
     * A conditional branch's resource value with its preparation moved into
     * the lambda that spells it, so `selectValue` selects it lazily. A
     * record or tuple, or a value read beside a found flag or identity, is
     * built by a lambda run only when `guard` selects the arm and read from
     * what it returned (`hoistedArmValue`); one whose members cannot move
     * refuses.
     */
    private lazyArmValue(
        arm: { value: Value; lines: string[] },
        node: ts.Expression,
        guard: () => string,
    ): Value {
        if (arm.lines.length === 0) return arm.value;
        const value =
            projectAssetContainer(this.context, arm.value, node) ?? arm.value;
        const hoisted = hoistsPreparedArm(value)
            ? this.hoistedArmValue(arm.lines, value, node, guard)
            : undefined;
        if (hoisted) return hoisted;
        if (
            value.kind === "record" ||
            value.kind === "tuple" ||
            value.optionalFoundCpp !== undefined ||
            value.objectIdentityCpp !== undefined
        )
            return this.context.fail(
                node,
                "A conditional branch that prepares a record, tuple or searched value must be bound to its own declaration first.",
            );
        return {
            ...value,
            cpp: this.context.dataLowerer.armExpression(
                node,
                arm.lines,
                value.cpp,
            ),
        };
    }

    /**
     * A prepared record or tuple arm whose run-time members a lambda
     * returns as one tuple, called only when `guard` holds; undefined when
     * a member has no plain native value to move.
     */
    private hoistedArmValue(
        lines: readonly string[],
        value: Value,
        node: ts.Expression,
        guard: () => string,
    ): Value | undefined {
        if (
            this.context.options.workers &&
            someAnalysisNode(node, ts.isAwaitExpression, { functions: "skip" })
        )
            return undefined;
        // Every member is a record, a tuple, a compile-time value or a plain
        // native value the tuple can hold.
        const movable = (member: Value): boolean =>
            member.kind === "record"
                ? !member.classDeclaration &&
                  Object.keys(member.recordMethods ?? {}).length === 0 &&
                  Object.keys(member.recordGetters ?? {}).length === 0 &&
                  Object.keys(member.recordSetters ?? {}).length === 0 &&
                  Object.values(member.recordProperties ?? {}).every(movable)
                : member.kind === "tuple"
                  ? (member.tupleElements ?? []).every(movable)
                  : member.cpp.length === 0 ||
                    member.staticNumber !== undefined ||
                    member.staticString !== undefined ||
                    member.staticBoolean !== undefined ||
                    (member.kind === "data" && member.dataType !== undefined) ||
                    member.kind === "number" ||
                    member.kind === "boolean" ||
                    member.kind === "string";
        if (!movable(value)) return undefined;
        const members: Value[] = [];
        const expressions: string[] = [];
        const holder = this.context.allocateTemporaryCppName("arm_members");
        // One run-time spelling moved into the returned tuple.
        const move = (cpp: string): string => {
            expressions.push(cpp);
            return `std::get<${expressions.length - 1}>(*${holder})`;
        };
        const moved = (member: Value): Value => {
            if (member.kind === "record")
                return {
                    kind: "record",
                    cpp: "",
                    recordProperties: Object.fromEntries(
                        Object.entries(member.recordProperties ?? {}).map(
                            ([key, property]) => [key, moved(property)],
                        ),
                    ),
                };
            if (member.kind === "tuple")
                return {
                    kind: "tuple",
                    cpp: "",
                    tupleElements: (member.tupleElements ?? []).map(moved),
                };
            if (
                member.cpp.length === 0 ||
                member.staticNumber !== undefined ||
                member.staticString !== undefined ||
                member.staticBoolean !== undefined
            )
                return member;
            members.push(member);
            const kind = member.kind;
            // A string is stored as one, so every read references it.
            const read = move(
                kind === "string" ? `std::string(${member.cpp})` : member.cpp,
            );
            const result: Value =
                kind === "data" && member.dataType
                    ? this.context.dataLowerer.leafValue(read, member.dataType)
                    : {
                          kind:
                              kind === "number" || kind === "string"
                                  ? kind
                                  : "boolean",
                          cpp: read,
                      };
            // A found flag, stated truthiness or identity is read beside
            // the value.
            return {
                ...result,
                ...(member.optionalFoundCpp !== undefined
                    ? { optionalFoundCpp: move(member.optionalFoundCpp) }
                    : {}),
                ...(member.truthinessCpp !== undefined
                    ? { truthinessCpp: move(member.truthinessCpp) }
                    : {}),
                ...(member.objectIdentityCpp !== undefined
                    ? { objectIdentityCpp: move(member.objectIdentityCpp) }
                    : {}),
                ...(member.conditionalOwnKey
                    ? { conditionalOwnKey: true as const }
                    : {}),
            };
        };
        const rebuilt = moved(value);
        // The condition, read once, is pinned ahead of the arm.
        const selected = guard();
        const build = this.context.allocateTemporaryCppName("arm_build");
        for (const member of members) this.context.useNativeValue(member);
        const tuple = `std::make_tuple(${expressions.join(", ")})`;
        this.context.emit({
            kind: "declaration",
            type: "const auto",
            name: build,
            initializer: `[&]() {\n${lines.join("\n")}\nreturn ${tuple};\n}`,
        });
        this.context.emit({
            kind: "declaration",
            type: `std::optional<decltype(${build}())>`,
            name: holder,
            initializer: "",
            initialization: "default",
        });
        const binding = this.context.registerNativeBinding(holder);
        this.context.emit({
            kind: "expression",
            code: `if (${selected}) ${holder}.emplace(${build}());`,
        });
        const capture = (member: Value): Value =>
            member.kind === "record"
                ? {
                      ...member,
                      recordProperties: Object.fromEntries(
                          Object.entries(member.recordProperties ?? {}).map(
                              ([key, property]) => [key, capture(property)],
                          ),
                      ),
                  }
                : member.kind === "tuple"
                  ? {
                        ...member,
                        tupleElements: (member.tupleElements ?? []).map(
                            capture,
                        ),
                    }
                  : [
                          member.cpp,
                          member.optionalFoundCpp,
                          member.truthinessCpp,
                          member.objectIdentityCpp,
                      ].some((cpp) => cpp?.includes(holder))
                    ? { ...member, nativeCaptures: [binding] }
                    : member;
        return capture(rebuilt);
    }

    private compileBooleanValue(expression: ts.Expression): Value {
        let value: Value = { kind: "boolean", cpp: "" };
        const lines = this.context.captureEmittedStatements(() => {
            value = {
                kind: "boolean",
                ...this.context.captureNativeExpression(() =>
                    this.context.conditions.compileCondition(expression),
                ),
            };
        });
        this.context.emitCapturedStatements(lines);
        return lines.length
            ? this.context.bindings.pinValueToTemporary(
                  value,
                  "condition_value",
                  expression,
              )
            : value;
    }

    private selectValue(
        selection: NativeExpression,
        whenTrue: Value,
        whenFalse: Value,
        node: ts.Node,
        path: readonly string[] = [],
    ): Value {
        this.context.dataLowerer.invalidateRecordArrayFacts(whenTrue);
        this.context.dataLowerer.invalidateRecordArrayFacts(whenFalse);
        const selected = this.selectValueInner(
            selection,
            whenTrue,
            whenFalse,
            node,
            path,
        );
        // Static aggregates retain their dependencies on each selected lane.
        // Every native expression also reads its condition, even when a branch
        // is a literal or an optional carrier has no additional storage.
        if (selected.kind === "record" || selected.kind === "tuple")
            return selected;
        const { nativeCaptures } = this.context.captureNativeDependencies(
            () => {
                this.context.useNativeValue(whenTrue);
                this.context.useNativeValue(whenFalse);
                this.context.useNativeValue(selected);
            },
        );
        return {
            ...selected,
            nativeCaptures: [
                ...new Set([...selection.nativeCaptures, ...nativeCaptures]),
            ],
        };
    }

    /**
     * `path` names the record member or tuple element of the conditional
     * `node`'s result being selected, for {@link selectedDataType}.
     */
    private selectValueInner(
        selection: NativeExpression,
        whenTrue: Value,
        whenFalse: Value,
        node: ts.Node,
        path: readonly string[],
    ): Value {
        const condition = selection.cpp;
        if (whenTrue.kind !== whenFalse.kind) {
            const trueAsset = projectAssetContainer(
                this.context,
                whenTrue,
                node,
            );
            const falseAsset = projectAssetContainer(
                this.context,
                whenFalse,
                node,
            );
            if (trueAsset && falseAsset) {
                whenTrue = trueAsset;
                whenFalse = falseAsset;
            }
        }
        if (
            whenTrue.kind !== whenFalse.kind &&
            ((whenTrue.kind === "record" &&
                whenFalse.kind === "data" &&
                whenFalse.dataType?.kind === "struct") ||
                (whenFalse.kind === "record" &&
                    whenTrue.kind === "data" &&
                    whenTrue.dataType?.kind === "struct"))
        ) {
            const data = whenTrue.kind === "data" ? whenTrue : whenFalse;
            const record = whenTrue.kind === "record" ? whenTrue : whenFalse;
            const dataType = data.dataType!;
            const projected: Value = {
                kind: "data",
                cpp: this.context.dataLowerer.compileKnownValueForSink(
                    record,
                    dataType,
                    node,
                ),
                dataType,
            };
            if (whenTrue.kind === "record") {
                whenTrue = projected;
            } else {
                whenFalse = projected;
            }
        }
        if (whenTrue.kind === "tuple" && whenFalse.kind === "tuple") {
            const trueElements = whenTrue.tupleElements ?? [];
            const falseElements = whenFalse.tupleElements ?? [];
            if (trueElements.length !== falseElements.length) {
                this.context.fail(
                    node,
                    "Conditional tuple branches must have the same length.",
                );
            }
            return {
                kind: "tuple",
                cpp: "",
                tupleElements: trueElements.map((element, index) =>
                    this.selectValue(
                        selection,
                        element,
                        falseElements[index]!,
                        node,
                        [...path, String(index)],
                    ),
                ),
            };
        }
        // Two records select member by member, the way two tuples select
        // element by element: a record is a compile-time property map
        // with no native expression of its own. The shared property
        // names are the condition for that to be the same thing.
        if (whenTrue.kind === "record" && whenFalse.kind === "record") {
            const trueClass = this.context.classOf(whenTrue);
            const falseClass = this.context.classOf(whenFalse);
            const trueProperties = whenTrue.recordProperties ?? {};
            const falseProperties = whenFalse.recordProperties ?? {};
            const trueNames = Object.keys(trueProperties);
            const falseNames = Object.keys(falseProperties);
            const names = [...trueNames];
            for (const name of falseNames) {
                if (!names.includes(name)) names.push(name);
            }
            const differingShape =
                trueNames.length !== falseNames.length ||
                names.some(
                    (name) =>
                        trueProperties[name] === undefined ||
                        falseProperties[name] === undefined,
                );
            if (
                differingShape &&
                (trueClass !== undefined ||
                    falseClass !== undefined ||
                    Object.keys(whenTrue.recordMethods ?? {}).length > 0 ||
                    Object.keys(whenFalse.recordMethods ?? {}).length > 0 ||
                    Object.keys(whenTrue.recordGetters ?? {}).length > 0 ||
                    Object.keys(whenFalse.recordGetters ?? {}).length > 0 ||
                    Object.keys(whenTrue.recordSetters ?? {}).length > 0 ||
                    Object.keys(whenFalse.recordSetters ?? {}).length > 0)
            ) {
                this.context.fail(
                    node,
                    "Conditional class or accessor records must carry the same properties.",
                );
            }
            const selected: Record<string, Value> = {};
            for (const name of names) {
                const trueValue = trueProperties[name];
                const falseValue = falseProperties[name];
                if (trueValue && falseValue) {
                    const merged = this.selectValue(
                        selection,
                        trueValue,
                        falseValue,
                        node,
                        [...path, name],
                    );
                    selected[name] =
                        trueValue.conditionalOwnKey ||
                        falseValue.conditionalOwnKey
                            ? { ...merged, conditionalOwnKey: true }
                            : merged;
                    continue;
                }
                const present = trueValue ?? falseValue!;
                // The record holds the array a compile-time member builds,
                // so a readonly one owns its storage as a returned one does.
                const memberType =
                    present.dataType === undefined &&
                    present.kind !== "number" &&
                    present.kind !== "boolean" &&
                    present.kind !== "string"
                        ? this.selectedDataType(node, [...path, name], true)
                        : undefined;
                const inner =
                    present.dataType ??
                    (present.kind === "number"
                        ? { kind: "number" as const }
                        : present.kind === "boolean"
                          ? { kind: "boolean" as const }
                          : present.kind === "string"
                            ? { kind: "string" as const }
                            : memberType &&
                              this.context.dataTypes.ownReturnedArray(
                                  memberType,
                              ));
                if (!inner) {
                    this.context.fail(
                        node,
                        `Conditional record property '${name}' must have one native data type.`,
                    );
                }
                // The registry's nullable rule keeps a reference struct bare,
                // so its absent arm is the null reference.
                const optional = this.context.dataTypes.nullableType(inner);
                const { value: valueCpp, nativeCaptures } =
                    this.context.captureNativeDependencies(() =>
                        this.context.dataLowerer.compileKnownValueForSink(
                            present,
                            inner,
                            node,
                        ),
                    );
                const populated =
                    inner.kind === "optional"
                        ? valueCpp
                        : this.context.dataTypes.presentValue(
                              optional,
                              valueCpp,
                          );
                const absent = this.context.dataTypes.absentValue(optional);
                const populatedValue: Value = {
                    kind: "data",
                    cpp: populated,
                    dataType: optional,
                    nativeCaptures,
                };
                const absentValue: Value = {
                    kind: "data",
                    cpp: absent,
                    dataType: optional,
                };
                // The key is own only where its arm was taken.
                selected[name] = {
                    ...this.selectValue(
                        selection,
                        trueValue ? populatedValue : absentValue,
                        trueValue ? absentValue : populatedValue,
                        node,
                        [...path, name],
                    ),
                    conditionalOwnKey: true,
                };
            }
            const selectedRecord: Value = {
                kind: "record",
                cpp: "",
                recordProperties: selected,
            };
            if (trueClass && trueClass === falseClass) {
                writable(selectedRecord).classDeclaration = trueClass;
                if (whenTrue.recordGetters) {
                    writable(selectedRecord).recordGetters =
                        whenTrue.recordGetters;
                }
            }
            return selectedRecord;
        }
        if (
            whenTrue.kind === "handle-collection" &&
            whenFalse.kind === "handle-collection" &&
            whenTrue.handleCollection &&
            whenFalse.handleCollection
        ) {
            const trueCollection = whenTrue.handleCollection;
            const falseCollection = whenFalse.handleCollection;
            if (
                trueCollection.elementKind !== falseCollection.elementKind ||
                trueCollection.elementCppType !==
                    falseCollection.elementCppType ||
                trueCollection.engineCpp !== falseCollection.engineCpp
            ) {
                this.context.fail(
                    node,
                    "Conditional handle collections must carry the same element and engine types.",
                );
            }
            return {
                kind: "handle-collection",
                cpp: "",
                engineCpp: trueCollection.engineCpp,
                handleCollection: {
                    property: trueCollection.property,
                    elementKind: trueCollection.elementKind,
                    elementCppType: trueCollection.elementCppType,
                    engineCpp: trueCollection.engineCpp,
                    temporaryLabel: "selected_handles",
                    containerCpp:
                        `(${condition} ? ${trueCollection.containerCpp} : ` +
                        `${falseCollection.containerCpp})`,
                },
            };
        }
        // A literal string and a string READ OUT OF A RECORD are the same
        // type; only the kinds differ, because one carries a compile-time
        // value and the other does not. The element-access path already
        // treats the pair as one (a dynamic record key is either), and a
        // branch that picks between a record's string and a literal -- the
        // shape a pick result's name takes -- is the same question. The
        // literal side widens, since `std::string` is the common type of
        // the emitted conditional either way.
        if (
            whenTrue.kind !== whenFalse.kind &&
            isStringValue(whenTrue) &&
            isStringValue(whenFalse)
        ) {
            // Only the literal side moves, and it carries nothing across:
            // spreading the other branch would hand each side the other's
            // `engineCpp`, which is what the mismatch check below exists
            // to catch.
            const asStringData = (value: Value): Value =>
                value.kind === "string"
                    ? {
                          kind: "data",
                          cpp: value.cpp,
                          dataType: { kind: "string" },
                      }
                    : value;
            whenTrue = asStringData(whenTrue);
            whenFalse = asStringData(whenFalse);
        }
        // A tuple LITERAL and a tuple a call RETURNED are the same type,
        // and only the kinds differ: one is a compile-time element list,
        // the other native storage. The literal side widens, the way the
        // string pair above does -- selecting element by element instead
        // would evaluate the returning branch once per element, which is
        // what `normalizeVec3(...) : [0, 0, -1]` would turn into.
        const tupleArity = (value: Value): number | undefined =>
            value.kind === "tuple"
                ? value.tupleElements?.length
                : value.kind === "data" && value.dataType?.kind === "tuple"
                  ? value.dataType.arity
                  : undefined;
        const sharedArity = tupleArity(whenTrue);
        if (
            whenTrue.kind !== whenFalse.kind &&
            sharedArity !== undefined &&
            sharedArity === tupleArity(whenFalse)
        ) {
            this.context.reachJsData();
            const asTupleData = (value: Value): Value =>
                value.kind === "tuple"
                    ? {
                          kind: "data",
                          cpp: this.context.dataLowerer.compileKnownValueForSink(
                              value,
                              { kind: "tuple", arity: sharedArity },
                              node,
                          ),
                          dataType: {
                              kind: "tuple",
                              arity: sharedArity,
                          },
                      }
                    : value;
            whenTrue = asTupleData(whenTrue);
            whenFalse = asTupleData(whenFalse);
        }
        // A value that already MODELS absence, guarded and defaulted to
        // `null`: `info.hit ? info.pickedMesh : null`. Upstream both arms
        // are the one nullable reference the field is, and this port spells
        // that reference as the value plus its own presence test -- so the
        // guard is not a second native branch to select, it is another term
        // of that test. `null` carries no native storage of its own, which
        // is exactly why it cannot be selected as one, and conjoining the
        // condition is what a JavaScript reader means by the whole
        // expression. The condition is duplicated into the presence test
        // the way the branch-selecting path below duplicates it; it is a
        // read of the same record here.
        const nullDefaulted = (
            present: Value,
            absent: Value,
            found: string,
        ): Value | undefined =>
            absent.kind === "json-null" &&
            absent.cpp.length === 0 &&
            present.kind !== "json-null" &&
            present.cpp.length > 0 &&
            presenceFlagCpp(present) !== undefined
                ? {
                      ...present,
                      optionalFoundCpp: `(${found} && ${presenceFlagCpp(present)})`,
                  }
                : undefined;
        if (whenTrue.kind !== whenFalse.kind) {
            const guarded =
                nullDefaulted(whenTrue, whenFalse, condition) ??
                nullDefaulted(whenFalse, whenTrue, `!(${condition})`);
            if (guarded) return guarded;
        }
        // Two arms that both read as `undefined` (a void call, `undefined`):
        // the selected one runs for its effects.
        const undefinedArm = (value: Value): boolean =>
            (value.kind === "void" &&
                !value.abruptCompletion &&
                !value.coroutineResult) ||
            (value.kind === "json-null" && value.cpp === "std::nullopt");
        if (
            whenTrue.kind !== whenFalse.kind &&
            undefinedArm(whenTrue) &&
            undefinedArm(whenFalse)
        ) {
            const effect = (value: Value): string =>
                value.kind === "void" && value.cpp.length > 0
                    ? `static_cast<void>(${value.cpp})`
                    : "void()";
            return {
                kind: "void",
                cpp: `(${condition} ? ${effect(whenTrue)} : ${effect(whenFalse)})`,
            };
        }
        // Data-model branches of different native kinds, or one without
        // storage of its own (a literal record, a function, `null`), select
        // as the storage of the conditional's type, each converted inside its
        // own arm; a type the checker cannot name is the one data branch's
        // own. Engine resources and promises keep the refusal below.
        const dataModel = (value: Value): boolean =>
            [
                "data",
                "number",
                "boolean",
                "string",
                "record",
                "tuple",
                "callback",
                "json-null",
            ].includes(value.kind);
        if (
            (whenTrue.kind !== whenFalse.kind ||
                whenTrue.cpp.length === 0 ||
                whenFalse.cpp.length === 0) &&
            dataModel(whenTrue) &&
            dataModel(whenFalse)
        ) {
            const data =
                whenTrue.kind === "data" && whenFalse.kind !== "data"
                    ? whenTrue
                    : whenFalse.kind === "data" && whenTrue.kind !== "data"
                      ? whenFalse
                      : undefined;
            const type = this.selectedDataType(node, path) ?? data?.dataType;
            const converted =
                type &&
                this.context.probeEmission(() => {
                    try {
                        return [
                            this.selectedArmValue(whenTrue, type, node),
                            this.selectedArmValue(whenFalse, type, node),
                        ] as const;
                    } catch (error) {
                        if (error instanceof CompileError) return undefined;
                        throw error;
                    }
                });
            if (converted) [whenTrue, whenFalse] = converted;
        }
        if (
            whenTrue.kind !== whenFalse.kind ||
            whenTrue.cpp.length === 0 ||
            whenFalse.cpp.length === 0 ||
            (whenTrue.engineCpp &&
                whenFalse.engineCpp &&
                whenTrue.engineCpp !== whenFalse.engineCpp)
        ) {
            this.context.fail(
                node,
                "Conditional expressions require matching native value branches " +
                    `(received ${whenTrue.kind}${whenTrue.cpp.length === 0 ? " without native storage" : ""} ` +
                    `and ${whenFalse.kind}${whenFalse.cpp.length === 0 ? " without native storage" : ""}).`,
            );
        }
        const conditional = commonResourceValue(
            {
                ...whenTrue,
                cpp: `(${condition} ? ${whenTrue.cpp} : ${whenFalse.cpp})`,
            },
            [whenTrue, whenFalse],
        );
        if (whenTrue.nativeLvalue && whenFalse.nativeLvalue) {
            // The C++ conditional operator preserves lvalue category when
            // both branches are lvalues of the same type. Class selection
            // relies on that to pass the selected field by reference.
            writable(conditional).nativeLvalue = true;
        } else {
            delete writable(conditional).nativeLvalue;
        }
        const trueFound = presenceFlagCpp(whenTrue);
        const falseFound = presenceFlagCpp(whenFalse);
        if (trueFound !== undefined || falseFound !== undefined) {
            writable(conditional).optionalFoundCpp =
                `(${condition} ? ` +
                `${trueFound ?? "true"} : ` +
                `${falseFound ?? "true"})`;
        }
        if (whenTrue.staticNumber !== whenFalse.staticNumber) {
            delete writable(conditional).staticNumber;
        }
        if (whenTrue.staticString !== whenFalse.staticString) {
            delete writable(conditional).staticString;
        }
        if (whenTrue.spriteDepthMode !== whenFalse.spriteDepthMode) {
            delete writable(conditional).spriteDepthMode;
        }
        return conditional;
    }

    /**
     * The storage of what the conditional `node` selects at `path` (a
     * member or element of its result): its type where the conditional is
     * expected (a spread into a typed record), else in the conditional or
     * one of its arms. `present` asks for the member one arm's record
     * holds: without the absence the other arm adds, and owning its array
     * even where the type is readonly.
     */
    private selectedDataType(
        node: ts.Node,
        path: readonly string[],
        present = false,
    ): DataType | undefined {
        if (!ts.isConditionalExpression(node)) return undefined;
        const checker = this.context.checker;
        const at = (type: ts.Type | undefined): ts.Type | undefined => {
            for (const name of path) {
                const property =
                    type &&
                    checker.getPropertyOfType(
                        checker.getNonNullableType(type),
                        name,
                    );
                type =
                    property &&
                    checker.getTypeOfSymbolAtLocation(property, node);
            }
            return type && present ? checker.getNonNullableType(type) : type;
        };
        for (const owner of [
            checker.getContextualType(node),
            checker.getTypeAtLocation(node),
            checker.getTypeAtLocation(node.whenTrue),
            checker.getTypeAtLocation(node.whenFalse),
        ]) {
            const type = at(owner);
            const mapped =
                type && this.context.dataTypes.fromStoredTsType(type, node);
            if (mapped)
                return present
                    ? this.context.dataTypes.ownReadonlyArray(mapped, type)
                    : mapped;
        }
        return undefined;
    }

    /**
     * A conditional arm's value as `type`'s storage. A conversion that
     * prepares its value runs inside the arm's lambda, so only the selected
     * arm converts.
     */
    private selectedArmValue(
        value: Value,
        type: DataType,
        node: ts.Node,
    ): Value {
        if (
            value.kind === "data" &&
            value.dataType &&
            dataTypesEqual(value.dataType, type)
        )
            return value;
        const {
            value: { value: cpp, lines },
            nativeCaptures,
        } = this.context.captureNativeDependencies(() =>
            this.context.dataLowerer.compileArm(() =>
                this.context.dataLowerer.compileKnownValueForSink(
                    value,
                    type,
                    node,
                ),
            ),
        );
        return {
            kind: "data",
            cpp: ts.isExpression(node)
                ? this.context.dataLowerer.armExpression(node, lines, cpp, type)
                : lines.length === 0
                  ? cpp
                  : this.context.fail(
                        node,
                        "A conditional branch that prepares its value must be bound to its own declaration first.",
                    ),
            dataType: type,
            nativeCaptures,
        };
    }

    private canHoistRecordValue(value: Value): boolean {
        if (
            value.staticNumber !== undefined ||
            value.staticString !== undefined ||
            value.staticBoolean !== undefined ||
            value.kind === "json-null"
        ) {
            return true;
        }
        if (value.kind === "tuple") {
            return (value.tupleElements ?? []).every((element) =>
                this.canHoistRecordValue(element),
            );
        }
        if (value.kind === "record") {
            return (
                Object.keys(value.recordMethods ?? {}).length === 0 &&
                Object.keys(value.recordGetters ?? {}).length === 0 &&
                Object.keys(value.recordSetters ?? {}).length === 0 &&
                Object.values(value.recordProperties ?? {}).every((property) =>
                    this.canHoistRecordValue(property),
                )
            );
        }
        return false;
    }

    private isModuleConstantRecord(expression: ts.Expression): boolean {
        const owner = this.context.unwrap(expression);
        if (!ts.isIdentifier(owner)) return false;
        const declaration = resolvedSymbol(
            this.context.checker,
            owner,
        )?.valueDeclaration;
        return (
            declaration !== undefined &&
            ts.isVariableDeclaration(declaration) &&
            declaration.parent !== undefined &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
            declaration.parent.parent !== undefined &&
            ts.isVariableStatement(declaration.parent.parent) &&
            ts.isSourceFile(declaration.parent.parent.parent)
        );
    }

    private isNavigatorGetGamepadsCall(call: ts.CallExpression): boolean {
        const callee = this.context.unwrap(call.expression);
        return (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "getGamepads" &&
            this.context.libraryGlobal(callee.expression) === "navigator"
        );
    }

    private compileCall(call: ts.CallExpression): Value {
        const reflected = this.context.recordProxies.reflect(call);
        if (reflected) return reflected;
        if (call.expression.kind === ts.SyntaxKind.ImportKeyword)
            return this.context.moduleNamespaces.compileImport(call);
        const deferred = this.context.deferredCapabilities.compile(call);
        if (deferred) return deferred;
        const target = this.context.unwrap(call.expression);
        if (target.kind === ts.SyntaxKind.SuperKeyword) {
            this.context.fail(
                call,
                "super(...) is lowered as a top-level statement of a derived " +
                    "class constructor.",
            );
        }
        if (
            ts.isPropertyAccessExpression(target) &&
            target.expression.kind === ts.SyntaxKind.SuperKeyword
        ) {
            return this.context.classLowerer.compileSuperMethodCall(
                call,
                target,
            );
        }
        const hostFunction = ts.isIdentifier(target)
            ? this.context.bindings.lookupOptional(target)?.hostFunction
            : ts.isPropertyAccessExpression(target)
              ? this.context.probeEmission(() => {
                    try {
                        return this.context.resolveRecordMember(target)
                            ?.hostFunction;
                    } catch (error) {
                        if (error instanceof CompileError) return undefined;
                        throw error;
                    }
                })
              : undefined;
        const http = compileHttpCall(
            this.context.dataLowerer,
            call,
            hostFunction,
        );
        if (http) return http;
        const windowService = compileWindowServiceCall(
            this.context.dataLowerer,
            call,
            hostFunction,
        );
        if (windowService) return windowService;
        const gpuAdapter = compileGpuAdapterCall(
            this.context.dataLowerer,
            call,
            hostFunction,
        );
        if (gpuAdapter) return gpuAdapter;
        const imported = this.context.symbols.importedName(call.expression);
        const boundIntrinsic = ts.isIdentifier(target)
            ? this.context.bindings.lookupOptional(target)?.intrinsicName
            : undefined;
        if (imported || boundIntrinsic) {
            const name = boundIntrinsic ?? imported!;
            const registered = this.context.compileRegisteredIntrinsic(
                name,
                call,
            );
            if (registered) return registered;
            this.context.fail(
                call.expression,
                `Babylon Lite intrinsic '${name}' is not supported by this prototype. Supported scene APIs are documented in docs/features.md.`,
            );
        }
        const numberPredicate = compileNumberPredicate(this.context, call);
        if (numberPredicate) return numberPredicate;
        const array = this.context.dataLowerer.compileNewArray(call);
        if (array) return array;
        const worker = this.context.compileWorkerValue(call);
        if (worker) return worker;
        if (this.isNavigatorGetGamepadsCall(call)) {
            this.context.expectArgumentCount(call, 0, 0);
            const engine = this.context.requireDefaultEngine(call);
            this.context.reachFeature("input:gamepad", call);
            this.context.reachJsData();
            return {
                kind: "data",
                cpp: `bbl::platform_gamepads(${engine})`,
                dataType: {
                    kind: "vector",
                    element: {
                        kind: "optional",
                        inner: { kind: "handle", handle: "gamepad" },
                    },
                },
                freshData: true,
                engineCpp: engine,
            };
        }
        const browserFile = compileBrowserFileCall(this.context, call);
        if (browserFile) {
            return browserFile;
        }
        // Web Storage and JSON are host services rather than pinned
        // modules, and both are recognized by the global the call reaches
        // rather than by anything a scene is named. They come first so
        // neither is mistaken for a user function of the same name.
        const storage = compileWebStorageCall(this.context, call);
        if (storage) {
            return storage;
        }
        const json = compileJsonCall(this.context, call);
        if (json) {
            return json;
        }
        const compressedJsonThen = compileCompressedJsonPromiseThen(
            this.context,
            call,
        );
        if (compressedJsonThen) {
            return compressedJsonThen;
        }
        const pixelsUpload = this.context.compilePixelsTextureUpload(call);
        if (pixelsUpload) {
            return pixelsUpload;
        }
        const platform = this.context.compilePlatformCall(call);
        if (platform) {
            return platform;
        }
        const promise = compileImmediatePromise(this.context, call);
        if (promise) {
            return promise;
        }
        const browserGenerated =
            this.context.compileBrowserGeneratedString(call);
        if (browserGenerated) return browserGenerated;
        // `setTimeout(callback, 0)`: run once, after the current turn.
        // Every other browser call erases; this one is implemented,
        // because the frame conductor already has that boundary and the
        // corpus reaches `stopEngine` through it -- the freeze a physics
        // scene pins its measured pose with.
        if (this.context.browserErasure.isDeferredCallbackCall(call)) {
            return this.compileDeferredCallback(call);
        }
        // A pure module-URL helper is a compile-time string whether it feeds a
        // registered asset intrinsic directly or first travels through an
        // inlined user-function parameter. Recognize the call at the value
        // boundary so both data flows observe the same public-root path.
        const moduleAsset = this.context.moduleRelativeAssetUrl(call);
        if (moduleAsset !== undefined) {
            return {
                kind: "string",
                cpp: this.context.cppString(moduleAsset),
                staticString: moduleAsset,
            };
        }
        const symbol = compileSymbolCall(this.context, call);
        if (symbol) return symbol;
        // `N.f()` calls the namespace member `f` as its body does.
        const callee =
            namespaceMemberName(
                this.context.checker,
                this.context.unwrap(call.expression),
            ) ?? this.context.unwrap(call.expression);
        // A microtask runs after the current task: the realm's event loop.
        // Structured cloning uses the realm's message codecs.
        const realmGlobal = this.context.libraryGlobal(callee);
        if (
            !this.context.options.workers &&
            (realmGlobal === "queueMicrotask" ||
                realmGlobal === "structuredClone")
        )
            throw new ApplicationRealmRequired();
        if (
            ts.isIdentifier(callee) &&
            this.context.libraryGlobal(callee) === "createImageBitmap"
        ) {
            this.context.expectArgumentCount(call, 1, 2);
            return {
                kind: "ui-element",
                // The bitmap's pixels have already been baked into the
                // packaged atlas. Keep a typed, truthy placeholder so the
                // source success arm retains its ordinary local binding;
                // drawImage/close themselves are browser-erased.
                cpp: "bbl::UiElementHandle{}",
                uiTag: "image-bitmap",
                truthinessCpp: "true",
            };
        }
        if (
            ts.isIdentifier(callee) &&
            this.context.libraryGlobal(callee) === "requestAnimationFrame"
        ) {
            const animationFrame = this.context.compileAnimationFrameCall(call);
            if (animationFrame) return animationFrame;
        }
        if (ts.isPropertyAccessExpression(callee)) {
            const value = this.compilePropertyCall(callee, call);
            if (value) return value;
        }
        if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
            return this.context.userFunctions.compileCallbackCall(
                this.context,
                call,
                callee,
            );
        }
        if (
            ts.isCallExpression(callee) ||
            ts.isBinaryExpression(callee) ||
            ts.isConditionalExpression(callee)
        ) {
            const called = this.compileCallableValueCall(
                call,
                callee,
                this.compileValue(callee),
            );
            if (called) return called;
        }
        if (ts.isElementAccessExpression(callee)) {
            let callable = this.compileValue(call.expression);
            if (callable.kind === "callback" && callable.callbackDeclaration) {
                const native =
                    this.context.userFunctions.compileNativeCallbackCall(
                        this.context,
                        call,
                        callable,
                    );
                if (native) return native;
                const declaration = callable.callbackDeclaration;
                const owner = callable.callbackRecordOwner;
                const inBodyScope = <T>(work: () => T): T =>
                    owner
                        ? this.context.withRecordScopes(
                              owner,
                              work,
                              declaration,
                          )
                        : work();
                return ts.isIdentifier(declaration)
                    ? this.context.userFunctions.compile(
                          this.context,
                          call,
                          declaration,
                          inBodyScope,
                      )!
                    : this.context.userFunctions.compileCallbackCall(
                          this.context,
                          call,
                          declaration,
                          inBodyScope,
                      );
            }
            if (
                hasNonNullAssertion(call.expression) &&
                callable.kind === "data"
            ) {
                callable = this.context.dataLowerer.narrowOptional(
                    callable,
                    call.expression,
                    true,
                );
            }
            if (
                callable.kind === "data" &&
                callable.dataType?.kind === "function"
            ) {
                return this.context.dataLowerer.compileStoredCall(
                    call,
                    callable.cpp,
                    callable.dataType,
                );
            }
            this.context.fail(
                callee,
                `Indexed call target resolved to ${callable.kind}` +
                    `${callable.dataType ? `:${callable.dataType.kind}` : ""}.`,
            );
        }
        const uriFunction = URI_FUNCTIONS.get(
            this.context.libraryGlobal(callee) ?? "",
        );
        if (uriFunction) {
            this.context.expectArgumentCount(call, 1, 1);
            const argument = argumentAt(call, 0);
            const value = this.compileValue(argument);
            this.context.reachJsData();
            return {
                kind: "string",
                dataType: { kind: "string" },
                cpp: `bbl::js::${uriFunction}(bbl::js::concat(${stringConcatPart(this.context, value, argument)}))`,
            };
        }
        // `parseFloat(<query text>)`: the same value browser-erasure already
        // settles for a guard beside it. It travels through the one path
        // that turns a settled browser primitive into a value, so what a
        // scene reads through its own pose is the number generation KNOWS
        // -- which is what lets a helper's guard on it fold. Above the
        // identifier gate because `Number.parseFloat` is the same function
        // under a property access, and the two spellings must not diverge.
        if (
            isParseFloatCallee(callee, this.context) &&
            call.arguments.length === 1
        ) {
            const settled =
                this.context.browserErasure.evaluateBrowserValue(call);
            if (settled?.kind === "number" && Number.isFinite(settled.value)) {
                // The value is returned already settled rather than through
                // `materializeBrowserPrimitive`: that helper renders its cpp
                // with `compileNumber(expression)`, which for THIS
                // expression re-enters the arm it was reached from.
                return {
                    kind: "number",
                    cpp: doubleLiteral(settled.value),
                    staticNumber: settled.value,
                };
            }
        }

        if (isParseFloatCallee(callee, this.context)) {
            this.context.expectArgumentCount(call, 1, 1);
            const value = this.compileValue(argumentAt(call, 0));
            if (!isStringValue(value)) {
                this.context.fail(
                    argumentAt(call, 0),
                    "Reached parseFloat requires a string value.",
                );
            }
            this.context.reachJsData();
            return {
                kind: "number",
                dataType: { kind: "number" },
                cpp: `bbl::js::parse_float(${value.cpp})`,
            };
        }
        if (isNumberParserCallee(callee, this.context, "parseInt")) {
            this.context.expectArgumentCount(call, 1, 2);
            const value = this.compileValue(argumentAt(call, 0));
            if (!isStringValue(value)) {
                this.context.fail(
                    argumentAt(call, 0),
                    "Reached parseInt currently requires a string value.",
                );
            }
            const radix = call.arguments[1]
                ? this.compileValue(call.arguments[1])
                : undefined;
            if (
                radix &&
                (radix.kind !== "number" ||
                    radix.staticNumber === undefined ||
                    radix.parameterBinding ||
                    !Number.isInteger(radix.staticNumber) ||
                    (radix.staticNumber !== 0 &&
                        (radix.staticNumber < 2 || radix.staticNumber > 36)))
            ) {
                this.context.fail(
                    argumentAt(call, 1),
                    "Reached parseInt requires a literal radix 0 or 2 through 36.",
                );
            }
            this.context.reachJsData();
            return {
                kind: "number",
                dataType: { kind: "number" },
                cpp:
                    radix?.staticNumber === 10
                        ? `bbl::js::parse_int_decimal(${value.cpp})`
                        : `bbl::js::parse_int(${value.cpp}, ${radix?.staticNumber ?? 0})`,
            };
        }

        if (!ts.isIdentifier(callee)) {
            const predicate = compileArrayPredicateOverData(
                this.context.dataLowerer,
                call,
            );
            if (predicate) {
                return predicate;
            }
            this.requireModuleReceiverStorage(callee);
            const receiver =
                ts.isPropertyAccessExpression(callee) &&
                ts.isIdentifier(callee.expression)
                    ? this.context.bindings.lookupOptional(callee.expression)
                    : ts.isPropertyAccessExpression(callee) &&
                        ts.isPropertyAccessExpression(callee.expression) &&
                        callee.expression.expression.kind ===
                            ts.SyntaxKind.ThisKeyword
                      ? this.context.resolveThisField(
                            callee.expression.name.text,
                        )
                      : undefined;
            this.context.fail(
                callee,
                `Unsupported call target '${callee.getText()}'` +
                    (receiver
                        ? ` on ${receiver.kind}${receiver.dataType ? `:${receiver.dataType.kind}` : ""}.`
                        : "."),
            );
        }

        if (this.context.libraryGlobal(callee) === "String") {
            this.context.expectArgumentCount(call, 1, 1);
            const argument = this.context.unwrap(argumentAt(call, 0));
            if (argument.kind === ts.SyntaxKind.NullKeyword) {
                return staticStringValue("null", (text) =>
                    this.context.cppString(text),
                );
            }
            if (this.context.symbols.isGlobalUndefined(argument)) {
                return staticStringValue("undefined", (text) =>
                    this.context.cppString(text),
                );
            }
            const value = this.compileValue(argumentAt(call, 0));
            this.context.reachJsData();
            if (value.kind === "json-null") {
                return staticStringValue(
                    value.cpp === "std::nullopt" ? "undefined" : "null",
                    (text) => this.context.cppString(text),
                );
            }
            // `String(symbol)` is its description text, as `toString()`.
            if (value.kind === "data" && value.dataType?.kind === "symbol")
                return this.context.dataValue(`(${value.cpp}).to_string()`, {
                    kind: "string",
                });
            if (
                value.dataType?.kind === "union" &&
                value.dataType.members.every(
                    (member) =>
                        member.kind === "number" ||
                        member.kind === "boolean" ||
                        member.kind === "string",
                )
            ) {
                return {
                    kind: "string",
                    cpp: stringConcatPart(
                        this.context,
                        value,
                        argumentAt(call, 0),
                    ),
                };
            }
            if (
                value.nativeError ||
                isJsonValue(value) ||
                value.kind === "number" ||
                value.kind === "boolean" ||
                value.dataType?.kind === "enum" ||
                value.dataType?.kind === "bigint" ||
                isUndefinedDataType(value.dataType) ||
                // An absent value spells "undefined" or "null", as in a
                // concatenation.
                value.dataType?.kind === "optional"
            ) {
                return {
                    kind: "data",
                    cpp: `bbl::js::concat(${stringConcatPart(this.context, value, argumentAt(call, 0))})`,
                    dataType: { kind: "string" },
                };
            }
            if (isStringValue(value)) {
                return {
                    kind: "data",
                    cpp: value.cpp,
                    dataType: { kind: "string" },
                };
            }
            this.context.fail(
                argumentAt(call, 0),
                `String() supports number, boolean, and string values, received ${value.kind}.`,
            );
        }

        if (this.context.libraryGlobal(callee) === "Number") {
            this.context.expectArgumentCount(call, 1, 1);
            return this.compileNumberConversion(argumentAt(call, 0));
        }
        // `Error(message)` called without `new` constructs exactly as
        // `new Error(message)` does, for every native Error constructor.
        const errorName = errorConstructor(call, (expression) =>
            this.context.libraryGlobal(expression),
        );
        if (errorName)
            return compileErrorConstruction(this.context, call, errorName);
        if (this.context.libraryGlobal(callee) === "Boolean") {
            // `Boolean(x)` is x's truthiness, which the condition lowering
            // already spells for every kind.
            this.context.expectArgumentCount(call, 1, 1);
            return booleanValue(
                this.context.conditions.compileCondition(argumentAt(call, 0)),
            );
        }

        const dynamicModuleAsset =
            this.context.compileDynamicModuleRelativeAssetUrl(call);
        if (dynamicModuleAsset) return dynamicModuleAsset;

        const fetched = this.context.compileStaticFetch(call, callee);
        if (fetched) return fetched;

        const bound = this.context.bindings.lookupOptional(callee);
        if (
            call.questionDotToken &&
            bound &&
            (bound.kind === "json-null" || isUndefinedDataType(bound.dataType))
        ) {
            this.context.emitDiscardedValue(bound);
            return { kind: "json-null", cpp: "std::nullopt" };
        }
        if (bound?.kind === "callback") {
            const recursive =
                this.context.userFunctions.compileNativeCallbackCall(
                    this.context,
                    call,
                    bound,
                );
            if (recursive) {
                return recursive;
            }
            if (!bound.callbackDeclaration) {
                this.context.fail(
                    callee,
                    "Callback value is missing its declaration.",
                );
            }
            const inRecordScope = <T>(work: () => T): T =>
                bound.callbackRecordOwner
                    ? this.context.withRecordScopes(
                          bound.callbackRecordOwner,
                          work,
                      )
                    : work();
            return ts.isIdentifier(bound.callbackDeclaration)
                ? this.context.userFunctions.compile(
                      this.context,
                      call,
                      bound.callbackDeclaration,
                      inRecordScope,
                  )!
                : this.context.userFunctions.compileCallbackCall(
                      this.context,
                      call,
                      bound.callbackDeclaration,
                      inRecordScope,
                  );
        }
        if (bound?.kind === "data" && bound.dataType?.kind === "function") {
            return this.context.dataLowerer.compileStoredCall(
                call,
                bound.cpp,
                bound.dataType,
            );
        }
        const unionMember =
            bound?.kind === "data"
                ? this.context.dataLowerer.unionFunctionMember(bound, callee)
                : undefined;
        if (unionMember) {
            return this.context.dataLowerer.compileStoredCall(
                call,
                unionMember.cpp,
                unionMember.dataType,
            );
        }
        const callableRecord =
            bound?.kind === "data"
                ? this.context.dataLowerer.compileCallableRecordCall(
                      call,
                      bound,
                  )
                : undefined;
        if (callableRecord) return callableRecord;
        if (!bound) {
            const aliased = this.compileConstAliasCall(call, callee);
            if (aliased) return aliased;
        }

        // `await HavokPhysics({ locateFile: ... })` -- the browser's own
        // solver module, fetched and instantiated while the page loads.
        // The pin hands it to `createHavokWorld` and calls `HP_*` on it;
        // a native build reaches its solver through the PAL instead, so
        // the call reaches nothing and the value exists only to be
        // accepted there. The same shape as the tracking installers: the
        // scene's line is legal and emits nothing.
        if (this.context.symbols.isPhysicsEngineModule(callee)) {
            return {
                kind: "physics-engine-module",
                cpp: "",
            };
        }

        const compressedJson = compileCompressedJsonCall(
            this.context,
            call,
            callee,
        );
        if (compressedJson) {
            return compressedJson;
        }
        const staticResult = this.context.userFunctions.tryCompileStaticResult(
            this.context,
            call,
            callee,
        );
        if (staticResult) return staticResult;
        const nativeFunction = this.context.nativeFunctions.tryCompileCall(
            call,
            callee,
        );
        if (nativeFunction) {
            return nativeFunction;
        }
        const thinInstanceUpload = this.context.compileThinInstanceUploadHelper(
            call,
            callee,
        );
        if (thinInstanceUpload) {
            return thinInstanceUpload;
        }
        const ownerMap = this.context.handleCollections.compileAssetOwnerMap(
            call,
            callee,
        );
        if (ownerMap) return ownerMap;
        const assetNode =
            this.context.handleCollections.compileAssetDescendantNameSearch(
                call,
                callee,
            );
        if (assetNode) {
            return assetNode;
        }
        const assetSkinned =
            this.context.handleCollections.compileAssetSkinnedDescendantSearch(
                call,
                callee,
            );
        if (assetSkinned) {
            return assetSkinned;
        }
        // Ahead of inlining: a canvas-owning texture producer's body is not
        // a body this compiler can lower, so the structural gate decides
        // before the inliner reaches `new OffscreenCanvas`.
        const browserTextures = this.context.compileBrowserTextureFunctionCall(
            call,
            callee,
        );
        if (browserTextures) {
            return browserTextures;
        }
        // The same gate for a producer that hands its canvas to no pinned
        // factory at all and returns the object URL instead: the URL is a
        // graph factory's argument, and the bake driver produces it.
        const executedUrl = this.context.compileExecutedUrlFunctionCall(
            call,
            callee,
        );
        if (executedUrl) {
            return executedUrl;
        }
        const executedVideo = this.context.compileExecutedVideoFunctionCall(
            call,
            callee,
        );
        if (executedVideo) {
            return executedVideo;
        }
        const userFunction = this.context.userFunctions.compile(
            this.context,
            call,
            callee,
        );
        if (userFunction) {
            return userFunction;
        }
        this.context.fail(
            callee,
            `Call '${callee.text}' does not resolve to a supported Babylon intrinsic or local function declaration.`,
        );
    }

    /**
     * A call through a function value the callee expression evaluated:
     * an intrinsic, a native recursive callback, a source function the
     * value names, or native function storage.
     */
    private compileCallableValueCall(
        call: ts.CallExpression,
        callee: ts.Expression,
        callable: Value,
    ): Value | undefined {
        if (callable.kind === "callback") {
            if (callable.intrinsicName) {
                return (
                    this.context.compileRegisteredIntrinsic(
                        callable.intrinsicName,
                        call,
                    ) ??
                    this.context.fail(
                        callee,
                        `Babylon Lite intrinsic '${callable.intrinsicName}' is not supported by this prototype.`,
                    )
                );
            }
            const native = this.context.userFunctions.compileNativeCallbackCall(
                this.context,
                call,
                callable,
            );
            if (native) return native;
            if (!callable.callbackDeclaration) {
                this.context.fail(
                    callee,
                    "Returned callback value is missing its declaration.",
                );
            }
            let declaration = callable.callbackDeclaration;
            if (ts.isIdentifier(declaration)) {
                const definitions =
                    this.context.symbols.valueSymbol(declaration)
                        ?.declarations ?? [];
                const variable = definitions.find(
                    (candidate): candidate is ts.VariableDeclaration =>
                        ts.isVariableDeclaration(candidate) &&
                        candidate.initializer !== undefined,
                );
                const initializer = variable?.initializer
                    ? this.context.unwrap(variable.initializer)
                    : undefined;
                if (
                    initializer &&
                    (ts.isArrowFunction(initializer) ||
                        ts.isFunctionExpression(initializer))
                ) {
                    declaration = initializer;
                }
            }
            const invoke = (): Value => {
                if (ts.isFunctionDeclaration(declaration)) {
                    if (!declaration.name) {
                        this.context.fail(
                            declaration,
                            "Returned function declaration must be named.",
                        );
                    }
                    return this.context.userFunctions.compile(
                        this.context,
                        call,
                        declaration.name,
                    )!;
                }
                return this.context.userFunctions.compileCallbackWithValues(
                    this.context,
                    declaration,
                    call.arguments.map((argument) =>
                        this.compileValue(argument),
                    ),
                    call,
                );
            };
            return callable.callbackRecordOwner
                ? this.context.withRecordScopes(
                      callable.callbackRecordOwner,
                      invoke,
                  )
                : invoke();
        }
        if (callable.kind === "data" && callable.dataType?.kind === "function")
            return this.context.dataLowerer.compileStoredCall(
                call,
                callable.cpp,
                callable.dataType,
            );
        return this.context.dataLowerer.compileCallableRecordCall(
            call,
            callable,
        );
    }

    /**
     * A call through a module `const` that aliases a function
     * (`const f32 = Math.fround`, `const key = archKey`). The binding is
     * immutable and reading it has no effect, so the call is a call of the
     * aliased function itself: the static constant resolves the alias chain
     * to what it names, a Math member keeps its direct native spelling and
     * a source function is called as a direct call of it would be.
     */
    private compileConstAliasCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        const aliased = constInitializer(this.context, callee);
        if (
            !aliased ||
            (!ts.isIdentifier(aliased) &&
                !ts.isPropertyAccessExpression(aliased))
        )
            return undefined;
        const target = this.context.resolveStaticExpression(callee);
        if (target === callee) return undefined;
        if (ts.isPropertyAccessExpression(target)) {
            const math = this.context.dataLowerer.compileMathCall(call, target);
            if (math) return math;
        } else if (
            ts.isIdentifier(target) &&
            !this.context.bindings.lookupOptional(target) &&
            tryResolveFunctionDeclaration(this.context.checker, target)
        )
            return this.context.userFunctions.compile(
                this.context,
                call,
                target,
            );
        return this.compileCallableValueCall(
            call,
            callee,
            this.compileValue(target),
        );
    }

    /**
     * One row of a bake's clip map, by name.
     *
     * The name is static in both reached scenes, and the row it selects is
     * the bake's answer rather than generation's -- so this emits the
     * native lookup and reports a miss the way every optional read in this
     * port does. A zero frame count is that miss: no baked clip has one.
     */
    private compileVatClipRow(
        map: Value,
        access: ts.ElementAccessExpression,
    ): Value {
        const clip = this.context.compileStringLiteral(
            access.argumentExpression,
        );
        const engine = this.context.requireEngine(map, access);
        const row = this.context.allocateTemporaryCppName("vat_clip");
        this.context.emit({
            kind: "declaration",
            type: "const bbl::VatClipRow",
            name: row,
            initializer: `bbl::vat_clip_row(${engine}, ${map.cpp}, ${this.context.cppString(clip)})`,
        });
        return {
            kind: "vat-clip",
            cpp: row,
            engineCpp: engine,
            optionalFoundCpp: `(${row}.frame_count != 0.0)`,
        };
    }

    private compileNumberConversion(expression: ts.Expression): Value {
        const unwrapped = this.context.unwrap(expression);
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
            // The probe keeps the left operand's emission only when this
            // arm takes it; otherwise the whole `??` compiles once below.
            const converted = this.context.probeEmission(
                (): Value | undefined => {
                    const optional = this.compileValue(unwrapped.left);
                    if (
                        optional.kind !== "data" ||
                        optional.dataType?.kind !== "optional" ||
                        (optional.dataType.inner.kind !== "string" &&
                            optional.dataType.inner.kind !== "number")
                    )
                        return undefined;
                    const fallback = this.context.dataLowerer.compileArm(() =>
                        this.compileNumberConversion(unwrapped.right),
                    );
                    const present =
                        optional.dataType.inner.kind === "string"
                            ? `bbl::js::number_from_string(*v)`
                            : `static_cast<double>(*v)`;
                    this.context.reachJsData();
                    const dataType = { kind: "number" } as const;
                    return {
                        kind: "number",
                        cpp:
                            fallback.lines.length === 0
                                ? `([&]() { const auto& v = ${optional.cpp}; ` +
                                  `return v.has_value() ? ${present} : ${fallback.value.cpp}; }())`
                                : this.context.dataLowerer.armExpression(
                                      unwrapped.right,
                                      [
                                          `const auto& v = ${optional.cpp};`,
                                          `if (v.has_value()) return ${present};`,
                                          ...fallback.lines,
                                      ],
                                      fallback.value.cpp,
                                      dataType,
                                  ),
                        dataType,
                    };
                },
            );
            if (converted) return converted;
        }
        const value = this.compileValue(unwrapped);
        if (value.kind === "number") return value;
        const present = (cpp: string, type: DataType | undefined) =>
            type?.kind === "number"
                ? `static_cast<double>(${cpp})`
                : type?.kind === "string"
                  ? `bbl::js::number_from_string(${cpp})`
                  : type?.kind === "boolean"
                    ? `(${cpp} ? 1.0 : 0.0)`
                    : type?.kind === "json" || type?.kind === "bigint"
                      ? `(${cpp}).to_number()`
                      : undefined;
        const number = (cpp: string): Value => {
            this.context.reachJsData();
            return { kind: "number", cpp, dataType: { kind: "number" } };
        };
        if (isStringValue(value))
            return number(present(value.cpp, { kind: "string" })!);
        if (value.kind === "boolean")
            return number(present(value.cpp, { kind: "boolean" })!);
        const direct =
            value.kind === "data" && present(value.cpp, value.dataType);
        if (direct) return number(direct);
        // An absent operand is NaN when it is `undefined` and 0 when it is
        // `null`, so the storage must say which one it holds.
        const inner =
            value.kind === "data" && value.dataType?.kind === "optional"
                ? value.dataType.inner
                : undefined;
        if (inner && present("*v", inner)) {
            const absence = absenceKind(this.context.checker, value, unwrapped);
            const absent =
                absence === "null"
                    ? "0.0"
                    : absence === "either"
                      ? this.context.fail(
                            expression,
                            "Number() of a value that may be null or undefined requires storage telling them apart.",
                        )
                      : typeof absence === "object"
                        ? `(${absence.slotFoundCpp} ? 0.0 : std::numeric_limits<double>::quiet_NaN())`
                        : "std::numeric_limits<double>::quiet_NaN()";
            return number(
                `([&]() { const auto& v = ${value.cpp}; ` +
                    `return v.has_value() ? ${present("*v", inner)} : ${absent}; }())`,
            );
        }
        this.context.fail(
            expression,
            `Number() supports numbers, strings, booleans, BigInts, parsed documents and their optionals, received ${value.kind}.`,
        );
    }

    private compileStaticOwner(expression: ts.Expression): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isArrayLiteralExpression(unwrapped)) {
            return this.staticContainer(this.compileValue(unwrapped));
        }
        if (ts.isIdentifier(unwrapped)) {
            const bound = this.staticContainer(
                this.context.bindings.lookupOptional(unwrapped),
            );
            if (bound) return bound;
            const resolved = this.context.resolveStaticExpression(unwrapped);
            return resolved !== unwrapped &&
                ts.isArrayLiteralExpression(resolved)
                ? this.staticContainer(this.compileValue(resolved))
                : undefined;
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const owner = this.compileStaticOwner(unwrapped.expression);
            return owner?.kind === "record"
                ? this.staticContainer(
                      owner.recordProperties?.[unwrapped.name.text],
                  )
                : undefined;
        }
        if (
            ts.isElementAccessExpression(unwrapped) &&
            unwrapped.argumentExpression
        ) {
            const owner = this.compileStaticOwner(unwrapped.expression);
            const indexNode = this.context.resolveStaticExpression(
                unwrapped.argumentExpression,
            );
            const index = ts.isNumericLiteral(indexNode)
                ? Number(indexNode.text)
                : undefined;
            return owner?.kind === "tuple" &&
                index !== undefined &&
                Number.isInteger(index)
                ? this.staticContainer(owner.tupleElements?.[index])
                : undefined;
        }
        return undefined;
    }

    private staticContainer(value: Value | undefined): Value | undefined {
        return value?.kind === "record" ||
            value?.kind === "tuple" ||
            value?.kind === "static-fetch-response"
            ? value
            : undefined;
    }

    private compileStaticTupleMap(
        call: ts.CallExpression,
        owner: Value,
        method: string,
    ): Value | undefined {
        if (
            owner.kind !== "tuple" ||
            (method !== "map" && method !== "some" && method !== "forEach")
        ) {
            return undefined;
        }
        if (call.arguments.length !== 1) {
            this.context.fail(
                call,
                `Compile-time Array.${method} requires exactly one callback and no thisArg.`,
            );
        }
        const callback = this.context.unwrap(argumentAt(call, 0));
        const callee = this.context.unwrap(call.expression);
        if (
            ts.isPropertyAccessExpression(callee) &&
            this.context.dataLowerer.prefersRuntimeTupleIteration(
                callee.expression,
                callback,
            )
        )
            return undefined;
        const local =
            ts.isArrowFunction(callback) ||
            ts.isFunctionExpression(callback) ||
            ts.isIdentifier(callback)
                ? callback
                : undefined;
        // Static iterations specialize local callbacks with their exact inputs.
        // Resource results can carry loader metadata without an erased stored
        // function signature; already stored callbacks retain that signature.
        const storedFunction =
            ts.isIdentifier(callback) &&
            this.context.bindings.lookupOptional(callback)?.dataType?.kind ===
                "function";
        const stored =
            !local || storedFunction
                ? this.context.dataLowerer.prepareCallbackValue(
                      callback,
                      "tuple",
                  )
                : undefined;
        if (!local && !stored) {
            this.context.fail(
                callback,
                `Compile-time Array.${method} requires a local function or function literal callback.`,
            );
        }
        const elements = owner.tupleElements ?? [];
        const invoke = (element: Value, index: number): Value => {
            const values: Value[] = [
                element,
                {
                    kind: "number",
                    cpp: `${index}.0f`,
                    staticNumber: index,
                },
                owner,
            ];
            if (stored) {
                const result =
                    this.context.dataLowerer.compileFunctionValueCall(
                        stored,
                        values,
                        call,
                    );
                if (method === "forEach") {
                    this.context.emitDiscardedValue(result);
                    return { kind: "void", cpp: "" } satisfies Value;
                }
                return method === "map"
                    ? this.context.bindings.pinValueToTemporary(
                          result,
                          "mapped_result",
                          callback,
                      )
                    : result;
            }
            const result =
                this.context.asyncActivations.withStaticCollectionCallback(
                    call,
                    local!,
                    () =>
                        this.compileStaticTupleCallback(
                            local!,
                            values,
                            call,
                            method === "forEach",
                        ),
                );
            return method === "map"
                ? this.context.bindings.pinValueToTemporary(
                      result,
                      "mapped_result",
                      callback,
                  )
                : result;
        };
        if (method === "some") {
            // Keep each callback's statements inside its short-circuited
            // operand. Emitting all bodies first would execute skipped calls.
            const predicates = elements.map((element, index) => {
                let condition = "";
                const lines = this.context.captureEmittedLines(() =>
                    this.inRuntimeControlFlow(() => {
                        const result = invoke(element, index);
                        condition =
                            this.context.dataLowerer.truthinessCondition(
                                result,
                            ) ??
                            this.context.fail(
                                callback,
                                "Array predicate return has no native truthiness.",
                            );
                    }),
                );
                return lines.length
                    ? `([&]() -> bool { ${lines.join("\n")} return ${condition}; }())`
                    : `(${condition})`;
            });
            return {
                kind: "boolean",
                cpp: predicates.length ? predicates.join(" || ") : "false",
                dataType: { kind: "boolean" },
            };
        }
        const results = elements.map(invoke);
        if (method === "forEach") return { kind: "void", cpp: "" };
        const mappedType = this.context.dataLowerer.dataTypeAt(call);
        if (
            mappedType?.kind === "vector" &&
            !results.some((result) => result.kind === "promise") &&
            results.some(
                (result) =>
                    result.staticNumber === undefined &&
                    result.staticString === undefined &&
                    result.kind !== "boolean" &&
                    result.kind !== "tuple" &&
                    result.kind !== "record",
            )
        ) {
            const elementType = mappedType.element;
            const elementCpp = this.context.dataTypes.cppType(elementType);
            const values = results.map((result) =>
                this.context.dataLowerer.compileKnownValueForSink(
                    result,
                    elementType,
                    call,
                ),
            );
            this.context.reachJsData();
            return {
                kind: "data",
                cpp: `bbl::js::Array<${elementCpp}>{${values.join(", ")}}`,
                dataType: mappedType,
            };
        }
        return {
            kind: "tuple",
            cpp: "",
            tupleElements: results,
        };
    }

    /**
     * Invoke a statically unrolled tuple callback. The ordinary user-function
     * path owns identifier parameters; this small extension owns the array
     * binding pattern JavaScript commonly uses for tuple tables
     * (`ranges.some(([first, last]) => ...)`).
     */
    private compileStaticTupleCallback(
        callback: ts.Identifier | ts.ArrowFunction | ts.FunctionExpression,
        arguments_: readonly Value[],
        call: ts.CallExpression,
        discardReturn = false,
    ): Value {
        if (
            ts.isIdentifier(callback) ||
            ts
                .getModifiers(callback)
                ?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
                ) ||
            callback.parameters.length === 0 ||
            !ts.isArrayBindingPattern(callback.parameters[0]!.name)
        ) {
            return this.context.userFunctions.compileCallbackWithValues(
                this.context,
                callback,
                arguments_,
                call,
                discardReturn,
            );
        }
        const tuple = arguments_[0];
        if (tuple?.kind !== "tuple") {
            this.context.fail(
                callback.parameters[0]!,
                "Array binding callback requires a tuple element.",
            );
        }
        this.context.bindings.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        try {
            const pattern = callback.parameters[0]!.name;
            pattern.elements.forEach((binding, index) => {
                if (ts.isOmittedExpression(binding)) return;
                if (
                    !ts.isIdentifier(binding.name) ||
                    binding.initializer ||
                    binding.dotDotDotToken
                ) {
                    this.context.fail(
                        binding,
                        "Static tuple callback bindings must be plain identifiers.",
                    );
                }
                const value = tuple.tupleElements?.[index];
                if (!value) {
                    this.context.fail(
                        binding,
                        "Static tuple callback binding exceeds the tuple width.",
                    );
                }
                this.context.bindings.bindLocalValue(binding.name, value);
            });
            callback.parameters.slice(1).forEach((parameter, index) => {
                if (
                    !ts.isIdentifier(parameter.name) ||
                    parameter.dotDotDotToken ||
                    parameter.initializer
                ) {
                    this.context.fail(
                        parameter,
                        "Static tuple callback parameters after the binding must be plain identifiers.",
                    );
                }
                const value = arguments_[index + 1];
                if (!value) {
                    this.context.fail(
                        parameter,
                        "Static tuple callback declares more parameters than the operation supplies.",
                    );
                }
                this.context.bindings.bindCompileTimeValue(
                    parameter.name,
                    value,
                );
            });
            if (ts.isBlock(callback.body)) {
                const statements = callback.body.statements;
                const finalStatement = statements.at(-1);
                if (
                    finalStatement &&
                    ts.isReturnStatement(finalStatement) &&
                    finalStatement.expression
                ) {
                    const earlierReturn = firstReturn(statements.slice(0, -1));
                    if (earlierReturn) {
                        this.context.fail(
                            earlierReturn,
                            "Destructured static tuple block callbacks support only a final return statement.",
                        );
                    }
                    for (const statement of statements.slice(0, -1)) {
                        this.context.emitStatement(statement);
                    }
                    return this.context.compileValue(finalStatement.expression);
                }
                if (firstReturn([callback.body])) {
                    this.context.fail(
                        callback.body,
                        "Destructured static tuple block callbacks do not support return statements.",
                    );
                }
                for (const statement of callback.body.statements) {
                    this.context.emitStatement(statement);
                }
                return { kind: "void", cpp: "" };
            }
            if (discardReturn) {
                this.context.emitExpressionAsStatement(callback.body);
                return { kind: "void", cpp: "" };
            }
            return this.context.compileValue(callback.body);
        } finally {
            this.context.bindings.popScope();
        }
    }

    private readIndexedProperty(
        owner: Value,
        key: Value,
        access: ts.ElementAccessExpression,
    ): Value | undefined {
        if (key.staticString === undefined) return undefined;
        const property = ts.factory.createPropertyAccessExpression(
            access.expression,
            key.staticString,
        );
        ts.setTextRange(property, access);
        ts.setOriginalNode(property, access);
        ts.setTextRange(property.name, access.argumentExpression);
        ts.setOriginalNode(property.name, access.argumentExpression);
        const value = this.context.propertyAccess.readResolvedProperty(
            owner,
            property,
        );
        if (value) this.context.emitDiscardedValue(key);
        return value;
    }

    /**
     * An index of an absent (null or undefined) receiver: an optional chain
     * short-circuits to undefined without evaluating the key; any other read
     * evaluates the key, then throws JavaScript's TypeError, typed as the
     * element it would have read.
     */
    private compileAbsentElementAccess(
        owner: Value,
        unwrapped: ts.ElementAccessExpression,
    ): Value {
        if (
            unwrapped.questionDotToken ||
            (ts.isOptionalChain(unwrapped) && owner.optionalChainShortCircuited)
        )
            return {
                kind: "json-null",
                cpp: "std::nullopt",
                optionalChainShortCircuited: true,
            };
        const type = this.context.dataLowerer.dataTypeAt(unwrapped);
        if (!type)
            return this.context.fail(
                unwrapped.expression,
                "Element access is not supported for json-null.",
            );
        this.context.emitDiscardedValue(
            this.compileValue(unwrapped.argumentExpression),
        );
        const absent = nullability(
            this.context.checker.getTypeAtLocation(
                this.context.unwrap(unwrapped.expression),
            ),
        );
        this.context.reachJsData();
        return this.context.dataLowerer.leafValue(
            `bbl::js::absent_receiver_read<${this.context.dataTypes.cppType(type)}>(${this.context.cppString(
                `Cannot read properties of ${absent.null && !absent.undefined ? "null" : "undefined"}`,
            )})`,
            type,
        );
    }

    private compileIndexedValue(
        unwrapped: ts.ElementAccessExpression,
        expression: ts.Expression,
        assertedNonNull: boolean,
    ): Value | undefined {
        // `baked.clips[<name>]`: one row of the bake's own map, read
        // natively because the bake decided the layout.
        const clipOwner = this.context.unwrap(unwrapped.expression);
        if (
            ts.isPropertyAccessExpression(clipOwner) &&
            clipOwner.name.text === "clips"
        ) {
            const map = this.context.probeEmission(() => {
                const value = this.compileValue(clipOwner);
                return value.kind === "vat-clip-map" ? value : undefined;
            });
            if (map) {
                return this.compileVatClipRow(map, unwrapped);
            }
        }
        const browserFile = compileBrowserFileElementAccess(
            this.context,
            unwrapped,
        );
        if (browserFile) {
            return browserFile;
        }
        const json = compileJsonRead(this.context, unwrapped);
        if (json) {
            return this.context.dataLowerer.narrowOptional(json, expression);
        }
        if (
            this.context.dataLowerer.dataTypeAt(unwrapped.expression)?.kind ===
            "enummap"
        ) {
            const constant = this.context.probeEmission(() => {
                const owner = this.compileValue(unwrapped.expression);
                if (owner.kind !== "record") return undefined;
                const key = this.compileValue(unwrapped.argumentExpression);
                // Select a known field before materializing a runtime enum
                // table would discard the field's constant facts.
                return this.readIndexedProperty(owner, key, unwrapped);
            });
            if (constant) return constant;
        }
        if (
            !assertedNonNull &&
            this.context.dataLowerer.mayCompileGuardableElementAccess(unwrapped)
        ) {
            const guardable =
                this.context.dataLowerer.compileGuardableElementAccess(
                    unwrapped,
                );
            if (guardable) return guardable;
        }
        const ownerExpression = this.context.unwrap(unwrapped.expression);
        if (ts.isConditionalExpression(ownerExpression)) {
            const selection = this.context.captureNativeExpression(() =>
                this.context.conditions.compileCondition(
                    ownerExpression.condition,
                ),
            );
            const condition = selection.cpp;
            const selectedOwner =
                condition === "true"
                    ? ownerExpression.whenTrue
                    : condition === "false"
                      ? ownerExpression.whenFalse
                      : undefined;
            const indexed = (owner: ts.Expression): Value =>
                this.context.dataLowerer.compileMaterializedElementAccess(
                    owner,
                    unwrapped.argumentExpression,
                ) ??
                this.compileValue(
                    ts.factory.createElementAccessExpression(
                        owner,
                        unwrapped.argumentExpression,
                    ),
                );
            if (selectedOwner) {
                return indexed(selectedOwner);
            }
            // Indexing distributes over a value-selecting conditional.
            // This lets each static table materialize under the shared
            // runtime index while preserving the conditional at the
            // selected element, rather than trying to index a
            // generation-only tuple.
            return this.selectValue(
                selection,
                indexed(ownerExpression.whenTrue),
                indexed(ownerExpression.whenFalse),
                unwrapped,
            );
        }
        const data = this.context.dataLowerer.compileDataPath(
            unwrapped,
            "read",
        );
        if (data) {
            return data;
        }
        const assetRoot =
            this.context.handleCollections.assetRootElementAccess(unwrapped);
        if (assetRoot) {
            return assetRoot;
        }
        const collectionElement =
            this.context.handleCollections.collectionElementAccess(unwrapped);
        if (collectionElement) {
            return collectionElement;
        }
        const owner = this.compileValue(unwrapped.expression);
        if (owner.kind === "json-null")
            return this.compileAbsentElementAccess(owner, unwrapped);
        const dataElement = this.context.dataLowerer.compileElementFromValue(
            owner,
            unwrapped.argumentExpression,
        );
        if (dataElement) {
            return assertedNonNull && dataElement.kind === "data"
                ? this.context.dataLowerer.narrowOptional(
                      dataElement,
                      expression,
                      true,
                  )
                : dataElement;
        }
        const key = this.compileValue(unwrapped.argumentExpression);
        const resolved = this.readIndexedProperty(owner, key, unwrapped);
        if (resolved) return resolved;
        if (owner.kind === "camera-world-matrix") {
            const index = this.compileValue(unwrapped.argumentExpression);
            if (
                index.kind !== "number" ||
                index.staticNumber === undefined ||
                !Number.isInteger(index.staticNumber) ||
                index.staticNumber < 0 ||
                index.staticNumber >= 16
            ) {
                this.context.fail(
                    unwrapped.argumentExpression,
                    "Camera world-matrix reads require a constant index from 0 through 15; mutable aliases are unsupported.",
                );
            }
            // The pinned `getCameraPosition` reads these three back out
            // of the camera's float32 world matrix, so the rounded
            // stored value is what a scene observes -- not the double
            // the eye was composed at.
            const element = index.staticNumber;
            return {
                kind: "number",
                cpp: `bbl::upstream::camera_world_matrix(${recordAt(`${this.context.requireEngine(owner, unwrapped)}.cameras`, owner.cpp)})[${element}]`,
                impure: true,
                ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
            };
        }
        if (owner.kind === "node-particle-column") {
            return readFrozenParticleElement(
                this.context,
                owner,
                this.context.compileNumber(
                    unwrapped.argumentExpression,
                    "double",
                ),
                unwrapped,
            );
        }
        if (owner.kind === "node-particle-set") {
            const slot = this.compileValue(unwrapped.argumentExpression);
            if (
                slot.kind !== "number" ||
                slot.staticNumber === undefined ||
                !Number.isInteger(slot.staticNumber) ||
                slot.staticNumber < 0
            ) {
                this.context.fail(
                    unwrapped.argumentExpression,
                    "A node-particle set's systems are indexed by a " +
                        "static non-negative integer.",
                );
            }
            // How many systems the set has is the graph's answer, not
            // this call's: the bake builds it and refuses an index it
            // has no system for.
            return {
                kind: "node-particle-system",
                cpp: "",
                ...(owner.nodeParticleSetIndex !== undefined
                    ? {
                          nodeParticleSetIndex: owner.nodeParticleSetIndex,
                      }
                    : {}),
                nodeParticleSystemIndex: slot.staticNumber,
                ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
            };
        }
        if (
            owner.kind === "node-particle-2d-binding" &&
            owner.nodeParticleLive
        ) {
            // `binding.bridges[k]`: one bridge of a live binding. How
            // many bridges the binding has is the graph's system
            // count, which the bake reports; the generated registrar
            // throws for an index it has no mapping for.
            const slot = this.compileValue(unwrapped.argumentExpression);
            if (
                slot.kind !== "number" ||
                slot.staticNumber === undefined ||
                !Number.isInteger(slot.staticNumber) ||
                slot.staticNumber < 0
            ) {
                this.context.fail(
                    unwrapped.argumentExpression,
                    "A pure-2D binding's bridges are indexed by a static " +
                        "non-negative integer.",
                );
            }
            return {
                ...owner,
                kind: "node-particle-2d-bridge",
                nodeParticleBridgeIndex: slot.staticNumber,
                nodeParticleSystemIndex: slot.staticNumber,
            };
        }
        if (owner.kind === "record") {
            const rawKey = this.compileValue(unwrapped.argumentExpression);
            const narrowedKey =
                rawKey.kind === "data"
                    ? this.context.dataLowerer.narrowOptional(
                          rawKey,
                          unwrapped.argumentExpression,
                      )
                    : rawKey;
            // A document key selects the property its ToString names.
            const key = isJsonValue(narrowedKey)
                ? this.context.dataLowerer.leafValue(
                      `${narrowedKey.cpp}.to_string()`,
                      { kind: "string" },
                  )
                : narrowedKey;
            const property =
                key.kind === "string"
                    ? key.staticString
                    : key.kind === "number" && key.staticNumber !== undefined
                      ? String(key.staticNumber)
                      : undefined;
            if (property === undefined) {
                const dynamicString =
                    key.kind === "string" ||
                    (key.kind === "data" &&
                        (key.dataType?.kind === "string" ||
                            (key.dataType?.kind === "optional" &&
                                key.dataType.inner.kind === "string")));
                const dynamicEnum =
                    key.kind === "data" && key.dataType?.kind === "enum";
                if (key.kind !== "number" && !dynamicString && !dynamicEnum) {
                    this.context.fail(
                        unwrapped.argumentExpression,
                        "Dynamic compile-time record access requires a string or numeric key.",
                    );
                }
                const indexedType =
                    this.context.dataLowerer.dataTypeAt(unwrapped);
                // A record read as `Record<string, unknown>` by a key known
                // only at run time reads a parsed view of the record: the
                // property the key names, or undefined.
                if (
                    !indexedType &&
                    (this.context.checker.getTypeAtLocation(unwrapped).flags &
                        (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !==
                        0 &&
                    (key.kind === "number" ||
                        key.kind === "string" ||
                        key.dataType?.kind === "string")
                ) {
                    const view =
                        this.context.dataLowerer.compileKnownValueForSink(
                            owner,
                            { kind: "json" },
                            unwrapped.expression,
                        );
                    const name =
                        key.kind === "number"
                            ? `bbl::js::number_to_string(${this.context.castNumber(key, "double")})`
                            : key.cpp;
                    this.context.reachJsData();
                    return this.context.dataLowerer.leafValue(
                        `${view}.get(${name})`,
                        { kind: "json" },
                    );
                }
                if (!indexedType) {
                    this.context.fail(
                        unwrapped,
                        "Dynamic numeric record values must belong to the native data model.",
                    );
                }
                // Record<number, T> is typed as T by TypeScript even
                // though a numeric property can be absent at runtime.
                // The lookup is therefore nullable whether or not the
                // checker already included undefined at this site.
                const ownerDataType = this.context.dataLowerer.dataTypeAt(
                    unwrapped.expression,
                );
                const declaredValueType =
                    ownerDataType?.kind === "map"
                        ? ownerDataType.value
                        : ownerDataType?.kind === "enummap"
                          ? ownerDataType.element
                          : indexedType;
                // Materializing a compile-time record as a native Map
                // stores its object values behind another container.
                // JavaScript Map/Record lookup must return the same object,
                // so object-valued entries need reference representation
                // whether or not a later mutation made that identity
                // obvious during the initial type scan.
                const valueType =
                    this.context.dataTypes.markStoredObjectReferences(
                        declaredValueType,
                    );
                if (
                    (ownerDataType?.kind === "map" ||
                        ownerDataType?.kind === "enummap") &&
                    Object.values(owner.recordProperties ?? {}).some(
                        (entry) => entry.kind === "record",
                    )
                ) {
                    // A lookup's local table would recreate scalarized entries on
                    // every call. Retain the dictionary at its source declaration.
                    const declaration = this.context.bindings.recordDeclaration(
                        owner,
                        unwrapped.expression,
                    );
                    if (declaration)
                        throw new DynamicBindingStorageRequired(
                            declaration,
                            "source",
                        );
                }
                const keyType = this.context.checker.getTypeAtLocation(
                    unwrapped.argumentExpression,
                );
                const closedEnumKey =
                    dynamicEnum ||
                    (keyType.flags & ts.TypeFlags.EnumLike) !== 0 ||
                    (keyType.symbol?.flags ?? 0) & ts.SymbolFlags.Enum;
                const ownerHasOptionalProperties = this.context.checker
                    .getTypeAtLocation(unwrapped.expression)
                    .getProperties()
                    .some(
                        (member) =>
                            (member.flags & ts.SymbolFlags.Optional) !== 0,
                    );
                const totalClosedKey =
                    closedEnumKey &&
                    indexedType.kind !== "optional" &&
                    !ownerHasOptionalProperties;
                const valueCpp = this.context.dataTypes.cppType(valueType);
                let entries: string[] = [];
                const { value: entryLines, nativeCaptures } =
                    this.context.captureNativeDependencies(() =>
                        this.context.captureEmittedLines(() => {
                            entries = Object.entries(
                                owner.recordProperties ?? {},
                            ).map(([name, value]) => {
                                // The key's narrowed union need not contain every
                                // property on its owner. Object property names stay
                                // strings even when the index uses a finite union.
                                if (dynamicString || dynamicEnum) {
                                    return `{${this.context.cppString(name)}, ${this.context.dataLowerer.compileKnownValueForSink(value, valueType, unwrapped)}}`;
                                }
                                const numericKey = Number(name);
                                if (!Number.isFinite(numericKey)) {
                                    this.context.fail(
                                        unwrapped.expression,
                                        `Dynamic numeric record has non-numeric key '${name}'.`,
                                    );
                                }
                                return `{${doubleLiteral(numericKey)}, ${this.context.dataLowerer.compileKnownValueForSink(value, valueType, unwrapped)}}`;
                            });
                        }),
                    );
                const requiresNativeOwner =
                    entryLines.length !== 0 || nativeCaptures.length !== 0;
                if (
                    requiresNativeOwner &&
                    (ownerDataType?.kind === "map" ||
                        ownerDataType?.kind === "enummap")
                ) {
                    // Factory results may already be native leaves. Their
                    // captured owners cannot be hoisted, nor reconstructed
                    // on every lookup of the original dictionary.
                    const declaration = this.context.bindings.recordDeclaration(
                        owner,
                        unwrapped.expression,
                    );
                    if (declaration)
                        throw new DynamicBindingStorageRequired(
                            declaration,
                            "source",
                        );
                }
                for (const line of entryLines) this.context.emit(line);
                this.context.reachJsData();
                const keyCpp =
                    dynamicString || dynamicEnum ? "std::string" : "double";
                const mapType = `bbl::js::Map<${keyCpp}, ${valueCpp}>`;
                const table = this.context.nativeEmission.recordAccessor(
                    owner,
                    mapType,
                    entries,
                    !requiresNativeOwner &&
                        (this.isModuleConstantRecord(unwrapped.expression) ||
                            Object.values(owner.recordProperties ?? {}).every(
                                (value) => this.canHoistRecordValue(value),
                            )),
                );
                const keyExpression =
                    key.dataType?.kind === "enum"
                        ? this.context.dataTypes.enumToStringCpp(
                              key.dataType,
                              key.cpp,
                              unwrapped.argumentExpression,
                          )
                        : key.cpp;
                const lookup = `${table}.${totalClosedKey ? "at" : "get"}(${keyExpression})`;
                if (!totalClosedKey)
                    return this.context.dataLowerer.mapPropertyValue(
                        table,
                        keyExpression,
                        valueType,
                    );
                const recordValues = Object.values(
                    owner.recordProperties ?? {},
                );
                const animationGroupSource =
                    recordValues.length > 0 &&
                    recordValues[0]!.animationGroupSource !== undefined &&
                    recordValues.every(
                        (value) =>
                            value.animationGroupSource ===
                            recordValues[0]!.animationGroupSource,
                    )
                        ? recordValues[0]!.animationGroupSource
                        : undefined;
                const engineCpp =
                    recordValues.length > 0 &&
                    recordValues[0]!.engineCpp !== undefined &&
                    recordValues.every(
                        (value) =>
                            value.engineCpp === recordValues[0]!.engineCpp,
                    )
                        ? recordValues[0]!.engineCpp
                        : undefined;
                if (valueType.kind === "handle") {
                    const value = this.context.dataLowerer.leafValue(
                        lookup,
                        valueType,
                    );
                    if (
                        value.kind === "animation-group" &&
                        animationGroupSource
                    ) {
                        writable(value).animationGroupSource =
                            animationGroupSource;
                    }
                    return {
                        ...value,
                        ...(engineCpp ? { engineCpp } : {}),
                    };
                }
                return {
                    ...this.context.dataLowerer.leafValue(lookup, valueType),
                    ownedCpp: `bbl::js::snapshot_value(${lookup})`,
                    nativeLvalue: true,
                };
            }
            const value = owner.recordProperties?.[property];
            if (!value) {
                const method = owner.recordMethods?.[property];
                if (method)
                    return {
                        kind: "callback",
                        cpp: "",
                        callbackDeclaration: method,
                        callbackRecordOwner: owner,
                    };
                if (
                    this.context.dataLowerer.declaredAsDictionary(
                        unwrapped.expression,
                    )
                )
                    return {
                        kind: "json-null",
                        cpp: "std::nullopt",
                        preserveUncheckedLookup: true,
                    };
                this.context.fail(
                    unwrapped.argumentExpression,
                    `Compile-time record has no property '${property}'.`,
                );
            }
            return value;
        }
        // A property no prototype of a number or boolean defines reads
        // undefined (`(42)["format"]`).
        if (owner.kind === "number" || owner.kind === "boolean") {
            const key = this.compileValue(unwrapped.argumentExpression);
            const name =
                key.staticString ??
                (key.staticNumber !== undefined
                    ? String(key.staticNumber)
                    : undefined);
            if (name !== undefined && !PRIMITIVE_PROTOTYPE_MEMBERS.has(name)) {
                this.context.emitDiscardedValue(owner);
                this.context.emitDiscardedValue(key);
                return { kind: "json-null", cpp: "std::nullopt" };
            }
        }
        if (owner.kind !== "tuple") {
            this.context.fail(
                unwrapped.expression,
                `Element access is not supported for ${owner.kind}.`,
            );
        }
        const index = this.compileValue(unwrapped.argumentExpression);
        if (index.kind !== "number") {
            this.context.fail(
                unwrapped.argumentExpression,
                "Static tuple access requires a numeric index.",
            );
        }
        // The index runs once, where JavaScript reads it, whichever lane it
        // selects and however many lanes compare it: none for a single
        // element or a lane generation knows, several for three or more.
        const selector =
            expressionHasEffects(unwrapped.argumentExpression) &&
            !this.context.dataLowerer.isHeldStoreKey(
                unwrapped.argumentExpression,
            )
                ? pinOperand(
                      this.context,
                      index,
                      unwrapped.argumentExpression,
                      "element_index",
                  )
                : index;
        const staticIndex =
            index.staticNumber ??
            staticNumberValue(this.context, unwrapped.argumentExpression);
        if (staticIndex === undefined) {
            const elements = owner.tupleElements ?? [];
            if (elements.length === 0) {
                this.context.fail(
                    unwrapped,
                    "A runtime index cannot read an empty static tuple.",
                );
            }
            let selected = elements[0]!;
            for (let lane = 1; lane < elements.length; lane += 1) {
                selected = this.selectValue(
                    this.context.captureNativeExpression(() => {
                        this.context.useNativeValue(selector);
                        return `(${selector.cpp}) == ${lane}`;
                    }),
                    elements[lane]!,
                    selected,
                    unwrapped,
                );
            }
            return selected;
        }
        if (!Number.isInteger(staticIndex)) {
            this.context.fail(
                unwrapped.argumentExpression,
                "Static tuple access requires an integer index.",
            );
        }
        const value = owner.tupleElements?.[staticIndex];
        if (!value) {
            const resultType =
                this.context.checker.getTypeAtLocation(unwrapped);
            const resultMembers =
                (resultType.flags & ts.TypeFlags.Union) !== 0
                    ? (resultType as ts.UnionType).types
                    : [resultType];
            if (
                resultMembers.some(
                    (member) =>
                        (member.flags &
                            (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !==
                        0,
                ) ||
                (ts.isBinaryExpression(unwrapped.parent) &&
                    unwrapped.parent.left === unwrapped &&
                    unwrapped.parent.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken)
            ) {
                // A lane past the tuple's end reads as `undefined`.
                return { kind: "json-null", cpp: "std::nullopt" };
            }
            this.context.fail(
                unwrapped,
                `Tuple index ${staticIndex} is out of range.`,
            );
        }
        return value;
    }

    /**
     * A folded conditional's or nullish's selected operand is the whole
     * expression's value, so it takes the full value pipeline (platform and
     * worker values included).
     */
    private compileSelectedOperand(expression: ts.Expression): Value {
        return this.context.compileValue(expression);
    }

    private compileConditionalValue(
        unwrapped: ts.ConditionalExpression,
    ): Value | undefined {
        // Optional/vector/struct conditionals normally ask their native
        // sink to lower both branches. Before doing that, retain the
        // ordinary value path's stronger answer when a side-effect-free
        // condition is generation-known. This is especially important
        // for a static record's optional field: the selected value is a
        // string, not native optional storage merely because the checker
        // still exposes the unselected `undefined` branch.
        const browserCondition =
            this.context.browserErasure.evaluateBrowserValue(
                unwrapped.condition,
            );
        const foldedCondition =
            browserCondition?.kind === "boolean"
                ? browserCondition.value
                    ? "true"
                    : "false"
                : !containsEvaluatedCall(unwrapped.condition)
                  ? this.context.probeEmission(
                        () =>
                            this.context.conditions.compileCondition(
                                unwrapped.condition,
                            ),
                        (condition) =>
                            condition === "true" || condition === "false",
                    )
                  : undefined;
        if (foldedCondition === "true" || foldedCondition === "false") {
            const taken =
                foldedCondition === "true"
                    ? unwrapped.whenTrue
                    : unwrapped.whenFalse;
            const dropped =
                foldedCondition === "true"
                    ? unwrapped.whenFalse
                    : unwrapped.whenTrue;
            const selected = this.compileSelectedOperand(taken);
            // When the arm generation just discarded was the NULL one,
            // the binding it feeds can no longer be absent -- and the
            // scene's own guard over it is therefore settled. Say so on
            // the value, the way a find the materialized asset resolved
            // at generation carries the constant "true": the guard then
            // folds through the ordinary optional path instead of
            // needing a per-kind truthiness rule. Scene 140 writes
            // `const sg = noShadows ? null : createPcf(...)` and then
            // `if (sg)`, with `noShadows` folded from its query.
            const droppedIsNullish = this.context.symbols.isNullishLiteral(
                this.context.unwrap(dropped),
            );
            // Only for a RESOURCE, because `optionalFoundCpp` means
            // presence and the consumers read it as truthiness. Those
            // two agree for a handle -- a mesh that exists is truthy
            // -- and part company for a value JavaScript can call
            // falsy while holding it: `flag ? 0 : null` surviving as
            // 0 would fold `if (n)` to true. A data or primitive arm
            // keeps whatever truthiness the ordinary path gives it.
            const survivorIsResource =
                selected.kind !== "number" &&
                selected.kind !== "string" &&
                selected.kind !== "boolean" &&
                selected.kind !== "data";
            if (
                droppedIsNullish &&
                survivorIsResource &&
                objectTruthinessCpp(selected) === undefined
            ) {
                return { ...selected, optionalFoundCpp: "true" };
            }
            return selected;
        }
        const contextual = this.context.checker.getContextualType(unwrapped);
        const contextualType = contextual
            ? this.context.dataTypes.fromTsType(contextual, unwrapped)
            : undefined;
        let inferred =
            this.context.dataLowerer.dataTypeAt(unwrapped) ??
            (contextualType &&
            [
                "number",
                "boolean",
                "string",
                "enum",
                "vector",
                "span",
                "product",
                "tuple",
            ].includes(contextualType.kind)
                ? contextualType
                : undefined);
        if (
            !inferred &&
            (this.context.checker
                .getTypeAtLocation(unwrapped)
                .getCallSignatures().length > 0 ||
                this.context.symbols.isNullishLiteral(
                    this.context.unwrap(unwrapped.whenTrue),
                ) ||
                this.context.symbols.isNullishLiteral(
                    this.context.unwrap(unwrapped.whenFalse),
                ))
        ) {
            // Selected callbacks and nullable callback records need owned
            // storage even when ordinary inference keeps them static.
            const stored = this.context.dataTypes.fromStoredTsType(
                this.context.checker.getTypeAtLocation(unwrapped),
                unwrapped,
            );
            if (stored)
                inferred =
                    this.context.dataTypes.markStoredObjectReferences(stored);
        }
        // A selected fresh readonly array, present or absent, must outlive
        // its branch's temporaries.
        const selectedArray =
            inferred?.kind === "optional" ? inferred.inner : inferred;
        // Arms of two record types select one existing object: both are
        // stored as the result's record type, in shared reference storage.
        const armRecord = (arm: ts.Expression): string | undefined => {
            if (ts.isObjectLiteralExpression(this.context.unwrap(arm)))
                return undefined;
            const type = this.context.dataLowerer.dataTypeAt(arm);
            return type?.kind === "struct" ? type.name : undefined;
        };
        const distinctRecordArms =
            inferred?.kind === "struct" &&
            armRecord(unwrapped.whenTrue) !== undefined &&
            armRecord(unwrapped.whenFalse) !== undefined &&
            armRecord(unwrapped.whenTrue) !== armRecord(unwrapped.whenFalse);
        const conditionalType =
            inferred && (selectedArray?.kind === "span" || distinctRecordArms)
                ? this.context.dataTypes.markStoredObjectReferences(inferred)
                : inferred?.kind === "enum"
                  ? { kind: "string" as const }
                  : inferred;
        if (
            conditionalType?.kind === "string" ||
            conditionalType?.kind === "number" ||
            conditionalType?.kind === "function" ||
            conditionalType?.kind === "promise" ||
            conditionalType?.kind === "union" ||
            conditionalType?.kind === "product" ||
            conditionalType?.kind === "vector" ||
            conditionalType?.kind === "set" ||
            conditionalType?.kind === "map" ||
            conditionalType?.kind === "json" ||
            (conditionalType?.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(conditionalType.name))
        ) {
            const condition = this.context.conditions.compileCondition(
                unwrapped.condition,
            );
            if (condition === "true" || condition === "false") {
                // Keep the selected Value's generation-known metadata.
                // A string-only sink would discard staticNumber, for
                // example when the chosen number configures engine MSAA.
                return this.compileSelectedOperand(
                    condition === "true"
                        ? unwrapped.whenTrue
                        : unwrapped.whenFalse,
                );
            }
            // The common sink keeps all branch preparation inside the
            // selected arm, including optional Map.get temporaries and
            // array literals that need runtime storage of different sizes.
            if (["struct", "vector", "map"].includes(conditionalType.kind)) {
                const dynamic = this.tryCompileJsonConditional(
                    unwrapped,
                    condition,
                );
                if (dynamic) return dynamic;
            }
            const cpp = this.inRuntimeControlFlow(() =>
                this.context.dataLowerer.compileConditionalForSink(
                    unwrapped,
                    conditionalType,
                    condition,
                ),
            );
            return conditionalType.kind === "string"
                ? { kind: "string", cpp, dataType: conditionalType }
                : this.context.dataValue(cpp, conditionalType);
        }
        if (conditionalType?.kind === "optional") {
            const objectIdentity =
                conditionalType.inner.kind === "struct"
                    ? this.inRuntimeControlFlow(() =>
                          this.context.dataLowerer.objectIdentity(unwrapped),
                      )
                    : undefined;
            return {
                kind: "data",
                cpp:
                    objectIdentity ??
                    this.inRuntimeControlFlow(() =>
                        this.context.dataLowerer.compileForSink(
                            unwrapped,
                            conditionalType,
                        ),
                    ),
                dataType: conditionalType,
                ...(objectIdentity
                    ? {
                          objectIdentityCpp: objectIdentity,
                          optionalFoundCpp: `(${objectIdentity}) != nullptr`,
                      }
                    : {}),
            };
        }
        const selection = this.context.captureNativeExpression(() =>
            this.context.conditions.compileCondition(unwrapped.condition),
        );
        const condition = selection.cpp;
        if (condition === "true" || condition === "false") {
            return this.compileSelectedOperand(
                condition === "true" ? unwrapped.whenTrue : unwrapped.whenFalse,
            );
        }
        const jsonConditional = this.tryCompileJsonConditional(
            unwrapped,
            condition,
        );
        if (jsonConditional) return jsonConditional;
        const branch = (expression: ts.Expression, truth: boolean): Value => {
            const value = this.compileValue(expression);
            const guard = this.context.unwrap(unwrapped.condition);
            const selected = this.context.unwrap(expression);
            if (
                value.dataType?.kind !== "optional" ||
                !ts.isIdentifier(selected) ||
                !ts.isBinaryExpression(guard)
            )
                return value;
            const equal =
                guard.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken ||
                guard.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken;
            const unequal =
                guard.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsEqualsToken ||
                guard.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsToken;
            if ((!equal && !unequal) || truth === equal) return value;
            const absent = (node: ts.Expression): boolean =>
                this.context.symbols.isNullishLiteral(
                    this.context.unwrap(node),
                );
            const tested = absent(guard.left)
                ? this.context.unwrap(guard.right)
                : absent(guard.right)
                  ? this.context.unwrap(guard.left)
                  : undefined;
            return tested &&
                ts.isIdentifier(tested) &&
                declaredSymbol(this.context.checker, tested) ===
                    declaredSymbol(this.context.checker, selected)
                ? this.context.dataLowerer.narrowOptional(
                      value,
                      expression,
                      true,
                  )
                : value;
        };
        const trueArm = this.context.dataLowerer.compileArm(() =>
            branch(unwrapped.whenTrue, true),
        );
        const falseArm = this.context.dataLowerer.compileArm(() =>
            branch(unwrapped.whenFalse, false),
        );
        if (trueArm.lines.length > 0 || falseArm.lines.length > 0) {
            // An arm that prepares its value (a pinned call result, say)
            // runs that preparation only when selected: the data sink keeps
            // each arm's lines inside it, and a resource the sink does not
            // convert selects as itself, its preparation moved into the
            // lambda that spells it. A spread's operand keeps the record
            // an unprepared one selects: its keys are what the spread copies.
            const aggregate = (arm: { value: Value; lines: string[] }) =>
                arm.lines.length > 0 &&
                (arm.value.kind === "record" || arm.value.kind === "tuple");
            const spreadOperand =
                spreadsItsValue(unwrapped) &&
                (aggregate(trueArm) || aggregate(falseArm));
            const sunk =
                conditionalType && !spreadOperand
                    ? this.context.probeEmission(() => {
                          try {
                              return this.context.dataLowerer.compileConditionalForSink(
                                  unwrapped,
                                  conditionalType,
                                  condition,
                                  { whenTrue: trueArm, whenFalse: falseArm },
                              );
                          } catch (error) {
                              if (error instanceof CompileError)
                                  return undefined;
                              throw error;
                          }
                      })
                    : undefined;
            if (conditionalType && sunk !== undefined)
                return this.context.dataValue(sunk, conditionalType);
            // An arm whose prepared members are read after it runs needs the
            // condition once, ahead of both.
            let pinned: NativeExpression | undefined;
            const selected = (): NativeExpression => {
                if (pinned) return pinned;
                const value = this.context.bindings.pinValueToTemporary(
                    { kind: "boolean", ...selection },
                    "arm_selected",
                    unwrapped.condition,
                );
                return (pinned = {
                    cpp: value.cpp,
                    nativeCaptures: value.nativeCaptures ?? [],
                });
            };
            const whenTrue = this.lazyArmValue(
                trueArm,
                unwrapped.whenTrue,
                () => selected().cpp,
            );
            const whenFalse = this.lazyArmValue(
                falseArm,
                unwrapped.whenFalse,
                () => `!(${selected().cpp})`,
            );
            return this.selectValue(
                pinned ?? selection,
                whenTrue,
                whenFalse,
                unwrapped,
            );
        }
        const whenTrue = trueArm.value;
        const whenFalse = falseArm.value;
        // A tuple value is a compile-time list of element values with
        // no native expression of its own, so selecting between two
        // tuples is selecting element by element. Same arity is the
        // condition for that to be the same thing.
        if (whenTrue.kind === "tuple" && whenFalse.kind === "tuple") {
            const trueElements = whenTrue.tupleElements ?? [];
            const falseElements = whenFalse.tupleElements ?? [];
            if (trueElements.length !== falseElements.length) {
                this.context.fail(
                    unwrapped,
                    "Conditional tuple branches must have the same length.",
                );
            }
            return {
                kind: "tuple",
                cpp: "",
                tupleElements: trueElements.map((element, index) =>
                    this.selectValue(
                        selection,
                        element,
                        falseElements[index]!,
                        unwrapped,
                    ),
                ),
            };
        }
        return this.selectValue(selection, whenTrue, whenFalse, unwrapped);
    }

    private tryCompileJsonConditional(
        unwrapped: ts.ConditionalExpression,
        condition: string,
    ): Value | undefined {
        return this.context.probeEmission(() => {
            let whenTrue!: Value, whenFalse!: Value;
            const trueLines = this.context.captureEmittedLines(() => {
                whenTrue = this.inRuntimeControlFlow(() =>
                    this.compileValue(unwrapped.whenTrue),
                );
            });
            const falseLines = this.context.captureEmittedLines(() => {
                whenFalse = this.inRuntimeControlFlow(() =>
                    this.compileValue(unwrapped.whenFalse),
                );
            });
            if (
                whenTrue.dataType?.kind !== "json" &&
                whenFalse.dataType?.kind !== "json"
            )
                return undefined;
            const type = { kind: "json" as const };
            return this.context.dataValue(
                this.context.dataLowerer.compileConditionalForSink(
                    unwrapped,
                    type,
                    condition,
                    {
                        whenTrue: { value: whenTrue, lines: trueLines },
                        whenFalse: { value: whenFalse, lines: falseLines },
                    },
                ),
                type,
            );
        });
    }

    private compileObjectValue(
        unwrapped: ts.ObjectLiteralExpression,
    ): Value | undefined {
        const dynamicSpread = hasDynamicObjectSpread(this.context, unwrapped);
        // A struct whose `?` fields decide its keys at run time spreads into
        // a dictionary of dynamic values when the position names one.
        const optionalKeysSpread = unwrapped.properties.some(
            (property) =>
                ts.isSpreadAssignment(property) &&
                this.spreadsOptionalOwnKeys(property.expression),
        );
        // A computed key a run-time value selects writes the record of the
        // position's type; no compile-time record can name it.
        const runtimeKeyed = unwrapped.properties.some((property) => {
            const key = this.context.dataLowerer.runtimeKey(property);
            return (
                key !== undefined &&
                this.context.probeEmission(
                    () => {
                        const value = this.compileValue(key);
                        return value.staticString ?? value.staticNumber;
                    },
                    () => false,
                ) === undefined
            );
        });
        if (
            unwrapped.properties.some((property) => {
                if (!ts.isSpreadAssignment(property)) return false;
                const type = this.context.dataLowerer.dataTypeAt(
                    property.expression,
                );
                return (
                    type?.kind === "map" ||
                    (type?.kind === "optional" &&
                        type.inner.kind === "map" &&
                        type.inner.dictionary)
                );
            }) ||
            dynamicSpread ||
            optionalKeysSpread ||
            runtimeKeyed
        ) {
            // The expression creates its own properties. A contextual interface
            // can be narrower, or open-ended, without changing those properties.
            const record = runtimeKeyed
                ? undefined
                : this.context.probeEmission(() =>
                      this.compileStaticObjectValue(unwrapped, true),
                  );
            if (record) return record;
            const contextual =
                this.context.checker.getContextualType(unwrapped);
            const type = this.context.dataTypes.withDynamicJsonTypes(
                dynamicSpread || optionalKeysSpread,
                () => {
                    const contextualType =
                        contextual &&
                        this.context.dataTypes.fromTsType(
                            contextual,
                            unwrapped,
                        );
                    // A dictionary spread contributes keys beyond the named
                    // fields inferred for the object literal.
                    if (
                        contextualType?.kind === "map" &&
                        contextualType.dictionary
                    )
                        return contextualType;
                    // A run-time key selects one of the position's fields;
                    // the literal's own type is an index signature.
                    if (runtimeKeyed && contextualType?.kind === "struct")
                        return contextualType;
                    return (
                        this.context.dataLowerer.dataTypeAt(unwrapped) ??
                        contextualType
                    );
                },
            );
            if (type?.kind === "map" || dynamicSpread) {
                const dictionary: DataType<"map"> =
                    type?.kind === "map"
                        ? type
                        : {
                              kind: "map",
                              key: { kind: "string" },
                              value: { kind: "json" },
                              dictionary: true,
                          };
                return this.context.dataLowerer.leafValue(
                    this.context.dataLowerer.compileForSink(
                        unwrapped,
                        dictionary,
                    ),
                    dictionary,
                );
            }
            if (type?.kind === "struct") {
                return this.context.dataLowerer.leafValue(
                    this.context.dataLowerer.compileForSink(unwrapped, type),
                    type,
                );
            }
        }
        return this.compileStaticObjectValue(unwrapped);
    }

    /** Whether a spread source is a struct whose `?` fields decide its keys at run time. */
    private spreadsOptionalOwnKeys(expression: ts.Expression): boolean {
        const dataType = this.context.dataLowerer.dataTypeAt(
            this.context.unwrap(expression),
        );
        return (
            dataType?.kind === "struct" &&
            !this.context.dataTypes.ownKeysDecided(dataType.name, expression)
        );
    }

    private compileStaticObjectValue(
        unwrapped: ts.ObjectLiteralExpression,
        allowDictionarySpread = false,
    ): Value | undefined {
        const properties: Record<string, Value> = {};
        const methods: Record<
            string,
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration
        > = {};
        const getters: Record<string, ts.GetAccessorDeclaration> = {};
        const setters: Record<string, ts.SetAccessorDeclaration> = {};
        const ownKeys = new Set<string>();
        const storeProperty = (name: string, value: Value): void => {
            ownKeys.add(name);
            properties[name] = value;
            delete methods[name];
            delete getters[name];
            delete setters[name];
        };
        const storeMethod = (
            name: string,
            method: NonNullable<Value["recordMethods"]>[string],
        ): void => {
            ownKeys.add(name);
            methods[name] = method;
            delete properties[name];
            delete getters[name];
            delete setters[name];
        };
        // A property value a later one touches the storage of, either
        // one writing it, is evaluated where JavaScript evaluates it (see
        // `evaluation-order.ts`).
        const ordered = this.context.evaluationOrder.operandsToPin(
            unwrapped.properties.map((property) =>
                ts.isPropertyAssignment(property)
                    ? property.initializer
                    : ts.isShorthandPropertyAssignment(property)
                      ? property.name
                      : ts.isSpreadAssignment(property)
                        ? property.expression
                        : property,
            ),
        );
        const member = (value: Value, index: number, node: ts.Expression) =>
            ordered[index]
                ? pinOperand(this.context, value, node, "record_member")
                : this.builtLane(value, node);
        // A key a spread writes only while it is own replaces an earlier
        // one only then.
        const replaceWhileOwn = (
            key: string,
            value: Value,
            property: ts.SpreadAssignment,
        ): void => {
            const existing = properties[key];
            if (!existing)
                this.context.fail(
                    property,
                    `A conditionally present spread key '${key}' cannot replace a method or accessor.`,
                );
            const held = this.context.bindings.pinValueToTemporary(
                value,
                "spread_member",
                property.expression,
            );
            const { value: entry, nativeCaptures } =
                this.context.captureNativeDependencies(() =>
                    this.context.dataLowerer.recordMemberEntry(
                        key,
                        held,
                        property,
                    ),
                );
            // A key that is always own replaces the earlier one outright.
            if (entry.presence === undefined) return storeProperty(key, held);
            // Both values select as the storage the key holds when present.
            const type = entry.value.dataType;
            const merged = this.selectValue(
                { cpp: entry.presence.ownCpp, nativeCaptures },
                type
                    ? this.selectedArmValue(
                          entry.value,
                          type,
                          property.expression,
                      )
                    : entry.value,
                type
                    ? this.selectedArmValue(existing, type, property.expression)
                    : existing,
                property.expression,
            );
            storeProperty(
                key,
                existing.conditionalOwnKey
                    ? { ...merged, conditionalOwnKey: true }
                    : merged,
            );
        };
        for (const [index, property] of unwrapped.properties.entries()) {
            if (ts.isSpreadAssignment(property)) {
                const spread = this.compileValue(property.expression);
                refuseErrorReflection(this.context, spread, property);
                // A struct whose fields are always own spreads its current
                // field values; a `?` field's key is decided at run time.
                if (
                    spread.kind === "data" &&
                    spread.dataType?.kind === "struct"
                ) {
                    const known = ownKeysKnown(this.context, spread, property);
                    if (!known && allowDictionarySpread) return undefined;
                    // A `?` field whose storage says whether it is own
                    // becomes a key the record holds while it is present.
                    const entries = structOwnEntries(
                        this.context,
                        known
                            ? spread
                            : this.context.bindings.pinValueToTemporary(
                                  spread,
                                  "spread_source",
                                  property.expression,
                              ),
                        spread.dataType,
                        property,
                    );
                    if (entries.some((entry) => entry.presence && !entry.slot))
                        this.context.fail(
                            property,
                            "A struct with optional properties spreads into a dictionary or a struct; a compile-time record needs keys known at generation.",
                        );
                    for (const { key, value, slot } of entries) {
                        if (!slot) {
                            storeProperty(
                                key,
                                member(value, index, property.expression),
                            );
                            continue;
                        }
                        const conditional: Value = {
                            ...slot,
                            conditionalOwnKey: true,
                        };
                        if (ownKeys.has(key))
                            replaceWhileOwn(key, conditional, property);
                        else
                            storeProperty(
                                key,
                                member(conditional, index, property.expression),
                            );
                    }
                    continue;
                }
                if (
                    spread.kind !== "record" &&
                    spread.recordProperties === undefined
                ) {
                    if (
                        allowDictionarySpread &&
                        (spread.dataType?.kind === "map" ||
                            (spread.dataType?.kind === "optional" &&
                                spread.dataType.inner.kind === "map" &&
                                spread.dataType.inner.dictionary) ||
                            isJsonValue(spread) ||
                            spread.kind === "string" ||
                            spread.kind === "number" ||
                            spread.kind === "boolean" ||
                            spread.kind === "void" ||
                            spread.kind === "json-null")
                    )
                        return undefined;
                    this.context.fail(
                        property,
                        "Compile-time object spread requires a plain record value or a data record with a complete static property snapshot " +
                            `(received ${spread.kind}${spread.dataType ? ` ${JSON.stringify(spread.dataType)}` : ""}).`,
                    );
                }
                const readsGetters =
                    Object.keys(spread.recordGetters ?? {}).length > 0;
                for (const key of recordPropertyKeys(spread)) {
                    const getter = spread.recordGetters?.[key];
                    const method = spread.recordMethods?.[key];
                    if (method && !getter) {
                        storeMethod(key, method);
                        continue;
                    }
                    const value = getter
                        ? this.context.compileRecordGetter(spread, getter)
                        : (spread.recordProperties?.[key] ?? {
                              kind: "json-null" as const,
                              cpp: "std::nullopt",
                          });
                    if (value.conditionalOwnKey && ownKeys.has(key)) {
                        replaceWhileOwn(key, value, property);
                        continue;
                    }
                    storeProperty(
                        key,
                        readsGetters
                            ? this.context.bindings.pinValueToTemporary(
                                  value,
                                  "spread_member",
                              )
                            : member(value, index, property.expression),
                    );
                }
                continue;
            }
            if (ts.isGetAccessorDeclaration(property)) {
                const name = this.context.propertyName(property.name);
                if (!name) {
                    this.context.fail(
                        property.name,
                        "Static record properties require literal names.",
                    );
                }
                getters[name] = property;
                ownKeys.add(name);
                delete properties[name];
                delete methods[name];
                continue;
            }
            if (ts.isSetAccessorDeclaration(property)) {
                const name = this.context.propertyName(property.name);
                if (!name) {
                    this.context.fail(
                        property.name,
                        "Static record properties require literal names.",
                    );
                }
                setters[name] = property;
                ownKeys.add(name);
                delete properties[name];
                delete methods[name];
                continue;
            }
            if (ts.isMethodDeclaration(property)) {
                const name = this.context.propertyName(property.name);
                if (!name) {
                    this.context.fail(
                        property.name,
                        "Static record methods require literal names.",
                    );
                }
                storeMethod(name, property);
                continue;
            }
            if (ts.isPropertyAssignment(property)) {
                const name = this.context.propertyName(property.name);
                if (!name) {
                    this.context.fail(
                        property.name,
                        "Static record properties require literal names.",
                    );
                }
                const initializer = this.context.unwrap(property.initializer);
                if (
                    ts.isIdentifier(initializer) &&
                    this.context.namesLocalFunction(initializer)
                ) {
                    storeMethod(name, initializer);
                    continue;
                }
                if (ts.isArrowFunction(initializer)) {
                    storeProperty(name, this.compileValue(initializer));
                    continue;
                }
                if (ts.isFunctionExpression(initializer)) {
                    storeMethod(name, initializer);
                    continue;
                }
                const value = member(
                    this.laneValue(property.initializer),
                    index,
                    property.initializer,
                );
                const contextual =
                    this.context.checker.getContextualType(unwrapped);
                const declared =
                    contextual &&
                    this.context.checker.getPropertyOfType(contextual, name);
                const propertyType = declared
                    ? this.context.checker.getTypeOfSymbolAtLocation(
                          declared,
                          property.name,
                      )
                    : this.context.checker.getTypeAtLocation(property.name);
                storeProperty(
                    name,
                    value.staticString !== undefined &&
                        propertyType.isStringLiteral()
                        ? { ...value, readOnly: true }
                        : value,
                );
            } else if (ts.isShorthandPropertyAssignment(property)) {
                if (this.context.namesLocalFunction(property.name)) {
                    storeMethod(property.name.text, property.name);
                    continue;
                }
                storeProperty(
                    property.name.text,
                    member(this.laneValue(property.name), index, property.name),
                );
            } else {
                this.context.fail(
                    property,
                    "Static records support property assignments, methods, getters, and properties naming a local function.",
                );
            }
        }
        const closes =
            Object.keys(methods).length > 0 ||
            Object.keys(getters).length > 0 ||
            Object.keys(setters).length > 0;
        const evaluationIdentity = this.context.callbackEvaluationIdentity();
        const record: Value = {
            kind: "record",
            cpp: "",
            recordProperties: properties,
            recordMethods: methods,
            recordGetters: getters,
            recordSetters: setters,
            // Only a record with code in it needs its scope: a
            // plain property already holds a resolved value.
            ...(closes
                ? {
                      recordPropertyOrder: [...ownKeys],
                      ...this.context.captureRecordScopes(),
                      ...(this.context.isInRuntimeIteration() ||
                      this.context.isInNativeFunctionBody()
                          ? {
                                repeatedCallbackEvaluation: true as const,
                            }
                          : {}),
                      ...(evaluationIdentity
                          ? {
                                callbackEvaluationIdentity: evaluationIdentity,
                            }
                          : {}),
                  }
                : {}),
        };
        // A coroutine method can retain its receiver after the creating scope
        // returns. Allocate its mutable fields before either branch calls it.
        const asyncReceiver =
            this.context.options.workers &&
            Object.values(methods).some(
                (method) =>
                    !ts.isIdentifier(method) &&
                    ts
                        .getModifiers(method)
                        ?.some(
                            (modifier) =>
                                modifier.kind === ts.SyntaxKind.AsyncKeyword,
                        ),
            );
        return asyncReceiver
            ? this.context.bindings.materializeEscapingValue(
                  record,
                  "async_receiver",
              )
            : record;
    }

    /**
     * `f.bind(thisArg, a, b)`: a fresh function of the parameters after the
     * bound ones. The bound arguments are read once, in order after the
     * target and thisArg, when `bind` runs; each call passes them before its
     * own arguments. Bound arguments past the parameters are read and
     * ignored, as the target ignores them.
     */
    private compilePartialBind(
        call: ts.CallExpression,
        target: string,
        type: DataType<"function">,
        receiverCpp: string,
    ): Value {
        const bound = call.arguments.slice(1);
        if (type.erasedParameters?.length || type.generic)
            this.context.fail(
                call,
                "Function.bind with arguments requires represented parameter lanes.",
            );
        if (
            type.restParameter !== undefined &&
            bound.length > type.restParameter
        )
            this.context.fail(
                call,
                "Function.bind cannot bind arguments into a rest parameter.",
            );
        const spread = bound.find(ts.isSpreadElement);
        if (spread)
            this.context.fail(
                spread,
                "Function.bind takes its bound arguments separately.",
            );
        if (bound.length > type.parameters.length)
            this.context.dataLowerer.noteArgumentsPastSignature(
                type,
                "passes",
                call,
            );
        const receiver =
            this.context.allocateTemporaryCppName("bound_receiver");
        this.context.emit({
            kind: "declaration",
            type: "const auto",
            name: receiver,
            initializer: receiverCpp,
        });
        const boundCpp: string[] = [];
        bound.forEach((argument, index) => {
            const parameter = type.parameters[index];
            if (!parameter) {
                this.context.emitDiscardedValue(this.compileValue(argument));
                return;
            }
            const name =
                this.context.allocateTemporaryCppName("bound_argument");
            this.context.emit({
                kind: "declaration",
                type: "const auto",
                name,
                initializer: this.context.dataLowerer.compileForSink(
                    argument,
                    parameter,
                ),
            });
            boundCpp.push(name);
        });
        const count = Math.min(bound.length, type.parameters.length);
        const optionalParameters = (type.optionalParameters ?? [])
            .filter((index) => index >= count)
            .map((index) => index - count);
        const { optionalParameters: _optional, restParameter, ...rest } = type;
        void _optional;
        const result: DataType<"function"> = {
            ...rest,
            parameters: type.parameters.slice(count),
            identity: true,
            ...(restParameter === undefined
                ? {}
                : { restParameter: restParameter - count }),
            ...(optionalParameters.length > 0 ? { optionalParameters } : {}),
        };
        this.context.reachJsData();
        return {
            kind: "data",
            dataType: result,
            freshData: true,
            cpp: `bbl::js::bind_callback_arguments<${this.context.dataTypes.cppType(result)}>(${[target, receiver, ...boundCpp].join(", ")})`,
        };
    }

    /**
     * `f.call(thisArg, ...args)` on a named function that declares or reads
     * its `this`: the function runs with `this` bound to thisArg, which is
     * read before the arguments, as each argument is read before the next.
     */
    private compileReceiverCall(
        call: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
    ): Value | undefined {
        const target = this.context.unwrap(callee.expression);
        if (
            !ts.isIdentifier(target) ||
            this.context.bindings.lookupOptional(target) !== undefined
        )
            return undefined;
        const declaration = tryResolveFunctionDeclaration(
            this.context.checker,
            target,
        );
        if (
            !declaration ||
            !(
                ts.isFunctionDeclaration(declaration) ||
                ts.isFunctionExpression(declaration)
            ) ||
            !(
                functionUsesDynamicThis(declaration) ||
                this.context.checker.getSignatureFromDeclaration(declaration)
                    ?.thisParameter
            ) ||
            call.arguments.length === 0 ||
            call.arguments.some(ts.isSpreadElement)
        )
            return undefined;
        const pins = this.context.evaluationOrder.operandsToPin(call.arguments);
        const values = call.arguments.map((argument, index) => {
            const value = this.compileValue(argument);
            return pins[index]
                ? pinOperand(this.context, value, argument, "call_argument")
                : value;
        });
        const previous = this.context.activeThis();
        this.context.defineThis(values[0]);
        try {
            return this.context.userFunctions.compileCallbackWithValues(
                this.context,
                target,
                values.slice(1),
                call,
            );
        } finally {
            this.context.defineThis(previous);
        }
    }

    /** Function call adapters consume the function object before their arguments run. */
    private compileFunctionObject(expression: ts.Expression): Value {
        if (
            this.context.checker
                .getTypeAtLocation(expression)
                .getCallSignatures()
                .some((signature) => signature.thisParameter)
        )
            this.context.fail(
                expression,
                "Function.call/bind does not rebind a dynamic this parameter.",
            );
        const value = this.compileValue(expression);
        if (value.kind !== "callback") return value;
        const declaration =
            value.callbackDeclaration &&
            ts.isIdentifier(value.callbackDeclaration)
                ? tryResolveFunctionDeclaration(
                      this.context.checker,
                      value.callbackDeclaration,
                  )
                : value.callbackDeclaration;
        if (declaration && functionUsesDynamicThis(declaration))
            this.context.fail(
                expression,
                "Function.call/bind requires a lexical receiver or a function without dynamic this.",
            );
        const mapped = this.context.dataLowerer.dataTypeAt(expression);
        if (mapped?.kind !== "function") return value;
        const type: DataType<"function"> = { ...mapped, identity: true };
        return this.context.dataLowerer.leafValue(
            this.context.dataLowerer.compileKnownValueForSink(
                value,
                type,
                expression,
            ),
            type,
        );
    }

    /**
     * A RegExp of a known pattern. A `u` pattern is rewritten over UTF-16
     * units (`unicodeUnitPattern`), its case folding included.
     */
    private compileRegExp(
        pattern: string,
        flags: string,
        node: ts.Node,
        site: "literals" | "constructors",
    ): Value {
        for (const flag of flags) {
            if (flag !== "g" && flag !== "i" && flag !== "u") {
                this.context.fail(
                    node,
                    `Reached RegExp ${site} support the g, i and u flags, not '${flag}'.`,
                );
            }
        }
        const unicode = flags.includes("u");
        const ignoreCase = flags.includes("i");
        const translated = unicode
            ? unicodeUnitPattern(pattern, ignoreCase)
            : { pattern };
        if ("refusal" in translated)
            return this.context.fail(node, translated.refusal);
        this.context.reachJsData();
        return {
            kind: "regexp",
            regexpCaptureCount: regexpCaptureCount(translated.pattern),
            ...(unicode ? { regexpUnicode: true as const } : {}),
            cpp:
                `bbl::js::RegExp(${this.context.cppString(translated.pattern)}, ` +
                `${flags.includes("g") ? "true" : "false"}, ` +
                `${ignoreCase && !unicode ? "true" : "false"}` +
                `${unicode ? ", true" : ""})`,
        };
    }

    private compilePropertyCall(
        callee: ts.PropertyAccessExpression,
        call: ts.CallExpression,
    ): Value | undefined {
        if (
            callee.name.text === "bind" &&
            this.context.checker
                .getTypeAtLocation(callee.expression)
                .getCallSignatures().length > 0
        ) {
            const collection = compileBoundCollectionMethod(
                this.context.dataLowerer,
                call,
                callee.expression,
            );
            if (collection) return collection;
            if (call.arguments.length === 0)
                this.context.expectArgumentCount(call, 1, 1);
            const callable = this.compileFunctionObject(callee.expression);
            if (
                callable.dataType?.kind === "function" &&
                callable.dataType.generic
            )
                this.context.fail(
                    call,
                    "Stored generic Function.bind requires a concrete signature.",
                );
            if (
                callable.kind !== "data" ||
                callable.dataType?.kind !== "function"
            )
                return this.context.fail(
                    callee,
                    "Function.bind requires represented native function storage.",
                );
            const target = this.context.allocateTemporaryCppName(
                "bound_function_target",
            );
            this.context.emit({
                kind: "declaration",
                type: "const auto",
                name: target,
                initializer: callable.cpp,
            });
            const receiver = this.compileValue(argumentAt(call, 0));
            const receiverType =
                receiver.dataType ??
                this.context.dataTypes.fromStoredTsType(
                    this.context.checker.getTypeAtLocation(argumentAt(call, 0)),
                    argumentAt(call, 0),
                );
            if (receiver.kind !== "json-null" && !receiverType)
                return this.context.fail(
                    call,
                    "Function.bind requires a represented native thisArg.",
                );
            const receiverCpp =
                receiver.kind === "json-null"
                    ? "std::monostate{}"
                    : this.context.dataLowerer.compileKnownValueForSink(
                          receiver,
                          receiverType!,
                          argumentAt(call, 0),
                      );
            if (call.arguments.length > 1)
                return this.compilePartialBind(
                    call,
                    target,
                    callable.dataType,
                    receiverCpp,
                );
            const type: DataType<"function"> = {
                ...callable.dataType,
                identity: true,
            };
            return {
                kind: "data",
                dataType: type,
                freshData: true,
                cpp: `bbl::js::bind_callback(${target}, ${receiverCpp})`,
            };
        }
        // `renderer._beforeUpdate.push(hook)`: sprite-renderer.ts keeps
        // its per-frame hooks in an ordinary array a caller pushes onto,
        // and `spriteRendererUpdate` runs them before it reads its
        // layers. It is a renderer-owned list rather than the scene's,
        // so the push is recognized here rather than through an
        // intrinsic name.
        if (
            callee.name.text === "push" &&
            ts.isPropertyAccessExpression(callee.expression) &&
            callee.expression.name.text === "_beforeUpdate"
        ) {
            const renderer = this.context.compileValue(
                callee.expression.expression,
            );
            if (renderer.kind !== "sprite-renderer") {
                this.context.fail(
                    callee.expression.expression,
                    "'_beforeUpdate' is the SpriteRenderer's own " +
                        `per-frame hook list; received ${renderer.kind}.`,
                );
            }
            this.context.expectArgumentCount(call, 1, 1);
            const engineCpp = this.context.requireEngine(renderer, call);
            return {
                kind: "void",
                cpp:
                    "bbl::sprite_renderer_before_update(" +
                    `${engineCpp}, ${renderer.cpp}, ` +
                    `${this.context.callbacks.compileFrameCallback(argumentAt(call, 0), "double-delta")})`,
                engineCpp,
            };
        }
        if (callee.name.text === "call") {
            const receiverCall = this.compileReceiverCall(call, callee);
            if (receiverCall) return receiverCall;
        }
        if (callee.name.text === "call" || callee.name.text === "apply") {
            const functionCall = this.context.probeEmission(() => {
                const objectCall = compileObjectPrototypeCall(
                    this.context,
                    call,
                );
                if (objectCall) return objectCall;
                const callable = this.context.checker
                    .getTypeAtLocation(callee.expression)
                    .getCallSignatures().length
                    ? this.compileFunctionObject(callee.expression)
                    : this.compileValue(callee.expression);
                if (
                    callable.kind === "data" &&
                    callable.dataType?.kind === "function"
                ) {
                    return this.context.dataLowerer.compileStoredCall(
                        call,
                        callable.cpp,
                        callable.dataType,
                        undefined,
                        callee.name.text === "apply" ? "apply" : 1,
                    );
                }
                return undefined;
            });
            if (functionCall) return functionCall;
        }
        const staticOwner = this.context.libraryGlobal(callee.expression);
        if (
            staticOwner === "Object" &&
            (callee.name.text === "keys" || callee.name.text === "values")
        ) {
            return this.compileObjectProjection(call, callee.name.text);
        }
        const objectStatic =
            staticOwner === "Object"
                ? OBJECT_STATIC_HANDLERS.get(callee.name.text)
                : undefined;
        if (objectStatic) {
            return objectStatic(this.context, call);
        }
        if (staticOwner === "Atomics")
            return compileAtomicsCall(this.context, call, callee.name.text);
        if (staticOwner === "String" && callee.name.text === "fromCharCode") {
            this.context.reachJsData();
            // Spread arguments pack, in order with the others, into one list.
            if (call.arguments.some(ts.isSpreadElement))
                return {
                    kind: "data",
                    cpp: `bbl::js::string_from_char_codes(${
                        this.context.dataLowerer.compileFunctionArguments(
                            call,
                            {
                                kind: "function",
                                restParameter: 0,
                                parameters: [
                                    {
                                        kind: "vector",
                                        element: { kind: "number" },
                                    },
                                ],
                            },
                            "String.fromCharCode",
                        )[0]!
                    })`,
                    dataType: { kind: "string" },
                };
            return {
                kind: "data",
                cpp:
                    call.arguments.length === 0
                        ? "std::string{}"
                        : call.arguments.length === 1
                          ? `bbl::js::string_from_char_code(${this.context.compileNumber(argumentAt(call, 0), "double")})`
                          : `bbl::js::string_from_char_codes({${call.arguments.map((argument) => this.context.compileNumber(argument, "double")).join(", ")}})`,
                dataType: { kind: "string" },
            };
        }
        if (staticOwner === "String" && callee.name.text === "fromCodePoint") {
            const spread = call.arguments.find(ts.isSpreadElement);
            if (spread)
                this.context.fail(
                    spread,
                    "String.fromCodePoint takes its code points as separate arguments.",
                );
            this.context.reachJsData();
            // A braced list evaluates its elements in order.
            return {
                kind: "data",
                cpp: `bbl::js::string_from_code_points({${call.arguments.map((argument) => this.context.compileNumber(argument, "double")).join(", ")}})`,
                dataType: { kind: "string" },
            };
        }
        if (
            callee.name.text === "toLocaleString" &&
            this.context.checker.getTypeAtLocation(callee.expression).flags &
                ts.TypeFlags.NumberLike
        ) {
            const owner = this.numberMethodReceiver(callee.expression);
            if (owner.kind !== "number")
                this.context.fail(
                    call,
                    "Number.toLocaleString requires a number receiver.",
                );
            return compileNumberLocaleString(
                this.context.dataLowerer,
                call,
                owner,
            );
        }
        if (callee.name.text === "toString") {
            const owner = this.numberMethodReceiver(callee.expression);
            if (owner.kind === "number") {
                this.context.expectArgumentCount(call, 0, 1);
                this.context.reachJsData();
                const radix = call.arguments[0];
                return {
                    kind: "data",
                    cpp: radix
                        ? `bbl::js::number_to_string_radix(${owner.cpp}, static_cast<int>(${this.context.compileNumber(radix, "double")}))`
                        : `bbl::js::number_to_string(${owner.cpp})`,
                    dataType: { kind: "string" },
                };
            }
        }
        if (PURE_NUMBER_FORMATTERS.has(callee.name.text)) {
            this.context.expectArgumentCount(call, 0, 1);
            const owner = this.numberMethodReceiver(callee.expression);
            const number =
                owner.staticNumber ??
                this.generationTimeNumber(callee.expression);
            const digits = call.arguments[0]
                ? staticNumberValue(this.context, call.arguments[0])
                : undefined;
            if (
                callee.name.text === "toFixed" &&
                owner.kind === "number" &&
                (number === undefined ||
                    (call.arguments.length > 0 && digits === undefined))
            ) {
                if (digits !== undefined && (digits < 0 || digits > 100)) {
                    this.context.fail(
                        call,
                        "Number.toFixed precision must be between 0 and 100.",
                    );
                }
                this.context.reachJsData();
                const receiver = call.arguments[0]
                    ? this.context.bindings.pinValueToTemporary(
                          owner,
                          "format_receiver",
                          callee.expression,
                      )
                    : owner;
                const precision = call.arguments[0]
                    ? this.context.compileNumber(call.arguments[0], "double")
                    : "0";
                return {
                    kind: "data",
                    cpp: `bbl::js::number_to_fixed(${receiver.cpp}, ${precision})`,
                    dataType: { kind: "string" },
                };
            }
            if (
                owner.kind !== "number" ||
                number === undefined ||
                (call.arguments.length > 0 &&
                    (digits === undefined || !Number.isInteger(digits)))
            ) {
                this.context.fail(
                    call,
                    `Number.${callee.name.text} in a generation-time string requires a static number and integer precision (received '${owner.cpp}').`,
                );
            }
            let text: string;
            if (callee.name.text === "toFixed") {
                if (digits !== undefined && (digits < 0 || digits > 100)) {
                    this.context.fail(
                        call,
                        "Number.toFixed precision must be between 0 and 100.",
                    );
                }
                text =
                    digits === undefined
                        ? number.toFixed()
                        : number.toFixed(digits);
            } else if (callee.name.text === "toPrecision") {
                if (digits !== undefined && (digits < 1 || digits > 100)) {
                    this.context.fail(
                        call,
                        "Number.toPrecision precision must be between 1 and 100.",
                    );
                }
                text =
                    digits === undefined
                        ? number.toPrecision()
                        : number.toPrecision(digits);
            } else {
                if (digits !== undefined && (digits < 0 || digits > 100)) {
                    this.context.fail(
                        call,
                        "Number.toExponential precision must be between 0 and 100.",
                    );
                }
                text =
                    digits === undefined
                        ? number.toExponential()
                        : number.toExponential(digits);
            }
            return {
                kind: "string",
                cpp: this.context.cppString(text),
                staticString: text,
            };
        }
        const staticContainerMethod = this.context.probeEmission(
            (): Value | undefined => {
                const staticOwner = this.compileStaticOwner(callee.expression);
                if (!staticOwner) return undefined;
                if (
                    staticOwner.kind === "tuple" &&
                    callee.name.text === "flat"
                ) {
                    this.context.expectArgumentCount(call, 0, 1);
                    const depth = call.arguments[0]
                        ? staticNumberValue(this.context, call.arguments[0])
                        : 1;
                    if (depth === undefined)
                        this.context.fail(
                            call,
                            "Array.flat requires a generation-known depth for tuple input.",
                        );
                    const remaining = Number.isNaN(depth)
                        ? 0
                        : Math.max(0, Math.trunc(depth));
                    const flatten = (
                        elements: readonly Value[],
                        level: number,
                    ): Value[] =>
                        elements.flatMap((element) => {
                            if (level > 0 && element.kind === "tuple")
                                return flatten(
                                    element.tupleElements ?? [],
                                    level - 1,
                                );
                            if (
                                level > 0 &&
                                element.dataType?.kind === "tuple"
                            ) {
                                const cpp = this.context.bindings.bindDataTuple(
                                    element,
                                    element.dataType.arity,
                                );
                                return Array.from(
                                    { length: element.dataType.arity },
                                    (_, index) =>
                                        this.context.dataLowerer.leafValue(
                                            `${cpp}[${index}]`,
                                            { kind: "number" },
                                        ),
                                );
                            }
                            if (
                                level > 0 &&
                                element.dataType?.kind === "vector"
                            ) {
                                this.context.fail(
                                    call,
                                    "Tuple Array.flat cannot flatten an array with runtime length.",
                                );
                            }
                            return [element];
                        });
                    return {
                        kind: "tuple",
                        cpp: "",
                        tupleElements: flatten(
                            staticOwner.tupleElements ?? [],
                            remaining,
                        ),
                    };
                }
                const fetched = this.context.compileStaticFetchMethod(
                    call,
                    staticOwner,
                    callee.name.text,
                );
                if (fetched) return fetched;
                const mapped = this.compileStaticTupleMap(
                    call,
                    staticOwner,
                    callee.name.text,
                );
                if (mapped) return mapped;
                return undefined;
            },
        );
        if (staticContainerMethod) return staticContainerMethod;
        const regexpExpression = this.context.unwrap(callee.expression);
        const regexpType =
            this.context.checker.getTypeAtLocation(regexpExpression);
        const boundRegexp = ts.isIdentifier(regexpExpression)
            ? this.context.bindings.lookupOptional(regexpExpression)
            : undefined;
        const regexpOwner =
            boundRegexp?.kind === "regexp"
                ? boundRegexp
                : regexpType.symbol?.name === "RegExp" ||
                    regexpExpression.kind ===
                        ts.SyntaxKind.RegularExpressionLiteral
                  ? this.compileValue(regexpExpression)
                  : undefined;
        if (regexpOwner?.kind === "regexp") {
            if (callee.name.text !== "exec" && callee.name.text !== "test") {
                this.context.fail(
                    callee.name,
                    `RegExp method '${callee.name.text}' is not supported.`,
                );
            }
            this.context.expectArgumentCount(call, 1, 1);
            const inputValue = this.compileValue(argumentAt(call, 0));
            const input = this.context.dataLowerer.compileKnownValueForSink(
                inputValue,
                { kind: "string" },
                argumentAt(call, 0),
            );
            this.context.reachJsData();
            if (callee.name.text === "test") {
                // A literal creates a fresh RegExp on each evaluation, so folding
                // it cannot lose a stored expression's lastIndex mutation.
                if (
                    ts.isRegularExpressionLiteral(regexpExpression) &&
                    inputValue.staticString !== undefined
                ) {
                    const { pattern, flags } =
                        regularExpressionParts(regexpExpression)!;
                    const matched = new RegExp(pattern, flags).test(
                        inputValue.staticString,
                    );
                    this.context.emitDiscardedValue(inputValue);
                    return booleanValue(String(matched));
                }
                return {
                    kind: "boolean",
                    cpp: `${regexpOwner.cpp}.test(${input})`,
                };
            }
            return {
                kind: "data",
                cpp: `${regexpOwner.cpp}.exec(${input})`,
                dataType: {
                    kind: "optional",
                    inner: {
                        kind: "vector",
                        element: { kind: "string" },
                    },
                },
            };
        }
        // The handle-collection concept owns the collection calls; the
        // three dispatch positions stay exactly where the arms sat so
        // the resolution order a call site observes is unchanged.
        const pushed =
            this.context.handleCollections.compileParticleSystemsPush(
                call,
                callee,
            );
        if (pushed) return pushed;
        const math = this.context.dataLowerer.compileMathCall(call);
        if (math) {
            return math;
        }
        const arrayFrom =
            this.context.dataLowerer.compileArrayFrom(call) ??
            this.context.dataLowerer.compileTypedArrayFactory(call);
        if (arrayFrom) {
            return arrayFrom;
        }
        // Resolve engine-handle searches before the plain-data method
        // probe compiles their owner. A fused `meshes.map(...).find(...)`
        // has no native intermediate array for that probe to lower.
        const found = this.context.handleCollections.compileFind(call, callee);
        if (found) {
            return found;
        }
        const physics = this.context.probeEmission(() =>
            compilePhysicsMethodCall(this.context, call, callee),
        );
        if (physics) return physics;
        const method = mayCompileDataMethodCall(this.context.checker, callee)
            ? this.context.probeEmission(() =>
                  this.context.dataLowerer.compileDataMethodCall(call),
              )
            : undefined;
        if (method) {
            return method;
        }
        // The Web Audio surface: `ctx.createGain()`,
        // `node.connect(...)`, `param.setValueAtTime(...)`. Babylon
        // Lite is function-shaped and the browser API is not, so the
        // audio family is the one place a handle carries methods.
        const audio = compileAudioMethodCall(this.context, call, callee);
        if (audio) {
            return audio;
        }
        // The second such surface: a VatHandle is a closure bundle
        // upstream, so its playback methods ride the handle too.
        const vat = compileVatMethodCall(this.context, call, callee);
        if (vat) {
            return vat;
        }
        const lightPush = this.context.handleCollections.compileSceneLightPush(
            call,
            callee,
        );
        if (lightPush) {
            return lightPush;
        }
        // After the data-model arm above, so a list of plain data still
        // grows through its own `push_back`; this one owns the case that
        // arm declines, a compile-time tuple of engine handles.
        const handlePush =
            this.context.handleCollections.compileHandleTuplePush(call, callee);
        if (handlePush) {
            return handlePush;
        }
        const staticMethod =
            this.context.classLowerer.resolveStaticMethod(callee);
        if (staticMethod) {
            const factory =
                this.context.classLowerer.compileNullableResourceFactory(
                    call,
                    staticMethod,
                );
            if (factory) return factory;
            return this.context.classLowerer.withStaticReceiver(callee, () =>
                this.context.userFunctions.compileCallbackCall(
                    this.context,
                    call,
                    staticMethod,
                ),
            );
        }
        // A method on a constructed instance inlines with `this`
        // bound to that instance's field record.
        const receiver = this.context.unwrap(callee.expression);
        if (
            ts.isIdentifier(receiver) ||
            receiver.kind === ts.SyntaxKind.ThisKeyword ||
            ts.isPropertyAccessExpression(receiver) ||
            ts.isElementAccessExpression(receiver) ||
            ts.isBinaryExpression(receiver) ||
            ts.isConditionalExpression(receiver) ||
            ts.isCallExpression(receiver) ||
            // `new C().method()`: the temporary instance is the receiver.
            ts.isNewExpression(receiver)
        ) {
            const receiverValue = ts.isIdentifier(receiver)
                ? (this.context.bindings.lookupOptional(receiver) ??
                  this.compileModuleNamespace(receiver))
                : receiver.kind === ts.SyntaxKind.ThisKeyword
                  ? this.context.activeThis()
                  : this.compileValue(receiver);
            const instance = receiverValue
                ? (this.context.classLowerer.hydrate(receiverValue, receiver) ??
                  receiverValue)
                : undefined;
            const callableProperty = instance
                ? readCallableProperty(
                      this.context,
                      instance,
                      callee.name.text,
                      callee,
                  )
                : undefined;
            if (callableProperty?.dataType?.kind === "function")
                return this.context.dataLowerer.compileStoredCall(
                    call,
                    callableProperty.cpp,
                    callableProperty.dataType,
                );
            const optionalCall =
                call.questionDotToken !== undefined ||
                callee.questionDotToken !== undefined;
            if (instance?.kind === "json-null" && optionalCall) {
                return { kind: "json-null", cpp: "std::nullopt" };
            }
            if (
                instance?.kind === "splat-mesh" &&
                callee.name.text === "updateData"
            ) {
                this.context.expectArgumentCount(call, 1, 1);
                if (presenceFlagCpp(instance)) {
                    this.context.fail(
                        call,
                        "updateData requires a present splat cloud.",
                    );
                }
                // Resolve the receiver before evaluating an argument
                // that may replace the source binding.
                const engine = this.context.requireEngine(instance, call);
                const cloud = this.context.allocateTemporaryCppName(
                    "splat_update_receiver",
                );
                this.context.emit({
                    kind: "declaration",
                    type: "const auto",
                    name: cloud,
                    initializer: instance.cpp,
                });
                const buffer = this.context.dataLowerer.compileForSink(
                    argumentAt(call, 0),
                    { kind: "arraybuffer" },
                );
                this.context.reachFeature("loader:splat-data", call);
                return {
                    kind: "void",
                    cpp: `bbl::update_splat_data(${engine}, ${cloud}, ${buffer})`,
                };
            }
            const declaration = instance
                ? this.context.classOf(instance)
                : undefined;
            // A record property naming a local function inlines at
            // the call site exactly as a direct call to that
            // function does, by handing the identifier the literal
            // wrote to the same resolver.
            const recordMethod = instance?.recordMethods?.[callee.name.text];
            const recordCallback =
                instance &&
                (this.context.moduleNamespaces.member(
                    instance,
                    callee.name.text,
                    callee,
                ) ??
                    instance.recordProperties?.[callee.name.text]);
            if (recordCallback?.intrinsicName) {
                const result = this.context.compileRegisteredIntrinsic(
                    recordCallback.intrinsicName,
                    call,
                );
                if (result) return result;
                this.context.fail(
                    call,
                    `Babylon Lite intrinsic '${recordCallback.intrinsicName}' is not supported by this prototype.`,
                );
            }
            if (
                instance &&
                call.questionDotToken &&
                !recordMethod &&
                !recordCallback
            ) {
                return { kind: "json-null", cpp: "std::nullopt" };
            }
            if (instance && recordMethod) {
                // A literal written in the record has no identifier
                // to resolve, so it takes the callback path a
                // function-literal argument already takes. Both
                // arrive at the same inliner.
                if (!ts.isIdentifier(recordMethod)) {
                    return this.context.userFunctions.compileCallbackCall(
                        this.context,
                        call,
                        recordMethod,
                        (work) =>
                            this.context.withRecordScopes(
                                instance,
                                work,
                                recordMethod,
                            ),
                    );
                }
                const method = this.context.userFunctions.compile(
                    this.context,
                    call,
                    recordMethod,
                    // Only the body runs in the record's
                    // scope; the arguments were written at
                    // the call site and resolve there.
                    (work) => this.context.withRecordScopes(instance, work),
                );
                if (method) {
                    return method;
                }
            }
            if (
                recordCallback?.kind === "callback" &&
                recordCallback.callbackDeclaration
            ) {
                const inRecordScope = <T>(work: () => T): T =>
                    recordCallback.callbackRecordOwner
                        ? this.context.withRecordScopes(
                              recordCallback.callbackRecordOwner,
                              work,
                          )
                        : work();
                return ts.isIdentifier(recordCallback.callbackDeclaration)
                    ? this.context.userFunctions.compile(
                          this.context,
                          call,
                          recordCallback.callbackDeclaration,
                          inRecordScope,
                      )!
                    : this.context.userFunctions.compileCallbackCall(
                          this.context,
                          call,
                          recordCallback.callbackDeclaration,
                          inRecordScope,
                      );
            }
            if (
                recordCallback?.kind === "data" &&
                recordCallback.dataType?.kind === "function"
            ) {
                const functionType = recordCallback.dataType;
                if (optionalCall) {
                    return this.context.dataLowerer.compileOptionalStoredCall(
                        call,
                        recordCallback.cpp,
                        functionType,
                        callee.questionDotToken ? instance?.cpp : undefined,
                    );
                }
                return this.context.dataLowerer.compileStoredCall(
                    call,
                    recordCallback.cpp,
                    functionType,
                );
            }
            if (instance && declaration) {
                const optionalFound =
                    presenceFlagCpp(instance) ??
                    (instance.dataType?.kind === "struct" &&
                    this.context.dataTypes.isReferenceStruct(
                        instance.dataType.name,
                    )
                        ? `static_cast<bool>(${instance.cpp})`
                        : undefined);
                if (optionalCall && optionalFound !== undefined) {
                    if (!ts.isExpressionStatement(call.parent))
                        return this.compileOptionalMethodValue(
                            call,
                            callee.name.text,
                            instance,
                            declaration,
                            optionalFound,
                        );
                    this.context.emit({
                        kind: "open",
                        code: `if (${optionalFound}) {`,
                    });
                    this.context.increaseIndent();
                    const result = this.context.classLowerer.compileMethodCall(
                        instance,
                        callee.name.text,
                        call,
                        declaration,
                    );
                    if (result.kind !== "void")
                        this.context.emitDiscardedValue(result);
                    else if (result.cpp) {
                        this.context.emit({
                            kind: "expression",
                            code: `${result.cpp};`,
                        });
                    }
                    this.context.decreaseIndent();
                    this.context.emit({ kind: "close", code: "}" });
                    return { kind: "void", cpp: "" };
                }
                return this.context.classLowerer.compileMethodCall(
                    instance,
                    callee.name.text,
                    call,
                    declaration,
                );
            }
        }
    }

    /**
     * `receiver?.method(...)` as a value: the method runs, its arguments
     * evaluated, only when the receiver is present, and the call is
     * `undefined` otherwise, so the result is the call's nullable type (a
     * `void` method's call is `undefined` either way).
     */
    private compileOptionalMethodValue(
        call: ts.CallExpression,
        method: string,
        instance: Value,
        declaration: ts.ClassLikeDeclaration,
        found: string,
    ): Value {
        const type = this.context.dataLowerer.dataTypeAt(call);
        const slot =
            type && !isUndefinedDataType(type)
                ? {
                      type,
                      cpp: this.context.allocateTemporaryCppName(
                          "optional_method_result",
                      ),
                  }
                : undefined;
        const lines = this.context.captureEmittedStatements(() =>
            this.inRuntimeControlFlow(() => {
                const result = this.context.classLowerer.compileMethodCall(
                    instance,
                    method,
                    call,
                    declaration,
                );
                if (!slot) {
                    this.context.emitDiscardedValue(result);
                    return;
                }
                if (result.kind === "void")
                    this.context.fail(
                        call,
                        "An optional method call's value requires the method's represented result.",
                    );
                this.context.emit({
                    kind: "expression",
                    code: `${slot.cpp} = ${this.context.dataLowerer.compileKnownValueForSink(result, slot.type, call)};`,
                });
            }),
        );
        if (slot)
            this.context.emit({
                kind: "declaration",
                type: this.context.dataTypes.cppType(slot.type),
                name: slot.cpp,
                initializer: this.context.dataTypes.absentValue(slot.type),
            });
        const binding = slot
            ? this.context.registerNativeBinding(slot.cpp)
            : undefined;
        this.context.emit({ kind: "open", code: `if (${found}) {` });
        this.context.increaseIndent();
        this.context.emitCapturedStatements(lines);
        this.context.decreaseIndent();
        this.context.emit({ kind: "close", code: "}" });
        return slot && binding
            ? {
                  ...this.context.dataLowerer.leafValue(slot.cpp, slot.type),
                  nativeBinding: true,
                  nativeCaptures: [binding],
              }
            : { kind: "json-null", cpp: "std::nullopt" };
    }
}
