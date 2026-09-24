// Variable declarations: `const`/`let` bindings with their initializers,
// typed data declarations, recursive and forward callback bindings, and
// array/object binding patterns, lowered into the scope stack's bindings.
import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import {
    forEachAnalysisNode,
    findAnalysisNodeWithState,
    someAnalysisNode,
} from "./analysis-walk.js";
import { isPrimitiveBrowserValue } from "./browser-erasure.js";
import { CompileError } from "./compile-error.js";
import { isNeverResized } from "./data-lowering.js";
import { isStoringDataCall, mutatingArrayMethods } from "./data-methods.js";
import {
    isOpaqueReference,
    isTypedArrayType,
    passesByReference,
    type DataType,
} from "./data-types.js";
import { isDeterministicRandomRead } from "./deterministic-random.js";
import { EmissionSet } from "./emission-transaction.js";
import { hasDynamicObjectSpread, isJsonValue } from "./json-bridge.js";
import { emitReachableStatements } from "./loop-control.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    captureDataFunctionBody,
    type NativeFunctionContext,
} from "./native-functions.js";
import { nativeReturnTsType } from "./native-return-type.js";
import {
    staticNumberValue,
    type PositiveIntegerContext,
} from "./option-helpers.js";
import { readProperty, type PropertyContext } from "./properties.js";
import { walkReachedLoopNodes } from "./resource-loops.js";
import { declaredSymbol, resolvedSymbol } from "./symbols.js";
import {
    argumentAt,
    assignmentTargets,
    isAssignmentExpression,
    isUpdateExpression,
} from "./syntax.js";
import {
    isCompileTimeOnlyValue,
    nativeDataMetadata,
    optionalPresentCpp,
    presenceFlagCpp,
    statedTruthinessCpp,
    valueForKind,
    withNativeMetadata,
    type Value,
    type ValueKind,
} from "./types.js";
import type { UiProjection } from "./ui-projection.js";
import {
    inferPromiseRejectStorage,
    inferUninitializedHandle,
} from "./uninitialized-handle.js";
import {
    aliasedMutationScan,
    isSupportedFunction,
    parameterIsMutated,
    parameterIsReadOnly,
    recursiveStorageEscapes,
    retainedNativeMutationTarget,
    tryResolveFunctionDeclaration,
    type AliasedMutationScan,
    type SupportedFunction,
} from "./user-functions.js";

/** What declaration lowering reads of the compiler. */
interface DeclarationContext
    extends
        NativeFunctionContext,
        PropertyContext,
        PositiveIntegerContext,
        Pick<
            LoweringServices,
            | "allocateTemporaryCppName"
            | "callbackIdentity"
            | "captureManagedClosureLines"
            | "compileCallbackWithValues"
            | "compileEngineCreation"
            | "compileStoredDataFunction"
            | "compileStringLiteral"
            | "constArrayLiteral"
            | "defaultEngine"
            | "emitDiscardedValue"
            | "emitNativeCallbackStorage"
            | "evaluator"
            | "handleCollections"
            | "isNativeHostUiLookup"
            | "moduleRelativeAssetUrl"
            | "nativeBindingCheckpoint"
            | "options"
            | "reachJson"
            | "renderSharedClosure"
            | "requireDefaultEngine"
            | "symbols"
            | "takeNativeTemporary"
            | "withRecordScopes"
        > {
    /** The engine the entry created, once it has. */
    readonly defaultEngineCpp: string | undefined;
    /** Declarations a storage demand retyped, by declaration. */
    readonly dynamicBindings: ReadonlyMap<
        ts.VariableDeclaration,
        DataType | undefined
    >;
    /** Callback bindings hoisted ahead of their declaration. */
    readonly hoistedCallbackBindings: Set<ts.Symbol>;
    /** Host-page element lookups awaiting the retained UI projection. */
    readonly pendingHostUiLookups: Value[];
    /** Module constants the static evaluator still folds. */
    readonly staticConstants: Map<ts.Symbol, ts.Expression>;
    readonly ui: Pick<UiProjection, "nativeHostUiTags">;
    callRetainsArgument(
        call: ts.CallExpression,
        index: number,
        includeFrameRegistrations: boolean,
    ): boolean;
    emitEscapingResolvePromise(
        declaration: ts.VariableDeclaration,
        cppName: string,
    ): boolean;
    hasStableNativeBinding(value: Value): boolean;
    importedCall(
        expression: ts.Expression,
        importedName: string,
    ): ts.CallExpression | undefined;
    isSharedClosureScalar(kind: string): boolean;
    mutableCapturedParameter(identifier: ts.Identifier, value: Value): boolean;
    needsSharedClosureStorage(
        declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
        binding?: ts.Identifier,
    ): boolean;
    nullableResourceKind(
        node: ts.Node,
        allowDirect?: boolean,
    ): { kind: ValueKind; cppType: string } | undefined;
    optionalResourceCpp(value: Value): string;
    unwrappedValueSymbol(expression: ts.Expression): ts.Symbol | undefined;
}

export class DeclarationLowerer {
    constructor(private readonly context: DeclarationContext) {}

    private initializerCapturesBinding(
        initializer: ts.Expression,
        symbol: ts.Symbol,
    ): boolean {
        const namesBinding = (node: ts.Node): boolean =>
            ts.isIdentifier(node) &&
            this.context.symbols.valueSymbol(node) === symbol;
        if (
            findAnalysisNodeWithState(
                initializer,
                false,
                (node, closure) => closure && namesBinding(node),
                (node, closure) => closure || ts.isFunctionLike(node),
            )
        )
            return true;
        return someAnalysisNode(
            initializer,
            (node) =>
                ts.isCallExpression(node) &&
                node.arguments.some((argument, index) => {
                    const value = this.context.unwrap(argument);
                    if (!ts.isIdentifier(value)) return false;
                    const callback = tryResolveFunctionDeclaration(
                        this.context.checker,
                        value,
                    );
                    return (
                        !!callback?.body &&
                        this.context.callRetainsArgument(node, index, true) &&
                        someAnalysisNode(callback.body, namesBinding)
                    );
                }),
        );
    }

    public emitVariableDeclaration(declaration: ts.VariableDeclaration): void {
        if (
            (ts.getCombinedModifierFlags(declaration) &
                ts.ModifierFlags.Ambient) !==
            0
        )
            return;
        if (
            !declaration.initializer &&
            declaration.type &&
            ts.isTypeReferenceNode(declaration.type) &&
            ts.isIdentifier(declaration.type.typeName) &&
            declaration.type.typeName.text === "GPUTexture" &&
            !declaredSymbol(this.context.checker, declaration.type.typeName)
                ?.declarations?.length &&
            ts.isIdentifier(declaration.name)
        ) {
            const cpp = this.context.bindings.cppIdentifier(
                declaration.name.text,
            );
            this.context.emit({
                kind: "declaration",
                type: "bbl::GpuTextureIdentity",
                name: cpp,
                initializer: "",
                initialization: "direct",
            });
            this.context.bindings.defineVariable(declaration.name, {
                kind: "gpu-texture",
                cpp,
                dataType: { kind: "handle", handle: "gpu-texture" },
                engineCpp: this.context.requireDefaultEngine(declaration),
            });
            return;
        }
        if (ts.isObjectBindingPattern(declaration.name)) {
            this.emitObjectBindingDeclaration(declaration);
            return;
        }
        if (ts.isArrayBindingPattern(declaration.name)) {
            this.emitArrayBindingDeclaration(declaration);
            return;
        }
        if (!ts.isIdentifier(declaration.name)) {
            this.context.fail(
                declaration.name,
                "Only identifier variable declarations are supported.",
            );
        }
        // An empty `Mesh[]` and the entity loop that fills it are one
        // construct — the recursive-visitor spelling of a container
        // flatten — so the pair is answered here, before the declaration
        // could become a runtime vector this port does not materialize.
        const flattened =
            this.context.handleCollections.assetRecursiveFlattenDeclaration(
                declaration,
            );
        if (flattened) {
            this.context.bindings.defineVariable(declaration.name, flattened);
            return;
        }
        const declarationSymbol = this.context.symbols.valueSymbol(
            declaration.name,
        );
        if (
            declarationSymbol &&
            this.context.hoistedCallbackBindings.has(declarationSymbol) &&
            this.context.bindings.lookupOptional(declaration.name)
        ) {
            this.context.hoistedCallbackBindings.delete(declarationSymbol);
            return;
        }
        const sourceName = declaration.name.text;
        const cppName = this.context.bindings.cppIdentifier(sourceName);
        if (
            this.context.options.workers &&
            declaration.initializer &&
            declarationSymbol &&
            !ts.isArrowFunction(declaration.initializer) &&
            !ts.isFunctionExpression(declaration.initializer) &&
            this.initializerCapturesBinding(
                declaration.initializer,
                declarationSymbol,
            )
        ) {
            const type =
                this.context.dataLowerer.dataTypeAt(declaration.name) ??
                this.context.dataTypes.fromCheckedObjectInitializer(
                    declaration.initializer,
                );
            if (!type)
                this.context.fail(
                    declaration,
                    "A binding captured by its initializer requires an owned data type.",
                );
            this.context.reachJsData();
            this.context.emit({
                kind: "declaration",
                type: "auto",
                name: cppName,
                initializer: `bbl::js::make_gc_shared<bbl::js::LexicalBinding<${this.context.dataTypes.cppType(type)}>>()`,
            });
            this.context.registerNativeBindingType(
                cppName,
                `std::shared_ptr<bbl::js::LexicalBinding<${this.context.dataTypes.cppType(type)}>>`,
            );
            this.context.bindings.defineVariable(declaration.name, {
                ...this.context.dataLowerer.leafValue(
                    `${cppName}->get()`,
                    type,
                ),
                sharedStorageCpp: cppName,
                nativeBinding: true,
            });
            this.context.staticConstants.delete(declarationSymbol);
            const value = this.context.compileValue(declaration.initializer);
            if (value.kind === "void" && value.abruptCompletion) {
                this.context.emitDiscardedValue(value);
                return;
            }
            const initializer =
                this.context.dataLowerer.compileKnownValueForSink(
                    value,
                    type,
                    declaration.initializer,
                );
            this.context.emit(`${cppName}->initialize(${initializer});`);
            return;
        }
        const sharedClosureStorage =
            this.context.needsSharedClosureStorage(declaration);
        if (!declaration.initializer) {
            if (
                declaration.parent === undefined ||
                !ts.isVariableDeclarationList(declaration.parent) ||
                (declaration.parent.flags & ts.NodeFlags.Const) !== 0
            ) {
                this.context.fail(
                    declaration,
                    `Constant '${sourceName}' requires an initializer.`,
                );
            }
            const resource = this.context.nullableResourceKind(
                declaration.name,
                true,
            );
            if (resource) {
                this.context.emit(
                    sharedClosureStorage
                        ? {
                              kind: "declaration",
                              type: `std::shared_ptr<std::optional<${resource.cppType}>>`,
                              name: cppName,
                              initializer: `bbl::js::make_gc_shared<std::optional<${resource.cppType}>>()`,
                          }
                        : {
                              kind: "declaration",
                              type: `std::optional<${resource.cppType}>`,
                              name: cppName,
                              initializer: "",
                              initialization: "default",
                              attributes: "[[maybe_unused]] ",
                          },
                );
                this.context.bindings.defineVariable(
                    declaration.name,
                    valueForKind(resource.kind, {
                        cpp: sharedClosureStorage
                            ? `(**${cppName})`
                            : `(*${cppName})`,
                        ...((resource.kind === "ui-element" ||
                            resource.kind === "pointer-drag") &&
                        this.context.defaultEngineCpp
                            ? { engineCpp: this.context.defaultEngineCpp }
                            : {}),
                        optionalFoundCpp: sharedClosureStorage
                            ? `${cppName}->has_value()`
                            : optionalPresentCpp(cppName),
                        ...(sharedClosureStorage
                            ? { sharedStorageCpp: cppName }
                            : {}),
                        optionalStorageCpp: sharedClosureStorage
                            ? `(*${cppName})`
                            : cppName,
                    }),
                );
                return;
            }
            let dataType = this.context.dataTypes.fromTsType(
                this.context.checker.getTypeAtLocation(declaration.name),
                declaration.name,
            );
            dataType ??= inferUninitializedHandle(
                declaration,
                this.context.checker,
                this.context.dataTypes,
            );
            dataType ??= inferPromiseRejectStorage(
                declaration,
                this.context.checker,
            );
            if (
                !dataType &&
                declaration.type?.kind === ts.SyntaxKind.UnknownKeyword
            ) {
                // A JSON.parse result is deliberately dynamic until the
                // source's own guards inspect it. `let json: unknown;` is the
                // corresponding uninitialized slot in that model; every later
                // assignment still has to be a JsonValue, so this does not
                // turn arbitrary unknown values into a permissive catch-all.
                dataType = { kind: "json" };
                this.context.reachJson();
            }
            if (!dataType) {
                // `let set;` -- no initializer and no native type: the
                // value is whatever the first assignment binds, and for a
                // compile-time record (a node-particle binding built inside
                // a `try`) nothing native exists to declare here. The
                // assignment decides; see `bindPendingLet`.
                this.context.bindings.defineVariable(declaration.name, {
                    kind: "pending-let",
                    cpp: "",
                });
                return;
            }
            if (dataType.kind === "borrowed-platform-event") {
                this.context.fail(
                    declaration,
                    `Variable '${sourceName}' cannot default-construct a borrowed DOM event; bind it from an active platform callback.`,
                );
            }
            if (
                dataType.kind !== "number" &&
                dataType.kind !== "boolean" &&
                dataType.kind !== "string"
            ) {
                this.context.reachJsData();
            }
            const cppType = this.context.dataTypes.cppType(dataType);
            this.context.emit(
                sharedClosureStorage
                    ? {
                          kind: "declaration",
                          type: "auto",
                          name: cppName,
                          initializer: `bbl::js::make_gc_shared<${cppType}>()`,
                      }
                    : {
                          kind: "declaration",
                          type: cppType,
                          name: cppName,
                          initializer: "",
                          initialization: "default",
                          attributes: "[[maybe_unused]] ",
                      },
            );
            const boundCpp = sharedClosureStorage ? `(*${cppName})` : cppName;
            if (dataType.kind !== "number" && dataType.kind !== "boolean") {
                this.context.dataLowerer.registerLocal(boundCpp, "owned");
            }
            this.context.bindings.defineVariable(declaration.name, {
                ...this.context.dataLowerer.leafValue(boundCpp, dataType),
                ...(sharedClosureStorage ? { sharedStorageCpp: cppName } : {}),
            });
            return;
        }

        if (
            declaration.parent !== undefined &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) === 0
        ) {
            const symbol = this.context.symbols.valueSymbol(declaration.name);
            if (symbol) {
                this.context.staticConstants.delete(symbol);
            }
        }
        if (
            declaration.type &&
            (ts.isArrowFunction(declaration.initializer) ||
                ts.isFunctionExpression(declaration.initializer)) &&
            this.emitAnnotatedDataDeclaration(
                declaration,
                cppName,
                sharedClosureStorage,
            )
        ) {
            return;
        }
        if (
            ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer)
        ) {
            this.emitRecursiveCallbackDeclaration(
                declaration.name,
                declaration.initializer,
                cppName,
            );
            return;
        }

        // A promise whose executor only escapes its own `resolve`, which
        // the scene later calls from a frame callback: a latch plus a
        // resolver, and an await that defers behind the latch.
        if (this.context.emitEscapingResolvePromise(declaration, cppName)) {
            return;
        }

        // `const original = Math.random`, which the corpus writes only to
        // put the generator back after a seeded window. It names the
        // function itself rather than a value, so it emits nothing and the
        // binding exists for the restore assignment to recognize.
        if (isDeterministicRandomRead(this.context, declaration.initializer)) {
            const native =
                this.context.sceneManifest.reachedNodeParticles.sets.some(
                    (set) => set.native,
                );
            if (native) {
                this.context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: cppName,
                    initializer: "bbl::js::random_function()",
                });
                this.context.bindings.defineVariable(declaration.name, {
                    kind: "callback",
                    cpp: cppName,
                    nativeCallbackParameterTypes: [],
                    nativeCallbackReturnType: { kind: "number" },
                });
            } else {
                this.context.bindings.defineVariable(declaration.name, {
                    kind: "js-random",
                    cpp: "",
                });
            }
            return;
        }

        const nullableResource = this.context.nullableResourceKind(
            declaration.name,
        );
        if (
            declaration.initializer.kind === ts.SyntaxKind.NullKeyword &&
            nullableResource
        ) {
            this.context.emit(
                sharedClosureStorage
                    ? {
                          kind: "declaration",
                          type: `std::shared_ptr<std::optional<${nullableResource.cppType}>>`,
                          name: cppName,
                          initializer: `bbl::js::make_gc_shared<std::optional<${nullableResource.cppType}>>()`,
                      }
                    : {
                          kind: "declaration",
                          type: `std::optional<${nullableResource.cppType}>`,
                          name: cppName,
                          initializer: "",
                          initialization: "default",
                          attributes: "[[maybe_unused]] ",
                      },
            );
            this.context.bindings.defineVariable(
                declaration.name,
                valueForKind(nullableResource.kind, {
                    cpp: sharedClosureStorage
                        ? `(**${cppName})`
                        : `(*${cppName})`,
                    ...((nullableResource.kind === "ui-element" ||
                        nullableResource.kind === "pointer-drag") &&
                    this.context.defaultEngineCpp
                        ? { engineCpp: this.context.defaultEngineCpp }
                        : {}),
                    optionalFoundCpp: sharedClosureStorage
                        ? `${cppName}->has_value()`
                        : optionalPresentCpp(cppName),
                    ...(sharedClosureStorage
                        ? { sharedStorageCpp: cppName }
                        : {}),
                    optionalStorageCpp: sharedClosureStorage
                        ? `(*${cppName})`
                        : cppName,
                }),
            );
            return;
        }

        const hostLookup = this.context.unwrap(declaration.initializer);
        const hostLookupCallee = ts.isCallExpression(hostLookup)
            ? this.context.unwrap(hostLookup.expression)
            : undefined;
        if (
            !this.context.defaultEngineCpp &&
            !this.context.options.workers &&
            ts.isCallExpression(hostLookup) &&
            hostLookupCallee &&
            ts.isPropertyAccessExpression(hostLookupCallee) &&
            hostLookupCallee.name.text === "getElementById" &&
            this.context.isNativeHostUiLookup(hostLookup)
        ) {
            const id = this.context.compileStringLiteral(
                argumentAt(hostLookup, 0),
            );
            const value: Value = {
                kind: "ui-element",
                cpp: cppName,
                uiHostId: id,
                uiTag: this.context.ui.nativeHostUiTags().get(id)!,
                truthinessCpp: "true",
            };
            this.context.pendingHostUiLookups.push(value);
            this.context.bindings.defineVariable(declaration.name, value);
            return;
        }

        if (
            this.context.browserErasure.isBrowserOnlyExpression(
                declaration.initializer,
            ) &&
            this.context.moduleRelativeAssetUrl(declaration.initializer) ===
                undefined
        ) {
            const browserValue =
                this.context.browserErasure.evaluateBrowserValue(
                    declaration.initializer,
                );
            if (!(
                browserValue &&
                isPrimitiveBrowserValue(browserValue) &&
                this.context.identifierIsRebound(declaration.name)
            )) {
                this.context.bindings.defineVariable(declaration.name, {
                    kind: "browser",
                    cpp: "",
                    ...(browserValue ? { browserValue } : {}),
                });
                return;
            }
        }

        const engineCall = this.context.importedCall(
            declaration.initializer,
            "createEngine",
        );
        if (engineCall && !this.context.options.workers) {
            const engine = this.context.compileEngineCreation(
                engineCall,
                cppName,
            );
            this.context.bindings.defineVariable(declaration.name, engine);
            return;
        }

        if (
            this.emitAnnotatedDataDeclaration(
                declaration,
                cppName,
                sharedClosureStorage,
            )
        ) {
            return;
        }

        const forwardCallback = this.prepareForwardFunctionResult(
            declaration,
            cppName,
        );
        const initializerBoundary = this.context.nativeBindingCheckpoint();
        let value = this.context.compileValue(declaration.initializer);
        if (
            value.kind === "number" &&
            value.staticNumber === undefined &&
            ts.isVariableDeclarationList(declaration.parent) &&
            ts.isVariableStatement(declaration.parent.parent) &&
            ts.isSourceFile(declaration.parent.parent.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0
        ) {
            // Materialized modules cannot revisit their initializers. Keep a
            // proven numeric snapshot on the immutable binding itself. Local
            // loop facts remain owned by the existing specialization analysis.
            const numeric = this.context.evaluator.staticNumberValue(
                declaration.initializer,
            );
            if (numeric !== undefined)
                value = { ...value, staticNumber: numeric };
        }
        if (value.kind === "promise") {
            const type = this.context.dataLowerer.dataTypeAt(declaration.name);
            if (type?.kind === "promise") {
                const expected = type.result
                    ? this.context.dataTypes.cppType(type.result)
                    : "bbl::js::PromiseVoid";
                const rebound = this.context.identifierIsRebound(
                    declaration.name,
                );
                if (expected === value.promiseType) {
                    const runtime = this.context.dataValue(value.cpp, type);
                    value =
                        rebound && runtime.kind === "promise"
                            ? { ...value, ...runtime }
                            : { ...value, dataType: type };
                } else if (rebound) {
                    this.context.fail(
                        declaration,
                        "Promise rebinding requires the declared result representation.",
                    );
                }
            }
        }
        value = this.context.bindings.bindSceneNodeVector(value);
        value = this.context.bindings.bindCameraVector(value);
        if (forwardCallback) {
            this.completeForwardFunctionResult(
                declaration,
                forwardCallback,
                value,
            );
            return;
        }
        value =
            this.context.bindings.referenceRecordValue(
                value,
                declaration.initializer,
            ) ?? value;
        if (nullableResource && value.kind === nullableResource.kind) {
            // Copy nullable resource STORAGE, not its present-value spelling.
            // A bound nullable resource exposes `(*storage)` for code that a
            // source guard has narrowed, but `const current = context` must
            // preserve an empty `context` as an empty `current`. Dereferencing
            // here engaged the copy with an indeterminate handle before the
            // copied source guard could run.
            //
            // A handle a search produced carries its presence beside it
            // (`optionalFoundCpp`): `const found = meshes.find(...)` is
            // empty when nothing matched, and copying the bare handle would
            // hand a later guard an indeterminate one -- the pin's
            // `undefined` -- as present.
            const initializerCpp = this.context.takeNativeTemporary(
                value.optionalStorageCpp ??
                    this.context.optionalResourceCpp(value),
                initializerBoundary,
            );
            this.context.emit(
                sharedClosureStorage
                    ? {
                          kind: "declaration",
                          type: `std::shared_ptr<std::optional<${nullableResource.cppType}>>`,
                          name: cppName,
                          initializer: `bbl::js::make_gc_shared<std::optional<${nullableResource.cppType}>>(${initializerCpp})`,
                      }
                    : {
                          kind: "declaration",
                          type: `std::optional<${nullableResource.cppType}>`,
                          name: cppName,
                          initializer: initializerCpp,
                          attributes: "[[maybe_unused]] ",
                      },
            );
            this.context.bindings.defineVariable(declaration.name, {
                ...value,
                cpp: sharedClosureStorage ? `(**${cppName})` : `(*${cppName})`,
                optionalFoundCpp: sharedClosureStorage
                    ? `${cppName}->has_value()`
                    : optionalPresentCpp(cppName),
                ...(sharedClosureStorage ? { sharedStorageCpp: cppName } : {}),
                optionalStorageCpp: sharedClosureStorage
                    ? `(*${cppName})`
                    : cppName,
            });
            return;
        }
        if (
            value.impure ||
            this.expressionHasObservableEvaluation(declaration.initializer)
        ) {
            // A `const` bound to a clock is a snapshot of it, so later
            // uses must read the native local rather than fold back to
            // the initializer and call the clock again. Same removal a
            // `let` declaration takes above, for the same reason: the
            // initializer stops being the value.
            const symbol = this.context.symbols.valueSymbol(declaration.name);
            if (symbol) {
                this.context.staticConstants.delete(symbol);
            }
        }
        if (
            value.kind === "node-particle-2d-binding" ||
            value.kind === "node-particle-2d-bridge" ||
            value.kind === "executed-url"
        ) {
            // Nothing native to bind: the registrar already ran, and the
            // binding exists so instrumentation can report it -- or, for a
            // live one, so its bridges can be named. A URL the bake driver
            // produces is likewise a generation-time name.
            this.context.bindings.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "browser") {
            // A local helper can erase its DOM body statement by statement
            // and return a browser handle. The call itself is not necessarily
            // recognizable as browser-only before inlining, but its resulting
            // binding is still a valid erased browser value.
            this.context.bindings.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "engine") {
            // createEngine already emitted the owning engine. A helper's
            // return value or an alias names that same identity; copying it
            // would separate the scene registry from callbacks retaining it.
            if (this.context.identifierIsRebound(declaration.name)) {
                this.context.fail(
                    declaration,
                    "Reassigning an engine alias is not supported.",
                );
            }
            this.context.bindings.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "void") {
            this.context.fail(
                declaration.initializer,
                `Expression assigned to '${sourceName}' does not produce a native value.`,
            );
        }
        if (value.kind === "callback" || isCompileTimeOnlyValue(value.kind)) {
            this.context.bindings.defineVariable(declaration.name, value);
            if (value.kind === "record")
                this.materializeAssignedRecordMethods(declaration.name, value);
            return;
        }
        if (value.kind === "data") {
            const symbol = this.context.symbols.valueSymbol(declaration.name);
            if (symbol) this.context.staticConstants.delete(symbol);
            const narrowed = this.context.dataLowerer.narrowForDeclaration(
                value,
                declaration.name,
            );
            if (!narrowed.dataType) {
                this.context.fail(
                    declaration.initializer,
                    `Data expression is missing its type (${narrowed.cpp}).`,
                );
            }
            if (
                narrowed.dataType.kind === "optional" &&
                narrowed.dataType.inner.kind === "struct" &&
                narrowed.objectIdentityCpp !== undefined
            ) {
                this.context.emit({
                    kind: "declaration",
                    type: "auto*",
                    name: cppName,
                    initializer: narrowed.objectIdentityCpp,
                });
                this.context.dataLowerer.registerAlias(
                    cppName,
                    narrowed.objectIdentityCpp,
                );
                this.context.bindings.defineVariable(declaration.name, {
                    ...nativeDataMetadata(narrowed),
                    kind: "data",
                    cpp: cppName,
                    optionalFoundCpp: `${cppName} != nullptr`,
                    objectIdentityCpp: cppName,
                });
                return;
            }
            const initializer = this.context.unwrap(declaration.initializer);
            const constructs =
                ts.isCallExpression(initializer) ||
                ts.isNewExpression(initializer) ||
                ts.isObjectLiteralExpression(initializer) ||
                ts.isArrayLiteralExpression(initializer);
            // A const local bound to a composite value or to a composite
            // element/member aliases the same JavaScript object. Most JS
            // runtime wrappers preserve that identity when copied; the
            // remaining value-backed native representations need a C++
            // reference. `let` keeps a copy because its binding can be
            // reseated.
            const aliases =
                !constructs &&
                declaration.parent !== undefined &&
                ts.isVariableDeclarationList(declaration.parent) &&
                (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
                passesByReference(this.context.dataTypes, narrowed.dataType) &&
                !narrowed.freshData &&
                (ts.isIdentifier(initializer) ||
                    ts.isElementAccessExpression(initializer) ||
                    ts.isPropertyAccessExpression(initializer)) &&
                // A value read out of a span is const, so it cannot be
                // bound by reference; the source language would not let
                // it be written through either.
                !narrowed.readOnly;
            const wrapperCopiesIdentity =
                isOpaqueReference(narrowed.dataType) ||
                narrowed.dataType.kind === "tuple" ||
                narrowed.dataType.kind === "product" ||
                narrowed.dataType.kind === "vector" ||
                narrowed.dataType.kind === "map" ||
                narrowed.dataType.kind === "set" ||
                narrowed.dataType.kind === "arraybuffer" ||
                narrowed.dataType.kind === "dataview" ||
                narrowed.dataType.kind === "bufferview" ||
                narrowed.dataType.kind === "numberindex" ||
                narrowed.dataType.kind === "json" ||
                narrowed.dataType.kind === "optional" ||
                narrowed.dataType.kind === "union" ||
                narrowed.dataType.kind === "iterator" ||
                narrowed.dataType.kind === "enummap" ||
                isTypedArrayType(narrowed.dataType);
            // These copies own their references; another wrapper's resize or
            // rebind cannot invalidate them like an interior C++ reference.
            const ownsSharedStorage =
                wrapperCopiesIdentity &&
                !narrowed.borrowedData &&
                !narrowed.nativeVectorData;
            const narrowedFound = presenceFlagCpp(narrowed);
            const optionalFoundCpp =
                narrowedFound === undefined
                    ? undefined
                    : this.context.allocateTemporaryCppName("element_found");
            const referenceStruct =
                narrowed.dataType.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(
                    narrowed.dataType.name,
                );
            const stableOwnerAlias =
                (wrapperCopiesIdentity ||
                    referenceStruct ||
                    narrowed.dataType.kind === "string") &&
                this.borrowsConstBinding(declaration, narrowed);
            if (optionalFoundCpp && !referenceStruct) {
                // A JavaScript local captures whether the element existed
                // when its initializer ran. Keep that snapshot separate
                // from the safe default object used to avoid an invalid
                // native read on the missing path.
                this.context.emit({
                    kind: "declaration",
                    type: "const bool",
                    name: optionalFoundCpp,
                    initializer: narrowedFound!,
                    attributes: "[[maybe_unused]] ",
                });
            }
            const localType = narrowed.nativeVectorData
                ? "auto"
                : this.context.dataTypes.cppType(narrowed.dataType);
            const sharedDataBinding =
                sharedClosureStorage &&
                this.context.identifierIsRebound(declaration.name);
            const boundCpp = sharedDataBinding ? `(*${cppName})` : cppName;
            const selectedCpp = narrowed.ownedCpp ?? narrowed.cpp;
            const transferredCpp = narrowed.borrowedData
                ? selectedCpp
                : selectedCpp === narrowed.cpp
                  ? this.context.takeNativeTemporary(
                        selectedCpp,
                        initializerBoundary,
                    )
                  : selectedCpp;
            let initializerCpp = transferredCpp;
            if (
                !stableOwnerAlias &&
                !narrowed.borrowedData &&
                narrowed.ownedCpp === undefined &&
                transferredCpp === selectedCpp &&
                (narrowed.nativeLvalue ||
                    cppIdentifierPattern.test(selectedCpp)) &&
                (wrapperCopiesIdentity || referenceStruct)
            ) {
                this.context.reachJsData();
                initializerCpp = `bbl::js::snapshot_value(${selectedCpp})`;
            }
            this.context.emit({
                kind: "declaration",
                name: cppName,
                type: sharedDataBinding
                    ? "auto"
                    : stableOwnerAlias && narrowed.dataType.kind === "string"
                      ? "auto&"
                      : `${localType}${stableOwnerAlias || (aliases && !wrapperCopiesIdentity) || narrowed.borrowedData ? "&" : ""}`,
                initializer: sharedDataBinding
                    ? `bbl::js::make_gc_shared<${localType}>(${initializerCpp})`
                    : initializerCpp,
                attributes: "[[maybe_unused]] ",
            });
            if (optionalFoundCpp && referenceStruct) {
                // Reference-backed records already use an empty shared
                // pointer as their safe missing value. Test the stored local
                // instead of repeating a conditional initializer (and all
                // branch preparation it may contain) just to learn whether
                // the result exists.
                this.context.emit({
                    kind: "declaration",
                    type: "const bool",
                    name: optionalFoundCpp,
                    initializer: `static_cast<bool>(${boundCpp})`,
                    attributes: "[[maybe_unused]] ",
                });
            }
            if (aliases && !ownsSharedStorage) {
                this.context.dataLowerer.registerAlias(cppName, narrowed.cpp);
            } else {
                this.context.dataLowerer.registerLocal(
                    boundCpp,
                    constructs ||
                        referenceStruct ||
                        narrowed.freshData ||
                        ownsSharedStorage
                        ? "owned"
                        : "copy",
                );
            }
            const staticElementsOwner =
                aliases && narrowed.staticElements
                    ? (narrowed.staticElementsOwner ?? narrowed)
                    : undefined;
            const optionalHandle =
                narrowed.dataType.kind === "optional" &&
                narrowed.dataType.inner.kind === "handle"
                    ? this.context.dataLowerer.leafValue(
                          `(*${boundCpp})`,
                          narrowed.dataType.inner,
                      )
                    : undefined;
            this.context.bindings.defineVariable(
                declaration.name,
                valueForKind(optionalHandle?.kind ?? "data", {
                    ...(optionalHandle ??
                        (narrowed.dataType.kind === "error"
                            ? this.context.dataLowerer.leafValue(
                                  boundCpp,
                                  narrowed.dataType,
                              )
                            : {
                                  kind: "data" as const,
                                  cpp: boundCpp,
                                  dataType: narrowed.dataType,
                              })),
                    ...(sharedDataBinding ? { sharedStorageCpp: cppName } : {}),
                    ...(staticElementsOwner
                        ? {
                              staticElements:
                                  staticElementsOwner.staticElements ??
                                  narrowed.staticElements,
                              staticElementsOwner,
                          }
                        : {}),
                    ...(!narrowed.freshData && narrowed.collectionCardinality
                        ? {
                              collectionCardinality:
                                  narrowed.collectionCardinality,
                          }
                        : {}),
                    ...(!narrowed.freshData && narrowed.runtimeElementTemplate
                        ? {
                              runtimeElementTemplate:
                                  narrowed.runtimeElementTemplate,
                          }
                        : {}),
                    ...(narrowed.recordProperties &&
                    narrowed.dataType.kind !== "error"
                        ? {
                              recordProperties: narrowed.recordProperties,
                          }
                        : {}),
                    ...(narrowed.borrowedData
                        ? { borrowedData: true as const }
                        : {}),
                    ...(narrowed.nativeVectorData
                        ? { nativeVectorData: true as const }
                        : {}),
                    ...(narrowed.preserveUncheckedLookup
                        ? { preserveUncheckedLookup: true as const }
                        : {}),
                    ...(optionalHandle
                        ? {
                              optionalStorageCpp: boundCpp,
                              optionalFoundCpp: optionalPresentCpp(boundCpp),
                              truthinessCpp: optionalPresentCpp(boundCpp),
                          }
                        : optionalFoundCpp
                          ? { optionalFoundCpp }
                          : {}),
                    ...(statedTruthinessCpp(narrowed)
                        ? {
                              truthinessCpp: statedTruthinessCpp(
                                  narrowed,
                              )!.replaceAll(narrowed.cpp, boundCpp),
                          }
                        : {}),
                }),
            );
            return;
        }

        const nativeType =
            value.kind === "platform-keyboard-event" ||
            value.kind === "platform-mouse-event"
                ? "const auto&"
                : value.kind === "number"
                  ? "double"
                  : value.kind === "boolean"
                    ? "bool"
                    : value.kind === "string"
                      ? "std::string"
                      : value.kind === "promise"
                        ? `bbl::js::Promise<${value.promiseType}>`
                        : value.dataType?.kind === "enum"
                          ? this.context.dataTypes.cppType(value.dataType)
                          : "auto";
        // compileValue already emits a JS number at double precision.
        // Compiling the initializer again is observably wrong for calls and
        // other expressions that materialize temporaries.
        let initializerCpp =
            value.ownedCpp ??
            this.context.takeNativeTemporary(value.cpp, initializerBoundary);
        const stableOwnerAlias = this.borrowsConstBinding(declaration, value);
        if (
            !stableOwnerAlias &&
            initializerCpp === value.cpp &&
            (value.nativeLvalue || cppIdentifierPattern.test(value.cpp)) &&
            ![
                "number",
                "boolean",
                "string",
                "engine",
                "scene",
                "platform-keyboard-event",
                "platform-mouse-event",
            ].includes(value.kind)
        ) {
            this.context.reachJsData();
            initializerCpp = `bbl::js::snapshot_value(${value.ownedCpp ?? value.cpp})`;
        }
        const sharedPrimitive =
            sharedClosureStorage &&
            this.context.isSharedClosureScalar(
                value.dataType?.kind === "enum" ? "enum" : value.kind,
            );
        const boundCpp = sharedPrimitive ? `(*${cppName})` : cppName;
        const valueFound = presenceFlagCpp(value);
        const optionalFoundCpp =
            valueFound === undefined ||
            valueFound === "true" ||
            valueFound === "false"
                ? undefined
                : this.context.allocateTemporaryCppName("element_found");
        // Source bindings can be consumed entirely through generation metadata.
        this.context.emit({
            kind: "declaration",
            name: cppName,
            type: sharedPrimitive
                ? "auto"
                : stableOwnerAlias
                  ? "auto&"
                  : nativeType,
            initializer: sharedPrimitive
                ? `bbl::js::make_gc_shared<${nativeType}>(${initializerCpp})`
                : initializerCpp,
            attributes: "[[maybe_unused]] ",
        });
        if (optionalFoundCpp) {
            // A local initialized from any maybe-absent handle snapshots both
            // the handle and whether it was present. Derive presence from the
            // bound handle where possible rather than re-reading an owner
            // whose slot may move later.
            const presence =
                value.cpp.length > 0
                    ? valueFound!.replaceAll(value.cpp, boundCpp)
                    : valueFound!;
            this.context.emit({
                kind: "declaration",
                type: "const bool",
                name: optionalFoundCpp,
                initializer: presence,
                attributes: "[[maybe_unused]] ",
            });
        }
        // Either spelling reads through the emitted variable, so a static
        // value the initializer carried must not fold past it.
        const stored: Value = {
            ...value,
            cpp: boundCpp,
            ...(sharedClosureStorage ? { sharedStorageCpp: cppName } : {}),
            ...(optionalFoundCpp ? { optionalFoundCpp } : {}),
            nativeBinding: true,
        };
        if (!sharedClosureStorage) delete stored.sharedStorageCpp;
        if (stored.kind === "audio-engine" && stored.audioMainBusCpp) {
            stored.audioMainBusCpp = this.context.takeNativeTemporary(
                stored.audioMainBusCpp,
                initializerBoundary,
            );
        }
        if (value.kind === "animation-clip") {
            stored.animationFrameRate = `${cppName}.frame_rate`;
            stored.animationDuration = `${cppName}.duration`;
        }
        if (
            declaration.parent !== undefined &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) === 0
        ) {
            // Mutable locals must never fold to their initial value:
            // later reads reference the native local, not the constant
            // the declaration happened to start from.
            delete stored.staticNumber;
            delete stored.staticString;
            delete stored.staticBoolean;
        }
        this.context.bindings.defineVariable(declaration.name, stored);
    }

    private borrowsConstBinding(
        declaration: ts.VariableDeclaration,
        value: Value,
    ): boolean {
        return (
            this.context.bindings.isImmutableVariable(declaration) &&
            this.context.hasStableNativeBinding(value)
        );
    }

    /** Mutable methods need a shared slot before callbacks can retain their owner. */
    private materializeAssignedRecordMethods(
        name: ts.Identifier,
        owner: Value,
    ): void {
        const initializers: Array<() => void> = [];
        const callbacks = new Map(
            Object.entries(owner.recordProperties ?? {}).filter(
                ([, value]) => value.kind === "callback",
            ),
        );
        for (const [key, method] of Object.entries(owner.recordMethods ?? {}))
            callbacks.set(key, {
                kind: "callback",
                cpp: "",
                callbackDeclaration: method,
                callbackRecordOwner: owner,
            });
        if (callbacks.size === 0) return;
        const assigned = new Set<string>();
        aliasedMutationScan(
            name,
            (identifier) => this.context.symbols.valueSymbol(identifier),
            {
                aliasingInitializer: (expression, scan) => {
                    const unwrapped = this.context.unwrap(expression);
                    return (
                        ts.isIdentifier(unwrapped) && scan.namesAlias(unwrapped)
                    );
                },
                mutates: (node, scan) => {
                    if (
                        isAssignmentExpression(node) &&
                        ts.isPropertyAccessExpression(node.left) &&
                        callbacks.has(node.left.name.text) &&
                        scan.namesAlias(node.left.expression)
                    )
                        assigned.add(node.left.name.text);
                    return assigned.size === callbacks.size;
                },
            },
        );
        const ownerType = this.context.checker.getTypeAtLocation(name);
        for (const key of assigned) {
            const callback = callbacks.get(key)!;
            const site = callback.callbackDeclaration ?? name;
            const parameters = callback.nativeCallbackParameterTypes;
            const property = ownerType.getProperty(key);
            const declaredType =
                property &&
                this.context.dataTypes.fromTsType(
                    this.context.checker.getTypeOfSymbolAtLocation(
                        property,
                        name,
                    ),
                    name,
                );
            const type: DataType | undefined =
                declaredType?.kind === "function"
                    ? declaredType
                    : parameters?.every(
                            (parameter): parameter is DataType =>
                                parameter !== undefined,
                        )
                      ? {
                            kind: "function",
                            parameters: [...parameters],
                            ...(callback.nativeCallbackReturnType
                                ? { result: callback.nativeCallbackReturnType }
                                : {}),
                        }
                      : this.context.dataLowerer.dataTypeAt(site);
            if (type?.kind !== "function")
                this.context.fail(
                    site,
                    "A mutable record method requires a concrete native function signature.",
                );
            const slot = this.context.allocateTemporaryCppName(
                `record_method_${key}`,
            );
            this.context.emit({
                kind: "declaration",
                type: "auto",
                name: slot,
                initializer: `bbl::js::make_gc_shared<${this.context.dataTypes.cppType(type)}>()`,
            });
            const capture = this.context.registerNativeBinding(slot);
            owner.recordProperties ??= {};
            owner.recordProperties[key] = {
                ...this.context.dataLowerer.leafValue(`(*${slot})`, type),
                nativeLvalue: true,
                sharedStorageCpp: slot,
                nativeCaptures: [capture],
            };
            if (owner.recordMethods) delete owner.recordMethods[key];
            initializers.push(() =>
                this.context.emit(
                    `(*${slot}) = ${this.context.dataLowerer.compileKnownValueForSink(callback, type, site)};`,
                ),
            );
        }
        for (const initialize of initializers) initialize();
    }

    /**
     * Materializes a function returned by a call before compiling that call.
     *
     * JavaScript can pass a closure into a builder which calls a function
     * declaration that, in turn, closes over the builder's returned function:
     *
     *     const update = build(value => apply(value, update));
     *
     * The returned binding exists by the time an event can invoke the closure,
     * but eager specialization reaches `update` while its initializer is still
     * being lowered. A native function slot gives that forward edge a concrete
     * identity; after the builder returns, the slot is filled with the normal
     * specialized callback body.
     */
    private prepareForwardFunctionResult(
        declaration: ts.VariableDeclaration,
        cppName: string,
    ):
        | {
              parameterTypes: readonly DataType[];
              parameterNames: readonly string[];
              storageCpp: string;
          }
        | undefined {
        const name = declaration.name;
        if (!ts.isIdentifier(name)) return undefined;

        if (!declaration.initializer) return undefined;
        const initializer = this.context.unwrap(declaration.initializer);
        if (!ts.isCallExpression(initializer)) return undefined;
        if (
            this.context.importedCall(initializer, "onCsmReceiverUpdate") ||
            this.context.importedCall(
                initializer,
                "enableSurfaceResizeObserver",
            )
        ) {
            // The shadow intrinsic materializes and registers its native
            // disposer directly. It is already a callable value, not a
            // source callback declaration returned by an inlined builder.
            return undefined;
        }
        const signatures = this.context.checker
            .getTypeAtLocation(name)
            .getCallSignatures();
        if (signatures.length !== 1) return undefined;
        const signature = signatures[0]!;
        const returnType =
            this.context.checker.getReturnTypeOfSignature(signature);
        if ((returnType.flags & ts.TypeFlags.Void) === 0) return undefined;
        const parameterTypes: DataType[] = [];
        const parameterNames: string[] = [];
        for (const [index, parameter] of signature.getParameters().entries()) {
            const site = parameter.valueDeclaration ?? name;
            if (
                parameter.valueDeclaration &&
                ts.isParameter(parameter.valueDeclaration) &&
                parameter.valueDeclaration.dotDotDotToken
            ) {
                return undefined;
            }
            const type = this.context.dataTypes.fromTsType(
                this.context.checker.getTypeOfSymbolAtLocation(parameter, site),
                site,
            );
            if (
                !type ||
                type.kind === "function" ||
                this.context.dataTypes.carriesHandle(type)
            ) {
                return undefined;
            }
            parameterTypes.push(type);
            parameterNames.push(
                this.context.allocateTemporaryCppName(
                    `forward_callback_arg_${index}`,
                ),
            );
        }
        this.context.reachJsData();
        const parameterCpp = parameterTypes.map((type) =>
            this.context.dataTypes.cppType(type),
        );
        const storage = this.context.emitNativeCallbackStorage(
            cppName,
            `void(${parameterCpp.join(", ")})`,
            // The slot exists because a closure handed to the builder
            // references it, and that closure's whole purpose is to run
            // when an event fires after the builder returned -- the
            // forward edge always escapes.
            true,
        );
        const storageCpp = storage.cpp;
        this.context.bindings.defineVariable(name, {
            ...storage,
            nativeCallbackParameterTypes: parameterTypes,
        });
        return { parameterTypes, parameterNames, storageCpp };
    }

    /** Fills the native slot opened by prepareForwardFunctionResult. */
    private completeForwardFunctionResult(
        declaration: ts.VariableDeclaration,
        forward: {
            parameterTypes: readonly DataType[];
            parameterNames: readonly string[];
            storageCpp: string;
        },
        value: Value,
    ): void {
        const name = declaration.name;
        if (!ts.isIdentifier(name))
            this.context.fail(name, "Function bindings require an identifier.");

        if (
            value.kind === "data" &&
            value.dataType?.kind === "function" &&
            value.cpp.length > 0
        ) {
            // A function stored in a plain-data record (for example an
            // observer method returning its unsubscribe closure) is already
            // a native std::function. Fill the forward slot from that value;
            // there is no source declaration left to specialize again.
            this.context.emit(`${forward.storageCpp} = ${value.cpp};`);
            this.context.bindings.rebindVariable(name, {
                kind: "callback",
                cpp: forward.storageCpp,
                nativeCallbackParameterTypes: forward.parameterTypes,
            });
            return;
        }
        if (value.kind !== "callback" || !value.callbackDeclaration) {
            this.context.fail(
                declaration.initializer!,
                "Function-valued call initializer did not return a supported callback " +
                    `(received ${value.kind}, native=${value.cpp.length > 0}, ` +
                    `declaration=${value.callbackDeclaration !== undefined}, ` +
                    `data=${JSON.stringify(value.dataType)}).`,
            );
        }
        const arguments_ = forward.parameterTypes.map((type, index) =>
            this.context.dataValue(forward.parameterNames[index]!, type),
        );
        const compiled = this.context.captureManagedClosureLines(() => {
            for (const name of forward.parameterNames)
                this.context.registerNativeBinding(name);
            const compile = () =>
                this.context.compileCallbackWithValues(
                    value.callbackDeclaration!,
                    arguments_,
                    declaration.initializer!,
                );
            const result = value.callbackRecordOwner
                ? this.context.withRecordScopes(
                      value.callbackRecordOwner,
                      compile,
                  )
                : compile();
            this.context.emitDiscardedValue(result);
        });
        const parameters = forward.parameterTypes.map(
            (type, index) =>
                `${this.context.dataTypes.cppType(type)} ${forward.parameterNames[index]}`,
        );
        this.context.emit(
            `${forward.storageCpp} = ${this.context.renderSharedClosure(compiled, "void", value.callbackDeclaration, parameters.join(", "), forward.parameterNames)};`,
        );
        this.context.bindings.rebindVariable(name, {
            kind: "callback",
            cpp: forward.storageCpp,
            nativeCallbackParameterTypes: forward.parameterTypes,
            platformCallbackIdentity: this.context.callbackIdentity(
                value.callbackDeclaration,
                value.callbackRecordOwner,
            ),
        });
    }

    /**
     * Whether re-expanding a scalar initializer could evaluate source work a
     * second time. Calls are conservatively snapshots: even a currently pure
     * helper can close over mutable state, and JavaScript evaluates it once at
     * the declaration rather than again at every numeric sink.
     */
    private expressionHasObservableEvaluation(node: ts.Node): boolean {
        let found = false;
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (candidate) => {
                if (found) return "skip";
                if (
                    ts.isCallExpression(candidate) ||
                    ts.isNewExpression(candidate) ||
                    ts.isAwaitExpression(candidate) ||
                    ts.isTaggedTemplateExpression(candidate)
                ) {
                    found = true;
                    return "skip";
                }
            });
        visit(node);
        return found;
    }

    /** Emits a self-recursive local data callback as a capturing C++ lambda. */
    private emitRecursiveCallbackDeclaration(
        name: ts.Identifier,
        callback: ts.ArrowFunction | ts.FunctionExpression,
        cppName: string,
    ): void {
        const symbol = this.context.symbols.valueSymbol(name);
        if (!symbol) return;
        let recursive = false;
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (recursive) return "skip";
                if (
                    this.context.options.workers &&
                    ts.isIdentifier(node) &&
                    this.context.symbols.valueSymbol(node) === symbol
                ) {
                    recursive = true;
                    return "skip";
                }
                if (
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    this.context.symbols.valueSymbol(node.expression) === symbol
                ) {
                    recursive = true;
                    return "skip";
                }
                if (
                    !this.context.options.workers &&
                    node !== callback &&
                    ts.isFunctionLike(node)
                ) {
                    return "skip";
                }
            });
        visit(callback.body);
        if (!recursive) {
            // Keep the declaration's lexical owner when a nested callback
            // later reads it for invocation or listener removal.
            const value = this.context.compileValue(callback);
            if (value.kind !== "callback")
                this.context.fail(
                    callback,
                    "A function declaration requires a callback value.",
                );
            if (value.callbackRecordOwner?.repeatedCallbackEvaluation) {
                this.context.reachJsData();
                const identity =
                    this.context.allocateTemporaryCppName("callback_identity");
                this.context.emit(
                    `[[maybe_unused]] const auto ${identity} = bbl::js::next_callback_identity();`,
                );
                this.context.registerNativeBinding(
                    identity,
                    false,
                    false,
                    "const std::size_t",
                );
                value.callbackRecordOwner.runtimeCallbackIdentityCpp = identity;
            }
            this.context.bindings.defineVariable(name, {
                ...value,
                callbackDeclaration: name,
            });
            return;
        }
        if (
            this.context.options.workers &&
            ts
                .getModifiers(callback)
                ?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
                )
        ) {
            const type = this.context.dataTypes.fromTsType(
                this.context.checker.getTypeAtLocation(callback),
                callback,
            );
            if (type?.kind !== "function")
                this.context.fail(
                    callback,
                    "Recursive async callback requires an owned function signature.",
                );
            this.context.reachJsData();
            const callbackType = this.context.dataTypes.cppType(type);
            this.context.emit({
                kind: "declaration",
                type: "auto",
                name: cppName,
                initializer: `bbl::js::make_gc_shared<${callbackType}>()`,
            });
            const value = {
                ...this.context.dataValue(`(*${cppName})`, type),
                sharedStorageCpp: cppName,
            };
            this.context.bindings.defineVariable(name, value);
            // Suspended invocations retain the recursive cell through the same
            // traced environment used by stored async callbacks.
            const compiled = this.context.compileStoredDataFunction(
                callback,
                type,
            );
            this.context.emit(`${value.cpp} = ${compiled};`);
            return;
        }
        if (!ts.isBlock(callback.body)) {
            this.context.fail(
                callback.body,
                "Recursive callbacks require a block body.",
            );
        }
        const callbackBody = callback.body;
        const signature =
            this.context.checker.getSignatureFromDeclaration(callback);
        if (!signature) {
            this.context.fail(
                callback,
                "Recursive callback has no callable signature.",
            );
        }
        const returnTsType = nativeReturnTsType(
            this.context.checker,
            this.context.checker.getReturnTypeOfSignature(signature),
            callback,
            { unwrapPromise: false },
        );
        const returnType = returnTsType
            ? (this.context.dataTypes.fromTsType(returnTsType, callback) ??
              this.context.dataTypes.dynamicJsonType(returnTsType))
            : undefined;
        if (returnTsType && !returnType) {
            this.context.fail(
                callback,
                "Recursive callback return type must be plain data or void.",
            );
        }
        const parameters = callback.parameters.map((parameter) => {
            if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) {
                this.context.fail(
                    parameter,
                    "Recursive callback parameters must be non-rest identifiers.",
                );
            }
            const type =
                this.context.dataTypes.fromTsType(
                    this.context.checker.getTypeAtLocation(parameter),
                    parameter,
                ) ??
                this.context.dataTypes.dynamicJsonType(
                    this.context.checker.getTypeAtLocation(parameter),
                );
            if (!type) {
                this.context.fail(
                    parameter,
                    "Recursive callback parameters must have plain-data types.",
                );
            }
            const byReference = passesByReference(this.context.dataTypes, type);
            const readOnly = parameterIsReadOnly(
                this.context.checker,
                callback,
                parameter.name,
            );
            return {
                declaration: parameter,
                name: parameter.name,
                type,
                byReference,
                readOnly,
                borrowedWrapper: false,
            };
        });
        const returnCpp = returnType
            ? this.context.dataTypes.cppType(returnType)
            : "void";
        const parameterTypes = parameters.map(
            ({ type, byReference, readOnly }) =>
                byReference
                    ? `${readOnly ? "const " : ""}${this.context.dataTypes.cppType(type)}&`
                    : this.context.dataTypes.cppType(type),
        );
        this.context.reachJsData();
        // This binding persists in its scope, so any later statement can
        // hand the callback to a retainer. The reference surface is
        // lexically bounded by the enclosing function body; a module-scope
        // declaration keeps engine ownership unscanned, because the
        // startEngine continuation split can rehome its storage.
        const enclosing = ts.findAncestor(name, ts.isFunctionLike);
        const enclosingBody =
            enclosing !== undefined && "body" in enclosing
                ? enclosing.body
                : undefined;
        const escapes =
            enclosingBody === undefined ||
            recursiveStorageEscapes(
                this.context.checker,
                new EmissionSet<SupportedFunction>([callback]),
                [enclosingBody],
            );
        if (escapes) {
            this.context.bindings.refuseEscapingPlatformEventCapturesIn(
                callback,
                this.context.bindings.variableScopes.length,
            );
        }
        const storage = this.context.emitNativeCallbackStorage(
            cppName,
            `${returnCpp}(${parameterTypes.join(", ")})`,
            escapes,
        );
        this.context.bindings.defineVariable(name, {
            ...storage,
            callbackDeclaration: callback,
            nativeCallbackParameterTypes: parameters.map(
                (parameter) => parameter.type,
            ),
            nativeCallbackStaticArguments: parameters.map(() => undefined),
            ...(returnType ? { nativeCallbackReturnType: returnType } : {}),
        });
        let parameterDeclarations: string[] = [];
        const emitCallbackBody = (): void => {
            const captured = captureDataFunctionBody(
                this.context,
                parameters,
                returnType,
                () => {
                    emitReachableStatements(
                        this.context,
                        callbackBody.statements,
                    );
                },
            );
            parameterDeclarations = captured.parameterDeclarations;
            for (const line of captured.lines) this.context.emit(line);
        };
        const compiled = this.context.dataTypes.withDynamicJsonTypes(
            returnType?.kind === "json" ||
                parameters.some((parameter) => parameter.type.kind === "json"),
            () =>
                this.context.captureManagedClosureLines(
                    emitCallbackBody,
                    !escapes,
                ),
        );
        this.context.emit(
            `${storage.cpp} = ${this.context.renderSharedClosure(compiled, returnCpp, callback, parameterDeclarations.join(", "), [])};`,
        );
    }

    /**
     * Emits a data-typed local when the declaration carries an explicit
     * annotation mapping to a composite data type, or when an inferred array
     * or inferred object value is subsequently mutated. The latter includes
     * values initialized through an array element or function result, not
     * only object literals: JavaScript gives all of them runtime identity.
     * Immutable options remain compile-time records, while a write or rebind
     * (including through a reached local-function parameter) materializes the
     * object's native data storage.
     */
    private initializerProducesAccessorRecord(
        expression: ts.Expression,
        seen = new EmissionSet<ts.Node>(),
    ): boolean {
        const unwrapped = this.context.unwrap(expression);
        if (seen.has(unwrapped)) return false;
        seen.add(unwrapped);
        if (ts.isObjectLiteralExpression(unwrapped)) {
            if (
                unwrapped.properties.some(
                    (property) =>
                        ts.isGetAccessorDeclaration(property) ||
                        ts.isSetAccessorDeclaration(property),
                )
            ) {
                return true;
            }
            return unwrapped.properties.some((property) => {
                if (ts.isPropertyAssignment(property)) {
                    return this.initializerProducesAccessorRecord(
                        property.initializer,
                        seen,
                    );
                }
                if (ts.isSpreadAssignment(property)) {
                    return this.initializerProducesAccessorRecord(
                        property.expression,
                        seen,
                    );
                }
                if (ts.isShorthandPropertyAssignment(property)) {
                    return this.initializerProducesAccessorRecord(
                        property.name,
                        seen,
                    );
                }
                return false;
            });
        }
        if (ts.isIdentifier(unwrapped)) {
            const declaration =
                this.context.symbols.valueSymbol(unwrapped)?.valueDeclaration;
            return Boolean(
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                this.initializerProducesAccessorRecord(
                    declaration.initializer,
                    seen,
                ),
            );
        }
        if (ts.isCallExpression(unwrapped)) {
            const declaration =
                this.context.checker.getResolvedSignature(
                    unwrapped,
                )?.declaration;
            if (
                !declaration ||
                !isSupportedFunction(declaration) ||
                !declaration.body
            ) {
                return false;
            }
            if (!ts.isBlock(declaration.body)) {
                return this.initializerProducesAccessorRecord(
                    declaration.body,
                    seen,
                );
            }
            let found = false;
            const visit = (root: ts.Node): void =>
                forEachAnalysisNode(root, (node) => {
                    if (found || ts.isFunctionLike(node)) return "skip";
                    if (
                        ts.isReturnStatement(node) &&
                        node.expression &&
                        this.initializerProducesAccessorRecord(
                            node.expression,
                            seen,
                        )
                    ) {
                        found = true;
                        return "skip";
                    }
                });
            declaration.body.statements.forEach(visit);
            return found;
        }
        return false;
    }

    private emitDynamicDataBinding(
        name: ts.Identifier,
        cppName: string,
        value: Value,
        source: ts.Expression,
        shared: boolean,
    ): true {
        const type: DataType = { kind: "json" };
        const initializer = this.context.dataLowerer.compileKnownValueForSink(
            value,
            type,
            source,
        );
        this.context.reachFeature("data:json", source);
        this.context.reachJsData();
        this.context.emit({
            kind: "declaration",
            type: shared ? "auto" : "bbl::js::JsonValue",
            name: cppName,
            initializer: shared
                ? `bbl::js::make_gc_shared<bbl::js::JsonValue>(${initializer})`
                : initializer,
        });
        const cpp = shared ? `(*${cppName})` : cppName;
        this.context.dataLowerer.registerLocal(cpp, "owned");
        this.context.bindings.defineVariable(name, {
            ...this.context.dataLowerer.leafValue(cpp, type),
            ...(shared ? { sharedStorageCpp: cppName } : {}),
        });
        return true;
    }

    private emitAnnotatedDataDeclaration(
        declaration: ts.VariableDeclaration,
        cppName: string,
        sharedClosureStorage: boolean,
    ): boolean {
        const name = declaration.name;
        if (!ts.isIdentifier(name)) return false;

        if (!declaration.initializer) {
            return false;
        }
        if (this.context.dynamicBindings.has(declaration)) {
            const type = this.context.dynamicBindings.get(declaration);
            if (type) {
                this.context.reachJsData();
                const initializer = this.context.dataLowerer.compileForSink(
                    declaration.initializer,
                    type,
                );
                this.context.emit({
                    kind: "declaration",
                    type: this.context.dataTypes.cppType(type),
                    name: cppName,
                    initializer,
                });
                this.context.bindings.defineVariable(
                    name,
                    this.context.dataLowerer.leafValue(cppName, type),
                );
                return true;
            }
            return this.emitDynamicDataBinding(
                name,
                cppName,
                this.context.compileValue(declaration.initializer),
                declaration.initializer,
                sharedClosureStorage,
            );
        }
        const annotatedResource = this.context.nullableResourceKind(name, true);
        if (annotatedResource?.kind === "storage-buffer") {
            // StorageBuffer is an opaque engine resource even though the
            // upstream declaration is a structurally visible interface.
            // Keep an explicit `const buffer: StorageBuffer = ...` on the
            // ordinary value path instead of materializing that interface as
            // a plain-data struct.
            return false;
        }
        const typeSite = declaration.type ?? name;
        const declaredType = declaration.type
            ? this.context.checker.getTypeFromTypeNode(declaration.type)
            : this.context.checker.getTypeAtLocation(name);
        // A rebound binding is storage: every later assignment writes a value
        // of the declared type into it, so the declared type is mapped as a
        // stored position. A local class it names takes its shared-object
        // representation here exactly as it would as a field or an element;
        // otherwise `let c: C | null = null` would keep the initializer's
        // null as the binding's only representation.
        let annotated = this.context.identifierIsRebound(name)
            ? this.context.dataTypes.fromStoredTsType(declaredType, typeSite)
            : this.context.dataTypes.fromTsType(declaredType, typeSite);
        if (
            annotated?.kind === "optional" &&
            annotated.inner.kind === "struct"
        ) {
            // A rebindable nullable object carries JavaScript object identity:
            // assigning another object selects that object, it does not copy
            // its fields into optional inline storage. Reference-backed
            // structs already encode both identity and null in their shared
            // pointer, so use that representation for this declaration.
            annotated =
                this.context.dataTypes.markStoredObjectReferences(annotated);
        }
        if (annotated?.kind === "enum" && sharedClosureStorage) {
            const initializer = this.context.compileValue(
                declaration.initializer,
            );
            const cppType = this.context.dataTypes.cppType(annotated);
            const initializerCpp =
                this.context.dataLowerer.compileKnownValueForSink(
                    initializer,
                    annotated,
                    declaration.initializer,
                );
            this.context.emit({
                kind: "declaration",
                type: "auto",
                name: cppName,
                initializer: `bbl::js::make_gc_shared<${cppType}>(${initializerCpp})`,
            });
            this.context.bindings.defineVariable(name, {
                kind: "data",
                cpp: `(*${cppName})`,
                sharedStorageCpp: cppName,
                dataType: annotated,
            });
            return true;
        }
        const inferredMutableArray =
            !declaration.type &&
            ts.isIdentifier(name) &&
            ts.isArrayLiteralExpression(
                this.context.unwrap(declaration.initializer),
            ) &&
            this.inferredArrayIsMutated(name);
        const initializer = this.context.unwrap(declaration.initializer);
        if (
            ts.isObjectLiteralExpression(initializer) &&
            hasDynamicObjectSpread(this.context, initializer)
        )
            return false;
        const annotatedOpenRecordLiteral =
            declaration.type !== undefined &&
            annotated?.kind === "map" &&
            ts.isObjectLiteralExpression(initializer) &&
            ts.isIdentifier(name);
        if (
            annotatedOpenRecordLiteral &&
            !this.openRecordContainerIsMutated(name) &&
            !this.context.identifierIsRebound(name)
        ) {
            // An immutable Record literal stays a compile-time record. A
            // dynamic read materializes the existing namespace-scope Map,
            // while a Record that is actually written needs ordinary Map
            // storage here (the XML attribute parser is that shape).
            return false;
        }
        const inferredPlainObject =
            annotated?.kind === "struct" ||
            (annotated?.kind === "optional" &&
                annotated.inner.kind === "struct");
        if (
            !declaration.type &&
            inferredPlainObject &&
            this.initializerProducesAccessorRecord(initializer)
        ) {
            return false;
        }
        const mutablePlainObject =
            ts.isIdentifier(name) &&
            inferredPlainObject &&
            (ts.isObjectLiteralExpression(initializer) ||
            ts.isConditionalExpression(initializer)
                ? this.inferredObjectIsMutated(name)
                : this.context.identifierIsRebound(name));
        const inferredMutableObject = !declaration.type && mutablePlainObject;
        const explicitlyTypedMutableEntryObject =
            declaration.type !== undefined &&
            mutablePlainObject &&
            (this.context.defaultEngine() !== undefined ||
                this.context.options.workers !== undefined);
        if (
            !declaration.type &&
            !inferredMutableArray &&
            !inferredMutableObject
        ) {
            return false;
        }
        // Inferred immutable locals already follow compileValue's actual
        // representation. Only declarations that request native storage need
        // this probe; immutable factory bodies must not be compiled twice.
        const objectAnnotation =
            annotated?.kind === "optional" ? annotated.inner : annotated;
        if (
            objectAnnotation &&
            ["struct", "vector", "tuple", "map", "enummap"].includes(
                objectAnnotation.kind,
            )
        ) {
            const source = declaration.initializer;
            const value = this.context.probeEmission(() => {
                try {
                    return this.context.compileValue(source);
                } catch (error) {
                    if (error instanceof CompileError) return undefined;
                    throw error;
                }
            }, isJsonValue);
            if (isJsonValue(value))
                return this.emitDynamicDataBinding(
                    name,
                    cppName,
                    value,
                    source,
                    sharedClosureStorage,
                );
        }
        if (
            inferredMutableArray &&
            annotated?.kind === "vector" &&
            annotated.element.kind === "handle" &&
            ["mesh", "animation-group", "camera"].includes(
                annotated.element.handle,
            )
        ) {
            // Inferred lists of generation-known engine handles retain the
            // compile-time tuple path. That path already models pushes and
            // is required by consumers whose exact members determine static
            // render composition. An explicitly typed handle array still
            // requests ordinary runtime container semantics.
            return false;
        }
        if (
            annotated &&
            (inferredMutableObject || explicitlyTypedMutableEntryObject)
        ) {
            annotated =
                this.context.dataTypes.markStoredObjectReferences(annotated);
        }
        const initializerLiteral = this.context.unwrap(declaration.initializer);
        if (
            !annotated ||
            annotated.kind === "number" ||
            annotated.kind === "boolean" ||
            (annotated.kind === "handle" &&
                !ts.isObjectLiteralExpression(initializerLiteral)) ||
            annotated.kind === "span" ||
            annotated.kind === "table" ||
            (annotated.kind === "optional" &&
                annotated.inner.kind === "handle") ||
            (annotated.kind === "tuple" &&
                !ts.isArrayLiteralExpression(initializerLiteral))
        ) {
            // Readonly views keep the legacy static-tuple declaration
            // semantics; only owning composites (and mutable tuple
            // locals initialized from array literals) take the data
            // path. An optional HANDLE local (`Mesh | undefined` from a
            // search) keeps the value path too: a handle a search
            // produced carries its found flag, which is this port's
            // representation of that optionality.
            //
            // A HANDLE annotation is carried by the value the initializer
            // produces rather than by this declaration: `const box: Mesh =
            // createBox(...)` names the same engine value the unannotated
            // spelling does, so the annotation must not turn it into data
            // storage that no longer accepts `box.material`. The exception
            // is a handle spelled as an object LITERAL -- `const atlas:
            // SpriteAtlas = { texture, frames, ... }` is a record the data
            // lowerer materializes, which is the shape freeciv and the
            // platformer write and the reason a bare `handle` exemption
            // here cannot be unconditional.
            return false;
        }
        if (ts.isIdentifier(name)) {
            const symbol = this.context.symbols.valueSymbol(name);
            if (symbol) this.context.staticConstants.delete(symbol);
        }
        const staticHandleElementType =
            annotated.kind === "vector" && annotated.element.kind === "handle"
                ? annotated.element
                : undefined;
        const staticHandleEntries =
            staticHandleElementType &&
            ts.isArrayLiteralExpression(initializer) &&
            initializer.elements.every(
                (element) =>
                    ts.isIdentifier(element) || ts.isSpreadElement(element),
            )
                ? this.context.handleCollections.staticHandleList(initializer)
                : undefined;
        const staticHandleElements = staticHandleEntries?.every(
            ({ value }) => value.kind === staticHandleElementType?.handle,
        )
            ? staticHandleEntries.map(({ value }) => value)
            : undefined;
        // Native numeric tuples retain generation facts on the same snapshot
        // that array writes and escaping aliases already invalidate.
        const staticTupleNumbers =
            annotated.kind === "tuple" &&
            ts.isArrayLiteralExpression(initializer)
                ? initializer.elements.map((element) =>
                      staticNumberValue(this.context, element),
                  )
                : undefined;
        const staticTupleElements: Value[] | undefined =
            staticTupleNumbers?.every(
                (value): value is number => value !== undefined,
            )
                ? staticTupleNumbers.map((value, index) => ({
                      kind: "number",
                      cpp: `${cppName}[${index}]`,
                      staticNumber: value,
                  }))
                : undefined;
        const staticElements =
            annotated.kind === "vector" &&
            ts.isArrayLiteralExpression(initializer) &&
            initializer.elements.length === 0
                ? []
                : (staticHandleElements ?? staticTupleElements);
        this.context.reachJsData();
        const spreadTarget =
            annotated.kind === "struct"
                ? annotated
                : annotated.kind === "optional" &&
                    annotated.inner.kind === "struct"
                  ? annotated.inner
                  : undefined;
        const declarationSymbol = ts.isIdentifier(name)
            ? this.context.symbols.valueSymbol(name)
            : undefined;
        let initializerReferencesBinding = false;
        const scannedFunctions = new EmissionSet<ts.FunctionLikeDeclaration>();
        if (declarationSymbol) {
            const visit = (root: ts.Node): void =>
                forEachAnalysisNode(root, (node) => {
                    if (initializerReferencesBinding) return "skip";
                    if (
                        ts.isIdentifier(node) &&
                        this.context.symbols.valueSymbol(node) ===
                            declarationSymbol
                    ) {
                        initializerReferencesBinding = true;
                        return "skip";
                    }
                    if (ts.isCallExpression(node)) {
                        const called =
                            this.context.checker.getResolvedSignature(
                                node,
                            )?.declaration;
                        if (
                            called &&
                            isSupportedFunction(called) &&
                            called.body &&
                            !scannedFunctions.has(called)
                        ) {
                            scannedFunctions.add(called);
                            visit(called.body);
                            if (initializerReferencesBinding) return "skip";
                        }
                    }
                });
            visit(initializer);
        }
        const selfReferentialBinding =
            initializerReferencesBinding &&
            (annotated.kind === "function" ||
                (annotated.kind === "struct" &&
                    this.context.dataTypes.isReferenceStruct(annotated.name)));
        const sharedDataBinding =
            !selfReferentialBinding &&
            sharedClosureStorage &&
            this.context.identifierIsRebound(name);
        if (selfReferentialBinding) {
            // A method in the initializer closes over the JavaScript binding,
            // not over the empty value it has while that initializer is being
            // lowered. Keep the reference in a shared cell so the generated
            // lambda observes the assignment immediately below.
            this.context.emit({
                kind: "declaration",
                type: "auto",
                name: cppName,
                initializer: `bbl::js::make_gc_shared<${this.context.dataTypes.cppType(annotated)}>()`,
            });
            this.context.bindings.defineVariable(name, {
                ...this.context.dataLowerer.leafValue(
                    `(*${cppName})`,
                    annotated,
                ),
                sharedStorageCpp: cppName,
            });
        }
        const initializerBoundary = this.context.nativeBindingCheckpoint();
        const initializerSnapshot =
            spreadTarget &&
            ((ts.isObjectLiteralExpression(initializer) &&
                !initializer.properties.some(ts.isSpreadAssignment)) ||
                ts.isConditionalExpression(initializer))
                ? this.context.compileValue(initializer)
                : undefined;
        const boundCpp =
            sharedDataBinding || selfReferentialBinding
                ? `(*${cppName})`
                : cppName;
        if (
            spreadTarget &&
            ts.isObjectLiteralExpression(initializer) &&
            initializer.properties.some((property) =>
                ts.isSpreadAssignment(property),
            )
        ) {
            const targetCpp =
                sharedDataBinding || selfReferentialBinding
                    ? this.context.allocateTemporaryCppName("shared_initial")
                    : cppName;
            this.context.dataLowerer.emitSpreadStructDeclaration(
                targetCpp,
                initializer,
                spreadTarget,
            );
            if (sharedDataBinding) {
                this.context.emit({
                    kind: "declaration",
                    type: "auto",
                    name: cppName,
                    initializer: `bbl::js::make_gc_shared<${this.context.dataTypes.cppType(annotated)}>(std::move(${targetCpp}))`,
                });
            } else if (selfReferentialBinding) {
                this.context.emit(`(*${cppName}) = std::move(${targetCpp});`);
            }
        } else {
            const initializerCpp = this.context.takeNativeTemporary(
                initializerSnapshot
                    ? this.context.dataLowerer.compileKnownValueForSink(
                          initializerSnapshot,
                          annotated,
                          declaration.initializer,
                      )
                    : this.context.dataLowerer.compileForSink(
                          declaration.initializer,
                          annotated,
                      ),
                initializerBoundary,
            );
            const sourceValue = ts.isIdentifier(initializer)
                ? this.context.bindings.lookupOptional(initializer)
                : undefined;
            const stableOwnerAlias =
                sourceValue !== undefined &&
                sourceValue.cpp === initializerCpp &&
                this.borrowsConstBinding(declaration, sourceValue) &&
                (annotated.kind !== "struct" ||
                    this.context.dataTypes.isReferenceStruct(annotated.name));
            this.context.emit(
                sharedDataBinding
                    ? {
                          kind: "declaration",
                          type: "auto",
                          name: cppName,
                          initializer: `bbl::js::make_gc_shared<${this.context.dataTypes.cppType(annotated)}>(${initializerCpp})`,
                      }
                    : selfReferentialBinding
                      ? `(*${cppName}) = ${initializerCpp};`
                      : {
                            kind: "declaration",
                            type: stableOwnerAlias
                                ? "auto&"
                                : this.context.dataTypes.cppType(annotated),
                            name: cppName,
                            initializer: initializerCpp,
                            attributes: "[[maybe_unused]] ",
                        },
            );
        }
        if (
            ts.isArrayLiteralExpression(initializer) &&
            ts.isIdentifier(name) &&
            isNeverResized(this.context.checker, name)
        ) {
            this.context.dataLowerer.registerFixedLength(
                boundCpp,
                initializer.elements.length,
            );
        }
        this.context.dataLowerer.registerLocal(
            boundCpp,
            (annotated.kind === "struct" &&
                this.context.dataTypes.isReferenceStruct(annotated.name)) ||
                ts.isCallExpression(initializer) ||
                ts.isNewExpression(initializer) ||
                ts.isObjectLiteralExpression(initializer) ||
                ts.isArrayLiteralExpression(initializer)
                ? "owned"
                : "copy",
        );
        const staticRecordProperties: Record<string, Value> = {
            ...(initializerSnapshot?.recordProperties ?? {}),
        };
        if (
            Object.keys(staticRecordProperties).length === 0 &&
            annotated.kind === "struct" &&
            ts.isObjectLiteralExpression(initializer)
        ) {
            for (const property of initializer.properties) {
                if (!ts.isShorthandPropertyAssignment(property)) {
                    continue;
                }
                const value = this.context.bindings.lookupOptional(
                    property.name,
                );
                if (
                    value &&
                    (value.staticNumber !== undefined ||
                        value.staticString !== undefined ||
                        value.staticBoolean !== undefined)
                ) {
                    staticRecordProperties[property.name.text] = value;
                }
            }
        }
        // A selected object's settled presence: a record is there, a
        // `null` arm is not, and a flag generation already decided says so.
        const snapshotFound =
            initializerSnapshot && presenceFlagCpp(initializerSnapshot);
        const settledPresence =
            initializerSnapshot?.kind === "json-null"
                ? "false"
                : initializerSnapshot?.kind === "record"
                  ? "true"
                  : snapshotFound === "true" || snapshotFound === "false"
                    ? snapshotFound
                    : undefined;
        const boundValue: Value = {
            kind: "data",
            cpp: boundCpp,
            ...(sharedDataBinding || selfReferentialBinding
                ? { sharedStorageCpp: cppName }
                : {}),
            dataType: annotated,
            ...(annotated.kind === "struct" &&
            initializerSnapshot?.kind === "record" &&
            ts.isIdentifier(name) &&
            !mutablePlainObject
                ? {
                      recordOwnKeys: Object.keys(
                          initializerSnapshot.recordProperties ?? {},
                      ),
                  }
                : annotated.kind === "enummap" &&
                    ts.isObjectLiteralExpression(initializer) &&
                    !this.context.identifierIsRebound(name)
                  ? {
                        recordOwnKeys: Object.keys(
                            Object.fromEntries(
                                this.context.dataLowerer
                                    .literalKeyOrder(initializer)
                                    .map((key) => [key, undefined]),
                            ),
                        ),
                    }
                  : {}),
            // Shared storage does not change a selected object's presence.
            ...(ts.isConditionalExpression(initializer) &&
            settledPresence !== undefined &&
            !this.context.identifierIsRebound(name)
                ? { optionalFoundCpp: settledPresence }
                : {}),
            ...(annotated.kind === "map" &&
            ts.isObjectLiteralExpression(initializer) &&
            initializer.properties.length === 0
                ? { recordProperties: {} }
                : Object.keys(staticRecordProperties).length > 0
                  ? { recordProperties: staticRecordProperties }
                  : {}),
            ...(staticElements && !sharedDataBinding && !selfReferentialBinding
                ? { staticElements }
                : {}),
        };
        const represented =
            annotated.kind === "error"
                ? withNativeMetadata(
                      boundValue,
                      this.context.dataLowerer.leafValue(boundCpp, annotated),
                  )
                : annotated.kind === "promise"
                  ? withNativeMetadata(
                        this.context.dataValue(boundCpp, annotated),
                        boundValue,
                    )
                  : boundValue;
        if (selfReferentialBinding) {
            this.context.bindings.rebindVariable(name, represented);
        } else {
            this.context.bindings.defineVariable(name, represented);
        }
        return true;
    }

    /**
     * Whether an inferred array literal needs actual array storage.
     *
     * The alias walk is `aliasedMutationScan`; the clauses here are what
     * counts as an array mutation: a runtime element index (which needs
     * storage even when nothing resizes), a mutating array method, the
     * array escaping into any call argument, and assignment through an
     * element or to the binding itself. Only a direct rebind
     * (`const b = arr` or `b = arr`) creates an alias.
     */
    private inferredArrayIsMutated(identifier: ts.Identifier): boolean {
        return aliasedMutationScan(
            identifier,
            (name) => this.context.symbols.valueSymbol(name),
            {
                aliasingInitializer: (initializer, scan) => {
                    const value = this.context.unwrap(initializer);
                    if (scan.namesAlias(value)) return true;
                    const callee = ts.isCallExpression(value)
                        ? this.context.unwrap(value.expression)
                        : undefined;
                    const called = ts.isCallExpression(value)
                        ? callee && ts.isIdentifier(callee)
                            ? tryResolveFunctionDeclaration(
                                  this.context.checker,
                                  callee,
                              )
                            : this.context.checker.getResolvedSignature(value)
                                  ?.declaration
                        : ts.isPropertyAccessExpression(value)
                          ? resolvedSymbol(
                                this.context.checker,
                                value,
                            )?.declarations?.find(ts.isGetAccessorDeclaration)
                          : undefined;
                    if (
                        (!isSupportedFunction(called) &&
                            !(called && ts.isGetAccessorDeclaration(called))) ||
                        !called.body
                    )
                        return false;
                    const returnsArrayAlias = (
                        expression: ts.Expression,
                    ): boolean => {
                        if (!scan.containsAlias(expression)) return false;
                        const type =
                            this.context.checker.getTypeAtLocation(expression);
                        return (
                            this.context.checker.isArrayType(type) ||
                            this.context.checker.isTupleType(type)
                        );
                    };
                    if (!ts.isBlock(called.body))
                        return returnsArrayAlias(called.body);
                    let aliases = false;
                    walkReachedLoopNodes(this.context, called.body, (node) => {
                        if (aliases) return false;
                        if (ts.isReturnStatement(node) && node.expression) {
                            aliases = returnsArrayAlias(node.expression);
                        }
                    });
                    return aliases;
                },
                mutates: (node, scan) => {
                    if (
                        ts.isElementAccessExpression(node) &&
                        scan.namesAlias(this.context.unwrap(node.expression)) &&
                        node.argumentExpression
                    ) {
                        const index = this.context.resolveStaticExpression(
                            node.argumentExpression,
                        );
                        if (
                            !ts.isNumericLiteral(index) ||
                            !Number.isInteger(Number(index.text))
                        ) {
                            // Constant numeric tables already have a lazy native
                            // representation for runtime reads. Keep their literal
                            // values available to generation-time projections too.
                            const literal =
                                this.context.constArrayLiteral(identifier);
                            if (
                                literal &&
                                this.context.dataLowerer.isNumericTable(literal)
                            ) {
                                return false;
                            }
                            // A runtime index needs actual array storage
                            // even when the inferred literal is never
                            // resized.
                            return true;
                        }
                    }
                    if (
                        isUpdateExpression(node) &&
                        ts.isElementAccessExpression(node.operand) &&
                        scan.namesAlias(
                            this.context.unwrap(node.operand.expression),
                        )
                    ) {
                        // `arr[0]++` writes the element without a binary
                        // assignment node; the runtime-index clause above
                        // only catches non-static subscripts.
                        return true;
                    }
                    if (ts.isCallExpression(node)) {
                        if (
                            ts.isPropertyAccessExpression(node.expression) &&
                            scan.namesAlias(
                                this.context.unwrap(node.expression.expression),
                            ) &&
                            mutatingArrayMethods.has(node.expression.name.text)
                        ) {
                            return true;
                        }
                        if (node.arguments.some(scan.containsAlias)) {
                            return true;
                        }
                    }
                    return (
                        isAssignmentExpression(node) &&
                        assignmentTargets(node.left).some(
                            (target) =>
                                ((ts.isPropertyAccessExpression(target) ||
                                    ts.isElementAccessExpression(target)) &&
                                    scan.containsAlias(node.right)) ||
                                (ts.isElementAccessExpression(target) &&
                                    scan.namesAlias(
                                        this.context.unwrap(target.expression),
                                    )) ||
                                scan.namesAlias(this.context.unwrap(target)),
                        )
                    );
                },
            },
        );
    }

    private openRecordContainerIsMutated(identifier: ts.Identifier): boolean {
        const symbol = this.context.symbols.valueSymbol(identifier);
        if (!symbol) return false;
        let mutated = false;
        const directlyIndexes = (expression: ts.Expression): boolean =>
            (ts.isElementAccessExpression(expression) ||
                ts.isPropertyAccessExpression(expression)) &&
            this.context.unwrappedValueSymbol(expression.expression) === symbol;
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (mutated) return "skip";
                if (
                    isAssignmentExpression(node) &&
                    assignmentTargets(node.left).some(directlyIndexes)
                ) {
                    mutated = true;
                    return "skip";
                }
                if (
                    (ts.isPrefixUnaryExpression(node) ||
                        ts.isPostfixUnaryExpression(node)) &&
                    directlyIndexes(node.operand)
                ) {
                    mutated = true;
                    return "skip";
                }
            });
        ts.forEachChild(identifier.getSourceFile(), visit);
        return mutated;
    }

    /**
     * Whether an inferred plain object needs native storage.
     *
     * Compile-time records are ideal for immutable options, but they cannot
     * model JavaScript object identity: retaining the initializer expressions
     * would make `point.x = value` assign back into whatever expression first
     * populated `x`. Follow simple aliases and local call parameters so a
     * mutation performed by a reached helper also materializes the caller's
     * object.
     *
     * The alias walk is `aliasedMutationScan`; the clauses here are what
     * counts as an object mutation: a rebind, a write or `++`/`--` through
     * a member chain rooted at an alias, storing the object into another
     * container, and a storing data method taking it. Any chain rooted at
     * an alias creates an alias (`const b = obj.child` shares storage),
     * and a call argument extends the set into the callee's parameters
     * rather than mutating.
     */
    private inferredObjectIsMutated(identifier: ts.Identifier): boolean {
        const isAlias = (
            scan: AliasedMutationScan,
            expression: ts.Expression,
            active = new Set<ts.Node>(),
        ): boolean => {
            const node = this.context.unwrap(expression);
            if (ts.isIdentifier(node)) return scan.namesAlias(node);
            if (
                ts.isPropertyAccessExpression(node) ||
                ts.isElementAccessExpression(node)
            )
                return isAlias(scan, node.expression, active);
            if (!ts.isCallExpression(node)) return false;
            const called =
                this.context.checker.getResolvedSignature(node)?.declaration;
            if (
                !isSupportedFunction(called) ||
                !called.body ||
                active.has(called)
            )
                return false;
            active.add(called);
            try {
                return ts.isBlock(called.body)
                    ? someAnalysisNode(
                          called.body,
                          (statement) =>
                              ts.isReturnStatement(statement) &&
                              !!statement.expression &&
                              isAlias(scan, statement.expression, active),
                          { functions: "skip" },
                      )
                    : isAlias(scan, called.body, active);
            } finally {
                active.delete(called);
            }
        };
        return aliasedMutationScan(
            identifier,
            (name) => this.context.symbols.valueSymbol(name),
            {
                aliasingInitializer: (initializer, scan) =>
                    isAlias(scan, initializer),
                mutates: (node, scan) => {
                    if (
                        ts.isVariableDeclaration(node) &&
                        node.initializer &&
                        scan.containsAlias(node.initializer) &&
                        (node.type ||
                            (ts.isIdentifier(node.name) &&
                                ts.isArrayLiteralExpression(
                                    this.context.unwrap(node.initializer),
                                ) &&
                                this.inferredArrayIsMutated(node.name)))
                    ) {
                        const type = this.context.dataTypes.fromTsType(
                            node.type
                                ? this.context.checker.getTypeFromTypeNode(
                                      node.type,
                                  )
                                : this.context.checker.getTypeAtLocation(
                                      node.name,
                                  ),
                            node.type ?? node.name,
                        );
                        // A typed native array retains this object's identity,
                        // including when a later dynamic tuple read mutates it.
                        if (type?.kind === "vector" || type?.kind === "product")
                            return true;
                    }
                    if (
                        ts.isDeleteExpression(node) &&
                        isAlias(scan, node.expression)
                    )
                        return true;
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                        ts.isIdentifier(node.left) &&
                        scan.namesAlias(node.left)
                    ) {
                        // Rebinding an inferred object still needs
                        // persistent reference storage even when no field
                        // is written.
                        return true;
                    }
                    if (
                        isAssignmentExpression(node) &&
                        assignmentTargets(node.left).some((target) =>
                            isAlias(scan, target),
                        )
                    ) {
                        return true;
                    }
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                        (ts.isPropertyAccessExpression(node.left) ||
                            ts.isElementAccessExpression(node.left)) &&
                        scan.containsAlias(node.right)
                    ) {
                        // Storing an object in another object/container
                        // makes identity observable through the second
                        // path.
                        return true;
                    }
                    if (
                        isUpdateExpression(node) &&
                        (ts.isPropertyAccessExpression(node.operand) ||
                            ts.isElementAccessExpression(node.operand)) &&
                        isAlias(scan, node.operand)
                    ) {
                        return true;
                    }
                    if (
                        (ts.isCallExpression(node) ||
                            ts.isNewExpression(node)) &&
                        node.arguments?.some(scan.containsAlias) &&
                        isStoringDataCall(node, this.context.checker)
                    )
                        return true;
                    if (ts.isCallExpression(node)) {
                        const retainedTarget = retainedNativeMutationTarget(
                            this.context.symbols,
                            node,
                        );
                        if (retainedTarget && isAlias(scan, retainedTarget)) {
                            // The retained writer mutates this object later.
                            // Choose its shared home before a typed alias can
                            // otherwise snapshot the compile-time record.
                            return true;
                        }
                        const called =
                            this.context.checker.getResolvedSignature(
                                node,
                            )?.declaration;
                        if (!isSupportedFunction(called)) return false;
                        for (const [
                            index,
                            argument,
                        ] of node.arguments.entries()) {
                            const parameter = called.parameters[index]?.name;
                            if (
                                scan.containsAlias(argument) &&
                                parameter !== undefined &&
                                ts.isIdentifier(parameter) &&
                                parameterIsMutated(
                                    this.context.checker,
                                    called,
                                    parameter,
                                )
                            ) {
                                // The shared parameter analysis follows
                                // aliases and nested calls through the
                                // callee's own source file. Extending this
                                // scan's symbol set only worked when the
                                // helper happened to live beside the caller;
                                // an imported *Into helper could otherwise
                                // mutate a compile-time object literal whose
                                // later reads stayed folded to its initializer.
                                return true;
                            }
                        }
                    }
                    return false;
                },
            },
        );
    }

    /**
     * Destructures a tuple-producing initializer (inlined callback results,
     * static tuples, or data tuples) into per-element locals.
     */
    private emitArrayBindingDeclaration(
        declaration: ts.VariableDeclaration,
    ): void {
        if (
            !ts.isArrayBindingPattern(declaration.name) ||
            !declaration.initializer
        ) {
            this.context.fail(
                declaration,
                "Array destructuring requires an initializer.",
            );
        }
        const initializerBoundary = this.context.nativeBindingCheckpoint();
        const rawValue = this.context.compileValue(declaration.initializer);
        const value =
            rawValue.kind === "data"
                ? this.context.dataLowerer.narrowOptional(
                      rawValue,
                      declaration.initializer,
                  )
                : rawValue;
        const bindings = declaration.name.elements;
        const restIndex = bindings.findIndex(
            (element) =>
                !ts.isOmittedExpression(element) &&
                element.dotDotDotToken !== undefined,
        );
        const rest = restIndex >= 0 ? bindings[restIndex] : undefined;
        if (rest !== undefined && restIndex !== bindings.length - 1) {
            this.context.fail(rest, "A rest element must be the last binding.");
        }
        // `[first, ...rest]`: the rest takes an identifier, bound per arm
        // below to what follows the named bindings.
        const restName =
            rest !== undefined &&
            !ts.isOmittedExpression(rest) &&
            ts.isIdentifier(rest.name)
                ? rest.name
                : undefined;
        if (rest !== undefined && restName === undefined) {
            this.context.fail(rest, "A rest binding takes an identifier.");
        }
        const bindElement = (
            element: ts.ArrayBindingElement,
            present: Value | undefined,
        ): void => {
            if (ts.isOmittedExpression(element)) {
                return;
            }
            if (!ts.isIdentifier(element.name) || element.dotDotDotToken) {
                this.context.fail(
                    element,
                    "Tuple destructuring supports plain identifiers.",
                );
            }
            // A default applies exactly when the lane is undefined: past
            // the end of the tuple, or present as `undefined`.
            const bound =
                (!present || present.kind === "json-null") &&
                element.initializer
                    ? this.context.compileValue(element.initializer)
                    : present;
            if (!bound) {
                this.context.fail(
                    element,
                    "The tuple has no element for this binding and it declares no default.",
                );
            }
            let stored = bound;
            if (bound.kind === "record") {
                const declared = this.context.dataTypes.fromTsType(
                    this.context.checker.getTypeAtLocation(element.name),
                    element.name,
                );
                if (declared?.kind === "struct") {
                    const dataType =
                        this.context.dataTypes.markStoredObjectReferences(
                            declared,
                        );
                    stored = this.context.dataLowerer.leafValue(
                        this.context.dataLowerer.compileKnownValueForSink(
                            bound,
                            dataType,
                            element.name,
                        ),
                        dataType,
                    );
                }
                if (stored.kind === "record") {
                    stored = this.context.bindings.materializeRecordScalars(
                        stored,
                        `record_${element.name.text}`,
                    );
                }
            }
            this.context.bindings.bindLocalValue(element.name, stored);
        };
        if (value.kind === "tuple" && value.tupleElements) {
            const elements = value.tupleElements;
            bindings.forEach((element, index) => {
                if (index === restIndex && restName) {
                    this.context.bindings.bindLocalValue(
                        restName,
                        this.context.dataLowerer.arrayRestValue(
                            value,
                            index,
                            restName,
                        ),
                    );
                    return;
                }
                bindElement(element, elements[index]);
            });
            return;
        }
        if (value.dataType?.kind === "product") {
            const temporary =
                this.context.allocateTemporaryCppName("destructure_tuple");
            this.context.emit(`const auto ${temporary} = ${value.cpp};`);
            bindings.forEach((element, index) => {
                if (index === restIndex && restName) {
                    this.context.bindings.bindLocalValue(
                        restName,
                        this.context.dataLowerer.arrayRestValue(
                            { ...value, cpp: temporary },
                            index,
                            restName,
                        ),
                    );
                    return;
                }
                bindElement(
                    element,
                    this.context.dataLowerer.fixedTupleElement(
                        { ...value, cpp: temporary },
                        index,
                        element,
                    ),
                );
            });
            return;
        }
        // A runtime index into a static numeric table leaves one table
        // dimension. Its native row is the same Tuple<N> used by data tuples.
        const tupleArity =
            value.dataType?.kind === "tuple"
                ? value.dataType.arity
                : value.dataType?.kind === "table" &&
                    value.dataType.dimensions.length === 1
                  ? value.dataType.dimensions[0]
                  : undefined;
        if (value.kind === "data" && tupleArity !== undefined) {
            if ((restIndex >= 0 ? restIndex : bindings.length) > tupleArity) {
                this.context.fail(
                    declaration.name,
                    `Tuple has ${tupleArity} elements, destructuring expects ${bindings.length}.`,
                );
            }
            const temporary = this.context.bindings.bindDataTuple(
                value,
                tupleArity,
                "tuple",
                initializerBoundary,
            );
            bindings.forEach((element, index) => {
                if (index === restIndex && restName) {
                    this.context.bindings.bindLocalValue(
                        restName,
                        this.context.dataLowerer.arrayRestValue(
                            {
                                ...value,
                                cpp: temporary,
                                dataType: { kind: "tuple", arity: tupleArity },
                            },
                            index,
                            restName,
                        ),
                    );
                    return;
                }
                bindElement(element, {
                    kind: "number",
                    cpp: `${temporary}[${index}]`,
                    dataType: { kind: "number" },
                });
            });
            return;
        }
        if (value.kind === "data" && value.dataType?.kind === "vector") {
            const temporary =
                this.context.allocateTemporaryCppName("destructure_vector");
            this.context.emit({
                kind: "declaration",
                type: "const auto&",
                name: temporary,
                initializer: value.cpp,
            });
            const storedVector: Value = {
                ...value,
                cpp: temporary,
            };
            const elementType = value.dataType.element;
            bindings.forEach((element, index) => {
                if (ts.isOmittedExpression(element)) {
                    return;
                }
                if (index === restIndex && restName) {
                    this.context.bindings.bindLocalValue(
                        restName,
                        this.context.dataLowerer.arrayRestValue(
                            storedVector,
                            index,
                            restName,
                        ),
                    );
                    return;
                }
                if (element.initializer && ts.isIdentifier(element.name)) {
                    // A default stands in for a lane past the end.
                    const fallback = this.context.dataLowerer.compileForSink(
                        element.initializer,
                        elementType,
                    );
                    this.bindCopiedDefault(
                        element.name,
                        elementType,
                        `${temporary}.size() > ${index} ? ${temporary}[${index}] : ${fallback}`,
                    );
                    return;
                }
                bindElement(
                    element,
                    this.context.dataLowerer.readVectorBindingElement(
                        storedVector,
                        index,
                        declaration.initializer!,
                    ),
                );
            });
            return;
        }
        this.context.fail(
            declaration.initializer,
            "Array destructuring requires a tuple-producing initializer.",
        );
    }

    /**
     * A destructuring default as a binding: a copied local of `type`
     * holding `initializer`, the value the lane or field would have had.
     */
    private bindCopiedDefault(
        name: ts.Identifier,
        type: DataType,
        initializer: string,
    ): void {
        const value = this.context.dataLowerer.leafValue(initializer, type);
        if (this.context.mutableCapturedParameter(name, value)) {
            this.context.bindings.bindParameterValue(name, value);
            return;
        }
        const cppName = this.context.bindings.cppIdentifier(name.text);
        this.context.reachJsData();
        this.context.emit(
            `${this.context.dataTypes.cppType(type)} ${cppName} = ${initializer};`,
        );
        this.context.bindings.defineVariable(
            name,
            this.context.dataLowerer.leafValue(cppName, type),
        );
        this.context.dataLowerer.registerLocal(cppName, "copy");
    }

    private emitObjectBindingDeclaration(
        declaration: ts.VariableDeclaration,
    ): void {
        if (
            !ts.isObjectBindingPattern(declaration.name) ||
            !declaration.initializer
        ) {
            this.context.fail(
                declaration,
                "Object destructuring requires an initializer.",
            );
        }
        const rawValue = this.context.compileValue(declaration.initializer);
        const value =
            rawValue.kind === "data"
                ? this.context.dataLowerer.narrowOptional(
                      rawValue,
                      declaration.initializer,
                  )
                : rawValue;
        this.bindObjectPattern(
            declaration.name,
            value,
            declaration.initializer,
        );
    }

    /**
     * Binds an object pattern from a value: a compile-time record's
     * properties, or a struct's fields. A destructuring declaration and a
     * destructured parameter are the same binding over different sources.
     */
    public bindObjectPattern(
        pattern: ts.ObjectBindingPattern,
        value: Value,
        source: ts.Node = pattern,
    ): void {
        if (value.kind === "record") {
            this.emitRecordBindingDeclaration(pattern, value);
            return;
        }
        if (value.kind === "data" && value.dataType?.kind === "struct") {
            const temporary =
                this.context.allocateTemporaryCppName("destructure");
            this.context.emit({
                kind: "declaration",
                type: "auto&&",
                name: temporary,
                initializer: value.cpp,
            });
            for (const element of pattern.elements) {
                const { name, property } = this.bindingProperty(element);
                const field = this.context.dataTypes.structField(
                    value.dataType.name,
                    property,
                    element,
                );
                const storedFieldCpp = `${temporary}${this.context.dataTypes.isReferenceStruct(value.dataType.name) ? "->" : "."}${field.name}`;
                if (element.initializer && field.type.kind === "optional") {
                    // The default stands in for an absent optional field; the
                    // binding is then a value of the field's inner type.
                    const fallback = this.context.dataLowerer.compileForSink(
                        element.initializer,
                        field.type.inner,
                    );
                    this.bindCopiedDefault(
                        name,
                        field.type.inner,
                        `${optionalPresentCpp(storedFieldCpp)} ? *${storedFieldCpp} : ${fallback}`,
                    );
                    continue;
                }
                const cppName = this.context.bindings.cppIdentifier(name.text);
                // A default on a required field never applies: the field is
                // never undefined, so the binding is the field itself.
                const fieldCpp = storedFieldCpp;
                const initialValue = this.context.dataLowerer.leafValue(
                    fieldCpp,
                    field.type,
                );
                if (this.context.mutableCapturedParameter(name, initialValue)) {
                    this.context.bindings.bindParameterValue(
                        name,
                        initialValue,
                    );
                    continue;
                }
                const aliases =
                    field.type.kind !== "number" &&
                    field.type.kind !== "boolean" &&
                    field.type.kind !== "string" &&
                    field.type.kind !== "enum" &&
                    field.type.kind !== "handle";
                this.context.emit(
                    `${this.context.dataTypes.cppType(field.type)}${aliases ? "&" : ""} ${cppName} = ${fieldCpp};`,
                );
                const fieldValue = this.context.dataLowerer.leafValue(
                    cppName,
                    field.type,
                );
                const staticField = value.recordProperties?.[property];
                if (staticField?.staticNumber !== undefined) {
                    fieldValue.staticNumber = staticField.staticNumber;
                }
                if (staticField?.staticString !== undefined) {
                    fieldValue.staticString = staticField.staticString;
                }
                if (staticField?.staticBoolean !== undefined) {
                    fieldValue.staticBoolean = staticField.staticBoolean;
                }
                if (aliases && staticField?.staticElements) {
                    fieldValue.staticElements = staticField.staticElements;
                    fieldValue.staticElementsOwner =
                        staticField.staticElementsOwner ?? staticField;
                }
                if (aliases && staticField?.collectionCardinality) {
                    fieldValue.collectionCardinality =
                        staticField.collectionCardinality;
                }
                this.context.bindings.defineVariable(name, fieldValue);
                if (aliases) {
                    this.context.dataLowerer.registerAlias(cppName, fieldCpp);
                }
            }
            return;
        }
        if (value.kind === "physics-aggregate") {
            const temporary =
                this.context.allocateTemporaryCppName("destructure");
            this.context.emit({
                kind: "declaration",
                type: "const auto",
                name: temporary,
                initializer: value.cpp,
            });
            for (const element of pattern.elements) {
                if (element.initializer) {
                    this.context.fail(
                        element,
                        "Default values in physics aggregate destructuring are not supported.",
                    );
                }
                const { name, property } = this.bindingProperty(element);
                const propertyValue =
                    readProperty(
                        this.context,
                        { ...value, cpp: temporary },
                        property,
                        element,
                    ) ??
                    this.context.fail(
                        element,
                        `Unsupported physics aggregate property '${property}'.`,
                    );
                const cppName = this.context.allocateTemporaryCppName(
                    `class_field_${name.text}`,
                );
                this.context.emit({
                    kind: "declaration",
                    type: "const auto",
                    name: cppName,
                    initializer: propertyValue.cpp,
                });
                this.context.bindings.defineVariable(name, {
                    ...propertyValue,
                    cpp: cppName,
                });
            }
            return;
        }
        if (value.kind !== "render-target-texture") {
            this.context.fail(
                source,
                `Object destructuring is not supported for ${value.kind}.`,
            );
        }
        const temporary = this.context.allocateTemporaryCppName("destructure");
        this.context.emit({
            kind: "declaration",
            type: "auto",
            name: temporary,
            initializer: value.cpp,
        });
        for (const element of pattern.elements) {
            const { name, property } = this.bindingProperty(element);
            const cppName = this.context.allocateTemporaryCppName(
                `class_field_${name.text}`,
            );
            // The same properties `rtt.rt` and `rtt.texture` name, read
            // off the temporary the destructuring bound.
            const propertyValue =
                readProperty(
                    this.context,
                    { ...value, cpp: temporary },
                    property,
                    element,
                ) ??
                this.context.fail(
                    element,
                    `Unsupported render-target texture property '${property}'.`,
                );
            this.context.emit({
                kind: "declaration",
                type: "auto",
                name: cppName,
                initializer: propertyValue.cpp,
            });
            this.context.bindings.defineVariable(name, {
                ...propertyValue,
                cpp: cppName,
            });
        }
    }

    /**
     * The source property a destructuring element reads, with the
     * binding forms the compiler does not lower rejected first. The
     * record and render-target paths share this and then diverge on
     * where the value comes from.
     */
    private bindingProperty(element: ts.BindingElement): {
        name: ts.Identifier;
        property: string;
    } {
        if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
            this.context.fail(
                element,
                "Object destructuring supports identifier properties only.",
            );
        }
        return {
            name: element.name,
            property:
                element.propertyName &&
                (ts.isIdentifier(element.propertyName) ||
                    ts.isStringLiteral(element.propertyName))
                    ? element.propertyName.text
                    : element.name.text,
        };
    }

    private emitRecordBindingDeclaration(
        pattern: ts.ObjectBindingPattern,
        value: Value,
    ): void {
        const consumed = new EmissionSet<string>();
        for (const element of pattern.elements) {
            if (element.dotDotDotToken) {
                // `{ a, ...rest }`: the rest is the record of the properties
                // no earlier binding named.
                if (!ts.isIdentifier(element.name)) {
                    this.context.fail(
                        element,
                        "A rest binding takes an identifier.",
                    );
                }
                const remaining = Object.fromEntries(
                    Object.entries(value.recordProperties ?? {}).filter(
                        ([key]) => !consumed.has(key),
                    ),
                );
                this.context.bindings.defineVariable(element.name, {
                    kind: "record",
                    cpp: "",
                    recordProperties: remaining,
                });
                continue;
            }
            const { name, property } = this.bindingProperty(element);
            consumed.add(property);
            const present = value.recordProperties?.[property];
            // A default applies exactly when the property is undefined:
            // absent from the record, or present as `undefined`.
            const propertyValue =
                (!present || present.kind === "json-null") &&
                element.initializer
                    ? this.context.compileValue(element.initializer)
                    : present;
            if (!propertyValue) {
                this.context.fail(
                    element,
                    `Record has no property '${property}'.`,
                );
            }
            if (this.context.mutableCapturedParameter(name, propertyValue)) {
                this.context.bindings.bindParameterValue(name, propertyValue);
                continue;
            }
            if (propertyValue.kind !== "number") {
                // Compile-time records and resource handles already carry
                // their native expressions. Destructuring aliases the same
                // value just as an ordinary identifier binding does; only a
                // numeric property needs distinct mutable local storage.
                this.context.bindings.defineVariable(name, propertyValue);
                continue;
            }
            const cppName = this.context.bindings.cppIdentifier(name.text);
            this.context.emit({
                kind: "declaration",
                type: "double",
                name: cppName,
                initializer: propertyValue.cpp,
                attributes: "[[maybe_unused]] ",
            });
            this.context.bindings.defineVariable(name, {
                kind: "number",
                cpp: cppName,
                ...(propertyValue.staticNumber === undefined
                    ? {}
                    : {
                          staticNumber: propertyValue.staticNumber,
                      }),
            });
        }
    }
}
