// Expression lowering: the value switch and its call dispatch.
//
// `compileValue` is the one door every value position goes through. It
// recognizes the expression's syntactic shape and hands each shape to
// the module that owns it -- data paths and constructors to the data
// lowerer, local classes to the class lowerer, property reads to the
// compiler's property path, and calls to `compileCall`, whose order
// (immediate promises, math and data methods, record and class
// methods, bound callbacks, registered intrinsics, native functions,
// user functions) is the resolution order a call site observes.
import ts from "typescript";
import type { ClassLowerer } from "./classes.js";
import type { DataLowerer } from "./data-lowering.js";
import type { NativeFunctionLowerer } from "./native-functions.js";
import {
    compileImmediatePromise,
    type PromiseLoweringContext,
} from "./promises.js";
import type { StaticEvaluator } from "./static-evaluator.js";
import type { CompilerSymbols } from "./symbols.js";
import type { Value } from "./types.js";
import type {
    UserFunctionContext,
    UserFunctionLowerer,
} from "./user-functions.js";

export interface ExpressionContext
    extends PromiseLoweringContext,
        UserFunctionContext {
    readonly evaluator: StaticEvaluator;
    readonly dataLowerer: DataLowerer;
    readonly classLowerer: ClassLowerer;
    readonly userFunctions: UserFunctionLowerer;
    readonly nativeFunctions: NativeFunctionLowerer;
    readonly symbols: CompilerSymbols;
    readonly variableScopes: ReadonlyArray<
        Map<ts.Symbol, { name: string; value: Value }>
    >;
    unwrap(expression: ts.Expression): ts.Expression;
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
    evaluateBrowserValue(
        expression: ts.Expression,
    ): Value["browserValue"] | undefined;
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
            return this.compileValue(
                this.context.evaluator.resolveNullish(unwrapped),
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
                return value;
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
            return this.compileCall(unwrapped);
        }
        if (ts.isConditionalExpression(unwrapped)) {
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
                const condition = this.context.compileCondition(
                    unwrapped.condition,
                );
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
                this.context.compileCondition(unwrapped.condition),
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
            const browserValue =
                this.context.evaluateBrowserValue(unwrapped);
            return {
                kind: "browser",
                cpp: "",
                ...(browserValue
                    ? { browserValue }
                    : {}),
            };
        }

        this.context.fail(unwrapped, `Unsupported value expression: ${ts.SyntaxKind[unwrapped.kind]}.`);
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
        const callee = this.context.unwrap(call.expression);
        if (ts.isPropertyAccessExpression(callee)) {
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
