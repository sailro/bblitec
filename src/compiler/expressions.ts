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

import { doubleLiteral } from "../cpp-literals.js";
import {
    compileAudioDecodeAssetCall,
    compileAudioMethodCall,
    isSupportedAudioMethodProperty,
} from "./audio-surface.js";
import { compileVatMethodCall } from "./intrinsics/vat.js";
import { isParseFloatCallee } from "./browser-erasure.js";
import type { ClassLowerer } from "./classes.js";
import {
    compileCompressedJsonCall,
    compileCompressedJsonPromiseThen,
} from "./compressed-json.js";
import type { DataLowerer } from "./data-lowering.js";
import { dataTypesEqual, type DataType } from "./data-types.js";
import type { NativeFunctionLowerer } from "./native-functions.js";
import {
    compileImmediatePromise,
    type PromiseLoweringContext,
} from "./promises.js";
import { staticNumberValue } from "./option-helpers.js";
import type { StaticEvaluator } from "./static-evaluator.js";
import type { CompilerSymbols } from "./symbols.js";
import type {
    CompiledNodeParticles,
    Feature,
    FrameCallbackSignature,
    Value,
    ValueKind,
    VariableBinding,
} from "./types.js";
import type {
    HandleCollections,
    HandleCollectionTarget,
} from "./handle-collections.js";
import type {
    UserFunctionContext,
    UserFunctionLowerer,
} from "./user-functions.js";

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
export const PURE_NUMBER_FORMATTERS = new Set([
    "toFixed",
    "toPrecision",
    "toExponential",
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
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        return true;
    }
    return ts.forEachChild(node, containsEvaluatedCall) ?? false;
}

function hasNonNullAssertion(expression: ts.Expression): boolean {
    let current = expression;
    while (
        ts.isAwaitExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current)
    ) {
        if (ts.isNonNullExpression(current)) {
            return true;
        }
        current = current.expression;
    }
    return false;
}

export interface ExpressionContext
    extends PromiseLoweringContext,
        UserFunctionContext {
    readonly checker: ts.TypeChecker;
    readonly evaluator: StaticEvaluator;
    /** The scene's node-particle program; a systems.push lands on it. */
    readonly reachedNodeParticles: CompiledNodeParticles;
    readonly dataLowerer: DataLowerer;
    readonly classLowerer: ClassLowerer;
    readonly userFunctions: UserFunctionLowerer;
    readonly nativeFunctions: NativeFunctionLowerer;
    readonly symbols: CompilerSymbols;
    readonly variableScopes: ReadonlyArray<
        Map<ts.Symbol, VariableBinding>
    >;
    unwrap(expression: ts.Expression): ts.Expression;
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    expectKind(value: Value, kind: ValueKind, node: ts.Node): void;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    activeThis(): Value | undefined;
    lookup(identifier: ts.Identifier): Value;
    lookupOptional(
        identifier: ts.Identifier,
    ): Value | undefined;
    resolveThisField(name: string): Value | undefined;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    canvasSizeValue(
        expression: ts.Expression,
    ): Value | undefined;
    compilePropertyAccess(
        expression: ts.PropertyAccessExpression,
    ): Value;
    registerClassInstance(
        instance: Value,
        declaration: ts.ClassDeclaration,
    ): void;
    classOf(
        instance: Value,
    ): ts.ClassDeclaration | undefined;
    withRecordScopes<T>(owner: Value, work: () => T): T;
    probeEmission<T>(
        probe: () => T,
        answered?: (result: T) => boolean,
    ): T;
    staticRecordAccessor(
        mapType: string,
        entries: readonly string[],
    ): string;
    requireEngine(value: Value, node: ts.Node): string;
    compileCondition(expression: ts.Expression): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileBoolean(expression: ts.Expression): string;
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
    registerAsset(
        source: string,
        kind: import("./types.js").CompileAsset["kind"],
    ): import("./types.js").CompileAsset;
    moduleRelativeAssetUrl(
        expression: ts.Expression,
    ): string | undefined;
    compileDynamicModuleRelativeAssetUrl(
        expression: ts.Expression,
    ): Value | undefined;
    materializeStaticNativeValue(
        identifier: ts.Identifier,
        value: Value,
    ): Value;
    isNumberExpression(
        expression: ts.Expression,
    ): boolean;
    propertyName(
        name: ts.PropertyName,
    ): string | undefined;
    namesLocalFunction(
        identifier: ts.Identifier,
    ): boolean;
    cppString(value: string): string;
    isBrowserOnlyExpression(
        expression: ts.Expression,
    ): boolean;
    isBrowserOnlyHandler(handler: ts.Expression): boolean;
    isDefaultLibraryIdentifier(identifier: ts.Identifier): boolean;
    isDeferredCallbackCall(call: ts.CallExpression): boolean;
    compileFrameCallback(
        expression: ts.Expression,
        signature?: FrameCallbackSignature,
    ): string;
    requireDefaultEngine(node: ts.Node): string;
    evaluateBrowserValue(
        expression: ts.Expression,
    ): Value["browserValue"] | undefined;
    /** The handle-collection concept: every collection operation. */
    readonly handleCollections: HandleCollections;
    handleCollectionIterationTarget(
        expression: ts.Expression,
    ): HandleCollectionTarget | undefined;
    assetRootElementAccess(
        expression: ts.ElementAccessExpression,
    ): Value | undefined;
    compileRegisteredConstant(importedName: string): Value | undefined;
    compileRegisteredIntrinsic(
        importedName: string,
        call: ts.CallExpression,
    ): Value | undefined;
    compileThinInstanceUploadHelper(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined;
    compilePixelsTextureUpload(
        call: ts.CallExpression,
    ): Value | undefined;
    compileStaticFetch(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined;
    compileVoxelFileCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined;
    compileStaticFetchMethod(
        call: ts.CallExpression,
        owner: Value,
        method: string,
    ): Value | undefined;
    compilePlatformCall(call: ts.CallExpression): Value | undefined;
    compileAnimationFrameCall(call: ts.CallExpression): Value | undefined;
    compileBrowserGeneratedString(
        call: ts.CallExpression,
    ): Value | undefined;
    reachFeature(feature: Feature, site?: ts.Node): void;
    reachJsData(): void;
    enterRuntimeControlFlow(): void;
    leaveRuntimeControlFlow(): void;
}

export class ExpressionLowerer {
    public constructor(
        private readonly context: ExpressionContext,
    ) {}

    private inRuntimeControlFlow<T>(compile: () => T): T {
        this.context.enterRuntimeControlFlow();
        try {
            return compile();
        } finally {
            this.context.leaveRuntimeControlFlow();
        }
    }

    public compileValue(expression: ts.Expression): Value {
        if (
            (ts.isAsExpression(expression) ||
                ts.isTypeAssertionExpression(expression)) &&
            ts.isTypeReferenceNode(expression.type) &&
            ts.isIdentifier(expression.type.typeName) &&
            this.context.symbols.importedName(
                expression.type.typeName,
            ) === "Mesh"
        ) {
            const asserted = this.compileValue(expression.expression);
            if (asserted.kind === "picked-node") {
                return {
                    kind: "mesh",
                    cpp: `bbl::picked_mesh(${asserted.cpp})`,
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
            const sourceType =
                this.context.dataLowerer.dataTypeAt(
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
                    this.compileValue(expression.expression),
                    expression,
                );
            }
        }
        const assertedNonNull =
            hasNonNullAssertion(expression);
        const unwrapped = this.context.unwrap(expression);

        if (unwrapped.kind === ts.SyntaxKind.NullKeyword) {
            return { kind: "json-null", cpp: "" };
        }

        if (
            ts.isArrowFunction(unwrapped) ||
            ts.isFunctionExpression(unwrapped)
        ) {
            return {
                kind: "callback",
                cpp: "",
                callbackDeclaration: unwrapped,
                callbackRecordOwner: {
                    kind: "record",
                    cpp: "",
                    recordScopes: [
                        ...this.context.variableScopes,
                    ],
                },
            };
        }

        if (ts.isBinaryExpression(unwrapped)) {
            const assignment =
                this.context.dataLowerer.compileAssignmentValue(
                    unwrapped,
                );
            if (assignment) return assignment;
        }

        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken
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
            const folded =
                this.context.evaluator.tryResolveNullish(unwrapped);
            if (folded) {
                return this.compileValue(folded);
            }
            // The general operator over the data model: an optional
            // selects natively with the right side lazy, and a left the
            // model proves non-nullish is the result.
            const general =
                this.context.dataLowerer.compileNullishCoalesce(
                    unwrapped,
                );
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
        if (
            unwrapped.kind === ts.SyntaxKind.ThisKeyword
        ) {
            const instance = this.context.activeThis();
            if (!instance) {
                this.context.fail(
                    unwrapped,
                    "'this' is only reached inside a class constructor or method.",
                );
            }
            return instance;
        }
        if (ts.isIdentifier(unwrapped)) {
            const value = this.context.lookupOptional(unwrapped);
            if (value) {
                const narrowed =
                    value.kind === "data"
                        ? this.context.dataLowerer.narrowOptional(
                              value,
                              unwrapped,
                          )
                        : value;
                return this.materializeBrowserPrimitive(
                    unwrapped,
                    narrowed,
                );
            }
            if (
                unwrapped.text === "devicePixelRatio" &&
                this.context.isDefaultLibraryIdentifier(unwrapped)
            ) {
                return {
                    kind: "number",
                    cpp: "1.0",
                    staticNumber: 1,
                    dataType: { kind: "number" },
                };
            }
            if (unwrapped.text === "undefined") {
                return { kind: "json-null", cpp: "std::nullopt" };
            }
            if (
                unwrapped.text === "Infinity" ||
                unwrapped.text === "NaN"
            ) {
                return {
                    kind: "number",
                    cpp: this.context.compileNumber(
                        unwrapped,
                        "double",
                    ),
                };
            }
            const resolved =
                this.context.resolveStaticExpression(unwrapped);
            if (resolved !== unwrapped) {
                const value = this.compileValue(resolved);
                return value.kind === "regexp"
                    ? this.context.materializeStaticNativeValue(
                          unwrapped,
                          value,
                      )
                    : value;
            }
            // A pinned constant a scene imports by name -- pure data the
            // intrinsic families own, not a local.
            const importedName =
                this.context.symbols.importedName(unwrapped);
            const constant = importedName
                ? this.context.compileRegisteredConstant(importedName)
                : undefined;
            if (constant) {
                return constant;
            }
            return this.context.lookup(unwrapped);
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            if (
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "Math" &&
                (unwrapped.name.text === "PI" ||
                    unwrapped.name.text === "SQRT1_2")
            ) {
                const staticNumber = staticNumberValue(
                    this.context,
                    unwrapped,
                );
                return {
                    kind: "number",
                    cpp: this.context.compileNumber(unwrapped, "double"),
                    ...(staticNumber === undefined
                        ? {}
                        : { staticNumber }),
                    dataType: { kind: "number" },
                };
            }
            const canvasSize =
                this.context.canvasSizeValue(unwrapped);
            if (canvasSize) {
                return canvasSize;
            }
            const data = this.context.dataLowerer.compileDataPath(
                unwrapped,
                "read",
            );
            if (data) {
                return data;
            }
            return this.context.compilePropertyAccess(unwrapped);
        }
        if (ts.isNewExpression(unwrapped)) {
            if (
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "RegExp" &&
                !this.context.lookupOptional(unwrapped.expression)
            ) {
                const arguments_ = unwrapped.arguments ?? [];
                if (arguments_.length < 1 || arguments_.length > 2) {
                    this.context.fail(
                        unwrapped,
                        "RegExp expects a pattern and optional flags.",
                    );
                }
                const pattern =
                    this.context.dataLowerer.compileForSink(
                        arguments_[0]!,
                        { kind: "string" },
                    );
                const flags = arguments_[1]
                    ? this.compileValue(arguments_[1]!).staticString
                    : "";
                if (flags === undefined) {
                    this.context.fail(
                        arguments_[1]!,
                        "Reached RegExp constructor flags must be static.",
                    );
                }
                for (const flag of flags) {
                    if (flag !== "g" && flag !== "i") {
                        this.context.fail(
                            arguments_[1] ?? unwrapped,
                            `Reached RegExp constructors support the g and i flags, not '${flag}'.`,
                        );
                    }
                }
                this.context.reachJsData();
                return {
                    kind: "regexp",
                    cpp:
                        `bbl::js::RegExp(${pattern}, ` +
                        `${flags.includes("g") ? "true" : "false"}, ` +
                        `${flags.includes("i") ? "true" : "false"})`,
                };
            }
            const constructed =
                this.context.dataLowerer.compileNewExpression(
                    unwrapped,
                );
            if (constructed) {
                return constructed;
            }
            const classDeclaration =
                this.context.classLowerer.resolveClass(unwrapped);
            if (classDeclaration) {
                const instance =
                    this.context.classLowerer.construct(
                        unwrapped,
                        classDeclaration,
                    );
                this.context.registerClassInstance(
                    instance,
                    classDeclaration,
                );
                return instance;
            }
            this.context.fail(
                unwrapped,
                "Unsupported constructor expression.",
            );
        }
        if (ts.isElementAccessExpression(unwrapped)) {
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
            if (!assertedNonNull) {
                // Determining whether an unchecked element read can carry an
                // existence predicate resolves its owner. A call-shaped owner
                // emits while it resolves, so a declined probe must discard
                // those lines before the ordinary element path compiles the
                // owner for real. Otherwise `makeRow().values[i]` evaluates
                // `makeRow()` twice even though JavaScript evaluates it once.
                const guardable = this.context.probeEmission(() =>
                    this.context.dataLowerer.compileGuardableElementAccess(
                        unwrapped,
                    ),
                );
                if (guardable) return guardable;
            }
            const ownerExpression = this.context.unwrap(
                unwrapped.expression,
            );
            if (ts.isConditionalExpression(ownerExpression)) {
                const condition = this.context.compileCondition(
                    ownerExpression.condition,
                );
                const selectedOwner =
                    condition === "true"
                        ? ownerExpression.whenTrue
                        : condition === "false"
                          ? ownerExpression.whenFalse
                          : undefined;
                const indexed = (owner: ts.Expression): Value =>
                    this.context.dataLowerer
                        .compileMaterializedElementAccess(
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
                    condition,
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
                this.context.assetRootElementAccess(unwrapped);
            if (assetRoot) {
                return assetRoot;
            }
            const collectionElement =
                this.context.handleCollections.collectionElementAccess(
                    unwrapped,
                );
            if (collectionElement) {
                return collectionElement;
            }
            const owner = this.compileValue(
                unwrapped.expression,
            );
            const dataElement =
                this.context.dataLowerer.compileElementFromValue(
                    owner,
                    unwrapped.argumentExpression,
                );
            if (dataElement) return dataElement;
            if (owner.kind === "camera-world-matrix") {
                const index = this.compileValue(
                    unwrapped.argumentExpression,
                );
                if (
                    index.kind !== "number" ||
                    index.staticNumber === undefined ||
                    ![12, 13, 14].includes(
                        index.staticNumber,
                    )
                ) {
                    this.context.fail(
                        unwrapped.argumentExpression,
                        "Reached camera world-matrix access supports translation indices 12-14.",
                    );
                }
                // The pinned `getCameraPosition` reads these three back out
                // of the camera's float32 world matrix, so the rounded
                // stored value is what a scene observes -- not the double
                // the eye was composed at.
                const element = index.staticNumber as
                    | 12
                    | 13
                    | 14;
                return {
                    kind: "number",
                    cpp: `bbl::upstream::camera_world_matrix(${this.context.requireEngine(owner, unwrapped)}.cameras[${owner.cpp}.value])[${element}]`,
                    ...(owner.engineCpp
                        ? { engineCpp: owner.engineCpp }
                        : {}),
                };
            }
            if (owner.kind === "node-particle-set") {
                const slot = this.compileValue(
                    unwrapped.argumentExpression,
                );
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
                              nodeParticleSetIndex:
                                  owner.nodeParticleSetIndex,
                          }
                        : {}),
                    nodeParticleSystemIndex: slot.staticNumber,
                    ...(owner.engineCpp
                        ? { engineCpp: owner.engineCpp }
                        : {}),
                };
            }
            if (owner.kind === "record") {
                const key = this.compileValue(
                    unwrapped.argumentExpression,
                );
                const property =
                    key.kind === "string"
                        ? key.staticString
                        : key.kind === "number" &&
                            key.staticNumber !== undefined
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
                        key.kind === "data" &&
                        key.dataType?.kind === "enum";
                    if (
                        key.kind !== "number" &&
                        !dynamicString &&
                        !dynamicEnum
                    ) {
                        this.context.fail(
                            unwrapped.argumentExpression,
                            "Dynamic compile-time record access requires a string or numeric key.",
                        );
                    }
                    const indexedType =
                        this.context.dataLowerer.dataTypeAt(
                            unwrapped,
                        );
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
                    const ownerDataType =
                        this.context.dataLowerer.dataTypeAt(
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
                    const keyType = this.context.checker.getTypeAtLocation(
                        unwrapped.argumentExpression,
                    );
                    const closedEnumKey =
                        dynamicEnum ||
                        (keyType.flags & ts.TypeFlags.EnumLike) !== 0 ||
                        (keyType.symbol?.flags ?? 0) & ts.SymbolFlags.Enum;
                    const ownerHasOptionalProperties =
                        this.context.checker
                            .getTypeAtLocation(unwrapped.expression)
                            .getProperties()
                            .some(
                                (member) =>
                                    (member.flags & ts.SymbolFlags.Optional) !==
                                    0,
                            );
                    const totalClosedKey =
                        closedEnumKey &&
                        indexedType.kind !== "optional" &&
                        !ownerHasOptionalProperties;
                    const resultType = totalClosedKey
                        ? valueType
                        : valueType.kind === "optional"
                          ? valueType
                          : indexedType.kind === "optional"
                            ? indexedType
                            : ({
                                  kind: "optional",
                                  inner: indexedType,
                              } as const);
                    const valueCpp =
                        this.context.dataTypes.cppType(
                            valueType,
                        );
                    const entries = Object.entries(
                        owner.recordProperties ?? {},
                    ).map(([name, value]) => {
                        if (dynamicEnum) {
                            return `{${this.context.dataTypes.enumMemberCpp(key.dataType as Extract<DataType, { kind: "enum" }>, name, unwrapped)}, ${this.context.dataLowerer.compileKnownValueForSink(value, valueType, unwrapped)}}`;
                        }
                        if (dynamicString) {
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
                    this.context.reachJsData();
                    const keyCpp = dynamicString
                        ? "std::string"
                        : dynamicEnum
                          ? this.context.dataTypes.cppType(key.dataType!)
                          : "double";
                    const mapType =
                        `bbl::js::Map<${keyCpp}, ${valueCpp}>`;
                    const table = this.context.staticRecordAccessor(
                        mapType,
                        entries,
                    );
                    const lookup =
                        `bblscene::${table}().${totalClosedKey ? "at" : "get"}(${key.cpp})`;
                    if (
                        valueType.kind === "struct" &&
                        this.context.dataTypes.isReferenceStruct(
                            valueType.name,
                        )
                    ) {
                        // A shared pointer already carries JavaScript's
                        // object-or-undefined state. Wrapping it in the
                        // optional data type would later spell `.has_value()`
                        // on a pointer, while narrowing it eagerly would lose
                        // the missing-key guard.
                        return this.context.dataLowerer.leafValue(
                            lookup,
                            valueType,
                        );
                    }
                    return {
                        kind: "data",
                        cpp: lookup,
                        dataType: resultType,
                        ...(resultType.kind === "optional"
                            ? { preserveUncheckedLookup: true as const }
                            : {}),
                    };
                }
                const value =
                    owner.recordProperties?.[property];
                if (!value) {
                    this.context.fail(
                        unwrapped.argumentExpression,
                        `Compile-time record has no property '${property}'.`,
                    );
                }
                return value;
            }
            if (owner.kind !== "tuple") {
                this.context.fail(
                    unwrapped.expression,
                    `Element access is not supported for ${owner.kind}.`,
                );
            }
            const index = this.compileValue(
                unwrapped.argumentExpression,
            );
            const staticIndex =
                index.kind === "number"
                    ? (index.staticNumber ??
                      staticNumberValue(
                          this.context,
                          unwrapped.argumentExpression,
                      ))
                    : undefined;
            if (
                index.kind !== "number"
            ) {
                this.context.fail(
                    unwrapped.argumentExpression,
                    "Static tuple access requires a numeric index.",
                );
            }
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
                        `(${index.cpp}) == ${lane}`,
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
            const value =
                owner.tupleElements?.[staticIndex];
            if (!value) {
                this.context.fail(
                    unwrapped,
                    `Tuple index ${staticIndex} is out of range.`,
                );
            }
            return value;
        }
        if (ts.isCallExpression(unwrapped)) {
            // A pure module-URL helper remains a compile-time string even
            // though its implementation uses browser URL objects. Recognize
            // it before the general browser-erasure gate so the value can
            // travel through ordinary inlined parameters into an asset sink.
            const moduleAsset =
                this.context.moduleRelativeAssetUrl(unwrapped);
            if (moduleAsset !== undefined) {
                return {
                    kind: "string",
                    cpp: this.context.cppString(moduleAsset),
                    staticString: moduleAsset,
                };
            }
            if (
                this.context.isBrowserOnlyExpression(unwrapped)
            ) {
                return this.compileBrowserValue(unwrapped);
            }
        }
        if (ts.isCallExpression(unwrapped)) {
            return this.compileCall(unwrapped);
        }
        if (ts.isConditionalExpression(unwrapped)) {
            // Optional/vector/struct conditionals normally ask their native
            // sink to lower both branches. Before doing that, retain the
            // ordinary value path's stronger answer when a side-effect-free
            // condition is generation-known. This is especially important
            // for a static record's optional field: the selected value is a
            // string, not native optional storage merely because the checker
            // still exposes the unselected `undefined` branch.
            const foldedCondition = !containsEvaluatedCall(
                unwrapped.condition,
            )
                ? this.context.probeEmission(
                      () =>
                          this.context.compileCondition(
                              unwrapped.condition,
                          ),
                      (condition) =>
                          condition === "true" ||
                          condition === "false",
                  )
                : undefined;
            if (
                foldedCondition === "true" ||
                foldedCondition === "false"
            ) {
                const taken =
                    foldedCondition === "true"
                        ? unwrapped.whenTrue
                        : unwrapped.whenFalse;
                const dropped =
                    foldedCondition === "true"
                        ? unwrapped.whenFalse
                        : unwrapped.whenTrue;
                const selected = this.compileValue(taken);
                // When the arm generation just discarded was the NULL one,
                // the binding it feeds can no longer be absent -- and the
                // scene's own guard over it is therefore settled. Say so on
                // the value, the way a find the materialized asset resolved
                // at generation carries the constant "true": the guard then
                // folds through the ordinary optional path instead of
                // needing a per-kind truthiness rule. Scene 140 writes
                // `const sg = noShadows ? null : createPcf(...)` and then
                // `if (sg)`, with `noShadows` folded from its query.
                const droppedNode = this.context.unwrap(dropped);
                const droppedIsNullish =
                    droppedNode.kind === ts.SyntaxKind.NullKeyword ||
                    (ts.isIdentifier(droppedNode) &&
                        droppedNode.text === "undefined");
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
                    selected.optionalFoundCpp === undefined &&
                    selected.truthinessCpp === undefined
                ) {
                    return { ...selected, optionalFoundCpp: "true" };
                }
                return selected;
            }
            const conditionalType =
                this.context.dataLowerer.dataTypeAt(
                    unwrapped,
                );
            if (conditionalType?.kind === "optional") {
                const objectIdentity =
                    conditionalType.inner.kind === "struct"
                        ? this.inRuntimeControlFlow(() =>
                              this.context.dataLowerer.objectIdentity(
                                  unwrapped,
                              ),
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
            if (
                conditionalType?.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(
                    conditionalType.name,
                )
            ) {
                return this.context.dataValue(
                    this.inRuntimeControlFlow(() =>
                        this.context.dataLowerer.compileForSink(
                            unwrapped,
                            conditionalType,
                        ),
                    ),
                    conditionalType,
                );
            }
            if (conditionalType?.kind === "vector") {
                // Array literals are represented as compile-time tuples until
                // a native sink asks for storage. A runtime conditional is
                // such a sink, and unlike a tuple select its two arrays may
                // legally have different lengths.
                return this.context.dataValue(
                    this.inRuntimeControlFlow(() =>
                        this.context.dataLowerer.compileForSink(
                            unwrapped,
                            conditionalType,
                        ),
                    ),
                    conditionalType,
                );
            }
            const condition = this.context.compileCondition(
                unwrapped.condition,
            );
            if (condition === "true" || condition === "false") {
                return this.compileValue(
                    condition === "true"
                        ? unwrapped.whenTrue
                        : unwrapped.whenFalse,
                );
            }
            const whenTrue = this.inRuntimeControlFlow(() =>
                this.compileValue(
                    unwrapped.whenTrue,
                ),
            );
            const whenFalse = this.inRuntimeControlFlow(() =>
                this.compileValue(
                    unwrapped.whenFalse,
                ),
            );
            // A tuple value is a compile-time list of element values with
            // no native expression of its own, so selecting between two
            // tuples is selecting element by element. Same arity is the
            // condition for that to be the same thing.
            if (
                whenTrue.kind === "tuple" &&
                whenFalse.kind === "tuple"
            ) {
                const trueElements =
                    whenTrue.tupleElements ?? [];
                const falseElements =
                    whenFalse.tupleElements ?? [];
                if (
                    trueElements.length !==
                    falseElements.length
                ) {
                    this.context.fail(
                        unwrapped,
                        "Conditional tuple branches must have the same length.",
                    );
                }
                return {
                    kind: "tuple",
                    cpp: "",
                    tupleElements: trueElements.map(
                        (element, index) =>
                            this.selectValue(
                                condition,
                                element,
                                falseElements[index]!,
                                unwrapped,
                            ),
                    ),
                };
            }
            return this.selectValue(
                condition,
                whenTrue,
                whenFalse,
                unwrapped,
            );
        }
        if (ts.isArrayLiteralExpression(unwrapped)) {
            if (
                unwrapped.elements.some(
                    ts.isSpreadElement,
                )
            ) {
                const dataType =
                    this.context.dataLowerer.dataTypeAt(
                        unwrapped,
                    );
                if (dataType?.kind !== "vector") {
                    const elements: Value[] = [];
                    let staticTuple = true;
                    for (const element of unwrapped.elements) {
                        if (ts.isSpreadElement(element)) {
                            const spread = this.compileValue(
                                element.expression,
                            );
                            if (spread.kind !== "tuple") {
                                staticTuple = false;
                                break;
                            }
                            elements.push(
                                ...(spread.tupleElements ?? []),
                            );
                        } else {
                            elements.push(this.laneValue(element));
                        }
                    }
                    if (staticTuple) {
                        return {
                            kind: "tuple",
                            cpp: "",
                            tupleElements: elements,
                        };
                    }
                    this.context.fail(
                        unwrapped,
                        "Array spread requires a concrete native array element type.",
                    );
                }
                return {
                    kind: "data",
                    cpp: this.context.dataLowerer.compileForSink(
                        unwrapped,
                        dataType,
                    ),
                    dataType,
                };
            }
            return {
                kind: "tuple",
                cpp: "",
                tupleElements: unwrapped.elements.map(
                    (element) => this.laneValue(element),
                ),
            };
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            const properties: Record<string, Value> = {};
            const methods: Record<
                string,
                | ts.Identifier
                | ts.ArrowFunction
                | ts.FunctionExpression
                | ts.MethodDeclaration
            > = {};
            const getters: Record<
                string,
                ts.GetAccessorDeclaration
            > = {};
            for (const property of unwrapped.properties) {
                if (ts.isSpreadAssignment(property)) {
                    const spread = this.compileValue(
                        property.expression,
                    );
                    if (
                        spread.kind !== "record" &&
                        spread.recordProperties === undefined
                    ) {
                        this.context.fail(
                            property,
                            "Compile-time object spread requires a plain record value or a data record with a complete static property snapshot.",
                        );
                    }
                    Object.assign(
                        properties,
                        spread.recordProperties ?? {},
                    );
                    Object.assign(
                        methods,
                        spread.recordMethods ?? {},
                    );
                    Object.assign(
                        getters,
                        spread.recordGetters ?? {},
                    );
                    continue;
                }
                if (
                    ts.isGetAccessorDeclaration(property)
                ) {
                    const name = this.context.propertyName(
                        property.name,
                    );
                    if (!name) {
                        this.context.fail(
                            property.name,
                            "Static record properties require literal names.",
                        );
                    }
                    getters[name] = property;
                    continue;
                }
                if (ts.isMethodDeclaration(property)) {
                    const name = this.context.propertyName(
                        property.name,
                    );
                    if (!name) {
                        this.context.fail(
                            property.name,
                            "Static record methods require literal names.",
                        );
                    }
                    methods[name] = property;
                    continue;
                }
                if (ts.isPropertyAssignment(property)) {
                    const name = this.context.propertyName(
                        property.name,
                    );
                    if (!name) {
                        this.context.fail(
                            property.name,
                            "Static record properties require literal names.",
                        );
                    }
                    const initializer = this.context.unwrap(
                        property.initializer,
                    );
                    if (
                        ts.isIdentifier(initializer) &&
                        this.context.namesLocalFunction(initializer)
                    ) {
                        methods[name] = initializer;
                        continue;
                    }
                    if (
                        ts.isArrowFunction(initializer) ||
                        ts.isFunctionExpression(initializer)
                    ) {
                        methods[name] = initializer;
                        continue;
                    }
                    properties[name] = this.laneValue(
                        property.initializer,
                    );
                } else if (
                    ts.isShorthandPropertyAssignment(
                        property,
                    )
                ) {
                    if (
                        this.context.namesLocalFunction(
                            property.name,
                        )
                    ) {
                        methods[property.name.text] =
                            property.name;
                        continue;
                    }
                    properties[property.name.text] =
                        this.laneValue(property.name);
                } else {
                    this.context.fail(
                        property,
                        "Static records support property assignments, methods, getters, and properties naming a local function.",
                    );
                }
            }
            const closes =
                Object.keys(methods).length > 0 ||
                Object.keys(getters).length > 0;
            return {
                kind: "record",
                cpp: "",
                recordProperties: properties,
                recordMethods: methods,
                recordGetters: getters,
                // Only a record with code in it needs its scope: a
                // plain property already holds a resolved value.
                ...(closes
                    ? {
                          recordScopes: [
                              ...this.context.variableScopes,
                          ],
                      }
                    : {}),
            };
        }
        if (ts.isPostfixUnaryExpression(unwrapped)) {
            const value =
                this.context.dataLowerer.compilePostfixValue(
                    unwrapped,
                );
            if (value) {
                return value;
            }
        }
        if (ts.isPrefixUnaryExpression(unwrapped)) {
            const value =
                this.context.dataLowerer.compilePrefixValue(
                    unwrapped,
                );
            if (value) {
                return value;
            }
        }
        if (ts.isTemplateExpression(unwrapped)) {
            return this.compileTemplate(unwrapped);
        }
        if (ts.isRegularExpressionLiteral(unwrapped)) {
            const literal = unwrapped.text;
            const delimiter = literal.lastIndexOf("/");
            if (delimiter <= 0) {
                this.context.fail(unwrapped, "Malformed regular expression literal.");
            }
            const flags = literal.slice(delimiter + 1);
            for (const flag of flags) {
                if (flag !== "g" && flag !== "i") {
                    this.context.fail(
                        unwrapped,
                        `Reached RegExp literals support the g and i flags, not '${flag}'.`,
                    );
                }
            }
            // Slash delimits a JavaScript literal but has no syntactic role
            // once the pattern is handed to std::regex as a string.
            const pattern = literal
                .slice(1, delimiter)
                .replaceAll("\\/", "/");
            this.context.reachJsData();
            return {
                kind: "regexp",
                cpp:
                    `bbl::js::RegExp(${this.context.cppString(pattern)}, ` +
                    `${flags.includes("g") ? "true" : "false"}, ` +
                    `${flags.includes("i") ? "true" : "false"})`,
            };
        }
        if (
            ts.isStringLiteral(unwrapped) ||
            ts.isNoSubstitutionTemplateLiteral(unwrapped)
        ) {
            const value =
                this.context.compileStringLiteral(unwrapped);
            return {
                kind: "string",
                cpp: this.context.cppString(value),
                staticString: value,
            };
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.PlusToken &&
            (this.context.checker.getTypeAtLocation(unwrapped)
                .flags & ts.TypeFlags.StringLike) !==
                0
        ) {
            const operands: ts.Expression[] = [];
            this.collectStringPlusOperands(unwrapped, operands);
            const parts = operands.map((operand) =>
                this.stringConcatPart(
                    this.compileValue(operand),
                    operand,
                ),
            );
            this.context.reachJsData();
            return {
                kind: "data",
                cpp: `bbl::js::concat(${parts.join(", ")})`,
                dataType: { kind: "string" },
            };
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            (unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken ||
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.BarBarToken) &&
            !containsEvaluatedCall(unwrapped.left)
        ) {
            let leftValue: Value | undefined;
            const truthiness = this.context.probeEmission(
                () => {
                    leftValue = this.compileValue(unwrapped.left);
                    return this.context.dataLowerer.conditionFromValue(
                        leftValue!,
                    );
                },
                (condition) =>
                    condition === "true" || condition === "false",
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
        if (this.context.isNumberExpression(unwrapped)) {
            const staticNumber =
                ts.isNumericLiteral(unwrapped)
                    ? Number(unwrapped.text)
                    : undefined;
            return {
                kind: "number",
                // A value-position number still has JavaScript's double
                // precision. Concrete float sinks narrow it explicitly.
                cpp: this.context.compileNumber(unwrapped, "double"),
                ...(staticNumber === undefined
                    ? {}
                    : { staticNumber }),
            };
        }
        if (ts.isTypeOfExpression(unwrapped)) {
            const expression = this.context.unwrap(
                unwrapped.expression,
            );
            if (
                isSupportedAudioMethodProperty(
                    this.context,
                    expression,
                )
            ) {
                return {
                    kind: "string",
                    cpp: this.context.cppString("function"),
                    staticString: "function",
                };
            }
            if (
                expression.kind === ts.SyntaxKind.NullKeyword
            ) {
                return {
                    kind: "string",
                    cpp: this.context.cppString("object"),
                    staticString: "object",
                };
            }
            if (
                ts.isIdentifier(expression) &&
                expression.text === "undefined" &&
                !this.context.lookupOptional(expression)
            ) {
                return {
                    kind: "string",
                    cpp: this.context.cppString("undefined"),
                    staticString: "undefined",
                };
            }
            const operand = this.context.compileValue(
                expression,
            );
            const dataType =
                operand.dataType?.kind === "optional"
                    ? operand.dataType.inner
                    : operand.dataType;
            const type =
                operand.kind === "number"
                    ? "number"
                    : operand.kind === "boolean"
                      ? "boolean"
                      : operand.kind === "string" ||
                          dataType?.kind === "string" ||
                          dataType?.kind === "enum"
                        ? "string"
                        : operand.kind === "callback"
                          ? "function"
                          : operand.kind === "void"
                            ? "undefined"
                          : "object";
            const checkedType =
                this.context.checker.getTypeAtLocation(
                    expression,
                );
            const checkedMayBeUndefined =
                (checkedType.flags &
                    ts.TypeFlags.Undefined) !==
                    0 ||
                ((checkedType.flags &
                    ts.TypeFlags.Union) !==
                    0 &&
                    (checkedType as ts.UnionType).types.some(
                        (member) =>
                            (member.flags &
                                ts.TypeFlags.Undefined) !==
                            0,
                    ));
            const present =
                operand.parameterBinding &&
                !checkedMayBeUndefined
                    ? undefined
                    : operand.optionalFoundCpp ??
                      (operand.dataType?.kind === "optional"
                          ? `${operand.cpp}.has_value()`
                          : undefined);
            if (present !== undefined) {
                return {
                    kind: "data",
                    cpp:
                        `(${present} ? ` +
                        `${this.context.cppString(type)} : ` +
                        `${this.context.cppString("undefined")})`,
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
                kind: "boolean",
                // Value position still needs the full runtime condition
                // dispatcher: a concise callback commonly returns
                // `!set.has(value)`, which is boolean but not a static
                // literal expression.
                cpp: this.context.compileCondition(unwrapped),
                ...(staticBoolean === undefined
                    ? {}
                    : { staticBoolean }),
            };
        }
        // A comparison in value position is the same expression a
        // condition position already lowers; only where it lands differs.
        if (
            this.context.evaluator.isComparisonExpression(unwrapped)
        ) {
            return {
                kind: "boolean",
                cpp: this.context.compileCondition(unwrapped),
            };
        }
        if (this.context.isBrowserOnlyExpression(unwrapped)) {
            return this.compileBrowserValue(unwrapped);
        }

        this.context.fail(unwrapped, `Unsupported value expression: ${ts.SyntaxKind[unwrapped.kind]}.`);
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
        const staticValue = staticNumberValue(
            this.context,
            expression,
        );
        if (staticValue !== undefined) {
            return staticValue;
        }
        const unwrapped = this.context.unwrap(expression);
        const node = this.context.resolveStaticExpression(
            unwrapped,
        );
        if (node !== unwrapped) {
            const resolved = this.generationTimeNumber(node);
            if (resolved !== undefined) return resolved;
        }
        if (
            !ts.isCallExpression(node) ||
            !ts.isPropertyAccessExpression(node.expression) ||
            !ts.isIdentifier(node.expression.expression) ||
            node.expression.expression.text !== "Math"
        ) {
            return undefined;
        }
        const values = node.arguments.map((argument) =>
            this.generationTimeNumber(argument),
        );
        if (values.some((value) => value === undefined)) {
            return undefined;
        }
        const numbers = values as number[];
        switch (node.expression.name.text) {
            case "atan2":
                return numbers.length === 2
                    ? Math.atan2(numbers[0]!, numbers[1]!)
                    : undefined;
            case "cos":
                return numbers.length === 1
                    ? Math.cos(numbers[0]!)
                    : undefined;
            case "sin":
                return numbers.length === 1
                    ? Math.sin(numbers[0]!)
                    : undefined;
            default:
                return undefined;
        }
    }

    private compileTemplate(
        expression: ts.TemplateExpression,
    ): Value {
        const staticValues = expression.templateSpans.map(
            (span) =>
                this.context.evaluator.staticTextValue(
                    span.expression,
                ),
        );
        if (
            staticValues.every(
                (value): value is string =>
                    value !== undefined,
            )
        ) {
            let text = expression.head.text;
            expression.templateSpans.forEach(
                (span, index) => {
                    text += staticValues[index];
                    text += span.literal.text;
                },
            );
            return {
                kind: "string",
                cpp: this.context.cppString(text),
                staticString: text,
            };
        }

        const parts: string[] = [
            this.context.cppString(expression.head.text),
        ];
        let compiledStaticText = expression.head.text;
        let allCompiledValuesAreStatic = true;
        expression.templateSpans.forEach((span) => {
            const value = this.compileValue(
                span.expression,
            );
            const staticText =
                value.staticString ??
                (value.staticNumber !== undefined
                    ? String(value.staticNumber)
                    : value.kind === "json-null"
                      ? "null"
                      : undefined);
            if (staticText === undefined) {
                allCompiledValuesAreStatic = false;
            } else {
                compiledStaticText += staticText;
            }
            parts.push(this.stringConcatPart(value, span.expression));
            parts.push(
                this.context.cppString(
                    span.literal.text,
                ),
            );
            compiledStaticText += span.literal.text;
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
                ts.TypeFlags.StringLike) !== 0
        ) {
            this.collectStringPlusOperands(unwrapped.left, operands);
            this.collectStringPlusOperands(unwrapped.right, operands);
            return;
        }
        operands.push(node);
    }

    /** One operand of `bbl::js::concat`: text, or a number spelled by it. */
    /**
     * `Object.keys` and `Object.values` over a compile-time record: the
     * projection is the only difference, so one arm serves both. A
     * tuple-typed result stays compile-time; a vector-typed one
     * materializes the projected entries in source order.
     */
    private compileObjectProjection(
        call: ts.CallExpression,
        projection: "keys" | "values",
    ): Value {
        this.context.expectArgumentCount(call, 1, 1);
        const object = this.compileValue(call.arguments[0]!);
        const resultType = this.context.dataLowerer.dataTypeAt(call);
        if (
            projection === "values" &&
            object.kind === "data" &&
            object.dataType?.kind === "enummap" &&
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
        if (object.kind !== "record") {
            this.context.fail(
                call.arguments[0]!,
                `Object.${projection} currently expects a compile-time record.`,
            );
        }
        const entries: Value[] =
            projection === "keys"
                ? Object.keys(object.recordProperties ?? {}).map((key) => ({
                      kind: "string" as const,
                      cpp: this.context.cppString(key),
                      staticString: key,
                  }))
                : Object.values(object.recordProperties ?? {});
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

    private stringConcatPart(
        value: Value,
        node: ts.Node,
    ): string {
        if (value.staticString !== undefined) {
            return this.context.cppString(value.staticString);
        }
        if (value.staticNumber !== undefined) {
            return this.context.cppString(
                String(value.staticNumber),
            );
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
        if (
            value.kind === "data" &&
            value.dataType?.kind === "enum"
        ) {
            return this.context.dataTypes.enumToStringCpp(
                value.dataType,
                value.cpp,
                node,
            );
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "string"
        ) {
            return value.cpp;
        }
        if (value.kind === "json-null") {
            return this.context.cppString("null");
        }
        this.context.fail(
            node,
            "String concatenation supports string, number, boolean, and null values.",
        );
    }

    private compileBrowserValue(
        expression: ts.Expression,
    ): Value {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isCallExpression(unwrapped)) {
            for (const argument of unwrapped.arguments) {
                if (!containsEvaluatedCall(argument)) {
                    continue;
                }
                const value = this.compileValue(argument);
                if (value.kind === "engine" || value.cpp.length === 0) {
                    continue;
                }
                this.context.emit(
                    value.kind !== "void" ||
                        value.requiresExplicitDiscard
                        ? `static_cast<void>(${value.cpp});`
                        : `${value.cpp};`,
                );
            }
        }
        const browserValue =
            this.context.evaluateBrowserValue(expression);
        return this.materializeBrowserPrimitive(expression, {
            kind: "browser",
            cpp: "",
            ...(browserValue
                ? { browserValue }
                : {}),
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
                    ...(Number.isFinite(
                        value.browserValue.value,
                    )
                        ? {
                              staticNumber:
                                  value.browserValue.value,
                          }
                        : {}),
                };
            case "boolean":
                return {
                    kind: "boolean",
                    cpp: value.browserValue.value
                        ? "true"
                        : "false",
                };
            case "string":
                return {
                    kind: "string",
                    cpp: this.context.cppString(
                        value.browserValue.value,
                    ),
                    staticString: value.browserValue.value,
                };
            case "null":
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
    private compileDeferredCallback(
        call: ts.CallExpression,
    ): Value {
        this.context.expectArgumentCount(call, 2, 2);
        const delay = staticNumberValue(
            this.context,
            call.arguments[1]!,
        );
        if (delay !== 0) {
            if (
                this.context.isBrowserOnlyHandler(
                    this.context.unwrap(call.arguments[0]!),
                )
            ) {
                return { kind: "void", cpp: "" };
            }

            if (delay === undefined || !Number.isFinite(delay) || delay < 0) {
                this.context.fail(
                    call.arguments[1]!,
                    "setTimeout delay must be a generation-known finite non-negative number.",
                );
            }
            const engine = this.context.requireDefaultEngine(call);
            const callback = this.context.compileFrameCallback(
                call.arguments[0]!,
                "void",
            );
            return {
                kind: "number",
                cpp: `bbl::set_timeout(${engine}, ${callback}, ${delay})`,
                impure: true,
            };
        }
        const engine = this.context.requireDefaultEngine(call);
        const callback = this.context.compileFrameCallback(
            call.arguments[0]!,
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
        const value = this.compileValue(expression);
        if (
            value.kind !== "number" ||
            value.staticNumber !== undefined
        ) {
            return value;
        }
        const staticNumber = staticNumberValue(
            this.context,
            expression,
        );
        return staticNumber === undefined
            ? value
            : { ...value, staticNumber };
    }

    /**
     * `condition ? whenTrue : whenFalse` for two already-compiled values.
     * Both branches must name the same kind of native expression, since
     * the result has to be one expression the caller can use.
     */
    private selectValue(
        condition: string,
        whenTrue: Value,
        whenFalse: Value,
        node: ts.Node,
    ): Value {
        // Racer's placement helper selects between a loaded AssetContainer
        // and `{ entities: [cloneTransformNode(root)] }`. Both are the same
        // native AssetHandle shape: clone_asset_root deliberately creates a
        // mesh-only AssetRecord so addToScene, entities[0], and
        // getContainerMeshes all consume it through the ordinary asset path.
        const asAssetContainer = (value: Value): Value | undefined => {
            if (value.kind === "asset") return value;
            if (value.kind !== "record") return undefined;
            const properties = value.recordProperties ?? {};
            const names = Object.keys(properties);
            const entities = properties.entities;
            const root =
                names.length === 1 &&
                entities?.kind === "tuple" &&
                entities.tupleElements?.length === 1
                    ? entities.tupleElements[0]
                    : undefined;
            return root?.kind === "asset-root" && root.assetRootClone
                ? { ...root, kind: "asset" }
                : undefined;
        };
        if (whenTrue.kind !== whenFalse.kind) {
            const trueAsset = asAssetContainer(whenTrue);
            const falseAsset = asAssetContainer(whenFalse);
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
        if (
            whenTrue.kind === "tuple" &&
            whenFalse.kind === "tuple"
        ) {
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
                tupleElements: trueElements.map(
                    (element, index) =>
                        this.selectValue(
                            condition,
                            element,
                            falseElements[index]!,
                            node,
                        ),
                ),
            };
        }
        // Two records select member by member, the way two tuples select
        // element by element: a record is a compile-time property map
        // with no native expression of its own. The shared property
        // names are the condition for that to be the same thing.
        if (
            whenTrue.kind === "record" &&
            whenFalse.kind === "record"
        ) {
            const trueClass = this.context.classOf(whenTrue);
            const falseClass = this.context.classOf(whenFalse);
            const trueProperties = whenTrue.recordProperties ?? {};
            const falseProperties = whenFalse.recordProperties ?? {};
            const names = Object.keys(trueProperties);
            const falseNames = new Set(Object.keys(falseProperties));
            if (
                names.length !== falseNames.size ||
                names.some((name) => !falseNames.has(name))
            ) {
                this.context.fail(
                    node,
                    "Conditional record branches must carry the same properties.",
                );
            }
            const selected: Record<string, Value> = {};
            for (const name of names) {
                selected[name] = this.selectValue(
                    condition,
                    trueProperties[name]!,
                    falseProperties[name]!,
                    node,
                );
            }
            const selectedRecord: Value = {
                kind: "record",
                cpp: "",
                recordProperties: selected,
            };
            if (trueClass && trueClass === falseClass) {
                selectedRecord.classDeclaration = trueClass;
                if (whenTrue.recordGetters) {
                    selectedRecord.recordGetters =
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
                trueCollection.elementCppType !== falseCollection.elementCppType ||
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
        const stringValued = (value: Value): boolean =>
            value.kind === "string" ||
            (value.kind === "data" &&
                value.dataType?.kind === "string");
        if (
            whenTrue.kind !== whenFalse.kind &&
            stringValued(whenTrue) &&
            stringValued(whenFalse)
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
                : value.kind === "data" &&
                    value.dataType?.kind === "tuple"
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
                          cpp: this.context.dataLowerer
                              .compileKnownValueForSink(
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
        const conditional: Value = {
            ...whenTrue,
            cpp: `(${condition} ? ${whenTrue.cpp} : ${whenFalse.cpp})`,
        };
        if (
            whenTrue.nativeLvalue &&
            whenFalse.nativeLvalue
        ) {
            // The C++ conditional operator preserves lvalue category when
            // both branches are lvalues of the same type. Class selection
            // relies on that to pass the selected field by reference.
            conditional.nativeLvalue = true;
        } else {
            delete conditional.nativeLvalue;
        }
        if (
            whenTrue.optionalFoundCpp !== undefined ||
            whenFalse.optionalFoundCpp !== undefined
        ) {
            conditional.optionalFoundCpp =
                `(${condition} ? ` +
                `${whenTrue.optionalFoundCpp ?? "true"} : ` +
                `${whenFalse.optionalFoundCpp ?? "true"})`;
        }
        if (
            whenTrue.staticNumber !== whenFalse.staticNumber
        ) {
            delete conditional.staticNumber;
        }
        if (
            whenTrue.staticString !== whenFalse.staticString
        ) {
            delete conditional.staticString;
        }
        if (
            whenTrue.spriteDepthMode !==
            whenFalse.spriteDepthMode
        ) {
            delete conditional.spriteDepthMode;
        }
        return conditional;
    }

    private compileCall(call: ts.CallExpression): Value {
        const compressedJsonThen = compileCompressedJsonPromiseThen(
            this.context,
            call,
        );
        if (compressedJsonThen) {
            return compressedJsonThen;
        }
        const pixelsUpload =
            this.context.compilePixelsTextureUpload(call);
        if (pixelsUpload) {
            return pixelsUpload;
        }
        const platform = this.context.compilePlatformCall(call);
        if (platform) {
            return platform;
        }
        const promise = compileImmediatePromise(
            this.context,
            call,
        );
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
        if (this.context.isDeferredCallbackCall(call)) {
            return this.compileDeferredCallback(call);
        }
        // A pure module-URL helper is a compile-time string whether it feeds a
        // registered asset intrinsic directly or first travels through an
        // inlined user-function parameter. Recognize the call at the value
        // boundary so both data flows observe the same public-root path.
        const moduleAsset =
            this.context.moduleRelativeAssetUrl(call);
        if (moduleAsset !== undefined) {
            return {
                kind: "string",
                cpp: this.context.cppString(moduleAsset),
                staticString: moduleAsset,
            };
        }
        const callee = this.context.unwrap(call.expression);
        if (
            ts.isIdentifier(callee) &&
            callee.text === "createImageBitmap" &&
            !this.context.lookupOptional(callee)
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
            callee.text === "requestAnimationFrame" &&
            !this.context.lookupOptional(callee)
        ) {
            const animationFrame =
                this.context.compileAnimationFrameCall(call);
            if (animationFrame) return animationFrame;
        }
        if (ts.isPropertyAccessExpression(callee)) {
            if (
                ts.isIdentifier(callee.expression) &&
                callee.expression.text === "Object" &&
                (callee.name.text === "keys" ||
                    callee.name.text === "values") &&
                !this.context.lookupOptional(callee.expression)
            ) {
                return this.compileObjectProjection(
                    call,
                    callee.name.text,
                );
            }
            if (
                ts.isIdentifier(callee.expression) &&
                callee.expression.text === "String" &&
                callee.name.text === "fromCharCode" &&
                !this.context.lookupOptional(callee.expression)
            ) {
                this.context.reachJsData();
                return {
                    kind: "data",
                    cpp:
                        call.arguments.length === 0
                            ? "std::string{}"
                            : call.arguments.length === 1
                            ? `bbl::js::string_from_char_code(${this.context.compileNumber(call.arguments[0]!, "double")})`
                            : `bbl::js::string_from_char_codes({${call.arguments.map((argument) => this.context.compileNumber(argument, "double")).join(", ")}})`,
                    dataType: { kind: "string" },
                };
            }
            if (
                ts.isIdentifier(callee.expression) &&
                callee.expression.text === "Number" &&
                callee.name.text === "isFinite" &&
                !this.context.lookupOptional(callee.expression)
            ) {
                this.context.expectArgumentCount(call, 1, 1);
                return {
                    kind: "boolean",
                    cpp: `std::isfinite(${this.context.compileNumber(call.arguments[0]!, "double")})`,
                    dataType: { kind: "boolean" },
                };
            }
            if (callee.name.text === "toString") {
                const owner = this.compileValue(
                    callee.expression,
                );
                if (owner.kind === "number") {
                    this.context.expectArgumentCount(call, 0, 0);
                    this.context.reachJsData();
                    return {
                        kind: "data",
                        cpp: `bbl::js::number_to_string(${owner.cpp})`,
                        dataType: { kind: "string" },
                    };
                }
            }
            if (PURE_NUMBER_FORMATTERS.has(callee.name.text)) {
                this.context.expectArgumentCount(call, 0, 1);
                const owner = this.compileValue(callee.expression);
                const number =
                    owner.staticNumber ??
                    this.generationTimeNumber(
                        callee.expression,
                    );
                const digits = call.arguments[0]
                    ? staticNumberValue(
                          this.context,
                          call.arguments[0],
                      )
                    : undefined;
                if (
                    callee.name.text === "toFixed" &&
                    owner.kind === "number" &&
                    number === undefined &&
                    (call.arguments.length === 0 ||
                        (digits !== undefined && Number.isInteger(digits)))
                ) {
                    const precision = digits ?? 0;
                    if (precision < 0 || precision > 100) {
                        this.context.fail(call, "Number.toFixed precision must be between 0 and 100.");
                    }
                    this.context.reachJsData();
                    return {
                        kind: "data",
                        cpp: `bbl::js::number_to_fixed(${owner.cpp}, ${precision})`,
                        dataType: { kind: "string" },
                    };
                }
                if (
                    owner.kind !== "number" ||
                    number === undefined ||
                    (call.arguments.length > 0 &&
                        (digits === undefined ||
                            !Number.isInteger(digits)))
                ) {
                    this.context.fail(
                        call,
                        `Number.${callee.name.text} in a generation-time string requires a static number and integer precision (received '${owner.cpp}').`,
                    );
                }
                let text: string;
                if (callee.name.text === "toFixed") {
                    if (digits !== undefined && (digits < 0 || digits > 100)) {
                        this.context.fail(call, "Number.toFixed precision must be between 0 and 100.");
                    }
                    text = digits === undefined
                        ? number.toFixed()
                        : number.toFixed(digits);
                } else if (callee.name.text === "toPrecision") {
                    if (digits !== undefined && (digits < 1 || digits > 100)) {
                        this.context.fail(call, "Number.toPrecision precision must be between 1 and 100.");
                    }
                    text = digits === undefined
                        ? number.toPrecision()
                        : number.toPrecision(digits);
                } else {
                    if (digits !== undefined && (digits < 0 || digits > 100)) {
                        this.context.fail(call, "Number.toExponential precision must be between 0 and 100.");
                    }
                    text = digits === undefined
                        ? number.toExponential()
                        : number.toExponential(digits);
                }
                return {
                    kind: "string",
                    cpp: this.context.cppString(text),
                    staticString: text,
                };
            }
            const staticOwner = this.compileStaticOwner(
                callee.expression,
            );
            if (staticOwner) {
                const fetched =
                    this.context.compileStaticFetchMethod(
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
            }
            const regexpExpression = this.context.unwrap(
                callee.expression,
            );
            const regexpType = this.context.checker.getTypeAtLocation(
                regexpExpression,
            );
            const boundRegexp = ts.isIdentifier(regexpExpression)
                ? this.context.lookupOptional(regexpExpression)
                : undefined;
            const regexpOwner =
                boundRegexp?.kind === "regexp"
                    ? boundRegexp
                    : regexpType.symbol?.name === "RegExp" ||
                        regexpExpression.kind ===
                            ts.SyntaxKind.RegularExpressionLiteral ||
                        ts.isNewExpression(regexpExpression)
                      ? this.compileValue(regexpExpression)
                      : undefined;
            if (regexpOwner?.kind === "regexp") {
                if (
                    callee.name.text !== "exec" &&
                    callee.name.text !== "test"
                ) {
                    this.context.fail(
                        callee.name,
                        `RegExp method '${callee.name.text}' is not supported.`,
                    );
                }
                this.context.expectArgumentCount(call, 1, 1);
                const input = this.context.dataLowerer.compileForSink(
                    call.arguments[0]!,
                    { kind: "string" },
                );
                this.context.reachJsData();
                if (callee.name.text === "test") {
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
            const math =
                this.context.dataLowerer.compileMathCall(call);
            if (math) {
                return math;
            }
            const arrayFrom =
                this.context.dataLowerer.compileArrayFrom(call);
            if (arrayFrom) {
                return arrayFrom;
            }
            // Resolve engine-handle searches before the plain-data method
            // probe compiles their owner. A fused `meshes.map(...).find(...)`
            // has no native intermediate array for that probe to lower.
            const found =
                this.context.handleCollections.compileFind(
                    call,
                    callee,
                );
            if (found) {
                return found;
            }
            const method = this.context.probeEmission(() =>
                this.context.dataLowerer.compileDataMethodCall(call),
            );
            if (method) {
                return method;
            }
            // The Web Audio surface: `ctx.createGain()`,
            // `node.connect(...)`, `param.setValueAtTime(...)`. Babylon
            // Lite is function-shaped and the browser API is not, so the
            // audio family is the one place a handle carries methods.
            const audio = compileAudioMethodCall(
                this.context,
                call,
                callee,
            );
            if (audio) {
                return audio;
            }
            // The second such surface: a VatHandle is a closure bundle
            // upstream, so its playback methods ride the handle too.
            const vat = compileVatMethodCall(
                this.context,
                call,
                callee,
            );
            if (vat) {
                return vat;
            }
            const lightPush =
                this.context.handleCollections.compileSceneLightPush(
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
                this.context.handleCollections.compileHandleTuplePush(
                    call,
                    callee,
                );
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
                return this.context.userFunctions.compileCallbackCall(
                    this.context,
                    call,
                    staticMethod,
                );
            }
            // A method on a constructed instance inlines with `this`
            // bound to that instance's field record.
            const receiver = this.context.unwrap(callee.expression);
            if (
                ts.isIdentifier(receiver) ||
                receiver.kind === ts.SyntaxKind.ThisKeyword ||
                ts.isPropertyAccessExpression(receiver) ||
                ts.isConditionalExpression(receiver) ||
                ts.isCallExpression(receiver)
            ) {
                const instance = ts.isIdentifier(receiver)
                    ? this.context.lookupOptional(receiver)
                    : receiver.kind === ts.SyntaxKind.ThisKeyword
                      ? this.context.activeThis()
                      : this.compileValue(receiver);
                const declaration = instance
                    ? this.context.classOf(instance)
                    : undefined;
                // A record property naming a local function inlines at
                // the call site exactly as a direct call to that
                // function does, by handing the identifier the literal
                // wrote to the same resolver.
                const recordMethod =
                    instance?.kind === "record"
                        ? instance.recordMethods?.[
                              callee.name.text
                          ]
                        : undefined;
                const recordCallback =
                    instance?.kind === "record"
                        ? instance.recordProperties?.[
                              callee.name.text
                          ]
                        : undefined;
                if (
                    instance?.kind === "record" &&
                    call.questionDotToken &&
                    !recordMethod &&
                    !recordCallback
                ) {
                    return { kind: "void", cpp: "" };
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
                                ),
                        );
                    }
                    const method =
                        this.context.userFunctions.compile(
                            this.context,
                            call,
                            recordMethod,
                            // Only the body runs in the record's
                            // scope; the arguments were written at
                            // the call site and resolve there.
                            (work) =>
                                this.context.withRecordScopes(
                                    instance,
                                    work,
                                ),
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
                    return ts.isIdentifier(
                        recordCallback.callbackDeclaration,
                    )
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
                if (instance && declaration) {
                    return this.context.classLowerer.compileMethodCall(
                        instance,
                        callee.name.text,
                        call,
                        declaration,
                    );
                }
            }
        }
        if (
            ts.isArrowFunction(callee) ||
            ts.isFunctionExpression(callee)
        ) {
            return this.context.userFunctions.compileCallbackCall(
                this.context,
                call,
                callee,
            );
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
            const settled = this.context.evaluateBrowserValue(call);
            if (
                settled?.kind === "number" &&
                Number.isFinite(settled.value)
            ) {
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

        if (!ts.isIdentifier(callee)) {
            const receiver =
                ts.isPropertyAccessExpression(callee) &&
                ts.isIdentifier(callee.expression)
                    ? this.context.lookupOptional(callee.expression)
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

        if (
            callee.text === "String" &&
            !this.context.lookupOptional(callee)
        ) {
            this.context.expectArgumentCount(call, 1, 1);
            const value = this.compileValue(call.arguments[0]!);
            this.context.reachJsData();
            if (value.kind === "number" || value.kind === "boolean") {
                return {
                    kind: "data",
                    cpp: `bbl::js::concat(${this.stringConcatPart(value, call.arguments[0]!)})`,
                    dataType: { kind: "string" },
                };
            }
            if (
                value.kind === "string" ||
                (value.kind === "data" &&
                    value.dataType?.kind === "string")
            ) {
                return {
                    kind: "data",
                    cpp: value.cpp,
                    dataType: { kind: "string" },
                };
            }
            this.context.fail(
                call.arguments[0]!,
                `String() supports number, boolean, and string values, received ${value.kind}.`,
            );
        }

        if (
            callee.text === "parseInt" &&
            this.context.isDefaultLibraryIdentifier(callee)
        ) {
            this.context.expectArgumentCount(call, 1, 2);
            if (call.arguments[1]) {
                const radix = this.compileValue(call.arguments[1]);
                if (
                    radix.kind !== "number" ||
                    radix.staticNumber !== 10 ||
                    radix.parameterBinding
                ) {
                    this.context.fail(
                        call.arguments[1],
                        "Reached parseInt currently requires the literal radix 10.",
                    );
                }
            }
            const value = this.compileValue(call.arguments[0]!);
            if (
                value.kind !== "string" &&
                !(
                    value.kind === "data" &&
                    value.dataType?.kind === "string"
                )
            ) {
                this.context.fail(
                    call.arguments[0]!,
                    "Reached parseInt currently requires a string value.",
                );
            }
            this.context.reachJsData();
            return {
                kind: "number",
                cpp: `bbl::js::parse_int_decimal(${value.cpp})`,
                dataType: { kind: "number" },
            };
        }
        if (
            callee.text === "Number" &&
            !this.context.lookupOptional(callee)
        ) {
            this.context.expectArgumentCount(call, 1, 1);
            return this.compileNumberConversion(
                call.arguments[0]!,
            );
        }

        const dynamicModuleAsset =
            this.context.compileDynamicModuleRelativeAssetUrl(call);
        if (dynamicModuleAsset) return dynamicModuleAsset;

        const fetched = this.context.compileStaticFetch(
            call,
            callee,
        );
        if (fetched) return fetched;

        const bound = this.context.lookupOptional(callee);
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
            return ts.isIdentifier(
                bound.callbackDeclaration,
            )
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
        if (
            bound?.kind === "data" &&
            bound.dataType?.kind === "function"
        ) {
            const functionType = bound.dataType;
            const argumentsCpp =
                this.context.dataLowerer.compileFunctionArguments(
                    call,
                    functionType,
                );
            const cpp = `${bound.cpp}(${argumentsCpp.join(", ")})`;
            return functionType.result
                ? this.context.dataLowerer.leafValue(cpp, functionType.result)
                : { kind: "void", cpp };
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

        const importedName =
            this.context.symbols.importedName(callee);
        if (importedName) {
            const registered = this.context.compileRegisteredIntrinsic(
                importedName,
                call,
            );
            if (registered) {
                return registered;
            }
            this.context.fail(
                callee,
                `Babylon Lite intrinsic '${importedName}' is not supported by this prototype. Supported scene APIs are documented in README.md.`,
            );
        }
        const compressedJson = compileCompressedJsonCall(
            this.context,
            call,
            callee,
        );
        if (compressedJson) {
            return compressedJson;
        }
        const voxelFile = this.context.compileVoxelFileCall(
            call,
            callee,
        );
        if (voxelFile) {
            return voxelFile;
        }
        const nativeFunction =
            this.context.nativeFunctions.tryCompileCall(
                call,
                callee,
            );
        if (nativeFunction) {
            return nativeFunction;
        }
        const thinInstanceUpload =
            this.context.compileThinInstanceUploadHelper(
                call,
                callee,
            );
        if (thinInstanceUpload) {
            return thinInstanceUpload;
        }
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
        const decodedAudio = compileAudioDecodeAssetCall(
            this.context,
            call,
            callee,
        );
        if (decodedAudio) {
            return decodedAudio;
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
        this.context.emit(
            `const bbl::VatClipRow ${row} = bbl::vat_clip_row(` +
                `${engine}, ${map.cpp}, ` +
                `${this.context.cppString(clip)});`,
        );
        return {
            kind: "vat-clip",
            cpp: row,
            engineCpp: engine,
            optionalFoundCpp: `(${row}.frame_count != 0.0)`,
        };
    }

    private compileNumberConversion(
        expression: ts.Expression,
    ): Value {
        const unwrapped = this.context.unwrap(expression);
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken
        ) {
            const optional = this.compileValue(unwrapped.left);
            if (
                optional.kind === "data" &&
                optional.dataType?.kind === "optional" &&
                (optional.dataType.inner.kind === "string" ||
                    optional.dataType.inner.kind === "number")
            ) {
                const fallback = this.compileNumberConversion(
                    unwrapped.right,
                );
                const present = optional.dataType.inner.kind === "string"
                    ? `bbl::js::number_from_string(*v)`
                    : `static_cast<double>(*v)`;
                this.context.reachJsData();
                return {
                    kind: "number",
                    cpp:
                        `([&]() { auto v = ${optional.cpp}; ` +
                        `return v.has_value() ? ${present} : ${fallback.cpp}; }())`,
                    dataType: { kind: "number" },
                };
            }
        }
        const value = this.compileValue(unwrapped);
        if (value.kind === "number") return value;
        if (
            value.kind === "string" ||
            (value.kind === "data" &&
                value.dataType?.kind === "string")
        ) {
            this.context.reachJsData();
            return {
                kind: "number",
                cpp: `bbl::js::number_from_string(${value.cpp})`,
                dataType: { kind: "number" },
            };
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "optional" &&
            (value.dataType.inner.kind === "string" ||
                value.dataType.inner.kind === "number")
        ) {
            const present = value.dataType.inner.kind === "string"
                ? "bbl::js::number_from_string(*v)"
                : "static_cast<double>(*v)";
            this.context.reachJsData();
            return {
                kind: "number",
                cpp:
                    `([&]() { auto v = ${value.cpp}; ` +
                    `return v.has_value() ? ${present} : ` +
                    `std::numeric_limits<double>::quiet_NaN(); }())`,
                dataType: { kind: "number" },
            };
        }
        this.context.fail(
            expression,
            `Number() supports number and string values, received ${value.kind}.`,
        );
    }

    private compileStaticOwner(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isArrayLiteralExpression(unwrapped)) {
            return this.staticContainer(
                this.compileValue(unwrapped),
            );
        }
        if (ts.isIdentifier(unwrapped)) {
            const bound = this.staticContainer(
                this.context.lookupOptional(unwrapped),
            );
            if (bound) return bound;
            const resolved =
                this.context.resolveStaticExpression(unwrapped);
            return resolved !== unwrapped &&
                ts.isArrayLiteralExpression(resolved)
                ? this.staticContainer(
                      this.compileValue(resolved),
                  )
                : undefined;
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const owner = this.compileStaticOwner(
                unwrapped.expression,
            );
            return owner?.kind === "record"
                ? this.staticContainer(
                      owner.recordProperties?.[
                          unwrapped.name.text
                      ],
                  )
                : undefined;
        }
        if (
            ts.isElementAccessExpression(unwrapped) &&
            unwrapped.argumentExpression
        ) {
            const owner = this.compileStaticOwner(
                unwrapped.expression,
            );
            const indexNode =
                this.context.resolveStaticExpression(
                    unwrapped.argumentExpression,
                );
            const index = ts.isNumericLiteral(indexNode)
                ? Number(indexNode.text)
                : undefined;
            return owner?.kind === "tuple" &&
                index !== undefined &&
                Number.isInteger(index)
                ? this.staticContainer(
                      owner.tupleElements?.[index],
                  )
                : undefined;
        }
        return undefined;
    }

    private staticContainer(
        value: Value | undefined,
    ): Value | undefined {
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
            (method !== "map" &&
                method !== "some" &&
                method !== "forEach")
        ) {
            return undefined;
        }
        if (call.arguments.length !== 1) {
            this.context.fail(
                call,
                `Compile-time Array.${method} requires exactly one callback and no thisArg.`,
            );
        }
        const callback = this.context.unwrap(call.arguments[0]!);
        if (
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback) &&
            !ts.isIdentifier(callback)
        ) {
            this.context.fail(
                callback,
                `Compile-time Array.${method} requires a local function or function literal callback.`,
            );
        }
        const elements = owner.tupleElements ?? [];
        const results = elements.map((element, index) =>
            this.compileStaticTupleCallback(
                callback,
                [
                    element,
                    {
                        kind: "number",
                        cpp: `${index}.0f`,
                        staticNumber: index,
                    },
                    owner,
                ],
                call,
            ),
        );
        if (method === "forEach") {
            return { kind: "void", cpp: "" };
        }
        if (method === "some") {
            for (const result of results) {
                if (result.kind !== "boolean") {
                    this.context.fail(
                        callback,
                        "Compile-time Array.some callback must return a boolean value.",
                    );
                }
            }
            return {
                kind: "boolean",
                cpp:
                    results.length === 0
                        ? "false"
                        : results
                              .map((result) => `(${result.cpp})`)
                              .join(" || "),
                dataType: { kind: "boolean" },
            };
        }
        const mappedType =
            this.context.dataLowerer.dataTypeAt(call);
        if (
            mappedType?.kind === "vector" &&
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
            const elementCpp =
                this.context.dataTypes.cppType(
                    elementType,
                );
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
        callback:
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression,
        arguments_: readonly Value[],
        call: ts.CallExpression,
    ): Value {
        if (
            ts.isIdentifier(callback) ||
            callback.parameters.length === 0 ||
            !ts.isArrayBindingPattern(
                callback.parameters[0]!.name,
            )
        ) {
            return this.context.userFunctions.compileCallbackWithValues(
                this.context,
                callback,
                arguments_,
                call,
            );
        }
        const tuple = arguments_[0];
        if (tuple?.kind !== "tuple") {
            this.context.fail(
                callback.parameters[0]!,
                "Array binding callback requires a tuple element.",
            );
        }
        this.context.pushScope(
            this.context.allocateUserFunctionPrefix(),
        );
        try {
            const pattern = callback.parameters[0]!
                .name as ts.ArrayBindingPattern;
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
                this.context.bindLocalValue(binding.name, value);
            });
            callback.parameters
                .slice(1)
                .forEach((parameter, index) => {
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
                    this.context.bindCompileTimeValue(
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
                    let earlierReturn: ts.ReturnStatement | undefined;
                    const findEarlierReturn = (node: ts.Node): void => {
                        if (earlierReturn) return;
                        if (ts.isReturnStatement(node)) {
                            earlierReturn = node;
                            return;
                        }
                        if (
                            node !== callback.body &&
                            ts.isFunctionLike(node)
                        ) {
                            return;
                        }
                        ts.forEachChild(node, findEarlierReturn);
                    };
                    statements
                        .slice(0, -1)
                        .forEach(findEarlierReturn);
                    if (earlierReturn) {
                        this.context.fail(
                            earlierReturn,
                            "Destructured static tuple block callbacks support only a final return statement.",
                        );
                    }
                    for (const statement of statements.slice(0, -1)) {
                        this.context.emitStatement(statement);
                    }
                    return this.context.compileValue(
                        finalStatement.expression,
                    );
                }
                let hasReturn = false;
                const findReturn = (node: ts.Node): void => {
                    if (hasReturn) return;
                    if (ts.isReturnStatement(node)) {
                        hasReturn = true;
                        return;
                    }
                    if (
                        node !== callback.body &&
                        ts.isFunctionLike(node)
                    ) {
                        return;
                    }
                    ts.forEachChild(node, findReturn);
                };
                findReturn(callback.body);
                if (hasReturn) {
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
            return this.context.compileValue(callback.body);
        } finally {
            this.context.popScope();
        }
    }
}
