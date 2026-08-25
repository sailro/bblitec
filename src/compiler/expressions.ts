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

import { compileAudioMethodCall } from "./audio-surface.js";
import type { ClassLowerer } from "./classes.js";
import type { DataLowerer } from "./data-lowering.js";
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
    Value,
    ValueKind,
} from "./types.js";
import type {
    HandleCollections,
    HandleCollectionTarget,
} from "./handle-collections.js";
import type {
    UserFunctionContext,
    UserFunctionLowerer,
} from "./user-functions.js";

export interface ExpressionContext
    extends PromiseLoweringContext,
        UserFunctionContext {
    readonly evaluator: StaticEvaluator;
    /** The scene's node-particle program; a systems.push lands on it. */
    readonly reachedNodeParticles: CompiledNodeParticles;
    readonly dataLowerer: DataLowerer;
    readonly classLowerer: ClassLowerer;
    readonly userFunctions: UserFunctionLowerer;
    readonly nativeFunctions: NativeFunctionLowerer;
    readonly symbols: CompilerSymbols;
    readonly variableScopes: ReadonlyArray<
        Map<ts.Symbol, { name: string; value: Value }>
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
        signature?: "delta" | "void",
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
}

export class ExpressionLowerer {
    public constructor(
        private readonly context: ExpressionContext,
    ) {}

    public compileValue(expression: ts.Expression): Value {
        const unwrapped = this.context.unwrap(expression);

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
                return this.materializeBrowserPrimitive(
                    unwrapped,
                    value,
                );
            }
            const resolved =
                this.context.resolveStaticExpression(unwrapped);
            if (resolved !== unwrapped) {
                return this.compileValue(resolved);
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
        if (
            ts.isCallExpression(unwrapped) &&
            this.context.isBrowserOnlyExpression(unwrapped)
        ) {
            return this.compileBrowserValue(unwrapped);
        }
        if (ts.isCallExpression(unwrapped)) {
            return this.compileCall(unwrapped);
        }
        if (ts.isConditionalExpression(unwrapped)) {
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
            return {
                kind: "tuple",
                cpp: "",
                tupleElements: unwrapped.elements.map(
                    (element) =>
                        this.compileValue(element),
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
            > = {};
            const getters: Record<
                string,
                ts.GetAccessorDeclaration
            > = {};
            for (const property of unwrapped.properties) {
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
                    properties[name] = this.compileValue(
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
                        this.compileValue(property.name);
                } else {
                    this.context.fail(
                        property,
                        "Static records support property assignments, getters, and properties naming a local function.",
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
        if (
            ts.isStringLiteral(unwrapped) ||
            ts.isNoSubstitutionTemplateLiteral(unwrapped) ||
            ts.isTemplateExpression(unwrapped)
        ) {
            const value =
                this.context.compileStringLiteral(unwrapped);
            return {
                kind: "string",
                cpp: this.context.cppString(value),
                staticString: value,
            };
        }
        if (this.context.isNumberExpression(unwrapped)) {
            const staticNumber =
                ts.isNumericLiteral(unwrapped)
                    ? Number(unwrapped.text)
                    : undefined;
            return {
                kind: "number",
                cpp: this.context.compileNumber(unwrapped),
                ...(staticNumber === undefined
                    ? {}
                    : { staticNumber }),
            };
        }
        if (this.context.evaluator.isBooleanExpression(unwrapped)) {
            return {
                kind: "boolean",
                cpp: this.context.compileBoolean(unwrapped),
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

    private compileBrowserValue(
        expression: ts.Expression,
    ): Value {
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
        const promise = compileImmediatePromise(
            this.context,
            call,
        );
        if (promise) {
            return promise;
        }
        // `setTimeout(callback, 0)`: run once, after the current turn.
        // Every other browser call erases; this one is implemented,
        // because the frame conductor already has that boundary and the
        // corpus reaches `stopEngine` through it -- the freeze a physics
        // scene pins its measured pose with.
        if (this.context.isDeferredCallbackCall(call)) {
            return this.compileDeferredCallback(call);
        }
        const callee = this.context.unwrap(call.expression);
        if (ts.isPropertyAccessExpression(callee)) {
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
                receiver.kind === ts.SyntaxKind.ThisKeyword
            ) {
                const instance = ts.isIdentifier(receiver)
                    ? this.context.lookupOptional(receiver)
                    : this.context.activeThis();
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
        if (!ts.isIdentifier(callee)) {
            this.context.fail(callee, `Unsupported call target '${callee.getText()}'.`);
        }

        const bound = this.context.lookupOptional(callee);
        if (bound?.kind === "callback") {
            if (!bound.callbackDeclaration) {
                this.context.fail(
                    callee,
                    "Callback value is missing its declaration.",
                );
            }
            return this.context.userFunctions.compileCallbackCall(
                this.context,
                call,
                bound.callbackDeclaration,
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
}
