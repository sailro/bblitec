// Variable declarations: `const`/`let` bindings with their initializers,
// typed data declarations, recursive and forward callback bindings, and
// array/object binding patterns, lowered into the scope stack's bindings.
import ts from "typescript";
import { cppIdentifierPattern, stringLiteral } from "../cpp-literals.js";
import {
    forEachAnalysisNode,
    findAnalysisNodeWithState,
    someAnalysisNode,
} from "./analysis-walk.js";
import {
    browserDeploymentValue,
    isPrimitiveBrowserValue,
} from "./browser-erasure.js";
import { CompileError } from "./compile-error.js";
import { isNeverResized } from "./data-lowering.js";
import { isStoringDataCall } from "./receiver-methods.js";
import { mutatingArrayMethods } from "./receiver-methods.js";
import {
    isOpaqueReference,
    isHandleKind,
    isTypedArrayType,
    passesByReference,
    type DataType,
} from "./data-types.js";
import { isDeterministicRandomRead } from "./deterministic-random.js";
import type { DynamicBindingStorage } from "./dynamic-binding-storage.js";
import { EmissionMap, EmissionSet, writable } from "./emission-transaction.js";
import { hasDynamicObjectSpread, isJsonValue } from "./json-bridge.js";
import { emitReachableStatements } from "./loop-control.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    captureDataFunctionBody,
    type NativeFunctionContext,
} from "./native-functions.js";
import { nativeReturnTsType } from "./native-return-type.js";
import { nullability } from "./type-facts.js";
import { provenUndefinedValue } from "./undefined-values.js";
import { localClassOfSymbol } from "./class-members.js";
import { ownKeysKnown } from "./object-statics.js";
import {
    staticNumberValue,
    type PositiveIntegerContext,
} from "./option-helpers.js";
import { readProperty, type PropertyContext } from "./properties.js";
import { walkReachedLoopNodes } from "./resource-loops.js";
import {
    type CompilerSymbols,
    declaredSymbol,
    resolvedSymbol,
} from "./symbols.js";
import {
    assignmentTargets,
    isAssignmentExpression,
    isUpdateExpression,
    propertyNameText,
} from "./syntax.js";
import {
    isCompileTimeOnlyValue,
    nativeDataMetadata,
    optionalPresentCpp,
    optionalValueCpp,
    presenceFlagCpp,
    readsNativeStorage,
    snapshotReadCpp,
    statedTruthinessCpp,
    valueForKind,
    withNativeMetadata,
    type Value,
    type ValueKind,
} from "./types.js";
import type { UiProjection } from "./ui-projection.js";
import { nullableResourceEngine } from "./window-events.js";
import { withLiteralSelfBinding } from "./home-object-methods.js";
import {
    inferPromiseRejectStorage,
    inferUninitializedHandle,
} from "./uninitialized-handle.js";
import {
    aliasedMutationScan,
    isSupportedFunction,
    recursiveStorageEscapes,
    retainedNativeMutationTarget,
    tryResolveFunctionDeclaration,
    type AliasedMutationScan,
    type SupportedFunction,
} from "./user-functions.js";
import {
    engineCallMutatesArgument,
    parameterIsMutated,
    parameterIsReadOnly,
} from "./parameter-effects.js";

/** What declaration lowering reads of the compiler. */
interface DeclarationContext
    extends
        NativeFunctionContext,
        PropertyContext,
        PositiveIntegerContext,
        Pick<
            LoweringServices,
            | "absenceTags"
            | "allocateTemporaryCppName"
            | "classLowerer"
            | "callbackIdentity"
            | "captureManagedClosureLines"
            | "compileCallbackWithValues"
            | "compileEngineCreation"
            | "compileForDataSink"
            | "compileStoredDataFunction"
            | "compileStringLiteral"
            | "constArrayLiteral"
            | "defaultEngine"
            | "refuseBorrowedPlatformEventEscape"
            | "emitDiscardedValue"
            | "emitExpressionAsStatement"
            | "callbacks"
            | "emitNativeCallbackStorage"
            | "engineLifecycle"
            | "evaluator"
            | "handleCollections"
            | "isNativeHostUiLookup"
            | "moduleRelativeAssetUrl"
            | "nativeBindingCheckpoint"
            | "options"
            | "moduleNamespaces"
            | "moduleContainerIsMutated"
            | "reachJson"
            | "nativeEmission"
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
        DynamicBindingStorage | undefined
    >;
    /** Host-page element lookups awaiting the retained UI projection. */
    readonly pendingHostUiLookups: Value[];
    /** Module constants the static evaluator still folds. */
    readonly staticConstants: Map<ts.Symbol, ts.Expression>;
    readonly ui: Pick<
        UiProjection,
        "nativeHostUiTags" | "lookupElementId" | "hostCanvas"
    >;
    hasStableNativeBinding(value: Value): boolean;
    importedCall(
        expression: ts.Expression,
        importedName: string,
    ): ts.CallExpression | undefined;
    mutableCapturedParameter(identifier: ts.Identifier, value: Value): boolean;
    nullableResourceKind(
        node: ts.Node,
        allowDirect?: boolean,
    ): { kind: ValueKind; cppType: string } | undefined;
    optionalResourceCpp(value: Value): string;
    unwrappedValueSymbol(expression: ts.Expression): ts.Symbol | undefined;
}

/** A `const` a callback names before the source declares it. */
export type ForwardDeclaration = ts.VariableDeclaration & {
    name: ts.Identifier;
    initializer: ts.Expression;
};

/**
 * Whether an initializer names the binding it initializes, directly or
 * through a function it calls: a method of `const batch: Batch = {...}` that
 * reads `batch` when it runs.
 */
export function initializerNamesBinding(
    checker: ts.TypeChecker,
    symbols: Pick<CompilerSymbols, "valueSymbol">,
    binding: ts.Symbol,
    initializer: ts.Expression,
): boolean {
    let found = false;
    const scanned = new Set<ts.FunctionLikeDeclaration>();
    const visit = (root: ts.Node): void =>
        forEachAnalysisNode(root, (node) => {
            if (found) return "skip";
            if (
                ts.isIdentifier(node) &&
                symbols.valueSymbol(node) === binding
            ) {
                found = true;
                return "skip";
            }
            if (ts.isCallExpression(node)) {
                const called = checker.getResolvedSignature(node)?.declaration;
                if (
                    called &&
                    isSupportedFunction(called) &&
                    called.body &&
                    !scanned.has(called)
                ) {
                    scanned.add(called);
                    visit(called.body);
                    if (found) return "skip";
                }
            }
        });
    visit(initializer);
    return found;
}

export class DeclarationLowerer {
    constructor(private readonly context: DeclarationContext) {}

    private bindOptionalResource(
        name: ts.Identifier,
        cppName: string,
        resource: { kind: ValueKind; cppType: string },
        shared: boolean,
        value: Value,
        initializer = "",
    ): void {
        const type = `std::optional<${resource.cppType}>`;
        this.context.emit(
            shared
                ? {
                      kind: "declaration",
                      type: `std::shared_ptr<${type}>`,
                      name: cppName,
                      initializer: `bbl::js::make_gc_shared<${type}>(${initializer})`,
                  }
                : {
                      kind: "declaration",
                      type,
                      name: cppName,
                      initializer,
                      ...(initializer === ""
                          ? { initialization: "default" as const }
                          : {}),
                      attributes: "[[maybe_unused]] ",
                  },
        );
        const stored: Value = {
            ...value,
            cpp: shared ? `(**${cppName})` : optionalValueCpp(cppName),
            optionalFoundCpp: shared
                ? `${cppName}->has_value()`
                : optionalPresentCpp(cppName),
            optionalStorageCpp: shared ? `(*${cppName})` : cppName,
        };
        if (shared) writable(stored).sharedStorageCpp = cppName;
        else delete writable(stored).sharedStorageCpp;
        this.context.bindings.defineVariable(name, stored);
    }

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
                        this.context.sharedClosures.callRetainsArgument(
                            node,
                            index,
                            true,
                        ) &&
                        someAnalysisNode(callback.body, namesBinding)
                    );
                }),
        );
    }

    /**
     * Later `const` declarations a callback named before the walk reached
     * them: materialized ahead of the callback ("hoisted"), or declared as
     * temporal-dead-zone storage their initializer fills where the source
     * declares it.
     */
    private readonly forwardBindings = new EmissionMap<
        ts.Symbol,
        "hoisted" | { cppName: string; type: DataType }
    >();

    private lexicalBindingType(
        name: ts.Identifier,
        initializer: ts.Expression,
    ): DataType | undefined {
        // A deployment constant the checker leaves untyped (an
        // `import.meta.env` key its declarations omit) holds its folded value.
        const deployed = browserDeploymentValue(this.context, initializer);
        return (
            this.context.dataLowerer.dataTypeAt(name) ??
            this.context.dataTypes.fromCheckedObjectInitializer(initializer) ??
            this.context.dataTypes.fromStoredTsType(
                this.context.checker.getTypeAtLocation(name),
                name,
            ) ??
            (typeof deployed === "string"
                ? { kind: "string" }
                : typeof deployed === "boolean"
                  ? { kind: "boolean" }
                  : undefined)
        );
    }

    /** Storage for a binding read before its initializer runs, as JavaScript's temporal dead zone. */
    private declareLexicalBinding(
        name: ts.Identifier,
        symbol: ts.Symbol,
        type: DataType,
    ): string {
        const cppName = this.context.bindings.cppIdentifier(name.text);
        const cppType = this.context.dataTypes.cppType(type);
        this.context.reachJsData();
        this.context.emit({
            kind: "declaration",
            type: "auto",
            name: cppName,
            initializer: `bbl::js::make_gc_shared<bbl::js::LexicalBinding<${cppType}>>()`,
        });
        this.context.registerNativeBindingType(
            cppName,
            `std::shared_ptr<bbl::js::LexicalBinding<${cppType}>>`,
        );
        this.context.bindings.defineVariable(name, {
            ...this.context.dataLowerer.leafValue(`${cppName}->get()`, type),
            sharedStorageCpp: cppName,
            nativeBinding: true,
        });
        this.context.staticConstants.delete(symbol);
        return cppName;
    }

    private initializeLexicalBinding(
        initializer: ts.Expression,
        cppName: string,
        type: DataType,
    ): void {
        const value = this.context.compileValue(initializer);
        if (value.kind === "void" && value.abruptCompletion) {
            this.context.emitDiscardedValue(value);
            return;
        }
        this.context.emit({
            kind: "expression",
            code: `${cppName}->initialize(${this.context.dataLowerer.compileKnownValueForSink(value, type, initializer)});`,
        });
    }

    /**
     * Makes a later binding a callback reads exist before the callback. When
     * running its initializer early could change its value or reorder an
     * effect (DOM, listeners, audio), or its caller requires declaration-time
     * initialization, the binding is temporal-dead-zone storage its
     * initializer fills where the source declares it; otherwise the
     * declaration is materialized here and skipped when the walk reaches it.
     * A stored closure requires represented temporal-dead-zone storage.
     * A native callback without an owned data type initializes here too,
     * unless `initializeAhead` is false: then nothing is hoisted.
     */
    public hoistForwardBinding(
        declaration: ForwardDeclaration,
        symbol: ts.Symbol,
        initializeAhead = true,
        initialization:
            "early" | "declaration" | "temporal-dead-zone" = "early",
    ): void {
        const pure =
            initialization === "early" &&
            this.context.evaluationOrder.isPureExpression(
                declaration.initializer,
            );
        const type = pure
            ? undefined
            : this.lexicalBindingType(
                  declaration.name,
                  declaration.initializer,
              );
        if (type) {
            this.forwardBindings.set(symbol, {
                cppName: this.declareLexicalBinding(
                    declaration.name,
                    symbol,
                    type,
                ),
                type,
            });
            return;
        }
        if (initialization === "temporal-dead-zone")
            this.context.fail(
                declaration,
                "A stored closure reading a later binding requires an owned data type to preserve its temporal dead zone.",
            );
        if (!pure && !initializeAhead) return;
        this.emitVariableDeclaration(declaration);
        this.forwardBindings.set(symbol, "hoisted");
    }

    /** A module's retained lexical home exists before its lazy evaluation. */
    public prepareModuleBinding(declaration: ts.VariableDeclaration): void {
        if (
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.BlockScoped) === 0
        )
            return this.context.fail(
                declaration,
                "Lazy module var bindings require hoisted undefined storage.",
            );
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
            return this.context.fail(
                declaration,
                "Lazy module bindings require an identifier and initializer.",
            );
        const symbol = this.context.symbols.valueSymbol(declaration.name);
        const mapped = this.lexicalBindingType(
            declaration.name,
            declaration.initializer,
        );
        if (!symbol || !mapped)
            return this.context.fail(
                declaration,
                "Lazy module bindings require an owned data representation.",
            );
        const type = this.context.dataTypes.markStoredObjectReferences(mapped);
        this.forwardBindings.set(symbol, {
            cppName: this.declareLexicalBinding(declaration.name, symbol, type),
            type,
        });
    }

    /**
     * A binding whose `null` and `undefined` the program tells apart
     * (`AbsenceTagStorageRequired`) keeps both in tagged storage: undefined
     * until its initializer or an assignment defines it.
     */
    private emitAbsenceTaggedDeclaration(
        declaration: ts.VariableDeclaration,
        cppName: string,
        sharedClosureStorage: boolean,
    ): boolean {
        if (
            !this.context.absenceTags.has(declaration) ||
            !ts.isIdentifier(declaration.name)
        )
            return false;
        const typeSite = declaration.type ?? declaration.name;
        const stored = this.context.dataTypes.fromStoredTsType(
            declaration.type
                ? this.context.checker.getTypeFromTypeNode(declaration.type)
                : this.context.checker.getTypeAtLocation(declaration.name),
            typeSite,
        );
        const type =
            stored &&
            this.context.dataTypes.absenceTaggedStorage(declaration, stored);
        if (type?.kind !== "tagged") return false;
        this.context.reachJsData();
        const cppType = this.context.dataTypes.cppType(type);
        const initializer = declaration.initializer
            ? this.context.dataLowerer.compileForSink(
                  declaration.initializer,
                  type,
              )
            : undefined;
        this.context.emit(
            sharedClosureStorage
                ? {
                      kind: "declaration",
                      type: "auto",
                      name: cppName,
                      initializer: `bbl::js::make_gc_shared<${cppType}>(${initializer ?? ""})`,
                  }
                : initializer !== undefined
                  ? {
                        kind: "declaration",
                        type: cppType,
                        name: cppName,
                        initializer,
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
        const bound = sharedClosureStorage ? `(*${cppName})` : cppName;
        this.context.dataLowerer.registerLocal(bound, "owned");
        this.context.bindings.defineVariable(declaration.name, {
            ...this.context.dataLowerer.leafValue(bound, type),
            ...(sharedClosureStorage ? { sharedStorageCpp: cppName } : {}),
        });
        return true;
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
        const forward = declarationSymbol
            ? this.forwardBindings.get(declarationSymbol)
            : undefined;
        if (
            forward &&
            declarationSymbol &&
            this.context.bindings.lookupOptional(declaration.name)
        ) {
            this.forwardBindings.delete(declarationSymbol);
            if (forward !== "hoisted")
                this.initializeLexicalBinding(
                    declaration.initializer!,
                    forward.cppName,
                    forward.type,
                );
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
            const type = this.lexicalBindingType(
                declaration.name,
                declaration.initializer,
            );
            if (!type)
                this.context.fail(
                    declaration,
                    "A binding captured by its initializer requires an owned data type.",
                );
            this.initializeLexicalBinding(
                declaration.initializer,
                this.declareLexicalBinding(
                    declaration.name,
                    declarationSymbol,
                    type,
                ),
                type,
            );
            return;
        }
        const sharedClosureStorage =
            this.context.sharedClosures.needsSharedClosureStorage(declaration);
        if (
            this.emitAbsenceTaggedDeclaration(
                declaration,
                cppName,
                sharedClosureStorage,
            )
        )
            return;
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
                            : optionalValueCpp(cppName),
                        ...nullableResourceEngine(
                            resource.kind,
                            this.context.options.workers,
                            this.context.defaultEngineCpp,
                        ),
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
            const declaredType = this.context.checker.getTypeAtLocation(
                declaration.name,
            );
            let dataType = this.context.dataTypes.fromTsType(
                declaredType,
                declaration.name,
            );
            // Only an assignment gives this binding a value.
            if (dataType)
                dataType = this.reboundBindingStorage(dataType, declaredType);
            dataType ??= inferUninitializedHandle(
                declaration,
                this.context.checker,
                this.context.dataTypes,
            );
            dataType ??= inferPromiseRejectStorage(
                declaration,
                this.context.checker,
            );
            dataType ??=
                this.context.dataTypes.undefinedOnlyStorage(declaredType);
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
            ((declaration.type &&
                (ts.isArrowFunction(declaration.initializer) ||
                    ts.isFunctionExpression(declaration.initializer))) ||
                this.isReassignedFunctionLiteral(declaration)) &&
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
        if (
            this.context.engineLifecycle.emitEscapingResolvePromise(
                declaration,
                cppName,
            )
        ) {
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
            this.bindOptionalResource(
                declaration.name,
                cppName,
                nullableResource,
                sharedClosureStorage,
                valueForKind(nullableResource.kind, {
                    cpp: "",
                    ...nullableResourceEngine(
                        nullableResource.kind,
                        this.context.options.workers,
                        this.context.defaultEngineCpp,
                    ),
                }),
            );
            return;
        }

        const hostLookup = this.context.unwrap(declaration.initializer);
        const id =
            !this.context.defaultEngineCpp &&
            !this.context.options.workers &&
            ts.isCallExpression(hostLookup) &&
            this.context.isNativeHostUiLookup(hostLookup)
                ? this.context.ui.lookupElementId(hostLookup)
                : undefined;
        const tag =
            id !== undefined
                ? this.context.ui.nativeHostUiTags().get(id)
                : undefined;
        if (id !== undefined && tag !== undefined) {
            const value: Value = {
                kind: "ui-element",
                cpp: cppName,
                uiHostId: id,
                uiTag: tag,
                truthinessCpp: "true",
                ...this.context.ui.hostCanvas(id, tag, hostLookup),
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
                this.context.sharedClosures.identifierIsRebound(
                    declaration.name,
                )
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

        // `const K = class { ... }` declares the class `K`: what the
        // declaration runs (static fields and blocks) runs here.
        const classExpression = this.context.unwrap(declaration.initializer);
        if (ts.isClassExpression(classExpression)) {
            if (
                localClassOfSymbol(
                    this.context.symbols.valueSymbol(declaration.name),
                ) !== classExpression
            )
                this.context.fail(
                    declaration.initializer,
                    "A class expression is lowered as the initializer of a const it names.",
                );
            this.context.classLowerer.emitDeclaration(classExpression);
            return;
        }
        const forwardCallback = this.prepareForwardFunctionResult(
            declaration,
            cppName,
        );
        const initializerBoundary = this.context.nativeBindingCheckpoint();
        let value = this.context.compileValue(declaration.initializer);
        if (value.kind === "record" && declaration.type) {
            value = this.context.bindings.materializeDeclaredRecordContainers(
                value,
                this.context.checker.getTypeFromTypeNode(declaration.type),
                declaration.initializer,
                `${sourceName}_array`,
            );
        }
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
                const rebound = this.context.sharedClosures.identifierIsRebound(
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
        const initializer = this.context.unwrap(declaration.initializer);
        const aliasesRecord =
            ts.isIdentifier(initializer) ||
            ts.isPropertyAccessExpression(initializer) ||
            ts.isElementAccessExpression(initializer);
        // A named or selected record already owns its fields. Allocating a
        // fresh object here would split aliases and discard their known facts.
        if (!aliasesRecord)
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
            this.bindOptionalResource(
                declaration.name,
                cppName,
                nullableResource,
                sharedClosureStorage,
                value,
                initializerCpp,
            );
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
            if (
                this.context.sharedClosures.identifierIsRebound(
                    declaration.name,
                )
            ) {
                this.context.fail(
                    declaration,
                    "Reassigning an engine alias is not supported.",
                );
            }
            this.context.bindings.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "void") {
            // `void x`, or a call whose completion is proven undefined: the
            // effects run here and the binding is `undefined`.
            if (
                !value.abruptCompletion &&
                !value.coroutineResult &&
                !this.context.sharedClosures.identifierIsRebound(
                    declaration.name,
                ) &&
                provenUndefinedValue(this.context, declaration.initializer)
            ) {
                this.context.emitDiscardedValue(value);
                this.context.bindings.defineVariable(declaration.name, {
                    kind: "json-null",
                    cpp: "std::nullopt",
                });
                return;
            }
            this.context.fail(
                declaration.initializer,
                `Expression assigned to '${sourceName}' does not produce a native value.`,
            );
        }
        if (value.kind === "callback" || isCompileTimeOnlyValue(value.kind)) {
            const accessors = [
                ...Object.values(value.recordGetters ?? {}),
                ...Object.values(value.recordSetters ?? {}),
            ];
            const accessorWrites = accessors.length
                ? this.context.evaluationOrder.bodyAccess(accessors).writes
                : undefined;
            if (
                value.kind === "record" &&
                !aliasesRecord &&
                (accessorWrites?.heap ||
                    accessorWrites?.any ||
                    this.inferredObjectIsMutated(declaration.name))
            ) {
                // Accessor bodies can mutate their receiver even when a caller
                // only consumes a scalar result through a structural view.
                value = this.context.bindings.materializeRecordScalars(
                    value,
                    `${sourceName}_fields`,
                    true,
                );
            }
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
                this.context.sharedClosures.identifierIsRebound(
                    declaration.name,
                );
            const boundCpp = sharedDataBinding ? `(*${cppName})` : cppName;
            const selectedCpp = narrowed.ownedCpp ?? narrowed.cpp;
            // A borrowing local reads its owner; only an owning one takes a
            // temporary.
            const transferredCpp =
                !narrowed.borrowedData &&
                !stableOwnerAlias &&
                selectedCpp === narrowed.cpp
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
                readsNativeStorage(narrowed) &&
                (wrapperCopiesIdentity || referenceStruct)
            ) {
                this.context.reachJsData();
                initializerCpp = snapshotReadCpp(narrowed);
            }
            const slotFoundCpp = this.pinSlotFound(
                narrowed.slotFoundCpp,
                narrowedFound,
                referenceStruct ? undefined : optionalFoundCpp,
            );
            const reference =
                stableOwnerAlias ||
                (aliases && !wrapperCopiesIdentity) ||
                narrowed.borrowedData;
            // An alias of a read-only reference parameter is a const handle,
            // through which the shared record stays writable.
            const constant =
                reference && referenceStruct && narrowed.readOnly
                    ? "const "
                    : "";
            this.context.emit({
                kind: "declaration",
                name: cppName,
                type: sharedDataBinding
                    ? "auto"
                    : stableOwnerAlias && narrowed.dataType.kind === "string"
                      ? "auto&"
                      : `${constant}${localType}${reference ? "&" : ""}`,
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
                          optionalValueCpp(boundCpp),
                          narrowed.dataType.inner,
                      )
                    : undefined;
            this.context.bindings.defineVariable(
                declaration.name,
                valueForKind(optionalHandle?.kind ?? "data", {
                    ...(optionalHandle ??
                        (narrowed.dataType.kind === "error" ||
                        narrowed.dataType.kind === "module-namespace"
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
                    ...(referenceStruct && narrowed.staticElementsOwner
                        ? {
                              staticElementsOwner: narrowed.staticElementsOwner,
                              ...(narrowed.staticElementIndex !== undefined
                                  ? {
                                        staticElementIndex:
                                            narrowed.staticElementIndex,
                                    }
                                  : {}),
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
                    ...(narrowed.packagedBodySource &&
                    !this.context.sharedClosures.identifierIsRebound(
                        declaration.name,
                    )
                        ? { packagedBodySource: narrowed.packagedBodySource }
                        : {}),
                    ...(narrowed.nativeVectorData
                        ? { nativeVectorData: true as const }
                        : {}),
                    ...(narrowed.preserveUncheckedLookup
                        ? { preserveUncheckedLookup: true as const }
                        : {}),
                    ...(slotFoundCpp ? { slotFoundCpp } : {}),
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
        const stableOwnerAlias = this.borrowsConstBinding(declaration, value);
        // A borrowing local reads its owner; only an owning one takes a
        // temporary.
        let initializerCpp =
            value.ownedCpp ??
            (stableOwnerAlias
                ? value.cpp
                : this.context.takeNativeTemporary(
                      value.cpp,
                      initializerBoundary,
                  ));
        if (
            !stableOwnerAlias &&
            initializerCpp === value.cpp &&
            readsNativeStorage(value) &&
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
            initializerCpp = snapshotReadCpp(value);
        }
        const sharedBinding =
            sharedClosureStorage &&
            (isHandleKind(value.kind) ||
                this.context.sharedClosures.isSharedClosureScalar(
                    value.dataType?.kind === "enum" ? "enum" : value.kind,
                ));
        const boundCpp = sharedBinding ? `(*${cppName})` : cppName;
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
            type: sharedBinding
                ? "auto"
                : stableOwnerAlias
                  ? "auto&"
                  : nativeType,
            initializer: sharedBinding
                ? `bbl::js::make_gc_shared<${nativeType === "auto" ? `std::decay_t<decltype(${initializerCpp})>` : nativeType}>(${initializerCpp})`
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
        const slotFoundCpp = this.pinSlotFound(
            value.slotFoundCpp,
            valueFound,
            optionalFoundCpp,
        );
        // Either spelling reads through the emitted variable, so a static
        // value the initializer carried must not fold past it.
        const stored: Value = {
            ...value,
            cpp: boundCpp,
            ...(sharedBinding ? { sharedStorageCpp: cppName } : {}),
            ...(optionalFoundCpp
                ? {
                      optionalFoundCpp,
                      nativeCompanionCaptures: {
                          ...value.nativeCompanionCaptures,
                          optionalFoundCpp: [
                              this.context.registerNativeConstBinding(
                                  optionalFoundCpp,
                              ),
                          ],
                      },
                  }
                : {}),
            ...(slotFoundCpp ? { slotFoundCpp } : {}),
            nativeBinding: true,
        };
        // The local reads its own storage, not a counted loop's counter.
        delete writable(stored).integerCounterCpp;
        if (!sharedBinding) delete writable(stored).sharedStorageCpp;
        if (value.kind === "animation-clip") {
            writable(stored).animationFrameRate = `${cppName}.frame_rate`;
            writable(stored).animationDuration = `${cppName}.duration`;
        }
        if (
            declaration.parent !== undefined &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) === 0
        ) {
            // Mutable locals must never fold to their initial value:
            // later reads reference the native local, not the constant
            // the declaration happened to start from.
            delete writable(stored).staticNumber;
            delete writable(stored).staticString;
            delete writable(stored).staticBoolean;
            delete writable(stored).packagedBodySource;
        }
        this.context.bindings.defineVariable(declaration.name, stored);
    }

    /**
     * A local keeps whether its initializer's slot existed as of its own
     * initialization (`Value.slotFoundCpp`), not as of a later read of an
     * owner that may have grown. When that test is the presence test the
     * declaration already snapshotted, the snapshot serves both.
     */
    private pinSlotFound(
        slotFoundCpp: string | undefined,
        presenceTest: string | undefined,
        discardIfUnused: string | undefined,
    ): string | undefined {
        if (
            slotFoundCpp === undefined ||
            cppIdentifierPattern.test(slotFoundCpp)
        ) {
            return slotFoundCpp;
        }
        if (discardIfUnused && slotFoundCpp === presenceTest) {
            return discardIfUnused;
        }
        const name = this.context.allocateTemporaryCppName("slot_found");
        this.context.emit({
            kind: "declaration",
            type: "const bool",
            name,
            initializer: slotFoundCpp,
            attributes: "[[maybe_unused]] ",
            discardIfUnused: true,
        });
        return name;
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
        const visited = new Set<ts.Symbol>();
        const collect = (identifier: ts.Identifier): void => {
            const symbol = this.context.symbols.valueSymbol(identifier);
            if (!symbol || visited.has(symbol)) return;
            visited.add(symbol);
            aliasedMutationScan(
                identifier,
                (candidate) => this.context.symbols.valueSymbol(candidate),
                {
                    aliasingInitializer: (expression, scan) => {
                        const unwrapped = this.context.unwrap(expression);
                        return (
                            ts.isIdentifier(unwrapped) &&
                            scan.namesAlias(unwrapped)
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
                        if (ts.isCallExpression(node)) {
                            const called =
                                this.context.checker.getResolvedSignature(
                                    node,
                                )?.declaration;
                            if (isSupportedFunction(called) && called.body) {
                                node.arguments.forEach((argument, index) => {
                                    const parameter =
                                        called.parameters[index]?.name;
                                    if (
                                        scan.namesAlias(
                                            this.context.unwrap(argument),
                                        ) &&
                                        parameter &&
                                        ts.isIdentifier(parameter)
                                    )
                                        collect(parameter);
                                });
                            }
                        }
                        return assigned.size === callbacks.size;
                    },
                },
            );
        };
        collect(name);
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
            writable((writable(owner).recordProperties ??= {}))[key] = {
                ...this.context.dataLowerer.leafValue(`(*${slot})`, type),
                nativeLvalue: true,
                sharedStorageCpp: slot,
                nativeCaptures: [capture],
            };
            if (owner.recordMethods) delete writable(owner.recordMethods)[key];
            initializers.push(() =>
                this.context.emit({
                    kind: "expression",
                    code: `(*${slot}) = ${this.context.dataLowerer.compileKnownValueForSink(callback, type, site)};`,
                }),
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
        const declaredType = this.context.checker.getTypeAtLocation(name);
        const signatures = declaredType.getCallSignatures();
        // A function object with properties is a callable record.
        if (
            signatures.length !== 1 ||
            this.context.checker.getPropertiesOfType(declaredType).length > 0
        )
            return undefined;
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
            this.context.emit({
                kind: "expression",
                code: `${forward.storageCpp} = ${value.cpp};`,
            });
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
            // The slot is a void function: the callback's result, typed
            // `void` (a generic result instantiated as `void` included),
            // is discarded.
            const compile = () =>
                this.context.compileCallbackWithValues(
                    value.callbackDeclaration!,
                    arguments_,
                    declaration.initializer!,
                    true,
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
        this.context.emit({
            kind: "expression",
            code: `${forward.storageCpp} = ${this.context.nativeEmission.renderSharedClosure(compiled, "void", value.callbackDeclaration, parameters.join(", "), forward.parameterNames)};`,
        });
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
                this.context.emit({
                    kind: "declaration",
                    type: "const auto",
                    name: identity,
                    initializer: "bbl::js::next_callback_identity()",
                    attributes: "[[maybe_unused]] ",
                });
                this.context.registerNativeBinding(
                    identity,
                    false,
                    false,
                    "const std::size_t",
                );
                writable(value.callbackRecordOwner).runtimeCallbackIdentityCpp =
                    identity;
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
            this.context.emit({
                kind: "expression",
                code: `${value.cpp} = ${compiled};`,
            });
            return;
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
        this.context.callbacks.hoistForwardCallbackBindings(callback);
        let parameterDeclarations: string[] = [];
        const emitCallbackBody = (): void => {
            const captured = captureDataFunctionBody(
                this.context,
                parameters,
                returnType,
                () => {
                    // An expression body is the value its one `return` hands back.
                    if (ts.isBlock(callbackBody))
                        emitReachableStatements(
                            this.context,
                            callbackBody.statements,
                        );
                    else if (returnType)
                        this.context.emit({
                            kind: "control",
                            code: `return ${this.context.compileForDataSink(callbackBody, returnType)};`,
                            transfer: "return",
                        });
                    else this.context.emitExpressionAsStatement(callbackBody);
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
        this.context.emit({
            kind: "expression",
            code: `${storage.cpp} = ${this.context.nativeEmission.renderSharedClosure(compiled, returnCpp, callback, parameterDeclarations.join(", "), [])};`,
        });
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

    /**
     * A function literal a later assignment replaces: storage of its type,
     * whether that type is written or inferred from the initializer.
     */
    private isReassignedFunctionLiteral(
        declaration: ts.VariableDeclaration,
    ): boolean {
        return (
            declaration.initializer !== undefined &&
            (ts.isArrowFunction(declaration.initializer) ||
                ts.isFunctionExpression(declaration.initializer)) &&
            ts.isIdentifier(declaration.name) &&
            this.context.sharedClosures.identifierIsRebound(declaration.name)
        );
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
            const storage = this.context.dynamicBindings.get(declaration);
            if (storage) {
                const source = this.context.checker.getTypeAtLocation(name);
                const mapped =
                    typeof storage === "object"
                        ? this.context.dataTypes.fromStoredTsType(
                              storage.nativeType,
                              storage.node,
                          )
                        : storage === "error-array"
                          ? undefined
                          : this.context.dataTypes.fromStoredTsType(
                                source,
                                declaration,
                            );
                let type: DataType | undefined = mapped;
                if (typeof storage === "object" && type) {
                    const absent = nullability(source);
                    if (absent.null || absent.undefined)
                        type = this.context.dataTypes.nullableType(
                            type,
                            !absent.null,
                        );
                } else if (storage === "error-array") {
                    type = { kind: "vector", element: { kind: "error" } };
                } else if (storage === "array") {
                    const indexed = this.context.checker.getIndexTypeOfType(
                        source,
                        ts.IndexKind.Number,
                    );
                    const element =
                        mapped?.kind === "vector" || mapped?.kind === "span"
                            ? mapped.element
                            : indexed &&
                              this.context.dataTypes.fromStoredTsType(
                                  indexed,
                                  declaration,
                              );
                    type = element ? { kind: "vector", element } : undefined;
                }
                if (!type)
                    this.context.fail(
                        declaration,
                        "Demanded binding no longer has a native storage representation.",
                    );
                // Retained readonly arrays own their initializer just like
                // returned arrays; a span would outlive a temporary projection.
                type = this.context.dataTypes.ownReturnedArray(type);
                this.context.reachJsData();
                const literal = this.context.unwrap(declaration.initializer);
                const arraySnapshot =
                    type.kind === "vector" &&
                    type.element.kind === "struct" &&
                    !sharedClosureStorage &&
                    !this.context.sharedClosures.identifierIsRebound(name) &&
                    ts.isArrayLiteralExpression(literal) &&
                    literal.elements.every(ts.isObjectLiteralExpression)
                        ? this.context.compileValue(literal)
                        : undefined;
                const engineRecordSnapshot =
                    this.hasReadonlyEngineField(type, declaration) &&
                    !this.context.sharedClosures.identifierIsRebound(name)
                        ? this.context.compileValue(declaration.initializer)
                        : undefined;
                const snapshot = arraySnapshot ?? engineRecordSnapshot;
                const initializer = snapshot
                    ? this.context.dataLowerer.compileKnownValueForSink(
                          snapshot,
                          type,
                          declaration.initializer,
                      )
                    : this.context.dataLowerer.compileForSink(
                          declaration.initializer,
                          type,
                      );
                this.context.emit({
                    kind: "declaration",
                    type: sharedClosureStorage
                        ? "auto"
                        : this.context.dataTypes.cppType(type),
                    name: cppName,
                    initializer: sharedClosureStorage
                        ? `bbl::js::make_gc_shared<${this.context.dataTypes.cppType(type)}>(${initializer})`
                        : initializer,
                });
                const bound: Value = {
                    ...this.context.dataLowerer.leafValue(
                        sharedClosureStorage ? `(*${cppName})` : cppName,
                        type,
                    ),
                    ...(type.kind === "struct" &&
                    ts.isObjectLiteralExpression(
                        this.context.unwrap(declaration.initializer),
                    ) &&
                    !this.context.sharedClosures.identifierIsRebound(name)
                        ? { optionalFoundCpp: "true" }
                        : {}),
                    ...(sharedClosureStorage
                        ? { sharedStorageCpp: cppName }
                        : {}),
                };
                if (engineRecordSnapshot) {
                    const properties = this.projectReadonlyEngineProperties(
                        bound.cpp,
                        type,
                        engineRecordSnapshot,
                        declaration,
                    );
                    if (properties)
                        writable(bound).recordProperties = properties;
                }
                this.context.bindings.defineVariable(name, bound);
                if (arraySnapshot)
                    this.context.dataLowerer.retainArrayLiteralFacts(
                        bound,
                        arraySnapshot,
                        declaration.initializer,
                    );
                const symbol = this.context.symbols.valueSymbol(name);
                if (symbol) this.context.staticConstants.delete(symbol);
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
        let annotated = this.context.sharedClosures.identifierIsRebound(name)
            ? this.context.dataTypes.fromStoredTsType(declaredType, typeSite)
            : this.context.dataTypes.fromTsType(declaredType, typeSite);
        const declaredRecord =
            annotated?.kind === "optional" ? annotated.inner : annotated;
        if (declaredRecord?.kind === "struct") {
            const sourceType = this.context.checker.getTypeAtLocation(
                declaration.initializer,
            );
            const actual = this.context.dataTypes.fromTsType(
                sourceType,
                declaration.initializer,
            );
            const native = actual?.kind === "optional" ? actual.inner : actual;
            if (
                native &&
                (isOpaqueReference(native) || native.kind === "event-target")
            ) {
                const absent = nullability(declaredType);
                annotated =
                    absent.null || absent.undefined
                        ? this.context.dataTypes.nullableType(
                              native,
                              !absent.null,
                          )
                        : actual;
            }
        }
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
        if (annotated && this.context.sharedClosures.identifierIsRebound(name))
            annotated = this.reboundBindingStorage(annotated, declaredType);
        if (annotated)
            annotated = this.context.dataTypes.numericSlotStorage(
                declaration,
                declaredType,
                annotated,
            );
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
            (this.inferredArrayIsMutated(name) ||
                this.context.moduleContainerIsMutated(name));
        const initializer = this.context.unwrap(declaration.initializer);
        if (
            !annotated &&
            inferredMutableArray &&
            ts.isArrayLiteralExpression(initializer) &&
            initializer.elements.length === 0
        ) {
            annotated = this.evolvedArrayType(name);
        }
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
            !this.context.moduleContainerIsMutated(name) &&
            !this.context.sharedClosures.identifierIsRebound(name)
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
        // An accessor record keeps its compile-time form, whose reads run the
        // getters in place, unless the binding is rebound: then it is stored
        // in a native record whose accessor slots run them.
        if (
            !declaration.type &&
            inferredPlainObject &&
            !this.context.sharedClosures.identifierIsRebound(name) &&
            this.initializerProducesAccessorRecord(initializer)
        ) {
            return false;
        }
        const mutablePlainObject =
            ts.isIdentifier(name) &&
            inferredPlainObject &&
            (ts.isObjectLiteralExpression(initializer) ||
            ts.isConditionalExpression(initializer)
                ? this.inferredObjectIsMutated(name) ||
                  this.context.moduleContainerIsMutated(name)
                : this.context.sharedClosures.identifierIsRebound(name));
        const inferredMutableObject = !declaration.type && mutablePlainObject;
        const explicitlyTypedMutableEntryObject =
            declaration.type !== undefined &&
            mutablePlainObject &&
            (this.context.defaultEngine() !== undefined ||
                this.context.options.workers !== undefined);
        const inferredReboundFunction =
            !declaration.type &&
            annotated?.kind === "function" &&
            this.isReassignedFunctionLiteral(declaration);
        if (
            !declaration.type &&
            !inferredMutableArray &&
            !inferredMutableObject &&
            !inferredReboundFunction
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
            const arrayType =
                inferredMutableArray && annotated?.kind === "vector"
                    ? annotated
                    : undefined;
            const result = this.context.probeEmission(
                () => {
                    try {
                        const value = this.context.compileValue(source);
                        if (isJsonValue(value)) return value;
                        // Nominal resource interfaces can describe several
                        // native shapes; prove the actual array sink too.
                        if (arrayType)
                            this.context.dataLowerer.compileKnownValueForSink(
                                value,
                                arrayType,
                                source,
                            );
                        return true;
                    } catch (error) {
                        if (error instanceof CompileError)
                            return arrayType === undefined;
                        throw error;
                    }
                },
                // JSON retains this registry; every other outcome rolls back
                // and carries only its boolean admission result outside it.
                (value) => typeof value !== "boolean",
            );
            if (typeof result !== "boolean")
                return this.emitDynamicDataBinding(
                    name,
                    cppName,
                    result,
                    source,
                    sharedClosureStorage,
                );
            if (!result) return false;
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
                annotated.inner.kind === "handle" &&
                annotated.inner.handle !== "worker-media-query") ||
            (annotated.kind === "tuple" &&
                !ts.isArrayLiteralExpression(initializerLiteral) &&
                !ts.isConditionalExpression(initializerLiteral))
        ) {
            // Readonly views keep the legacy static-tuple declaration
            // semantics; only owning composites (and mutable tuple
            // locals initialized from array literals or their conditional) take the data
            // path. An optional HANDLE local (`Mesh | undefined` from a
            // search) keeps the value path too: a handle a search
            // produced carries its found flag, which is this port's
            // representation of that optionality. Media queries instead own
            // a shared runtime object and can use ordinary nullable storage.
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
        const initializerReferencesBinding =
            declarationSymbol !== undefined &&
            initializerNamesBinding(
                this.context.checker,
                this.context.symbols,
                declarationSymbol,
                initializer,
            );
        // A record whose own methods name its binding (`batch.keyAt(i)` in a
        // method of `const batch: Batch = {...}`) is one shared object. An
        // object literal binds the name to the object it creates before its
        // methods capture it; through any other initializer the methods read
        // a shared cell when they run, after it is filled.
        if (initializerReferencesBinding && annotated.kind === "struct")
            this.context.dataTypes.markStoredObjectReferences(annotated);
        const selfLiteral =
            initializerReferencesBinding &&
            annotated.kind === "struct" &&
            ts.isObjectLiteralExpression(initializer) &&
            !initializer.properties.some(ts.isSpreadAssignment) &&
            !this.context.sharedClosures.identifierIsRebound(name)
                ? initializer
                : undefined;
        const selfReferentialBinding =
            initializerReferencesBinding &&
            !selfLiteral &&
            (annotated.kind === "function" ||
                (annotated.kind === "struct" &&
                    this.context.dataTypes.isReferenceStruct(annotated.name)));
        const sharedDataBinding =
            !selfReferentialBinding &&
            sharedClosureStorage &&
            this.context.sharedClosures.identifierIsRebound(name);
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
        const readonlyEngineCall =
            ts.isCallExpression(initializer) &&
            !this.context.sharedClosures.identifierIsRebound(name) &&
            this.hasReadonlyEngineField(annotated, initializer);
        const initializerSnapshot =
            readonlyEngineCall ||
            (annotated.kind === "http-response" &&
                !this.context.sharedClosures.identifierIsRebound(name)) ||
            (spreadTarget &&
                ((ts.isObjectLiteralExpression(initializer) &&
                    !initializer.properties.some(ts.isSpreadAssignment)) ||
                    ts.isConditionalExpression(initializer)))
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
                this.context.emit({
                    kind: "expression",
                    code: `(*${cppName}) = std::move(${targetCpp});`,
                });
            }
        } else {
            const source = declaration.initializer;
            const lowerInitializer = (): string =>
                this.context.takeNativeTemporary(
                    initializerSnapshot
                        ? this.context.dataLowerer.compileKnownValueForSink(
                              initializerSnapshot,
                              annotated,
                              source,
                          )
                        : this.context.dataLowerer.compileForSink(
                              source,
                              annotated,
                          ),
                    initializerBoundary,
                );
            const initializerCpp = selfLiteral
                ? withLiteralSelfBinding(
                      selfLiteral,
                      { name, cppName },
                      lowerInitializer,
                  )
                : lowerInitializer();
            if (selfLiteral && initializerCpp !== cppName)
                this.context.fail(
                    declaration,
                    `Record '${name.text}' names itself in its methods, but its literal did not create the object the binding holds.`,
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
            if (!selfLiteral)
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
        // A spread element contributes as many elements as its source holds.
        if (
            ts.isArrayLiteralExpression(initializer) &&
            !initializer.elements.some(ts.isSpreadElement) &&
            ts.isIdentifier(name) &&
            isNeverResized(
                this.context.checker,
                name,
                initializer.elements.length,
            )
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
            ...(readonlyEngineCall
                ? {}
                : (initializerSnapshot?.recordProperties ?? {})),
        };
        if (readonlyEngineCall && initializerSnapshot)
            Object.assign(
                staticRecordProperties,
                this.projectReadonlyEngineProperties(
                    boundCpp,
                    annotated,
                    initializerSnapshot,
                    initializer,
                ),
            );
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
            ...(annotated.kind === "struct"
                ? nativeDataMetadata(
                      this.context.dataLowerer.leafValue(boundCpp, annotated),
                  )
                : {}),
            ...(initializerSnapshot?.packagedBodySource
                ? { packagedBodySource: initializerSnapshot.packagedBodySource }
                : {}),
            ...(sharedDataBinding || selfReferentialBinding
                ? { sharedStorageCpp: cppName }
                : {}),
            dataType: annotated,
            // A key a conditional spread decides is own while its field is.
            ...(annotated.kind === "struct" &&
            initializerSnapshot?.kind === "record" &&
            ts.isIdentifier(name) &&
            !mutablePlainObject &&
            ownKeysKnown(this.context, initializerSnapshot, name)
                ? {
                      recordOwnKeys: Object.keys(
                          initializerSnapshot.recordProperties ?? {},
                      ),
                  }
                : annotated.kind === "enummap" &&
                    ts.isObjectLiteralExpression(initializer) &&
                    !this.context.sharedClosures.identifierIsRebound(name)
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
            ...((ts.isConditionalExpression(initializer) ||
                ts.isObjectLiteralExpression(initializer)) &&
            settledPresence !== undefined &&
            !this.context.sharedClosures.identifierIsRebound(name)
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
                : annotated.kind === "promise" ||
                    annotated.kind === "module-namespace"
                  ? withNativeMetadata(
                        this.context.dataValue(boundCpp, annotated),
                        boundValue,
                    )
                  : boundValue;
        // The literal or the shared cell already bound the name.
        if (selfReferentialBinding || selfLiteral) {
            this.context.bindings.rebindVariable(name, represented);
        } else {
            this.context.bindings.defineVariable(name, represented);
        }
        return true;
    }

    /**
     * A rebound binding holds whichever object was assigned last. A readonly
     * array it holds is owned, like a parameter's, and a record is a shared
     * object, so each assignment reseats the name instead of copying into
     * the object an alias still names.
     */
    private reboundBindingStorage(
        type: DataType,
        declaredType: ts.Type,
    ): DataType {
        const owned = this.context.dataTypes.ownReadonlyArray(
            type,
            declaredType,
        );
        return owned.kind === "struct"
            ? this.context.dataTypes.markStoredObjectReferences(owned)
            : owned;
    }

    private hasReadonlyEngineField(type: DataType, node: ts.Node): boolean {
        return (
            type.kind === "struct" &&
            this.context.dataTypes
                .structFields(type.name, node, "accessors")
                .some(
                    (field) =>
                        field.readOnly &&
                        field.type.kind === "handle" &&
                        field.type.handle === "engine",
                )
        );
    }

    /** Read live fields from storage; only proven readonly owners keep identity. */
    private projectReadonlyEngineProperties(
        cpp: string,
        type: DataType,
        source: Value,
        node: ts.Node,
    ): Record<string, Value> | undefined {
        if (type.kind !== "struct") return undefined;
        const memberAccess = this.context.dataTypes.isReferenceStruct(type.name)
            ? "->"
            : ".";
        const properties: Record<string, Value> = {};
        for (const field of this.context.dataTypes.structFields(
            type.name,
            node,
            "accessors",
        )) {
            if (field.accessor) continue;
            const member = this.context.dataLowerer.leafValue(
                `${cpp}${memberAccess}${field.name}`,
                field.type,
            );
            const identity = field.readOnly
                ? source.recordProperties?.[field.sourceName]?.engineIdentity
                : undefined;
            if (identity && member.kind === "engine")
                writable(member).engineIdentity = identity;
            properties[field.sourceName] = member;
        }
        return properties;
    }

    /** TypeScript's evolved reads supply storage for an initially empty array. */
    private evolvedArrayType(identifier: ts.Identifier): DataType | undefined {
        const checker = this.context.checker;
        const symbol = this.context.symbols.valueSymbol(identifier);
        if (!symbol) return undefined;
        let scope: ts.Node = identifier.parent;
        while (!ts.isBlock(scope) && !ts.isSourceFile(scope))
            scope = scope.parent;
        const candidates: ts.Type[] = [];
        forEachAnalysisNode(scope, (node) => {
            if (
                !ts.isIdentifier(node) ||
                node === identifier ||
                this.context.symbols.valueSymbol(node) !== symbol
            )
                return;
            const type = checker.getTypeAtLocation(node);
            if (!checker.isArrayType(type)) return;
            const element = checker.getIndexTypeOfType(
                type,
                ts.IndexKind.Number,
            );
            if (
                !element ||
                (element.flags &
                    (ts.TypeFlags.Any |
                        ts.TypeFlags.Unknown |
                        ts.TypeFlags.Never)) !==
                    0
            )
                return;
            candidates.push(type);
        });
        // TypeScript evolves `const values = []` at each read. Its widest
        // compatible read supplies the array type after branch/loop appends.
        const type = candidates.find((candidate) =>
            candidates.every((other) =>
                checker.isTypeAssignableTo(other, candidate),
            ),
        );
        return type
            ? this.context.dataTypes.fromStoredTsType(type, identifier)
            : undefined;
    }

    /**
     * Alias writes, mutating methods and escapes require owning array
     * storage: an array reaching another owner -- a call or construction
     * argument, a field, an element, a default, or a return out of the
     * function declaring it -- can be written through that owner, and
     * JavaScript keeps one array for both.
     */
    private inferredArrayIsMutated(identifier: ts.Identifier): boolean {
        const declaringFunction = ts.findAncestor(
            identifier.parent,
            ts.isFunctionLike,
        );
        /** Whether `expression`'s value is a tracked alias itself. */
        const valueNamesAlias = (
            expression: ts.Expression,
            scan: AliasedMutationScan,
        ): boolean => {
            const value = this.context.unwrap(expression);
            if (ts.isConditionalExpression(value))
                return (
                    valueNamesAlias(value.whenTrue, scan) ||
                    valueNamesAlias(value.whenFalse, scan)
                );
            if (ts.isBinaryExpression(value)) {
                const operator = value.operatorToken.kind;
                if (operator === ts.SyntaxKind.CommaToken)
                    return valueNamesAlias(value.right, scan);
                if (
                    operator === ts.SyntaxKind.QuestionQuestionToken ||
                    operator === ts.SyntaxKind.BarBarToken ||
                    operator === ts.SyntaxKind.AmpersandAmpersandToken
                )
                    return (
                        valueNamesAlias(value.left, scan) ||
                        valueNamesAlias(value.right, scan)
                    );
            }
            return scan.namesAlias(value);
        };
        const escapes = (node: ts.Node, scan: AliasedMutationScan): boolean =>
            (ts.isPropertyAssignment(node) &&
                valueNamesAlias(node.initializer, scan)) ||
            (ts.isShorthandPropertyAssignment(node) &&
                scan.namesAlias(node.name)) ||
            (ts.isArrayLiteralExpression(node) &&
                node.elements.some(
                    (element) =>
                        !ts.isSpreadElement(element) &&
                        !ts.isOmittedExpression(element) &&
                        valueNamesAlias(element, scan),
                )) ||
            (ts.isNewExpression(node) &&
                (node.arguments ?? []).some(scan.containsAlias)) ||
            ((ts.isPropertyDeclaration(node) ||
                ts.isParameter(node) ||
                ts.isBindingElement(node)) &&
                node.initializer !== undefined &&
                valueNamesAlias(node.initializer, scan)) ||
            (ts.isYieldExpression(node) &&
                node.expression !== undefined &&
                valueNamesAlias(node.expression, scan)) ||
            (ts.isExportAssignment(node) &&
                valueNamesAlias(node.expression, scan)) ||
            (((ts.isReturnStatement(node) &&
                node.expression !== undefined &&
                valueNamesAlias(node.expression, scan)) ||
                (ts.isArrowFunction(node) &&
                    !ts.isBlock(node.body) &&
                    valueNamesAlias(node.body, scan))) &&
                (ts.isArrowFunction(node)
                    ? node
                    : ts.findAncestor(node, ts.isFunctionLike)) !==
                    declaringFunction);
        return aliasedMutationScan(
            identifier,
            (name) => this.context.symbols.valueSymbol(name),
            {
                aliasingInitializer: (initializer, scan) => {
                    const value = this.context.unwrap(initializer);
                    if (valueNamesAlias(value, scan)) return true;
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
                    if (escapes(node, scan)) return true;
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
                        if (!isSupportedFunction(called) || !called.body)
                            return node.arguments.some(
                                (argument, index) =>
                                    scan.containsAlias(argument) &&
                                    engineCallMutatesArgument(
                                        this.context.checker,
                                        node,
                                        index,
                                    ),
                            );
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
        this.bindArrayPattern(
            declaration.name,
            value,
            declaration.initializer,
            initializerBoundary,
        );
    }

    private bindArrayPattern(
        pattern: ts.ArrayBindingPattern,
        value: Value,
        source: ts.Node,
        initializerBoundary = this.context.nativeBindingCheckpoint(),
    ): void {
        const bindings = pattern.elements;
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
            if (element.dotDotDotToken) {
                this.context.fail(
                    element,
                    "A rest binding must be handled by its array owner.",
                );
            }
            // A default applies exactly when the lane is undefined: past
            // the end of the tuple, or present as `undefined`.
            const bound =
                (!present ||
                    (present.kind === "json-null" &&
                        present.cpp === "std::nullopt")) &&
                element.initializer
                    ? this.context.compileValue(element.initializer)
                    : present;
            if (!bound) {
                this.context.fail(
                    element,
                    "The tuple has no element for this binding and it declares no default.",
                );
            }
            if (!ts.isIdentifier(element.name)) {
                this.bindNestedPattern(element.name, bound, element);
                return;
            }
            let stored = this.context.dataLowerer.narrowBindingLane(
                bound,
                element.name,
            );
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
            this.context.emit({
                kind: "declaration",
                type: "const auto",
                name: temporary,
                initializer: value.cpp,
            });
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
                    pattern,
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
                type: "const auto",
                name: temporary,
                initializer: value.cpp,
            });
            const storedVector: Value = {
                ...value,
                cpp: temporary,
            };
            const elementType = value.dataType.element;
            let defaultType: DataType | undefined;
            let defaultsWhenEmpty = false;
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
                if (element.initializer) {
                    if (!defaultType) {
                        const indexed = this.context.checker.getIndexTypeOfType(
                            this.context.checker.getTypeAtLocation(pattern),
                            ts.IndexKind.Number,
                        );
                        const absent = indexed && nullability(indexed);
                        if (absent?.null && absent.undefined)
                            this.context.fail(
                                element,
                                "Destructuring defaults require distinguishable null and undefined array elements.",
                            );
                        defaultsWhenEmpty = Boolean(
                            absent?.undefined &&
                            (elementType.kind === "optional" ||
                                (elementType.kind === "struct" &&
                                    this.context.dataTypes.isReferenceStruct(
                                        elementType.name,
                                    ))),
                        );
                        defaultType =
                            defaultsWhenEmpty && elementType.kind === "optional"
                                ? elementType.inner
                                : elementType;
                    }
                    const type = defaultType;
                    const lane = `${temporary}[${index}]`;
                    const present =
                        `${temporary}.size() > ${index}` +
                        (defaultsWhenEmpty
                            ? ` && ${elementType.kind === "optional" ? optionalPresentCpp(lane) : `static_cast<bool>(${lane})`}`
                            : "");
                    const selected =
                        defaultsWhenEmpty && elementType.kind === "optional"
                            ? `*${lane}`
                            : lane;
                    // An absent lane or stored undefined selects the lazy default.
                    const fallback = this.context.dataLowerer.compileArm(() =>
                        this.context.dataLowerer.compileForSink(
                            element.initializer!,
                            type,
                        ),
                    );
                    this.bindCopiedDefault(
                        element.name,
                        type,
                        `${present} ? ${selected} : ${this.context.dataLowerer.armExpression(element.initializer, fallback.lines, fallback.value, type)}`,
                    );
                    return;
                }
                bindElement(
                    element,
                    this.context.dataLowerer.readVectorBindingElement(
                        storedVector,
                        index,
                        source,
                    ),
                );
            });
            return;
        }
        // A parsed document destructures through iteration: its array
        // elements (or string code points), each another document, with
        // undefined past the end.
        if (isJsonValue(value)) {
            this.context.reachJsData();
            const temporary = this.context.allocateTemporaryCppName(
                "destructure_document",
            );
            this.context.emit({
                kind: "declaration",
                type: "const auto",
                name: temporary,
                initializer: `bbl::js::json_iterated(${value.cpp}, ${bindings.length})`,
            });
            bindings.forEach((element, index) => {
                if (ts.isOmittedExpression(element)) return;
                if (element.dotDotDotToken || element.initializer)
                    this.context.fail(
                        element,
                        "Destructuring a parsed document binds plain elements, without rest or defaults.",
                    );
                bindElement(
                    element,
                    this.context.dataLowerer.leafValue(
                        `${temporary}.at(${index}.0)`,
                        { kind: "json" },
                    ),
                );
            });
            return;
        }
        this.context.fail(
            source,
            "Array destructuring requires a tuple-producing initializer.",
        );
    }

    /**
     * A destructuring default as a binding: a copied local of `type`
     * holding `initializer`, the value the lane or field would have had.
     */
    private bindCopiedDefault(
        name: ts.BindingName,
        type: DataType,
        initializer: string,
    ): void {
        const value = this.context.dataLowerer.leafValue(initializer, type);
        if (
            ts.isIdentifier(name) &&
            this.context.mutableCapturedParameter(name, value)
        ) {
            this.context.bindings.bindParameterValue(name, value);
            return;
        }
        const cppName = ts.isIdentifier(name)
            ? this.context.bindings.cppIdentifier(name.text)
            : this.context.allocateTemporaryCppName("destructure_default");
        this.context.reachJsData();
        this.context.emit({
            kind: "declaration",
            type: this.context.dataTypes.cppType(type),
            name: cppName,
            initializer: initializer,
        });
        const copied = this.context.dataLowerer.leafValue(cppName, type);
        if (ts.isIdentifier(name))
            this.context.bindings.defineVariable(name, copied);
        else this.bindNestedPattern(name, copied, name);
        this.context.dataLowerer.registerLocal(cppName, "copy");
    }

    /**
     * An object pattern over a parsed document: the document is read once,
     * and each binding is the member its key names, itself a document; a
     * default stands in for an undefined member. A rest element refuses.
     */
    private bindDocumentPattern(
        pattern: ts.ObjectBindingPattern,
        value: Value,
    ): void {
        const owner = this.context.bindings.pinValueToTemporary(
            value,
            "destructure_document",
        );
        const documentType: DataType = { kind: "json" };
        this.context.reachJson();
        for (const element of pattern.elements) {
            if (element.dotDotDotToken)
                this.context.fail(
                    element,
                    "Object rest over a parsed document is not represented.",
                );
            const { name, property } = this.bindingProperty(element);
            const member = `${owner.cpp}.get(${stringLiteral(property)})`;
            if (element.initializer) {
                const held =
                    this.context.allocateTemporaryCppName("document_member");
                this.context.emit({
                    kind: "declaration",
                    type: "const bbl::js::JsonValue",
                    name: held,
                    initializer: member,
                });
                const fallback = this.context.dataLowerer.compileArm(() =>
                    this.context.dataLowerer.compileForSink(
                        element.initializer!,
                        documentType,
                    ),
                );
                this.bindCopiedDefault(
                    name,
                    documentType,
                    `${held}.is_undefined() ? ${this.context.dataLowerer.armExpression(element.initializer, fallback.lines, fallback.value, documentType)} : ${held}`,
                );
                continue;
            }
            this.bindCopiedDefault(name, documentType, member);
        }
    }

    private bindNestedPattern(
        pattern: ts.BindingPattern,
        value: Value,
        source: ts.Node,
    ): void {
        if (ts.isObjectBindingPattern(pattern))
            this.bindObjectPattern(pattern, value, source);
        else this.bindArrayPattern(pattern, value, source);
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
        if (value.dataType?.kind === "module-namespace") {
            value = this.context.bindings.pinValueToTemporary(
                value,
                "module_destructure",
            );
            this.emitRecordBindingDeclaration(pattern, value);
            return;
        }
        if (value.kind === "record") {
            this.emitRecordBindingDeclaration(pattern, value);
            return;
        }
        if (isJsonValue(value)) {
            this.bindDocumentPattern(pattern, value);
            return;
        }
        if (value.kind === "data" && value.dataType?.kind === "struct") {
            // Retain the selected object before a binding's default can replace
            // its source slot. Value-layout records still read their live fields.
            const owner = this.context.dataTypes.isReferenceStruct(
                value.dataType.name,
            )
                ? this.context.bindings.pinValueToTemporary(
                      value,
                      "destructure_owner",
                  )
                : value;
            const temporary =
                this.context.allocateTemporaryCppName("destructure");
            this.context.emit({
                kind: "declaration",
                type: "auto&&",
                name: temporary,
                initializer: owner.cpp,
            });
            const consumed = new EmissionSet<string>();
            for (const element of pattern.elements) {
                if (element.dotDotDotToken) {
                    this.bindStructRest(
                        element,
                        { ...owner, cpp: temporary },
                        consumed,
                    );
                    continue;
                }
                const { name, property } = this.bindingProperty(element);
                consumed.add(property);
                const absent = this.context.dataLowerer.absentBindingValue(
                    element,
                    value.dataType.name,
                    property,
                );
                if (absent && ts.isIdentifier(name)) {
                    this.context.bindings.defineVariable(name, absent);
                    continue;
                }
                const field = this.context.dataTypes.structField(
                    value.dataType.name,
                    property,
                    element,
                    "accessors",
                );
                const slotCpp = `${temporary}${this.context.dataTypes.isReferenceStruct(value.dataType.name) ? "->" : "."}${field.name}`;
                // An accessor's getter runs once; the binding owns its result.
                const storedFieldCpp = field.accessor
                    ? this.context.allocateTemporaryCppName("accessed")
                    : slotCpp;
                if (field.accessor)
                    this.context.emit({
                        kind: "declaration",
                        type: this.context.dataTypes.cppType(field.type),
                        name: storedFieldCpp,
                        initializer: `${slotCpp}.get()`,
                    });
                if (
                    element.initializer &&
                    (field.type.kind === "optional" ||
                        (field.type.kind === "struct" &&
                            this.context.dataTypes.isReferenceStruct(
                                field.type.name,
                            )))
                ) {
                    const sourceProperty =
                        this.context.checker.getPropertyOfType(
                            this.context.checker.getTypeAtLocation(pattern),
                            property,
                        );
                    const absent =
                        sourceProperty &&
                        nullability(
                            this.context.checker.getTypeOfSymbolAtLocation(
                                sourceProperty,
                                pattern,
                            ),
                        );
                    if (absent?.null && absent.undefined)
                        this.context.fail(
                            element,
                            "Destructuring defaults require distinguishable null and undefined source fields.",
                        );
                    if (absent?.undefined && !absent.null) {
                        // The default stands in for an absent optional field; the
                        // binding is then a value of the field's inner type.
                        const inner =
                            field.type.kind === "optional"
                                ? field.type.inner
                                : field.type;
                        const fallback = this.context.dataLowerer.compileArm(
                            () =>
                                this.context.dataLowerer.compileForSink(
                                    element.initializer!,
                                    inner,
                                ),
                        );
                        const present =
                            field.type.kind === "optional"
                                ? optionalPresentCpp(storedFieldCpp)
                                : `static_cast<bool>(${storedFieldCpp})`;
                        const selected =
                            field.type.kind === "optional"
                                ? `*${storedFieldCpp}`
                                : storedFieldCpp;
                        this.bindCopiedDefault(
                            name,
                            inner,
                            `${present} ? ${selected} : ${this.context.dataLowerer.armExpression(element.initializer, fallback.lines, fallback.value, inner)}`,
                        );
                        continue;
                    }
                }
                // A default on a required field never applies: the field is
                // never undefined, so the binding is the field itself.
                const fieldCpp = storedFieldCpp;
                const initialValue = this.context.dataLowerer.leafValue(
                    fieldCpp,
                    field.type,
                );
                if (!ts.isIdentifier(name)) {
                    this.bindNestedPattern(name, initialValue, element);
                    continue;
                }
                const cppName = this.context.bindings.cppIdentifier(name.text);
                if (this.context.mutableCapturedParameter(name, initialValue)) {
                    this.context.bindings.bindParameterValue(
                        name,
                        initialValue,
                    );
                    continue;
                }
                // Owning wrappers copy the selected identity, not the slot that
                // supplied it. Borrowed layouts keep their existing alias checks.
                const aliases =
                    field.type.kind === "span" ||
                    field.type.kind === "table" ||
                    (field.type.kind === "struct" &&
                        !this.context.dataTypes.isReferenceStruct(
                            field.type.name,
                        ));
                this.context.emit({
                    kind: "declaration",
                    type: `${this.context.dataTypes.cppType(field.type)}${aliases ? "&" : ""}`,
                    name: cppName,
                    initializer: fieldCpp,
                });
                const fieldValue = this.context.dataLowerer.leafValue(
                    cppName,
                    field.type,
                );
                const staticField = field.accessor
                    ? undefined
                    : value.recordProperties?.[property];
                if (staticField?.staticNumber !== undefined) {
                    writable(fieldValue).staticNumber =
                        staticField.staticNumber;
                }
                if (staticField?.staticString !== undefined) {
                    writable(fieldValue).staticString =
                        staticField.staticString;
                }
                if (staticField?.staticBoolean !== undefined) {
                    writable(fieldValue).staticBoolean =
                        staticField.staticBoolean;
                }
                if (staticField?.staticElements) {
                    writable(fieldValue).staticElements =
                        staticField.staticElements;
                    writable(fieldValue).staticElementsOwner =
                        staticField.staticElementsOwner ?? staticField;
                }
                if (staticField?.collectionCardinality) {
                    writable(fieldValue).collectionCardinality =
                        staticField.collectionCardinality;
                }
                this.context.bindings.defineVariable(name, fieldValue);
                if (aliases) {
                    this.context.dataLowerer.registerAlias(cppName, fieldCpp);
                } else {
                    this.context.dataLowerer.registerLocal(cppName, "copy");
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
                if (!ts.isIdentifier(name))
                    this.context.fail(
                        name,
                        "Physics aggregate bindings require an identifier.",
                    );
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
            if (!ts.isIdentifier(name))
                this.context.fail(
                    name,
                    "Render-target texture bindings require an identifier.",
                );
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

    /** Object rest copies remaining own fields into a fresh object. */
    private bindStructRest(
        element: ts.BindingElement,
        source: Value,
        consumed: ReadonlySet<string>,
    ): void {
        if (
            !ts.isIdentifier(element.name) ||
            source.dataType?.kind !== "struct"
        )
            this.context.fail(
                element,
                "A rest binding takes an identifier and represented object storage.",
            );
        const type = this.context.dataTypes.fromTsType(
            this.context.checker.getTypeAtLocation(element.name),
            element.name,
        );
        if (type?.kind !== "struct")
            this.context.fail(
                element,
                "Object rest requires a concrete record result type.",
            );
        this.context.dataTypes.markStoredObjectReferences(type);
        const cppName = this.context.bindings.cppIdentifier(element.name.text);
        this.context.emit({
            kind: "declaration",
            type: this.context.dataTypes.cppType(type),
            name: cppName,
            initializer: this.context.dataLowerer.structAggregate(type, []),
        });
        // The rest object is fresh: each field still holds its absent default.
        this.context.dataLowerer.copyStructOwnProperties(
            { cpp: cppName, type },
            source,
            source.dataType,
            element.parent,
            "rest",
            { excludedKeys: consumed, fresh: () => true },
        );
        this.context.bindings.defineVariable(
            element.name,
            this.context.dataLowerer.leafValue(cppName, type),
        );
        this.context.dataLowerer.registerLocal(cppName, "copy");
    }

    /** The source property named by an ordinary destructuring binding. */
    private bindingProperty(element: ts.BindingElement): {
        name: ts.BindingName;
        property: string;
    } {
        if (element.dotDotDotToken) {
            this.context.fail(
                element,
                "A rest binding must be handled by its object owner.",
            );
        }
        const propertyName = element.propertyName;
        if (!propertyName && ts.isIdentifier(element.name))
            return { name: element.name, property: element.name.text };
        if (!propertyName)
            this.context.fail(
                element,
                "A nested binding requires a property key.",
            );
        let property = propertyNameText(propertyName);
        if (ts.isComputedPropertyName(propertyName)) {
            const expression = this.context.unwrap(propertyName.expression);
            if (ts.isStringLiteralLike(expression)) property = expression.text;
            else if (ts.isNumericLiteral(expression))
                property = String(Number(expression.text));
        }
        if (property === undefined)
            this.context.fail(
                propertyName,
                "Object destructuring requires a literal property key.",
            );
        return { name: element.name, property };
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
                    (
                        this.context.moduleNamespaces.entries(value, element) ??
                        Object.entries(value.recordProperties ?? {})
                    )
                        .filter(([key]) => !consumed.has(key))
                        .map(([key, field]) => [
                            key,
                            value.moduleNamespace && field.kind !== "callback"
                                ? this.context.bindings.pinValueToTemporary(
                                      field,
                                      "module_export_snapshot",
                                  )
                                : field,
                        ]),
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
            const present =
                this.context.moduleNamespaces.member(
                    value,
                    property,
                    element,
                ) ?? value.recordProperties?.[property];
            // A default applies exactly when the property is undefined:
            // absent from the record, or present as `undefined`.
            let propertyValue =
                (!present ||
                    (present.kind === "json-null" &&
                        present.cpp === "std::nullopt")) &&
                element.initializer
                    ? this.context.compileValue(element.initializer)
                    : present;
            if (
                !propertyValue &&
                !value.moduleNamespace &&
                nullability(this.context.checker.getTypeAtLocation(name))
                    .undefined
            )
                propertyValue = { kind: "json-null", cpp: "std::nullopt" };
            if (!propertyValue) {
                this.context.fail(
                    element,
                    `Record has no property '${property}'.`,
                );
            }
            if (value.moduleNamespace && propertyValue.kind !== "callback")
                propertyValue = this.context.bindings.pinValueToTemporary(
                    propertyValue,
                    "module_export_snapshot",
                );
            if (!ts.isIdentifier(name)) {
                this.bindNestedPattern(name, propertyValue, element);
                continue;
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
