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
import { compileAudioMethodCall } from "./audio-surface.js";
import type { ClassLowerer } from "./classes.js";
import type { DataLowerer } from "./data-lowering.js";
import type { DataType } from "./data-types.js";
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
const PURE_NUMBER_FORMATTERS = new Set([
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
    moduleRelativeAssetUrl(
        expression: ts.Expression,
    ): string | undefined;
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
    compileStaticFetch(
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
}

export class ExpressionLowerer {
    public constructor(
        private readonly context: ExpressionContext,
    ) {}

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
            if (!assertedNonNull) {
                const guardable =
                    this.context.dataLowerer.compileGuardableElementAccess(
                        unwrapped,
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
                            key.dataType?.kind === "string");
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
                    const declaredValueType =
                        indexedType.kind === "optional"
                            ? indexedType.inner
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
                    const lookup =
                        `([]() -> ${mapType}& { ` +
                        `static ${mapType} values{${entries.join(", ")}}; ` +
                        `return values; }()).${totalClosedKey ? "at" : "get"}(${key.cpp})`;
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
            if (
                index.kind !== "number" ||
                index.staticNumber === undefined ||
                !Number.isInteger(index.staticNumber)
            ) {
                this.context.fail(
                    unwrapped.argumentExpression,
                    "Static tuple access requires an integer index.",
                );
            }
            const value =
                owner.tupleElements?.[index.staticNumber];
            if (!value) {
                this.context.fail(
                    unwrapped,
                    `Tuple index ${index.staticNumber} is out of range.`,
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
            const conditionalType =
                this.context.dataLowerer.dataTypeAt(
                    unwrapped,
                );
            if (conditionalType?.kind === "optional") {
                const objectIdentity =
                    conditionalType.inner.kind === "struct"
                        ? this.context.dataLowerer.objectIdentity(
                              unwrapped,
                          )
                        : undefined;
                return {
                    kind: "data",
                    cpp:
                        objectIdentity ??
                        this.context.dataLowerer.compileForSink(
                            unwrapped,
                            conditionalType,
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
                    this.context.dataLowerer.compileForSink(
                        unwrapped,
                        conditionalType,
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
                    this.context.dataLowerer.compileForSink(
                        unwrapped,
                        conditionalType,
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
            const whenTrue = this.compileValue(
                unwrapped.whenTrue,
            );
            const whenFalse = this.compileValue(
                unwrapped.whenFalse,
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
                    if (spread.kind !== "record") {
                        this.context.fail(
                            property,
                            "Compile-time object spread requires a plain record value.",
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
            const left = this.compileValue(unwrapped.left);
            const right = this.compileValue(unwrapped.right);
            const leftCpp = this.stringCoercion(
                left,
                unwrapped.left,
            );
            const rightCpp = this.stringCoercion(
                right,
                unwrapped.right,
            );
            this.context.reachJsData();
            return {
                kind: "data",
                cpp: `${leftCpp} + ${rightCpp}`,
                dataType: { kind: "string" },
            };
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
            `std::string(${this.context.cppString(
                expression.head.text,
            )})`,
        ];
        let compiledStaticText = expression.head.text;
        let allCompiledValuesAreStatic = true;
        expression.templateSpans.forEach((span) => {
            const value = this.compileValue(
                span.expression,
            );
            if (value.staticString !== undefined) {
                compiledStaticText += value.staticString;
                parts.push(
                    this.context.cppString(
                        value.staticString,
                    ),
                );
            } else if (value.staticNumber !== undefined) {
                compiledStaticText += String(value.staticNumber);
                parts.push(
                    this.context.cppString(
                        String(value.staticNumber),
                    ),
                );
            } else if (value.kind === "number") {
                allCompiledValuesAreStatic = false;
                parts.push(
                    `bbl::js::number_to_string(${value.cpp})`,
                );
            } else if (value.kind === "boolean") {
                allCompiledValuesAreStatic = false;
                parts.push(
                    `std::string(${value.cpp} ? "true" : "false")`,
                );
            } else if (value.kind === "string") {
                allCompiledValuesAreStatic = false;
                parts.push(value.cpp);
            } else if (
                value.kind === "data" &&
                value.dataType?.kind === "string"
            ) {
                allCompiledValuesAreStatic = false;
                parts.push(value.cpp);
            } else if (value.kind === "json-null") {
                compiledStaticText += "null";
                parts.push(this.context.cppString("null"));
            } else {
                this.context.fail(
                    span.expression,
                    "Runtime template substitutions support string, number, boolean, and null values.",
                );
            }
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
            cpp: parts.join(" + "),
            dataType: { kind: "string" },
        };
    }

    private stringCoercion(
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
            return `bbl::js::number_to_string(${value.cpp})`;
        }
        if (value.kind === "boolean") {
            return `std::string(${value.cpp} ? "true" : "false")`;
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
     * `setTimeout(callback, 0)`, as the deferred callback the engine runs
     * at the next frame boundary.
     *
     * The delay is read at generation and must be zero. Babylon Native --
     * which embeds a JavaScript engine and so must serve any delay -- pays
     * for a whole timer thread here; the reached slice needs none of it,
     * and a non-zero delay refuses rather than silently becoming "next
     * frame", which would be a different scene.
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
            const callback = this.context.unwrap(
                call.arguments[0]!,
            );
            const body =
                ts.isArrowFunction(callback) ||
                ts.isFunctionExpression(callback)
                    ? callback.body
                    : undefined;
            const browserOnly = body
                ? ts.isBlock(body)
                    ? body.statements.every(
                          (statement) =>
                              ts.isExpressionStatement(statement) &&
                              this.context.isBrowserOnlyExpression(
                                  statement.expression,
                              ),
                      )
                    : this.context.isBrowserOnlyExpression(body)
                : false;
            if (browserOnly) {
                return { kind: "void", cpp: "" };
            }
            this.context.fail(
                call.arguments[1]!,
                "Only a zero-delay setTimeout is lowered: it means " +
                    "\"after the current turn\", which the frame " +
                    "conductor already has. A real delay needs a timer " +
                    "this runtime does not carry, and rounding one to " +
                    "the next frame would be a different scene.",
            );
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
            return {
                kind: "record",
                cpp: "",
                recordProperties: selected,
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
                "Conditional expressions require matching native value branches.",
            );
        }
        const conditional: Value = {
            ...whenTrue,
            cpp: `(${condition} ? ${whenTrue.cpp} : ${whenFalse.cpp})`,
        };
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
        return conditional;
    }

    private compileCall(call: ts.CallExpression): Value {
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
                callee.name.text === "values" &&
                !this.context.lookupOptional(callee.expression)
            ) {
                this.context.expectArgumentCount(call, 1, 1);
                const object = this.compileValue(call.arguments[0]!);
                const resultType =
                    this.context.dataLowerer.dataTypeAt(call);
                if (
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
                        "Object.values currently expects a compile-time record.",
                    );
                }
                const values = Object.values(
                    object.recordProperties ?? {},
                );
                if (resultType?.kind === "vector") {
                    this.context.reachJsData();
                    return {
                        kind: "data",
                        cpp:
                            `bbl::js::Array<${this.context.dataTypes.cppType(resultType.element)}>{` +
                            values
                                .map((value) =>
                                    this.context.dataLowerer.compileKnownValueForSink(
                                        value,
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
                    tupleElements: values,
                };
            }
            if (
                ts.isIdentifier(callee.expression) &&
                callee.expression.text === "String" &&
                callee.name.text === "fromCharCode" &&
                !this.context.lookupOptional(callee.expression)
            ) {
                this.context.expectArgumentCount(call, 1, 1);
                this.context.reachJsData();
                return {
                    kind: "data",
                    cpp: `bbl::js::string_from_char_code(${this.context.compileNumber(call.arguments[0]!, "double")})`,
                    dataType: { kind: "string" },
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
            const regexpOwner = ts.isIdentifier(callee.expression)
                ? this.context.lookupOptional(callee.expression)
                : undefined;
            if (regexpOwner?.kind === "regexp") {
                if (callee.name.text !== "exec") {
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
            const method =
                this.context.dataLowerer.compileDataMethodCall(
                    call,
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
            const found =
                this.context.handleCollections.compileFind(
                    call,
                    callee,
                );
            if (found) {
                return found;
            }
            // A method on a constructed instance inlines with `this`
            // bound to that instance's field record.
            const receiver = this.context.unwrap(callee.expression);
            if (
                ts.isIdentifier(receiver) ||
                receiver.kind === ts.SyntaxKind.ThisKeyword ||
                ts.isPropertyAccessExpression(receiver)
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
                if (
                    instance?.kind === "record" &&
                    call.questionDotToken &&
                    !recordMethod &&
                    !instance.recordProperties?.[callee.name.text]
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
        if (!ts.isIdentifier(callee)) {
            this.context.fail(callee, `Unsupported call target '${callee.getText()}'.`);
        }

        if (
            callee.text === "String" &&
            !this.context.lookupOptional(callee)
        ) {
            this.context.expectArgumentCount(call, 1, 1);
            const value = this.compileValue(call.arguments[0]!);
            this.context.reachJsData();
            if (value.kind === "number") {
                return {
                    kind: "data",
                    cpp: `bbl::js::number_to_string(${value.cpp})`,
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
                `String() supports number and string values, received ${value.kind}.`,
            );
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
            return this.staticContainer(
                this.context.lookupOptional(unwrapped),
            );
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
