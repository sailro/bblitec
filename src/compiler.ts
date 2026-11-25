import { ShaderCreationsRequired } from "./compiler/shader-derivations.js";
import { reachLedgerProgram } from "./compiler/shader-material.js";
import { DeferredCapabilities } from "./compiler/deferred-capabilities.js";
import { thinInstanceOwnershipFailure } from "./thin-instance-admission.js";
import { lowerThinInstanceUploadBody } from "./compiler/thin-instance-upload.js";
import {
    isNonThenableDataType,
    readsErasedVoid,
} from "./compiler/undefined-values.js";
import { NativeCaptureCache } from "./compiler/native-capture-cache.js";
import { isNativeOwnerRecord } from "./compiler/native-owner-carrier.js";
import { createHash } from "node:crypto";
import { outlineEmittedBody } from "./compiler/body-outlining.js";
import { cppIdentifiers } from "./compiler/cpp-identifiers.js";
import {
    hasScalarFacts,
    staticStringValue,
    isStringValue,
    optionalPresentCpp,
    optionalValueCpp,
    presenceFlagCpp,
    valueForKind,
    withCommonResourceMetadata,
    type NullableResourceType,
} from "./compiler/types.js";
import {
    belongsToEntryEngine,
    isEngineScopedHandleKind,
    isInputSnapshotHandleKind,
} from "./compiler/data-types/handles.js";
import {
    forEachAnalysisNode,
    precedesForwardRead,
    someAnalysisNode,
    sourceFileNodes,
    sourceFilesWalk,
} from "./compiler/analysis-walk.js";
import {
    emissionArray,
    EmissionMap,
    emissionRecord,
    EmissionSet,
    EmissionTransaction,
    EmissionWeakMap,
    EmissionWeakSet,
    journaled,
    writable,
} from "./compiler/emission-transaction.js";
import type {
    LoweringServices,
    EmissionMark,
    LoweringStatement,
    NativeFunctionBodyOptions,
    ShaderSourceText,
} from "./compiler/lowering-services.js";
import type { ApplicationCpp } from "./compiler/source-units.js";
import {
    nativeDeclarationFacts,
    nativeDeclarationDiscardIfUnused,
    type NativeDeclaration,
} from "./compiler/native-declarations.js";
import {
    nativeStatementCode,
    renderNativeEmission,
    verbatimEmission,
    type NativeEmission,
    type NativeStatement,
} from "./compiler/native-statements.js";
import { sourceProfileScope } from "./compiler/source-profile.js";
import { coverSourceRealm } from "./compiler/source-coverage.js";
import ts from "typescript";
import {
    absenceOf,
    knownCondition,
    valueProvenPresent,
    knownOwnKeys,
    staticBooleanOf,
    staticKeyOf,
    undefinedValue,
} from "./compiler/values/model.js";
import { bindingRebinds } from "./compiler/binding-rebinds.js";
import { CallbackLowerer } from "./compiler/callbacks.js";
import { AsyncActivations } from "./compiler/async-activations.js";
import { PageLoader } from "./compiler/page-loader.js";
import { EngineLifecycle } from "./compiler/engine-lifecycle.js";
import { SharedClosureAnalysis } from "./compiler/shared-closure-analysis.js";
import { NativeEmissionRegistry } from "./compiler/native-emission-registry.js";
import { AssetRegistry } from "./compiler/asset-registry.js";
import { AdmissionRecorder } from "./compiler/admissions.js";
import { IntrinsicOptions } from "./compiler/intrinsic-options.js";
import {
    traceSourceApplication,
    traceSourceProgram,
    traceSourceNode,
} from "./compiler/source-trace.js";
import { emptyStorage } from "./compiler/empty-storage.js";
import { emitSurveyRoots } from "./compiler/survey-roots.js";
import {
    activeSurvey,
    describeRequests,
    describeStop,
    SurveyCollector,
    SurveyPassLimit,
    type SurveySettings,
    withSurvey,
    type SurveyReport,
} from "./compiler/survey.js";
import { isJsonValue } from "./compiler/json-bridge.js";
import {
    requireDynamicBindingStorage,
    type DynamicBindingStorage,
} from "./compiler/dynamic-binding-storage.js";
import {
    activeStorageDemandPlanner,
    recordStorageCompileAttempt,
    storageDemandPlanningEnabled,
    StorageDemandPlanner,
} from "./compiler/storage-demand-planner.js";
import { moduleLevelCallee } from "./compiler/runtime-case-split.js";
import { StorageDemand } from "./compiler/storage-demand.js";
import { ReplayStorage } from "./compiler/replay-storage.js";
import {
    NativeRecordStorageRequired,
    refusingRecordDemand,
} from "./compiler/native-record-storage.js";
import { resolve } from "node:path";
import { integerCounterOf } from "./compiler/integer-loops.js";
import {
    compileTextModuleValue,
    compileTextMutation,
} from "./compiler/text-surface.js";
import { promoteLiveTextData } from "./compiler/intrinsics/text.js";
import { emitSplatStreamAssignment } from "./compiler/splat-stream-surface.js";
import { emitLibraryNodeParent } from "./compiler/lowered-record-surface.js";
import { surfaceResizeFunction } from "./compiler/surface-pixel-ratio.js";
import { retainedOptions } from "./compiler/intrinsics/retained-options.js";
import { compileNodeInputMutation } from "./compiler/node-input-surface.js";
import { checkNodeGeometryMutation } from "./compiler/node-geometry-admission.js";
import {
    compileWorkerApplication,
    usesWorkers,
    ApplicationRealmRequired,
} from "./compiler/worker-modules.js";
import {
    compileWorkerValue,
    emitMessageHandler,
    isNativeWorkerExpression,
    isRuntimeLocationMember,
} from "./compiler/workers.js";
import { compileCanvasValue, emitCanvasAssignment } from "./compiler/canvas.js";
import {
    compileWindowIdentity,
    emitWindowLocationAssignment,
    nullableResourceEngine,
    windowInputEngine,
} from "./compiler/window-events.js";
import { RuntimeSearchParamsRequired } from "./compiler/search-params.js";
import { featureRequiresApplicationRealm } from "./feature-activation.js";
import { WindowProperties } from "./compiler/window-properties.js";
import { EngineObjectProperties } from "./compiler/engine-object-properties.js";
import { AsyncLowerer, PendingActivationsRequired } from "./compiler/async.js";
import { sourceLocation } from "./source-location.js";
import {
    cppIdentifierPattern,
    doubleLiteral,
    sanitizeCppIdentifier,
    stringLiteral,
} from "./cpp-literals.js";
import { jsonToValue, type JsonValuePolicy } from "./compiler/json-value.js";
import { compileAdaptations } from "./compiler/adaptations.js";
import {
    emitPropertyAssignment,
    emitUnobservedErrorPropertyWrite,
    emitStructuralPropertyAssignment,
} from "./compiler/assignments.js";
import {
    probePixelsAsset,
    registerSpriteAtlasAsset,
    withStableAssetSources,
} from "./compiler/assets.js";
import {
    compileStaticFetch,
    compileStaticFetchMethod,
    packagedFetchText,
} from "./compiler/static-fetch.js";
import {
    BrowserErasure,
    browserDeploymentValue,
    browserEnvironmentValue,
    constInitializer,
} from "./compiler/browser-erasure.js";
import {
    deploymentEnvironment,
    deploymentPublicUrl,
    deploymentUrl,
    moduleRelativeUrl,
    nativeModuleOrigin,
    nativeModuleUrl,
} from "./compiler/deployment.js";
import { browserGeneratedString } from "./compiler/browser-generated-string.js";
import { compileBrowserTextureFunctionCall } from "./compiler/browser-texture-function.js";
import { compileExecutedUrlFunctionCall } from "./compiler/executed-url-function.js";
import { compileExecutedVideoFunctionCall } from "./compiler/executed-video-function.js";
import { compileExecutedGltfFunctionCall } from "./compiler/executed-gltf-function.js";
import {
    compileEnginePixelRatioCap,
    compileEnginePrecisionPolicy,
} from "./compiler/intrinsics/engine-options.js";
import {
    compileRegisteredConstant,
    compileRegisteredIntrinsic,
} from "./compiler/intrinsics/registry.js";
import {
    isSampleCount,
    selectedStaticExpression,
    selectedStaticNumberValue,
    type StaticSelectionContext,
    staticNumberValue,
    staticJsonValue,
    validateObjectProperties,
} from "./compiler/option-helpers.js";
import {
    executeApplicationFunction,
    holdsEngineValue,
    runApplicationFunction,
    type ExecutedFunctionContext,
    type ExecutedScalar,
    type ExecutedArgument,
    type ExecutedResult,
    type ExecutedTarget,
} from "./compiler/executed-application-function.js";
import { liftWgslNumberHoles, type ShaderStage } from "./shader-ir.js";
import {
    foldNumberFormat,
    numberConstantValue,
    numberFormatOf,
    type NumberFormat,
} from "./compiler/number-intrinsics.js";
import { DataLowerer } from "./compiler/data-lowering.js";
import {
    cameraNumberWrite,
    isCameraExpression,
} from "./compiler/camera-writes.js";
import { noteCameraRecordWrite } from "./compiler/intrinsics/camera.js";
import {
    DataTypeRegistry,
    doubleLiteral as dataDoubleLiteral,
    domAudioHandleKind,
    handleCppType,
    isHandleKind,
    isUiElementHandleType,
    isPinnedType,
    typeImpliedFacts,
    opaqueEngineValue,
    pinnedHandleKind,
    resourceValueCppType,
    type DataIterationElement,
    type DataStructField,
    type DataType,
    type TypedArrayKind,
} from "./compiler/data-types.js";
import { metadataFieldsForKind } from "./compiler/values/metadata.js";
import { engineFieldIdentities } from "./compiler/engine-field-identities.js";
import { ExpressionLowerer } from "./compiler/expressions.js";
import { NativeFunctionLowerer } from "./compiler/native-functions.js";
import {
    emitReachableStatements,
    firstReturn,
} from "./compiler/loop-control.js";
import {
    createsReceiverState,
    isInertDefaultExport,
    isModuleInitializerStatement,
    planEntryModuleState,
    recordHoldsCallables,
    planImportedModuleState,
} from "./compiler/module-initializers.js";
import { moduleConstantIsWritten } from "./compiler/module-container-writes.js";
import {
    namespaceMemberName,
    refuseNamespaceMemberWrite,
} from "./compiler/namespace-declarations.js";
import { emitBigIntCompoundAssignment } from "./compiler/bigint-values.js";
import { compileSpriteAtlasRecord } from "./compiler/sprite-atlas-record.js";
import { createCompilerProgram } from "./compiler/program.js";
import {
    ModuleActivationRequired,
    ModuleNamespaces,
} from "./compiler/module-namespaces.js";
import { RecordProxies } from "./compiler/proxies.js";
import { PropertyAccessLowerer } from "./compiler/properties.js";
import {
    CompilerSymbols,
    staticAccessKey,
    declaredIn,
    declaredInDomLibrary,
    enumMemberConstant,
    staticPropertyKey,
    type DeclarationOrigin,
    typeMayHoldKey,
    libraryName,
    computedEnumMember,
    isLibraryNumberFormatter,
    calledDeclaration,
    calledFunction,
    namedMember,
    libraryStaticMember,
    nullishComparison,
    isLibraryStatic,
} from "./compiler/symbols.js";
import {
    isNullable,
    presentMembers,
    typeCanCarryReference,
    undefinedOnly,
    callSignatures,
    inheritsFrom,
    isVoid,
    unionMembers,
    valueKindOf,
    typeAdmitsData,
} from "./compiler/type-facts.js";
import {
    retainedStaticText,
    StaticEvaluator,
    type ReturnedExpression,
} from "./compiler/static-evaluator.js";
import { StatementLowerer } from "./compiler/statements.js";
import { HandleCollections } from "./compiler/handle-collections.js";
import {
    UserFunctionLowerer,
    aliasedMutationScan,
    resolveFunctionDeclaration,
    retainedNativeMutationTarget,
    tryResolveFunctionDeclaration,
    writesThroughTrackedRoot,
    type AliasedMutationScan,
    type CallbackInvocationOptions,
} from "./compiler/user-functions.js";
import {
    bindingSubtreeIntact,
    callArgumentIsReadOnly,
    isEffectFunction,
    parameterIsReadOnly,
    parameterWrittenSlots,
    readsIntactParameterObject,
} from "./compiler/parameter-effects.js";
import { promiseReactionOf } from "./compiler/promises.js";
import { recordComponents } from "./compiler/record-components.js";
import { recordFieldIsWritten } from "./compiler/record-observations.js";
import { parameterProjectionIsReadOnly } from "./compiler/parameter-projection-effects.js";
import { homeObjectMembers } from "./compiler/home-object-methods.js";
import {
    argumentAt,
    heldIdentifiers,
    identifierText,
    isAssignmentExpression,
    isDeclaredInside,
    literalMember,
    isUpdateExpression,
    sourceFunctionName,
    stringLiteralText,
    unwrappedIdentifier,
    writeSites,
    type WriteSite,
    isValueReference,
    expressionHasEffects,
    expressionMayRunCode,
    lastWriter,
    objectLiteralMembers,
    plainDataMembers,
    containsSuspension,
    functionKind,
    isSupportedFunction,
    isModuleConstDeclaration,
    variableKind,
    referenceBases,
    keysMayMatch,
    sameKeys,
    unwrapExpression,
    notJson,
    type SupportedFunction,
    type FunctionWithBody,
} from "./compiler/syntax.js";
import {
    CompileError,
    unlessRefused,
    unlessRuntimeValue,
} from "./compiler/compile-error.js";
import { packagedValueDomain } from "./compiler/asset-url-domain.js";
import {
    isEffectTaskMethodName,
    isTaskMethodWrite,
} from "./compiler/effect-task-methods.js";
import {
    ClosureCaptures,
    nativeCompanionKeys,
    renderClosure,
    renderCoroutineInvocation,
    type CapturedClosure,
    type ClosureBorrowing,
    type NativeCaptureBinding,
} from "./compiler/closure-captures.js";
import {
    parameterizedResourceLoop,
    requiresStaticDataIteration,
    canShareFunctionBody,
    reachesOnlyClosedEffects,
    reachesOpaqueCallee,
    sharedFunctionHasCallEffects,
    requiresStaticLoopIteration,
    runtimeProfileConstructionIntrinsics,
    writtenOnceBegun,
    type ParameterizedResourceLoop,
    type ResourceLoop,
} from "./compiler/resource-loops.js";
import { StaticExpansionBudget } from "./compiler/static-expansion.js";
import { compileWithRuntimeCaseSplit } from "./compiler/runtime-case-split.js";
import type {
    CollectionCardinality,
    CollectionSite,
    StaticListItem,
    CompileAsset,
    CompileOptions,
    CompileResult,
    DefaultRenderTaskEmission,
    Feature,
    RefusalSite,
    ResolvedCompileOptions,
    Value,
    ValueKind,
} from "./compiler/types.js";
import { isCompileTimeOnlyValue } from "./compiler/types.js";
import { refuseUnreadablePart } from "./compiler/unreadable-values.js";
import { ClassLowerer } from "./compiler/classes.js";
import { ClassHierarchy } from "./compiler/class-members.js";
import { EvaluationOrder } from "./compiler/evaluation-order.js";
import { engineBodies } from "./compiler/engine-bodies.js";
import { assertDeterministicRandomUnreached } from "./compiler/deterministic-random.js";
import {
    featureOrder,
    impliedFeatures,
    projectFeatures,
    renderMainCpp,
} from "./compiler/output-projection.js";
import {
    SceneManifestRecorder,
    type ResourceConstructionState,
} from "./compiler/scene-manifest.js";
import { BindingScopes } from "./compiler/binding-scopes.js";
import { ConditionLowerer } from "./compiler/conditions.js";
import {
    DeclarationLowerer,
    initializerNamesBinding,
} from "./compiler/declarations.js";
import { VarBindings } from "./compiler/var-bindings.js";
import { PlatformCalls } from "./compiler/platform-calls.js";
import { emitSharedCell } from "./compiler/shared-cells.js";
import { UiProjection } from "./compiler/ui-projection.js";
import { recordAt } from "./compiler/record-access.js";

export type {
    CompileAsset,
    CompileResult,
    CompiledShaderProgram,
    GeometryOutputTaskManifest,
    PostProcessTaskManifest,
} from "./compiler/types.js";

/**
 * A canvas size read, and which of the engine's two dimensions answers it.
 *
 * `clientWidth`/`clientHeight` are the logical window box rather than the
 * backing store, and the pin reads both: pointer mapping scales a client
 * coordinate by `backingWidth / clientWidth`. The PAL retains both sizes so
 * Windows display scaling and interactive resize keep that ratio faithful.
 */
interface CanvasSizeProperty {
    axis: "width" | "height";
    client: boolean;
}
interface ResourceConstructionCheckpoint {
    state: ResourceConstructionState;
    callbackDepth: number;
}
function resourceConstructionStatesEqual(
    left: ResourceConstructionState,
    right: ResourceConstructionState,
    containers = true,
): boolean {
    return (
        (!containers || left.gltfContainers === right.gltfContainers) &&
        left.counters.length === right.counters.length &&
        left.counters.every(
            (value, index) => value === right.counters[index],
        ) &&
        left.lightIdentities.length === right.lightIdentities.length &&
        left.lightIdentities.every(
            (value, index) => value === right.lightIdentities[index],
        )
    );
}

const CANVAS_SIZE_AXES = new EmissionMap<string, CanvasSizeProperty>([
    ["width", { axis: "width", client: false }],
    ["height", { axis: "height", client: false }],
    ["clientWidth", { axis: "width", client: true }],
    ["clientHeight", { axis: "height", client: true }],
]);

/**
 * The resources a nullable name holds as optional native storage beyond the
 * pinned handles and Web Audio identities the data model's own classifiers
 * name (`nullableResourceKind`), keyed by type name and gated on the origin
 * that declares that type: a program's own `class AssetContainer` or
 * `interface Element` is its own data, not the engine's or the browser's.
 *
 * A Map, like the two tables above: the key is a type's symbol name, and an
 * object literal would answer `Object.prototype` for one spelled `toString`.
 */
const NULLABLE_RESOURCE_TYPES = new EmissionMap<
    string,
    { origin: DeclarationOrigin } & NullableResourceType
>([
    [
        "AudioEngine",
        {
            origin: "babylon",
            kind: "audio-engine",
            cppType: "bbl::AudioEngineHandle",
        },
    ],
    [
        "SpriteRenderer",
        {
            origin: "babylon",
            kind: "sprite-renderer",
            cppType: resourceValueCppType("sprite-renderer")!,
        },
    ],
    [
        "AssetContainer",
        { origin: "babylon", kind: "asset", cppType: handleCppType("asset") },
    ],
    [
        "RenderTask",
        { origin: "babylon", kind: "task", cppType: "bbl::TaskHandle" },
    ],
]);

/**
 * The VAT handle row, kept in its own table because it is classified AFTER
 * the data model has been asked about the type.
 *
 * `fromTsType` is not a pure classifier -- reaching it can register a
 * native record for the type it is handed -- so moving this name in front
 * of it would silently withdraw that call. It stays where it is.
 *
 * `VatHandle`: `let handle: VatHandle | null = null` then a guarded
 * assignment inside the "did the asset carry a skinned mesh and clips" arm,
 * the shape both VAT scenes are written in. A pinned type. A `VatClip` is a
 * plain record: a bake's clip read is its row's three fields.
 */
const NULLABLE_VAT_RESOURCE_TYPES = new EmissionMap<
    string,
    { kind: ValueKind; cppType: string }
>([["VatHandle", { kind: "vat-handle", cppType: "bbl::VatHandle" }]]);

/** The two DOM types a drawing surface is declared as. */
const CANVAS_TYPE_NAMES: ReadonlySet<string> = new EmissionSet([
    "HTMLCanvasElement",
    "OffscreenCanvas",
]);

/** The closure key for a callback the program evaluates once, at module scope. */
const unownedCallbackScope: object = {};
const CAMERA_MUTATION_OPERATORS = new EmissionMap<ts.SyntaxKind, string>([
    [ts.SyntaxKind.EqualsToken, "="],
    [ts.SyntaxKind.PlusEqualsToken, "+"],
    [ts.SyntaxKind.MinusEqualsToken, "-"],
    [ts.SyntaxKind.AsteriskEqualsToken, "*"],
    [ts.SyntaxKind.SlashEqualsToken, "/"],
]);

/**
 * The nearest construct whose evaluation mints a new function object for a
 * callback declaration: the class whose instance owns it, or the function
 * body it was written in. Undefined means module scope, which the program
 * evaluates once.
 *
 * An object literal is deliberately not one of them. It carries no scope of
 * its own, so a method written in a module-level literal is as singular as a
 * module-level function, and one written inside a function is distinguished
 * by that function's evaluation.
 */
function callbackClosureContainer(
    declaration: ts.Node,
): ts.ClassLikeDeclaration | ts.SignatureDeclaration | undefined {
    return ts.findAncestor(declaration.parent, (owner) =>
        ts.isSourceFile(owner)
            ? "quit"
            : ts.isClassLike(owner) || ts.isFunctionLike(owner),
    ) as ts.ClassLikeDeclaration | ts.SignatureDeclaration | undefined;
}

export { CompileError };

/** A transaction that is not a probe: its work stands unless it throws. */
const commitAlways = (): boolean => true;

/**
 * @unjournaled A fact of the parsed program, kept across replays: by
 * parameter, `alwaysUsedParameterDefault`'s answer and the awaits its walk
 * unwrapped, which each later asking compile records again.
 */
const parameterDefaultAnswers = new WeakMap<
    ts.ParameterDeclaration,
    {
        readonly initializer: ts.Expression | undefined;
        readonly awaits: readonly ts.AwaitExpression[];
    }
>();

/** The variable and parameter names a program declares. */
const sourceDeclaredNames = sourceFilesWalk((node) =>
    (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
    ts.isIdentifier(node.name)
        ? node.name.text
        : undefined,
);

/** A site `predeclareStoredObjectReferences` maps before emission. */
type StoredReferenceSite =
    | { readonly kind: "retained"; readonly target: ts.Expression }
    | {
          readonly kind: "named-type";
          readonly node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
      }
    | {
          readonly kind: "annotated";
          readonly node: ts.VariableDeclaration;
          readonly type: ts.TypeNode;
      }
    | {
          readonly kind: "class-parameter";
          readonly node: ts.ParameterDeclaration;
      }
    | { readonly kind: "field"; readonly node: ts.PropertyDeclaration }
    | {
          readonly kind: "home-literal";
          readonly node: ts.ObjectLiteralExpression;
      };

/**
 * A retained mutation target, a named type, an annotated variable, a class
 * constructor or method parameter, a field, or a literal with home methods.
 */
function storedReferenceSite(
    node: ts.Node,
    symbols: CompilerSymbols,
): StoredReferenceSite | undefined {
    const target = retainedNativeMutationTarget(symbols, node);
    if (target) return { kind: "retained", target };
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
        return { kind: "named-type", node };
    if (ts.isVariableDeclaration(node) && node.type)
        return { kind: "annotated", node, type: node.type };
    if (
        ts.isParameter(node) &&
        (ts.isConstructorDeclaration(node.parent) ||
            ts.isMethodDeclaration(node.parent))
    )
        return { kind: "class-parameter", node };
    if (ts.isPropertyDeclaration(node)) return { kind: "field", node };
    if (ts.isObjectLiteralExpression(node) && homeObjectMembers(node).size > 0)
        return { kind: "home-literal", node };
    return undefined;
}

/** A program's stored-reference sites in source order. */
const storedReferenceSites = sourceFilesWalk(storedReferenceSite);

/**
 * Executed module constants: numbers are JavaScript doubles, and every value
 * keeps full static metadata for the static positions that read it.
 */
const executedConstantJsonPolicy: JsonValuePolicy = {
    numberLiteral: doubleLiteral,
    nullCpp: "std::nullopt",
    staticMetadata: true,
    unsupportedMessage:
        "An executed module constant holds a value JSON cannot represent.",
};

export function compileSource(
    source: string,
    options: CompileOptions = {},
): CompileResult {
    return traceSourceApplication(() =>
        compileSourceApplication(source, options),
    );
}

interface SurveyOutcome {
    report: SurveyReport;
    /** Present when every realm lowered to the end; its output has holes where statements refused. */
    result?: CompileResult;
}

/**
 * Lowers `source` past every compile refusal and reports them all, instead
 * of stopping at the first. A measurement of what an entry reaches; the
 * result is never a program to build.
 */
export function surveySource(
    source: string,
    options: CompileOptions = {},
    settings: SurveySettings = {},
): SurveyOutcome {
    const collector = new SurveyCollector(
        settings,
        isReplay,
        (error) => error instanceof RuntimeSearchParamsRequired,
    );
    return withSurvey(collector, () => {
        try {
            const result = compileSourceApplication(source, options);
            return { report: collector.published(), result };
        } catch (error) {
            if (error instanceof SurveyPassLimit)
                return { report: collector.published() };
            if (!(error instanceof Error)) throw error;
            return { report: collector.published(error) };
        }
    });
}

function compileSourceApplication(
    source: string,
    options: CompileOptions,
): CompileResult {
    return withStableAssetSources(() =>
        lowerSourceApplication(source, options),
    );
}

/**
 * The replays a compile applies before its next attempt: a storage demand,
 * a lazy module's activation, runtime query state, pending activations,
 * the whole program's shader material creations.
 */
function isReplay(error: unknown): error is Error {
    return (
        error instanceof StorageDemand ||
        error instanceof ModuleActivationRequired ||
        error instanceof RuntimeSearchParamsRequired ||
        error instanceof PendingActivationsRequired ||
        error instanceof ShaderCreationsRequired
    );
}

function lowerSourceApplication(
    source: string,
    options: CompileOptions,
): CompileResult {
    const fileName = options.fileName ?? "input.ts";
    const environment = deploymentEnvironment(options);
    const frontend = createCompilerProgram(source, fileName, options.hostPage);
    const survey = activeSurvey();
    const compile = (
        input: typeof frontend,
        workers?: ResolvedCompileOptions["workers"],
    ): CompileResult => {
        const resolved: ResolvedCompileOptions = {
            ...(options.readAssetBytes
                ? { readAssetBytes: options.readAssetBytes }
                : {}),
            ...(options.deferredCapabilities
                ? { deferredCapabilities: options.deferredCapabilities }
                : {}),
            fileName: workers?.namespace ? input.sourceFile.fileName : fileName,
            title: options.title ?? "Babylon Lite Native",
            width: options.width ?? 1280,
            height: options.height ?? 720,
            search: options.search ?? "",
            ...(options.initialSearch !== undefined
                ? { initialSearch: options.initialSearch }
                : {}),
            siteUrl: deploymentUrl(options).href,
            environment,
            ...(options.publicDir
                ? { publicDir: resolve(options.publicDir) }
                : {}),
            ...(options.publicUrl
                ? { publicUrl: deploymentPublicUrl(options.publicUrl) }
                : {}),
            ...(workers ? { workers } : {}),
            ...(options.hostPage && !workers?.namespace
                ? { hostPage: options.hostPage }
                : {}),
            ...(input.loaderFile && options.hostPage?.loader
                ? {
                      pageLoader: {
                          sourceFile: input.loaderFile,
                          specifier: options.hostPage.loader.specifier,
                      },
                  }
                : {}),
            ...(input.startupFiles?.length && !workers?.namespace
                ? { pageStartup: input.startupFiles }
                : {}),
            ...(options.sourceProfile?.length
                ? { sourceProfile: options.sourceProfile }
                : {}),
        };
        // Each demand belongs to a source binding, not its spelling. Reuse the
        // frontend and rebuild emission so earlier aliases use the same storage.
        const storage = new ReplayStorage(input.checker);
        const lazyModules = new Set<ts.SourceFile>();
        const newCompiler = (planner?: StorageDemandPlanner): Compiler => {
            recordStorageCompileAttempt(planner !== undefined);
            storage.beginAttempt();
            return new Compiler(
                input.program,
                input.sourceFile,
                input.checker,
                resolved,
                storage,
                lazyModules,
            );
        };
        // A replay lowers the realm again from the start, so a survey keeps
        // only the attempt that ran to the end. A plan that lowered every
        // statement is that attempt (`StorageDemandPlanner.complete`).
        const lower = (planner?: StorageDemandPlanner): CompileResult =>
            coverSourceRealm(input.program, input.sourceFile.fileName, () => {
                const compiler = newCompiler(planner);
                const result = traceSourceProgram(input.program, () =>
                    planner
                        ? planner.complete(compiler.compile())
                        : compiler.compile(),
                );
                result.manifest.inputs = input.localFiles;
                return result;
            });
        const acceptReplay = (error: unknown): boolean => {
            if (error instanceof ModuleActivationRequired) {
                if (lazyModules.has(error.file)) return false;
                lazyModules.add(error.file);
                return true;
            }
            if (error instanceof ShaderCreationsRequired) {
                resolved.shaderCreations = error.ledger;
                return true;
            }
            if (error instanceof StorageDemand) {
                // Outside a recovered statement a refused demand is the
                // compile's refusal.
                const refusal =
                    error instanceof NativeRecordStorageRequired
                        ? storage.refusedRecord(error.demand)
                        : undefined;
                if (refusal) throw refusal;
                return (
                    error.requests.filter((request) => storage.add(request))
                        .length > 0
                );
            }
            if (
                error instanceof RuntimeSearchParamsRequired &&
                (!resolved.runtimeSearchParams ||
                    (error.location && !resolved.runtimeLocationSearch))
            ) {
                resolved.runtimeSearchParams = true;
                if (error.location) resolved.runtimeLocationSearch = true;
            } else if (
                error instanceof PendingActivationsRequired &&
                !resolved.pendingActivations
            ) {
                resolved.pendingActivations = true;
            } else return false;
            return true;
        };
        const addPlanned = (planner: StorageDemandPlanner): number =>
            planner.demands.filter(
                (demand) =>
                    !storage.joinsAlreadyHeld(demand) && storage.add(demand),
            ).length;
        // A survey lowers every statement in each pass: a storage demand a
        // statement meets goes into the storage at once and the statement
        // lowers again; any other replay (a lazy module's activation) rolls
        // its statement back as a refusal does, and the next pass replays
        // with what this one met, until a pass meets and takes nothing new.
        // A replay raised in an attempt's setup restarts it; one raised once
        // every statement lowered ends the pass with the others.
        const surveyPasses = (
            collector: SurveyCollector,
            accept: (error: unknown) => boolean,
        ): CompileResult => {
            for (;;) {
                const realm = input.sourceFile.fileName;
                let result: CompileResult | undefined;
                let added = 0;
                try {
                    result = collector.attempt(realm, lower, accept);
                } catch (error) {
                    const accepted = accept(error);
                    if (!collector.settling(realm)) {
                        if (!accepted) throw error;
                        collector.restarted(error);
                        continue;
                    }
                    // One the storage already holds is the next pass's when
                    // this one took a demand (its stale storage may raise
                    // it), and the compile's refusal otherwise.
                    if (accepted) added++;
                    else if (collector.taken(realm) === 0 || !isReplay(error))
                        throw error;
                }
                added += collector.replaysOf(realm).filter(accept).length;
                added += collector.taken(realm);
                if (collector.passEnded(added)) continue;
                if (result) return result;
                throw new SurveyPassLimit();
            }
        };
        if (survey) return surveyPasses(survey, acceptReplay);
        // Storage converged as a survey's passes do, on the entry's own
        // lowering (no roots): each demand a statement meets is taken at
        // once and the statement lowers again, instead of one restart of
        // the whole realm per demand. Only storage demands converge: any
        // other replay (a lazy module's activation) a rolled-back statement
        // meets is the strict lowering's to meet or not. What the passes
        // lower is discarded; the compile is the strict lowering below,
        // with the storage they took.
        if (options.convergeStorage) {
            const converging = new SurveyCollector(
                {
                    roots: false,
                    passLimit: options.convergeStorage.passes,
                    ...(options.compileProgress
                        ? {
                              progress: {
                                  report: options.compileProgress,
                                  intervalMs: 60 * 1000,
                              },
                          }
                        : {}),
                },
                isReplay,
            );
            try {
                withSurvey(converging, () =>
                    surveyPasses(
                        converging,
                        (error) =>
                            error instanceof StorageDemand &&
                            acceptReplay(error),
                    ),
                );
            } catch (error) {
                // The strict lowering meets and reports any refusal itself.
                if (!(error instanceof Error)) throw error;
                options.compileProgress?.(
                    `Storage converged short of a pass meeting nothing new: ${describeStop(error)}`,
                );
            }
            // A statement a pass lowered before another demand reached its
            // records demands their sharing; the strict lowering demands
            // again the sharing it needs, so its records keep the layout
            // and order a strict compile gives them.
            storage.withdrawSharedRecords();
        }
        // Once a storage demand restarted the realm, every attempt is a
        // plan: it goes on past the demands later statements do not read, so
        // one attempt meets a run of them, and a plan that lowered every
        // statement is the compile. A plan that adds no demand leaves the
        // next attempt to strict lowering.
        let planning = false;
        const started = performance.now();
        const attempted = (attempt: number, ended: string): void => {
            options.compileProgress?.(
                `Compile attempt ${attempt} of ${input.sourceFile.fileName}: ${ended} (${((performance.now() - started) / 1000).toFixed(0)} s)`,
            );
        };
        for (let attempt = 1; ; attempt++) {
            if (planning) {
                const planner = new StorageDemandPlanner(input.checker);
                let replay = "";
                try {
                    const planned = planner.run(() => lower(planner));
                    if (planned) return planned;
                } catch (planningError) {
                    if (!acceptReplay(planningError)) throw planningError;
                    replay = `, then ${describeStop(planningError)}`;
                }
                const added = addPlanned(planner);
                planning = added > 0;
                attempted(
                    attempt,
                    `plan took ${added} of ${planner.demands.length} demands (${describeRequests(planner.demands)})${replay}`,
                );
                continue;
            }
            try {
                return lower();
            } catch (error) {
                if (!acceptReplay(error)) throw error;
                planning =
                    error instanceof StorageDemand &&
                    storageDemandPlanningEnabled();
                attempted(attempt, describeStop(error));
            }
        }
    };
    const application = () =>
        compileWorkerApplication(frontend, compile, (node, message) => {
            const { file, line, character } = sourceLocation(node);
            throw new CompileError(file.fileName, line, character, message);
        });
    const lowered = (): CompileResult => {
        if (usesWorkers(frontend)) return application();
        try {
            return compile(frontend);
        } catch (error) {
            if (!(error instanceof ApplicationRealmRequired)) throw error;
            return application();
        }
    };
    const result = lowered();
    const thinInstanceFailure = thinInstanceOwnershipFailure(
        new Set(result.manifest.features),
        { geometryOutputTasks: result.manifest.geometryOutputTasks.length },
    );
    if (thinInstanceFailure)
        throw new CompileError(fileName, 1, 1, thinInstanceFailure);
    requireSourceProfileScopes(options.sourceProfile, result);
    return result;
}

/**
 * Every `--source-profile` name must scope a native body in some realm: a
 * name that selects none would leave its profile silently empty.
 */
function requireSourceProfileScopes(
    selected: readonly string[] | undefined,
    result: CompileResult,
): void {
    const scoped = new Set(result.sourceProfileScopes);
    const unmatched = [...new Set(selected)].filter(
        (name) => !scoped.has(name),
    );
    if (unmatched.length === 0) return;
    throw new Error(
        `--source-profile selects no timed source function named ${unmatched.map((name) => `'${name}'`).join(", ")}. ` +
            "A name is a function's own, Class.method for a class member, or the variable or property an unnamed " +
            "function is bound to; async functions, generators and functions lowered inline at their calls carry no scope.",
    );
}

function losslessGenerationNumber(value: ExecutedArgument): boolean {
    return (
        typeof value !== "number" ||
        (Number.isFinite(value) && !Object.is(value, -0))
    );
}

/**
 * A run-time number a shader stage's text spells (`compileShaderSource`):
 * the builder call, the formatter call of its body that spells the number,
 * and the argument lane the formatter reads.
 */
interface ShaderSourceHole {
    readonly call: ts.CallExpression;
    readonly formatter: ts.CallExpression;
    readonly parameter: number;
    readonly lane: readonly string[];
    readonly format: NumberFormat;
    readonly digits: number | undefined;
}

/**
 * The argument lanes of a builder call generation does not know the
 * numbers of, by argument index: key paths into each argument.
 */
type UnreadLanes = ReadonlyMap<number, ReadonlyArray<readonly string[]>>;

/**
 * One fold of a shader stage's text (`compileShaderSource`): which run, the
 * holes found so far, and whether a builder ran over an argument with holes.
 */
interface ShaderSourceRun {
    run: 0 | 1;
    readonly holes: ShaderSourceHole[];
    admitted: boolean;
    /** The call whose known numbers are holes too. */
    readonly every?: ts.CallExpression;
}

/** A list item spelled in the bindings that read it. */
function unboundListItem(node: ts.Expression): StaticListItem {
    return { node, within: (read) => read() };
}

/**
 * What each run spells a hole's number as before formatting it: distinct
 * per hole and per run, as the two spellings locate holes by.
 */
const SHADER_SOURCE_REPRESENTATIVES = [1.2109375, 3804.6875] as const;

/** The literal run `run` spells the hole at `index` with. */
function shaderSourceSpelling(
    hole: ShaderSourceHole,
    index: number,
    run: 0 | 1,
): string {
    return foldNumberFormat(
        hole.format,
        SHADER_SOURCE_REPRESENTATIVES[run] * 10 ** index,
        hole.digits,
    )!;
}

class Compiler implements LoweringServices {
    public readonly symbols: CompilerSymbols;
    public readonly evaluator: StaticEvaluator;
    /** The handle-collection concept: every collection operation. */
    public readonly handleCollections: HandleCollections =
        new HandleCollections(this);
    /**
     * Runtime case split: the outcome each split test takes in the arm being
     * compiled. @unjournaled Set and cleared around one arm's compile.
     */
    public readonly conditionOverrides = new Map<ts.Node, boolean>();
    /**
     * Runtime case split: the value an argument a split test reads takes in
     * the arm being compiled. @unjournaled Set and cleared around one arm's
     * compile.
     */
    public readonly valueOverrides = new Map<ts.Node, Value>();
    /**
     * Whether a packaged-value query is running: reads it lowers answer as
     * the documents they read, not by asking again. @unjournaled Set and
     * cleared around one query.
     */
    private packagedQuery = false;
    /**
     * `stableLocalInitializer` answers, by declaration (`false`: none).
     * @unjournaled A function of the program's syntax.
     */
    private readonly stableInitializers = new WeakMap<
        ts.VariableDeclaration,
        ts.Expression | false
    >();
    /**
     * `rereadsAlike` answers, by expression.
     * @unjournaled A function of the program's syntax.
     */
    private readonly rereadAlike = new WeakMap<ts.Expression, boolean>();
    /** The scene composition records this compilation projects into its manifest. */
    public readonly sceneManifest: SceneManifestRecorder =
        new SceneManifestRecorder(this);
    /** The lexical scope stack: every source name's current binding. */
    public readonly bindings: BindingScopes = new BindingScopes(this);
    /** The C++ truth test of a source condition. */
    public readonly conditions: ConditionLowerer = new ConditionLowerer(this);
    public readonly moduleNamespaces: ModuleNamespaces = new ModuleNamespaces(
        this,
    );
    /** Variable declarations and binding patterns. */
    public readonly declarations: DeclarationLowerer = new DeclarationLowerer(
        this,
    );
    /** Hoisted `var` storage and its declaration-site assignments. */
    public readonly varBindings: VarBindings = new VarBindings(this);
    /** Property access on every represented owner. */
    public readonly propertyAccess: PropertyAccessLowerer =
        new PropertyAccessLowerer(this);
    /** Per-intrinsic option objects and the shader programs they reach. */
    public readonly deferredCapabilities = new DeferredCapabilities(this);
    public readonly recordProxies: RecordProxies = new RecordProxies(this);

    public readonly intrinsicOptions: IntrinsicOptions = new IntrinsicOptions(
        this,
    );
    /** The admission failures a capability defers until the program is known to reach it. */
    public readonly admissions: AdmissionRecorder = new AdmissionRecorder(this);
    /** Asset registration and the facts generation stamps on registered assets. */
    public readonly assetRegistry: AssetRegistry = new AssetRegistry(this);
    /** The namespace-level definitions the application's units compile. */
    public readonly nativeEmission: NativeEmissionRegistry =
        new NativeEmissionRegistry(this);
    /** Which bindings closures share by reference, and which are rebound. */
    public readonly sharedClosures: SharedClosureAnalysis =
        new SharedClosureAnalysis(this);
    /** Where startEngine lands, the continuation after it and the frame yields inside it. */
    public readonly engineLifecycle: EngineLifecycle = new EngineLifecycle(
        this,
    );
    /** Async activations, pending-promise boundaries and worker realm hooks. */
    public readonly asyncActivations: AsyncActivations = new AsyncActivations(
        this,
    );
    public readonly pageLoader: PageLoader | undefined;
    /** Frame, platform, physics and stored-data callbacks. */
    public readonly callbacks: CallbackLowerer = new CallbackLowerer(this);
    private readonly statements = new StatementLowerer();
    public readonly userFunctions: UserFunctionLowerer;
    public readonly ui: UiProjection = new UiProjection(this);
    public readonly platform = new PlatformCalls(this, this.ui);
    public readonly asyncLowerer = new AsyncLowerer(this);
    public readonly windowProperties: WindowProperties = new WindowProperties(
        this,
    );
    public readonly engineObjectProperties: EngineObjectProperties =
        new EngineObjectProperties(this);
    public readonly dataTypes: DataTypeRegistry;
    public readonly dataLowerer: DataLowerer;
    public readonly classLowerer: ClassLowerer;
    public readonly evaluationOrder: EvaluationOrder;
    public readonly nativeFunctions: NativeFunctionLowerer;
    public readonly browserErasure: BrowserErasure;
    @journaled private accessor staticAssetUrlCandidateCache:
        readonly string[] | undefined;
    private readonly expressions: ExpressionLowerer;
    private readonly returnFrames: Array<
        | ({
              kind: "native";
              type: DataType | "void";
              contextualVoid?: boolean;
              engineScopeDepth: number;
          } & NativeFunctionBodyOptions)
        | {
              kind: "inline";
              engineScopeDepth: number;
          }
    > = emissionArray([]);
    private readonly synchronousCleanupFrames: Array<object | undefined> =
        emissionArray([]);
    private readonly resourceLoopReturns = new EmissionWeakMap<
        object,
        {
            condition: ts.Expression;
            checkpoint: ResourceConstructionCheckpoint;
        }
    >();
    private readonly resourceConstructionCheckpoints =
        new EmissionSet<ResourceConstructionCheckpoint>();
    private readonly deferredResourceCaptureDepths = new EmissionSet<number>();
    private readonly collectionCardinalities =
        new EmissionSet<CollectionCardinality>();
    /** Where each compile-time list was first bound, by its elements. */
    private readonly listCreationSites = new EmissionWeakMap<
        readonly Value[],
        CollectionSite
    >();
    @journaled public accessor jsDataReached = false;
    @journaled public accessor fileReaderReached = false;
    /** Whether the entry body itself decodes an image (drawn-atlas records). */
    @journaled public accessor imageDecodeReached = false;
    @journaled public accessor jsRandomReached = false;
    @journaled private accessor audioSessionReached = false;
    /** Whether this attempt reached the shader-creation ledger (`reachShaderCreations`). */
    @journaled private accessor shaderCreationsReached = false;
    /**
     * The bounded canvas-owning functions this compilation executed at
     * generation, by name. It is the fidelity adaptation's reach test: the
     * assets they produce are ordinary data-URL payloads by the time they
     * reach the manifest, so nothing downstream can tell them apart.
     */
    public readonly browserTextureFunctions = new EmissionSet<string>();
    public readonly canvasReadbackFunctions = new EmissionSet<string>();
    /** The bounded video producers this compilation executed at generation. */
    public readonly executedVideoFunctions = new EmissionSet<string>();
    /** Whether a scene threw one of its own preconditions. */
    @journaled public accessor throwReached = false;
    public readonly staticConstants = new EmissionMap<
        ts.Symbol,
        ts.Expression
    >();
    private readonly sourceCppNames = new EmissionSet<string>();
    public readonly features = new EmissionSet<Feature>(["core"]);
    private readonly featureSites = new EmissionMap<Feature, string>();
    public readonly assets = new EmissionMap<string, CompileAsset>();
    public readonly assetOutputs = new EmissionMap<string, CompileAsset>();
    public readonly assetPayloads = new EmissionMap<string, string>();
    /**
     * Pixels-texture locals already handed to a material slot.
     *
     * The slot takes a copy where the pin binds the one `Texture2D` object,
     * so a `texture.uScale = ...` write afterwards would move the local and
     * not the material -- a silent divergence rather than a different image.
     * The names are the generated locals', which is what makes the check
     * hold across scopes.
     */
    public readonly boundPixelsTextures = new EmissionSet<string>();
    @journaled private accessor thisInstance: Value | undefined;
    private readonly classInstances = new EmissionMap<
        Value,
        ts.ClassLikeDeclaration
    >();
    /**
     * JavaScript identities minted for materialized callbacks, per
     * declaration and per owning object.
     */
    private readonly callbackIdentities = new EmissionMap<
        ts.Node,
        Map<object, number>
    >();
    @journaled private accessor nextCallbackIdentity = 0;
    @journaled private accessor nextNativeBindingSequence = 0;
    private readonly nativeBindings = new EmissionMap<
        string,
        NativeCaptureBinding
    >();
    private readonly nativeBindingTypes = new EmissionMap<
        string,
        {
            readonly type: string | undefined;
            readonly constant: boolean;
            /** A local declared by value (not a reference): it owns its storage. */
            readonly owned: boolean;
        }
    >();
    private readonly allocatedCppNames = new EmissionMap<string, number>();
    private readonly nativeTemporaries =
        new EmissionWeakSet<NativeCaptureBinding>();
    private readonly nativeConstBindings =
        new EmissionWeakSet<NativeCaptureBinding>();
    private readonly nativeStoredValues = new EmissionWeakSet<Value>();
    private readonly iteratorStorageBindings =
        new EmissionWeakSet<NativeCaptureBinding>();
    private readonly nativeDependencyStack: Set<NativeCaptureBinding>[] =
        emissionArray([]);
    /**
     * The native bindings a store placed inside another binding's value
     * (`saved = { box }`), by a native binding of the holder: a hoisted
     * finally reading the holder reaches them (`captureHoistedLines`).
     */
    private readonly heldNativeBindings = new EmissionMap<
        NativeCaptureBinding,
        readonly NativeCaptureBinding[]
    >();
    private readonly realmEngineCaptures = new EmissionMap<
        string,
        readonly NativeCaptureBinding[]
    >();
    private readonly realmEngineStorage = new EmissionMap<string, string>();
    private readonly realmEngineIdentities = new EmissionMap<string, symbol>();
    public readonly managedCaptures: ClosureCaptures[] = emissionArray([]);
    public readonly body: NativeEmission[] = emissionArray([]);
    @journaled private accessor emissionSource: string | undefined;
    /** Outlined helpers already defined, by their shape-derived names. */
    private readonly outlinedHelpers = new EmissionSet<string>();
    public readonly nativeDeclarations = new EmissionMap<
        string,
        NativeDeclaration
    >();
    public readonly statementDependencies: Set<NativeCaptureBinding>[] =
        emissionArray([]);
    /**
     * The statements being lowered, outermost first, with the binding scope
     * depth and emission position each began at. @unjournaled Pushed and
     * popped around each statement's lowering.
     */
    private readonly loweringStatements: LoweringStatement[] = [];
    /**
     * For each closure being lowered that runs after the statement creating
     * it, innermost last, how many statements stood when it began.
     * @unjournaled Pushed and popped around each such closure's lowering.
     */
    private readonly laterBodies: number[] = [];
    public readonly erasedBrowserExpressions = new EmissionSet<number>();
    public readonly erasedBrowserInstrumentation = new EmissionSet<number>();
    /** Erased writes through DOM element receivers, refused with retained UI. */
    private readonly erasedElementWrites = new EmissionMap<
        number,
        { site: ts.Node; element: ts.Expression }
    >();
    public readonly unwrappedAwaitExpressions = new EmissionSet<number>();
    public readonly localCubemapState: { maxCandidates?: number } =
        emissionRecord({});
    /** `constArrayIsWritten` answers, by binding: the scan walks a file. */
    private readonly writtenConstArrays = new EmissionMap<ts.Symbol, boolean>();
    /**
     * @unjournaled Only compared before and after one initializer's compile; a
     * discarded attempt can only over-count, which keeps a `const` a snapshot.
     */
    private impureReads = 0;
    public get impureReadCount(): number {
        return this.impureReads;
    }
    public noteImpureRead(): void {
        this.impureReads++;
    }
    /** @unjournaled Results of closed generation runs, a function of their inputs alone. */
    private readonly generationRuns = new Map<
        ExecutedTarget,
        Map<string, unknown>
    >();
    /** @unjournaled Module constants generation cannot run, a function of the program. */
    private readonly unrunnableModuleConstants =
        new Set<ts.VariableDeclaration>();
    /**
     * @unjournaled The run of the shader stage text `compileShaderSource`
     * folds, kept across the probes of its runs.
     */
    private shaderSourceHoles: ShaderSourceRun | undefined;
    @journaled public accessor hasMainEntry = false;
    @journaled public accessor defaultEngineCpp: string | undefined;
    /** Platform owner for an entry that has no source-created Babylon engine. */
    @journaled public accessor presentationHostCpp: string | undefined;
    /** First statement after the one engine is created. */
    @journaled private accessor engineCreationInsertion: number | undefined;
    /** Explicit static surface sample count; absence means the pinned default. */
    @journaled private accessor engineMsaaSamples: 1 | 4 | undefined;
    /** Bound only while lowering a platform visibility callback body. */
    @journaled public accessor platformDocumentHiddenCpp: string | undefined;
    @journaled public accessor indentLevel = 2;
    private readonly emissionBlocks = emissionArray([0]);
    @journaled private accessor nextEmissionBlock = 1;
    @journaled private accessor temporaryIndex = 0;
    @journaled public accessor defaultRenderTaskAdapted = false;
    @journaled private accessor sceneRegistrationSite: ts.Node | undefined;
    /** The storage demands this compile replays with (`ReplayStorage`). */
    public readonly dynamicBindings: ReadonlyMap<
        ts.VariableDeclaration,
        DynamicBindingStorage | undefined
    >;
    private readonly replayStorage: ReplayStorage;
    public readonly absenceTags: ReadonlySet<ts.Declaration>;
    public readonly thrownValueKinds: ReadonlySet<"string">;
    public readonly tupleArraySlots: ReadonlySet<ts.Declaration>;
    public readonly parameterObjects: ReadonlySet<ts.ParameterDeclaration>;

    public constructor(
        public readonly program: ts.Program,
        public readonly sourceFile: ts.SourceFile,
        public readonly checker: ts.TypeChecker,
        public readonly options: ResolvedCompileOptions,
        storage: ReplayStorage,
        private readonly lazyModules: ReadonlySet<ts.SourceFile>,
    ) {
        this.replayStorage = storage;
        this.dynamicBindings = storage.dynamicBindings;
        this.absenceTags = storage.absenceTags;
        this.thrownValueKinds = storage.thrownValueKinds;
        this.tupleArraySlots = storage.tupleArraySlots;
        this.parameterObjects = storage.parameterObjects;
        this.symbols = new CompilerSymbols(checker);
        this.userFunctions = new UserFunctionLowerer(checker);
        this.dataTypes = new DataTypeRegistry(
            checker,
            (node, message) => this.fail(node, message),
            new ClassHierarchy(checker, program),
            options.workers !== undefined,
            storage,
        );
        this.dataLowerer = new DataLowerer(this);
        this.classLowerer = new ClassLowerer(this);
        this.evaluationOrder = EvaluationOrder.ofProgram(
            checker,
            this.dataTypes.classHierarchy,
            engineBodies,
        );
        this.nativeFunctions = new NativeFunctionLowerer(this);
        this.browserErasure = new BrowserErasure(this);
        this.pageLoader = options.pageLoader
            ? new PageLoader(this, options.pageLoader)
            : undefined;
        this.expressions = new ExpressionLowerer(this);
        this.evaluator = new StaticEvaluator(
            this.staticConstants,
            this.checker,
            (identifier) => this.symbols.valueSymbol(identifier),
            // A location member the realm answers at run time has no
            // generation-known value.
            (expression) =>
                isRuntimeLocationMember(this, {
                    name: expression.name.text,
                    expression: expression.expression,
                })
                    ? undefined
                    : (compileCanvasValue(this, expression) ??
                      this.canvasSizeValue(expression) ??
                      this.enumMemberValue(expression) ??
                      this.dataLowerer.compileDataPath(expression, "read") ??
                      this.propertyAccess.lookupRecordProperty(expression) ??
                      this.propertyAccess.compilePropertyAccess(expression)),
            (expression) => this.compileValue(expression),
            (expression) => this.compileValue(expression),
            (expression) => this.compileValue(expression),
            (expression) => this.conditions.compileCondition(expression),
            (expression) =>
                this.browserErasure.evaluateBrowserValue(expression),
            (expression) =>
                this.browserErasure.isBrowserOnlyExpression(expression),
            (value, expression, assertedNonNull, expectedType) =>
                this.dataLowerer.narrowOptional(
                    value,
                    expression,
                    assertedNonNull,
                    expectedType,
                ),
            (identifier) => this.bindings.lookup(identifier),
            (identifier) => this.bindings.lookupOptional(identifier),
            (node, message, reason) => this.fail(node, message, reason),
            (expression) => this.recordUnwrappedAwait(expression),
            () => this.reachJsData(),
            (value, arity) => this.bindings.bindDataTuple(value, arity),
            (expression) => this.symbols.pinnedWgslTemplate(expression),
            (value) => this.dataLowerer.truthinessCondition(value),
            (cpp) =>
                this.bindings.pinValueToTemporary(
                    { kind: "number", cpp },
                    "number_operand",
                ).cpp,
            this.evaluationOrder,
            {
                compileArm: (compile) => this.dataLowerer.compileArm(compile),
                armExpression: (node, lines, cpp, type) =>
                    this.dataLowerer.armExpression(node, lines, cpp, type),
            },
            (expression) => this.generationText(expression),
            (object) => this.objectProperties(object),
            (identifier) => this.inlinedArgumentText(identifier),
            (access) => this.dataLowerer.compileGuardableElementAccess(access),
            (probe, answered) => this.probeEmission(probe, answered),
            (work, answered) => this.keptEmission(work, answered),
            (value, dataType, node) =>
                this.dataLowerer.compileKnownValueForSink(
                    value,
                    dataType,
                    node,
                ),
            (value, name, node) => this.structNumber(value, name, node),
            this.absenceTags,
            (callee, call, values) =>
                this.bindReturnedParameters(callee, call, values),
        );
    }

    public compile(): CompileResult {
        // The session is emitted at entry scope when reached, even if its first
        // use occurs while compiling a nested coroutine or callback.
        this.registerNativeBinding("bbl_audio_session");
        if (this.options.workers)
            this.reachFeature("platform:workers", this.sourceFile);
        this.dataTypes.registerRecordFacts(this.program.getSourceFiles());
        this.collectSourceCppNames();
        this.collectStaticConstants();
        this.predeclareStoredObjectReferences();
        this.moduleNamespaces.prepare(this.lazyModules);
        if (this.options.pageStartup?.length) {
            if (!this.options.workers) throw new ApplicationRealmRequired();
            this.emitNativeHostUi();
        }
        // The page's script runs up to its import of the entry, which then
        // evaluates the entry's imports and the entry itself.
        this.pageLoader?.emit((statement) => this.emitStatement(statement));
        this.emitImportedModuleInitializers();
        const entry = this.entryStatements();
        this.emitEntryModuleState(entry);
        this.moduleNamespaces.defineInitializers();
        this.emitEntryBody(entry);
        const survey = activeSurvey();
        survey?.phaseEnded("entry");
        if (survey?.lowersRoots && !this.options.workers?.namespace) {
            const lowerRoots = (): void =>
                survey.rollingBack(() => emitSurveyRoots(this, survey));
            lowerRoots();
            survey.rounds(lowerRoots);
        }
        survey?.settle();
        if (!this.options.pageStartup?.length) this.emitNativeHostUi();
        this.finalizeSceneRegistration();
        this.admissions.enforceDeferredAdmissions();
        const ledger = this.sceneManifest.shaderDerivations.splitLedger(
            this.sceneManifest.reachedShaderPrograms,
        );
        if (ledger) throw new ShaderCreationsRequired(ledger);
        this.sceneManifest.shaderDerivations.refuseUncreated();
        const particles = this.sceneManifest.reachedNodeParticles;
        if (
            particles.nativeProvider &&
            !particles.sets.some((set) => set.native)
        ) {
            this.fail(
                this.sourceFile,
                "A reached native emitter provider must feed a built particle set; standalone provider options are not lowered.",
            );
        }
        assertDeterministicRandomUnreached(
            this,
            this.jsRandomReached,
            this.sourceFile,
        );
        this.sceneManifest.settle();

        // After every feature has settled: retained UI must land on a frame
        // loop that presents it (NA-26).
        this.refuseMixedStandaloneTextContexts();
        this.refuseRealmFrameGraph();
        this.refuseUiWithoutPresentation();
        this.refuseErasedElementWrites();
        this.ui.validateUiStaticProjection();

        if (this.dataTypes.usesJsonStorage()) this.reachJson();
        if (this.dataTypes.usesBigIntStorage())
            this.reachFeature("data:bigint");
        if (this.dataTypes.usesSymbolStorage())
            this.reachFeature("data:symbol");
        if (this.dataTypes.usesLocaleStorage())
            this.reachFeature("data:locale");
        if (this.dataTypes.usesFileStorage())
            this.reachFeature("browser:file", this.sourceFile);
        // After every packaged file is known.
        this.assetRegistry.registerContentImages();

        const features = featureOrder.filter((feature) =>
            this.features.has(feature),
        );
        // Emitted in `features` order so the parallel record serializes
        // deterministically beside the array it annotates.
        const featureSites: Record<string, string> = {};
        for (const feature of features) {
            const site = this.featureSites.get(feature);
            if (site !== undefined) {
                featureSites[feature] = site;
            }
        }
        const application = this.renderCpp(features);
        this.staticExpansionBudget.assertWithinBudget();
        const { runtimeSources, generatedSources, cmake } = projectFeatures(
            features,
            application.sourceUnits.map(({ path }) => path),
        );
        return {
            cpp: application.cpp,
            cppFiles: application.files,
            cmake,
            assetPayloads: this.assetPayloads,
            ...(particles.sets.length > 0 ? { nodeParticles: particles } : {}),
            ...(this.sourceProfileScopes.size > 0
                ? { sourceProfileScopes: [...this.sourceProfileScopes] }
                : {}),
            manifest: {
                ...(this.deferredCapabilities.sites.length
                    ? { deferredCapabilities: this.deferredCapabilities.sites }
                    : {}),
                source: this.options.fileName,
                // The compiler's half of the reached-file list is the
                // program's, filled in by `compileSource`; generation
                // appends the files it reads beside the program.
                inputs: [],
                features,
                ...(this.ui.primaryCanvasReadyGate ||
                this.ui.windowCanvasReadyGate
                    ? { canvasReadyGate: true as const }
                    : {}),
                ...(this.engineMsaaSamples !== undefined
                    ? { engineMsaaSamples: this.engineMsaaSamples }
                    : {}),
                featureSites,
                runtimeSources,
                generatedSources,
                sourceUnits: application.sourceUnits,
                assets: [...this.assets.values()],
                ...(this.assetRegistry.assetDecoders.has("configuration")
                    ? {
                          assetDecoders:
                              this.assetRegistry.assetDecoders.get(
                                  "configuration",
                              )!,
                      }
                    : {}),
                ...this.sceneManifest.manifestRecords(
                    compileAdaptations(this, features),
                ),
            },
        };
    }

    /** Host page element lookups bound before the engine exists, declared once it does. */
    public readonly pendingHostUiLookups: Value[] = emissionArray([]);

    /**
     * Materialize the host page's markup into the same retained UI IR as
     * scene-created DOM: the TypeScript module cannot observe elements its
     * HTML page owns in a native process.
     */
    private emitNativeHostUi(): void {
        const startup = this.options.pageStartup;
        const script = startup
            ? (fileName: string): string[] => {
                  const source = startup.find(
                      (file) => resolve(file.fileName) === resolve(fileName),
                  );
                  if (!source)
                      this.failAtFile(
                          `Missing page startup script '${fileName}'.`,
                      );
                  return this.captureEmittedLines(() => {
                      for (const statement of source.statements)
                          this.emitStatement(statement);
                  });
              }
            : undefined;
        const page = this.options.hostPage;
        const emitted = page?.hostUi
            ? this.attributeRefusalsTo({ file: page.path, line: 1 }, () =>
                  this.ui.compileHostUi(script),
              )
            : this.ui.compileHostUi(script);
        const insertion = this.options.workers
            ? 0
            : (this.engineCreationInsertion ?? this.body.length);
        this.body.splice(insertion, 0, ...emitted.map(verbatimEmission));
    }

    /**
     * A host lookup becomes native only when its literal id is present in the
     * host page, including its canvas elements.
     */
    public isNativeHostUiLookup(call: ts.CallExpression): boolean {
        return this.ui.isNativeHostUiLookup(call);
    }

    /**
     * Fix object representation before any C++ member access is emitted.
     *
     * Data types are discovered lazily, but whether a struct is value-backed
     * or reference-backed is global to its generated C++ name. Scan declared
     * storage shapes and class fields first so a function reached early cannot
     * emit `record.field` and then have a later class turn the same record into
     * a shared pointer that requires `record->field`.
     */
    private predeclareStoredObjectReferences(): void {
        // In an order of the program: the layout is the program's, not the
        // order the attempts before this one met the demands in.
        const records = this.replayStorage.orderedRecords();
        this.dataTypes.prepareRecordComponents(
            recordComponents(
                this.checker,
                this.replayStorage.orderedJoins(records),
            ),
            records,
            this.program,
        );
        for (const demand of records)
            if (!demand.document)
                refusingRecordDemand(demand, () =>
                    this.dataTypes.predeclareOwnedRecord(demand),
                );
        for (const [
            declaration,
            storage,
        ] of this.replayStorage.sourceOrderedDynamicBindings())
            this.predeclaring(declaration, () => {
                const source = this.checker.getTypeAtLocation(declaration.name);
                // A record of methods has a type only as the storage it takes:
                // the binding's one object, whose methods read it as `this`.
                const type =
                    this.dataTypes.fromTsType(source, declaration) ??
                    (storage === "source"
                        ? this.dataTypes.fromStoredTsType(source, declaration)
                        : undefined);
                if (type) this.dataTypes.markStoredObjectReferences(type);
            });
        // Named record types with no layout outside a stored position, whose
        // held named records are marked once every named type is mapped.
        const unlaid: (ts.InterfaceDeclaration | ts.TypeAliasDeclaration)[] =
            [];
        for (const site of storedReferenceSites(
            this.program.getSourceFiles(),
            this.symbols,
        ))
            this.predeclaring(
                site.kind === "retained" ? site.target : site.node,
                () => {
                    if (site.kind !== "named-type") this.predeclareSite(site);
                    else if (
                        !this.dataTypes.fromTsType(
                            this.checker.getTypeAtLocation(site.node.name),
                            site.node,
                        )
                    )
                        unlaid.push(site.node);
                },
            );
        for (const node of unlaid)
            this.predeclaring(node, () =>
                this.dataTypes.markHeldNamedRecords(
                    this.checker.getTypeAtLocation(node.name),
                    node,
                ),
            );
    }

    /** Predeclares the storage one stored-reference site needs. */
    private predeclareSite(
        site: Exclude<StoredReferenceSite, { kind: "named-type" }>,
    ): void {
        switch (site.kind) {
            case "retained": {
                const targetType = this.checker.getTypeAtLocation(site.target);
                // Existing accessor records keep their getter/setter lowering.
                // Plain targets are retained by the group's generated writer.
                const hasAccessors = targetType
                    .getProperties()
                    .some((property) =>
                        property.declarations?.some(
                            (declaration) =>
                                ts.isAccessor(declaration) ||
                                ts.isMethodDeclaration(declaration),
                        ),
                    );
                if (!hasAccessors) {
                    const dataType = this.dataTypes.fromTsType(
                        targetType,
                        site.target,
                    );
                    if (dataType?.kind === "struct")
                        this.dataTypes.markStoredObjectReferences(dataType);
                }
                break;
            }
            case "annotated": {
                // Mapping an explicitly stored container eagerly marks any
                // object-valued entries as shared references. Do this before
                // function bodies are emitted so an earlier object literal
                // cannot use value syntax for a type that a later Map/Array
                // declaration makes reference-backed.
                const dataType = this.dataTypes.fromTsType(
                    this.checker.getTypeFromTypeNode(site.type),
                    site.type,
                );
                if (this.bindingSelectsObjects(site.node, dataType))
                    this.dataTypes.markStoredObjectReferences(dataType!);
                break;
            }
            case "class-parameter": {
                // Class argument binding preserves JavaScript object identity.
                // Predeclare that representation before helpers returning the
                // same structural type are lowered.
                const dataType = this.dataTypes.fromTsType(
                    this.checker.getTypeAtLocation(site.node),
                    site.node,
                );
                if (dataType?.kind === "struct")
                    this.dataTypes.markStoredObjectReferences(dataType);
                break;
            }
            case "field": {
                const dataType = this.dataTypes.fromTsType(
                    this.checker.getTypeAtLocation(site.node),
                    site.node,
                );
                if (dataType)
                    this.dataTypes.markStoredObjectReferences(dataType);
                break;
            }
            case "home-literal": {
                // A method's or accessor's `this` is the object the
                // literal creates.
                const dataType = this.dataTypes.fromTsType(
                    this.checker.getContextualType(site.node) ??
                        this.checker.getTypeAtLocation(site.node),
                    site.node,
                );
                if (dataType?.kind === "struct")
                    this.dataTypes.markStoredObjectReferences(dataType);
                break;
            }
        }
    }

    /**
     * Runs a setup step that predeclares the storage `node` needs. In a
     * survey its refusal is the census's, recorded against the statement
     * holding `node`, and setup goes on; elsewhere it is the compile's.
     */
    public predeclaring(node: ts.Node, work: () => void): void {
        if (!activeSurvey()) {
            work();
            return;
        }
        try {
            this.transaction(work);
        } catch (error) {
            if (!(error instanceof CompileError)) throw error;
            this.surveyRefusal(node, error);
        }
    }

    /**
     * A typed binding that holds one shared object rather than a copy: a
     * record whose own methods name the binding, and a nullable record an
     * uninitialized `let` is later pointed at (`let s: S | undefined; s =
     * createS()`). Decided before emission, so no storage replays.
     */
    private bindingSelectsObjects(
        declaration: ts.VariableDeclaration,
        dataType: DataType | undefined,
    ): boolean {
        if (!ts.isIdentifier(declaration.name)) return false;
        const symbol = this.symbols.valueSymbol(declaration.name);
        if (!symbol) return false;
        if (declaration.initializer)
            return (
                dataType?.kind === "struct" &&
                initializerNamesBinding(
                    this.checker,
                    this.symbols,
                    symbol,
                    declaration.initializer,
                )
            );
        return (
            dataType?.kind === "optional" &&
            dataType.inner.kind === "struct" &&
            !this.dataTypes.isClassStruct(dataType.inner.name) &&
            this.sharedClosures.identifierIsRebound(declaration.name)
        );
    }

    private collectStaticConstants(): void {
        for (const file of this.program.getSourceFiles()) {
            if (file.isDeclarationFile) {
                continue;
            }
            for (const statement of file.statements) {
                // A `var` holds undefined until its declaration runs, and
                // each declaration of it assigns: no initializer is its value.
                if (
                    !ts.isVariableStatement(statement) ||
                    variableKind(statement.declarationList) === "var" ||
                    (file !== this.sourceFile &&
                        variableKind(statement.declarationList) !== "const")
                ) {
                    continue;
                }
                for (const declaration of statement.declarationList
                    .declarations) {
                    if (
                        ts.isIdentifier(declaration.name) &&
                        declaration.initializer
                    ) {
                        const symbol = this.symbols.valueSymbol(
                            declaration.name,
                        );
                        if (symbol) {
                            this.staticConstants.set(
                                symbol,
                                declaration.initializer,
                            );
                        }
                    }
                }
            }
        }
    }

    private collectSourceCppNames(): void {
        for (const name of sourceDeclaredNames(this.program.getSourceFiles()))
            this.sourceCppNames.add(this.bindings.cppIdentifier(name));
    }

    /**
     * Executes the observable top-level work of imported project modules.
     *
     * Imported functions and immutable constants normally lower lazily at
     * their use sites. That is not enough for a module which builds exported
     * state by mutating an array/map, running a loop, or calling a registrar
     * at top level: JavaScript performs that work once before the importing
     * entry runs. TypeScript orders source files dependency-first in the
     * program, so emitting the reached local modules in that order preserves
     * the same initialization dependency order.
     *
     * Only modules with observable executable work are materialized. Pure
     * declaration modules keep the existing static/lazy path, avoiding a
     * runtime copy of every lookup table merely because it was imported.
     */
    private emitImportedModuleInitializers(): void {
        const modules = planImportedModuleState(
            this.program,
            this.sourceFile,
            this.checker,
            this.symbols,
            this.evaluationOrder,
            this.dynamicBindings.keys(),
        );
        if (modules.length === 0) return;

        const staticDeclarations = new Set<ts.VariableDeclaration>();

        // Once a module is materialized, its declarations name the native
        // storage initialized below. They must not continue resolving to the
        // declaration initializer (an empty array is no longer empty after a
        // following top-level registrar has pushed into it).
        for (const file of modules) {
            for (const statement of file.statements) {
                if (!ts.isVariableStatement(statement)) continue;
                for (const declaration of statement.declarationList
                    .declarations) {
                    if (!ts.isIdentifier(declaration.name)) continue;
                    if (
                        variableKind(statement.declarationList) === "const" &&
                        declaration.initializer &&
                        !this.dynamicBindings.has(declaration) &&
                        this.evaluationOrder.isPureExpression(
                            declaration.initializer,
                        ) &&
                        !this.evaluationOrder.hasModuleEffects(
                            declaration.initializer,
                        ) &&
                        !recordHoldsCallables(
                            this.checker,
                            declaration.initializer,
                        ) &&
                        // Its one evaluation is observable (the planner's
                        // rule): evaluated per use, members see other state.
                        !createsReceiverState(
                            this.checker,
                            this.symbols,
                            declaration,
                        ) &&
                        !this.moduleConstantIsWritten(declaration.name)
                    ) {
                        staticDeclarations.add(declaration);
                        continue;
                    }
                    const symbol = this.symbols.valueSymbol(declaration.name);
                    if (symbol) this.staticConstants.delete(symbol);
                }
            }
        }

        modules.forEach((file, index) => {
            this.bindings.pushScope(`module${index}_`);
            const moduleScope = this.bindings.variableScopes.at(-1)!;
            try {
                for (const statement of file.statements) {
                    if (ts.isVariableStatement(statement)) {
                        const declarations =
                            statement.declarationList.declarations.filter(
                                (declaration) =>
                                    !staticDeclarations.has(declaration),
                            );
                        if (declarations.length === 0) continue;
                        // Keep checker-bound declarations and original source
                        // identity; only the filtered statement is synthetic.
                        const runtimeStatement =
                            declarations.length ===
                            statement.declarationList.declarations.length
                                ? statement
                                : Object.assign(
                                      writable(
                                          ts.factory.updateVariableStatement(
                                              statement,
                                              statement.modifiers,
                                              ts.factory.updateVariableDeclarationList(
                                                  statement.declarationList,
                                                  declarations,
                                              ),
                                          ),
                                      ),
                                      { parent: statement.parent },
                                  );
                        this.emitStatement(runtimeStatement);
                        continue;
                    }
                    if (isInertDefaultExport(statement, this.evaluationOrder))
                        continue;
                    if (isModuleInitializerStatement(statement, this.checker)) {
                        this.emitStatement(statement);
                    }
                }
            } finally {
                // Module bindings remain visible to imported functions after
                // initialization, but their source names live under a module
                // prefix so two files may both export (say) `values`.
                const root = this.bindings.variableScopes[0]!;
                for (const [symbol, binding] of moduleScope) {
                    root.set(symbol, binding);
                }
                this.bindings.popScope();
            }
        });
    }

    /** Whether a module-scope container is written through anywhere. */
    public moduleContainerIsMutated(name: ts.Identifier): boolean {
        const declaration = name.parent;
        if (
            !ts.isVariableDeclaration(declaration) ||
            !ts.isVariableDeclarationList(declaration.parent) ||
            !ts.isVariableStatement(declaration.parent.parent) ||
            !ts.isSourceFile(declaration.parent.parent.parent)
        )
            return false;
        return this.moduleConstantIsWritten(name);
    }

    /**
     * Materialize shared module state before an implicit main body, using
     * ordinary declaration and capture lowering. Authored module entries
     * already include their declarations and must not initialize them twice.
     */
    private emitEntryModuleState(entry: readonly ts.Statement[]): void {
        const emitted = new EmissionSet<ts.Statement>(entry);
        for (const statement of planEntryModuleState(
            this.program,
            this.sourceFile,
            this.checker,
            this.symbols,
            this.dynamicBindings.keys(),
        )) {
            if (!emitted.has(statement)) this.emitStatement(statement);
        }
    }

    private emitEntryBody(entry: readonly ts.Statement[]): void {
        const emitBody = (): boolean => {
            const terminated = emitReachableStatements(this, entry);
            this.callbacks.emitDeferredPhysicsCallbacks();
            return terminated;
        };
        const suspends =
            this.options.workers &&
            entry.some((statement) => containsSuspension(statement));
        if (!suspends) {
            emitBody();
            return;
        }
        // Startup executes once, preserving construction metadata. Its locals
        // belong to the coroutine, so retained callbacks cannot borrow them as
        // entry-stack values after the initialization callback has returned.
        this.bindings.pushScope(this.allocateUserFunctionPrefix());
        let closure: CapturedClosure;
        try {
            closure = this.asyncActivations.withAsyncActivation(() =>
                this.captureClosureLines(
                    () => {
                        this.beginNativeFunctionBody(undefined, false, {
                            coroutine: true,
                        });
                        try {
                            if (!emitBody()) this.emitFallOffEnd();
                        } finally {
                            this.endNativeFunctionBody();
                        }
                    },
                    false,
                    true,
                ),
            );
        } finally {
            this.bindings.popScope();
        }
        this.emit({
            kind: "expression",
            code: `static_cast<void>(${renderCoroutineInvocation(closure, "bbl::js::Promise<bbl::js::PromiseVoid>")});`,
        });
    }

    private entryStatements(): readonly ts.Statement[] {
        const moduleStatements = this.sourceFile.statements.filter(
            (statement) => {
                if (ts.isEnumDeclaration(statement)) {
                    // Constant members already lower at their use sites. A
                    // runtime initializer must not disappear with its declaration.
                    if (
                        computedEnumMember(this.checker, statement) ||
                        !statement.members.every(
                            (member) =>
                                !member.initializer ||
                                this.evaluationOrder.isPureExpression(
                                    member.initializer,
                                ),
                        )
                    )
                        this.fail(
                            statement,
                            "Enum declarations with runtime initializers require runtime enum storage.",
                        );
                    return false;
                }
                return (
                    !ts.isImportDeclaration(statement) &&
                    !ts.isFunctionDeclaration(statement) &&
                    !ts.isExportDeclaration(statement)
                );
            },
        );
        if (this.options.workers?.namespace) return moduleStatements;
        const main = this.sourceFile.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === "main" &&
                statement.body !== undefined,
        );
        // A module that supplies its own entry call owns startup
        // order. Lowering only the function body would lose module-level
        // producers, listeners and work after an async call suspends.
        const authoredEntry = main && this.moduleReferencesEntry(main);
        if (main && !authoredEntry) {
            this.hasMainEntry = true;
            return main.body!.statements;
        }

        const terminal = moduleStatements.at(-1);
        if (main && terminal && this.isTerminalMainCall(terminal, main)) {
            this.hasMainEntry = true;
            const state = new EmissionSet(
                planEntryModuleState(
                    this.program,
                    this.sourceFile,
                    this.checker,
                    this.symbols,
                    this.dynamicBindings.keys(),
                ),
            );
            // Immutable literals retain the static evaluator's source shape;
            // shared state and effectful initializers execute in module order.
            const prefix = moduleStatements
                .slice(0, -1)
                .filter(
                    (statement) =>
                        !ts.isVariableStatement(statement) ||
                        state.has(statement) ||
                        statement.declarationList.declarations.some(
                            (declaration) =>
                                !ts.isIdentifier(declaration.name) ||
                                !declaration.initializer ||
                                !this.evaluationOrder.isPureExpression(
                                    declaration.initializer,
                                ),
                        ),
                );
            return [...prefix, ...main.body!.statements];
        }
        const statements = moduleStatements.map((statement) =>
            this.unwrapEntryReporter(statement),
        );
        if (statements.length === 0) {
            this.failAtFile(
                "Expected top-level scene statements or a function named main with a body.",
            );
        }
        return statements;
    }

    /** Preserve the implicit-entry adapter only where no caller continuation follows. */
    private isTerminalMainCall(
        statement: ts.Statement,
        main: ts.FunctionDeclaration,
    ): boolean {
        if (
            !ts.isExpressionStatement(statement) ||
            main.parameters.length !== 0 ||
            (main.name && this.sharedClosures.identifierIsRebound(main.name))
        )
            return false;
        let expression = this.unwrap(statement.expression);
        if (ts.isVoidExpression(expression) || ts.isAwaitExpression(expression))
            expression = this.unwrap(expression.expression);
        if (
            ts.isCallExpression(expression) &&
            promiseReactionOf(expression.expression, this.checker)?.reaction ===
                "catch"
        ) {
            const promise = this.entryReporterPromise(expression, true);
            if (!promise) return false;
            expression = promise;
        }
        const signature = ts.isCallExpression(expression)
            ? this.checker.getResolvedSignature(expression)
            : undefined;
        const result =
            signature && this.checker.getReturnTypeOfSignature(signature);
        const returned =
            result && (this.checker.getAwaitedType(result) ?? result);
        return (
            ts.isCallExpression(expression) &&
            expression.arguments.length === 0 &&
            ts.isIdentifier(expression.expression) &&
            this.symbols.valueSymbol(expression.expression)
                ?.valueDeclaration === main &&
            calledDeclaration(this.checker, expression) === main &&
            returned !== undefined &&
            undefinedOnly(returned)
        );
    }

    private moduleReferencesEntry(entry: ts.FunctionDeclaration): boolean {
        const statements = this.sourceFile.statements.filter(
            (statement) => !ts.isFunctionDeclaration(statement),
        );
        const isEntryReference = (node: ts.Node): boolean =>
            ts.isIdentifier(node) &&
            this.symbols.valueSymbol(node)?.valueDeclaration === entry;
        const policy = { types: "skip", names: "references" } as const;
        if (
            statements.some((statement) =>
                someAnalysisNode(statement, isEntryReference, policy),
            )
        )
            return true;
        const visited = new Set<ts.Node>();
        const referencesEntry = (root: ts.Node): boolean =>
            someAnalysisNode(
                root,
                (node) => {
                    if (isEntryReference(node)) return true;
                    if (!ts.isCallExpression(node)) return false;
                    const callee = calledFunction(this.checker, node);
                    if (callee === entry) return true;
                    if (!callee || visited.has(callee)) return false;
                    visited.add(callee);
                    return referencesEntry(callee.body);
                },
                policy,
            );
        return statements.some(referencesEntry);
    }

    /**
     * `entry(...).catch(<reporter>)`, which is how a scene whose entry is an
     * imported async helper ends.
     *
     * The terminal `main` adapter uses the same reporting-only proof.
     * Native scene entries report escaping failures through their application
     * reporter; Window applications retain their actual promise handlers.
     *
     * This is an entry-point rule, so it is applied to entry text once per
     * compile rather than to every `.catch` a program contains: mid-scene,
     * a rejection handler is a recovery path and lowering it away would be
     * a silent change of meaning.
     */
    private unwrapEntryReporter(statement: ts.Statement): ts.Statement {
        if (!ts.isExpressionStatement(statement)) return statement;
        const promise = this.entryReporterPromise(statement.expression);
        if (!promise) return statement;
        this.hasMainEntry = true;
        return ts.factory.createExpressionStatement(promise);
    }

    private entryReporterPromise(
        expression: ts.Expression,
        terminalMain = false,
    ): ts.CallExpression | undefined {
        if (this.options.workers) return undefined;
        const call = this.unwrap(expression);
        if (!ts.isCallExpression(call)) return undefined;
        const catcher = promiseReactionOf(call.expression, this.checker);
        if (catcher?.reaction !== "catch" || call.arguments.length !== 1) {
            return undefined;
        }
        const promise = this.unwrap(catcher.expression);
        if (
            !ts.isCallExpression(promise) ||
            this.checker.getAwaitedType(
                this.checker.getTypeAtLocation(promise),
            ) === this.checker.getTypeAtLocation(promise)
        ) {
            return undefined;
        }
        const handler = this.unwrap(argumentAt(call, 0));
        return (terminalMain && this.isIdentityRejectionHandler(handler)) ||
            this.browserErasure.isBrowserOnlyHandler(handler, true)
            ? promise
            : undefined;
    }

    /** A terminal rethrow leaves the entry's original rejection unchanged. */
    private isIdentityRejectionHandler(handler: ts.Expression): boolean {
        if (
            (!ts.isArrowFunction(handler) &&
                !ts.isFunctionExpression(handler)) ||
            functionKind(handler) !== "plain" ||
            handler.parameters.length !== 1 ||
            !ts.isBlock(handler.body) ||
            handler.body.statements.length !== 1
        )
            return false;
        const parameter = handler.parameters[0]!;
        const statement = handler.body.statements[0]!;
        if (
            !ts.isIdentifier(parameter.name) ||
            parameter.initializer ||
            parameter.dotDotDotToken ||
            !ts.isThrowStatement(statement)
        )
            return false;
        const thrown = this.unwrap(statement.expression);
        const parameterSymbol = this.symbols.valueSymbol(parameter.name);
        return (
            parameterSymbol !== undefined &&
            ts.isIdentifier(thrown) &&
            this.symbols.valueSymbol(thrown) === parameterSymbol
        );
    }

    public emitStatement(statement: ts.Statement): void {
        const previousSource = this.emissionSource;
        this.emissionSource =
            statement.getSourceFile()?.fileName ?? previousSource;
        this.statementDependencies.push(new EmissionSet());
        try {
            this.standingAt(statement, false, () =>
                this.statements.emit(this, statement),
            );
        } finally {
            this.popDependencies(this.statementDependencies);
            this.emissionSource = previousSource;
        }
    }

    /**
     * Lowers a statement of a block nested in a statement (`lower`), which
     * stands as the one that block is lowering; one `emitStatement` stands
     * at already lowers as it is.
     */
    public lowerNestedStatement(
        statement: ts.Statement,
        lower: () => void,
    ): void {
        if (this.loweringStatements.at(-1)?.statement === statement) lower();
        else this.standingAt(statement, true, lower);
    }

    /**
     * Runs `lower` with `statement` standing as the one its block is
     * lowering, then places the lines declared ahead of it.
     */
    private standingAt(
        statement: ts.Statement,
        nested: boolean,
        lower: () => void,
    ): void {
        const hoistsForward = precedesForwardRead(statement);
        const entry: LoweringStatement = {
            statement,
            nested,
            scopeDepth: this.bindings.variableScopes.length,
            scope: this.bindings.variableScopes.at(-1)!,
            emissionScope: this.activeEmissionScope,
            indentLevel: this.indentLevel,
            block: this.emissionBlocks.at(-1)!,
            blockDepth: this.emissionBlocks.length,
            bodyStart: this.body.length,
            aheadSequence: hoistsForward ? ++this.nextNativeBindingSequence : 0,
            continuationSequence: this.engineLifecycle.continuationSequence,
            hoistsForward,
        };
        this.loweringStatements.push(entry);
        try {
            lower();
            const ahead = this.aheadLines.get(entry);
            if (ahead) {
                this.aheadLines.delete(entry);
                this.body.splice(entry.bodyStart, 0, ...ahead);
            }
        } finally {
            this.loweringStatements.pop();
        }
    }

    /**
     * Lowers a statement (`lower`). Under a statement that precedes a later
     * binding of its block, each time it refuses a read of such a binding
     * no scope holds (a closure built in a nested block, a function it
     * reaches), its lines are withdrawn, the binding takes
     * temporal-dead-zone storage ahead of the statement its block stands
     * at, and it lowers again. From scopes that are not under that
     * statement (a body with scopes of its own) the refusal is an enclosing
     * statement's to start over on, so they lower it directly.
     */
    public hoistingForward(lower: () => void): void {
        if (
            !this.loweringStatements.some(
                (entry) => entry.hoistsForward && this.standsUnder(entry),
            )
        )
            return lower();
        const survey = activeSurvey();
        for (;;) {
            const begun = survey?.bodiesBegun() ?? 0;
            const refusal = this.emissionTransaction(
                () => {
                    try {
                        lower();
                        return undefined;
                    } catch (error) {
                        if (
                            !(error instanceof CompileError) ||
                            !this.callbacks.forwardBindingMissed(error)
                        )
                            throw error;
                        return error;
                    }
                },
                (met) => met === undefined,
            );
            if (!refusal) return;
            if (
                !this.callbacks.retryForwardMiss(refusal, () =>
                    survey?.withdrawBodies(begun),
                )
            )
                throw refusal;
        }
    }

    public loweringStatementIn(
        container: ts.Node,
    ): LoweringStatement | undefined {
        for (
            let index = this.loweringStatements.length - 1;
            index >= 0;
            index--
        ) {
            const entry = this.loweringStatements[index]!;
            if (entry.statement.parent === container) return entry;
        }
        return undefined;
    }

    public emitsAtLevelOf(statement: LoweringStatement): boolean {
        return (
            this.activeEmissionScope === statement.emissionScope &&
            this.indentLevel === statement.indentLevel
        );
    }

    public standsUnder(statement: LoweringStatement): boolean {
        return (
            this.bindings.variableScopes[statement.scopeDepth - 1] ===
                statement.scope &&
            this.emissionBlocks[statement.blockDepth - 1] === statement.block
        );
    }

    /** Lines declared ahead of statements being lowered, until each ends. */
    private readonly aheadLines = new EmissionMap<
        LoweringStatement,
        readonly NativeEmission[]
    >();
    /** The sequence native bindings take while declared ahead of a statement. */
    @journaled private accessor aheadBindingSequence: number | undefined =
        undefined;

    public emitAheadOf(statement: LoweringStatement, work: () => void): void {
        // At the statement's start, emission is ahead of it already.
        if (
            this.body.length === statement.bodyStart &&
            this.emitsAtLevelOf(statement) &&
            this.bindings.variableScopes.length === statement.scopeDepth
        ) {
            work();
            return;
        }
        const start = this.body.length;
        const indentLevel = this.indentLevel;
        const emissionScope = this.activeEmissionScope;
        const sequence = this.aheadBindingSequence;
        const blocks = this.emissionBlocks.splice(statement.blockDepth);
        this.indentLevel = statement.indentLevel;
        this.activeEmissionScope = statement.emissionScope;
        this.aheadBindingSequence = statement.aheadSequence;
        const continuation = this.engineLifecycle.continuationSequence;
        this.engineLifecycle.continuationSequence =
            statement.continuationSequence;
        this.statementDependencies.push(new EmissionSet());
        try {
            this.bindings.withScopeDepth(statement.scopeDepth, work);
        } finally {
            this.statementDependencies.pop();
            this.engineLifecycle.continuationSequence = continuation;
            this.aheadBindingSequence = sequence;
            this.activeEmissionScope = emissionScope;
            this.indentLevel = indentLevel;
            this.emissionBlocks.push(...blocks);
            const lines = this.body.splice(start);
            if (lines.length > 0)
                this.aheadLines.set(statement, [
                    ...(this.aheadLines.get(statement) ?? []),
                    ...lines,
                ]);
        }
    }

    public statementTerminatesAfterLowering(statement: ts.Statement): boolean {
        return this.statements.terminatesAfterLowering(statement);
    }

    public catchBindingIsErased(
        binding: ts.Identifier,
        body: ts.Node,
    ): boolean {
        return this.statements.catchBindingIsErased(this, binding, body);
    }

    public nullableResourceKind(
        node: ts.Node,
        allowDirect = false,
    ): NullableResourceType | undefined {
        const resource = this.rawNullableResourceKind(node, allowDirect);
        if (
            !resource ||
            !isHandleKind(resource.kind) ||
            !isEngineScopedHandleKind(resource.kind) ||
            resource.cppType !== handleCppType(resource.kind)
        )
            return resource;
        const dataType: DataType<"handle"> = {
            kind: "handle",
            handle: resource.kind,
            ownedEngine: true,
        };
        return {
            ...resource,
            cppType: this.dataTypes.cppType(dataType),
            dataType,
        };
    }

    /** Reconstruct a nullable resource from the slot holding its current owner. */
    public nullableResourceValue(
        resource: NullableResourceType,
        storage: string,
        source?: Value,
    ): Value {
        const present = resource.dataType
            ? withCommonResourceMetadata(
                  this.dataLowerer.leafValue(
                      `(*${storage})`,
                      resource.dataType,
                  ),
                  source ? [source] : [],
              )
            : valueForKind(resource.kind, {
                  ...(source ??
                      nullableResourceEngine(
                          resource.kind,
                          this.options.workers,
                          this.defaultEngineCpp,
                      )),
                  ...resource.implied,
                  cpp: `(*${storage})`,
              });
        // The new slot owns its current value; an initializer's lookup-copy
        // expression must not bypass a later assignment to this slot.
        if (!resource.dataType) delete writable(present).ownedCpp;
        return {
            ...present,
            optionalFoundCpp: optionalPresentCpp(storage),
            optionalStorageCpp: storage,
        };
    }

    private rawNullableResourceKind(
        node: ts.Node,
        allowDirect: boolean,
    ): NullableResourceType | undefined {
        const type = this.checker.getTypeAtLocation(node);
        const present = presentMembers(type);
        if (!allowDirect && !isNullable(type)) return undefined;
        // DOM interfaces (`HTMLElement | SVGElement`) are one retained
        // element handle, as the data model maps their union.
        if (
            present.length > 1 &&
            present.every(
                (member) =>
                    member.symbol !== undefined &&
                    isUiElementHandleType(member.symbol),
            )
        ) {
            const element: DataType = { kind: "handle", handle: "ui-element" };
            return {
                kind: "ui-element",
                cppType: this.dataTypes.cppType(element),
            };
        }
        if (present.length !== 1) return undefined;
        const member = present[0]!;
        if (isPinnedType(member, ["EngineContext"])) {
            if (!this.options.workers && !isNullable(type)) return undefined;
            if (!this.options.workers) throw new ApplicationRealmRequired();
            return { kind: "engine", cppType: "std::shared_ptr<bbl::Engine>" };
        }
        const pinned = pinnedHandleKind(member);
        switch (pinned) {
            case "mesh":
            case "scene-node":
            case "sprite-layer":
            case "navigation":
            case "navigation-obstacle":
            case "storage-buffer":
            case "scene":
            case "gaussian-splat-stream":
            case "gaussian-point-splatting":
            case "gaussian-point-splatting-progress":
            case "mesh-lod-asset":
            case "mesh-lod-instance":
            case "splat-voxel-collision":
            case "static-sound":
            case "audio-bus":
            case "sound-buffer":
            case "streaming-sound":
                return { kind: pinned, cppType: handleCppType(pinned) };
        }
        const audio = domAudioHandleKind(member);
        switch (audio) {
            case "audio-context":
            case "audio-param":
            case "audio-buffer":
            case "media-stream":
            case "media-stream-track":
                return { kind: audio, cppType: handleCppType(audio) };
        }
        const name = member.symbol?.name;
        const named = name ? NULLABLE_RESOURCE_TYPES.get(name) : undefined;
        if (named && declaredIn(member.symbol, named.origin)) {
            const implied = typeImpliedFacts(member);
            return {
                kind: named.kind,
                cppType: named.cppType,
                ...(implied ? { implied } : {}),
            };
        }
        // `createRenderTexture2D` returns the pin's ordinary `Texture2D`, so
        // the type cannot tell its offscreen target from a loaded texture;
        // the assignment that fills the name does.
        if (
            isPinnedType(member, ["Texture2D"]) &&
            this.identifierIsAssignedFromIntrinsic(
                node,
                "createRenderTexture2D",
            )
        ) {
            return {
                kind: "texture",
                cppType: "bbl::SpriteRenderTextureHandle",
            };
        }
        const mappedHandle = this.dataTypes.fromTsType(member, node);
        if (
            mappedHandle?.kind === "handle" &&
            (mappedHandle.handle === "ui-element" ||
                mappedHandle.handle === "pointer-drag" ||
                isInputSnapshotHandleKind(mappedHandle.handle) ||
                (this.options.workers &&
                    mappedHandle.handle === "offscreen-canvas"))
        ) {
            return {
                kind: mappedHandle.handle,
                cppType: this.dataTypes.cppType(mappedHandle),
            };
        }
        if (
            this.typeIsOrExtendsNamed(member, "Material", (symbol) =>
                declaredIn(symbol, "babylon"),
            )
        ) {
            return {
                kind: "material",
                cppType: handleCppType("material"),
            };
        }
        const vat = name ? NULLABLE_VAT_RESOURCE_TYPES.get(name) : undefined;
        if (vat && declaredIn(member.symbol, "babylon")) return vat;
        // Resolved through the DOM library's own `AudioNode`: a scene's
        // `SceneNode`, or the pin's `TransformNode`, is not a Web Audio node.
        if (
            this.typeIsOrExtendsNamed(member, "AudioNode", declaredInDomLibrary)
        ) {
            return {
                kind: "audio-node",
                cppType: "bbl::pal::AudioNodeHandle",
            };
        }
        // An engine value the plain-data model deliberately does not carry,
        // held by one nullable name: `let g: RotationGizmo | null = null`
        // and the guarded assignment that builds the widget on first use,
        // which is how an editor scene keeps a gizmo out of its own static
        // frame. Nothing below the classification is family-specific --
        // the optional storage, the `if (!g)` guard reading `has_value()`,
        // the assignment through `emitOptionalResourceAssignment` and the
        // shared closure cell a stored callback needs are the same ones
        // every resource row above already uses.
        const opaque = opaqueEngineValue(member);
        if (opaque) {
            return opaque;
        }
        return undefined;
    }

    /**
     * Whether a type is, or derives from, the class or interface named
     * `name` that `declaredBy` owns (the DOM library's `AudioNode`, not a
     * scene's own class of that name).
     */
    private typeIsOrExtendsNamed(
        type: ts.Type,
        name: string,
        declaredBy: (symbol: ts.Symbol) => boolean,
    ): boolean {
        return inheritsFrom(
            type,
            (candidate) =>
                candidate.symbol?.name === name && declaredBy(candidate.symbol),
        );
    }

    /** Whether a nullable local is later filled by one pinned factory. */
    private identifierIsAssignedFromIntrinsic(
        node: ts.Node,
        intrinsic: string,
    ): boolean {
        if (!ts.isIdentifier(node)) return false;
        const symbol = this.symbols.valueSymbol(node);
        if (!symbol) return false;
        let found = false;
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (candidate) => {
                if (found) return "skip";
                for (const { target, stored } of writeSites(candidate)) {
                    if (!stored || this.unwrappedValueSymbol(target) !== symbol)
                        continue;
                    const right = this.unwrap(stored);
                    const callee = ts.isCallExpression(right)
                        ? unwrappedIdentifier(right.expression, (wrapped) =>
                              this.unwrap(wrapped),
                          )
                        : undefined;
                    if (
                        callee &&
                        this.symbols.importedName(callee) === intrinsic
                    ) {
                        found = true;
                        return "skip";
                    }
                }
            });
        visit(node.getSourceFile());
        return found;
    }

    public emitExpressionAsStatement(expression: ts.Expression): void {
        this.statements.emitExpression(this, expression);
    }

    public compileTextMutation(expression: ts.Expression): Value | undefined {
        return compileTextMutation(this, expression);
    }

    public compileNodeInputMutation(
        expression: ts.Expression,
    ): Value | undefined {
        return compileNodeInputMutation(this, expression);
    }

    public checkNodeGeometryMutation(expression: ts.Expression): void {
        checkNodeGeometryMutation(this, expression);
    }
    private readonly reachedRenderContextRegistrations =
        new EmissionSet<string>();

    public promoteTextData(node: ts.Node): void {
        promoteLiveTextData(this);
        this.reachFeature("text:layout", node);
    }

    public emitDiscardedValue(value: Value): void {
        if (value.kind === "engine") return;
        if (value.cpp.length === 0) {
            for (const element of value.tupleElements ??
                Object.values(value.recordProperties ?? {})) {
                this.emitDiscardedValue(element);
            }
            return;
        }
        this.emit({
            kind: "expression",
            code:
                value.kind !== "void" || value.requiresExplicitDiscard
                    ? `static_cast<void>(${value.cpp});`
                    : `${value.cpp};`,
        });
    }

    public hasStableNativeBinding(value: Value): boolean {
        const storage =
            value.stableOwnerCpp ??
            value.resourceStorageCpp ??
            (value.kind === "engine" ? value.storedEngineCpp : undefined) ??
            value.cpp;
        if (
            value.sharedStorageCpp ||
            value.borrowedData ||
            value.runtimeIteration ||
            (value.readOnly &&
                !(
                    value.dataType?.kind === "struct" &&
                    this.dataTypes.isReferenceStruct(value.dataType.name)
                )) ||
            (value.dataType?.kind === "struct" &&
                !this.dataTypes.isReferenceStruct(value.dataType.name)) ||
            !cppIdentifierPattern.test(storage)
        )
            return false;
        return this.hasStableNativeExpression(storage);
    }

    private hasStableNativeExpression(cpp: string): boolean {
        const binding = this.nativeBindings.get(cpp);
        return binding !== undefined && this.nativeConstBindings.has(binding);
    }

    public emitDelete(expression: ts.DeleteExpression): void {
        if (this.recordProxies.remove(expression)) return;
        if (this.windowProperties.remove(expression)) return;
        if (this.engineObjectProperties.remove(expression)) return;
        this.dataLowerer.emitDelete(expression);
    }

    public emitAssignment(expression: ts.BinaryExpression): void {
        traceSourceNode(expression.left);
        this.noteHeldNativeBindings(expression);
        this.dataLowerer.withStoreKeysHeld(expression, () =>
            this.emitStore(expression),
        );
    }

    /**
     * `holder = { box }`: the native bindings whose values the store places
     * inside the holder's value -- the stored value itself, or a member,
     * element or branch of a literal it builds -- whatever storage the
     * holder's type (declared or inferred) gave it. A value computed from
     * them (`createCsgFromMesh(box)`) holds none of them, and a scalar is
     * copied into the holder.
     */
    public noteHeldNativeBindings(expression: ts.BinaryExpression): void {
        if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
        const target = this.unwrap(expression.left);
        if (!ts.isIdentifier(target)) return;
        const holders = this.identifierNativeBindings(target);
        if (holders.length === 0) return;
        const held = heldIdentifiers(this.unwrap(expression.right), (node) =>
            this.unwrap(node),
        )
            .filter((identifier) =>
                typeCanCarryReference(
                    this.checker.getTypeAtLocation(identifier),
                ),
            )
            .flatMap((identifier) => this.identifierNativeBindings(identifier));
        if (held.length === 0) return;
        for (const holder of holders)
            this.heldNativeBindings.set(holder, [
                ...(this.heldNativeBindings.get(holder) ?? []),
                ...held,
            ]);
    }

    /** The native bindings a source binding's current value reads. */
    private identifierNativeBindings(
        identifier: ts.Identifier,
    ): readonly NativeCaptureBinding[] {
        const symbol = this.symbols.valueSymbol(identifier);
        const binding = symbol && this.bindings.peekBinding(symbol);
        return binding
            ? this.nativeValueCaptures.bindingsOf(binding.value)
            : [];
    }

    /** `emitAssignment` once its target's keys are read. */
    private emitStore(expression: ts.BinaryExpression): void {
        const namespaceMember = namespaceMemberName(
            this.checker,
            this.unwrap(expression.left),
        );
        if (namespaceMember) refuseNamespaceMemberWrite(this, namespaceMember);
        if (emitBigIntCompoundAssignment(this, expression)) return;
        if (emitWindowLocationAssignment(this.dataLowerer, expression)) return;
        this.checkNodeGeometryMutation(expression);
        const input = this.compileNodeInputMutation(expression);
        if (input) {
            this.emitDiscardedValue(input);
            return;
        }
        const text = this.compileTextMutation(expression);
        if (text) {
            this.emitDiscardedValue(text);
            return;
        }
        if (this.compileCameraMutation(expression)) return;
        if (emitLibraryNodeParent(this, expression)) return;
        if (emitSplatStreamAssignment(this, expression)) return;
        if (emitCanvasAssignment(this, expression)) return;
        if (this.options.workers && emitMessageHandler(this, expression))
            return;
        if (this.options.workers && this.emitUiPropertyAssignment(expression))
            return;
        if (emitStructuralPropertyAssignment(this, expression)) {
            return;
        }
        const left = this.unwrap(expression.left);
        if (
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(left) &&
            this.probeEmission(
                // The selected property writer evaluates this receiver.
                () => {
                    const owner = this.resolveRecordValue(left.expression);
                    return (
                        owner?.recordSetters?.[left.name.text] ??
                        owner?.recordGetters?.[left.name.text]
                    );
                },
                () => false,
            )
        ) {
            emitPropertyAssignment(this, expression);
            return;
        }
        // `record["x"] = v` with a static key runs the setter `record.x = v`
        // would; storing the key as data would drop the call.
        if (
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isElementAccessExpression(left)
        ) {
            const key = staticAccessKey(this.checker, left);
            const owner =
                key === undefined
                    ? undefined
                    : this.resolveRecordValue(left.expression);
            const setter =
                key === undefined ? undefined : owner?.recordSetters?.[key];
            if (owner && setter) {
                this.compileRecordSetter(owner, setter, expression.right);
                return;
            }
        }
        // An effect task's `record` / `dispose` replaces the method its
        // frame graph calls; the read of either is a copy, not a slot.
        if (isTaskMethodWrite(this, left)) {
            if (
                !ts.isPropertyAccessExpression(left) ||
                !isEffectTaskMethodName(left.name.text)
            )
                this.fail(
                    expression,
                    "Unsupported task method write; only record/dispose saved-bind wrappers are lowered.",
                );
            emitPropertyAssignment(this, expression);
            return;
        }
        if (emitUnobservedErrorPropertyWrite(this, expression)) return;
        if (this.dataLowerer.emitAssignment(expression)) {
            return;
        }
        // The property layer gives explicitly lowered browser surfaces
        // (notably Web Audio) first refusal, then erases genuinely
        // browser-only writes. Doing the broad erasure here would hide the
        // type information before its native owner can see it.
        emitPropertyAssignment(this, expression);
    }

    private recordCollectionAssignment(
        target: Value,
        source: ts.Expression,
        destination: ts.Expression | undefined,
        kind: "vector" | "map" | "set",
        constructedArray: boolean,
    ): void {
        const left = destination && this.unwrap(destination);
        const binding =
            left && ts.isIdentifier(left)
                ? this.bindings.lookupOptional(left)
                : undefined;
        const previous = binding ?? target;
        const previousState =
            previous.collectionCardinality ??
            previous.staticElementsOwner?.collectionCardinality;
        const sourceValue = this.knownValueWithoutEvaluation(source);
        const sourceState =
            sourceValue?.collectionCardinality ??
            sourceValue?.staticElementsOwner?.collectionCardinality;
        const right = this.unwrap(source);
        const nativeConstructor = ts.isNewExpression(right)
            ? this.libraryGlobal(right.expression)
            : undefined;
        const fresh =
            kind === "vector"
                ? constructedArray ||
                  ts.isArrayLiteralExpression(right) ||
                  nativeConstructor === "Array"
                : nativeConstructor === (kind === "map" ? "Map" : "Set");
        const literalCount = ts.isArrayLiteralExpression(right)
            ? this.knownCollectionCardinality(right)
            : undefined;
        const definite =
            !this.isInRuntimeControlFlow() &&
            !this.isInRuntimeIteration() &&
            this.frameCallbackDepth === 0 &&
            !this.isInNativeFunctionBody() &&
            !previous.sharedStorageCpp;
        const template = sourceValue?.runtimeElementTemplate;
        const sourceElements =
            sourceValue?.staticElementsOwner?.staticElements ??
            sourceValue?.staticElements;
        const sourceOwner = sourceValue?.staticElementsOwner ?? sourceValue;
        if (binding && sourceState && previousState === sourceState) {
            writable(target).collectionCardinality = sourceState;
            writable(binding).collectionCardinality = sourceState;
            return;
        }
        if (sourceValue?.kind === "tuple" && !fresh) {
            // A named literal array takes one native array, which the alias shares.
            if (ts.isIdentifier(right))
                requireDynamicBindingStorage(this.checker, right, "array");
            this.fail(
                source,
                "Assigning an array alias requires native collection storage.",
            );
        }
        let tainted = false;
        const taint = (state: CollectionCardinality | undefined): void => {
            if (!state) return;
            tainted = true;
            writable(state).untrackedAliases = true;
            writable(state).count = undefined;
            delete writable(state).keys;
        };
        if (!definite) taint(previousState);
        if (!sourceState && !fresh) {
            for (const state of this.collectionCardinalities) {
                if (state.kind === (kind === "vector" ? "array" : "keyed"))
                    taint(state);
            }
        } else if (!definite || !binding) {
            taint(sourceState);
        }
        if (tainted) {
            this.bindings.visitScopedValues((value) => {
                const state =
                    value.collectionCardinality ??
                    value.staticElementsOwner?.collectionCardinality;
                if (state?.untrackedAliases) {
                    delete writable(value).staticElements;
                    delete writable(value).staticElementsOwner;
                    delete writable(value).runtimeElementTemplate;
                }
            });
        }
        const owner = previous.staticElementsOwner ?? previous;
        if (owner === previous || owner === target)
            this.bindings.invalidateStaticElements(previous, true);
        for (const value of new EmissionSet([target, previous])) {
            delete writable(value).staticElements;
            delete writable(value).staticElementsOwner;
            delete writable(value).runtimeElementTemplate;
            delete writable(value).collectionCardinality;
        }
        let state: CollectionCardinality;
        if (definite && binding && sourceState) {
            state = sourceState;
            if (!state.untrackedAliases && sourceElements && sourceOwner) {
                writable(binding).staticElements = sourceElements;
                writable(binding).staticElementsOwner = sourceOwner;
            }
            if (!state.untrackedAliases && template)
                writable(binding).runtimeElementTemplate = template;
        } else {
            let count: number | undefined;
            if (definite && binding && fresh) {
                if (ts.isArrayLiteralExpression(right)) {
                    count = literalCount;
                } else if (ts.isNewExpression(right)) {
                    const arguments_ = right.arguments ?? [];
                    if (arguments_.length === 0) count = 0;
                    else if (kind === "vector" && arguments_.length === 1) {
                        const length = staticNumberValue(this, arguments_[0]!);
                        if (
                            length !== undefined &&
                            Number.isSafeInteger(length) &&
                            length >= 0
                        )
                            count = length;
                    }
                }
            }
            state = {
                kind: kind === "vector" ? "array" : "keyed",
                count,
                ...(kind !== "vector" && count === 0
                    ? { keys: new EmissionSet<string | number | boolean>() }
                    : {}),
                createdIn: [...this.parameterizedResourceIterations],
                varyingIn: new EmissionSet(),
                ...(!definite || !binding || !fresh
                    ? { untrackedAliases: true as const }
                    : {}),
            };
        }
        this.collectionCardinalities.add(state);
        writable(target).collectionCardinality = state;
        if (binding) writable(binding).collectionCardinality = state;
    }

    public recordDataAssignmentMetadata(
        target: Value,
        source: ts.Expression,
        destination?: ts.Expression,
        constructedArray = false,
        sourceValue?: Value,
    ): boolean {
        const destinationName = destination && this.unwrap(destination);
        if (destinationName && ts.isIdentifier(destinationName)) {
            const binding = this.bindings.lookupOptional(destinationName);
            const declaration =
                this.symbols.valueSymbol(destinationName)?.valueDeclaration;
            if (
                binding &&
                binding.orderedTextDeclaration === declaration &&
                declaration !== undefined
            ) {
                // Only control flow entered since the declaration can skip
                // this write; an enclosing loop re-declares the local.
                const text =
                    this.runtimeControlFlowDepth >
                    (binding.orderedTextControlDepth ?? 0)
                        ? undefined
                        : (sourceValue?.staticString ??
                          retainedStaticText(this, source));
                if (text === undefined) delete writable(binding).staticString;
                else writable(binding).staticString = text;
            }
        }
        const dataType = target.dataType;
        const storedType =
            dataType?.kind === "optional" ? dataType.inner : dataType;
        if (
            storedType?.kind === "vector" ||
            storedType?.kind === "map" ||
            storedType?.kind === "set"
        ) {
            this.recordCollectionAssignment(
                target,
                source,
                destination,
                storedType.kind,
                constructedArray,
            );
            return true;
        }
        if (
            storedType?.kind !== "handle" ||
            storedType.handle !== "ui-element"
        ) {
            return false;
        }
        const tag =
            this.ui.uiCreationTag(source) ??
            this.ui.uiCreatedElementTag(source);
        if (!tag) return false;
        const creation = this.ui.uiCreationCall(source);
        const staticId = creation
            ? this.ui.uiStaticIdsByCreation.get(creation)
            : undefined;
        const keys = [target.cpp, target.optionalStorageCpp].filter(
            (key): key is string => key !== undefined,
        );
        for (const key of keys) {
            const existing = this.ui.uiElementMetadataByDataStorage.get(key);
            if (existing !== undefined && existing.tag !== tag) {
                this.fail(
                    source,
                    `Nullable retained UI storage cannot hold both <${existing.tag}> and <${tag}> elements.`,
                );
            }
            const retainedStaticId = staticId ?? existing?.staticId;
            this.ui.uiElementMetadataByDataStorage.set(key, {
                tag,
                ...(retainedStaticId === undefined
                    ? {}
                    : { staticId: retainedStaticId }),
            });
        }
        writable(target).uiTag = tag;
        if (staticId !== undefined) {
            writable(target).uiStaticId = staticId;
        }
        return false;
    }

    /** Whether an expression is already known to produce retained UI state. */
    public isNativeUiValueExpression(expression: ts.Expression): boolean {
        return this.ui.isNativeUiValueExpression(expression);
    }

    /** The text driver records text layers only, so mixed contexts require an explicit boundary. */
    private refuseMixedStandaloneTextContexts(): void {
        if (!this.reachedRenderContextRegistrations.has("registerTextRenderer"))
            return;
        const incompatible = (
            [
                ["registerScene", "renderer:scene"],
                ["registerSpriteRenderer", "renderer:sprite"],
                ["registerFrameGraphContext", "renderer:frame-graph"],
                ["registerEffectRenderer", "renderer:effect"],
            ] as const
        )
            .filter(([name]) =>
                this.reachedRenderContextRegistrations.has(name),
            )
            .map(([, feature]) => feature);
        if (incompatible.length === 0) return;
        this.failAtFile(
            "Standalone text rendering cannot be combined with other reached rendering contexts: " +
                incompatible.join(", ") +
                ". The native text driver does not preserve mixed context registration order.",
        );
    }

    /**
     * Outside an application realm `ui:rml` presents through the scene and
     * sprite loops only; the standalone fullscreen-effect and frame-graph
     * drivers have no UI path on either backend (`pal_sdl_gpu_effect.cpp`/
     * `pal_sdl_gpu_frame_graph.cpp` and their Dawn twins render no
     * `UiRenderFrame`). Refuse the combination while nothing reaches it so
     * retained chrome cannot silently vanish from a task-only program. In a
     * realm the Window host presents the UI over every renderer's canvas
     * frames. The driver mirror follows `pal_sdl.cpp`'s `renderer_kind`
     * priority: a scene wins, then a frame graph, then an effect renderer,
     * then sprites.
     */
    private refuseUiWithoutPresentation(): void {
        if (
            !this.features.has("ui:rml") ||
            this.features.has("renderer:scene") ||
            this.options.workers
        ) {
            return;
        }
        const driver = this.features.has("renderer:frame-graph")
            ? "standalone frame-graph"
            : this.features.has("renderer:effect")
              ? "standalone fullscreen-effect"
              : undefined;
        if (driver === undefined) return;
        const site = this.featureSites.get("ui:rml");
        this.failAtFile(
            `Retained UI is not lowered under the ${driver} driver: the ` +
                `scene reaches ui:rml${site ? ` (${site})` : ""} but that ` +
                "frame loop presents no UI on either backend. Retained UI " +
                "presents through the scene and sprite loops only.",
        );
    }

    /**
     * A standalone frame graph (no scene, which `renderer_kind` prefers)
     * refuses in an application realm: the engine holds the registered
     * `FrameGraphContext` by address, and the realm entry that declares it
     * returns once the engine's first frame resolves (`run_realm_frames`).
     */
    private refuseRealmFrameGraph(): void {
        if (
            !this.options.workers ||
            !this.features.has("renderer:frame-graph") ||
            this.features.has("renderer:scene")
        )
            return;
        const site = this.featureSites.get("renderer:frame-graph");
        this.failAtFile(
            `A standalone frame graph${site ? ` (${site})` : ""} does not yet run in an ` +
                "application realm: the engine holds the registered FrameGraphContext by " +
                "address, and the realm entry that declares it returns at the engine's " +
                "first frame.",
        );
    }

    public emitUiPropertyAssignment(expression: ts.BinaryExpression): boolean {
        if (this.windowProperties.assign(expression)) return true;
        return this.ui.emitUiPropertyAssignment(expression);
    }

    public emitUiDatasetProperty(
        element: Value,
        property: string,
        value: Value,
        site: ts.Expression,
    ): void {
        this.ui.emitUiDatasetProperty(element, property, value, site);
    }

    public emitUiElementProperty(
        element: Value,
        receiver: ts.Expression,
        property: string,
        value: Value,
        site: ts.Expression,
    ): void {
        this.ui.emitUiElementStore(
            element,
            receiver,
            property,
            { value, site },
            site,
        );
    }

    public emitUiStyleValue(
        element: Value,
        property: string,
        value: Value,
        site: ts.Expression,
    ): void {
        this.ui.emitUiStyleProperty(element, property, site, site, value);
    }

    public emitAddedPropertyLogicalAssignment(
        expression: ts.BinaryExpression,
    ): boolean {
        return (
            this.windowProperties.assignLogical(expression) ||
            this.engineObjectProperties.assign(expression)
        );
    }

    public optionalChainStop(node: ts.Expression): Value | undefined {
        return this.expressions.optionalChainStop(node);
    }

    public compileValue(expression: ts.Expression): Value {
        const assigned = this.dataLowerer.assignedValue(expression);
        if (assigned) return assigned;
        traceSourceNode(expression);
        this.asyncActivations.requirePendingActivationRealm(expression);
        this.checkNodeGeometryMutation(expression);
        const boundary = this.nextNativeBindingSequence;
        const dependencies = new EmissionSet<NativeCaptureBinding>();
        this.nativeDependencyStack.push(dependencies);
        let value: Value;
        try {
            const unwrapped = this.unwrap(expression);
            const importedText = ts.isPropertyAccessExpression(unwrapped)
                ? compileTextModuleValue(this, unwrapped)
                : undefined;
            value =
                importedText ??
                this.compileNodeInputMutation(expression) ??
                this.compileTextMutation(expression) ??
                this.compileCameraMutation(expression) ??
                this.compileWorkerValue(expression) ??
                this.windowProperties.call(expression) ??
                this.expressions.compileValue(expression);
        } finally {
            this.popDependencies(this.nativeDependencyStack);
        }
        if (
            value.kind === "text-vector" &&
            (ts.isConditionalExpression(this.unwrap(expression)) ||
                ts.isBinaryExpression(this.unwrap(expression)))
        ) {
            this.fail(
                expression,
                "Conditional text transform objects require a runtime vector identity carrier; select the renderable before reading its transform.",
            );
        }
        const known =
            value.kind === "boolean" ? staticBooleanOf(value) : undefined;
        if (known !== undefined) value = { ...value, staticBoolean: known };
        // CSG values retain materialized geometry plans, not the native mesh
        // handles read while producing them. A later consumer can therefore
        // use the plan from a hoisted cleanup without capturing those locals.
        const geometryPlan =
            value.kind === "csg-solid" || value.kind === "csg2-solid";
        const retained = new EmissionSet(value.nativeCaptures);
        if (!geometryPlan) {
            for (const binding of dependencies) {
                if (binding.sequence <= boundary) retained.add(binding);
            }
        }
        if (retained.size && !this.nativeStoredValues.has(value))
            writable(value).nativeCaptures = [...retained];
        if (
            value.kind === "engine" &&
            (value.storedEngineCpp || value.ownedEngineCpp) &&
            expression.parent !== undefined &&
            ts.isCallExpression(expression.parent) &&
            expression.parent.arguments.includes(expression)
        ) {
            // A call receives this owner before later arguments or statements
            // can replace the source slot; resources keep the same snapshot.
            value = this.bindings.pinValueToTemporary(
                value,
                "engine_argument",
                expression,
            );
        }
        this.describeEngineCaptures(value);
        this.useNativeValue(value);
        // A generation-known list of strings travels on the value, exactly
        // as one string travels on `staticString`. It has to: an inlined
        // call binds its parameter to the argument's VALUE and drops the
        // expression, so a scene passing mesh ids through its own helper
        // leaves nothing for `resolveStaticExpression` to fold. Only a
        // fully static list is carried, so a present field is complete.
        if (
            value.kind === "data" &&
            value.staticStrings === undefined &&
            value.dataType?.kind === "vector" &&
            value.dataType.element.kind === "string"
        ) {
            const strings = this.staticStringElements(expression);
            if (strings) {
                const withStrings = { ...value, staticStrings: strings };
                return withStrings;
            }
        }
        return value;
    }

    public compileWorkerValue(expression: ts.Expression): Value | undefined {
        const canvas = compileCanvasValue(this, expression);
        if (canvas) return canvas;
        if (this.options.workers) {
            const promise = this.asyncLowerer.compile(expression);
            if (promise) return promise;
        }
        return compileWorkerValue(this, expression);
    }

    public withOwnedCallbackBody<T>(body: () => T): T {
        this.frameCallbackDepth++;
        try {
            return body();
        } finally {
            this.frameCallbackDepth--;
        }
    }

    public isNativeWorkerExpression(expression: ts.Expression): boolean {
        return isNativeWorkerExpression(this, expression);
    }

    /**
     * The strings a generation-known array expression holds, spreads of
     * such arrays included, or undefined where any element is computed.
     *
     * Pure by construction: it resolves literals rather than compiling
     * them, so asking the question emits nothing.
     */
    public staticStringElements(
        expression: ts.Expression,
    ): readonly string[] | undefined {
        const literal =
            this.probeStaticArrayLiteral(expression) ??
            this.constArrayLiteral(expression);
        if (!literal) {
            const unwrapped = this.unwrap(expression);
            const binding = ts.isIdentifier(unwrapped)
                ? this.bindings.lookupOptional(unwrapped)
                : undefined;
            // A list generation holds by its elements (a local array its
            // pushes kept) has no literal to read.
            const elements =
                binding?.staticElementsOwner?.staticElements ??
                binding?.staticElements;
            if (binding?.staticStrings || !elements)
                return binding?.staticStrings;
            const held: string[] = [];
            for (const element of elements) {
                if (element.staticString === undefined) return undefined;
                held.push(element.staticString);
            }
            return held;
        }
        const strings: string[] = [];
        for (const element of literal.elements) {
            if (ts.isSpreadElement(element)) {
                const nested = this.staticStringElements(element.expression);
                if (!nested) return undefined;
                strings.push(...nested);
                continue;
            }
            const resolved = this.resolveStaticExpression(element);
            if (!ts.isStringLiteralLike(resolved)) return undefined;
            strings.push(resolved.text);
        }
        return strings;
    }

    /**
     * The array literal a `const` local was initialized from, when nothing
     * writes through the binding.
     *
     * `resolveStaticExpression`'s own const fallback answers for object
     * literals only, and widening it would move every consumer of static
     * resolution at once — so the array case stays here, behind its own
     * write scan: a list a scene mutates answers nothing.
     */
    public constArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined {
        if (
            this.knownValueWithoutEvaluation(expression)?.collectionCardinality
                ?.untrackedAliases
        )
            return undefined;
        const unwrapped = this.unwrap(expression);
        if (!ts.isIdentifier(unwrapped)) return undefined;
        const declarations =
            this.symbols.valueSymbol(unwrapped)?.declarations ?? [];
        const declaration =
            declarations.length === 1 ? declarations[0]! : undefined;
        if (
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !ts.isIdentifier(declaration.name) ||
            !ts.isVariableDeclarationList(declaration.parent) ||
            variableKind(declaration.parent) !== "const" ||
            !declaration.initializer
        ) {
            return undefined;
        }
        const initializer = this.unwrap(declaration.initializer);
        return ts.isArrayLiteralExpression(initializer) &&
            !this.constArrayIsWritten(declaration.name)
            ? initializer
            : undefined;
    }

    /**
     * Whether anything writes THROUGH a `const` array binding.
     *
     * `inferredArrayIsMutated` answers a neighbouring but different
     * question — does this local need runtime array storage — and every
     * call the array is passed to counts, because the callee has to read a
     * real container. A generation-time fold of the contents needs only
     * the writes, so the call clause asks this repository's own
     * `parameterIsReadOnly` instead, and a callee it cannot resolve stays
     * a write. Memoized per binding: the scan walks the whole entry file,
     * and one array is asked about once per use.
     */
    private constArrayIsWritten(identifier: ts.Identifier): boolean {
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) return true;
        const cached = this.writtenConstArrays.get(symbol);
        if (cached !== undefined) return cached;
        const written = aliasedMutationScan(
            identifier,
            (name) => this.symbols.valueSymbol(name),
            {
                aliasingInitializer: (initializer, scan) =>
                    scan.namesAlias(this.unwrap(initializer)),
                mutates: (node, scan) => this.writesThroughArray(node, scan),
            },
        );
        this.writtenConstArrays.set(symbol, written);
        return written;
    }

    /** `moduleConstantIsWritten` over this compiler's program. */
    private moduleConstantIsWritten(name: ts.Identifier): boolean {
        return moduleConstantIsWritten(this, name);
    }

    /**
     * One node's verdict for `constArrayIsWritten`'s scan.
     *
     * The three write shapes come from `writesThroughTrackedRoot`, the one
     * recognizer `parameterIsReadOnly` and `returnedValueCanMove` also
     * read. The target is anything inside the array (`referenceBases`):
     * writing a slot, its length or a member of an element changes what a
     * fold would read.
     */
    private writesThroughArray(
        node: ts.Node,
        scan: AliasedMutationScan,
    ): boolean {
        const isTarget = (expression: ts.Expression): boolean =>
            referenceBases(expression, (chain) => this.unwrap(chain)).some(
                scan.namesAlias,
            );
        if (
            writesThroughTrackedRoot(node, isTarget, {
                checker: this.checker,
                typed: true,
            })
        ) {
            return true;
        }
        // The fourth shape, which is this caller's alone: an alias handed
        // to a call that does not promise to leave it alone escapes there.
        return (
            ts.isCallExpression(node) &&
            node.arguments.some(
                (argument, index) =>
                    scan.containsAlias(argument) &&
                    !callArgumentIsReadOnly(this.checker, node, index),
            )
        );
    }

    /** `browserGeneratedString` with this compiler's own argument fold. */
    private bakedBrowserGeneratedString(
        call: ts.CallExpression,
    ): string | undefined {
        return browserGeneratedString(
            this.checker,
            call,
            (argument) => this.foldGeneratedStringArgument(argument),
            (expression) => this.symbols.pinnedWgslTemplate(expression),
        );
    }

    public compileBrowserGeneratedString(
        call: ts.CallExpression,
    ): Value | undefined {
        const value = this.bakedBrowserGeneratedString(call);
        return value === undefined
            ? undefined
            : {
                  kind: "string",
                  cpp: this.cppString(value),
                  staticString: value,
              };
    }

    /**
     * The compile-time value of one argument to a Canvas2D helper.
     *
     * A drawn texture is keyed by what it draws, so an argument reaching
     * the helper through an inlined parameter is as much a compile-time
     * input as one written as a literal at the call: scene 90 reaches
     * `labelTextureUrl(text)` from `createLabelMaterial(engine, "-")`, and
     * the string that decides the glyph is the bound parameter. A value
     * that does not settle to a scalar answers `undefined`, which is what
     * keeps a runtime argument from being spelled into the bake.
     *
     * The probe discards unconditionally, which is the one thing that
     * separates it from `compileStringLiteral`'s otherwise identical fold
     * a few hundred lines down: that one KEEPS what its value lowering
     * emitted, because the string it answers with is also a value the
     * program goes on to use. Here the helper's whole call disappears
     * into a baked asset, so anything it emitted would be a statement no
     * one reaches.
     */
    private foldGeneratedStringArgument(
        argument: ts.Expression,
    ): string | number | boolean | undefined {
        const value = this.probeEmission(
            () => this.compileValue(argument),
            () => false,
        );
        if (value.staticString !== undefined) return value.staticString;
        if (value.staticNumber !== undefined) return value.staticNumber;
        if (value.staticBoolean !== undefined) return value.staticBoolean;
        return undefined;
    }

    public enumMemberValue(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const constant =
            enumMemberConstant(this.checker, expression) ??
            this.symbols.pinnedConstantProperty(expression);
        if (typeof constant === "number") {
            return {
                kind: "number",
                cpp: dataDoubleLiteral(constant),
                staticNumber: constant,
            };
        }
        if (typeof constant === "string") {
            return {
                kind: "string",
                cpp: this.cppString(constant),
                staticString: constant,
            };
        }
        return undefined;
    }

    public compileRegisteredConstant(importedName: string): Value | undefined {
        return compileRegisteredConstant(importedName);
    }

    public compileStaticFetch(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        return compileStaticFetch(this, call, callee);
    }

    public compileStaticFetchMethod(
        call: ts.CallExpression,
        owner: Value,
        method: string,
    ): Value | undefined {
        return compileStaticFetchMethod(this, call, owner, method);
    }

    public compileRegisteredIntrinsic(
        importedName: string,
        call: ts.CallExpression,
    ): Value | undefined {
        if (
            importedName === "parseNodeMaterialFromSnippet" &&
            ((this.frameCallbackDepth > 0 &&
                this.isRuntimeResourceConstruction()) ||
                this.engineLifecycle.engineStartMark !== undefined ||
                this.admissions.temporalSceneRegistration)
        ) {
            this.fail(
                call,
                `Node material construction requires setup before scene registration; live group rebuilding is not represented (${this.frameCallbackDepth > 0 ? "callback" : this.engineLifecycle.engineStartMark !== undefined ? "engine started" : "scene registered"}).`,
            );
        }
        // A load after a runtime-profiled material, or one that runs a
        // generation-unknown number of times, has no creation-order place
        // among the composed rows, so every container announces its own.
        if (
            importedName === "loadGltf" &&
            (this.sceneManifest.hasRuntimeMaterialProfiles() ||
                (this.isRuntimeResourceConstruction() &&
                    (this.frameCallbackDepth > 0 ||
                        this.isInRuntimeControlFlow())))
        ) {
            this.sceneManifest.recordProfiledGltfLoads();
        }
        const profile =
            runtimeProfileConstructionIntrinsics.has(importedName) &&
            this.isRuntimeResourceConstruction();
        const mark = this.sceneManifest.compositionMark();
        const value = compileWithRuntimeCaseSplit(
            this,
            call,
            () => compileRegisteredIntrinsic(this, importedName, call),
            "held-text",
        );
        if (
            value &&
            [
                "registerTextRenderer",
                "registerScene",
                "registerSpriteRenderer",
                "registerFrameGraphContext",
                "registerEffectRenderer",
            ].includes(importedName)
        ) {
            this.reachedRenderContextRegistrations.add(importedName);
        }
        if (!profile || !value) return value;
        this.sceneManifest.recordRuntimeProfiles(mark);
        if (value.kind === "mesh" && value.sceneMeshIndex !== undefined) {
            const index = value.sceneMeshIndex;
            this.sceneManifest.recordRuntimeMeshProfile(index);
            writable(value).sceneMeshProfileIndex = index;
            delete writable(value).sceneMeshIndex;
            writable(value).cpp =
                `(bbl::upstream::begin_scene_mesh_profile(${this.requireEngine(value, call)}, ${index}u), ${value.cpp})`;
        }
        return value;
    }

    /** Ordered awaited setup may branch without becoming a retained callback. */
    public isRuntimeCallback(): boolean {
        return this.frameCallbackDepth > 0 && !this.isEngineSetupCallback();
    }

    private isEngineSetupCallback(): boolean {
        return !!(
            this.options.workers &&
            this.engineCreationExecution &&
            this.frameCallbackDepth ===
                this.engineCreationExecution.callback +
                    this.asyncActivations.awaitedSetupDepth -
                    this.engineCreationExecution.awaited
        );
    }

    public isRuntimeResourceConstruction(): boolean {
        if (
            this.isEngineSetupCallback() &&
            this.engineCreationExecution &&
            this.runtimeControlFlowDepth ===
                this.engineCreationExecution.control &&
            this.runtimeIterationDepth ===
                this.engineCreationExecution.iteration &&
            this.returnFrames
                .filter((frame) => frame.kind === "native")
                .slice(this.engineCreationExecution.native)
                .every(
                    (frame) =>
                        frame.kind === "native" && frame.coroutine === true,
                ) &&
            this.returnFrames.filter((frame) => frame.kind === "native")
                .length <=
                this.engineCreationExecution.native +
                    this.asyncActivations.awaitedSetupDepth -
                    this.engineCreationExecution.awaited
        ) {
            // Resource order is relative to this newly allocated engine.
            // A worker message can invoke the same factory again, creating
            // another engine with the same independently owned slot layout.
            return false;
        }
        return !this.definiteCollectionMutation();
    }

    @journaled public accessor engineCreationExecution:
        | {
              callback: number;
              control: number;
              iteration: number;
              native: number;
              awaited: number;
          }
        | undefined;

    /**
     * Some applications update an established thin-instance pool
     * through `GPUQueue.writeBuffer`, falling back to the pin's dirty range
     * when the GPU buffer does not exist yet. Native owns that upload boundary,
     * so the helper shape lowers to a retained raw-byte upload while
     * every other raw GPU use remains refused by the property surface.
     */
    public compileThinInstanceUploadHelper(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        const declaration = this.symbols
            .valueSymbol(callee)
            ?.declarations?.find(ts.isFunctionDeclaration);
        if (!declaration?.body || declaration.parameters.length !== 3) {
            return undefined;
        }
        const names = declaration.parameters.map(({ name }) => name);
        if (!names.every(ts.isIdentifier)) return undefined;
        const [meshParameter, bufferParameter, countParameter] = names.map(
            (name) => name.text,
        );
        if (
            !this.isDirectThinInstanceUploadBody(
                declaration.body,
                meshParameter!,
                bufferParameter!,
                countParameter!,
            )
        ) {
            return undefined;
        }
        this.expectArgumentCount(call, 3, 3);
        const mesh = this.bindings.pinValueToTemporary(
            this.compileValue(argumentAt(call, 0)),
            "thin_upload_mesh",
            argumentAt(call, 0),
        );
        this.expectKind(mesh, "mesh", argumentAt(call, 0));
        const matrices = this.bindings.pinValueToTemporary(
            this.compileValue(argumentAt(call, 1)),
            "thin_upload_matrices",
            argumentAt(call, 1),
        );
        if (matrices.kind !== "data" || matrices.dataType?.kind !== "f32array")
            this.fail(
                argumentAt(call, 1),
                "Direct thin-instance GPU uploads require a Float32Array byte view; Float64Array and union views need the source-managed synchronization path.",
            );
        const count = this.allocateTemporaryCppName("thin_upload_count");
        this.emit({
            kind: "declaration",
            type: "double",
            name: count,
            initializer: this.compileNumber(argumentAt(call, 2), "double"),
        });
        this.reachFeature("mesh:thin-instances", call);
        this.reachFeature("mesh:thin-instances-dynamic", call);
        this.sceneManifest.recordThinInstanceMesh(mesh.sceneMeshIndex);
        return {
            kind: "void",
            cpp: lowerThinInstanceUploadBody(
                declaration,
                [meshParameter!, bufferParameter!, countParameter!],
                this.requireEngine(mesh, call),
                mesh.cpp,
                matrices.cpp,
                count,
                this.allocateTemporaryCppName("thin_upload_pool"),
            ),
        };
    }

    /**
     * Lowers a full `GPUQueue.writeTexture` into the pixels texture object
     * that owns the upload. The native sprite backends observe the texture's
     * version during their ordinary update phase; no raw device object leaks
     * into generated application code.
     */
    public compilePixelsTextureUpload(
        call: ts.CallExpression,
    ): Value | undefined {
        const callee = namedMember(this.checker, this.unwrap(call.expression));
        const queue =
            callee?.name === "writeTexture"
                ? namedMember(this.checker, callee.expression)
                : undefined;
        if (queue?.name !== "queue" || !ts.isIdentifier(queue.expression)) {
            return undefined;
        }
        // A reached upload commonly captures `const device = engine._device`
        // in a later callback. Resolve the identifier through ordinary value
        // compilation so the outer lexical binding remains visible here;
        // lookupOptional only describes bindings installed in this immediate
        // compiler scope.
        const device = this.compileValue(queue.expression);
        if (device.kind !== "gpu-device") return undefined;
        this.expectArgumentCount(call, 4, 4);
        const destination = this.unwrap(argumentAt(call, 0));
        if (!ts.isObjectLiteralExpression(destination)) {
            this.fail(
                destination,
                "GPUQueue.writeTexture destination must name a pixels texture.",
            );
        }
        const textureValue = this.objectProperty(destination, "texture");
        const textureMember = textureValue
            ? this.unwrap(textureValue)
            : undefined;
        if (
            !textureMember ||
            !ts.isPropertyAccessExpression(textureMember) ||
            textureMember.name.text !== "texture"
        ) {
            this.fail(
                destination,
                "GPUQueue.writeTexture destination must be `{ texture: pixelsTexture.texture }`.",
            );
        }
        const texture = this.compileValue(textureMember.expression);
        if (texture.kind !== "texture" || texture.textureStorage !== "pixels") {
            this.fail(
                textureMember.expression,
                "GPUQueue.writeTexture currently updates createTexture2DFromPixels results.",
            );
        }
        const pixelValue = this.compileValue(argumentAt(call, 1));
        if (
            pixelValue.kind !== "data" ||
            pixelValue.dataType?.kind !== "u8array"
        ) {
            this.fail(
                argumentAt(call, 1),
                "GPUQueue.writeTexture source must be a Uint8Array.",
            );
        }
        this.reachFeature("texture:pixels", call);
        this.reachFeature("texture:pixels-writes", call);
        this.admissions.noteNodeInputAdmissionFailure(
            call,
            "Node input bindings do not represent later GPU writes to a texture producer.",
        );
        return {
            kind: "void",
            cpp:
                `bbl::update_pixels_texture(` +
                `${this.requireEngine(texture, call)}, ` +
                `${texture.cpp}, ${pixelValue.cpp})`,
        };
    }

    private isDirectThinInstanceUploadBody(
        body: ts.Block,
        meshParameter: string,
        bufferParameter: string,
        countParameter: string,
    ): boolean {
        let thinInstancesRead = false;
        let directUpload = false;
        const dirtyFields = new EmissionSet<string>();
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "thinInstances" &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === meshParameter
                ) {
                    thinInstancesRead = true;
                }
                if (
                    ts.isCallExpression(node) &&
                    namedMember(this.checker, node.expression)?.name ===
                        "writeBuffer" &&
                    node.arguments.length === 5
                ) {
                    const source = argumentAt(node, 2);
                    const offset = argumentAt(node, 3);
                    const size = argumentAt(node, 4);
                    directUpload =
                        ts.isPropertyAccessExpression(source) &&
                        source.name.text === "buffer" &&
                        ts.isIdentifier(source.expression) &&
                        source.expression.text === bufferParameter &&
                        ts.isPropertyAccessExpression(offset) &&
                        offset.name.text === "byteOffset" &&
                        ts.isIdentifier(offset.expression) &&
                        offset.expression.text === bufferParameter &&
                        ts.isBinaryExpression(size) &&
                        size.operatorToken.kind ===
                            ts.SyntaxKind.AsteriskToken &&
                        ts.isIdentifier(size.left) &&
                        size.left.text === countParameter &&
                        ts.isNumericLiteral(size.right) &&
                        Number(size.right.text) === 64;
                }
                if (
                    ts.isPropertyAccessExpression(node) &&
                    ["_version", "_dirtyMin", "_dirtyMax"].includes(
                        node.name.text,
                    )
                ) {
                    dirtyFields.add(node.name.text);
                }
            });
        visit(body);
        return thinInstancesRead && directUpload && dirtyFields.size === 3;
    }

    public guardStaticConstructionRead(operation: string): void {
        if (this.features.has("physics:viewer"))
            this.emit({
                kind: "expression",
                code: `bbl::pal::require_runtime_execution(${this.cppString(operation)});`,
            });
    }

    public expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression {
        const literal = this.evaluator.staticArrayLiteral(expression);
        if (literal) return literal;
        const resolved = this.resolveStaticLiteral(expression);
        if (ts.isArrayLiteralExpression(resolved)) return resolved;
        return this.evaluator.expectStaticArrayLiteral(expression);
    }

    public expectStaticArrayElements(
        expression: ts.Expression,
    ): ts.Expression[] {
        const projected = this.projectedStaticElements(expression);
        if (projected) return projected;
        return this.expectStaticArrayLiteral(expression).elements.flatMap(
            (element) =>
                ts.isSpreadElement(element)
                    ? this.expectStaticArrayElements(element.expression)
                    : [element],
        );
    }

    /**
     * The items of a generation-known list, as `expectStaticArrayElements`
     * spells them, or as the strings a part it cannot spell holds: a local
     * list its pushes kept (`staticStringElements`), or a closed call run
     * at generation (`ITEMS.map((item) => nameOf(item))`).
     */
    public staticListItems(expression: ts.Expression): StaticListItem[] {
        const resolved = this.resolveListExpression(expression);
        if (resolved !== this.unwrap(expression))
            return this.staticListItems(resolved);
        if (ts.isConditionalExpression(resolved)) {
            const selected = this.probeEmission(() => {
                const condition = this.resolveListExpression(
                    resolved.condition,
                );
                const name = this.unwrap(resolved.condition);
                const parameters =
                    ts.isIdentifier(name) && condition !== name
                        ? [
                              {
                                  name,
                                  value: this.compileValue(condition),
                                  compileTime: true,
                              },
                          ]
                        : [];
                // Keep the re-read condition's value in the selected arm too:
                // a predicate there may capture the const side-table entry.
                const within = <T>(read: () => T): T =>
                    this.bindings.withBoundParameters(parameters, read);
                const known = within(() =>
                    knownCondition(
                        this.conditions.compileCondition(resolved.condition),
                    ),
                );
                if (known === undefined) return undefined;
                return within(() =>
                    this.staticListItems(
                        known ? resolved.whenTrue : resolved.whenFalse,
                    ),
                ).map((item) => ({
                    ...item,
                    within: <T>(read: () => T): T =>
                        within(() => item.within(read)),
                }));
            });
            if (selected) return selected;
        }
        const filtered = this.filteredListItems(resolved);
        if (filtered) return filtered;
        const projected = this.projectedStaticElements(expression);
        if (projected) return projected.map(unboundListItem);
        const literal = unlessRefused(() =>
            this.expectStaticArrayLiteral(expression),
        );
        if (literal)
            return literal.elements.flatMap((element) =>
                ts.isSpreadElement(element)
                    ? this.staticListItems(element.expression)
                    : [unboundListItem(element)],
            );
        const held = this.heldStrings(expression);
        if (held)
            return held.map((text) => ({
                ...unboundListItem(expression),
                text,
            }));
        const returned =
            this.returnedListItems(expression) ??
            this.memberListItems(expression);
        if (returned) return returned;
        try {
            return this.expectStaticArrayElements(expression).map(
                unboundListItem,
            );
        } catch (error) {
            // The reader reads every item: a list holding a part
            // generation cannot read refuses with it.
            const value =
                error instanceof CompileError
                    ? this.probeEmission(
                          () =>
                              unlessRefused(() =>
                                  this.compileValue(expression),
                              ),
                          () => false,
                      )
                    : undefined;
            if (value) refuseUnreadablePart(this, value, expression);
            throw error;
        }
    }

    /** List syntax may re-read an unwritten local under the current variant. */
    private resolveListExpression(expression: ts.Expression): ts.Expression {
        return this.evaluator.resolveStaticExpression(expression, undefined, {
            scope: "local",
            readOnly: (declaration) =>
                ts.isIdentifier(declaration.name) &&
                !this.constArrayIsWritten(declaration.name),
        });
    }

    private filteredListItems(
        expression: ts.Expression,
    ): StaticListItem[] | undefined {
        if (
            !ts.isCallExpression(expression) ||
            expression.questionDotToken ||
            expression.arguments.length !== 1
        )
            return undefined;
        const member = namedMember(this.checker, expression.expression);
        const callback = this.unwrap(argumentAt(expression, 0));
        if (member?.name !== "filter" || !ts.isArrowFunction(callback))
            return undefined;
        return this.probeEmission(() => {
            const items = this.staticListItems(member.expression);
            const elements = items.map((item) =>
                this.staticListItemValue(item),
            );
            const owner: Value = {
                kind: "tuple",
                cpp: "",
                tupleElements: elements,
            };
            const selected: StaticListItem[] = [];
            for (let index = 0; index < items.length; ++index) {
                const matched = this.compilePredicateWithValues(
                    callback,
                    [
                        elements[index]!,
                        {
                            kind: "number",
                            cpp: `${index}.0`,
                            staticNumber: index,
                        },
                        owner,
                    ],
                    expression,
                );
                if (matched.staticBoolean === undefined) return undefined;
                if (matched.staticBoolean) selected.push(items[index]!);
            }
            return selected;
        });
    }

    private staticListItemValue(item: StaticListItem): Value {
        return item.within(() => {
            const json = item.text ?? staticJsonValue(this, item.node);
            return json === notJson
                ? this.compileValue(item.node)
                : jsonToValue(
                      this,
                      executedConstantJsonPolicy,
                      json,
                      item.node,
                  );
        });
    }

    /**
     * The items of the array literal a local function's call returns, for a
     * call generation cannot run (`returnedExpression`): a returned
     * conditional selects the literal its condition, known at generation,
     * names.
     */
    private returnedListItems(
        expression: ts.Expression,
    ): StaticListItem[] | undefined {
        const call = this.unwrap(expression);
        if (!ts.isCallExpression(call)) return undefined;
        const site = this.returnedExpression(call);
        return site && this.literalListItems(site.returned, site);
    }

    /**
     * The items of a list a record member holds (`a.b.c`) where the record
     * is what a local function's call returns (`returnedExpression`): the
     * call `a` is, or the one a `const` holds, re-running alike
     * (`rerunCallInitializer`) and written through by nothing before the
     * read; then each key the member of the record literal the returned
     * expression is, through module constants and calls of local functions
     * in turn.
     */
    private memberListItems(
        expression: ts.Expression,
    ): StaticListItem[] | undefined {
        const keys: string[] = [];
        let root = this.unwrap(expression);
        while (ts.isPropertyAccessExpression(root)) {
            keys.unshift(root.name.text);
            root = this.unwrap(root.expression);
        }
        const held = ts.isIdentifier(root)
            ? this.rerunCallInitializer(root)
            : undefined;
        const call = ts.isCallExpression(root)
            ? root
            : held &&
                !this.evaluator.isWrittenThroughBefore(
                    held.declaration,
                    expression,
                )
              ? held.call
              : undefined;
        if (keys.length === 0 || !call) return undefined;
        return this.probeEmission(
            () => unlessRefused(() => this.returnedMemberItems(call, keys)),
            (items) => items !== undefined,
        );
    }

    /** The items the member at `keys` of the record `call` returns holds (`memberListItems`). */
    private returnedMemberItems(
        call: ts.CallExpression,
        keys: readonly string[],
        enclosing: ReturnedExpression["within"] = (read) => read(),
    ): StaticListItem[] | undefined {
        const site = enclosing(() => this.returnedExpression(call));
        if (!site) return undefined;
        const within: ReturnedExpression["within"] = (read) =>
            enclosing(() => site.within(read));
        let node: ts.Expression = site.returned;
        for (const [index, key] of keys.entries()) {
            node = within(() => this.selectedReturnedExpression(node, site));
            if (ts.isCallExpression(node))
                return this.returnedMemberItems(
                    node,
                    keys.slice(index),
                    within,
                );
            const record = ts.isIdentifier(node)
                ? this.evaluator.resolveStaticLiteral(node)
                : node;
            const member = ts.isObjectLiteralExpression(record)
                ? this.objectProperty(record, key)
                : undefined;
            if (!member) return undefined;
            node = member;
        }
        const list = within(() => this.selectedReturnedExpression(node, site));
        if (ts.isCallExpression(list))
            return this.returnedMemberItems(list, [], within);
        return this.literalListItems(list, { ...site, within });
    }

    /**
     * `node`, a part of what a callee returns, past the conditionals its
     * known conditions settle and the callee's own `const` names it reads.
     */
    private selectedReturnedExpression(
        node: ts.Expression,
        site: ReturnedExpression,
    ): ts.Expression {
        for (let current = this.unwrap(node); ;) {
            if (ts.isConditionalExpression(current)) {
                const known = this.compileValue(
                    current.condition,
                ).staticBoolean;
                if (known === undefined) return current;
                current = this.unwrap(
                    known ? current.whenTrue : current.whenFalse,
                );
                continue;
            }
            const alias = ts.isIdentifier(current)
                ? site.aliases.get(this.symbols.valueSymbol(current)!)
                : undefined;
            if (!alias) return current;
            current = this.unwrap(alias);
        }
    }

    /** The items of an array literal `node` settles to, each read `within` the callee's scope. */
    private literalListItems(
        node: ts.Expression,
        site: Pick<ReturnedExpression, "within" | "aliases">,
    ): StaticListItem[] | undefined {
        const list = site.within(() =>
            this.selectedReturnedExpression(node, {
                ...site,
                returned: node,
            }),
        );
        if (!ts.isArrayLiteralExpression(list)) return undefined;
        const elements = list.elements;
        return site
            .within(() =>
                elements.flatMap((element) =>
                    ts.isSpreadElement(element)
                        ? this.staticListItems(element.expression)
                        : [unboundListItem(element)],
                ),
            )
            .map((item) => ({
                ...item,
                within: <T>(read: () => T): T =>
                    site.within(() => item.within(read)),
            }));
    }

    /**
     * What a call of a local function generation cannot run returns
     * (`StaticEvaluator.returnedExpression`), each argument evaluated once
     * here: a list generation reads as one, otherwise its value.
     */
    private returnedExpression(
        call: ts.CallExpression,
    ): ReturnedExpression | undefined {
        return this.evaluator.returnedExpression(call, () =>
            call.arguments.map((argument) =>
                this.bindings.pinValueToTemporary(
                    this.probeEmission(() =>
                        unlessRefused(() => ({
                            kind: "tuple" as const,
                            cpp: "",
                            tupleElements: this.staticListItems(argument).map(
                                (item) => this.staticListItemValue(item),
                            ),
                        })),
                    ) ?? this.compileValue(argument),
                    "list_argument",
                    argument,
                ),
            ),
        );
    }

    /** A scope binding `callee`'s parameters to `values`, `call`'s arguments, for reads `within` it. */
    private bindReturnedParameters(
        callee: FunctionWithBody,
        call: ts.CallExpression,
        values: readonly Value[],
    ): ReturnedExpression["within"] {
        return <T>(read: () => T): T => {
            this.bindings.pushScope(this.allocateUserFunctionPrefix());
            try {
                callee.parameters.forEach((parameter, index) =>
                    this.bindings.bindParameterValue(
                        parameter.name as ts.Identifier,
                        values[index]!,
                        call.arguments[index],
                    ),
                );
                return read();
            } finally {
                this.bindings.popScope();
            }
        };
    }

    /** The strings a list generation cannot spell holds (`staticListItems`). */
    private heldStrings(
        expression: ts.Expression,
    ): readonly string[] | undefined {
        const kept = this.staticStringElements(expression);
        if (kept) return kept;
        const selected = this.unwrap(
            this.evaluator.staticArrayExpression(expression),
        );
        if (!ts.isCallExpression(selected)) return undefined;
        const value = unlessRefused(() =>
            this.runGenerationFunction(
                selected,
                [],
                `List '${selected.expression.getText()}'`,
            ),
        );
        return Array.isArray(value) &&
            value.every((item): item is string => typeof item === "string")
            ? value
            : undefined;
    }

    /**
     * `xs.map(([, name]) => name)` (or `(x) => x.name`, `(x) => x`) over a
     * static array literal: each result is the source element's own node
     * the callback only selects, so the list stays static syntax.
     */
    private projectedStaticElements(
        expression: ts.Expression,
    ): ts.Expression[] | undefined {
        const call = this.unwrap(expression);
        if (!ts.isCallExpression(call) || call.arguments.length !== 1)
            return undefined;
        const map = namedMember(this.checker, call.expression);
        if (map?.name !== "map") return undefined;
        const callback = this.unwrap(argumentAt(call, 0));
        if (
            !ts.isArrowFunction(callback) ||
            callback.parameters.length !== 1 ||
            ts.isBlock(callback.body)
        )
            return undefined;
        const source = map.expression;
        const receiver = this.probeEmission(
            () => this.expectStaticArrayElements(source),
            () => false,
        );
        const parameter = callback.parameters[0]!.name;
        const body = this.unwrap(callback.body);
        const select = (element: ts.Expression): ts.Expression | undefined => {
            if (ts.isIdentifier(parameter)) {
                if (ts.isIdentifier(body) && body.text === parameter.text)
                    return element;
                if (
                    ts.isPropertyAccessExpression(body) &&
                    ts.isIdentifier(body.expression) &&
                    body.expression.text === parameter.text
                ) {
                    const record = this.resolveStaticLiteral(element);
                    return ts.isObjectLiteralExpression(record)
                        ? this.objectProperty(record, body.name.text)
                        : undefined;
                }
                return undefined;
            }
            if (!ts.isArrayBindingPattern(parameter) || !ts.isIdentifier(body))
                return undefined;
            const index = parameter.elements.findIndex(
                (binding) =>
                    ts.isBindingElement(binding) &&
                    !binding.dotDotDotToken &&
                    ts.isIdentifier(binding.name) &&
                    binding.name.text === body.text,
            );
            return index >= 0
                ? literalMember(this.resolveStaticLiteral(element), index)
                : undefined;
        };
        const elements = receiver.map(select);
        return elements.every((element) => element !== undefined)
            ? elements
            : undefined;
    }

    public referenceSearch(): string {
        return this.options.search;
    }

    /** See `libraryGlobal` (symbols.ts). */
    public libraryGlobal(expression: ts.Expression): string | undefined {
        return this.symbols.libraryGlobal(expression);
    }

    /**
     * The number a named record's field holds: its initializer's, when the
     * name is a static literal and that initializer re-reads alike; else the
     * bound number, when its binding still holds the record it was declared
     * with and, for a record in native storage, no write in the program
     * (through this type or any view of it) can have replaced the field.
     */
    public staticProperty(
        access: ts.PropertyAccessExpression,
    ): number | undefined {
        // Resolving anything but a name may inline, and so emit, its calls.
        if (!ts.isIdentifier(access.expression)) return undefined;
        const target = this.resolveStaticExpression(access.expression);
        if (ts.isObjectLiteralExpression(target)) {
            const field = unlessRefused(() =>
                this.objectProperty(target, access.name.text),
            );
            return field && this.rereadsAlike(field)
                ? staticNumberValue(this, field)
                : undefined;
        }
        if (!ts.isIdentifier(target)) return undefined;
        const owner = this.bindings.lookupOptional(target);
        // Another closure may replace a shared cell's whole record.
        if (
            !owner ||
            owner.sharedStorageCpp !== undefined ||
            !this.bindings.recordPropertiesAreCurrent(owner)
        )
            return undefined;
        const property = owner.recordProperties?.[access.name.text];
        // A static record's field is what reading it yields; only one in
        // native storage can take a write through another view.
        if (
            property?.kind !== "number" ||
            property.parameterBinding ||
            (owner.kind !== "record" &&
                recordFieldIsWritten(
                    this,
                    this.checker.getTypeAtLocation(access.expression),
                    access.name.text,
                ))
        )
            return undefined;
        return property.staticNumber;
    }

    /** The value symbol an expression names once unwrapped, or undefined. */
    public unwrappedValueSymbol(
        expression: ts.Expression,
        onAwait?: (awaited: ts.AwaitExpression) => void,
    ): ts.Symbol | undefined {
        const identifier = unwrappedIdentifier(expression, (wrapped) =>
            onAwait
                ? this.evaluator.unwrap(wrapped, { onAwait })
                : this.unwrap(wrapped),
        );
        return identifier && this.symbols.valueSymbol(identifier);
    }

    public compileVec3(
        expression: ts.Expression,
        precision: "float" | "double",
    ): string {
        return this.evaluator.compileVec3(expression, precision);
    }

    public vec3FromRecord(
        value: Value,
        node: ts.Node,
        precision: "float" | "double",
    ): string {
        return this.evaluator.vec3FromRecord(value, node, precision);
    }

    /**
     * A data struct's numeric field read where the struct stands;
     * undefined when the field holds no number.
     */
    private structNumber(
        value: Value,
        name: string,
        node: ts.Node,
    ): Value | undefined {
        if (value.dataType?.kind !== "struct") return undefined;
        const struct = value.dataType.name;
        const field = this.dataTypes.structField(struct, name, node);
        return field.type.kind === "number"
            ? {
                  kind: "number",
                  cpp: `${value.cpp}${this.dataTypes.memberAccess(struct)}${field.name}`,
              }
            : undefined;
    }

    /** One number Value at one sink's width — the rule, in one place. */
    public castNumber(value: Value, precision: "float" | "double"): string {
        return this.evaluator.castNumber(value, precision);
    }

    public compileBoolean(expression: ts.Expression): string {
        return (
            this.dataLowerer.assignedCondition(expression, () =>
                this.compileBoolean(expression),
            ) ?? this.evaluator.compileBoolean(expression)
        );
    }

    /** Nonzero while a frame callback's statements are being lowered. */
    @journaled public accessor frameCallbackDepth = 0;
    /** Native path-dependent bodies currently being lowered. */
    @journaled public accessor runtimeControlFlowDepth = 0;
    /** Native loop expressions/bodies currently being lowered. */
    @journaled private accessor runtimeIterationDepth = 0;
    private readonly parameterizedResourceIterations: Array<{
        statement: ResourceLoop;
        iterations: number;
        controlDepth: number;
        iterationDepth: number;
    }> = emissionArray([]);
    private readonly staticExpansionBudget = new StaticExpansionBudget(
        (node, message) => this.fail(node, message),
    );
    /** Per-iteration scope keys while a loop is being statically emitted. */
    private readonly staticCallbackEvaluationIdentities: object[] =
        emissionArray([]);

    public compileColor3(expression: ts.Expression): string {
        return this.evaluator.compileColor3(expression);
    }

    public compileColor4(expression: ts.Expression): string {
        return this.evaluator.compileColor4(expression);
    }

    public compileNumber(
        expression: ts.Expression,
        precision: "float" | "double",
    ): string {
        return (
            this.dataLowerer.assignedNumber(expression, precision) ??
            this.evaluator.compileNumber(expression, precision)
        );
    }

    public compileEnumSwitchLabel(
        expression: ts.Expression,
        dataType: DataType & { kind: "enum" },
    ): string | undefined {
        const literal = this.evaluator.staticTextValue(expression);
        if (literal === undefined) {
            this.fail(
                expression,
                "Enum switch case labels must be compile-time strings.",
            );
        }
        return this.dataTypes.enumMembers(dataType.name).includes(literal)
            ? this.dataTypes.enumMemberCpp(dataType, literal, expression)
            : undefined;
    }

    /**
     * An options bag, written inline or named by a `const` above the call.
     *
     * Resolved rather than merely unwrapped, which is what
     * `expectStaticArrayLiteral` already does for the list form: a scene
     * that names its parameters once and passes the name is writing the
     * same literal, and refusing it would refuse a spelling.
     */
    public expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression {
        const resolved = this.evaluator.resolveStaticLiteral(expression);
        if (ts.isObjectLiteralExpression(resolved)) return resolved;
        return (
            this.boundRecordLiteral(expression) ??
            this.fail(resolved, "Expected an object literal.")
        );
    }

    /**
     * A name, or a member chain of one, bound to a record whose properties
     * are current, as the literal of its own fields: each one reads the
     * bound owner, whose initializer has already run, and dynamic fields
     * remain ordinary native reads. Undefined for anything else.
     */
    private boundRecordLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression | undefined {
        const node = this.unwrap(expression);
        const path: string[] = [];
        let root: ts.Expression = node;
        while (ts.isPropertyAccessExpression(root) && !root.questionDotToken) {
            path.unshift(root.name.text);
            root = this.unwrap(root.expression);
        }
        if (!ts.isIdentifier(root)) return undefined;
        const named = this.bindings.lookupOptional(root);
        const bound =
            path.length === 0
                ? named
                : this.bindings.currentRecordMember(named, path);
        if (!bound) return undefined;
        // A struct whose every field is always an own key: its fields.
        if (
            ts.isIdentifier(node) &&
            bound.kind === "data" &&
            bound.dataType?.kind === "struct"
        ) {
            const keys = knownOwnKeys(this, bound, node);
            return keys ? this.memberLiteral(node, keys) : undefined;
        }
        const properties = bound.recordProperties;
        const keys =
            bound.recordOwnKeys ??
            (bound.kind === "record" && properties
                ? Object.keys(properties)
                : undefined);
        return properties &&
            keys &&
            this.bindings.recordPropertiesAreCurrent(bound) &&
            !Object.keys(bound.recordGetters ?? {}).length &&
            !Object.keys(bound.recordSetters ?? {}).length &&
            !Object.keys(bound.recordMethods ?? {}).length &&
            keys.every(
                (key) =>
                    key !== "__proto__" &&
                    properties[key] !== undefined &&
                    !properties[key].conditionalOwnKey,
            )
            ? this.memberLiteral(node, keys)
            : undefined;
    }

    /** The literal `{ key: owner.key, ... }` of `keys`, placed where `owner` stands. */
    public memberLiteral(
        owner: ts.Expression,
        keys: readonly string[],
    ): ts.ObjectLiteralExpression {
        const object = ts.factory.createObjectLiteralExpression(
            keys.map((key) => {
                const access = ts.factory.createPropertyAccessExpression(
                    owner,
                    key,
                );
                ts.setOriginalNode(access, owner);
                ts.setTextRange(access, owner);
                writable(access).parent = owner.parent;
                writable(access.name).parent = access;
                const keyLiteral = ts.factory.createStringLiteral(key);
                ts.setOriginalNode(keyLiteral, owner);
                ts.setTextRange(keyLiteral, owner);
                const assignment = ts.factory.createPropertyAssignment(
                    keyLiteral,
                    access,
                );
                ts.setOriginalNode(assignment, owner);
                ts.setTextRange(assignment, owner);
                writable(keyLiteral).parent = assignment;
                return assignment;
            }),
        );
        ts.setOriginalNode(object, owner);
        ts.setTextRange(object, owner);
        writable(object).parent = owner.parent;
        return object;
    }

    /**
     * The value a literal (static spreads expanded) gives `name`, from its
     * last writer ({@link lastWriter}); undefined when no member writes it.
     * A later spread whose type may hold `name`, or a key generation cannot
     * read, leaves it to the run time: refused here rather than read as
     * absent.
     */
    public objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined {
        const writer = lastWriter(
            objectLiteralMembers(this.objectProperties(object), (key) =>
                this.propertyName(key),
            ),
            name,
            (spread, key) =>
                typeMayHoldKey(this.checker, spread.expression, key),
        );
        if (writer === "unknown")
            return this.fail(
                object,
                `'${name}' may come from a spread or key only the run time knows.`,
            );
        return writer?.value;
    }

    public objectProperties(
        object: ts.ObjectLiteralExpression,
    ): readonly ts.ObjectLiteralElementLike[] {
        return object.properties.flatMap((property) => {
            const settled = ts.isSpreadAssignment(property)
                ? this.staticSpreadObject(property)
                : undefined;
            return settled ? this.objectProperties(settled) : [property];
        });
    }

    private staticSpreadObject(
        spread: ts.SpreadAssignment,
    ): ts.ObjectLiteralExpression | undefined {
        // A probe: a spread generation cannot settle leaves no trace.
        return this.probeEmission(() => {
            const selected = selectedStaticExpression(
                this.literalSelection(),
                spread.expression,
            );
            if (!selected) return undefined;
            return ts.isObjectLiteralExpression(selected)
                ? selected
                : this.boundRecordLiteral(selected);
        });
    }

    /**
     * The key a property name declares, when knowing it runs no code: the
     * checker's ({@link staticPropertyKey}), else a computed key generation
     * folds (`[prefix + "x"]`). Reading it emits nothing. A computed key that
     * calls, constructs, awaits or writes has none here: only the literal
     * that runs it knows it ({@link compilePropertyKey}).
     */
    public propertyName(name: ts.PropertyName): string | undefined {
        if (
            ts.isComputedPropertyName(name) &&
            expressionHasEffects(name.expression)
        )
            return undefined;
        const key = staticPropertyKey(this.checker, name);
        if (key !== undefined || !ts.isComputedPropertyName(name)) return key;
        const value = this.probeEmission(
            () => this.compileValue(name.expression),
            () => false,
        );
        return staticKeyOf(value);
    }

    /**
     * Evaluates a literal member's key where the literal runs it, its
     * effects in source order (`{ [next()]: v }`), and returns the key
     * generation knows. A key that runs nothing reads as
     * {@link propertyName}.
     */
    public compilePropertyKey(name: ts.PropertyName): string | undefined {
        if (
            !ts.isComputedPropertyName(name) ||
            !expressionHasEffects(name.expression)
        )
            return this.propertyName(name);
        const value = this.compileValue(name.expression);
        const key = staticPropertyKey(this.checker, name) ?? staticKeyOf(value);
        if (key !== undefined) this.emitDiscardedValue(value);
        return key;
    }

    public compileStringLiteral(expression: ts.Expression): string {
        const moduleAsset = this.moduleRelativeAssetUrl(expression);
        if (moduleAsset !== undefined) return moduleAsset;
        const unwrapped = this.unwrap(expression);
        const carried =
            ts.isIdentifier(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped) ||
            ts.isTemplateExpression(unwrapped) ||
            ts.isCallExpression(unwrapped)
                ? this.unlessShaderSourceRefuses(() =>
                      this.probeEmission(
                          () => this.compileValue(unwrapped),
                          (value) => value.staticString !== undefined,
                      ),
                  )
                : undefined;
        if (carried?.staticString !== undefined) {
            // Static helper scans commonly carry a URL through a decoded
            // record and a statically unrolled loop.  The AST is no longer
            // a literal at the asset call, but the bound Value still is.
            return carried.staticString;
        }
        const resolved = this.resolveStaticExpression(expression);
        if (ts.isCallExpression(resolved)) {
            const generated = this.bakedBrowserGeneratedString(resolved);
            if (generated !== undefined) return generated;
            const callee = this.unwrap(resolved.expression);
            if (ts.isIdentifier(callee)) {
                const declaration = resolveFunctionDeclaration(
                    this.checker,
                    callee,
                    (node, message) => this.fail(node, message),
                );
                const returned = this.builderReturn(declaration);
                if (
                    returned &&
                    (ts.isTemplateExpression(returned) ||
                        ts.isStringLiteralLike(returned))
                ) {
                    // This is a generation-time source factory, so keep its
                    // numeric arguments in the inliner's static domain. The
                    // ordinary value path is allowed to hoist a plain-data
                    // string helper into a native function, which would turn
                    // the shader source into a runtime string after the
                    // variant table has already been generated.
                    const value = this.unlessShaderSourceRefuses(() =>
                        declaration && !ts.isFunctionDeclaration(declaration)
                            ? this.userFunctions.compileCallbackWithValues(
                                  this,
                                  declaration,
                                  resolved.arguments.map((argument) =>
                                      this.compileValue(
                                          this.alwaysUsedParameterDefault(
                                              argument,
                                          ) ?? argument,
                                      ),
                                  ),
                                  resolved,
                              )
                            : this.userFunctions.compile(
                                  this,
                                  resolved,
                                  callee,
                              ),
                    );
                    if (value?.staticString !== undefined) {
                        return value.staticString;
                    }
                }
            }
        }
        return this.evaluator.compileStringLiteral(expression);
    }

    /** Literal calls to the pinned module-asset helper across reached sources. */
    public staticAssetUrlCandidates(): readonly string[] {
        if (this.staticAssetUrlCandidateCache) {
            return this.staticAssetUrlCandidateCache;
        }
        const candidates = new EmissionSet<string>();
        // Native physics substitutes the browser module; its loader
        // callbacks are never invoked or packaged.
        const physicsModuleCall = (node: ts.Node): boolean =>
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            this.symbols.isPhysicsEngineModule(node.expression);
        for (const source of this.sourceFiles())
            for (const node of sourceFileNodes(source))
                if (
                    ts.isCallExpression(node) &&
                    node.arguments.length === 2 &&
                    ts.isStringLiteralLike(argumentAt(node, 0)) &&
                    !ts.findAncestor(node, physicsModuleCall)
                ) {
                    const url = this.moduleRelativeAssetUrl(node);
                    if (url !== undefined) candidates.add(url);
                }
        this.staticAssetUrlCandidateCache = [...candidates].sort();
        return this.staticAssetUrlCandidateCache;
    }

    /** An `await` the evaluator's unwrap passed: the adaptation report counts it. */
    private recordUnwrappedAwait(expression: ts.AwaitExpression): void {
        this.unwrappedAwaitExpressions.add(expression.pos);
    }

    /**
     * The initializer of a parameter which every source call omits.
     *
     * A shader-source factory can sit inside a wrapper that native-function
     * lowering has already parameterized. If the wrapper's parameter is
     * nevertheless omitted at every call, JavaScript always observes its
     * default and generation may retain that value instead of losing it to
     * the native signature.
     */
    private alwaysUsedParameterDefault(
        expression: ts.Expression,
    ): ts.Expression | undefined {
        const node = this.unwrap(expression);
        if (!ts.isIdentifier(node)) return undefined;
        const symbol = this.symbols.valueSymbol(node);
        const parameter =
            symbol?.valueDeclaration && ts.isParameter(symbol.valueDeclaration)
                ? symbol.valueDeclaration
                : symbol?.declarations?.find(ts.isParameter);
        if (!parameter?.initializer || !ts.isFunctionLike(parameter.parent)) {
            return undefined;
        }
        const known = parameterDefaultAnswers.get(parameter);
        if (known) {
            // The walk's unwraps record the awaits they pass in every compile.
            for (const awaited of known.awaits)
                this.recordUnwrappedAwait(awaited);
            return known.initializer;
        }
        const owner = parameter.parent;
        const index = owner.parameters.indexOf(parameter);
        if (index < 0) return undefined;
        const awaits: ts.AwaitExpression[] = [];
        const onAwait = (awaited: ts.AwaitExpression): void => {
            awaits.push(awaited);
        };
        let reachedCall = false;
        let passedExplicitly = false;
        const ownerName = ts.isFunctionDeclaration(owner)
            ? owner.name
            : ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)
              ? owner.parent &&
                ts.isVariableDeclaration(owner.parent) &&
                ts.isIdentifier(owner.parent.name)
                  ? owner.parent.name
                  : undefined
              : undefined;
        const ownerSymbol = ownerName
            ? this.symbols.valueSymbol(ownerName)
            : undefined;
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (candidate) => {
                if (passedExplicitly) return "skip";
                if (
                    ts.isCallExpression(candidate) &&
                    (calledDeclaration(this.checker, candidate) === owner ||
                        (ownerSymbol !== undefined &&
                            this.unwrappedValueSymbol(
                                candidate.expression,
                                onAwait,
                            ) === ownerSymbol))
                ) {
                    reachedCall = true;
                    if (candidate.arguments.length > index) {
                        passedExplicitly = true;
                        return "skip";
                    }
                }
            });
        for (const source of this.sourceFiles()) visit(source);
        const initializer =
            reachedCall && !passedExplicitly
                ? parameter.initializer
                : undefined;
        parameterDefaultAnswers.set(parameter, { initializer, awaits });
        return initializer;
    }

    /** The path and pathname rewrites of a pure helper called against the module's URL. */
    private moduleRelativeAssetCall(expression: ts.Expression):
        | {
              path: ts.Expression;
              replacements: readonly (readonly [string, string])[];
          }
        | undefined {
        const resolved = this.resolveStaticExpression(expression);
        if (
            !ts.isCallExpression(resolved) ||
            !ts.isIdentifier(resolved.expression) ||
            resolved.arguments.length !== 2 ||
            !this.isImportMetaUrl(argumentAt(resolved, 1))
        ) {
            return undefined;
        }
        const declaration = this.symbols
            .valueSymbol(resolved.expression)
            ?.declarations?.find(ts.isFunctionDeclaration);
        if (
            !declaration?.body ||
            functionKind(declaration) !== "plain" ||
            declaration.parameters.length !== 2 ||
            declaration.parameters.some((parameter) => parameter.dotDotDotToken)
        ) {
            return undefined;
        }
        const pathParameter = declaration.parameters[0]!.name;
        const moduleParameter = declaration.parameters[1]!.name;
        if (
            !ts.isIdentifier(pathParameter) ||
            !ts.isIdentifier(moduleParameter)
        ) {
            return undefined;
        }
        const replacements = this.moduleUrlPathReplacements(
            declaration.body,
            pathParameter.text,
            moduleParameter.text,
        );
        return replacements
            ? { path: argumentAt(resolved, 0), replacements }
            : undefined;
    }

    public isModuleRelativeAssetCall(expression: ts.Expression): boolean {
        return this.moduleRelativeAssetCall(expression) !== undefined;
    }

    /** A folded module URL for static asset sinks and package discovery. */
    private moduleRelativeAssetUrl(
        expression: ts.Expression,
    ): string | undefined {
        const helper = this.moduleRelativeAssetCall(expression);
        if (!helper || expressionMayRunCode(helper.path)) return undefined;
        const text = unlessRuntimeValue(() =>
            this.evaluator.compileStringLiteral(helper.path),
        );
        return text === undefined
            ? undefined
            : moduleRelativeUrl(text, helper.replacements);
    }

    public compileModuleRelativeAssetUrl(
        call: ts.CallExpression,
    ): Value | undefined {
        const helper = this.moduleRelativeAssetCall(call);
        if (!helper) return undefined;
        const path = this.compileValue(helper.path);
        const folded =
            path.staticString !== undefined && !path.parameterBinding
                ? moduleRelativeUrl(path.staticString, helper.replacements)
                : undefined;
        if (folded !== undefined) {
            if (path.impure) this.emitDiscardedValue(path);
            return staticStringValue(folded, (text) => this.cppString(text));
        }
        // The literal directory is a package inventory hint, never the value of the URL.
        const template = this.unwrap(helper.path);
        if (
            ts.isTemplateExpression(template) &&
            template.head.text.endsWith("/")
        ) {
            const prefix = moduleRelativeUrl(
                template.head.text,
                helper.replacements,
            );
            const candidates = this.staticAssetUrlCandidates();
            if (
                prefix !== undefined &&
                prefix.endsWith("/") &&
                !candidates.includes(prefix)
            )
                this.staticAssetUrlCandidateCache = [
                    ...candidates,
                    prefix,
                ].sort();
        }
        this.reachJsData();
        const input = this.dataLowerer.compileKnownValueForSink(
            path,
            { kind: "string" },
            helper.path,
        );
        const urlType = this.dataTypes.cppType({ kind: "url" });
        const url = this.allocateTemporaryCppName("module_url");
        this.emit({
            kind: "declaration",
            type: urlType,
            name: url,
            initializer: `${urlType}(${input}, std::string_view(${this.cppString(nativeModuleUrl)}))`,
        });
        for (const [from, to] of helper.replacements)
            this.emit(
                `${url}.set_pathname(bbl::js::string_replace(${url}.pathname(), ${this.cppString(from)}, ${this.cppString(to)}, false));`,
            );
        return {
            kind: "data",
            dataType: { kind: "string" },
            cpp: `(${url}.origin() == ${this.cppString(nativeModuleOrigin)} ? ${url}.pathname() + ${url}.search() + ${url}.hash() : ${url}.href())`,
        };
    }

    private isImportMetaUrl(expression: ts.Expression): boolean {
        const unwrapped = this.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            const value = this.bindings.lookupOptional(unwrapped)?.browserValue;
            return value?.kind === "object" && value.moduleUrl === true;
        }
        return (
            ts.isPropertyAccessExpression(unwrapped) &&
            unwrapped.name.text === "url" &&
            ts.isMetaProperty(unwrapped.expression) &&
            unwrapped.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
            unwrapped.expression.name.text === "meta"
        );
    }

    private moduleUrlPathReplacements(
        body: ts.Block,
        pathParameter: string,
        moduleParameter: string,
    ): readonly (readonly [string, string])[] | undefined {
        const [declarationStatement, ...tail] = body.statements;
        const returned = tail.at(-1);
        if (
            !declarationStatement ||
            !ts.isVariableStatement(declarationStatement) ||
            declarationStatement.declarationList.declarations.length !== 1 ||
            !returned ||
            !ts.isReturnStatement(returned) ||
            !returned.expression
        ) {
            return undefined;
        }
        const declaration =
            declarationStatement.declarationList.declarations[0]!;
        if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.initializer ||
            !ts.isNewExpression(declaration.initializer) ||
            this.libraryGlobal(declaration.initializer.expression) !== "URL" ||
            declaration.initializer.arguments?.length !== 2 ||
            identifierText(argumentAt(declaration.initializer, 0)) !==
                pathParameter ||
            identifierText(argumentAt(declaration.initializer, 1)) !==
                moduleParameter
        ) {
            return undefined;
        }
        const urlVariable = declaration.name.text;
        if (
            !ts.isPropertyAccessExpression(returned.expression) ||
            !ts.isIdentifier(returned.expression.expression) ||
            returned.expression.expression.text !== urlVariable ||
            returned.expression.name.text !== "href"
        ) {
            return undefined;
        }
        const replacements: [string, string][] = [];
        for (const statement of tail.slice(0, -1)) {
            if (
                !ts.isExpressionStatement(statement) ||
                !ts.isBinaryExpression(statement.expression) ||
                statement.expression.operatorToken.kind !==
                    ts.SyntaxKind.EqualsToken
            ) {
                return undefined;
            }
            const assignment = statement.expression;
            const left = namedMember(this.checker, assignment.left);
            const call = assignment.right;
            const replace = ts.isCallExpression(call)
                ? namedMember(this.checker, call.expression)
                : undefined;
            const read =
                replace && namedMember(this.checker, replace.expression);
            if (
                !left ||
                !ts.isIdentifier(left.expression) ||
                left.expression.text !== urlVariable ||
                left.name !== "pathname" ||
                !ts.isCallExpression(call) ||
                replace?.name !== "replace" ||
                !read ||
                !ts.isIdentifier(read.expression) ||
                read.expression.text !== urlVariable ||
                read.name !== "pathname" ||
                call.arguments.length !== 2
            ) {
                return undefined;
            }
            const from = stringLiteralText(argumentAt(call, 0));
            const to = stringLiteralText(argumentAt(call, 1));
            if (from === undefined || to === undefined) {
                return undefined;
            }
            replacements.push([from, to]);
        }
        return replacements;
    }

    public importedCall(
        expression: ts.Expression,
        importedName: string,
    ): ts.CallExpression | undefined {
        const unwrapped = this.unwrap(expression);
        if (
            !ts.isCallExpression(unwrapped) ||
            !ts.isIdentifier(unwrapped.expression) ||
            this.symbols.importedName(unwrapped.expression) !== importedName
        ) {
            return undefined;
        }
        return unwrapped;
    }

    /**
     * `requiredLimits`: the record's present numeric members by WebGPU limit
     * name, in property order, as the device request reads them
     * (`EngineOptions::required_limits`; an undefined member requests nothing).
     */
    private compileRequiredLimits(site: ts.Expression): string {
        const target = this.allocateTemporaryCppName("required_limits");
        this.emit({
            kind: "declaration",
            type: "std::vector<std::pair<std::string, double>>",
            name: target,
            initializer: "{}",
        });
        for (const field of retainedOptions(
            this,
            this.compileValue(site),
            site,
        )) {
            const type =
                field.type?.kind === "optional" ? field.type.inner : field.type;
            if (type?.kind !== "number")
                this.fail(
                    site,
                    `Engine requiredLimits.${field.name} requires a number.`,
                );
            const value =
                field.value && field.type?.kind !== "optional"
                    ? this.castNumber(field.value, "double")
                    : field.cpp;
            const entry = `${target}.emplace_back(${this.cppString(field.name)}, `;
            this.emit({
                kind: "expression",
                code:
                    field.type?.kind === "optional"
                        ? `if (${value}.has_value()) ${entry}*${value});`
                        : `${entry}${value});`,
            });
        }
        return target;
    }

    public compileEngineCreation(
        call: ts.CallExpression,
        cppName: string,
    ): Value {
        this.expectArgumentCount(call, 1, 2);
        let canvasArgument = "";
        let engineCanvas: Value | undefined;
        if (this.options.workers) {
            const canvas = this.compileValue(argumentAt(call, 0));
            engineCanvas = canvas;
            if (
                canvas.kind !== "offscreen-canvas" &&
                canvas.kind !== "ui-element"
            )
                this.fail(
                    argumentAt(call, 0),
                    "The realm engine requires a native canvas context.",
                );
            if (canvas.kind === "ui-element") {
                const snapshot = this.allocateTemporaryCppName("engine_canvas");
                this.emit({
                    kind: "declaration",
                    type: "const auto",
                    name: snapshot,
                    initializer: `bbl::pal::window_canvas(${canvas.cpp})`,
                });
                canvasArgument = `, ${snapshot}`;
            } else {
                canvasArgument = `, ${
                    this.bindings.pinValueToTemporary(
                        canvas,
                        "engine_canvas",
                        argumentAt(call, 0),
                    ).cpp
                }`;
            }
        }
        let msaaSamples: 1 | 4 | "runtime" = 4;
        let sampleOverride: string | undefined;
        let pixelRatioCap: string | undefined;
        let highPrecisionMatrix = false;
        let floatingOrigin = false;
        let requiredLimits: string | undefined;
        if (call.arguments[1]) {
            const options = this.expectObjectLiteral(call.arguments[1]);
            validateObjectProperties(
                this,
                options,
                [
                    "maxDevicePixelRatio",
                    "msaaSamples",
                    "requiredLimits",
                    "useHighPrecisionMatrix",
                    "useFloatingOrigin",
                ],
                "Reached engine options support maxDevicePixelRatio, msaaSamples, " +
                    "requiredLimits, useHighPrecisionMatrix and useFloatingOrigin.",
            );
            pixelRatioCap = compileEnginePixelRatioCap(this, options);
            // Both flags reach generation: the pin's `_setHpmAllocator`
            // swaps a process-global allocator, so `useHighPrecisionMatrix`
            // decides the width every matrix this port composes is stored
            // at, and `useFloatingOrigin` decides the frame they are
            // composed in.
            ({ highPrecisionMatrix, floatingOrigin } =
                compileEnginePrecisionPolicy(this, options));
            const samples = this.objectProperty(options, "msaaSamples");
            if (samples) {
                const value = this.compileValue(samples);
                const staticSamples =
                    value.staticNumber ??
                    this.probeEmission(
                        () => selectedStaticNumberValue(this, samples),
                        () => false,
                    );
                if (staticSamples !== undefined) {
                    if (!isSampleCount(staticSamples))
                        this.fail(
                            samples,
                            "Native engine lowering supports explicit msaaSamples: 1 or 4 only.",
                        );
                    this.emitDiscardedValue(value);
                    msaaSamples = staticSamples;
                    this.engineMsaaSamples = staticSamples;
                } else {
                    const represented =
                        this.dataLowerer.compileKnownValueForSink(
                            value,
                            { kind: "json" },
                            samples,
                        );
                    sampleOverride =
                        this.allocateTemporaryCppName("engine_samples");
                    this.emit({
                        kind: "declaration",
                        type: "const std::uint32_t",
                        name: sampleOverride,
                        initializer: `(${represented}).strict_equals(1.0) ? 1u : 4u`,
                    });
                    msaaSamples = "runtime";
                }
            }
            const limits = this.objectProperty(options, "requiredLimits");
            if (limits) requiredLimits = this.compileRequiredLimits(limits);
        }
        if (this.defaultEngineCpp) {
            this.fail(
                call,
                "The prototype currently supports one engine per entry point.",
            );
        }
        const engineOptions = [
            this.cppString(this.options.title),
            String(this.options.width),
            String(this.options.height),
        ];
        if (sampleOverride || pixelRatioCap !== undefined)
            engineOptions.push(sampleOverride ?? "0");
        if (pixelRatioCap !== undefined) engineOptions.push(pixelRatioCap);
        let engineOptionsCpp = `bbl::EngineOptions{${engineOptions.join(", ")}}`;
        if (requiredLimits) {
            const named = this.allocateTemporaryCppName("engine_options");
            this.emit({
                kind: "declaration",
                type: "bbl::EngineOptions",
                name: named,
                initializer: engineOptionsCpp,
            });
            this.emit({
                kind: "expression",
                code: `${named}.required_limits = std::move(${requiredLimits});`,
            });
            engineOptionsCpp = `std::move(${named})`;
        }
        this.emit({
            kind: "declaration",
            type: "auto",
            name: cppName,
            initializer: `${this.options.workers ? "bbl::pal::create_realm_engine" : "bbl::create_engine"}(${engineOptionsCpp}${canvasArgument})`,
        });
        const engine = this.realmEngine(cppName);
        this.registerNativeBindingType(cppName, engine.type);
        // The pin's createEngine resizes its surface once, and every frame
        // head and cap write runs the same resize: a DOM canvas's backing
        // store has this one writer.
        if (this.options.workers) {
            const resize = surfaceResizeFunction(this);
            this.emit({
                kind: "expression",
                code: `bbl::install_surface_resize(*${cppName}, &${resize}, &${resize}_auxiliary);`,
            });
        }
        this.engineCreationInsertion = this.body.length;
        if (this.options.workers)
            this.engineCreationExecution = {
                awaited: this.asyncActivations.awaitedSetupDepth,
                callback: this.frameCallbackDepth,
                control: this.runtimeControlFlowDepth,
                iteration: this.runtimeIterationDepth,
                native: this.returnFrames.filter(
                    (frame) => frame.kind === "native",
                ).length,
            };
        const engineCpp = engine.cpp;
        this.defaultEngineCpp = engineCpp;
        for (const lookup of this.pendingHostUiLookups) {
            writable(lookup).engineCpp = engineCpp;
            this.emit({
                kind: "declaration",
                type: "const auto",
                name: lookup.cpp,
                initializer: `bbl::ui_get_element_by_id(${engineCpp}, ${this.cppString(lookup.uiHostId!)})`,
            });
        }
        let surfaceCanvas = false;
        if (
            !this.options.workers &&
            [...this.ui.nativeHostUiTags().values()].includes("canvas")
        ) {
            const canvas = this.compileValue(argumentAt(call, 0));
            engineCanvas = canvas;
            if (canvas.kind === "ui-element") {
                if (canvas.uiTag !== "canvas")
                    this.fail(
                        argumentAt(call, 0),
                        "An engine surface requires a retained canvas element.",
                    );
                this.emit({
                    kind: "expression",
                    code: `${engineCpp}.surface_canvas = ${canvas.cpp};`,
                });
                this.emit({
                    kind: "expression",
                    code: `${recordAt(`${engineCpp}.ui_elements`, canvas.cpp)}.client_rect_requested = true;`,
                });
                surfaceCanvas = true;
                this.reachFeature("renderer:surface", call);
            }
        }
        const nativeBinding = this.registerNativeBinding(
            cppName,
            !this.options.workers,
        );
        if (this.options.workers)
            this.nativeBindings.set(engineCpp, nativeBinding);
        // The policy travels as reached features, which is what every other
        // emission decision reads: `useHighPrecisionMatrix` is what the
        // pin's process-global allocator swaps on, and this port composes
        // every world in double already -- so it reaches generation as the
        // precondition floating origin needs rather than as a storage
        // choice, and `useFloatingOrigin` is the one that changes what is
        // emitted.
        if (highPrecisionMatrix) {
            this.reachFeature("renderer:high-precision-matrix", call);
        }
        if (floatingOrigin) {
            this.reachFeature("renderer:floating-origin", call);
        }
        const engineIdentity = Symbol();
        if (engineCanvas) {
            writable(engineCanvas).canvasEngineIdentity = engineIdentity;
            // A read of a binding is a copy of its value (a narrowed
            // `canvas!` too): the binding keeps the proof its later reads
            // and the aliases they make carry.
            const argument = this.unwrap(argumentAt(call, 0));
            const stored = ts.isIdentifier(argument)
                ? this.bindings.lookupOptional(argument)
                : undefined;
            if (stored?.kind === engineCanvas.kind)
                writable(stored).canvasEngineIdentity = engineIdentity;
        }
        return {
            kind: "engine",
            cpp: engineCpp,
            engineCpp,
            // The default-engine spelling and every alias are one engine.
            engineIdentity,
            ...(this.options.workers ? { ownedEngineCpp: cppName } : {}),
            msaaSamples,
            ...(surfaceCanvas ? { surfaceCanvas: true as const } : {}),
            nativeCaptures: [nativeBinding],
        };
    }

    public allocateTemporaryCppName(label: string): string {
        // The label is a readability hint the index makes unique; a label
        // taken from source (a private name's sigil) must still spell an
        // identifier.
        const safe = sanitizeCppIdentifier(label);
        while (true) {
            const candidate = `v_bblite_${safe}_${this.temporaryIndex++}`;
            if (!this.sourceCppNames.has(candidate)) {
                this.sourceCppNames.add(candidate);
                this.allocatedCppNames.set(candidate, this.temporaryIndex);
                return candidate;
            }
        }
    }

    public allocateUserFunctionPrefix(): string {
        return `fn${this.temporaryIndex++}_`;
    }

    public allocateBlockPrefix(): string {
        return `${this.bindings.cppNamePrefix}block${this.temporaryIndex++}_`;
    }

    public compileStaticString(expression: ts.Expression): string {
        return this.compileStringLiteral(expression);
    }

    /**
     * What a source builder returns: its expression body, or the expression
     * of a block body's single `return`, read through `unwrap` so the pin's
     * `wgsl` tag over a template is that template. Undefined for any other
     * shape.
     */
    private builderReturn(
        declaration: ts.SignatureDeclaration | undefined,
    ): ts.Expression | undefined {
        const body =
            declaration && ts.isFunctionLike(declaration)
                ? (declaration as ts.FunctionLikeDeclaration).body
                : undefined;
        if (!body) return undefined;
        if (!ts.isBlock(body)) return this.unwrap(body);
        const only =
            body.statements.length === 1 ? body.statements[0] : undefined;
        return only && ts.isReturnStatement(only) && only.expression
            ? this.unwrap(only.expression)
            : undefined;
    }

    public reachShaderCreations(): void {
        if (this.shaderCreationsReached) return;
        for (const entry of this.options.shaderCreations ?? [])
            reachLedgerProgram(this, entry);
        this.shaderCreationsReached = true;
    }

    /**
     * A shader stage's generation-time text, each run-time number a builder
     * formats into it read from a material uniform.
     *
     * Native pipelines are generated before the program runs, so a stage
     * spelling a run-time number (LibreQuake's mover depth bias, an atlas
     * rectangle measured from a loaded mesh) is one pipeline whose material
     * block receives each number when the material is created. The text is
     * folded twice, each formatter of such a number spelling a different
     * representative (`runShaderSourceBuilder`); the two spellings locate the
     * holes (`liftWgslNumberHoles`), and each uniform holds the number its
     * formatted text denotes. A stage that is a function literal's call
     * reads the numbers it formats from known arguments from uniforms too.
     */
    public compileShaderSource(
        expression: ts.Expression,
        stage: ShaderStage,
    ): ShaderSourceText {
        const resolved = this.resolveStaticExpression(expression);
        const callee = ts.isCallExpression(resolved)
            ? this.unwrap(resolved.expression)
            : undefined;
        const declaration =
            callee && ts.isIdentifier(callee)
                ? resolveFunctionDeclaration(
                      this.checker,
                      callee,
                      (node, message) => this.fail(node, message),
                  )
                : undefined;
        if (ts.isCallExpression(resolved) && declaration) {
            // Function declarations use closed execution.
            if (ts.isFunctionDeclaration(declaration)) {
                const built = this.runGenerationBuilder(resolved);
                if (built !== undefined)
                    return { source: built, dynamicUniforms: [] };
            } else {
                // A function literal's calls share one pipeline: every
                // number it formats from its arguments is a uniform where
                // its whole text lifts, a known one too.
                const shared = this.probeEmission(() =>
                    unlessRefused(() =>
                        this.liftShaderSource(expression, stage, resolved),
                    ),
                );
                if (shared) return shared;
            }
        }
        let refusal: CompileError;
        try {
            return {
                source: this.probeEmission(() =>
                    this.compileStaticString(expression),
                ),
                dynamicUniforms: [],
            };
        } catch (error) {
            if (!(error instanceof CompileError)) throw error;
            refusal = error;
        }
        // Text no builder read a run-time argument of refuses as static text.
        const lifted = this.liftShaderSource(expression, stage);
        if (!lifted) throw refusal;
        return lifted;
    }

    /**
     * A stage's text folded twice (`compileShaderSource`), each number its
     * builders format from a run-time argument -- and every number `every`
     * formats from its arguments -- read from a uniform. Undefined when no
     * builder ran over such an argument.
     */
    private liftShaderSource(
        expression: ts.Expression,
        stage: ShaderStage,
        every?: ts.CallExpression,
    ): ShaderSourceText | undefined {
        const state: ShaderSourceRun = {
            run: 0,
            holes: [],
            admitted: false,
            ...(every ? { every } : {}),
        };
        const { holes } = state;
        const spelled: string[] = [];
        const enclosing = this.shaderSourceHoles;
        this.shaderSourceHoles = state;
        try {
            for (const run of [0, 1] as const) {
                state.run = run;
                // The runs spell differently only at holes: without one,
                // the second spells the first's text.
                const text =
                    run === 1 && holes.length === 0
                        ? spelled[0]
                        : this.probeEmission(
                              () =>
                                  every
                                      ? this.runGenerationBuilder(every)
                                      : this.compileStaticString(expression),
                              () => false,
                          );
                if (!state.admitted || text === undefined) return undefined;
                spelled.push(text);
            }
        } catch (error) {
            if (error instanceof CompileError && !state.admitted)
                return undefined;
            throw error;
        } finally {
            this.shaderSourceHoles = enclosing;
        }
        const name = (hole: number): string =>
            `bblDynamic${stage === "vertex" ? "Vertex" : "Fragment"}${hole}`;
        let lifted: ReturnType<typeof liftWgslNumberHoles>;
        try {
            lifted = liftWgslNumberHoles(
                [spelled[0]!, spelled[1]!],
                holes.map((hole, index) => [
                    shaderSourceSpelling(hole, index, 0),
                    shaderSourceSpelling(hole, index, 1),
                ]),
                (hole) => `shaderUniforms.${name(hole)}`,
            );
        } catch (error) {
            if (error instanceof CompileError || !(error instanceof Error))
                throw error;
            this.fail(
                expression,
                `A ${stage} shader source is not WGSL the compiler reads: ${error.message}`,
            );
        }
        if ("refusal" in lifted) {
            const hole =
                lifted.hole === undefined ? undefined : holes[lifted.hole];
            this.fail(
                hole?.formatter ?? expression,
                hole
                    ? `A ${stage} shader source spells the run-time number '${hole.formatter.getText()}' in ${lifted.refusal}; a material uniform takes its place only where WGSL reads an f32 value in a function body, or as a module-scope 'const NAME: f32 = <number>;'.`
                    : `A ${stage} shader source ${lifted.refusal}.`,
            );
        }
        // Each argument is read once, however many of its numbers the text spells.
        const values = new Map<ts.Expression, Value>();
        return {
            source: lifted.source,
            dynamicUniforms: lifted.holes.map((index) => {
                const hole = holes[index]!;
                const argument = this.shaderSourceArgument(hole);
                let value = values.get(argument);
                if (!value) {
                    value = this.compileValue(argument);
                    values.set(argument, value);
                }
                const lane = this.runtimeNumberShape(
                    argument,
                    value,
                    every === hole.call,
                )?.lanes.find(({ lane }) => sameKeys(lane, hole.lane));
                if (!lane) {
                    this.fail(
                        hole.formatter,
                        `The number '${hole.formatter.getText()}' a shader source spells reads a lane its argument, compiled for the material's uniform, does not hold as a number.`,
                    );
                }
                const known = lane.value.staticNumber;
                if (known === undefined && hole.digits !== undefined)
                    this.reachJsData();
                return {
                    name: name(index),
                    type: "f32" as const,
                    components: [
                        known !== undefined
                            ? this.castNumber(
                                  numberConstantValue(
                                      Number(
                                          foldNumberFormat(
                                              hole.format,
                                              known,
                                              hole.digits,
                                          ),
                                      ),
                                  ),
                                  "float",
                              )
                            : `static_cast<float>(${
                                  // Without digits, toExponential spells the
                                  // shortest text that reads back as the
                                  // number.
                                  hole.digits === undefined
                                      ? this.castNumber(lane.value, "double")
                                      : `bbl::js::number_from_string(bbl::js::number_${hole.format === "toFixed" ? "to_fixed" : "to_exponential"}(${this.castNumber(lane.value, "double")}, ${hole.digits}.0))`
                              })`,
                    ],
                };
            }),
        };
    }

    /** The expression a hole's builder call passes the hole's argument as. */
    private shaderSourceArgument(hole: ShaderSourceHole): ts.Expression {
        const argument = hole.call.arguments[hole.parameter]!;
        return this.alwaysUsedParameterDefault(argument) ?? argument;
    }

    /**
     * An argument generation knows the shape of but not every number of
     * (`compileShaderSource`): its data, each number generation does not
     * know -- with `every`, each number -- as 0, and the key path and value
     * of each such lane. Undefined for an argument whose evaluation writes
     * or has effects, one of another shape, or one with no such lane.
     */
    private runtimeNumberShape(
        expression: ts.Expression,
        value?: Value,
        every = false,
    ):
        | {
              data: ExecutedArgument;
              lanes: Array<{ lane: readonly string[]; value: Value }>;
          }
        | undefined {
        const node = this.unwrap(expression);
        if (
            this.evaluationOrder.writesStorage(node) ||
            this.evaluationOrder.hasModuleEffects(node)
        )
            return undefined;
        const lanes: Array<{ lane: readonly string[]; value: Value }> = [];
        // A parsed document typed as a number is one lane too, and so is one
        // typed as an optional number generation proved present.
        const type = this.checker.getTypeAtLocation(node);
        const numberTyped = valueKindOf(type) === "number";
        const presentNumberTyped =
            valueKindOf(this.checker.getNonNullableType(type)) === "number";
        const visit = (
            current: Value,
            lane: readonly string[],
        ): ExecutedArgument | undefined => {
            if (
                current.kind === "number" ||
                (current.kind === "data" &&
                    current.dataType?.kind === "number") ||
                (lane.length === 0 &&
                    isJsonValue(current) &&
                    (numberTyped ||
                        (presentNumberTyped && valueProvenPresent(current))))
            ) {
                const known = current.staticNumber;
                if (
                    !every &&
                    known !== undefined &&
                    losslessGenerationNumber(known)
                )
                    return known;
                lanes.push({ lane, value: current });
                return 0;
            }
            if (!this.bindings.recordPropertiesAreCurrent(current))
                return undefined;
            const elements =
                current.staticElementIndex !== undefined
                    ? undefined
                    : current.staticElementsOwner
                      ? current.staticElementsOwner.staticElements
                      : (current.staticElements ?? current.tupleElements);
            if (elements) {
                const data: ExecutedArgument[] = [];
                for (const [index, element] of elements.entries()) {
                    const entry = visit(element, [...lane, String(index)]);
                    if (entry === undefined) return undefined;
                    data.push(entry);
                }
                return data;
            }
            if (current.kind === "data" && current.dataType?.kind === "tuple") {
                return Array.from(
                    { length: current.dataType.arity },
                    (_, index) => {
                        lanes.push({
                            lane: [...lane, String(index)],
                            value: this.dataLowerer.fixedTupleElement(
                                current,
                                index,
                                node,
                            )!,
                        });
                        return 0;
                    },
                );
            }
            if (
                current.kind !== "record" ||
                !current.recordProperties ||
                Object.keys(current.recordMethods ?? {}).length > 0 ||
                Object.keys(current.recordGetters ?? {}).length > 0 ||
                Object.keys(current.recordSetters ?? {}).length > 0
            )
                return undefined;
            const record: { [name: string]: ExecutedArgument } = {};
            for (const key of current.recordOwnKeys ??
                Object.keys(current.recordProperties)) {
                const property = current.recordProperties[key];
                const entry = property && visit(property, [...lane, key]);
                if (entry === undefined || key === "__proto__")
                    return undefined;
                record[key] = entry;
            }
            return record;
        };
        const data = visit(
            value ??
                this.probeEmission(
                    () => this.compileValue(node),
                    () => false,
                ),
            [],
        );
        return data === undefined || lanes.length === 0
            ? undefined
            : { data, lanes };
    }

    /**
     * A shader stage's builder run over arguments with numbers generation
     * does not know (`compileShaderSource`): each formatter call spelling
     * one, in its body or a local function it hands the number to
     * (`shaderSourceReads`), runs as this run's spelling of that hole, and
     * any other read of such a number refuses.
     */
    private runShaderSourceBuilder(
        call: ts.CallExpression,
        declaration: SupportedFunction,
        args: readonly (ExecutedArgument | undefined)[],
        unread: UnreadLanes,
        state: ShaderSourceRun,
        label: string,
        keys?: readonly string[],
    ): unknown {
        state.admitted = true;
        const spellings = new Map<ts.Node, string>();
        const reads = this.shaderSourceReads(declaration, unread);
        for (const found of reads.formatters) {
            let index = state.holes.findIndex(
                (hole) =>
                    hole.call === call && hole.formatter === found.formatter,
            );
            if (index < 0) index = state.holes.push({ call, ...found }) - 1;
            spellings.set(
                found.formatter,
                shaderSourceSpelling(state.holes[index]!, index, state.run),
            );
        }
        const message = (index: number): string => {
            const parameter = declaration.parameters[index]!.name;
            return `it reads the run-time number '${parameter.getText()}' other than through a number formatter with literal digits, whose text a shader source's uniform replaces`;
        };
        // A number passed whole has no accessor to refuse a read through:
        // only the formatters it stands in for, the calls it is handed on
        // to and its presence tests may read its parameter.
        if (reads.stray)
            this.fail(
                reads.stray.node,
                `${label} cannot run at generation: ${message(reads.stray.parameter)}.`,
            );
        return executeApplicationFunction(
            this.generationRunContext(
                (identifier) => this.staticScalar(identifier),
                {
                    standInText: (node) => spellings.get(node),
                    unreadNumbers: new Map(
                        [...unread].map(([index, lanes]) => [
                            index,
                            {
                                lanes: lanes.filter((lane) => lane.length > 0),
                                message: message(index),
                            },
                        ]),
                    ),
                },
            ),
            declaration,
            args,
            label,
            keys,
        );
    }

    /**
     * Where a builder's run reads the run-time numbers of its arguments
     * (`runShaderSourceBuilder`), through its own body and the local
     * functions it hands one of its arguments whole (whose parameter then
     * stands for that argument): each number formatter spelling such a number
     * (`shaderSourceFormatter`), and the first other read of a number passed
     * whole. A presence test of one against `null` or `undefined` is no such
     * read: a lane is a number, present at every run.
     */
    private shaderSourceReads(
        declaration: SupportedFunction,
        unread: UnreadLanes,
    ): {
        readonly formatters: Array<Omit<ShaderSourceHole, "call">>;
        readonly stray?: { readonly node: ts.Node; readonly parameter: number };
    } {
        const formatters: Array<Omit<ShaderSourceHole, "call">> = [];
        let stray: { node: ts.Node; parameter: number } | undefined;
        const followed = new Map<ts.Node, Set<string>>();
        const whole = (parameter: number): boolean =>
            unread.get(parameter)?.some((lane) => lane.length === 0) ?? false;
        const walk = (
            unit: SupportedFunction,
            bound: ReadonlyMap<ts.Symbol, number>,
        ): void => {
            const key = [...bound.values()].join(",");
            const seen = followed.get(unit) ?? new Set<string>();
            if (!unit.body || seen.has(key)) return;
            followed.set(unit, seen.add(key));
            const boundOf = (node: ts.Node): number | undefined => {
                const symbol = ts.isIdentifier(node)
                    ? this.symbols.valueSymbol(node)
                    : undefined;
                return symbol === undefined ? undefined : bound.get(symbol);
            };
            // Reads that pass a number on whole or test its presence.
            const allowed = new Set<ts.Node>();
            forEachAnalysisNode(
                unit.body,
                (node) => {
                    if (ts.isCallExpression(node)) {
                        const found = this.shaderSourceFormatter(
                            node,
                            boundOf,
                            unread,
                        );
                        if (found) {
                            formatters.push(found);
                            return "skip";
                        }
                        const callee = unwrapExpression(node.expression);
                        const target = ts.isIdentifier(callee)
                            ? resolveFunctionDeclaration(
                                  this.checker,
                                  callee,
                                  (at, message) => this.fail(at, message),
                              )
                            : undefined;
                        const passed = new Map<ts.Symbol, number>();
                        if (target?.body)
                            node.arguments.forEach((argument, index) => {
                                const read = unwrapExpression(argument);
                                const parameter = boundOf(read);
                                const name = target.parameters[index]?.name;
                                const symbol =
                                    name && ts.isIdentifier(name)
                                        ? this.symbols.valueSymbol(name)
                                        : undefined;
                                if (parameter === undefined || !symbol) return;
                                passed.set(symbol, parameter);
                                allowed.add(read);
                            });
                        if (target && passed.size > 0) walk(target, passed);
                    }
                    const comparison = ts.isBinaryExpression(node)
                        ? nullishComparison(this.checker, node)
                        : undefined;
                    const tested =
                        comparison && unwrapExpression(comparison.tested);
                    if (tested && boundOf(tested) !== undefined)
                        allowed.add(tested);
                    const parameter = boundOf(node);
                    if (
                        !stray &&
                        parameter !== undefined &&
                        whole(parameter) &&
                        !allowed.has(node)
                    )
                        stray = { node, parameter };
                },
                { types: "skip" },
            );
        };
        walk(
            declaration,
            new Map(
                declaration.parameters.flatMap((parameter, index) => {
                    const symbol =
                        unread.has(index) && ts.isIdentifier(parameter.name)
                            ? this.symbols.valueSymbol(parameter.name)
                            : undefined;
                    return symbol ? [[symbol, index] as const] : [];
                }),
            ),
        );
        return { formatters, ...(stray ? { stray } : {}) };
    }

    /**
     * A library number formatter call spelling a number generation does not
     * know of an argument a parameter `boundOf` stands for:
     * `<parameter>[.<key>]*.toFixed(<digits>)` or `.toExponential(<digits>?)`,
     * with literal digits, so the text is a float literal for every number.
     */
    private shaderSourceFormatter(
        node: ts.CallExpression,
        boundOf: (node: ts.Node) => number | undefined,
        unread: UnreadLanes,
    ): Omit<ShaderSourceHole, "call"> | undefined {
        if (
            node.questionDotToken ||
            !isLibraryNumberFormatter(this.checker, node)
        )
            return undefined;
        const member = namedMember(
            this.checker,
            unwrapExpression(node.expression),
        )!;
        const lane: string[] = [];
        let receiver = unwrapExpression(member.expression);
        for (
            let access = namedMember(this.checker, receiver);
            access && !ts.isOptionalChain(access.access);
            access = namedMember(this.checker, receiver)
        ) {
            lane.unshift(access.name);
            receiver = unwrapExpression(access.expression);
        }
        const parameter = boundOf(receiver);
        if (
            parameter === undefined ||
            !unread.get(parameter)?.some((known) => sameKeys(known, lane))
        )
            return undefined;
        const format = numberFormatOf(member.name)!;
        const written = node.arguments[0]
            ? unwrapExpression(node.arguments[0])
            : undefined;
        const digits =
            written && ts.isNumericLiteral(written)
                ? Number(written.text)
                : undefined;
        if (
            (written && digits === undefined) ||
            (digits !== undefined &&
                foldNumberFormat(format, 0, digits) === undefined)
        ) {
            this.fail(
                node,
                `A shader source's run-time number formatted by '${node.getText()}' requires literal ${format} digits.`,
            );
        }
        if (
            format === "toPrecision" ||
            (format === "toFixed" && !(digits !== undefined && digits >= 1))
        ) {
            this.fail(
                node,
                `A shader source's run-time number formatted by '${node.getText()}' spells an integer literal for some numbers, whose WGSL type its position decides; toFixed with one or more digits and toExponential spell a float.`,
            );
        }
        return { formatter: node, parameter, lane, format, digits };
    }

    /**
     * The text a required-text position reads from an expression: the
     * string or number its value carries at generation, or the text a
     * builder call returns when run there (`runGenerationBuilder`).
     */
    private generationText(expression: ts.Expression): string | undefined {
        // A committed probe keeps its statements, and a required-text
        // position may ask about the same expression more than once before
        // lowering it: an impure expression folds only when its lowering
        // emits nothing (a declined probe rolls its statements back).
        const pure = this.evaluationOrder.isPureExpression(expression);
        const carried = this.unlessShaderSourceRefuses(() =>
            this.probeEmission(() => {
                let value: Value | undefined;
                const effects = this.captureEmittedStatements(() => {
                    value = this.compileValue(expression);
                });
                if (!value || (!pure && effects.length > 0)) return undefined;
                return staticKeyOf(value);
            }),
        );
        if (carried !== undefined) return carried;
        if (ts.isIdentifier(expression))
            return (
                this.executedConstantText(expression) ??
                this.localText(expression)
            );
        if (
            ts.isPropertyAccessExpression(expression) ||
            ts.isElementAccessExpression(expression)
        )
            return this.executedConstantText(expression);
        return ts.isCallExpression(expression)
            ? this.runGenerationBuilder(expression)
            : undefined;
    }

    /**
     * The text a local `const` or `let` holds at `read`, generation folding
     * its writes in order: its initializer's text, then each `=` or `+=` of
     * text its function makes before the read outside loops, skipping one
     * whose enclosing `if` is not taken, each selection and `if` decided
     * where its condition is settled (`settledCondition`), each text folded
     * where what it reads holds at the read (`unchangedUntil`). Undefined for
     * another write, a write in a loop or another function, an enclosing
     * statement other than a block or a settled `if`, or text generation
     * cannot fold.
     */
    private localText(read: ts.Identifier): string | undefined {
        const symbol = this.symbols.valueSymbol(read);
        const declaration = symbol?.valueDeclaration;
        if (
            !symbol ||
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !declaration.initializer
        )
            return undefined;
        const kind = variableKind(declaration);
        if (kind !== "let" && kind !== "const") return undefined;
        const unit = ts.findAncestor(declaration, ts.isFunctionLike);
        const scope = declaration.parent.parent.parent;
        if (!unit || ts.findAncestor(read, ts.isFunctionLike) !== unit)
            return undefined;
        // A selection the initializer or a write makes takes its settled arm.
        const text = (expression: ts.Expression): string | undefined => {
            const node = unwrapExpression(expression);
            if (ts.isConditionalExpression(node)) {
                const known = this.settledCondition(node.condition);
                return known === undefined
                    ? undefined
                    : text(known ? node.whenTrue : node.whenFalse);
            }
            return this.unchangedUntil(expression, read)
                ? unlessRefused(() =>
                      this.evaluator.compileStringLiteral(expression),
                  )
                : undefined;
        };
        const writes = bindingRebinds(
            this.checker,
            [read.getSourceFile()],
            symbol,
        );
        // A write in a loop may come before the read in a later round, and
        // one in another function whenever that function runs: the text is
        // the run's.
        if (
            writes.some(
                (write) =>
                    ts.findAncestor(
                        write.node,
                        (node) =>
                            ts.isFunctionLike(node) ||
                            ts.isIterationStatement(node, false),
                    ) !== unit,
            )
        )
            return undefined;
        let held = text(declaration.initializer);
        for (const write of [...writes]
            .filter((site) => site.node.getEnd() <= read.getStart())
            .sort((left, right) => left.node.pos - right.node.pos)) {
            if (held === undefined) return undefined;
            const taken = this.writeTaken(write.node, scope);
            if (taken === undefined) return undefined;
            if (!taken) continue;
            const assignment = write.node;
            if (
                !ts.isBinaryExpression(assignment) ||
                (write.kind === "assign"
                    ? assignment.operatorToken.kind !==
                      ts.SyntaxKind.EqualsToken
                    : write.kind !== "compound" ||
                      assignment.operatorToken.kind !==
                          ts.SyntaxKind.PlusEqualsToken)
            )
                return undefined;
            const right = text(assignment.right);
            held =
                right === undefined
                    ? undefined
                    : write.kind === "assign"
                      ? right
                      : held + right;
        }
        return held;
    }

    /**
     * Whether what `expression` reads holds the same at `read`, later in its
     * function: no name it reads is written between the two or in another
     * function, and no member it reads is one a write in the program
     * replaces (`recordFieldIsWritten`).
     */
    private unchangedUntil(expression: ts.Node, read: ts.Node): boolean {
        const unit = ts.findAncestor(read, ts.isFunctionLike);
        return !this.readsReplaced(
            expression,
            (writes) =>
                writes.some(
                    (write) =>
                        ts.findAncestor(write.node, ts.isFunctionLike) !==
                            unit ||
                        (write.node.getStart() >= expression.getEnd() &&
                            write.node.getEnd() <= read.getStart()),
                ),
            { functions: "skip" },
        );
    }

    /**
     * Whether `expression` reads a member a write in the program replaces
     * (`recordFieldIsWritten`) or a name whose writes (`bindingRebinds`)
     * `replaced` counts.
     */
    private readsReplaced(
        expression: ts.Node,
        replaced: (writes: readonly WriteSite[]) => boolean,
        policy?: { readonly functions?: "skip" },
    ): boolean {
        return someAnalysisNode(
            expression,
            (node) => {
                if (ts.isPropertyAccessExpression(node))
                    return recordFieldIsWritten(
                        this,
                        this.checker.getTypeAtLocation(node.expression),
                        node.name.text,
                    );
                if (!ts.isIdentifier(node) || !isValueReference(node))
                    return false;
                const symbol = this.symbols.valueSymbol(node);
                return (
                    symbol !== undefined &&
                    replaced(
                        bindingRebinds(
                            this.checker,
                            [node.getSourceFile()],
                            symbol,
                        ),
                    )
                );
            },
            policy,
        );
    }

    /**
     * Whether a write statement inside `scope` runs, where generation knows
     * every `if` it is nested in; undefined for another enclosing statement
     * or a condition generation does not know.
     */
    private writeTaken(write: ts.Node, scope: ts.Node): boolean | undefined {
        let taken = true;
        if (!ts.isExpressionStatement(write.parent)) return undefined;
        let child: ts.Node = write.parent;
        for (let node = child.parent; node !== scope; node = node.parent) {
            if (!node || ts.isFunctionLike(node)) return undefined;
            if (ts.isBlock(node)) {
                child = node;
                continue;
            }
            if (!ts.isIfStatement(node) || child === node.expression)
                return undefined;
            const known = this.settledCondition(node.expression);
            if (known === undefined) return undefined;
            if (known !== (child === node.thenStatement)) taken = false;
            child = node;
        }
        return taken;
    }

    /**
     * What a condition is where text is folded later than the program
     * evaluates it (`localText`): what generation knows of it now, when it reads
     * nothing that could have changed since -- names never rebound, members
     * no write in the program replaces (`recordFieldIsWritten`) -- and calls
     * or writes nothing. Undefined otherwise: the condition is then a
     * run-time test.
     */
    private settledCondition(condition: ts.Expression): boolean | undefined {
        if (
            someAnalysisNode(
                condition,
                (node) =>
                    ts.isCallExpression(node) ||
                    ts.isNewExpression(node) ||
                    ts.isTaggedTemplateExpression(node) ||
                    ts.isElementAccessExpression(node) ||
                    writeSites(node).length > 0,
            ) ||
            this.readsReplaced(condition, (writes) => writes.length > 0)
        )
            return undefined;
        const compiled = unlessRefused(() =>
            this.probeEmission(
                () => this.conditions.compileCondition(condition),
                () => false,
            ),
        );
        return compiled === undefined ? undefined : knownCondition(compiled);
    }

    /**
     * What `attempt` returns; while a shader stage's text folds
     * (`compileShaderSource`), nothing where a lowering refuses, its
     * emission dropped, so the fold reaches the builder runs that read
     * run-time numbers. A fold that runs no builder over one refuses as the
     * static text did.
     */
    private unlessShaderSourceRefuses<T>(attempt: () => T): T | undefined {
        return this.shaderSourceHoles
            ? unlessRefused(() => this.probeEmission(attempt, () => true))
            : attempt();
    }

    /**
     * The text a read-only parameter of an inlined call holds: its argument
     * (`UserFunctionLowerer.inlinedArgument`) folded as a string literal
     * position folds it. The binding drops the argument's expression, so a
     * text the call site can read but its value does not carry (a module
     * constant run at generation) is read here.
     */
    private inlinedArgumentText(identifier: ts.Identifier): string | undefined {
        const argument = this.userFunctions.inlinedArgument(
            identifier,
            (name) => this.bindings.scopeOf(name),
        );
        if (!argument) return undefined;
        try {
            return this.evaluator.compileStringLiteral(argument);
        } catch (error) {
            if (error instanceof CompileError) return undefined;
            throw error;
        }
    }

    /**
     * Whether a read-only parameter of an inlined call is, through each
     * inlined call that passes it on, a call's result: a generation run
     * computes that text, and refuses a binding the program writes through.
     */
    public inlinedCallArgument(identifier: ts.Identifier): boolean {
        const argument = this.userFunctions.inlinedArgument(
            identifier,
            (name) => this.bindings.scopeOf(name),
        );
        if (!argument) return false;
        const source = this.unwrap(argument);
        return ts.isCallExpression(source)
            ? true
            : ts.isIdentifier(source) && this.inlinedCallArgument(source);
    }

    /**
     * Required text from plain data generation knows, or from its fields:
     * an unwritten module constant, evaluated by the same generation
     * executor as its initializer, or the record a helper call returns,
     * read in place or through the local `const` holding it
     * (`settledCallInitializer`).
     */
    private executedConstantText(
        expression: ts.Expression,
    ): string | undefined {
        const path = this.executedPath(expression);
        if (!path) return undefined;
        const { call, held, keys } = path;
        const returned =
            call &&
            (held ||
                !(
                    this.evaluationOrder.writesStorage(call) ||
                    this.evaluationOrder.hasModuleEffects(call)
                ))
                ? this.returnedLiteralText(call, keys)
                : undefined;
        if (returned !== undefined) return returned;
        const value = this.executedPathValue(path);
        return typeof value === "string" || typeof value === "number"
            ? String(value)
            : undefined;
    }

    /**
     * The plain data generation runs for a read (`executedConstantText`):
     * the module constant or helper call at its root, and the keys it reads
     * through.
     */
    private executedPath(expression: ts.Expression):
        | {
              constant?: ts.VariableDeclaration;
              call?: ts.CallExpression;
              held: boolean;
              keys: readonly string[];
          }
        | undefined {
        const keys: string[] = [];
        let root = this.unwrap(expression);
        for (;;) {
            while (
                ts.isPropertyAccessExpression(root) ||
                ts.isElementAccessExpression(root)
            ) {
                const key = ts.isPropertyAccessExpression(root)
                    ? root.name.text
                    : this.evaluator.staticTextValue(root.argumentExpression);
                if (key === undefined) return undefined;
                keys.unshift(key);
                root = this.unwrap(root.expression);
            }
            // A member of the literal a read-only parameter is handed is
            // the expression that literal holds there.
            if (ts.isObjectLiteralExpression(root) && keys.length > 0) {
                const literal = root;
                // A key a spread may supply leaves the read to the run time.
                const member = unlessRefused(() =>
                    this.objectProperty(literal, keys[0]!),
                );
                if (!member) return undefined;
                keys.shift();
                root = this.unwrap(member);
                continue;
            }
            if (!ts.isIdentifier(root) || this.moduleConstantDeclaration(root))
                break;
            // A local `const` naming a module constant, or a member of what
            // another binding holds, reads that one; an inlined call's
            // read-only parameter reads its argument.
            const aliased = constInitializer(this, root);
            const next =
                aliased &&
                (ts.isIdentifier(aliased) ||
                    ts.isPropertyAccessExpression(aliased))
                    ? aliased
                    : this.userFunctions.inlinedArgument(root, (name) =>
                          this.bindings.scopeOf(name),
                      );
            if (!next) break;
            root = this.unwrap(next);
        }
        const constant = ts.isIdentifier(root)
            ? this.moduleConstantDeclaration(root)
            : undefined;
        // A held result re-reads the call its declaration still evaluates;
        // a call read in place is folded away, so it may write nothing.
        const held =
            !constant && ts.isIdentifier(root)
                ? this.settledCallInitializer(root, keys)
                : undefined;
        const call =
            held ??
            (ts.isCallExpression(root) && !root.questionDotToken
                ? root
                : undefined);
        if (!constant && !call) return undefined;
        return {
            ...(constant ? { constant: constant.declaration } : {}),
            ...(call ? { call } : {}),
            held: held !== undefined,
            keys,
        };
    }

    /** What the run of an `executedPath` holds at its keys, if it runs. */
    private executedPathValue(
        path: NonNullable<ReturnType<Compiler["executedPath"]>>,
    ): unknown {
        // A call's run is read at the keys inside it: what else its result
        // holds (a function beside the text read) is never read.
        if (!path.constant) return this.executedCall(path.call!, path.keys);
        let value: unknown = this.runModuleConstant(path.constant);
        for (const key of path.keys) {
            if (value === null || typeof value !== "object") return undefined;
            value = Object.getOwnPropertyDescriptor(value, key)?.value;
        }
        return value;
    }

    /**
     * The text at `keys` of the record literal a helper call returns
     * directly (`StaticEvaluator.resolveStaticLiteral`): each key a property
     * of a literal, the last one's value folding as required text.
     */
    private returnedLiteralText(
        call: ts.CallExpression,
        keys: readonly string[],
    ): string | undefined {
        return unlessRefused(() =>
            this.probeEmission(
                () => {
                    let literal = this.evaluator.resolveStaticLiteral(call);
                    if (literal === this.unwrap(call)) return undefined;
                    for (const key of keys) {
                        const member = ts.isObjectLiteralExpression(literal)
                            ? this.objectProperty(literal, key)
                            : undefined;
                        if (!member) return undefined;
                        literal = this.evaluator.resolveStaticLiteral(member);
                    }
                    return this.evaluator.compileStringLiteral(literal);
                },
                () => false,
            ),
        );
    }

    /**
     * The elements of a module-scope `const` array a static iteration needs
     * and the static literal reader cannot resolve, run at generation
     * (`runModuleConstant`).
     */
    public executedModuleConstantElements(
        expression: ts.Expression,
    ): readonly Value[] | undefined {
        if (this.evaluator.staticArrayLiteral(expression)) return undefined;
        const identifier = this.unwrap(expression);
        const constant = ts.isIdentifier(identifier)
            ? this.moduleConstantDeclaration(identifier)
            : undefined;
        if (!constant) return undefined;
        const elements = this.runModuleConstant(constant.declaration);
        return Array.isArray(elements)
            ? elements.map((element: unknown) =>
                  jsonToValue(
                      this,
                      executedConstantJsonPolicy,
                      element,
                      identifier,
                  ),
              )
            : undefined;
    }

    /**
     * `<module constant Map>.get(<key>)` read from the generation run of
     * the constant: undefined when the constant is not an executed Map or
     * something writes through it, absent when the Map lacks the key.
     */
    public executedModuleConstantMapEntry(
        expression: ts.Expression,
        key: string | number,
    ): Value | undefined {
        const identifier = this.unwrap(expression);
        if (!ts.isIdentifier(identifier)) return undefined;
        const constant = this.moduleConstantDeclaration(identifier);
        if (!constant || this.moduleConstantIsWritten(identifier))
            return undefined;
        // A Map is no plain data, but its entry list is: run the argument
        // `new Map(entries)` was built from and look the key up there.
        const initializer = this.unwrap(constant.declaration.initializer!);
        const source =
            ts.isNewExpression(initializer) &&
            this.libraryGlobal(initializer.expression) === "Map" &&
            initializer.arguments?.length === 1
                ? this.unwrap(initializer.arguments[0]!)
                : undefined;
        if (!source || !ts.isCallExpression(source)) return undefined;
        const entries = unlessRefused(() =>
            this.runGenerationFunction(
                source,
                [],
                `Entries of module Map '${identifier.text}'`,
            ),
        );
        if (!Array.isArray(entries)) return undefined;
        // A later entry for a key replaces an earlier one, as Map does.
        const entry = [...(entries as unknown[])]
            .reverse()
            .find(
                (pair): pair is [unknown, unknown] =>
                    Array.isArray(pair) && pair[0] === key,
            );
        if (!entry) return undefinedValue();
        // A generation copy of an object entry would be a different identity
        // from the native Map's own value; only scalars stand in.
        const value = jsonToValue(
            this,
            executedConstantJsonPolicy,
            entry[1],
            identifier,
        );
        return value.kind === "json-null" || hasScalarFacts(value)
            ? value
            : undefined;
    }

    /** The module-scope `const` declaration binding one name an identifier reads. */
    private moduleConstantDeclaration(
        identifier: ts.Identifier,
    ):
        | { declaration: ts.VariableDeclaration; name: ts.Identifier }
        | undefined {
        const declaration = this.symbols
            .valueSymbol(identifier)
            ?.declarations?.find(ts.isVariableDeclaration);
        return isModuleConstDeclaration(declaration)
            ? { declaration, name: declaration.name }
            : undefined;
    }

    /**
     * A module constant run at generation, as its module runs it, once: the
     * run reaches only module constants and functions, none of which the
     * program writes through unless an earlier fresh record is unchanged
     * before this primitive initialization snapshot. Undefined when it
     * reaches what generation does not carry (the host, the engine, a class,
     * a `let`, the clock, a written constant) or returns what is not plain
     * data, which leaves the value to the static evaluator.
     */
    private runModuleConstant(declaration: ts.VariableDeclaration): unknown {
        if (this.unrunnableModuleConstants.has(declaration)) return undefined;
        try {
            return this.runGenerationFunction(
                declaration,
                [],
                `Module constant '${declaration.name.getText()}'`,
            );
        } catch (error) {
            if (!(error instanceof CompileError)) throw error;
            this.unrunnableModuleConstants.add(declaration);
            return undefined;
        }
    }

    /** A primitive module result snapshots an earlier fresh record before later escapes. */
    private moduleRecordUnchangedBeforeSnapshot(
        name: ts.Identifier,
        snapshot: ts.VariableDeclaration,
    ): boolean {
        const source = this.moduleConstantDeclaration(name)?.declaration;
        if (
            !source ||
            source.getSourceFile() !== snapshot.getSourceFile() ||
            source.end >= snapshot.pos ||
            typeCanCarryReference(this.checker.getTypeAtLocation(snapshot.name))
        )
            return false;
        const initializer = this.unwrap(source.initializer!);
        if (
            !ts.isObjectLiteralExpression(initializer) ||
            !(
                plainDataMembers(initializer)?.every(
                    (member) =>
                        member.kind === "property" &&
                        !typeCanCarryReference(
                            this.checker.getTypeAtLocation(member.value),
                        ),
                ) ?? false
            ) ||
            !this.evaluationOrder.isPureExpression(initializer) ||
            this.evaluationOrder.hasModuleEffects(initializer)
        )
            return false;
        const before = source.parent.parent;
        const after = snapshot.parent.parent;
        if (
            !ts.isVariableStatement(before) ||
            !ts.isVariableStatement(after) ||
            !ts.isSourceFile(before.parent) ||
            after.parent !== before.parent ||
            before.declarationList.declarations.length !== 1 ||
            after.declarationList.declarations.length !== 1
        )
            return false;
        const statements = before.parent.statements;
        const start = statements.indexOf(before);
        const end = statements.indexOf(after);
        if (start < 0 || end <= start) return false;
        for (let index = start + 1; index < end; index++) {
            const statement = statements[index]!;
            if (
                ts.isFunctionDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement) ||
                ts.isImportDeclaration(statement) ||
                ts.isExportDeclaration(statement) ||
                ts.isEmptyStatement(statement)
            )
                continue;
            if (
                !ts.isVariableStatement(statement) ||
                statement.declarationList.declarations.some(
                    (binding) =>
                        binding.initializer !== undefined &&
                        (!this.evaluationOrder.isPureExpression(
                            binding.initializer,
                        ) ||
                            this.evaluationOrder.hasModuleEffects(
                                binding.initializer,
                            )),
                )
            )
                return false;
        }
        return true;
    }

    /**
     * The text a call to a source function or const function literal returns when
     * generation runs it: every supplied argument folds to a generation-known
     * scalar or fresh literal data (an always-omitted wrapper parameter folds to its default).
     * Omitted arguments take defaults in the closed function's own scope.
     * Undefined for any other call; a function that runs and returns anything
     * but text refuses. While a shader stage's text folds, an argument may
     * hold numbers generation does not know (`runShaderSourceBuilder`).
     */
    private runGenerationBuilder(call: ts.CallExpression): string | undefined {
        const executed = this.runGenerationCall(call, this.shaderSourceHoles);
        if (!executed) return undefined;
        const { value, label } = executed;
        if (typeof value === "string") return value;
        if (typeof value === "number") return String(value);
        return this.fail(call, `${label} returned ${typeof value}, not text.`);
    }

    /** Closed helpers share argument admission and execution for text and data. */
    private runGenerationCall(
        call: ts.CallExpression,
        holes?: ShaderSourceRun,
        keys?: readonly string[],
    ): { value: unknown; label: string } | undefined {
        const callee = this.unwrap(call.expression);
        const member = libraryStaticMember(this.checker, callee);
        if (member && !member.access.questionDotToken) {
            const label = `Static call '${callee.getText()}'`;
            return {
                value: this.runGenerationFunction(
                    call,
                    [],
                    label,
                    undefined,
                    keys,
                ),
                label,
            };
        }
        if (!ts.isIdentifier(callee)) return undefined;
        const declaration = resolveFunctionDeclaration(
            this.checker,
            callee,
            (node, message) => this.fail(node, message),
        );
        if (
            !declaration ||
            !declaration.body ||
            declaration.getSourceFile().isDeclarationFile ||
            call.arguments.length > declaration.parameters.length ||
            declaration.parameters.some(
                (parameter) =>
                    !ts.isIdentifier(parameter.name) ||
                    parameter.dotDotDotToken,
            )
        ) {
            return undefined;
        }
        if (!ts.isFunctionDeclaration(declaration)) {
            const binding = declaration.parent;
            if (
                !ts.isVariableDeclaration(binding) ||
                binding.initializer !== declaration ||
                !ts.isVariableDeclarationList(binding.parent) ||
                variableKind(binding.parent) !== "const"
            )
                return undefined;
        }
        const args: Array<ExecutedArgument | undefined> = [];
        const unread = new Map<number, readonly (readonly string[])[]>();
        // Omitted arguments stay omitted: the closed function evaluates its
        // own defaults in parameter order and observes the authored arity.
        for (const [index, argument] of call.arguments.entries()) {
            const passed = ts.isSpreadElement(argument)
                ? undefined
                : (this.alwaysUsedParameterDefault(argument) ?? argument);
            const value = passed && this.generationArgument(passed);
            const parameter = declaration.parameters[index]?.name;
            const every = holes?.every === call;
            if (value === undefined || every) {
                // A shader stage's builder may read, through formatters, the
                // numbers of an argument it does not rebind that generation
                // does not know (with `every`, all of them), where the call
                // is the stage's own or in a function body: no module
                // constant holds its text.
                const shape =
                    holes &&
                    passed &&
                    parameter &&
                    ts.isIdentifier(parameter) &&
                    (every ||
                        ts.findAncestor(call.parent, ts.isFunctionLike)) &&
                    parameterIsReadOnly(this.checker, declaration, parameter)
                        ? this.runtimeNumberShape(passed, undefined, every)
                        : undefined;
                if (shape) {
                    args.push(shape.data);
                    unread.set(
                        index,
                        shape.lanes.map(({ lane }) => lane),
                    );
                    continue;
                }
                if (value === undefined) return undefined;
            }
            // A snapshot of retained data crosses as a copy, so the helper
            // must only read it: a write would miss the native object.
            if (
                value.snapshot &&
                (!parameter ||
                    !ts.isIdentifier(parameter) ||
                    !parameterIsReadOnly(this.checker, declaration, parameter))
            )
                return undefined;
            args.push(value.value);
        }
        const label = `Builder '${callee.text}'`;
        return {
            value:
                holes && unread.size > 0
                    ? this.runShaderSourceBuilder(
                          call,
                          declaration,
                          args,
                          unread,
                          holes,
                          label,
                          keys,
                      )
                    : this.runGenerationFunction(
                          declaration,
                          args,
                          label,
                          undefined,
                          keys,
                      ),
            label,
        };
    }

    /**
     * An application function run at generation (`executeApplicationFunction`),
     * once per declaration and arguments when it folds no enclosing binding:
     * the realm is fresh and closed, so one run is every run. A module
     * constant runs once, with no arguments.
     */
    public runGenerationFunction(
        declaration: ExecutedTarget,
        args: readonly (ExecutedArgument | undefined)[],
        label: string,
        pinnedStandIn?: (name: string) => unknown,
        keys: readonly string[] = [],
    ): unknown {
        const key = JSON.stringify([
            pinnedStandIn !== undefined,
            keys,
            ...args.map((value) =>
                value === undefined
                    ? ["undefined"]
                    : typeof value === "number"
                      ? ["number", Object.is(value, -0) ? "-0" : String(value)]
                      : ["value", value],
            ),
        ]);
        let runs = this.generationRuns.get(declaration);
        if (!runs) {
            runs = new Map();
            this.generationRuns.set(declaration, runs);
        }
        if (runs.has(key)) return runs.get(key);
        // A run that folds an enclosing function's bindings depends on the
        // specialization it was reached in, so only a closed one is kept.
        let closed = true;
        const result = executeApplicationFunction(
            this.generationRunContext(
                (identifier) => {
                    closed = false;
                    return this.staticScalar(identifier);
                },
                {
                    ...(pinnedStandIn ? { pinnedStandIn } : {}),
                    ...(ts.isVariableDeclaration(declaration) ||
                    ts.isCallExpression(declaration)
                        ? {
                              writtenThrough: (name: ts.Identifier) =>
                                  this.moduleConstantIsWritten(name) &&
                                  (!ts.isVariableDeclaration(declaration) ||
                                      !this.moduleRecordUnchangedBeforeSnapshot(
                                          name,
                                          declaration,
                                      )),
                          }
                        : {}),
                },
            ),
            declaration,
            args,
            label,
            keys,
        );
        if (closed) runs.set(key, result);
        return result;
    }

    public runModelCall(
        call: ts.CallExpression,
        label: string,
    ): ExecutedResult {
        return runApplicationFunction(
            this.generationRunContext(
                (identifier) => this.staticScalar(identifier),
                {
                    model: true,
                    opaque: (identifier) =>
                        holdsEngineValue(this.checker, identifier),
                },
            ),
            call,
            [],
            label,
        );
    }

    public runCallOverHeldData(
        call: ts.CallExpression,
        held: (identifier: ts.Identifier) => ExecutedArgument | undefined,
        written: (name: ts.Identifier) => boolean,
        label: string,
    ): ExecutedResult {
        return runApplicationFunction(
            this.generationRunContext(held, { writtenThrough: written }),
            call,
            [],
            label,
        );
    }

    /**
     * What a generation run reads of the program: its checker and files,
     * the deployment's constants, the enclosing bindings `foldEnclosing`
     * folds, and `more`.
     */
    private generationRunContext(
        foldEnclosing: ExecutedFunctionContext["foldEnclosing"],
        more: Pick<
            ExecutedFunctionContext,
            | "writtenThrough"
            | "pinnedStandIn"
            | "standInText"
            | "unreadNumbers"
            | "model"
            | "opaque"
        >,
    ): ExecutedFunctionContext {
        return {
            checker: this.checker,
            sourceFiles: this.program.getSourceFiles(),
            fail: (node, message) => this.fail(node, message),
            foldEnclosing,
            deploymentValue: (expression) =>
                browserDeploymentValue(this, expression),
            packagedText: (url) => packagedFetchText(this, url),
            ...more,
        };
    }

    /** The generation-known scalar an expression folds to, if any. */
    private staticScalar(
        expression: ts.Expression,
    ): ExecutedScalar | undefined {
        return this.generationScalar(expression, this.compileValue(expression));
    }

    /**
     * The scalar a generation run reads for `value`, compiled from
     * `expression`: its static text, boolean or number, or the text
     * generation knows another way (a module constant, an inlined call's
     * argument).
     */
    private generationScalar(
        expression: ts.Expression,
        value: Value,
    ): ExecutedScalar | undefined {
        return (
            value.staticString ??
            value.staticBoolean ??
            value.staticNumber ??
            (isStringValue(value)
                ? this.evaluator.staticTextValue(expression)
                : undefined)
        );
    }

    /** Retained objects stay native; only fresh, lossless literal data may cross realms. */
    private generationArgument(
        expression: ts.Expression,
    ): { value: ExecutedArgument | undefined; snapshot?: true } | undefined {
        const node = this.unwrap(expression);
        if (node.kind === ts.SyntaxKind.NullKeyword) return { value: null };
        if (ts.isArrayLiteralExpression(node)) {
            const elements: ExecutedArgument[] = [];
            for (const element of node.elements) {
                if (
                    ts.isSpreadElement(element) ||
                    ts.isOmittedExpression(element)
                )
                    return undefined;
                const value = this.generationArgument(element);
                if (
                    value?.value === undefined ||
                    !losslessGenerationNumber(value.value)
                )
                    return undefined;
                elements.push(value.value);
            }
            return { value: elements };
        }
        if (ts.isObjectLiteralExpression(node)) {
            const record: { [name: string]: ExecutedArgument } = {};
            const members = plainDataMembers(node);
            if (!members) return undefined;
            for (const member of members) {
                if (member.kind !== "property") return undefined;
                const value = this.generationArgument(member.value);
                if (
                    value?.value === undefined ||
                    !losslessGenerationNumber(value.value)
                )
                    return undefined;
                // An own `["__proto__"]` key is data; `=` would set the prototype.
                Object.defineProperty(record, member.key, {
                    value: value.value,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
            return { value: record };
        }
        // A proven scalar field may read a retained record without passing
        // that record into the generation realm. Its ordinary value lowering
        // owns the alias/write proof; observable calls still stay native.
        if (
            this.evaluationOrder.writesStorage(node) ||
            this.evaluationOrder.hasModuleEffects(node)
        )
            return undefined;
        const carried = this.compileValue(node);
        // A present undefined argument still counts toward the authored arity.
        // Nested undefined values remain excluded by the lossless JSON boundary.
        if (absenceOf(carried) === "undefined" && !carried.parameterBinding)
            return { value: undefined };
        // A known null (a case split's null arm) is plain data too.
        if (absenceOf(carried) === "null" && !carried.parameterBinding)
            return { value: null };
        const value = this.generationScalar(node, carried);
        if (value !== undefined) return { value };
        // A field of plain data generation runs (`executedPath`), such as
        // the record an awaited helper's call settles to.
        const path =
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
                ? this.executedPath(node)
                : undefined;
        const executed = path && this.executedPathValue(path);
        if (
            typeof executed === "number" ||
            typeof executed === "string" ||
            typeof executed === "boolean"
        )
            return { value: executed };
        // A complete static snapshot of retained data (a record or array
        // whose current contents generation knows) crosses as its copy.
        const snapshot = this.currentStaticLiteral(carried, node);
        return snapshot !== undefined &&
            snapshot !== null &&
            typeof snapshot === "object"
            ? { value: snapshot as ExecutedArgument, snapshot: true }
            : undefined;
    }

    /**
     * The elements a const local's closed-helper initializer produced
     * (`const icons = plan(opts.icons)`), for a reader that knows nothing
     * changes the array; undefined when a run at the read is not the
     * declaration's (`rerunCallInitializer`), the call cannot run at
     * generation or its result is no array.
     */
    public executedInitializerElements(
        identifier: ts.Identifier,
    ): readonly Value[] | undefined {
        const initializer = this.rerunCallInitializer(identifier);
        const executed = initializer && this.executedCall(initializer.call);
        return Array.isArray(executed)
            ? executed.map((element: unknown) =>
                  jsonToValue(
                      this,
                      executedConstantJsonPolicy,
                      element,
                      identifier,
                  ),
              )
            : undefined;
    }

    public packagedValueDomain(
        expression: ts.Expression,
        scalar: "number" | "boolean",
    ): readonly string[] | undefined {
        if (this.packagedQuery) return undefined;
        this.packagedQuery = true;
        try {
            return packagedValueDomain(this, expression, scalar);
        } finally {
            this.packagedQuery = false;
        }
    }

    /**
     * The helper call a `const` binding's initializer is, with its
     * declaration, when running it at a later read calls what the
     * declaration called: a module's own function, with arguments that
     * re-read alike.
     */
    private rerunCallInitializer(
        identifier: ts.Identifier,
    ):
        | { declaration: ts.VariableDeclaration; call: ts.CallExpression }
        | undefined {
        const declaration =
            this.symbols.valueSymbol(identifier)?.valueDeclaration;
        if (
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !declaration.initializer ||
            variableKind(declaration) !== "const"
        )
            return undefined;
        const call = this.unwrap(declaration.initializer);
        return ts.isCallExpression(call) &&
            !call.questionDotToken &&
            moduleLevelCallee(this.checker, call.expression) &&
            // The answer at the read only relaxes the cached one.
            call.arguments.every(
                (argument) =>
                    this.rereadsAlike(argument) ||
                    this.rereadsAlike(argument, identifier),
            )
            ? { declaration, call }
            : undefined;
    }

    /**
     * What a closed-helper call returns when generation runs it, if it can,
     * read at `keys` (`executeApplicationFunction`); while a shader stage's
     * text folds, the run-time numbers it formats spelled as that fold's
     * holes (`runShaderSourceBuilder`).
     */
    private executedCall(
        call: ts.CallExpression,
        keys?: readonly string[],
    ): unknown {
        return unlessRefused(() =>
            this.probeEmission(
                () =>
                    this.runGenerationCall(call, this.shaderSourceHoles, keys)
                        ?.value,
                () => false,
            ),
        );
    }

    /**
     * The helper call a `const` holds the result of
     * (`const sources = stageSources(lit)`), when evaluating it at a later
     * read of its member at `keys` gives what the binding holds there: a
     * run there is the declaration's (`rerunCallInitializer`) and no write
     * the program can make reaches that member -- for a function's own
     * `const`, nor anything it holds (`bindingSubtreeIntact`); for a module
     * one, the binding at all.
     */
    public settledCallInitializer(
        identifier: ts.Identifier,
        keys: readonly string[] = [],
    ): ts.CallExpression | undefined {
        const initializer = this.rerunCallInitializer(identifier);
        if (!initializer) return undefined;
        const { declaration } = initializer;
        const unwritten = ts.findAncestor(declaration.parent, isEffectFunction)
            ? bindingSubtreeIntact(this.checker, declaration, keys)
            : this.unwrittenConst(declaration);
        return unwritten ? initializer.call : undefined;
    }

    /**
     * The value a member read of `const x = await f()` holds where
     * generation runs the call and it settles to plain data reading only
     * packaged files (`executedPath`), and no write the program can make
     * reaches the member read (`settledCallInitializer`). The binding's
     * run-time storage answers every other read.
     */
    public generationRead(expression: ts.Expression): Value | undefined {
        const path = this.executedPath(expression);
        const declaration =
            path?.held && path.call
                ? ts.findAncestor(path.call, ts.isVariableDeclaration)
                : undefined;
        if (
            !path ||
            path.keys.length === 0 ||
            !declaration?.initializer ||
            !ts.isAwaitExpression(
                this.evaluator.unwrap(declaration.initializer, {
                    await: false,
                }),
            )
        )
            return undefined;
        const data = this.executedPathValue(path);
        // Data of a kind the read does not type stays the run time's to read.
        return data === undefined ||
            !typeAdmitsData(
                this.checker,
                this.checker.getTypeAtLocation(expression),
                data,
            )
            ? undefined
            : jsonToValue(this, executedConstantJsonPolicy, data, expression);
    }

    public resolveStaticExpression(
        expression: ts.Expression,
        resolving: ReadonlySet<ts.Symbol> = new EmissionSet(),
    ): ts.Expression {
        return this.evaluator.resolveStaticExpression(expression, resolving);
    }

    public constantNameValue(name: ts.Identifier): Value | undefined {
        return this.resolveStaticExpression(name) !== name
            ? this.compileValue(name)
            : undefined;
    }

    public staticLiteralData(
        value: Value,
        expression: ts.Expression,
        leaf?: (part: Value) => unknown,
    ): unknown {
        return this.currentStaticLiteral(
            value,
            expression,
            undefined,
            undefined,
            leaf,
        );
    }

    /**
     * Read complete current snapshots through the ordinary property
     * ownership rules; `leaf` reads a part as the plain data it answers,
     * where it answers any.
     */
    private currentStaticLiteral(
        carried: Value,
        expression: ts.Expression,
        active: ReadonlySet<Value> = new Set(),
        projectedTypes: ReadonlySet<string> = new Set(),
        leaf?: (part: Value) => unknown,
    ): unknown {
        if (
            carried.parameterBinding ||
            active.has(carried) ||
            !this.bindings.recordPropertiesAreCurrent(carried)
        )
            return undefined;
        const read = leaf?.(carried);
        if (read !== undefined) return read;
        const scalar =
            carried.staticString ??
            carried.staticNumber ??
            carried.staticBoolean;
        if (scalar !== undefined)
            return typeof scalar === "number" &&
                (!Number.isFinite(scalar) || Object.is(scalar, -0))
                ? undefined
                : scalar;
        const nested = new Set([...active, carried]);
        const elements =
            carried.staticElementIndex !== undefined
                ? undefined
                : carried.staticElementsOwner
                  ? carried.staticElementsOwner.staticElements
                  : (carried.staticElements ?? carried.tupleElements);
        if (elements) {
            const values = elements.map((element, index) =>
                this.currentStaticLiteral(
                    element,
                    ts.factory.createElementAccessExpression(
                        expression,
                        ts.factory.createNumericLiteral(index),
                    ),
                    nested,
                    projectedTypes,
                    leaf,
                ),
            );
            return values.every((value) => value !== undefined)
                ? values
                : undefined;
        }
        const projectedType =
            carried.kind === "data" &&
            carried.dataType?.kind === "struct" &&
            carried.recordProperties === undefined
                ? carried.dataType.name
                : undefined;
        if (projectedType && projectedTypes.has(projectedType))
            return undefined;
        const nestedTypes = projectedType
            ? new Set([...projectedTypes, projectedType])
            : projectedTypes;
        const fields =
            carried.kind === "data" && carried.dataType?.kind === "struct"
                ? this.dataTypes
                      .structFields(
                          carried.dataType.name,
                          expression,
                          "accessors",
                      )
                      .filter(
                          (field) =>
                              carried.recordOwnKeys === undefined ||
                              carried.recordOwnKeys.includes(field.sourceName),
                      )
                      .map((field) => ({
                          sourceName: field.sourceName,
                          accessor: field.accessor !== undefined,
                      }))
                : (carried.kind === "record" ||
                        (carried.kind === "data" &&
                            carried.dataType?.kind === "union" &&
                            carried.recordOwnKeys !== undefined)) &&
                    carried.recordProperties &&
                    Object.keys(carried.recordMethods ?? {}).length === 0 &&
                    Object.keys(carried.recordGetters ?? {}).length === 0 &&
                    Object.keys(carried.recordSetters ?? {}).length === 0
                  ? (
                        carried.recordOwnKeys ??
                        Object.keys(carried.recordProperties)
                    ).map((sourceName) => ({ sourceName, accessor: false }))
                  : undefined;
        if (!fields) return undefined;
        const entries: Array<[string, unknown]> = [];
        for (const field of fields) {
            if (field.accessor || field.sourceName === "__proto__")
                return undefined;
            if (
                carried.kind === "data" &&
                carried.dataType?.kind === "union" &&
                !carried.recordProperties?.[field.sourceName]
            )
                return undefined;
            const access = ts.factory.createPropertyAccessExpression(
                expression,
                field.sourceName,
            );
            const member = this.propertyAccess.readResolvedProperty(
                carried,
                access,
            );
            if (!member) return undefined;
            const value = this.currentStaticLiteral(
                member,
                access,
                nested,
                nestedTypes,
                leaf,
            );
            if (value === undefined) return undefined;
            entries.push([field.sourceName, value]);
        }
        return Object.fromEntries(entries);
    }

    /**
     * A local `const` whose values generation does not all fold: its
     * initializer, re-read where a static descriptor list needs syntax.
     * Only when the re-read sees what the declaration saw: nothing writes
     * through the binding and its initializer re-reads alike
     * (`rereadsAlike`).
     */
    private stableLocalInitializer(
        identifier: ts.Identifier,
    ): ts.Expression | undefined {
        const declaration =
            this.symbols.valueSymbol(identifier)?.valueDeclaration;
        if (
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !declaration.initializer ||
            ts.isSourceFile(declaration.parent.parent.parent)
        )
            return undefined;
        const known = this.stableInitializers.get(declaration);
        if (known !== undefined) return known || undefined;
        const initializer =
            this.unwrittenConst(declaration) &&
            this.rereadsAlike(declaration.initializer)
                ? declaration.initializer
                : undefined;
        this.stableInitializers.set(declaration, initializer ?? false);
        return initializer;
    }

    /** A `const` binding nothing writes through. */
    private unwrittenConst(declaration: ts.VariableDeclaration): boolean {
        return (
            variableKind(declaration) === "const" &&
            !this.evaluator.isWrittenThrough(declaration)
        );
    }

    /**
     * Whether a later re-read of an expression sees what its first
     * evaluation saw: a call in it returns a literal, and its names are
     * functions, consts nothing writes through, or parameter members their
     * function only reads (up to `atRead`, when supplied).
     */
    private rereadsAlike(expression: ts.Expression, atRead?: ts.Node): boolean {
        const known = atRead ? undefined : this.rereadAlike.get(expression);
        if (known !== undefined) return known;
        const stableName = (name: ts.Identifier): boolean => {
            const named = this.symbols.valueSymbol(name)?.valueDeclaration;
            if (!named) return false;
            if (ts.isFunctionDeclaration(named)) return true;
            if (ts.isVariableDeclaration(named))
                return this.unwrittenConst(named);
            if (
                !ts.isParameter(named) ||
                !ts.isIdentifier(named.name) ||
                !ts.isFunctionLike(named.parent) ||
                !("body" in named.parent)
            )
                return false;
            const binding = named.name;
            const path: string[] = [];
            for (
                let node: ts.Node = name;
                ts.isPropertyAccessExpression(node.parent) &&
                node.parent.expression === node;
                node = node.parent
            )
                path.push(node.parent.name.text);
            // A one-key read sees only the slot; a deeper one sees inside it.
            if (path.length === 1) {
                const written = parameterWrittenSlots(
                    this.checker,
                    named.parent,
                    binding,
                    atRead,
                );
                return (
                    !written.has("") &&
                    ![...written].some((key) => keysMayMatch(key, path[0]!))
                );
            }
            return parameterProjectionIsReadOnly(
                this.checker,
                named.parent,
                named.parent.parameters.indexOf(named),
                path,
            );
        };
        const stable = (node: ts.Node): boolean => {
            if (ts.isFunctionLike(node)) return false;
            if (ts.isTypeNode(node)) return true;
            // A parameterless literal-returning helper re-runs to the same literal.
            if (
                ts.isCallExpression(node) &&
                (node.arguments.length > 0 ||
                    this.evaluator.resolveStaticLiteral(node) === node)
            )
                return false;
            if (ts.isIdentifier(node))
                return !isValueReference(node) || stableName(node);
            return !ts.forEachChild(node, (child) => !stable(child));
        };
        const alike = stable(expression);
        if (!atRead) this.rereadAlike.set(expression, alike);
        return alike;
    }

    /** The fold over required literals, which may read closed helpers. */
    private literalSelection(): StaticSelectionContext {
        return {
            conditions: this.conditions,
            probeEmission: (probe, answered) =>
                this.probeEmission(probe, answered),
            resolveStaticExpression: (node) =>
                this.evaluator.resolveStaticLiteral(node),
        };
    }

    /**
     * The literal a call's argument gave a member of a parameter's own
     * object, where the read runs before anything in the function changes
     * or keeps that object (`readsIntactParameterObject`): the argument's
     * facts still describe it there, and nowhere after.
     */
    private argumentLiteralMember(expression: ts.Expression): unknown {
        const keys: string[] = [];
        let root: ts.Node = expression;
        while (ts.isPropertyAccessExpression(root)) {
            keys.unshift(root.name.text);
            // A member the compiler projects is read where its source is.
            root =
                root.expression.pos < 0
                    ? ts.getOriginalNode(root.expression)
                    : root.expression;
        }
        if (
            keys.length === 0 ||
            !ts.isIdentifier(root) ||
            !readsIntactParameterObject(
                this.checker,
                this.parameterObjects,
                root,
            )
        )
            return undefined;
        const fact = this.bindings.currentRecordMember(
            this.bindings.lookupOptional(root),
            keys,
        );
        return fact && this.currentStaticLiteral(fact, expression);
    }

    /** Required descriptors may read closed helpers or unwritten module constants. */
    public resolveStaticLiteral(expression: ts.Expression): ts.Expression {
        const resolved =
            selectedStaticExpression(this.literalSelection(), expression) ??
            this.evaluator.resolveStaticLiteral(expression);
        let value: unknown;
        if (
            ts.isIdentifier(resolved) ||
            ts.isPropertyAccessExpression(resolved) ||
            ts.isElementAccessExpression(resolved)
        ) {
            const carried = this.compileValue(resolved);
            value =
                this.currentStaticLiteral(carried, resolved) ??
                this.argumentLiteralMember(resolved);
            const local =
                value === undefined && ts.isIdentifier(resolved)
                    ? this.stableLocalInitializer(resolved)
                    : undefined;
            if (local) return this.resolveStaticLiteral(local);
            const constant =
                value === undefined && ts.isIdentifier(resolved)
                    ? this.moduleConstantDeclaration(resolved)
                    : undefined;
            if (constant)
                value = this.runGenerationFunction(
                    constant.declaration,
                    [],
                    `Module constant '${constant.name.text}'`,
                );
            // A static reader reads all it resolves: a part generation
            // cannot read refuses there.
            if (value === undefined)
                refuseUnreadablePart(this, carried, expression);
        } else if (
            ts.isCallExpression(resolved) &&
            !resolved.questionDotToken
        ) {
            value = this.runGenerationCall(resolved)?.value;
        }
        if (value === undefined) return resolved;
        // The executor admits only lossless JSON data and rejects module
        // constants the program writes through. Keep ordinary literal validation.
        const file = ts.createSourceFile(
            `${expression.getSourceFile().fileName}.static-literal.ts`,
            `(${JSON.stringify(value)});`,
            ts.ScriptTarget.ESNext,
            true,
        );
        const statement = file.statements[0];
        return statement && ts.isExpressionStatement(statement)
            ? this.unwrap(statement.expression)
            : resolved;
    }

    public compileTypedArrayArgument(
        expression: ts.Expression,
        kind: TypedArrayKind,
    ): string {
        return this.dataLowerer.compileForSink(expression, { kind });
    }

    /**
     * A typed-array argument the source already holds -- a name, a member,
     * an element -- as the value of its storage, where it is of `kind`.
     */
    public heldTypedArrayValue(
        expression: ts.Expression,
        kind: TypedArrayKind,
    ): Value | undefined {
        const read = this.unwrap(expression);
        if (
            !ts.isIdentifier(read) &&
            !ts.isPropertyAccessExpression(read) &&
            !ts.isElementAccessExpression(read)
        )
            return undefined;
        return this.probeEmission(() => {
            const value = this.compileValue(expression);
            return value.kind === "data" && value.dataType?.kind === kind
                ? value
                : undefined;
        });
    }

    public compileForDataSink(
        expression: ts.Expression,
        dataType: DataType,
    ): string {
        return this.dataLowerer.compileForSink(expression, dataType);
    }

    /** Materializes a pure-data SpriteAtlas record over a reached pixel texture. */
    public compileSpriteAtlasRecord(
        value: Value,
        node: ts.Node,
    ): string | undefined {
        return compileSpriteAtlasRecord(this, value, node);
    }

    public compileSpriteAtlas(expression: ts.Expression): Value {
        const unwrapped = this.unwrap(expression);
        const value = this.compileValue(unwrapped);
        if (value.kind === "record") {
            const cpp = compileSpriteAtlasRecord(this, value, expression);
            if (cpp) {
                const engineCpp = this.defaultEngine();
                return {
                    kind: "sprite-atlas",
                    cpp,
                    ...(engineCpp ? { engineCpp } : {}),
                };
            }
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "optional" &&
            value.dataType.inner.kind === "handle" &&
            value.dataType.inner.handle === "sprite-atlas"
        ) {
            const engineCpp = this.defaultEngine();
            return {
                kind: "sprite-atlas",
                cpp: `(*${value.cpp})`,
                dataType: value.dataType.inner,
                ...(engineCpp ? { engineCpp } : {}),
            };
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "handle" &&
            value.dataType.handle === "sprite-atlas"
        ) {
            const engineCpp = this.defaultEngine();
            return {
                kind: "sprite-atlas",
                cpp: value.cpp,
                dataType: value.dataType,
                ...(engineCpp ? { engineCpp } : {}),
            };
        }
        return value;
    }

    public probeStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined {
        if (
            this.knownValueWithoutEvaluation(expression)?.collectionCardinality
                ?.untrackedAliases
        )
            return undefined;
        // A list a scene selects between with a generation-known condition
        // is still a static list. Scene 140 writes both of its option
        // arrays that way -- `sg ? [sg] : undefined` for the shadow lights
        // and `probe ? [box] : [sphere, box]` for the casters -- behind
        // query flags that fold. Selected through the shared helper rather
        // than inside resolveStaticExpression, which feeds every numeric
        // and colour position in the compiler: folding conditional arms
        // there would move emitted code far outside array positions.
        const resolved = selectedStaticExpression(this, expression);
        return resolved && ts.isArrayLiteralExpression(resolved)
            ? resolved
            : undefined;
    }

    public sourceFiles(): readonly ts.SourceFile[] {
        return this.program.getSourceFiles();
    }

    public reachThrow(): void {
        this.throwReached = true;
    }

    /**
     * Materialize a PAL container as the plain-data value the scene's own
     * type says it is.
     *
     * Every other intrinsic that returns data returns a PRIMITIVE container
     * -- an `f32array`, a handle, a string -- which needs no element type.
     * A query that answers a list of records does, and the element struct is
     * the scene's, not the PAL's: `Vec3` is generated from the pinned
     * interface with its own field order and its own value-or-reference
     * backing. So the type is read off the call site rather than assumed,
     * the fields are filled by NAME against the generated definition, and a
     * field the caller cannot supply is a refusal rather than a positional
     * guess that would compile and mean something else.
     */
    public emitDataVectorOfStructs(
        node: ts.Node,
        sourceCpp: string,
        fieldValues: (element: string) => Readonly<Record<string, string>>,
    ): Value {
        const dataType = this.dataLowerer.dataTypeAt(node);
        if (dataType?.kind !== "vector" || dataType.element.kind !== "struct") {
            this.fail(
                node,
                "This query answers a list of records, which needs a " +
                    "generated struct element at the call site.",
            );
        }
        const structName = dataType.element.name;
        // The loop variable is MINTED and handed to the caller, so the name
        // the loop declares and the names the fields read cannot disagree.
        const elementName = this.allocateTemporaryCppName("data_element");
        const values = fieldValues(elementName);
        const parts = this.dataTypes
            .structFields(structName, node)
            .map((field) => {
                const value = values[field.name];
                if (value === undefined) {
                    this.fail(
                        node,
                        `Reached '${structName}' names a field ` +
                            `'${field.name}' this query cannot fill.`,
                    );
                }
                return value;
            });
        const cppName = this.allocateTemporaryCppName("data_vector");
        this.reachJsData();
        this.emit(`${this.dataTypes.cppType(dataType)} ${cppName};`);
        this.emit({
            kind: "expression",
            code: `${cppName}.reserve(${sourceCpp}.size());`,
        });
        this.emit({
            kind: "open",
            code: `for (const auto& ${elementName} : ${sourceCpp}) {`,
            iteration: true,
        });
        this.increaseIndent();
        this.emit({
            kind: "expression",
            code:
                `${cppName}.push_back(` +
                `${this.dataLowerer.structAggregate(dataType.element, parts)});`,
        });
        this.decreaseIndent();
        this.emit({ kind: "close", code: `}` });
        this.dataLowerer.registerLocal(cppName, "owned");
        return { kind: "data", cpp: cppName, dataType };
    }

    public reachJsData(): void {
        this.jsDataReached = true;
    }

    /** Whether a `new` expression constructs a reached local class. */
    public constructsLocalClass(expression: ts.NewExpression): boolean {
        return this.classLowerer.resolveClass(expression) !== undefined;
    }

    public reachFileReader(): void {
        this.fileReaderReached = true;
    }

    public reachJson(): void {
        this.reachFeature("data:json");
    }

    public reachImageDecode(): void {
        this.imageDecodeReached = true;
    }

    public enterRuntimeControlFlow(): void {
        this.runtimeControlFlowDepth += 1;
    }

    public leaveRuntimeControlFlow(): void {
        this.runtimeControlFlowDepth -= 1;
    }

    public isInFrameCallback(): boolean {
        return this.frameCallbackDepth > 0;
    }

    public hasPresentationHost(): boolean {
        return this.presentationHostCpp !== undefined;
    }

    public hasFeature(feature: Feature): boolean {
        return this.features.has(feature);
    }

    public isInRuntimeControlFlow(): boolean {
        return this.runtimeControlFlowDepth > 0;
    }

    public enterRuntimeIteration(body?: ts.Node): void {
        if (body) {
            const frame = this.parameterizedResourceIterations.at(-1);
            const counted =
                frame?.statement.statement === body &&
                frame.iterationDepth === this.runtimeIterationDepth;
            this.bindings.visitRepeatedCollectionWrites(
                body,
                (value, elementsUnchanged) => {
                    const state =
                        value.collectionCardinality ??
                        value.staticElementsOwner?.collectionCardinality;
                    // Counted construction keeps its final size, but no iteration
                    // may observe that aggregate as its current collection size.
                    if (counted && state)
                        for (const current of this
                            .parameterizedResourceIterations)
                            if (
                                !state.createdIn.includes(current) &&
                                current.iterations > 1
                            )
                                state.varyingIn.add(current);
                    this.bindings.invalidateStaticElements(
                        value,
                        counted || elementsUnchanged,
                    );
                },
            );
        }
        this.runtimeIterationDepth += 1;
    }

    public leaveRuntimeIteration(): void {
        this.runtimeIterationDepth -= 1;
    }

    public isInRuntimeIteration(): boolean {
        return this.runtimeIterationDepth > 0;
    }

    public isInNativeFunctionBody(): boolean {
        return this.returnFrames.some((frame) => frame.kind === "native");
    }

    /**
     * Whether a function expression evaluated here mints one function object
     * per run-time evaluation: in a loop, a native function body, or on a
     * shared class instance (one per construction).
     */
    public isFunctionEvaluationRepeated(
        lexicalThis: Value | undefined,
    ): boolean {
        return (
            this.isInRuntimeIteration() ||
            this.isInNativeFunctionBody() ||
            (lexicalThis?.dataType?.kind === "struct" &&
                this.dataTypes.isClassStruct(lexicalThis.dataType.name))
        );
    }

    public isLocalCallbackEvaluationRepeated(declaration: ts.Node): boolean {
        const container = callbackClosureContainer(declaration);
        return (
            this.isInNativeFunctionBody() &&
            container !== undefined &&
            ts.isFunctionLike(container)
        );
    }

    public enterStaticIteration(statement: ts.IterationStatement): void {
        this.staticExpansionBudget.enter(statement);
        this.staticCallbackEvaluationIdentities.push(
            this.bindings.variableScopes.at(-1)!,
        );
    }

    /**
     * An optional static expansion: where it would exceed the compilation's
     * static budget, nothing it emitted is kept, the budget included, and
     * `declined` stands for it, so the caller emits the runtime form.
     */
    public withinStaticExpansionBudget<T>(expand: () => T, declined: T): T {
        let exceeded = false;
        const refusals = this.staticExpansionBudget.refusals;
        return this.probeEmission(
            () => {
                try {
                    return expand();
                } catch (error) {
                    if (
                        !(error instanceof CompileError) ||
                        this.staticExpansionBudget.refusals === refusals
                    )
                        throw error;
                    exceeded = true;
                    return declined;
                }
            },
            () => !exceeded,
        );
    }

    public leaveStaticIteration(): void {
        this.staticCallbackEvaluationIdentities.pop();
        this.staticExpansionBudget.leave();
    }

    public isInParameterizedResourceLoop(
        statement?: ts.IterationStatement,
    ): boolean {
        return statement
            ? this.parameterizedResourceIterations.some(
                  (frame) => frame.statement === statement,
              )
            : this.parameterizedResourceIterations.length > 0;
    }

    public parameterizedResourceLoop(
        statement: ResourceLoop,
        knownIterations?: number,
    ): ParameterizedResourceLoop | undefined {
        if (
            this.isInRuntimeControlFlow() &&
            !this.isInParameterizedResourceLoop()
        ) {
            return undefined;
        }
        if (!this.requiresStaticIteration(statement.statement))
            return undefined;
        return parameterizedResourceLoop(this, statement, knownIterations);
    }

    /**
     * Construction executes natively. Only the closed composition sequence is
     * repeated, in creation order, for the existing per-renderable tables.
     */
    public emitParameterizedResourceLoop(
        statement: ResourceLoop,
        iterations: number,
        emitBody: () => void,
    ): void {
        if (iterations === 0) return;
        const mark = this.sceneManifest.compositionMark();
        this.parameterizedResourceIterations.push({
            statement,
            iterations,
            controlDepth: this.runtimeControlFlowDepth,
            iterationDepth: this.runtimeIterationDepth,
        });
        try {
            emitBody();
        } finally {
            this.parameterizedResourceIterations.pop();
        }
        this.sceneManifest.repeatComposition(
            mark,
            iterations,
            (totalMeshes, totalMaterials) =>
                this.staticExpansionBudget.checkComposition(
                    statement,
                    totalMeshes,
                    totalMaterials,
                ),
        );
    }

    public callbackEvaluationIdentity(): object | undefined {
        return this.staticCallbackEvaluationIdentities.at(-1);
    }

    public defineThis(instance: Value | undefined): void {
        this.thisInstance = instance;
        // A generic receiver carries what its type parameters stand for.
        // Installing it with `this` is what makes an inlined method body
        // resolve `P` through the construction site rather than through the
        // declaration, and every existing save/restore of `this` restores
        // the substitution with it.
        this.dataTypes.setActiveTypeArguments(instance?.classTypeArguments);
    }

    /**
     * True when an identifier names a local function declaration, so a
     * record property holding it is a method rather than a value.
     */
    public namesLocalFunction(identifier: ts.Identifier): boolean {
        if (this.bindings.lookupOptional(identifier)) {
            // A bound value wins: a local shadowing a function name is
            // that local.
            return false;
        }
        return (
            resolveFunctionDeclaration(
                this.checker,
                identifier,
                (node, message) => this.fail(node, message),
            ) !== undefined
        );
    }

    /**
     * The value a property access reads out of a compile-time record,
     * or undefined when the owner is not one. Asking rather than
     * asserting, so the data lowerer can probe a path it may not own.
     */
    public resolveRecordMember(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const ownerExpression = this.unwrap(expression.expression);
        const owner = ts.isIdentifier(ownerExpression)
            ? (this.bindings.lookupOptional(ownerExpression) ??
              this.moduleNamespaces.fromIdentifier(ownerExpression) ??
              browserEnvironmentValue(this, ownerExpression))
            : ownerExpression.kind === ts.SyntaxKind.ThisKeyword
              ? this.activeThis()
              : ts.isPropertyAccessExpression(ownerExpression)
                ? (this.resolveRecordMember(ownerExpression) ??
                  browserEnvironmentValue(this, ownerExpression) ??
                  this.propertyAccess.lookupRecordProperty(ownerExpression))
                : undefined;
        if (owner?.dataType?.kind === "module-namespace")
            return this.moduleNamespaces.member(
                owner,
                expression.name.text,
                expression,
            );
        if (owner?.kind !== "record") {
            return undefined;
        }
        const accessor = owner.recordGetters?.[expression.name.text];
        const member = accessor
            ? this.compileRecordGetter(owner, accessor)
            : owner.recordProperties?.[expression.name.text];
        if (member) {
            // A link of an optional chain carries the chain's presence.
            return ts.isOptionalChain(expression)
                ? this.propertyAccess.propertyWithOwnerPresence(
                      owner,
                      member,
                      expression,
                  )
                : member;
        }
        // A property the record was built without reads as `undefined`
        // when its type declares it optional: `{ b: 2 } as { a?: number }`
        // has no `a`, and `r.a ?? 0` is the source's own way of saying so.
        const declared = this.checker
            .getTypeAtLocation(expression.expression)
            .getProperty(expression.name.text);
        return declared !== undefined &&
            (declared.flags & ts.SymbolFlags.Optional) !== 0
            ? undefinedValue()
            : undefined;
    }

    public resolveRecordValue(expression: ts.Expression): Value | undefined {
        const unwrapped = this.unwrap(expression);
        const value = ts.isIdentifier(unwrapped)
            ? (this.bindings.lookupOptional(unwrapped) ??
              compileWindowIdentity(this, unwrapped) ??
              browserEnvironmentValue(this, unwrapped))
            : unwrapped.kind === ts.SyntaxKind.ThisKeyword
              ? this.activeThis()
              : ts.isPropertyAccessExpression(unwrapped)
                ? (this.resolveRecordMember(unwrapped) ??
                  browserEnvironmentValue(this, unwrapped))
                : undefined;
        return value?.kind === "record" ? value : undefined;
    }

    public compileRecordSetter(
        owner: Value,
        setter: ts.SetAccessorDeclaration,
        value: ts.Expression,
        // The argument already computed (a compound store's new value);
        // `value` then only locates diagnostics.
        evaluated?: Value,
    ): void {
        const parameter = setter.parameters[0];
        if (!parameter || !ts.isIdentifier(parameter.name)) {
            this.classLowerer.compileSetter(owner, setter, value, evaluated);
            return;
        }
        const argument =
            evaluated ?? this.compileClassParameterValue(parameter.name, value);
        this.withRecordScopes(owner, () =>
            this.classLowerer.compileSetter(owner, setter, value, argument),
        );
    }

    /** Capture the lexical variables and types used by a returned callable. */
    public captureRecordScopes(): Pick<
        Value,
        "recordScopes" | "recordTypeArguments"
    > {
        const recordTypeArguments = this.dataTypes.captureTypeArguments();
        return {
            recordScopes: [...this.bindings.variableScopes],
            ...(recordTypeArguments ? { recordTypeArguments } : {}),
        };
    }

    /** Runs `work` in a callback value's record scopes ({@link withRecordScopes}). */
    public withCallbackScopes<T>(
        callback: Value,
        work: () => T,
        method?: ts.Node,
    ): T {
        return callback.callbackRecordOwner
            ? this.withRecordScopes(callback.callbackRecordOwner, work, method)
            : work();
    }

    /**
     * Runs `work` with a record's captured scope chain in force, so a
     * method or getter of that record sees the state it closed over
     * even when the scope that built it has since been left.
     */
    public withRecordScopes<T>(
        owner: Value,
        work: () => T,
        // The callable about to run, when the caller holds it: a class
        // method and an object literal's `method() {}` read their record
        // through `this`, while an arrow property keeps the `this` it
        // closed over.
        method?: ts.Node,
    ): T {
        const bindThis =
            owner.classDeclaration !== undefined ||
            (method !== undefined && !ts.isArrowFunction(method));
        if (!owner.recordScopes && !owner.recordTypeArguments && !bindThis) {
            return work();
        }
        const saved = [...this.bindings.variableScopes];
        if (owner.recordScopes) {
            this.bindings.variableScopes.length = 0;
            this.bindings.variableScopes.push(...owner.recordScopes);
        }
        try {
            return this.withThis(bindThis ? owner : this.activeThis(), () =>
                this.dataTypes.withTypeArguments(
                    owner.recordTypeArguments,
                    work,
                ),
            );
        } finally {
            if (owner.recordScopes) {
                this.bindings.variableScopes.length = 0;
                this.bindings.variableScopes.push(...saved);
            }
        }
    }

    /**
     * Reads a record getter by evaluating its accessor at the read
     * site, with the record's own scope restored. The subset covers
     * the shape the reached records use: a single `return` of an
     * expression over the state the record closed over.
     */
    public compileRecordGetter(
        owner: Value,
        accessor: ts.GetAccessorDeclaration,
        receiver?: Value,
    ): Value {
        const dispatched = this.classLowerer.dispatchGetter(
            owner,
            accessor,
            (receiver, selected) =>
                this.compileRecordGetter(receiver, selected),
        );
        if (dispatched) return dispatched;
        const statements = accessor.body?.statements ?? [];
        const only = statements.at(-1);
        if (!only || !ts.isReturnStatement(only) || !only.expression) {
            this.fail(
                accessor,
                `Getter '${accessor.name.getText()}' requires a final value return.`,
            );
        }
        const expression = only.expression;
        const leading = statements.slice(0, -1);
        const earlyReturn = firstReturn(leading);
        let resultType: DataType | undefined;
        if (earlyReturn) {
            // Early returns are function control flow: the body runs as a
            // native lambda of the getter's represented result type.
            const signature =
                this.checker.getSignatureFromDeclaration(accessor);
            resultType = signature
                ? this.dataTypes.fromTsType(
                      this.checker.getReturnTypeOfSignature(signature),
                      accessor,
                  )
                : undefined;
            if (!resultType)
                this.fail(
                    earlyReturn,
                    "A getter with early returns requires a represented result flow.",
                );
        }
        return this.withRecordScopes(owner, () => {
            if (leading.length)
                this.bindings.pushScope(this.allocateUserFunctionPrefix());
            // A getter's `this` is its receiver for both class instances and
            // object-literal accessors. The record may have crossed a return
            // boundary that copied its compile-time Value wrapper, so its
            // identity in classInstances is not a reliable dispatch guard.
            try {
                return this.withThis(receiver ?? owner, () => {
                    // A getter is an evaluation, even when its return happens
                    // to lower to a field read. Optional chains must consume
                    // it once and keep any nested method calls behind their
                    // guard.
                    if (resultType)
                        return {
                            ...this.userFunctions.emitValueLambda(
                                this,
                                statements,
                                this.dataTypes.ownReturnedArray(resultType),
                                false,
                            ),
                            impure: true,
                        };
                    emitReachableStatements(this, leading);
                    return { ...this.compileValue(expression), impure: true };
                });
            } finally {
                if (leading.length) this.bindings.popScope();
            }
        });
    }

    /**
     * Binds a class field to storage. A field whose declared type is
     * in the data model gets a real local of that type, so an array
     * field is a vector rather than the static tuple its empty literal
     * would otherwise fold to.
     */
    public bindClassField(
        name: ts.MemberName,
        initializer: ts.Expression,
        declared?: DataType,
    ): void {
        const sharedStorage = this.classFieldNeedsSharedStorage(name);
        const declaredData = declared ?? this.dataLowerer.dataTypeAt(name);
        const unwrappedInitializer = this.unwrap(initializer);
        if (
            declaredData &&
            this.dataTypes.carriesBorrowedPlatformEvent(declaredData) &&
            unwrappedInitializer.kind !== ts.SyntaxKind.NullKeyword &&
            !(
                ts.isIdentifier(unwrappedInitializer) &&
                unwrappedInitializer.text === "undefined" &&
                !this.bindings.lookupOptional(unwrappedInitializer)
            )
        ) {
            this.refuseBorrowedPlatformEventEscape(
                this.compileValue(initializer),
                initializer,
                "class field assignment",
            );
        }
        const nullableResource = this.nullableResourceKind(name);
        const nullableInitializer = nullableResource
            ? this.compileValue(initializer)
            : undefined;
        if (nullableResource && nullableInitializer?.kind === "json-null") {
            this.bindNullableClassField(name);
            return;
        }
        if (this.bindClassDataField(name, initializer, declared)) {
            return;
        }
        this.bindings.bindLocalOrParameterValue(
            name,
            nullableInitializer ?? this.compileValue(initializer),
            false,
            this.allocateTemporaryCppName(`class_field_${name.text}`),
            sharedStorage,
        );
    }

    private classFieldNeedsSharedStorage(name: ts.MemberName): boolean {
        const symbol = this.symbols.valueSymbol(name);
        const declaration = symbol?.declarations?.find(
            (candidate) =>
                ts.isPropertyDeclaration(candidate) ||
                (ts.isParameter(candidate) &&
                    candidate.parent !== undefined &&
                    ts.isParameterPropertyDeclaration(
                        candidate,
                        candidate.parent,
                    )),
        );
        return (
            declaration !== undefined &&
            (ts.getCombinedModifierFlags(declaration) &
                ts.ModifierFlags.Readonly) ===
                0
        );
    }

    /** Predeclare an uninitialized nullable resource class field. */
    public bindNullableClassField(name: ts.MemberName): Value | undefined {
        const resource = this.nullableResourceKind(name);
        if (!resource) return undefined;
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        const type = `std::optional<${resource.cppType}>`;
        const cell = this.classFieldNeedsSharedStorage(name)
            ? emitSharedCell(this, cppName, { type })
            : undefined;
        if (!cell)
            this.emit({
                kind: "declaration",
                type,
                name: cppName,
                initializer: "{}",
            });
        const value: Value = {
            ...this.nullableResourceValue(resource, cell?.cpp ?? cppName),
            ...(cell ? { sharedStorageCpp: cell.sharedStorageCpp } : {}),
        };
        this.bindings.defineVariable(name, value);
        return value;
    }

    /**
     * Predeclare class data that needs storage before the constructor body.
     * Optional fields and object references begin at JavaScript undefined.
     * Their backing cells belong to construction, not the first method that
     * writes them. Arrays are also created
     * here because a readonly array field must own the constructor value;
     * wiring it only at `this.field = value` would otherwise infer the
     * parameter's non-owning span representation.
     */
    public bindUninitializedClassDataField(
        name: ts.MemberName,
        declared?: DataType,
        assignedBeforeRead = false,
    ): Value | undefined {
        const dataType = declared ?? this.dataLowerer.dataTypeAt(name);
        // A field no code can read before its first assignment needs no
        // representation of its initial `undefined`.
        if (
            !dataType ||
            (!assignedBeforeRead &&
                dataType.kind !== "optional" &&
                dataType.kind !== "vector" &&
                !(
                    dataType.kind === "struct" &&
                    this.dataTypes.isReferenceStruct(dataType.name)
                ))
        ) {
            return undefined;
        }
        return this.bindClassDataStorage(name, dataType, undefined);
    }

    /** Predeclare optional storage for a resource-valued expression. */
    public bindOptionalResourceValue(name: ts.Identifier): Value | undefined {
        const resource = this.nullableResourceKind(name, true);
        if (!resource) return undefined;
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        this.emit({
            kind: "declaration",
            type: `std::optional<${resource.cppType}>`,
            name: cppName,
            initializer: "{}",
        });
        const value = this.nullableResourceValue(resource, cppName);
        this.bindings.defineVariable(name, value);
        return value;
    }

    /**
     * An explicitly declared class field without an initializer is first
     * assigned in the constructor body. Give a data-model field the same
     * native storage as an initialized declaration at that assignment; a
     * resource or compile-time record returns undefined for the existing
     * one-time binding path to own.
     * Reuse an evaluated value when assignment dispatch already resolved it,
     * so projecting its members into typed storage cannot rerun factories.
     */
    public bindClassDataField(
        name: ts.MemberName,
        initializer: ts.Expression,
        declared?: DataType,
        knownValue?: Value,
    ): Value | undefined {
        const dataType = declared ?? this.dataLowerer.dataTypeAt(name);
        if (!dataType || dataType.kind === "handle") {
            return undefined;
        }
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        const cpp = knownValue
            ? this.dataLowerer.compileKnownValueForSink(
                  knownValue,
                  dataType,
                  initializer,
              )
            : this.dataLowerer.compileForSink(initializer, dataType);
        return this.bindClassDataStorage(name, dataType, cpp, cppName);
    }

    /** A class data field's storage, value-initialized without `initializerCpp`. */
    private bindClassDataStorage(
        name: ts.MemberName,
        dataType: DataType,
        initializerCpp: string | undefined,
        cppName = this.allocateTemporaryCppName(`class_field_${name.text}`),
    ): Value {
        const cppType = this.dataTypes.cppType(dataType);
        const cell = this.classFieldNeedsSharedStorage(name)
            ? emitSharedCell(this, cppName, {
                  type: cppType,
                  initializer: initializerCpp,
              })
            : undefined;
        if (!cell)
            this.emit(
                initializerCpp === undefined
                    ? `${cppType} ${cppName}{};`
                    : `${cppType} ${cppName} = ${initializerCpp};`,
            );
        const storage = cell?.cpp ?? cppName;
        this.dataLowerer.registerLocal(storage, "owned");
        // Leaves use the same surface as a container read: numbers stay
        // numeric and stored resource handles remain resources.
        const value = this.dataLowerer.leafValue(storage, dataType);
        writable(value).nativeLvalue = true;
        if (cell) writable(value).sharedStorageCpp = cell.sharedStorageCpp;
        this.bindings.defineVariable(name, value);
        return value;
    }

    public resolveThisField(name: string): Value | undefined {
        const value = this.thisInstance?.recordProperties?.[name];
        if (value) this.useNativeValue(value);
        return value;
    }

    public activeThis(): Value | undefined {
        return this.thisInstance;
    }

    /** Runs `work` with `this` bound to `receiver`, restoring the enclosing `this` after. */
    public withThis<T>(receiver: Value | undefined, work: () => T): T {
        const previous = this.thisInstance;
        this.defineThis(receiver);
        try {
            return work();
        } finally {
            this.defineThis(previous);
        }
    }

    public registerClassInstance(
        instance: Value,
        declaration: ts.ClassLikeDeclaration,
    ): void {
        writable(instance).classDeclaration = declaration;
        this.classInstances.set(instance, declaration);
    }

    public classOf(instance: Value): ts.ClassLikeDeclaration | undefined {
        return instance.classDeclaration ?? this.classInstances.get(instance);
    }

    /**
     * The JavaScript identity of one materialized callback.
     *
     * Evaluating a function expression mints a function object, so the
     * identity is the declaration *and* the thing whose evaluation produced
     * it -- the instance a class-body handler was declared on, or the scope
     * an inline literal closed over. That is the declaration's own closure,
     * never whichever receiver happened to be bound where the callback was
     * materialized: a module-level `onTick` added inside a constructor and
     * removed at module scope is one function object, and two instances
     * adding it add the same one.
     *
     * An instance callback owned by a shared class has no such owner to key on --
     * its `this` is rebuilt at every access, and one identity would make
     * every instance's handler the same handler. That is refused rather
     * than conflated, as is a closure this cannot name at all. Structural
     * adapters for module-level prototype methods share the declaration's
     * identity while retaining their receivers in separate closures.
     */
    public callbackIdentity(
        declaration: ts.Node,
        owner: Value | undefined,
        prototypeMethod = false,
    ): number {
        if (ts.isIdentifier(declaration)) {
            declaration =
                tryResolveFunctionDeclaration(this.checker, declaration) ??
                this.fail(
                    declaration,
                    "Callback identity requires a function declaration.",
                );
        }
        if (
            prototypeMethod &&
            !(
                ts.isMethodDeclaration(declaration) &&
                ts.isClassDeclaration(declaration.parent) &&
                ts.isSourceFile(declaration.parent.parent)
            )
        )
            this.fail(
                declaration,
                "A structural method view requires a module-level class prototype identity.",
            );
        const key = prototypeMethod
            ? declaration.parent
            : this.callbackClosureKey(declaration, owner);
        const perClosure =
            this.callbackIdentities.get(declaration) ??
            new EmissionMap<object, number>();
        this.callbackIdentities.set(declaration, perClosure);
        const existing = perClosure.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const identity = ++this.nextCallbackIdentity;
        perClosure.set(key, identity);
        return identity;
    }

    /**
     * The object a callback declaration closes over, as one comparable key.
     *
     * An object literal is transparent here: it mints no scope of its own,
     * so a method written in one at module scope is as singular as a
     * module-level function. What mints a new function object per evaluation
     * is an enclosing class instance or an enclosing function body, and
     * those are exactly the two the key names.
     */
    private callbackClosureKey(
        declaration: ts.Node,
        owner: Value | undefined,
    ): object {
        const found = this.callbackClosureKeyOf(declaration, owner);
        return "key" in found
            ? found.key
            : this.fail(declaration, found.refusal);
    }

    /**
     * Whether a materialization of `declaration` with `owner` names the
     * function object it is (`callbackIdentity` gives it an identity
     * without refusing).
     */
    public hasCallbackIdentity(
        declaration: ts.Node,
        owner: Value | undefined,
    ): boolean {
        return "key" in this.callbackClosureKeyOf(declaration, owner);
    }

    /** `callbackClosureKey`'s key, or why a materialization names none. */
    private callbackClosureKeyOf(
        declaration: ts.Node,
        owner: Value | undefined,
    ): { key: object } | { refusal: string } {
        const container = callbackClosureContainer(declaration);
        if (!container) {
            if (owner?.callbackEvaluationIdentity) {
                return { key: owner.callbackEvaluationIdentity };
            }
            // Module scope: the program evaluates the declaration once, so
            // every materialization names the same function object.
            return { key: unownedCallbackScope };
        }
        if (ts.isClassLike(container)) {
            const receiver = this.thisInstance;
            // A materialization that supplied no owner may still be standing
            // on the declaring instance -- but only that one counts, so the
            // receiver is checked against the class the declaration is
            // written in rather than assumed to own it.
            const instance = owner?.recordProperties
                ? owner
                : receiver &&
                    isDeclaredInside(declaration, this.classOf(receiver))
                  ? receiver
                  : undefined;
            if (
                instance?.dataType?.kind === "struct" &&
                this.dataTypes.isClassStruct(instance.dataType.name)
            ) {
                return {
                    refusal:
                        "A callback declared per instance of a shared class has " +
                        "no identity a container could compare: every " +
                        "instance would register the same handler.",
                };
            }
            const properties = instance?.recordProperties;
            if (!properties) {
                return {
                    refusal:
                        "A callback declared in a class body is one function " +
                        "object per instance, and this materialization names " +
                        "no instance to compare it by.",
                };
            }
            return { key: properties };
        }
        if (
            ts.isConstructorDeclaration(container) &&
            owner?.recordProperties &&
            owner.classDeclaration === container.parent
        ) {
            if (
                owner.dataType?.kind === "struct" &&
                this.dataTypes.isClassStruct(owner.dataType.name)
            ) {
                return {
                    refusal:
                        "A callback declared by a shared class constructor has " +
                        "no per-instance identity a container could compare.",
                };
            }
            // A constructor evaluates once for this exact instance, so its
            // field record is also the identity of every function literal
            // created by that evaluation.
            return { key: owner.recordProperties };
        }
        // Declared inside a function: one function object per evaluation of
        // that body, and the innermost scope the evaluation pushed is what
        // the declaration closed over.
        const scope = owner?.recordScopes?.at(-1);
        if (scope) return { key: scope };
        // A body emitted once as a native function runs many times behind one
        // emission, so its evaluations have no compile-time scope to tell
        // them apart and are refused rather than conflated.
        if (this.returnFrames.some((frame) => frame.kind === "native")) {
            return {
                refusal:
                    "A callback declared inside a function emitted as a native " +
                    "function is a new function object at every call, and " +
                    "one identity would make them all the same handler.",
            };
        }
        return {
            refusal:
                "A callback declared inside a function is a new function " +
                "object at every evaluation, and this materialization " +
                "carries no closure to tell those evaluations apart.",
        };
    }

    public defaultEngine(): string | undefined {
        return this.defaultEngineCpp;
    }

    /** @unjournaled One identity per engine binding where no live binding carries it. */
    private readonly sourceEngineIdentities = new WeakMap<ts.Symbol, symbol>();

    /**
     * The engine a struct's engine field holds, as the analysis before
     * emission found it ({@link engineFieldIdentities}): its binding's
     * identity while that binding is live, else one per binding.
     */
    private engineFieldIdentity(field: DataStructField): symbol | undefined {
        const root = engineFieldIdentities(this.program).root(field.sourceName);
        if (!root) return undefined;
        const live = this.bindings.peekBinding(root)?.value.engineIdentity;
        if (live) return live;
        let identity = this.sourceEngineIdentities.get(root);
        if (!identity)
            this.sourceEngineIdentities.set(root, (identity = Symbol()));
        return identity;
    }

    /** Explicit engine parameters and their record fields supply a native body's
     * implicit resource context, without changing the entry's engine binding. */
    private scopedEngineContexts(): { engine: Value; owner: Value }[] {
        const frame = this.returnFrames[0];
        if (!frame) return [];
        const candidates = new Map<
            symbol | string,
            { engine: Value; owner: Value }
        >();
        const ancestry = new Set<string>();
        const seenValues = new Set<Value>();
        const collectType = (
            type: DataType,
            cpp: string,
            owner: Value,
            known: Value | undefined,
            field?: DataStructField,
        ): void => {
            if (type.kind === "handle" && type.handle === "engine") {
                const engine = `(*${cpp})`;
                const identity =
                    known?.engineIdentity ??
                    (field && this.engineFieldIdentity(field));
                candidates.set(identity ?? engine, {
                    engine: this.dataLowerer.leafValue(cpp, type),
                    owner,
                });
                return;
            }
            if (type.kind !== "struct" || ancestry.has(type.name)) return;
            ancestry.add(type.name);
            try {
                const access = this.dataTypes.memberAccess(type.name);
                for (const field of this.dataTypes.structFields(
                    type.name,
                    this.sourceFile,
                    "accessors",
                )) {
                    if (!field.accessor)
                        collectType(
                            field.type,
                            `${cpp}${access}${field.name}`,
                            owner,
                            field.readOnly
                                ? known?.recordProperties?.[field.sourceName]
                                : undefined,
                            field,
                        );
                }
            } finally {
                ancestry.delete(type.name);
            }
        };
        const collect = (value: Value, owner: Value): void => {
            if (seenValues.has(value)) return;
            seenValues.add(value);
            if (value.kind === "engine") {
                candidates.set(value.engineIdentity ?? value.cpp, {
                    engine: value,
                    owner,
                });
                return;
            }
            if (value.dataType)
                return collectType(value.dataType, value.cpp, owner, value);
            for (const field of Object.values(value.recordProperties ?? {}))
                collect(field, owner);
        };
        for (
            let index = this.bindings.variableScopes.length - 1;
            index >= frame.engineScopeDepth - 1;
            --index
        ) {
            for (const { value } of this.bindings.variableScopes[
                index
            ]!.values()) {
                seenValues.clear();
                collect(value, value);
            }
            if (candidates.size > 0) return Array.from(candidates.values());
        }
        return [];
    }

    public reachJsRandom(): void {
        this.jsRandomReached = true;
    }

    /** Escaping recursive functions own shared cells. Their traced closures
     * retain sibling cells; collection releases the group after its last root. */
    public emitNativeCallbackStorage(
        cppName: string,
        signature: string,
        escapesEmittingScope: boolean,
    ): Value<"callback"> {
        const type = `bbl::js::Callback<${signature}>`;
        if (!escapesEmittingScope) {
            this.emit(`${type} ${cppName};`);
            return {
                kind: "callback",
                cpp: cppName,
                runtimeCallbackIdentityCpp: `${cppName}.identity()`,
                nativeCaptures: [
                    this.registerNativeBinding(cppName, false, true, type),
                ],
            };
        }
        const owner = emitSharedCell(this, `${cppName}_owner`, { type });
        return {
            kind: "callback",
            cpp: owner.cpp,
            runtimeCallbackIdentityCpp: `${owner.cpp}.identity()`,
            sharedStorageCpp: owner.sharedStorageCpp,
            nativeCaptures: [
                this.registerNativeBinding(owner.sharedStorageCpp),
            ],
        };
    }

    /** How many speculative probes are open; a probe decides its own refusals. */
    @journaled private accessor probeDepth = 0;

    public get speculating(): boolean {
        return this.probeDepth > 0;
    }

    /** Commit a successful probe; restore all compiler-owned state on decline or throw. */
    public probeEmission<T>(
        probe: () => T,
        answered: (result: T) => boolean = (result) => result !== undefined,
    ): T {
        this.probeDepth++;
        // A survey times its outermost probes, kept or dropped.
        const survey = this.probeDepth === 1 ? activeSurvey() : undefined;
        const started = survey ? performance.now() : 0;
        let kept = false;
        try {
            const result = this.emissionTransaction(probe, answered);
            kept = answered(result);
            return result;
        } catch (error) {
            // A refusal leaving the outermost probe is the lowering's own:
            // the storage it names replays.
            if (
                this.probeDepth === 1 &&
                error instanceof CompileError &&
                error.demand
            )
                throw error.demand;
            throw error;
        } finally {
            this.probeDepth--;
            survey?.probed(kept, performance.now() - started);
        }
    }

    public keptEmission<T>(
        work: () => T,
        answered: (result: T) => boolean = (result) => result !== undefined,
    ): T {
        return this.emissionTransaction(work, answered);
    }

    public transaction(work: () => void): void {
        this.emissionTransaction(work, commitAlways);
    }

    public storageTakenDuringAttempt(declaration: ts.Declaration): boolean {
        return this.replayStorage.takenDuringAttempt(declaration);
    }

    public storageRevision(): number {
        return this.replayStorage.revision;
    }

    public refusedDemand(error: unknown): CompileError | undefined {
        return error instanceof NativeRecordStorageRequired
            ? this.replayStorage.refusedRecord(error.demand)
            : undefined;
    }

    public bindEmptyStorage(name: ts.Identifier): void {
        if (this.bindings.lookupOptional(name)) return;
        try {
            this.transaction(() => {
                if (this.declarations.bindAbsentResource(name)) return;
                const value = emptyStorage(
                    this,
                    this.dataLowerer.dataTypeAt(name),
                    name.text,
                );
                if (value) this.bindings.defineVariable(name, value);
            });
        } catch (error) {
            if (
                !(error instanceof CompileError) &&
                !(error instanceof StorageDemand)
            )
                throw error;
        }
    }

    public realmEngine(name: string): {
        name: string;
        type: string;
        cpp: string;
    } {
        return this.options.workers
            ? { name, type: "std::shared_ptr<bbl::Engine>", cpp: `(*${name})` }
            : { name, type: "bbl::Engine", cpp: name };
    }

    private emissionTransaction<T>(
        probe: () => T,
        answered: (result: T) => boolean,
    ): T {
        return new EmissionTransaction().run(probe, answered);
    }

    /**
     * Runs an emission body with indentation reset to column zero and
     * returns the produced lines, removing them from the main body stream.
     * Native function definitions and for-headers use this.
     */
    public captureEmittedLines(
        emitBody: () => void,
        options?: { functionBody?: true },
    ): string[] {
        if (options?.functionBody)
            return this.captureFunctionBodyLines(emitBody);
        return this.captureEmittedStatements(emitBody).map(
            renderNativeEmission,
        );
    }

    private captureFunctionBodyLines(emitBody: () => void): string[] {
        if (this.options.workers)
            return this.captureEmittedStatements(emitBody).map(
                renderNativeEmission,
            );
        const boundary = this.nativeBindingCheckpoint();
        const allocations = this.temporaryIndex;
        const captured = this.captureNativeDependencies(() =>
            this.captureEmittedStatements(emitBody),
        );
        const parameters = captured.nativeCaptures
            .filter((binding) => binding.sequence <= boundary)
            .map((binding) => ({
                name: binding.name,
                type: this.nativeBindingCaptureType(binding.name),
            }));
        return this.outlineNativeBody(captured.value, parameters, {
            bindings: boundary,
            allocations,
        }).map(renderNativeEmission);
    }

    public captureEmittedStatements(emitBody: () => void): NativeEmission[] {
        const start = this.body.length;
        const previousIndent = this.indentLevel;
        const previousScope = this.activeEmissionScope;
        this.activeEmissionScope = this.nextEmissionScope++;
        this.emissionScopeParents.set(this.activeEmissionScope, previousScope);
        this.indentLevel = 0;
        try {
            emitBody();
        } finally {
            this.indentLevel = previousIndent;
            this.activeEmissionScope = previousScope;
        }
        return this.body.splice(start);
    }

    public emitCapturedStatements(body: readonly NativeEmission[]): void {
        const indent = "    ".repeat(this.indentLevel);
        for (const event of body) {
            const emitted = { ...event, indent: indent + event.indent };
            this.staticExpansionBudget.emit(renderNativeEmission(emitted));
            this.body.push(emitted);
        }
    }

    /**
     * `locals` bounds the names the body declares: a native binding or a
     * temporary created after it began (the entry body's are all its own).
     */
    private outlineNativeBody(
        body: readonly NativeEmission[],
        parameters: readonly { name: string; type: string | undefined }[],
        locals = { bindings: 0, allocations: 0 },
    ): readonly NativeEmission[] {
        if (this.options.workers) return body;
        const outlined = outlineEmittedBody({
            body,
            parameters,
            bindingType: (name) => this.nativeBindingCaptureType(name),
            // Named by shape, two bodies outlining the same code (two
            // specializations of one function) call one helper and stay one
            // body for the shared-function interning.
            allocateName: (shape) =>
                `bbl_outlined_${createHash("sha256").update(shape).digest("hex").slice(0, 16)}`,
            isLocal: (name) =>
                (this.nativeBindings.get(name)?.sequence ?? 0) >
                    locals.bindings ||
                (this.allocatedCppNames.get(name) ?? 0) > locals.allocations,
            source: this.emissionSource ?? this.sourceFile.fileName,
        });
        for (const segment of outlined.segments) {
            if (this.outlinedHelpers.has(segment.name)) continue;
            this.outlinedHelpers.add(segment.name);
            this.nativeEmission.registerNativeFunction(
                segment.prototype,
                [...segment.lines],
                segment.source,
            );
        }
        for (const declaration of outlined.rewrittenDeclarations)
            this.nativeDeclarations.set(
                nativeStatementCode(declaration),
                declaration,
            );
        return outlined.body;
    }

    /**
     * Identity of the C++ lexical scope currently receiving emitted lines.
     * Captured callback/IIFE bodies get their own identity so a lazily
     * materialized local cannot be reused by code emitted outside that body.
     */
    @journaled public accessor activeEmissionScope = 0;
    @journaled private accessor nextEmissionScope = 1;
    /** The scope each captured emission scope was opened in. */
    private readonly emissionScopeParents = new EmissionMap<number, number>();

    /** Where a declaration emitted now lives: its emission scope and innermost block. */
    public emissionMark(): EmissionMark {
        return {
            emission: this.activeEmissionScope,
            block: this.emissionBlocks.at(-1)!,
        };
    }

    /**
     * Whether a declaration emitted at `mark` is in scope here: its block is
     * still open and its emission scope encloses this one. One emitted in
     * captured lines (a lambda's body, a closed block) is not, once they end.
     */
    public reachesEmissionMark(mark: EmissionMark): boolean {
        if (!this.emissionBlocks.includes(mark.block)) return false;
        for (
            let scope: number | undefined = this.activeEmissionScope;
            scope !== undefined;
            scope = this.emissionScopeParents.get(scope)
        )
            if (scope === mark.emission) return true;
        return false;
    }

    public beginNativeFunctionBody(
        returnType: DataType | undefined,
        contextualVoid = false,
        options: NativeFunctionBodyOptions = {},
    ): void {
        if (options.callSiteEffects && !this.definiteCollectionMutation()) {
            throw new Error(
                "Shared call effects require a definite source invocation.",
            );
        }
        this.returnFrames.push({
            kind: "native",
            type: returnType ?? "void",
            engineScopeDepth: this.bindings.variableScopes.length,
            ...(contextualVoid ? { contextualVoid: true } : {}),
            ...options,
        });
    }

    public prefersNativeDataIteration(): boolean {
        for (let index = this.returnFrames.length - 1; index >= 0; --index) {
            const frame = this.returnFrames[index]!;
            if (frame.kind === "native") return frame.runtimeDataLoops === true;
        }
        return false;
    }

    public endNativeFunctionBody(): void {
        this.validateResourceLoopReturn(this.returnFrames.pop());
    }

    public registerNativeBinding(
        name: string,
        borrowed = false,
        allowReference = false,
        cppType?: string,
    ): NativeCaptureBinding {
        if (cppType) this.registerNativeBindingType(name, cppType);
        const existing = this.nativeBindings.get(name);
        if (existing) return existing;
        const binding = {
            name,
            borrowed,
            allowReference,
            sequence:
                this.aheadBindingSequence ?? ++this.nextNativeBindingSequence,
            entryLifetime:
                this.bindings.variableScopes.length === 1 &&
                this.activeEmissionScope === 0 &&
                !this.engineLifecycle.engineStartMark,
        };
        this.nativeBindings.set(name, binding);
        if (
            this.engineLifecycle.engineStartMark &&
            this.indentLevel ===
                this.engineLifecycle.engineStartMark.indentLevel
        ) {
            this.engineLifecycle.continuationLocals.set(
                name,
                this.engineLifecycle.continuationSequence,
            );
        }
        return binding;
    }

    /** A capture's native type, constant when its local is declared so. */
    private nativeBindingCaptureType(name: string): string | undefined {
        const binding = this.nativeBindingTypes.get(name);
        return binding?.type !== undefined && binding.constant
            ? `const ${binding.type}`
            : binding?.type;
    }

    public registerNativeBindingType(name: string, cppType: string): void {
        if (!cppIdentifierPattern.test(name)) return;
        const previous = this.nativeBindingTypes.get(name);
        if (previous?.type !== undefined) return;
        this.nativeBindingTypes.set(name, {
            type: cppType.replace(/^const /, ""),
            constant: previous?.constant ?? cppType.startsWith("const "),
            owned: previous?.owned ?? false,
        });
    }

    public nativeBindingCheckpoint(): number {
        return this.nextNativeBindingSequence;
    }

    public registerNativeTemporary(name: string, type?: DataType): void {
        // Views borrow; generic handles can retain companion expressions.
        // Scalars need neither transfer nor additional JS runtime support.
        if (
            type?.kind === "span" ||
            type?.kind === "table" ||
            type?.kind === "handle" ||
            type?.kind === "number" ||
            type?.kind === "boolean" ||
            type?.kind === "enum"
        )
            return;
        this.nativeTemporaries.add(this.registerNativeBinding(name));
    }

    public registerNativeConstBinding(
        name: string,
        allowReference = false,
        cppType?: string,
    ): NativeCaptureBinding {
        const binding = this.registerNativeBinding(
            name,
            false,
            allowReference,
            cppType,
        );
        this.nativeConstBindings.add(binding);
        return binding;
    }

    /** Whether `cpp` names a native binding the compile tracks. */
    public hasNativeBinding(cpp: string): boolean {
        return this.nativeBindings.has(cpp);
    }

    public nativeLocalSince(cpp: string, boundary: number): boolean {
        const binding = this.nativeBindings.get(cpp);
        return binding !== undefined && binding.sequence > boundary;
    }

    public takeNativeTemporary(cpp: string, boundary: number): string {
        const binding = this.nativeBindings.get(cpp);
        if (
            !binding ||
            !this.nativeLocalSince(cpp, boundary) ||
            !this.nativeTemporaries.has(binding)
        )
            return cpp;
        // Only a temporary created by this initializer is exclusive: a cached
        // property or an existing source binding must retain its own value.
        this.reachJsData();
        return `bbl::js::take_temporary(${cpp})`;
    }

    public captureHoistedLines(
        emitBody: () => void,
        beforeBody: number,
        site: ts.Node,
    ): string[] {
        const beforeGuard = this.nextNativeBindingSequence;
        const dependencies = new EmissionSet<NativeCaptureBinding>();
        this.nativeDependencyStack.push(dependencies);
        // Keep source generation scope unchanged, but throw from this cleanup
        // belongs to a synchronous closure, not the protected coroutine.
        this.synchronousCleanupFrames.push(this.returnFrames.at(-1));
        let lines: string[];
        try {
            lines = this.captureEmittedLines(emitBody);
        } finally {
            this.synchronousCleanupFrames.pop();
            this.popDependencies(this.nativeDependencyStack);
        }
        // A native local of the try body, read directly or held by a
        // binding the guard reads (`saved = { box }`), has left scope when
        // the guard runs.
        const reached = [...dependencies].flatMap((binding) => [
            binding,
            ...(this.heldNativeBindings.get(binding) ?? []),
        ]);
        for (const binding of reached) {
            if (
                binding.sequence > beforeBody &&
                binding.sequence <= beforeGuard
            ) {
                this.fail(
                    site,
                    `A hoisted finally guard cannot reference native local '${binding.name}' ` +
                        "declared inside its try/catch body; declare retained native state before the try.",
                );
            }
        }
        return lines;
    }

    private describeEngineCaptures(value: Value): void {
        if (!value.engineCpp) return;
        if (value.kind === "engine") {
            if (value.engineIdentity)
                this.realmEngineIdentities.set(
                    value.engineCpp,
                    value.engineIdentity,
                );
            else this.realmEngineIdentities.delete(value.engineCpp);
            const storage =
                value.storedEngineCpp ??
                (value.ownedEngineCpp
                    ? `bbl::StoredEngine{${value.ownedEngineCpp}}`
                    : undefined);
            if (storage) this.realmEngineStorage.set(value.engineCpp, storage);
            const owned =
                value.ownedEngineCpp &&
                this.nativeBindings.get(value.ownedEngineCpp);
            if (owned) this.realmEngineCaptures.set(value.engineCpp, [owned]);
            if (value.storedEngineCpp) {
                const stored = this.nativeBindings.get(value.storedEngineCpp);
                const captures = stored
                    ? [stored]
                    : (value.nativeCompanionCaptures?.storedEngineCpp ??
                      value.nativeCaptures);
                if (captures?.length)
                    this.realmEngineCaptures.set(value.engineCpp, captures);
            }
        }
        if (
            value.engineOwnerIdentity &&
            (this.hasStableNativeBinding(value) ||
                (value.nativeOwnedRvalue &&
                    value.dataType?.kind === "handle" &&
                    value.dataType.ownedEngine))
        )
            this.realmEngineIdentities.set(
                value.engineCpp,
                value.engineOwnerIdentity,
            );
        const owners = this.realmEngineCaptures.get(value.engineCpp);
        if (owners)
            writable(value).nativeCompanionCaptures = {
                ...value.nativeCompanionCaptures,
                engineCpp: owners,
            };
    }

    public describeNativeValue(value: Value): void {
        this.describeEngineCaptures(value);
        this.nativeStoredValues.add(value);
        const counter = integerCounterOf(value);
        const storage =
            value.sharedStorageCpp ??
            (value.optionalStorageCpp &&
            cppIdentifierPattern.test(value.optionalStorageCpp)
                ? value.optionalStorageCpp
                : undefined) ??
            value.resourceStorageCpp ??
            counter ??
            (cppIdentifierPattern.test(value.cpp)
                ? value.cpp
                : (value.absenceTagStorageCpp ??
                  value.optionalStorageCpp ??
                  value.cpp));
        if (
            (isCompileTimeOnlyValue(value.kind) &&
                !isNativeOwnerRecord(value)) ||
            value.kind === "browser" ||
            !cppIdentifierPattern.test(storage) ||
            ["true", "false", "nullptr"].includes(storage)
        )
            return;
        // A texture held in typed storage (a shared call's result) keeps its
        // producer's storage fact, but its C++ is the storage's type.
        const producerTexture =
            value.kind === "texture" && value.dataType?.kind !== "handle";
        const cppType =
            counter !== undefined && storage === counter
                ? "std::int64_t"
                : value.kind === "engine"
                  ? value.ownedEngineCpp
                      ? "std::shared_ptr<bbl::Engine>"
                      : "bbl::Engine"
                  : producerTexture && value.textureStorage === "solid"
                    ? "bbl::SolidTexture"
                    : producerTexture && value.textureStorage === "file"
                      ? "bbl::FileTexture"
                      : producerTexture && value.textureStorage === "pixels"
                        ? "bbl::PixelsTexture"
                        : // The tagged slot's type is the slot's own: a local
                          // holding the value read through it holds that value.
                          value.absenceTagType &&
                            storage === value.absenceTagStorageCpp
                          ? this.dataTypes.cppType(value.absenceTagType)
                          : value.dataType
                            ? this.dataTypes.cppType(value.dataType)
                            : isHandleKind(value.kind)
                              ? handleCppType(value.kind)
                              : value.kind === "number"
                                ? "double"
                                : value.kind === "boolean"
                                  ? "bool"
                                  : value.kind === "string"
                                    ? "std::string"
                                    : undefined;
        if (cppType)
            this.registerNativeBindingType(
                storage,
                value.sharedStorageCpp
                    ? `std::shared_ptr<${cppType}>`
                    : cppType,
            );
        writable(value).nativeCaptures = [
            this.registerNativeBinding(
                storage,
                value.kind === "engine" && !value.ownedEngineCpp,
                value.sharedStorageCpp === undefined,
            ),
        ];
        if (
            value.dataType &&
            this.dataTypes.carriesOpaqueIterator(value.dataType)
        )
            this.iteratorStorageBindings.add(value.nativeCaptures![0]!);
        for (const key of nativeCompanionKeys) {
            const companion = value[key];
            if (
                companion &&
                cppIdentifierPattern.test(companion) &&
                !["true", "false", "nullptr"].includes(companion)
            ) {
                this.registerNativeBinding(companion, key === "engineCpp");
            }
        }
    }

    /**
     * An immutable source binding's native storage and captures are const:
     * a binding that aliases storage keeps it from being reseated, as a
     * class instance's binding aliases its fields. A tuple or object
     * literal's record aliases nothing -- its captures are the storage its
     * members were read from, which a constant record built from `count`
     * does not make constant.
     */
    public markImmutableNativeStorage(value: Value, immutable: boolean): void {
        const binding = this.nativeBindings.get(
            value.resourceStorageCpp ?? value.cpp,
        );
        if (
            binding &&
            !value.sharedStorageCpp &&
            !value.borrowedData &&
            !value.runtimeIteration &&
            immutable
        ) {
            this.nativeConstBindings.add(binding);
        }
        const holdsReadValues =
            value.kind === "tuple" ||
            (value.kind === "record" && this.classOf(value) === undefined);
        if (immutable && !value.sharedStorageCpp && !holdsReadValues) {
            for (const capture of value.nativeCaptures ?? [])
                this.nativeConstBindings.add(capture);
            for (const captures of Object.values(
                value.nativeCompanionCaptures ?? {},
            )) {
                for (const capture of captures ?? [])
                    this.nativeConstBindings.add(capture);
            }
        }
        if (value.engineOwnerIdentity) this.describeEngineCaptures(value);
    }

    /**
     * Close the innermost dependency frame: its enclosing frame gains the
     * bindings it read, in first-read order. A frame is read only once it is
     * innermost again, so handing reads up when a frame closes is the same
     * as adding each read to every open frame.
     */
    private popDependencies(stack: Set<NativeCaptureBinding>[]): void {
        const closed = stack.pop()!;
        const enclosing = stack.at(-1);
        if (enclosing) for (const binding of closed) enclosing.add(binding);
    }

    public useNativeBinding(binding: NativeCaptureBinding): void {
        // Stored Values keep their own home rather than initializer dependencies.
        // Propagate reads here so a parent expression still sees those reads when
        // its child returns an existing stored Value.
        this.nativeDependencyStack.at(-1)?.add(binding);
        for (const capture of this.managedCaptures) capture.use(binding);
        this.statementDependencies.at(-1)?.add(binding);
        if (this.engineLifecycle.engineStartMark) {
            let sequences = this.engineLifecycle.continuationUses.get(
                binding.name,
            );
            if (!sequences) {
                sequences = new EmissionSet();
                this.engineLifecycle.continuationUses.set(
                    binding.name,
                    sequences,
                );
            }
            sequences.add(this.engineLifecycle.continuationSequence);
        }
    }

    private readonly nativeValueCaptures = new NativeCaptureCache(
        this.nativeBindings,
    );

    public useNativeValue(value: Value): void {
        if (value.requiresApplicationRealm && !this.options.workers)
            throw new ApplicationRealmRequired();
        for (const binding of this.nativeValueCaptures.bindingsOf(value))
            this.useNativeBinding(binding);
    }

    public captureNativeExpression(
        compile: () => string,
    ): import("./compiler/closure-captures.js").NativeExpression {
        const { value: cpp, nativeCaptures } =
            this.captureNativeDependencies(compile);
        return { cpp, nativeCaptures };
    }

    public captureNativeDependencies<T>(compile: () => T): {
        value: T;
        nativeCaptures: readonly NativeCaptureBinding[];
    } {
        const dependencies = new EmissionSet<NativeCaptureBinding>();
        this.nativeDependencyStack.push(dependencies);
        try {
            return { value: compile(), nativeCaptures: [...dependencies] };
        } finally {
            this.popDependencies(this.nativeDependencyStack);
        }
    }

    public captureManagedClosureLines(
        emitBody: () => void,
        byReference: ClosureBorrowing = false,
    ): CapturedClosure {
        return this.captureClosureLines(emitBody, byReference, false);
    }

    /**
     * `captureManagedClosureLines`, for the entry's own body too
     * (`entryBody`), which outlives its scope but runs where it is created.
     */
    private captureClosureLines(
        emitBody: () => void,
        byReference: ClosureBorrowing,
        entryBody: boolean,
    ): CapturedClosure {
        const capture = new ClosureCaptures(
            this.allocateTemporaryCppName("environment"),
            this.nextNativeBindingSequence,
            byReference,
            (binding) => this.nativeBindingCaptureType(binding.name),
        );
        const allocationBoundary = this.temporaryIndex;
        this.managedCaptures.push(capture);
        const deferred =
            this.frameCallbackDepth > 0 &&
            !this.deferredResourceCaptureDepths.has(this.frameCallbackDepth)
                ? this.checkpointResourceConstruction()
                : undefined;
        if (deferred)
            this.deferredResourceCaptureDepths.add(deferred.callbackDepth);
        let lines: string[];
        // An environment borrowed for its scope (`true`, `"call"`) runs
        // inside it; any other closure outlives the loops around its creation.
        const outlivesScope = byReference !== true && byReference !== "call";
        const runsLater = outlivesScope && !entryBody;
        if (outlivesScope) this.statements.enterCallbackBody();
        if (runsLater) this.laterBodies.push(this.loweringStatements.length);
        try {
            lines = this.captureEmittedLines(emitBody, { functionBody: true });
        } finally {
            if (runsLater) this.laterBodies.pop();
            if (outlivesScope) this.statements.leaveCallbackBody();
            if (deferred) {
                this.deferredResourceCaptureDepths.delete(
                    deferred.callbackDepth,
                );
                this.resourceConstructionCheckpoints.delete(deferred);
                this.excludeDeferredResourceConstruction(deferred);
            }
            this.managedCaptures.pop();
        }
        const identifiers = cppIdentifiers(lines.join("\n"));
        capture.retainReferenced(identifiers);
        if (
            byReference !== "call" &&
            capture.nativeCaptures.some((binding) =>
                this.iteratorStorageBindings.has(binding),
            )
        )
            this.fail(
                this.loweringStatements.at(-1)?.statement ?? this.sourceFile,
                "Retained closures cannot capture opaque iterator storage until suspended frame cycles have traced ownership.",
            );
        const localBindings = [...identifiers].filter(
            (name) =>
                (this.nativeBindings.get(name)?.sequence ?? 0) >
                    capture.boundary ||
                (this.allocatedCppNames.get(name) ?? 0) > allocationBoundary,
        );
        const environmentType = capture.environmentType;
        const struct = capture.environmentStruct;
        if (!this.nativeEmission.environmentStructs.has(struct.name)) {
            this.nativeEmission.environmentStructs.add(struct.name);
            this.nativeEmission.registerNativeTemplate(
                struct.name,
                [...struct.lines],
                struct.declaration,
            );
        }
        return {
            lines: [...capture.declarations, ...lines],
            environment: capture.environment,
            initializer: capture.initializer,
            ...(environmentType ? { environmentType } : {}),
            nativeCaptures: capture.nativeCaptures,
            localBindings: [
                capture.environment,
                ...capture.nativeCaptures.map((binding) => binding.name),
                ...localBindings,
            ],
        };
    }

    private trackRetainedCaptureName(name: string): void {
        const binding = this.nativeBindings.get(name);
        if (binding) this.useNativeBinding(binding);
        // A spelling read through storage (an owned field's engine) names
        // the bindings it reads; each is captured where the spelling is used.
        else
            for (const identifier of cppIdentifiers(name, {
                unqualified: true,
            })) {
                const read = this.nativeBindings.get(identifier);
                if (read) this.useNativeBinding(read);
            }
        for (const owner of this.realmEngineCaptures.get(name) ?? [])
            this.useNativeBinding(owner);
    }

    public emitUnderJumpOwners<T>(
        holders: readonly ts.Node[],
        emitBody: () => T,
    ): T {
        return this.statements.emitUnderJumpOwners(this, holders, emitBody);
    }

    public emitInlinedBody<T>(
        declaration: ts.SignatureDeclaration,
        returns: "break" | "label" | undefined,
        emitBody: () => T,
    ): T {
        this.returnFrames.push({
            kind: "inline",
            engineScopeDepth: this.bindings.variableScopes.length,
        });
        try {
            return returns
                ? this.statements.emitInlinedBody(
                      this,
                      declaration,
                      returns,
                      emitBody,
                  )
                : emitBody();
        } finally {
            this.validateResourceLoopReturn(this.returnFrames.pop());
        }
    }

    private checkpointResourceConstruction(): ResourceConstructionCheckpoint {
        const checkpoint = {
            state: this.sceneManifest.constructionState(),
            callbackDepth: this.frameCallbackDepth,
        };
        this.resourceConstructionCheckpoints.add(checkpoint);
        return checkpoint;
    }

    /** Compiling a retained callback does not execute its construction in the enclosing loop. */
    private excludeDeferredResourceConstruction(
        before: ResourceConstructionCheckpoint,
    ): void {
        const after = this.sceneManifest.constructionState();
        const removed = new EmissionSet(
            before.state.lightIdentities.filter(
                (value) => !after.lightIdentities.includes(value),
            ),
        );
        const added = after.lightIdentities.filter(
            (value) => !before.state.lightIdentities.includes(value),
        );
        for (const checkpoint of this.resourceConstructionCheckpoints) {
            if (checkpoint.callbackDepth >= before.callbackDepth) continue;
            const state = writable(checkpoint.state);
            const counters = writable(state.counters);
            for (const [index, baseline] of counters.entries()) {
                counters[index] =
                    baseline +
                    after.counters[index]! -
                    before.state.counters[index]!;
            }
            state.gltfContainers +=
                after.gltfContainers - before.state.gltfContainers;
            state.lightIdentities = [
                ...state.lightIdentities.filter((value) => !removed.has(value)),
                ...added,
            ];
        }
    }

    public trackResourceLoopEarlyReturn(condition: ts.Expression): void {
        const frame = this.returnFrames.at(-1);
        if (frame && !this.resourceLoopReturns.has(frame)) {
            this.resourceLoopReturns.set(frame, {
                condition,
                checkpoint: this.checkpointResourceConstruction(),
            });
        }
    }

    private validateResourceLoopReturn(frame: object | undefined): void {
        const guard = frame && this.resourceLoopReturns.get(frame);
        if (!guard) return;
        this.resourceConstructionCheckpoints.delete(guard.checkpoint);
        const state = this.sceneManifest.constructionState();
        if (!resourceConstructionStatesEqual(state, guard.checkpoint.state)) {
            // A profiled glTF container announces its rows by document, so a
            // load the runtime return skips moves no other construction's ordinal.
            if (
                resourceConstructionStatesEqual(
                    state,
                    guard.checkpoint.state,
                    false,
                )
            ) {
                this.sceneManifest.recordProfiledGltfLoads();
                return;
            }
            this.fail(
                guard.condition,
                "A resource-construction helper's early return requires a " +
                    "generation-known condition inside a static loop.",
            );
        }
    }

    public activeNativeReturnType(): DataType | "void" | undefined {
        const top = this.returnFrames.at(-1);
        return top?.kind === "native" ? top.type : undefined;
    }

    public activeNativeCoroutine(): boolean {
        const top = this.returnFrames.at(-1);
        return top?.kind === "native" && top.coroutine === true;
    }

    /** Whether the innermost native body discards a returned value (a contextually void callback). */
    public activeNativeReturnDiscarded(): boolean {
        const top = this.returnFrames.at(-1);
        return (
            top?.kind === "native" &&
            top.type === "void" &&
            top.contextualVoid === true
        );
    }

    /** Whether an expression's type is a Promise (every present member). */
    private isPromiseTyped(expression: ts.Expression): boolean {
        const members = presentMembers(
            this.checker.getTypeAtLocation(expression),
        );
        return (
            members.length > 0 &&
            members.every((member) => libraryName(member) === "Promise")
        );
    }

    /**
     * A native body that runs off its end completes as `return;` does:
     * undefined for a void or optional result, the end of a generator. A
     * result without undefined cannot get there (TypeScript proves it; an
     * exhaustive switch lowered to an if/else chain keeps a defined guard).
     */
    public emitFallOffEnd(): void {
        const frame = this.returnFrames.at(-1);
        if (frame?.kind !== "native")
            throw new Error("A body end outside a native function body.");
        const returnType = frame.type;
        if (frame.generator || (frame.coroutine && returnType === "void")) {
            this.emit({
                kind: "control",
                code: frame.generator
                    ? "co_return;"
                    : "co_return bbl::js::PromiseVoid{};",
                transfer: "suspend",
            });
            return;
        }
        if (returnType === "void") return;
        this.emit(
            returnType.kind === "optional"
                ? {
                      kind: "control",
                      code: `${frame.coroutine ? "co_return" : "return"} std::nullopt;`,
                      transfer: frame.coroutine ? "suspend" : "return",
                  }
                : {
                      kind: "control",
                      code: 'throw std::runtime_error("Native value function fell through without returning.");',
                      transfer: "throw",
                  },
        );
    }

    public emitNativeReturn(statement: ts.ReturnStatement): void {
        const frame = this.returnFrames.at(-1);
        if (frame?.kind === "native" && frame.generator) {
            if (statement.expression)
                this.fail(
                    statement,
                    "Generator return values require a typed completion channel.",
                );
            this.emit({
                kind: "control",
                code:
                    this.synchronousCleanupFrames.includes(frame) ||
                    this.statements.needsReturnCompletion(statement)
                        ? "throw bbl::js::GeneratorClose{};"
                        : "co_return;",
                transfer: "suspend",
            });
            return;
        }
        const coroutine = frame?.kind === "native" && frame.coroutine;
        const returnKeyword = coroutine ? "co_return" : "return";
        const returnType = this.activeNativeReturnType();
        if (returnType === undefined) {
            this.fail(statement, "Return outside a native function.");
        }
        const completesCleanup =
            !coroutine && this.statements.needsReturnCompletion(statement);
        const emitReturned = (cpp?: string): void => {
            this.emit({
                kind: "control",
                code: completesCleanup
                    ? returnType === "void"
                        ? "throw bbl::js::ReturnCompletion<void>{};"
                        : `throw bbl::js::ReturnCompletion<${this.dataTypes.cppType(returnType)}>(${cpp});`
                    : `${returnKeyword}${cpp === undefined ? "" : ` ${cpp}`};`,
                transfer: completesCleanup
                    ? "throw"
                    : coroutine
                      ? "suspend"
                      : "return",
            });
        };
        if (returnType !== "void" && statement.expression)
            this.asyncActivations.refuseThenableReturn(statement.expression);
        if (coroutine && statement.expression) {
            const emitResult = (expression: ts.Expression): void => {
                const selected = this.unwrap(expression);
                // A promise on one branch only: each branch is its own
                // return, the promise one adopting its settlement.
                if (
                    ts.isConditionalExpression(selected) &&
                    this.isPromiseTyped(selected.whenTrue) !==
                        this.isPromiseTyped(selected.whenFalse)
                ) {
                    const condition = this.conditions.compileCondition(
                        selected.condition,
                    );
                    this.emit({ kind: "open", code: `if (${condition}) {` });
                    this.increaseIndent();
                    this.enterRuntimeControlFlow();
                    try {
                        emitResult(selected.whenTrue);
                        this.decreaseIndent();
                        this.emit({ kind: "branch", code: "} else {" });
                        this.increaseIndent();
                        emitResult(selected.whenFalse);
                    } finally {
                        this.leaveRuntimeControlFlow();
                    }
                    this.decreaseIndent();
                    this.emit({ kind: "close", code: "}" });
                    return;
                }
                const result =
                    returnType !== "void" && frame.compileReturn
                        ? frame.compileReturn(expression, returnType)
                        : this.asyncActivations.compileAsyncReturn(
                              expression,
                              returnType === "void" ? undefined : returnType,
                          );
                this.emit({
                    kind: "control",
                    code: this.statements.needsReturnCompletion(statement)
                        ? `throw bbl::js::AsyncReturn<${returnType === "void" ? "bbl::js::PromiseVoid" : this.dataTypes.cppType(returnType)}>(${result});`
                        : `co_return ${result};`,
                    transfer: "suspend",
                });
            };
            emitResult(statement.expression);
            return;
        }
        if (returnType === "void") {
            if (statement.expression) {
                if (
                    (frame?.kind !== "native" || !frame.contextualVoid) &&
                    !isVoid(
                        this.dataTypes.resolveTypeParameter(
                            this.checker.getTypeAtLocation(
                                statement.expression,
                            ),
                        ),
                    )
                ) {
                    this.fail(
                        statement.expression,
                        "Void functions cannot return a value.",
                    );
                }
                // TypeScript's contextual-void callback rule discards the
                // expression's value but not its side effects. Preserve the
                // same boundary for `return stopEngine(engine)` and for
                // value-returning expressions accepted by a void callback.
                // A `void` expression has no value to discard: `return
                // work()` in a body whose result type is `void` here, a type
                // parameter's argument included.
                this.asyncActivations.emitDiscardedReturn(statement.expression);
            }
            if (coroutine)
                this.emit(
                    this.statements.needsReturnCompletion(statement)
                        ? "throw bbl::js::AsyncReturn<bbl::js::PromiseVoid>(bbl::js::PromiseVoid{});"
                        : "co_return bbl::js::PromiseVoid{};",
                );
            else emitReturned();
            return;
        }
        if (!statement.expression) {
            if (returnType.kind === "optional") {
                if (
                    coroutine &&
                    this.statements.needsReturnCompletion(statement)
                )
                    this.emit(
                        `throw bbl::js::AsyncReturn<${this.dataTypes.cppType(returnType)}>(std::nullopt);`,
                    );
                else emitReturned("std::nullopt");
                return;
            }
            this.fail(
                statement,
                "Non-void native functions must return a value.",
            );
        }
        if (frame?.kind === "native" && frame.compileReturn) {
            emitReturned(frame.compileReturn(statement.expression, returnType));
            return;
        }
        if (returnType.kind === "number") {
            emitReturned(this.compileNumber(statement.expression, "double"));
            return;
        }
        if (returnType.kind === "boolean") {
            emitReturned(
                this.conditions.compileCondition(statement.expression),
            );
            return;
        }
        if (this.dataTypes.carriesBorrowedPlatformEvent(returnType)) {
            const value = this.compileValue(statement.expression);
            this.refuseBorrowedPlatformEventEscape(
                value,
                statement.expression,
                "a function return",
            );
        }
        const returned = this.dataLowerer.compileForSink(
            statement.expression,
            returnType,
        );
        emitReturned(
            !completesCleanup && this.movesReturnedLocal(statement, returned)
                ? `std::move(${returned})`
                : returned,
        );
    }

    public emitNativeYield(expression: ts.YieldExpression): void {
        const frame = this.returnFrames.at(-1);
        if (frame?.kind !== "native" || !frame.generator)
            this.fail(expression, "Yield requires an active generator body.");
        for (
            let owner: ts.Node = expression.parent;
            !ts.isFunctionLike(owner);
            owner = owner.parent
        ) {
            if (
                ts.isBlock(owner) &&
                ts.isTryStatement(owner.parent) &&
                owner.parent.finallyBlock === owner
            )
                this.fail(
                    expression,
                    "Yield in finally requires a resumable cleanup protocol.",
                );
        }
        if (expression.asteriskToken) {
            this.emitDelegatedYield(expression, frame.generator);
            return;
        }
        const element = frame.generator.element;
        // `yield;` yields undefined, which the pull channel must tell from
        // completion: an empty reference or function would read as done.
        if (
            !expression.expression &&
            element.kind !== "undefined" &&
            (element.kind !== "optional" ||
                element.inner.kind === "struct" ||
                element.inner.kind === "function")
        )
            this.fail(
                expression,
                "A generator's empty yields produce undefined, which its element storage holds only as an optional value apart from completion.",
            );
        const value = !expression.expression
            ? this.dataLowerer.compileKnownValueForSink(
                  undefinedValue(),
                  element,
                  expression,
              )
            : frame.generator.asynchronous
              ? this.asyncActivations.compileAsyncReturn(
                    expression.expression,
                    element,
                )
              : this.dataLowerer.compileForSink(expression.expression, element);
        this.emit({
            kind: "control",
            code: `co_yield ${frame.generator.asynchronous ? `co_await bbl::js::generator_yield_value<${this.dataTypes.cppType(element)}>(${value})` : value};`,
            transfer: "suspend",
        });
    }

    /**
     * `yield* delegate` in a synchronous generator: each value the delegate
     * produces is yielded in turn, and closing the generator while it is
     * suspended there closes the delegate. `next` takes no inbound value and
     * `throw` is not represented, so forwarding `next` and `return` is the
     * whole protocol; the delegate's completion value is `undefined`.
     */
    private emitDelegatedYield(
        expression: ts.YieldExpression,
        generator: DataType<"iterator">,
    ): void {
        if (generator.asynchronous || !expression.expression)
            this.fail(
                expression,
                "yield* delegates to a synchronous iterable from a synchronous generator.",
            );
        const delegateType = this.dataLowerer.dataTypeAt(expression.expression);
        const yieldElement = (cpp: string, type: DataType): void =>
            this.emit({
                kind: "control",
                code: `co_yield ${this.dataLowerer.compileKnownValueForSink(this.dataLowerer.leafValue(cpp, type), generator.element, expression)};`,
                transfer: "suspend",
            });
        if (delegateType?.kind === "iterator" && !delegateType.asynchronous) {
            const delegate = this.dataLowerer.compileForSink(
                expression.expression,
                delegateType,
            );
            this.statements.emitIteratorWalk(
                this,
                expression,
                this.dataLowerer.leafValue(delegate, delegateType),
                delegateType,
                (element) => yieldElement(element, delegateType.element),
            );
            return;
        }
        if (delegateType?.kind === "vector" || delegateType?.kind === "span") {
            // The array iterator reads the length and the element at each
            // step, so the array may change while the generator waits.
            const source = this.allocateTemporaryCppName("delegated_array");
            const index = this.allocateTemporaryCppName("delegated_index");
            this.emit({ kind: "open", code: "{" });
            this.increaseIndent();
            this.emit(
                `const auto ${source} = ${this.dataLowerer.compileForSink(expression.expression, delegateType)};`,
            );
            this.emit({
                kind: "open",
                code: `for (std::size_t ${index} = 0; ${index} < ${source}.size(); ++${index}) {`,
                iteration: true,
            });
            this.increaseIndent();
            yieldElement(`${source}[${index}]`, delegateType.element);
            this.decreaseIndent();
            this.emit({ kind: "close", code: "}" });
            this.decreaseIndent();
            this.emit({ kind: "close", code: "}" });
            return;
        }
        this.fail(
            expression.expression,
            "yield* delegates to a generator, an iterator or an array.",
        );
    }

    public activeGeneratorType(): DataType<"iterator"> | undefined {
        const frame = this.returnFrames.at(-1);
        return frame?.kind === "native" ? frame.generator : undefined;
    }

    /**
     * Whether a return hands back the present value of an optional local its
     * own frame declared by value: nothing reads the local after the return,
     * so its value moves out rather than copying. C++ moves a returned local
     * only when the return names it bare. A `finally` around the return still
     * runs afterwards and may read it, and a cell's value is shared, so
     * neither moves.
     */
    private movesReturnedLocal(
        statement: ts.ReturnStatement,
        returned: string,
    ): boolean {
        const expression =
            statement.expression && this.unwrap(statement.expression);
        if (!expression || !ts.isIdentifier(expression)) return false;
        const local = this.bindings.lookupOptional(expression);
        // The local's optional storage: a nullable data local itself, or the
        // storage behind an optional resource whose value `cpp` reads.
        const nullable = local?.dataType;
        const storage =
            local?.optionalStorageCpp ??
            (nullable?.kind === "optional" &&
            !(
                nullable.inner.kind === "struct" &&
                this.dataTypes.isReferenceStruct(nullable.inner.name)
            )
                ? local?.cpp
                : undefined);
        const declaration = this.symbols
            .valueSymbol(expression)
            ?.declarations?.find(ts.isVariableDeclaration);
        const owner = ts.findAncestor(statement.parent, ts.isFunctionLike);
        if (
            !local ||
            storage === undefined ||
            local.sharedStorageCpp !== undefined ||
            !this.nativeBindingTypes.get(storage)?.owned ||
            // The sink handed back the local's own present value, not a
            // copy or conversion of it.
            returned !== optionalValueCpp(storage) ||
            !owner ||
            !declaration ||
            ts.findAncestor(declaration.parent, ts.isFunctionLike) !== owner
        )
            return false;
        for (
            let current: ts.Node = statement;
            current !== owner;
            current = current.parent
        ) {
            if (
                ts.isTryStatement(current.parent) &&
                current.parent.finallyBlock
            )
                return false;
        }
        return true;
    }

    public emitNativeThrow(
        errorCpp: string,
        node?: ts.ThrowStatement,
        rethrow = false,
    ): void {
        const frame = this.returnFrames.at(-1);
        const type = this.synchronousCleanupFrames.includes(frame)
            ? undefined
            : frame?.kind === "native" && frame.coroutine
              ? frame.type === "void"
                  ? "bbl::js::PromiseVoid"
                  : this.dataTypes.cppType(frame.type)
              : this.asyncLowerer.terminalThrowType(node);
        const statement = rethrow
            ? `std::rethrow_exception(${errorCpp});`
            : `throw ${errorCpp};`;
        if (type) {
            this.emit({
                kind: "control",
                code: `co_return [&]() -> ${type} { ${statement} }();`,
                transfer: "suspend",
            });
        } else
            this.emit({ kind: "control", code: statement, transfer: "throw" });
    }

    public emitDataPostfix(expression: ts.PostfixUnaryExpression): boolean {
        if (this.compileCameraMutation(expression)) return true;
        return this.dataLowerer.emitPostfixUnary(expression);
    }

    private compileCameraMutation(
        expression: ts.Expression,
    ): Value | undefined {
        const node = this.unwrap(expression);
        const unary =
            ts.isPrefixUnaryExpression(node) ||
            ts.isPostfixUnaryExpression(node);
        if (unary ? !isUpdateExpression(node) : !isAssignmentExpression(node))
            return undefined;
        const left = this.unwrap(
            unary ? node.operand : (node as ts.BinaryExpression).left,
        );
        const operator = unary
            ? node.operator === ts.SyntaxKind.PlusPlusToken
                ? "+"
                : node.operator === ts.SyntaxKind.MinusMinusToken
                  ? "-"
                  : undefined
            : ts.isBinaryExpression(node)
              ? CAMERA_MUTATION_OPERATORS.get(node.operatorToken.kind)
              : undefined;
        if (
            (!operator || ts.isElementAccessExpression(left)) &&
            (ts.isPropertyAccessExpression(left) ||
                ts.isElementAccessExpression(left))
        ) {
            if (this.mayOwnCameraState(left.expression)) {
                this.admissions.noteUntrackedCameraWrite({
                    node: left,
                    reason: "this camera mutation syntax does not invoke its pinned setter",
                });
            }
        }
        if (!operator || (!unary && !ts.isBinaryExpression(node)))
            return undefined;
        if (
            ts.isPropertyAccessExpression(left) &&
            ["target", "position", "upVector", "parent"].includes(
                left.name.text,
            ) &&
            isCameraExpression(this, left.expression)
        ) {
            this.admissions.noteUntrackedCameraWrite({
                node: left,
                reason: `replacing camera.${left.name.text} changes its observable owner`,
            });
        }
        const target = cameraNumberWrite(this, left);
        if (!target) return undefined;
        this.admissions.noteTextCameraMutation(left);
        noteCameraRecordWrite(
            this,
            target.camera,
            target.property,
            unary ? undefined : node.right,
            operator === "=" &&
                !["target", "position", "up_vector"].includes(target.property),
        );
        if (target.property === "position" || target.property === "up_vector") {
            this.admissions.noteUntrackedCameraWrite({
                node: left,
                reason: `camera.${target.property} is not the arc camera's observable target`,
                ...(target.camera.cameraKind === "free"
                    ? { cameraVersionSafe: true as const }
                    : {}),
            });
        }
        let previous: string | undefined;
        if (operator !== "=") {
            previous = this.allocateTemporaryCppName("camera_previous");
            this.emit({
                kind: "declaration",
                type: "const double",
                name: previous,
                initializer: target.current,
            });
        }
        const right = unary ? "1.0" : this.compileNumber(node.right, "double");
        const value = this.allocateTemporaryCppName("camera_value");
        this.emit({
            kind: "declaration",
            type: "const double",
            name: value,
            initializer:
                operator === "=" ? right : `(${previous} ${operator} ${right})`,
        });
        this.emit(target.write(value));
        return {
            kind: "number",
            cpp: unary && ts.isPostfixUnaryExpression(node) ? previous! : value,
            dataType: { kind: "number" },
        };
    }

    /**
     * A nullable local's storage from a maybe-absent handle. A nullable
     * handle property is represented by the invalid native handle, while
     * local nullable storage is std::optional; that optional must not be
     * engaged with the sentinel, or the next guarded read would index a
     * collection with invalid_handle. The producer's presence test, when it
     * has one, decides between the value and an empty optional, for the
     * declaration and the assignment alike.
     */
    public optionalResourceCpp(value: Value): string {
        const cpp = value.storedEngineCpp ?? value.ownedEngineCpp ?? value.cpp;
        const found = presenceFlagCpp(value);
        return found !== undefined && knownCondition(found) !== true
            ? `(${found} ? std::optional{${cpp}} : std::nullopt)`
            : cpp;
    }

    public assignOptionalResourceValue(
        target: Value,
        value: Value,
        node: ts.Node,
    ): void {
        if (target.kind === "engine") {
            if (target.engineCpp)
                this.realmEngineIdentities.delete(target.engineCpp);
            writable(target).engineIdentity = Symbol();
        }
        const storage =
            target.optionalStorageCpp ??
            this.fail(
                node,
                `Nullable ${target.kind} value has no optional storage.`,
            );
        const ownedType =
            target.dataType?.kind === "handle" && target.dataType.ownedEngine
                ? target.dataType
                : undefined;
        if (ownedType) {
            const type: DataType<"optional"> = {
                kind: "optional",
                inner: ownedType,
            };
            const converted = this.dataLowerer.compileKnownValueForSink(
                value,
                type,
                node,
            );
            this.emit({
                kind: "expression",
                code: `${storage} = ${this.dataTypes.cppType(type)}{${converted}}.to_optional();`,
            });
        } else {
            if (
                value.kind === "data" &&
                value.dataType?.kind === "optional" &&
                value.dataType.inner.kind === "handle" &&
                value.dataType.inner.handle === target.kind
            ) {
                this.emit({
                    kind: "open",
                    code: `if (${optionalPresentCpp(value.cpp)}) {`,
                });
                this.emit({
                    kind: "expression",
                    code: `    ${storage} = *${value.cpp};`,
                });
                this.emit({ kind: "branch", code: "} else {" });
                this.emit({
                    kind: "expression",
                    code: `    ${storage}.reset();`,
                });
                this.emit({ kind: "close", code: "}" });
                return;
            }
            if (value.kind !== target.kind) {
                this.fail(
                    node,
                    `Nullable ${target.kind} assignment received ${value.kind}.`,
                );
            }
            this.emit({
                kind: "expression",
                code: `${storage} = ${this.optionalResourceCpp(value)};`,
            });
        }
        if (
            !ownedType &&
            value.engineCpp !== undefined &&
            target.kind !== "engine"
        ) {
            writable(target).engineCpp = value.engineCpp;
        }
        // A scene's state, and the attachments a render-target texture
        // declared (what its `.texture` read samples), ride the name.
        const carried =
            target.kind === "scene"
                ? ([
                      "sceneEnvironmentState",
                      "sceneTopologyState",
                      "sceneCamera",
                      "surfaceCanvas",
                      "msaaSamples",
                  ] as const)
                : target.kind === "render-target-texture"
                  ? metadataFieldsForKind(target.kind)
                  : [];
        for (const key of carried) {
            const metadata = value[key];
            if (metadata === undefined) delete writable(target)[key];
            else Object.assign(writable(target), { [key]: metadata });
        }
        // A declaration without an initializer is represented by optional
        // native storage, but assigning into that storage must still make the
        // binding an alias of the resource the right-hand side produced. The
        // mesh row is generation-time object identity: later material and
        // shadow writes use it to stamp the exact scene-mesh manifest entry.
        // Losing it here leaves the emitted handle correct while composition
        // silently describes a different mesh.
        if (target.kind === "mesh") {
            if (value.sceneMeshIndex === undefined) {
                delete writable(target).sceneMeshIndex;
            } else {
                writable(target).sceneMeshIndex = value.sceneMeshIndex;
            }
            if (value.runtimeMeshStreams === undefined) {
                delete writable(target).runtimeMeshStreams;
            } else {
                writable(target).runtimeMeshStreams = value.runtimeMeshStreams;
            }
            if (value.directMorphCompatible === undefined) {
                delete writable(target).directMorphCompatible;
            } else {
                writable(target).directMorphCompatible =
                    value.directMorphCompatible;
            }
        }
        // The same alias rule applies when a material itself is first filled
        // through optional storage. These fields are the generation-time
        // identity and composition state paired with its native handle.
        if (target.kind === "material") {
            if (value.scenePbrMaterialIndex === undefined) {
                delete writable(target).scenePbrMaterialIndex;
            } else {
                writable(target).scenePbrMaterialIndex =
                    value.scenePbrMaterialIndex;
            }
            if (value.assetPbrMaterial === undefined) {
                delete writable(target).assetPbrMaterial;
            } else {
                writable(target).assetPbrMaterial = value.assetPbrMaterial;
            }
            if (value.standardMaterial === undefined) {
                delete writable(target).standardMaterial;
            } else {
                writable(target).standardMaterial = value.standardMaterial;
            }
            if (value.standardMaterialPluginIndex === undefined) {
                delete writable(target).standardMaterialPluginIndex;
            } else {
                writable(target).standardMaterialPluginIndex =
                    value.standardMaterialPluginIndex;
            }
            if (value.standardMaterialInput === undefined) {
                delete writable(target).standardMaterialInput;
            } else {
                writable(target).standardMaterialInput =
                    value.standardMaterialInput;
            }
            if (value.nodeMaterialIndex === undefined) {
                delete writable(target).nodeMaterialIndex;
            } else {
                writable(target).nodeMaterialIndex = value.nodeMaterialIndex;
            }
            if (value.sceneShaderVariant === undefined) {
                delete writable(target).sceneShaderVariant;
            } else {
                writable(target).sceneShaderVariant = value.sceneShaderVariant;
            }
        }
        if (value.asset === undefined) delete writable(target).asset;
        else writable(target).asset = value.asset;
        if (value.assetRootState === undefined)
            delete writable(target).assetRootState;
        else writable(target).assetRootState = value.assetRootState;
        if (value.assetRootClone === undefined)
            delete writable(target).assetRootClone;
        else writable(target).assetRootClone = value.assetRootClone;
        if (target.kind === "ui-element") {
            if (value.uiStaticId === undefined)
                delete writable(target).uiStaticId;
            else writable(target).uiStaticId = value.uiStaticId;
            if (value.uiTag === undefined) delete writable(target).uiTag;
            else writable(target).uiTag = value.uiTag;
        }
        if (value.spriteDepthMode === undefined) {
            delete writable(target).spriteDepthMode;
        } else {
            writable(target).spriteDepthMode = value.spriteDepthMode;
        }
        if (value.textureStorage !== undefined) {
            writable(target).textureStorage = value.textureStorage;
            if (value.textureWidth !== undefined) {
                writable(target).textureWidth = value.textureWidth;
            }
            if (value.textureHeight !== undefined) {
                writable(target).textureHeight = value.textureHeight;
            }
        }
    }

    public emitOptionalResourceAssignment(
        expression: ts.BinaryExpression,
        target: Value,
    ): boolean {
        const storage = target.optionalStorageCpp;
        if (!storage) return false;
        const value = this.compileValue(expression.right);
        if (
            (value.kind === "json-null" || value.kind === "void") &&
            !readsErasedVoid(this, value, expression.right)
        ) {
            this.emitDiscardedValue(value);
            this.emit({ kind: "expression", code: `${storage}.reset();` });
            if (target.kind === "engine" && target.engineCpp)
                this.realmEngineIdentities.delete(target.engineCpp);
            delete writable(target).engineIdentity;
            delete writable(target).spriteDepthMode;
            return true;
        }
        this.assignOptionalResourceValue(target, value, expression.right);
        return true;
    }

    public dataIterationTarget(
        expression: ts.Expression,
        knownTuple?: Value,
    ):
        | {
              container: Value;
              element: DataIterationElement;
              template?: Value;
          }
        | undefined {
        return this.dataLowerer.iterationTarget(expression, knownTuple);
    }

    public requiresStaticDataIteration(statement: ts.Node): boolean {
        // Runtime control flow and stored bodies cannot retain one settled
        // DOM subtree for all invocations. Their loops need no static expansion.
        return requiresStaticDataIteration(
            this,
            statement,
            false,
            !this.isInRuntimeControlFlow() &&
                !this.isInFrameCallback() &&
                !this.isInNativeFunctionBody(),
        );
    }

    public canShareFunctionBody(body: ts.Node): boolean {
        return canShareFunctionBody(
            this,
            body,
            this.definiteCollectionMutation(),
        );
    }

    public reachesOpaqueCallee(body: ts.Node): boolean {
        return reachesOpaqueCallee(this, body);
    }

    public reachesOnlyClosedEffects(body: ts.Node): boolean {
        return reachesOnlyClosedEffects(
            this,
            body,
            this.definiteCollectionMutation(),
        );
    }

    /**
     * A body emitted once for every caller runs from any control flow, any
     * number of times: its lowering sees runtime control flow and iteration,
     * and it may not record a generation-owned construction.
     * A call-site reuse probe preserves its original control flow so the proof
     * cannot turn an unconditional construction into a runtime profile.
     */
    public emitReusableNativeBody<T>(
        declaration: ts.Node,
        emitBody: () => T,
        preserveControlFlow = false,
    ): T {
        if (!preserveControlFlow) {
            this.enterRuntimeControlFlow();
            this.enterRuntimeIteration(declaration);
        }
        try {
            const checkpoint = this.checkpointResourceConstruction();
            try {
                const emitted = emitBody();
                if (
                    !resourceConstructionStatesEqual(
                        checkpoint.state,
                        this.sceneManifest.constructionState(),
                    )
                ) {
                    this.fail(
                        declaration,
                        "A shared native body cannot record a generation-owned construction for every caller.",
                    );
                }
                return emitted;
            } finally {
                this.resourceConstructionCheckpoints.delete(checkpoint);
            }
        } finally {
            if (!preserveControlFlow) {
                this.leaveRuntimeIteration();
                this.leaveRuntimeControlFlow();
            }
        }
    }

    public canReplaySharedCallEffects(body: ts.Node): boolean {
        return (
            this.definiteCollectionMutation() &&
            sharedFunctionHasCallEffects(this, body)
        );
    }

    public compileSharedMethod(
        declaration: ts.MethodDeclaration,
        call: ts.CallExpression,
        arguments_: readonly Value[],
    ): Value | undefined {
        return this.userFunctions.compileSharedMethod(
            this,
            declaration,
            call,
            arguments_,
        );
    }

    public emitNativeDataIteration<T>(
        statement: ts.Statement,
        emitBody: () => T,
    ): T {
        const checkpoint = this.checkpointResourceConstruction();
        let emitted: T;
        try {
            emitted = emitBody();
        } finally {
            this.resourceConstructionCheckpoints.delete(checkpoint);
        }
        const after = this.sceneManifest.constructionState();
        if (!resourceConstructionStatesEqual(checkpoint.state, after)) {
            this.fail(
                statement,
                "Runtime resource construction requires a generation-known iteration count " +
                    "and representable specialization; a native data loop cannot record just one construction.",
            );
        }
        return emitted;
    }

    public dataValue(cpp: string, dataType: DataType): Value {
        return this.dataLowerer.leafValue(cpp, dataType);
    }

    public bindDataIterationVariable(
        name: ts.BindingName,
        itemCpp: string,
        element: DataIterationElement,
        template?: Value,
    ): void {
        this.dataLowerer.bindIterationVariable(
            name,
            itemCpp,
            element,
            template,
            (identifier, value) =>
                this.bindings.defineVariable(identifier, value),
        );
    }

    public probePixelsAsset(
        expression: ts.Expression,
    ): { cpp: string; source: string } | undefined {
        return probePixelsAsset(this, expression);
    }

    /**
     * A local call that PRODUCES its textures with a browser canvas.
     *
     * Attempted ahead of ordinary inlining because the body it would inline
     * is a canvas the native runtime does not have; the structural gate in
     * `browser-texture-function.ts` decides, and a call that is not that
     * shape falls straight through to the inliner.
     */
    public compileBrowserTextureFunctionCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        return compileBrowserTextureFunctionCall(this, call, callee);
    }

    public compileExecutedUrlFunctionCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        return compileExecutedUrlFunctionCall(this, call, callee);
    }

    /**
     * A zero-parameter producer that creates a video element runs in
     * Chromium at generation (`executed-video-function.ts`); its body is a
     * media pipeline the native runtime does not have.
     */
    public compileExecutedVideoFunctionCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        return compileExecutedVideoFunctionCall(this, call, callee);
    }

    /**
     * A function returning `loadGltf(engine, new Blob(...))` over closed data
     * runs at generation (`executed-gltf-function.ts`); its call loads the
     * document it built.
     */
    public compileExecutedGltfFunctionCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        return compileExecutedGltfFunctionCall(this, call, callee);
    }

    public registerSpriteAtlasAsset(expression: ts.Expression): string {
        return registerSpriteAtlasAsset(this, expression);
    }

    /**
     * `canvas.width` / `canvas.height` on the render canvas.
     *
     * The canvas itself is browser-only, but its size is not: it is the
     * size the drawing surface was created at, which native names as the
     * engine's own options. Scene code reads it to lay content out in
     * pixels (the pinned sprite grid centres itself in it), so the read
     * has to produce a number rather than being erased with its owner.
     */
    private canvasSizeInfo(
        expression: ts.Expression,
    ): CanvasSizeProperty | undefined {
        const unwrapped = this.unwrap(expression);
        if (!ts.isPropertyAccessExpression(unwrapped)) {
            return undefined;
        }
        const axis = CANVAS_SIZE_AXES.get(unwrapped.name.text);
        if (!axis) {
            return undefined;
        }
        // A scene-created overlay canvas is retained by the UI IR and owns
        // its own backing extent. Only the browser entry canvas maps to the
        // engine drawing surface below.
        const element = this.ui.uiElementValue(unwrapped.expression);
        if (element?.uiCanvas) {
            return element.uiPrimaryCanvas && axis.client ? axis : undefined;
        }
        return this.isCanvasElement(unwrapped.expression) ? axis : undefined;
    }

    public canvasSizeProperty(
        expression: ts.Expression,
    ): "width" | "height" | undefined {
        return this.canvasSizeInfo(expression)?.axis;
    }

    public canvasSizeValue(expression: ts.Expression): Value | undefined {
        const unwrapped = this.unwrap(expression);
        if (
            !this.defaultEngineCpp &&
            ts.isPropertyAccessExpression(unwrapped) &&
            CANVAS_SIZE_AXES.has(unwrapped.name.text)
        ) {
            const owner = this.browserErasure.evaluateBrowserValue(
                unwrapped.expression,
            );
            if (owner?.kind === "object" && owner.primaryCanvas) {
                this.requirePresentationHost(expression);
            }
        }
        const property = this.canvasSizeInfo(expression);
        return property
            ? {
                  kind: "number",
                  cpp: property.client
                      ? `${this.requireDefaultEngine(expression)}.canvas_client_${property.axis}`
                      : `static_cast<double>(${this.requireDefaultEngine(
                            expression,
                        )}.options.${property.axis})`,
                  dataType: { kind: "number" },
              }
            : undefined;
    }

    public isBrowserInstrumentationCall(call: ts.CallExpression): boolean {
        const callee = namedMember(this.checker, this.unwrap(call.expression));
        if (callee?.name === "addEventListener") {
            const device = namedMember(
                this.checker,
                this.unwrap(callee.expression),
            );
            if (
                device?.name === "_device" &&
                ts.isIdentifier(device.expression) &&
                this.bindings.lookupOptional(device.expression)?.kind ===
                    "engine"
            )
                return false;
        }
        const assigned = call.arguments[0];
        if (
            isLibraryStatic(
                this.checker,
                call.expression,
                "Object",
                "assign",
            ) &&
            assigned &&
            this.mayOwnCameraState(assigned)
        ) {
            // This erased browser helper cannot invoke observable setters,
            // including through a helper-returned camera/vector argument.
            this.admissions.noteUntrackedCameraWrite({
                node: call,
                reason: "Object.assign does not lower observable camera setters",
            });
        }
        return this.browserErasure.isBrowserInstrumentationCall(call);
    }

    /**
     * Whether writing through `target` writes camera state the pin observes
     * through setters: a camera, a camera vector value, or a camera's
     * `target`, `position` or `upVector`.
     */
    private mayOwnCameraState(target: ts.Expression): boolean {
        const owner = this.unwrap(target);
        return (
            this.probeEmission(
                () =>
                    this.resolveRecordValue(owner)?.cameraVector !== undefined,
                () => false,
            ) ||
            isCameraExpression(this, owner) ||
            (ts.isPropertyAccessExpression(owner) &&
                ["target", "position", "upVector"].includes(owner.name.text) &&
                isCameraExpression(this, owner.expression))
        );
    }

    public platformDocumentHidden(): string | undefined {
        return this.platformDocumentHiddenCpp;
    }

    public compilePlatformCall(call: ts.CallExpression): Value | undefined {
        return this.platform.compilePlatformCall(call);
    }

    /**
     * Registers an application-owned browser animation loop on the native
     * frame conductor. Browser RAF callbacks run in registration order. A
     * callback registered before `startEngine` therefore updates before the
     * engine-owned render callback, while one registered after the awaited
     * start (the platformer conductor) runs after rendering and affects the
     * following frame. Native startup itself remains deferred because its
     * platform loop blocks.
     *
     * A recursive request inside the callback only re-arms the browser
     * callback; the conductor is already recurring, so that call emits
     * nothing. The callback belongs to the engine frame conductor, so
     * scene-less applications do not fabricate a SceneContext that would
     * select the wrong native renderer.
     */
    public compileAnimationFrameCall(
        call: ts.CallExpression,
    ): Value | undefined {
        return this.platform.compileAnimationFrameCall(call);
    }

    public requireCompatibleFrameConductor(
        owner: "manager" | "persistent",
        site: ts.Node,
    ): void {
        return this.platform.requireCompatibleFrameConductor(owner, site);
    }

    public emitPlatformEventListener(call: ts.CallExpression): boolean {
        return this.platform.emitPlatformEventListener(call);
    }

    /**
     * Whether every member of an expression's type is one of the DOM
     * library's two canvas types. A program's own type that shares a canvas
     * name is not a canvas, and neither is a member without a symbol.
     */
    public isCanvasElement(expression: ts.Expression): boolean {
        const type = this.checker.getTypeAtLocation(expression);
        const members = unionMembers(type);
        return (
            members.length > 0 &&
            members.every((member) => {
                const symbol = member.getSymbol();
                return (
                    symbol !== undefined &&
                    CANVAS_TYPE_NAMES.has(symbol.getName()) &&
                    declaredInDomLibrary(symbol)
                );
            })
        );
    }

    /**
     * A module-level `const`'s own initializer, for a reader that may only
     * answer from an immutable binding.
     *
     * `staticConstants` deliberately admits the ENTRY file's `let` too --
     * the emitter deletes each one as it reaches its declaration, so
     * a later read resolves through the value path instead. That ordering is
     * right for the emitter and wrong for anything asking speculatively, so
     * this asks the DECLARATION whether it is const rather than trusting the
     * map.
     */
    public constantInitializer(
        identifier: ts.Identifier,
    ): ts.Expression | undefined {
        const symbol = this.symbols.valueSymbol(identifier);
        const declaration = symbol?.declarations?.[0];
        if (
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !ts.isVariableDeclarationList(declaration.parent) ||
            variableKind(declaration.parent) !== "const"
        ) {
            return undefined;
        }
        return this.resolveStaticExpression(identifier);
    }

    /**
     * The module-level function an identifier names, when it names exactly
     * one declaration and that declaration has a body.
     *
     * Module level is the load-bearing half. A function declared inside
     * another body closes over that body's locals, so a reader that
     * evaluates the body speculatively -- browser erasure asks this of the
     * capture-pose helpers -- would be resolving names against whichever
     * scope happened to be open at the time. A single declaration is the
     * other half: an overload set has signatures without bodies, and
     * picking one of them would answer for a call the checker resolved to
     * another.
     */
    public moduleFunctionDeclaration(
        identifier: ts.Identifier,
    ): ts.FunctionDeclaration | undefined {
        const declarations =
            this.symbols.valueSymbol(identifier)?.declarations ?? [];
        const declaration =
            declarations.length === 1 ? declarations[0]! : undefined;
        return declaration &&
            ts.isFunctionDeclaration(declaration) &&
            declaration.body !== undefined &&
            ts.isSourceFile(declaration.parent)
            ? declaration
            : undefined;
    }

    public refuseBorrowedPlatformEventEscape(
        value: Value,
        node: ts.Node,
        destination: string,
    ): void {
        if (!this.bindings.containsPlatformEvent(value)) return;
        this.fail(
            node,
            `A borrowed platform event cannot escape its synchronous dispatch frame through ${destination}. Copy only owned scalar/string fields needed later.`,
        );
    }

    /**
     * The evaluator's own unwrap -- one rule for what a reader sees
     * through, including the pin's `wgsl` tag -- which records every await
     * it passes into `unwrappedAwaitExpressions` through `onAwait`.
     */
    public readonly unwrap = (expression: ts.Expression): ts.Expression =>
        this.evaluator.unwrap(expression);

    /**
     * The expression whose value this one is: through an `await` only where
     * it settles in place. In a worker realm an await suspends, so its
     * value is the await's own.
     */
    public readonly unwrapValue = (expression: ts.Expression): ts.Expression =>
        this.evaluator.unwrap(expression, { await: !this.options.workers });

    /** Captured mutable parameters own their binding, not the caller's slot. */
    public mutableCapturedParameter(
        identifier: ts.Identifier,
        value: Value,
    ): boolean {
        let declaration: ts.Node = identifier.parent;
        while (
            ts.isBindingElement(declaration) ||
            ts.isObjectBindingPattern(declaration) ||
            ts.isArrayBindingPattern(declaration)
        )
            declaration = declaration.parent;
        return (
            ts.isParameter(declaration) &&
            this.sharedClosures.needsSharedClosureStorage(
                declaration,
                identifier,
            ) &&
            (this.sharedClosures.isSharedClosureScalar(
                value.dataType?.kind ?? value.kind,
            )
                ? isSupportedFunction(declaration.parent) &&
                  !parameterIsReadOnly(
                      this.checker,
                      declaration.parent,
                      identifier,
                  )
                : this.sharedClosures.identifierIsRebound(identifier))
        );
    }

    public bindClassParameterValue(
        identifier: ts.Identifier,
        argument: ts.Expression,
    ): void {
        this.bindings.bindParameterValue(
            identifier,
            this.compileClassParameterValue(identifier, argument),
        );
    }

    public compileClassParameterValue(
        identifier: ts.Identifier,
        argument: ts.Expression,
    ): Value {
        let dataType = this.dataLowerer.dataTypeAt(identifier);
        const parameter = identifier.parent;
        if (
            dataType &&
            ["number", "string", "boolean"].includes(dataType.kind) &&
            ts.isParameter(parameter) &&
            isSupportedFunction(parameter.parent) &&
            parameterIsReadOnly(this.checker, parameter.parent, identifier)
        ) {
            const value = this.compileValue(argument);
            const cpp = this.dataLowerer.compileKnownValueForSink(
                value,
                dataType,
                argument,
            );
            return {
                ...this.dataLowerer.leafValue(cpp, dataType),
                ...(value.staticNumber !== undefined && !value.parameterBinding
                    ? { staticNumber: value.staticNumber }
                    : {}),
                ...(value.staticString !== undefined && !value.parameterBinding
                    ? { staticString: value.staticString }
                    : {}),
                ...(value.staticBoolean !== undefined && !value.parameterBinding
                    ? { staticBoolean: value.staticBoolean }
                    : {}),
            };
        }
        if (dataType?.kind === "struct") {
            dataType = this.dataTypes.markStoredObjectReferences(dataType);
        }
        if (!dataType || dataType.kind === "handle") {
            return this.compileValue(argument);
        }
        let receivingDeclaration: ts.Node | undefined = argument.parent;
        while (
            receivingDeclaration &&
            !ts.isVariableDeclaration(receivingDeclaration) &&
            !ts.isStatement(receivingDeclaration)
        ) {
            receivingDeclaration = receivingDeclaration.parent;
        }
        const receivingName =
            receivingDeclaration &&
            ts.isVariableDeclaration(receivingDeclaration) &&
            ts.isIdentifier(receivingDeclaration.name)
                ? receivingDeclaration.name
                : undefined;
        const receivingSymbol =
            receivingName && !this.bindings.lookupOptional(receivingName)
                ? this.symbols.valueSymbol(receivingName)
                : undefined;
        if (
            dataType.kind === "struct" &&
            this.dataTypes.carriesFunction(dataType) &&
            receivingSymbol &&
            someAnalysisNode(
                argument,
                (node) =>
                    ts.isIdentifier(node) &&
                    this.symbols.valueSymbol(node) === receivingSymbol,
            )
        ) {
            // Inline class fields can retain callback wiring until a native
            // storage boundary demands it. Materializing here would compile
            // closures before the variable receiving this instance exists.
            const value = this.compileValue(argument);
            return value.kind === "record"
                ? value
                : this.dataLowerer.leafValue(
                      this.dataLowerer.compileKnownValueForSink(
                          value,
                          dataType,
                          argument,
                      ),
                      dataType,
                  );
        }
        if (dataType.kind === "function") {
            const unwrappedCallback = this.unwrap(argument);
            const bound = ts.isIdentifier(unwrappedCallback)
                ? this.bindings.lookupOptional(unwrappedCallback)
                : undefined;
            const declaration =
                !bound && ts.isIdentifier(unwrappedCallback)
                    ? tryResolveFunctionDeclaration(
                          this.checker,
                          unwrappedCallback,
                      )
                    : undefined;
            const callback = declaration
                ? ({
                      kind: "callback",
                      cpp: "",
                      callbackDeclaration: declaration,
                      callbackRecordOwner: {
                          kind: "record",
                          cpp: "",
                          ...this.captureRecordScopes(),
                      },
                  } satisfies Value)
                : this.compileValue(argument);
            if (callback.kind === "callback") {
                // An inlined class method can carry a local callback as
                // compiler metadata and inline each invocation directly.
                // Materializing std::function here adds type erasure to hot
                // loops even though the callback never crossed a runtime
                // storage boundary. If the method actually stores it, that
                // later function-typed sink still performs materialization.
                return callback;
            }
        }
        const unwrapped = this.unwrap(argument);
        const collection =
            dataType.kind === "vector" ||
            dataType.kind === "span" ||
            dataType.kind === "map" ||
            dataType.kind === "set";
        const structural =
            dataType.kind === "struct" ||
            (dataType.kind === "vector" && dataType.element.kind === "struct");
        if (
            collection ||
            (structural &&
                (ts.isIdentifier(unwrapped) ||
                    ts.isPropertyAccessExpression(unwrapped) ||
                    ts.isElementAccessExpression(unwrapped)))
        ) {
            const actual = this.compileValue(unwrapped);
            if (isJsonValue(actual)) return actual;
            if (
                collection &&
                actual.kind === "data" &&
                actual.dataType &&
                this.dataLowerer.spanCompatible(actual.dataType, dataType)
            ) {
                return actual;
            }
            if (
                structural &&
                actual.kind === "record" &&
                this.dataTypes.carriesHandle(dataType)
            ) {
                // The caller holds a compile-time record of engine handles.
                // Materializing it for the declared struct would mint a
                // SECOND object naming the same handles at every call, so
                // the parameter keeps the one object the caller named --
                // which is what a parameter typed outside the data model
                // already does.
                return actual;
            }
            if (
                actual.kind === "data" &&
                ((actual.dataType?.kind === "vector" &&
                    dataType.kind === "vector" &&
                    actual.dataType.element.kind === "struct" &&
                    dataType.element.kind === "struct") ||
                    (actual.dataType?.kind === "struct" &&
                        dataType.kind === "struct"))
            ) {
                // TypeScript already proved structural assignability. Keep
                // the actual array/object shape so a parameter that reads or
                // writes a subset of fields shares the caller's JavaScript
                // object instead of projecting and copying it.
                return actual;
            }
            if (collection) {
                dataType = this.dataTypes.ownReturnedArray(dataType);
                const cpp = this.dataLowerer.compileKnownValueForSink(
                    actual,
                    dataType,
                    argument,
                );
                return this.dataLowerer.leafValue(cpp, dataType);
            }
        }
        const cpp = this.dataLowerer.compileForSink(argument, dataType);
        if (dataType.kind === "borrowed-platform-event") {
            // The erased Event view returns itself from get(), so its wrapper
            // must outlive the inlined parameter reference.
            const storage = this.allocateTemporaryCppName("event_argument");
            this.emit({
                kind: "declaration",
                type: "const auto",
                name: storage,
                initializer: cpp,
            });
            return {
                ...this.dataLowerer.leafValue(storage, dataType),
                nativeCaptures: [this.registerNativeBinding(storage)],
            };
        }
        return this.dataLowerer.leafValue(
            dataType.kind === "optional" && cpp === "std::nullopt"
                ? `${this.dataTypes.cppType(dataType)}{std::nullopt}`
                : cpp,
            dataType,
        );
    }

    public compileCallbackWithValues(
        declaration:
            | ts.Identifier
            | ts.FunctionDeclaration
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        arguments_: readonly Value[],
        callNode: ts.Node,
        discardReturn = false,
        body?: CallbackInvocationOptions,
    ): Value {
        const callable = ts.isFunctionDeclaration(declaration)
            ? (declaration.name ??
              this.fail(
                  declaration,
                  "Callback function declarations require a name.",
              ))
            : declaration;
        return this.userFunctions.compileCallbackWithValues(
            this,
            callable,
            arguments_,
            callNode,
            discardReturn,
            body,
        );
    }

    public compileCallbackValueWithValues(
        callback: Value,
        arguments_: readonly Value[],
        callNode: ts.Node,
        options?: {
            discardReturn?: boolean;
            predicate?: boolean;
            body?: CallbackInvocationOptions;
        },
    ): Value {
        return this.userFunctions.compileCallbackValueWithValues(
            this,
            callback,
            arguments_,
            callNode,
            options,
        );
    }

    public compileStoredDataFunction(
        expression:
            | ts.Identifier
            | ts.FunctionDeclaration
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        dataType: DataType & { kind: "function" },
        owner?: Value,
        prototypeMethod = false,
        receiver?: Value,
    ): string {
        if (prototypeMethod && owner?.kind !== "record")
            this.fail(
                expression,
                "A structural method view requires its receiver.",
            );
        if (ts.isIdentifier(expression)) {
            const imported = this.symbols.importedName(expression);
            if (imported)
                return this.compileStoredIntrinsicFunction(
                    expression,
                    imported,
                    dataType,
                );
        }
        const expressionIsFunctionObject =
            ts.isArrowFunction(expression) ||
            ts.isFunctionExpression(expression) ||
            ts.isMethodDeclaration(expression);
        const evaluationIdentity = this.callbackEvaluationIdentity();
        const lexicalThis = ts.isArrowFunction(expression)
            ? this.activeThis()
            : undefined;
        const effectiveOwner: Value | undefined =
            owner ??
            (expressionIsFunctionObject
                ? {
                      ...(lexicalThis ?? {
                          kind: "record" as const,
                          cpp: "",
                      }),
                      ...this.captureRecordScopes(),
                      ...(this.isFunctionEvaluationRepeated(lexicalThis)
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
                : undefined);
        const identityCpp = prototypeMethod
            ? `${this.callbackIdentity(expression, owner, true)}u`
            : effectiveOwner?.runtimeCallbackIdentityCpp;
        const compile = (): string => {
            if (dataType.generic) {
                const declaration = ts.isIdentifier(expression)
                    ? resolveFunctionDeclaration(
                          this.checker,
                          expression,
                          (node, message) => this.fail(node, message),
                      )
                    : expression;
                if (!declaration)
                    this.fail(
                        expression,
                        "Stored generic function requires a local declaration.",
                    );
                if (
                    declaration.body &&
                    someAnalysisNode(
                        declaration.body,
                        (node) => node.kind === ts.SyntaxKind.ThisKeyword,
                        {
                            skip: (node) =>
                                ts.isFunctionLike(node) &&
                                !ts.isArrowFunction(node),
                        },
                    )
                )
                    this.fail(
                        expression,
                        "Stored generic methods using this require a shared native receiver.",
                    );
                const fields = this.dataTypes.genericFunctionFields(
                    dataType.generic,
                );
                const parts = fields.map((field) =>
                    this.dataTypes.withGenericFunctionArguments(
                        declaration,
                        field.demand,
                        () =>
                            this.compileStoredDataFunction(
                                expression,
                                field.type,
                                effectiveOwner,
                                prototypeMethod,
                            ),
                    ),
                );
                const table = this.dataLowerer.structAggregate(
                    { kind: "struct", name: dataType.generic },
                    parts,
                );
                const identity =
                    identityCpp ??
                    (effectiveOwner?.repeatedCallbackEvaluation
                        ? "bbl::js::next_callback_identity()"
                        : `${this.callbackIdentity(declaration, effectiveOwner)}u`);
                return `${this.dataTypes.cppType(dataType)}{${identity}, ${table}}`;
            }
            if (identityCpp) {
                this.useNativeValue({
                    kind: "number",
                    cpp: identityCpp,
                });
                dataType = { ...dataType, identity: true };
            }
            this.bindings.refuseEscapingPlatformEventCapturesIn(
                expression,
                this.bindings.variableScopes.length,
            );
            const cpp = this.userFunctions.compileStoredDataFunction(
                this,
                expression,
                dataType,
                effectiveOwner,
                identityCpp,
                receiver,
            );
            this.registerNativeBinding(cpp);
            return cpp;
        };
        if (!effectiveOwner) {
            // A named function bound to a receiver (`f.bind(thisArg)`).
            return receiver ? this.withThis(receiver, compile) : compile();
        }
        return this.withRecordScopes(effectiveOwner, () => {
            if (!effectiveOwner.recordProperties && !receiver) {
                // A scope-only owner carries the captured variables of an
                // inline literal and no receiver; `this` stays whatever the
                // literal was written under.
                return compile();
            }
            // A method or arrow declared in an object or class body closes
            // over that object. Materializing it from a field read has to
            // restore the same `this` its declaration ran under, or the
            // body would resolve its fields against whichever receiver the
            // enclosing inlined method happened to leave bound.
            return this.withThis(receiver ?? effectiveOwner, compile);
        });
    }

    public compileStoredAccessor(
        owner: Value,
        accessor: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
        valueType: DataType,
        receiverType?: DataType<"struct">,
        home?: Value,
    ): string {
        const getter = ts.isGetAccessorDeclaration(accessor);
        const valueCpp = this.dataTypes.cppType(valueType);
        const argument = this.allocateTemporaryCppName("accessor_value");
        const receiverName = receiverType
            ? this.allocateTemporaryCppName("accessor_receiver")
            : "";
        const receiverCpp =
            receiverType && this.dataTypes.cppType(receiverType);
        const body = this.captureManagedClosureLines(() => {
            const receiver: Value | undefined = receiverType
                ? {
                      ...this.dataLowerer.leafValue(receiverName, receiverType),
                      nativeCaptures: [
                          this.registerNativeBinding(
                              receiverName,
                              false,
                              false,
                              receiverCpp,
                          ),
                      ],
                  }
                : home;
            if (getter) {
                const value = this.compileRecordGetter(
                    owner,
                    accessor,
                    receiver,
                );
                this.emit(
                    `return ${this.dataLowerer.compileKnownValueForSink(value, valueType, accessor)};`,
                );
                return;
            }
            const parameterName = accessor.parameters[0]?.name;
            if (!parameterName || !ts.isIdentifier(parameterName))
                this.fail(accessor, "A setter takes one named parameter.");
            const argumentValue: Value = {
                ...this.dataLowerer.leafValue(argument, valueType),
                nativeCaptures: [
                    this.registerNativeBinding(
                        argument,
                        false,
                        false,
                        valueCpp,
                    ),
                ],
            };
            this.withRecordScopes(
                owner,
                () =>
                    this.classLowerer.compileSetter(
                        receiver ?? owner,
                        accessor,
                        parameterName,
                        argumentValue,
                    ),
                accessor,
            );
            if (receiverType) this.emit("return true;");
        });
        this.reachJsData();
        if (receiverCpp)
            return getter
                ? `bbl::js::Callback<${valueCpp}(${receiverCpp})>(${renderClosure(body, `[[maybe_unused]] ${receiverCpp} ${receiverName}`, valueCpp)})`
                : `bbl::js::Callback<bool(${receiverCpp}, ${valueCpp})>(${renderClosure(body, `[[maybe_unused]] ${receiverCpp} ${receiverName}, [[maybe_unused]] ${valueCpp} ${argument}`, "bool")})`;
        return getter
            ? `bbl::js::Callback<${valueCpp}()>(${renderClosure(body, "", valueCpp)})`
            : `bbl::js::Callback<void(${valueCpp})>(${renderClosure(body, `[[maybe_unused]] ${valueCpp} ${argument}`, "void")})`;
    }

    private compileStoredIntrinsicFunction(
        expression: ts.Identifier,
        imported: string,
        type: DataType<"function">,
    ): string {
        const signature = callSignatures(
            this.checker,
            this.checker.getTypeAtLocation(expression),
            "exact",
        )[0];
        const declaration = signature?.declaration;
        if (
            !signature ||
            !declaration ||
            type.erasedParameters?.length ||
            type.restParameter !== undefined
        )
            this.fail(
                expression,
                "Stored intrinsics require one fixed native signature.",
            );
        const sourceReturn = this.checker.getReturnTypeOfSignature(signature);
        const awaitedReturn = this.checker.getAwaitedType(sourceReturn);
        const synchronous = awaitedReturn === sourceReturn;
        if (
            (type.undefinedCompletion || type.nonThenableCompletion) &&
            !synchronous
        )
            this.fail(
                expression,
                type.undefinedCompletion
                    ? "A stored callback requires a proven undefined completion."
                    : "A stored callback requires a proven nonthenable completion.",
            );
        const parameters = type.parameters.map((parameter, index) => {
            const source = declaration.parameters[index];
            if (!source || !ts.isIdentifier(source.name))
                this.fail(
                    expression,
                    "Stored intrinsic parameters require declared identifiers.",
                );
            return {
                source: source.name,
                type: parameter,
                name: this.allocateTemporaryCppName("intrinsic_argument"),
            };
        });
        const call = ts.factory.createCallExpression(
            expression,
            undefined,
            parameters.map((parameter) => parameter.source),
        );
        ts.setTextRange(call, expression);
        ts.setOriginalNode(call, expression);
        const body = this.captureManagedClosureLines(() => {
            const bound = parameters.map((parameter) => ({
                name: parameter.source,
                compileTime: true,
                value: {
                    ...this.dataLowerer.leafValue(
                        parameter.name,
                        parameter.type,
                    ),
                    nativeCaptures: [
                        this.registerNativeBinding(
                            parameter.name,
                            false,
                            false,
                            this.dataTypes.cppType(parameter.type),
                        ),
                    ],
                },
            }));
            this.bindings.withBoundParameters(bound, () => {
                const value =
                    this.compileRegisteredIntrinsic(imported, call) ??
                    this.fail(
                        expression,
                        `Stored Babylon Lite intrinsic '${imported}' is not supported.`,
                    );
                const isUndefinedResult = (
                    result: Value | undefined,
                ): boolean =>
                    !!result &&
                    !result.erasedVoidCompletion &&
                    (result.kind === "void" ||
                        absenceOf(result) === "undefined" ||
                        result.dataType?.kind === "undefined");
                const undefinedCompletion =
                    synchronous &&
                    undefinedOnly(sourceReturn) &&
                    isUndefinedResult(value);
                if (type.undefinedCompletion && !undefinedCompletion)
                    this.fail(
                        expression,
                        "A stored callback requires a proven undefined completion.",
                    );
                if (
                    type.awaitedUndefinedCompletion &&
                    !(
                        awaitedReturn &&
                        undefinedOnly(awaitedReturn) &&
                        (undefinedCompletion ||
                            (value.kind === "promise" &&
                                isUndefinedResult(value.promiseResult)))
                    )
                )
                    this.fail(
                        expression,
                        "A stored callback requires a proven undefined completion after awaiting.",
                    );
                const scalarValue =
                    isNonThenableDataType(value.dataType) ||
                    ["number", "boolean", "string", "json-null"].includes(
                        value.kind,
                    );
                if (
                    type.nonThenableCompletion &&
                    !(synchronous && (undefinedCompletion || scalarValue))
                )
                    this.fail(
                        expression,
                        "A stored callback requires a proven nonthenable completion.",
                    );
                if (!type.result) {
                    this.emitDiscardedValue(value);
                    return;
                }
                if (
                    type.result.kind === "promise" &&
                    value.kind !== "promise"
                ) {
                    const result = type.result.result;
                    const cpp = result
                        ? this.dataLowerer.compileKnownValueForSink(
                              value,
                              result,
                              expression,
                          )
                        : "bbl::js::PromiseVoid{}";
                    if (!result) this.emitDiscardedValue(value);
                    this.emit(
                        `return ${this.dataTypes.cppType(type.result)}::resolved(${cpp});`,
                    );
                } else {
                    this.emit(
                        `return ${this.dataLowerer.compileKnownValueForSink(value, type.result, expression)};`,
                    );
                }
            });
        });
        this.reachJsData();
        const closure = renderClosure(
            body,
            parameters
                .map(
                    (parameter) =>
                        `[[maybe_unused]] ${this.dataTypes.cppType(parameter.type)} ${parameter.name}`,
                )
                .join(", "),
            type.result ? this.dataTypes.cppType(type.result) : "void",
        );
        return `${this.dataTypes.cppType(type)}{${this.callbackIdentity(declaration, undefined)}u, ${closure}}`;
    }

    public compilePredicateWithValues(
        declaration:
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        arguments_: readonly Value[],
        callNode: ts.Node,
    ): Value {
        return this.userFunctions.compilePredicateWithValues(
            this,
            declaration,
            arguments_,
            callNode,
        );
    }

    /** A declared collection's cardinality, shared with the aliases of its elements. */
    public trackCollectionCardinality(
        identifier: ts.MemberName,
        value: Value,
    ): void {
        if (
            value.kind === "data" &&
            (value.dataType?.kind === "vector" ||
                value.dataType?.kind === "map" ||
                value.dataType?.kind === "set")
        ) {
            const owner = value.staticElementsOwner ?? value;
            const declaration = identifier.parent;
            const initializer =
                ts.isVariableDeclaration(declaration) && declaration.initializer
                    ? this.unwrap(declaration.initializer)
                    : undefined;
            const keyed = value.dataType.kind !== "vector";
            const emptyKeys =
                keyed &&
                initializer &&
                ((ts.isNewExpression(initializer) &&
                    (initializer.arguments?.length ?? 0) === 0) ||
                    (ts.isObjectLiteralExpression(initializer) &&
                        initializer.properties.length === 0));
            const count = emptyKeys
                ? 0
                : (owner.staticElements?.length ??
                  (initializer &&
                  ts.isArrayLiteralExpression(initializer) &&
                  !initializer.elements.some(ts.isSpreadElement)
                      ? initializer.elements.length
                      : undefined));
            const cardinality: CollectionCardinality =
                owner.collectionCardinality ??
                    value.collectionCardinality ?? {
                        kind: keyed ? "keyed" : "array",
                        count,
                        ...(emptyKeys
                            ? {
                                  keys: new EmissionSet<
                                      string | number | boolean
                                  >(),
                              }
                            : {}),
                        createdIn: [...this.parameterizedResourceIterations],
                        varyingIn: new EmissionSet(),
                    };
            writable(value).collectionCardinality = cardinality;
            writable(owner).collectionCardinality = cardinality;
            this.collectionCardinalities.add(cardinality);
        }
        if (
            value.kind === "tuple" &&
            value.tupleElements &&
            !this.listCreationSites.has(value.tupleElements)
        )
            this.listCreationSites.set(
                value.tupleElements,
                this.collectionSite(),
            );
    }

    /** Read carried facts only; accessors and runtime expressions are not evaluated. */
    public knownValueWithoutEvaluation(
        expression: ts.Expression,
    ): Value | undefined {
        const node = this.unwrap(expression);
        if (ts.isIdentifier(node)) return this.bindings.lookupOptional(node);
        if (node.kind === ts.SyntaxKind.ThisKeyword) return this.activeThis();
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.knownValueWithoutEvaluation(node.expression);
            if (!owner?.recordGetters?.[node.name.text])
                return owner?.recordProperties?.[node.name.text];
        }
        return undefined;
    }

    public knownCollectionCardinality(
        expression: ts.Expression,
    ): number | undefined {
        const carried = this.knownValueWithoutEvaluation(expression);
        const carriedState =
            carried?.collectionCardinality ??
            carried?.staticElementsOwner?.collectionCardinality;
        if (carried && carriedState)
            return this.collectionCount(carried, carriedState);
        const node = this.unwrap(this.resolveStaticExpression(expression));
        if (ts.isArrayLiteralExpression(node)) {
            let count = 0;
            for (const element of node.elements) {
                if (!ts.isSpreadElement(element)) {
                    count++;
                    continue;
                }
                const spread = this.knownCollectionCardinality(
                    element.expression,
                );
                if (spread === undefined) return undefined;
                count += spread;
            }
            return count;
        }
        const value = this.knownValueWithoutEvaluation(node);
        if (!value) return undefined;
        const state =
            value.collectionCardinality ??
            value.staticElementsOwner?.collectionCardinality;
        if (state) return this.collectionCount(value, state);
        return (
            value.tupleElements ??
            (this.collectionFactsHold(value)
                ? (value.staticElementsOwner?.staticElements ??
                  value.staticElements)
                : undefined)
        )?.length;
    }

    /** The size `state` knows for `value`'s collection where the walk stands. */
    private collectionCount(
        value: Value,
        state: CollectionCardinality,
    ): number | undefined {
        return state.count === undefined ||
            state.untrackedAliases ||
            this.parameterizedResourceIterations.some((frame) =>
                state.varyingIn.has(frame),
            ) ||
            !this.collectionFactsHold(value)
            ? undefined
            : state.count;
    }

    /**
     * Whether the generation facts `value` carries for a collection (its
     * size, its elements) describe it where the walk stands.
     *
     * A closure that runs after the statement creating it is lowered at that
     * statement, so a fact that a binding declared outside the closure holds
     * describes the collection there. It holds where the closure runs only
     * if no code that can run once that statement begins writes the binding
     * (`writtenOnceBegun`).
     */
    public collectionFactsHold(value: Value): boolean {
        const begun = this.laterBodies.at(-1);
        const owner = value.staticElementsOwner ?? value;
        if (
            begun === undefined ||
            !(
                owner.collectionCardinality ??
                value.collectionCardinality ??
                owner.staticElements ??
                value.staticElements
            )
        )
            return true;
        return this.bindings
            .collectionHolders(value)
            .every(({ symbol, scope }) => {
                // The statement the holder's block stands at, when lowered.
                let index = this.loweringStatements.length - 1;
                while (
                    index >= 0 &&
                    this.loweringStatements[index]!.scope !== scope
                )
                    index--;
                // Declared while the closure is lowered: it runs there.
                if (index >= begun) return true;
                const declaration = symbol.valueDeclaration;
                const name =
                    declaration && ts.getNameOfDeclaration(declaration);
                return (
                    name !== undefined &&
                    ts.isIdentifier(name) &&
                    !writtenOnceBegun(
                        this,
                        name,
                        this.loweringStatements[index]?.statement,
                    )
                );
            });
    }

    /** A known size whose members no longer have individual static aliases. */
    public runtimeCollectionCardinality(
        expression: ts.Expression,
    ): number | undefined {
        const value = this.knownValueWithoutEvaluation(expression);
        return value &&
            !value.tupleElements &&
            !(value.staticElementsOwner?.staticElements ?? value.staticElements)
            ? this.knownCollectionCardinality(expression)
            : undefined;
    }

    /** Where the source walk is, by the run-time regions around it. */
    private collectionSite(): CollectionSite {
        return {
            control: this.runtimeControlFlowDepth,
            iteration: this.runtimeIterationDepth,
            callback: this.frameCallbackDepth,
            frame: [...this.returnFrames]
                .reverse()
                .find((frame) => frame.kind === "native"),
        };
    }

    /**
     * Gives a list a block-scoped declaration creates a cardinality of its
     * own, created here.
     */
    public declaredCollection(value: Value): void {
        const state: CollectionCardinality = {
            kind: "array",
            count: undefined,
            createdIn: [...this.parameterizedResourceIterations],
            varyingIn: new EmissionSet(),
            createdAt: this.collectionSite(),
        };
        this.collectionCardinalities.add(state);
        writable(value).collectionCardinality = state;
    }

    /** Whether a mutation here runs whenever `value`'s collection was created. */
    public mutatesWhereCreated(value: Value): boolean {
        const state =
            (value.staticElementsOwner ?? value).collectionCardinality ??
            value.collectionCardinality;
        return (
            !state?.untrackedAliases && this.atCollectionSite(state?.createdAt)
        );
    }

    /**
     * Whether a push here onto the compile-time list `elements` runs
     * whenever its binding did; a list no declaration bound has no site to
     * leave.
     */
    public mutatesListWhereCreated(elements: readonly Value[]): boolean {
        const created = this.listCreationSites.get(elements);
        return !created || this.atCollectionSite(created);
    }

    private atCollectionSite(created: CollectionSite | undefined): boolean {
        if (!created) return false;
        const here = this.collectionSite();
        return (
            created.control === here.control &&
            created.iteration === here.iteration &&
            created.callback === here.callback &&
            created.frame === here.frame &&
            !this.returnFrames.some((current) =>
                this.resourceLoopReturns.has(current),
            )
        );
    }

    public definiteCollectionMutation(): boolean {
        const frame = this.parameterizedResourceIterations.at(-1);
        const definite = frame
            ? this.runtimeControlFlowDepth === frame.controlDepth + 1 &&
              this.runtimeIterationDepth === frame.iterationDepth + 1
            : this.runtimeControlFlowDepth === 0 &&
              this.runtimeIterationDepth === 0;
        return (
            definite &&
            this.frameCallbackDepth === 0 &&
            (frame !== undefined ||
                this.returnFrames.every(
                    (current) =>
                        current.kind !== "native" || current.callSiteEffects,
                )) &&
            !this.returnFrames.some((current) =>
                this.resourceLoopReturns.has(current),
            )
        );
    }

    public recordArrayPush(value: Value, added: number | undefined): boolean {
        const owner = value.staticElementsOwner ?? value;
        const state =
            owner.collectionCardinality ?? value.collectionCardinality;
        if (state) writable(value).collectionCardinality = state;
        if (
            added === undefined ||
            !(
                this.definiteCollectionMutation() ||
                this.mutatesWhereCreated(value)
            ) ||
            state?.untrackedAliases
        ) {
            if (state) {
                writable(state).count = undefined;
                if (
                    this.frameCallbackDepth > 0 ||
                    (!this.parameterizedResourceIterations.length &&
                        this.isInNativeFunctionBody())
                ) {
                    writable(state).untrackedAliases = true;
                }
            }
            return false;
        }
        if (!state) return true;
        let repetitions = 1;
        for (const current of this.parameterizedResourceIterations) {
            if (state.createdIn.includes(current)) continue;
            repetitions *= current.iterations;
            if (added !== 0 && current.iterations > 1)
                state.varyingIn.add(current);
        }
        if (state.count !== undefined) {
            const count = state.count + added * repetitions;
            writable(state).count = Number.isSafeInteger(count)
                ? count
                : undefined;
        }
        return true;
    }

    public recordCollectionKey(
        value: Value,
        key: Value,
        removed = false,
    ): void {
        const state = value.collectionCardinality;
        if (!state || state.kind !== "keyed") return;
        const scalar =
            key.staticNumber ?? key.staticString ?? key.staticBoolean;
        if (
            scalar === undefined ||
            !this.definiteCollectionMutation() ||
            state.untrackedAliases
        ) {
            writable(state).count = undefined;
            delete writable(state).keys;
            if (
                this.frameCallbackDepth > 0 ||
                (!this.parameterizedResourceIterations.length &&
                    this.isInNativeFunctionBody())
            ) {
                writable(state).untrackedAliases = true;
            }
            return;
        }
        if (!state.keys) return;
        const changed = removed
            ? state.keys.has(scalar)
            : !state.keys.has(scalar);
        if (removed) state.keys.delete(scalar);
        else state.keys.add(scalar);
        writable(state).count = state.keys.size;
        if (changed) {
            for (const current of this.parameterizedResourceIterations) {
                if (
                    !state.createdIn.includes(current) &&
                    current.iterations > 1
                )
                    state.varyingIn.add(current);
            }
        }
    }

    public recordCollectionClear(value: Value): void {
        const state = value.collectionCardinality;
        if (!state || state.kind !== "keyed") return;
        if (this.definiteCollectionMutation() && !state.untrackedAliases) {
            writable(state).keys = new EmissionSet();
            writable(state).count = 0;
        } else {
            delete writable(state).keys;
            writable(state).count = undefined;
        }
    }

    public expectKind(value: Value, kind: ValueKind, node: ts.Node): void {
        if (kind === "string" && isStringValue(value)) return;
        if (value.kind !== kind) {
            // Data names its storage and the type it was read as, where the
            // refusal outlives a probe.
            const stored =
                value.kind === "data" && value.dataType && !this.speculating
                    ? ` (stored as ${JSON.stringify(value.dataType)}, typed '${this.checker.typeToString(this.checker.getTypeAtLocation(node))}')`
                    : "";
            this.fail(
                node,
                `Expected ${kind}, received ${value.kind}${stored}.`,
            );
        }
    }

    /** Only an immutable outer capture can describe every invocation of a shared body. */
    public capturedEngineOwnerIdentity(
        value: Value,
        captures: readonly NativeCaptureBinding[],
    ): symbol | undefined {
        if (!value.engineCpp) return undefined;
        const identity =
            value.engineOwnerIdentity ??
            this.realmEngineIdentities.get(value.engineCpp);
        const binding = this.nativeBindings.get(value.engineCpp);
        const owners =
            value.nativeCompanionCaptures?.engineCpp ??
            this.realmEngineCaptures.get(value.engineCpp) ??
            (binding ? [binding] : []);
        return identity &&
            owners.length > 0 &&
            owners.every(
                (owner) =>
                    this.nativeConstBindings.has(owner) &&
                    captures.includes(owner),
            )
            ? identity
            : undefined;
    }

    /** Immutable aliases and owning snapshots retain the source engine identity. */
    public sameEngineOwner(left: string, right: string): boolean {
        if (left === right) return true;
        const identity = this.realmEngineIdentities.get(left);
        return (
            identity !== undefined &&
            identity === this.realmEngineIdentities.get(right)
        );
    }

    public expectSameEngine(left: Value, right: Value, node: ts.Node): void {
        void node;
        // Entry points can construct only one engine. Different spellings
        // here are aliases introduced while the same callback is specialized
        // through multiple lexical scopes, not distinct native engines.
        if (!left.engineCpp || !right.engineCpp) return;
    }

    public requireEngine(value: Value, node: ts.Node): string {
        if (!value.engineCpp) {
            this.dataTypes.requireEngineOwnerStorage(
                value.engineOwnerParameter,
            );
            // Resources whose carriers disagree belong to the one
            // unambiguous engine context (one engine per entry point).
            if (value.engineCarriersDisagree)
                return this.requireDefaultEngine(node);
            // A UI element no carrier names belongs to the Window document.
            if (value.kind === "ui-element")
                return this.ui.documentEngine(node);
            // So does a pad or one of its buttons to the Window's input.
            if (value.kind === "gamepad" || value.kind === "gamepad-button")
                return windowInputEngine(this, node);
            this.fail(
                node,
                `A ${value.kind} value is not associated with an engine.`,
            );
        }
        // One engine per entry point: where the entry's own binding is in
        // scope, an owned pair of a kind it holds names it without reading
        // the pair's stored owner.
        if (
            value.dataType?.kind === "handle" &&
            value.dataType.ownedEngine &&
            belongsToEntryEngine(value.dataType.handle)
        ) {
            const entry = this.entryEngineInScope();
            if (entry) return entry;
        }
        for (const binding of value.nativeCompanionCaptures?.engineCpp ?? [])
            this.useNativeBinding(binding);
        this.trackRetainedCaptureName(value.engineCpp);
        return value.engineCpp;
    }

    /**
     * The entry's engine binding, where no explicit engine parameter scopes
     * the body and the code is not namespace-scope (`requireDefaultEngine`).
     */
    public entryEngineInScope(): string | undefined {
        const engine = this.defaultEngineCpp;
        if (
            !engine ||
            this.returnFrames.some(
                (frame) => frame.kind === "native" && frame.namespaceScope,
            ) ||
            this.scopedEngineContexts().length > 0
        )
            return undefined;
        this.trackRetainedCaptureName(engine);
        return engine;
    }

    /** Preserve the actual stored owner when a resource leaves its source scope. */
    public storedResourceEngine(value: Value, node: ts.Node): string {
        this.useNativeValue(value);
        const engine = this.requireEngine(value, node);
        if (value.dataType?.kind === "handle" && value.dataType.ownedEngine) {
            if (!value.resourceStorageCpp)
                return this.fail(
                    node,
                    "An owned resource requires its represented storage.",
                );
            return `(${value.resourceStorageCpp}).first`;
        }
        return (
            this.realmEngineStorage.get(engine) ??
            `bbl::StoredEngine{${engine}}`
        );
    }

    /** A tracked resource choice retains only the selected engine owner. */
    public selectResourceOwner(
        value: Value,
        candidates: readonly Value[],
        index: Value,
        node: ts.Node,
    ): Value {
        this.useNativeValue(index);
        const owners = candidates.map((candidate) => {
            return this.storedResourceEngine(candidate, node);
        });
        let selected = owners.at(-1)!;
        for (let position = owners.length - 2; position >= 0; --position)
            selected = `(${index.cpp} == ${position} ? ${owners[position]} : ${selected})`;
        const owner = this.allocateTemporaryCppName("resource_owner");
        this.emit({
            kind: "declaration",
            type: "const bbl::StoredEngine",
            name: owner,
            initializer: selected,
            attributes: "[[maybe_unused]] ",
        });
        const capture = this.registerNativeConstBinding(owner);
        this.registerNativeBindingType(owner, "bbl::StoredEngine");
        const engineCpp = `(*${owner})`;
        this.realmEngineStorage.set(engineCpp, owner);
        this.realmEngineCaptures.set(engineCpp, [capture]);
        const selectedValue: Value = {
            ...value,
            engineCpp,
            nativeCompanionCaptures: {
                ...value.nativeCompanionCaptures,
                engineCpp: [capture],
            },
        };
        const identities = candidates.map(
            (candidate) =>
                candidate.engineOwnerIdentity ??
                (candidate.engineCpp
                    ? this.realmEngineIdentities.get(candidate.engineCpp)
                    : undefined),
        );
        const identity = identities[0];
        if (identity && identities.every((current) => current === identity)) {
            writable(selectedValue).engineOwnerIdentity = identity;
            this.realmEngineIdentities.set(engineCpp, identity);
        } else delete writable(selectedValue).engineOwnerIdentity;
        return selectedValue;
    }

    public engineFor(value: Value, node: ts.Node): string {
        if (value.engineCpp) {
            this.trackRetainedCaptureName(value.engineCpp);
            return value.engineCpp;
        }
        return this.requireDefaultEngine(node);
    }

    public audioSessionCpp(): string {
        if (this.defaultEngineCpp) {
            this.trackRetainedCaptureName(this.defaultEngineCpp);
            return `${this.defaultEngineCpp}.audio_session`;
        }
        this.audioSessionReached = true;
        this.useNativeBinding(this.registerNativeBinding("bbl_audio_session"));
        return "bbl_audio_session";
    }

    public requireDefaultEngine(node: ts.Node): string {
        const scoped = this.scopedEngineContexts();
        if (scoped.length > 1)
            this.fail(
                node,
                "An implicit resource constructor requires one unambiguous engine context.",
            );
        let engine = scoped[0]?.engine.cpp ?? this.defaultEngineCpp;
        if (!engine) {
            this.fail(
                node,
                "This intrinsic requires createEngine to run first.",
            );
        }
        if (
            scoped.length === 0 &&
            this.returnFrames.some(
                (frame) => frame.kind === "native" && frame.namespaceScope,
            )
        )
            this.fail(
                node,
                "A namespace-scope function has no binding for the entry's engine.",
                "entry-scope-required",
            );
        if (scoped[0]) {
            this.useNativeValue(scoped[0].owner);
            const source = scoped[0].engine;
            // A resource keeps its construction owner even when the source slot
            // is later reassigned. Its escaped uses capture this stable owner.
            const retained =
                source.ownedEngineCpp || source.storedEngineCpp
                    ? this.bindings.pinValueToTemporary(
                          source,
                          "engine_context",
                          ts.isExpression(node) ? node : undefined,
                      )
                    : source;
            engine = retained.cpp;
            this.describeEngineCaptures(retained);
            this.realmEngineCaptures.set(
                engine,
                this.nativeValueCaptures.bindingsOf(retained),
            );
            this.useNativeValue(retained);
        } else this.trackRetainedCaptureName(engine);
        return engine;
    }

    /**
     * A Canvas2D/animation-only entry still needs a platform clock and window.
     * Its host is declared in the entry preamble, including when first reached
     * while compiling a callback, so no Babylon scene or engine is fabricated
     * in the source value model.
     */
    public requirePresentationHost(node: ts.Node): string {
        if (!this.defaultEngineCpp) {
            if (this.options.workers) {
                this.fail(
                    node,
                    "Standalone Canvas2D presentation is not lowered in worker realms.",
                );
            }
            const name = this.allocateTemporaryCppName("presentation_host");
            this.presentationHostCpp = name;
            this.defaultEngineCpp = name;
            // Preamble storage precedes every closure, even one currently
            // being compiled. Its capture boundary therefore is entry scope.
            this.nativeBindings.set(name, {
                name,
                sequence: 0,
                borrowed: true,
                allowReference: false,
                entryLifetime: true,
            });
        }
        return this.requireDefaultEngine(node);
    }

    /** Whether `enablePbrLightmap()` has registered the extension yet. */
    public pbrLightmapEnabled(): boolean {
        return this.features.has("material:lightmap");
    }

    /** The `--source-profile` names a native body has been scoped under. */
    private readonly sourceProfileScopes = new EmissionSet<string>();

    /**
     * A selected source function times its whole native body
     * (`--source-profile`): these locals open the scope, ahead of everything
     * else the body runs.
     */
    public sourceProfileScopeDeclarations(
        declaration: ts.SignatureDeclaration,
    ): NativeDeclaration[] {
        const selected = this.options.sourceProfile;
        if (!selected) return [];
        const name = sourceFunctionName(declaration);
        if (name === undefined || !selected.includes(name)) return [];
        // A scope lives on the native stack; a suspended body would outlive it.
        if (functionKind(declaration) !== "plain") return [];
        this.reachFeature("profile:source", declaration);
        this.sourceProfileScopes.add(name);
        return sourceProfileScope(
            name,
            {
                function: this.allocateTemporaryCppName("source_function"),
                scope: this.allocateTemporaryCppName("source_scope"),
            },
            (text) => this.cppString(text),
        );
    }

    /**
     * Adds a runtime feature to the reached set and records the first
     * reaching scene-source call site as "file:line" for the manifest's
     * `featureSites` record. First-reach wins: the walk is a single
     * deterministic pass (entry statements in document order,
     * sub-expressions depth-first), so ties resolve by document order
     * and regeneration is stable — a repeat reach never moves the
     * recorded site. Files are named the way `fail` names them: the
     * entry file by its option name, an imported file by its program
     * name.
     *
     * `site` is the scene-source node that reached the feature, or — for a
     * feature the host page reaches with no call in the scene to name —
     * the already-formatted location of that page.
     */
    public reachFeature(
        feature: Feature,
        site?: ts.Node | string,
        impliedBy?: Feature,
    ): void {
        if (
            feature === "mesh:thin-instances" ||
            feature === "compute:frame-graph" ||
            feature === "engine:device-recovery"
        ) {
            const failure = thinInstanceOwnershipFailure(this.features, {
                reached: feature,
            });
            if (failure)
                this.fail(
                    typeof site === "object" ? site : this.sourceFile,
                    failure,
                );
        }
        if (
            !this.options.workers &&
            featureRequiresApplicationRealm(feature, impliedBy)
        )
            throw new ApplicationRealmRequired();
        if (
            ((feature === "math:mat4-invert" ||
                feature === "math:mat4-create" ||
                feature === "camera:view-projection") &&
                this.features.has("renderer:high-precision-matrix")) ||
            (feature === "renderer:high-precision-matrix" &&
                (this.features.has("math:mat4-invert") ||
                    this.features.has("math:mat4-create") ||
                    this.features.has("camera:view-projection")))
        ) {
            this.fail(
                typeof site === "object" ? site : this.sourceFile,
                "Scene-code matrix intrinsics currently require Float32 Mat4 storage; high-precision matrix allocation is not supported.",
            );
        }
        for (const implied of impliedFeatures(feature))
            this.reachFeature(implied, site, feature);
        this.features.add(feature);
        if (site !== undefined && !this.featureSites.has(feature)) {
            this.featureSites.set(feature, this.featureSite(site));
        }
    }

    /** One reaching site as the `featureSites` record spells it. */
    private featureSite(site: ts.Node | string): string {
        if (typeof site === "string") return site;
        const { file, line } = sourceLocation(site);
        const fileName =
            file === this.sourceFile ? this.options.fileName : file.fileName;
        return `${fileName}:${line}`;
    }

    public compileSceneRegistration(scene: Value, node: ts.Node): string {
        // A registered scene renders, its clear color at least, with no mesh.
        this.reachFeature("renderer:scene", node);
        if (scene.surfaceCanvas) {
            const task = this.ensureDefaultRenderTask(scene, node);
            return `${task.setup};\n        bbl::register_scene(${task.sceneCpp})`;
        }
        this.sceneRegistrationSite ??= node;
        return `bblscene::bbl_register_scene(${scene.cpp})`;
    }

    private finalizeSceneRegistration(): void {
        if (!this.sceneRegistrationSite) return;
        // Timing can be reached after registration, including inside callbacks.
        const task = this.features.has("engine:gpu-task-timing")
            ? this.ensureDefaultRenderTask(
                  { kind: "scene", cpp: "scene" },
                  this.sceneRegistrationSite,
              )
            : undefined;
        this.nativeEmission.registerNativeFunction(
            "void bbl_register_scene(bbl::Scene& scene);",
            [
                "void bbl_register_scene(bbl::Scene& scene) {",
                ...(task ? [`    ${task.setup};`] : []),
                `    bbl::register_scene(${task?.sceneCpp ?? "scene"});`,
                "}",
            ],
        );
    }

    public ensureDefaultRenderTask(
        scene: Value,
        node: ts.Node,
    ): DefaultRenderTaskEmission {
        this.reachFeature("renderer:scene", node);
        this.reachFeature("renderer:geometry-output", node);
        this.reachFeature("frame-graph:resources", node);
        this.reachFeature("frame-graph:target-disposal", node);
        if (!this.defaultRenderTaskAdapted) {
            this.nativeEmission.registerNativeFunction(
                "void bbl_ensure_default_render_task(bbl::Scene& scene);",
                [
                    "void bbl_ensure_default_render_task(bbl::Scene& scene) {",
                    '    if (!scene.engine) throw std::runtime_error("A scene render task requires its owning engine.");',
                    "    if (scene.state->default_render_task && scene.state->default_render_task_handle.value == bbl::invalid_handle) {",
                    "        auto& engine = *scene.engine;",
                    "        auto target = bbl::create_render_target(engine, " +
                        "bbl::RenderTargetOptions{scene.state->default_render_task_samples, true, true, false, 0u, 0u});",
                    "        auto resolve_target = bbl::create_render_target(engine, " +
                        "bbl::RenderTargetOptions{1u, true, false, false, 0u, 0u});",
                    `        ${recordAt("engine.render_targets", "target")}.surface_canvas = scene.surface_canvas;`,
                    `        ${recordAt("engine.render_targets", "resolve_target")}.surface_canvas = scene.surface_canvas;`,
                    "        // The readable attachments belong to the scene's default frame graph.",
                    "        scene.disposables.emplace_back([owner = scene.engine, target, resolve_target] {",
                    "            bbl::dispose_render_target(*owner, target);",
                    "            bbl::dispose_render_target(*owner, resolve_target);",
                    "        });",
                    "        auto render_task = bbl::create_render_task(engine, scene, " +
                        'bbl::RenderTaskOptions{"default-render-task", target, std::nullopt, true, ' +
                        `${handleCppType("camera")}{}, false, true, true, true});`,
                    "        bbl::add_task(scene, render_task);",
                    "        auto resolve_task = bbl::create_copy_to_texture_task(engine, scene, " +
                        'bbl::CopyTaskOptions{"default-resolve", bbl::render_target_texture(target), ' +
                        "bbl::RenderTargetHandle{}, resolve_target, false, bbl::NormalizedViewport{}});",
                    "        bbl::add_pass_after(*scene.state, resolve_task, render_task);",
                    "        auto present_task = bbl::create_copy_to_texture_task(engine, scene, " +
                        'bbl::CopyTaskOptions{"default-present", bbl::render_target_texture(resolve_target), ' +
                        "bbl::swapchain_render_target(engine), bbl::RenderTargetHandle{}, false, bbl::NormalizedViewport{}});",
                    "        bbl::add_pass_after(*scene.state, present_task, render_task);",
                    "        scene.state->default_render_task_handle = render_task;",
                    "    }",
                    "}",
                ],
            );
            this.defaultRenderTaskAdapted = true;
        }
        const sceneCpp = this.allocateTemporaryCppName("default_scene");
        return {
            sceneCpp,
            setup:
                `auto ${sceneCpp} = ${scene.cpp};\n` +
                `        bblscene::bbl_ensure_default_render_task(${sceneCpp})`,
        };
    }

    public importedName(identifier: ts.Identifier): string | undefined {
        return this.symbols.importedName(identifier);
    }

    /**
     * Large data-only loops are safe native loops. A loop that calls into the
     * pinned package is different: lowering those calls records composition,
     * baked simulation steps, assets, and other generation-owned state. Walk
     * local/imported helper calls too, so wrapping a pinned call does not
     * change whether the enclosing loop must be statically iterated.
     */
    public requiresStaticIteration(statement: ts.Statement): boolean {
        return requiresStaticLoopIteration(this, statement);
    }

    public eraseBrowserInstrumentation(position: number): void {
        this.erasedBrowserInstrumentation.add(position);
    }

    /**
     * A browser-erasure path dropped a write through `receiver`. Writes erased
     * by contract (`UiProjection.erasesByContract`) are consumed before the
     * assignment fallback; a path dropping a whole statement asks the same
     * question. With retained UI, any other write through a DOM element is
     * one no path represents.
     */
    public noteErasedElementWrite(
        receiver: ts.Expression,
        site: ts.Node,
    ): void {
        if (ts.isBinaryExpression(site) && this.ui.erasesByContract(site))
            return;
        const isElement = (expression: ts.Expression): boolean => {
            const type = this.checker.getNonNullableType(
                this.checker.getTypeAtLocation(expression),
            );
            return unionMembers(type).some((member) => {
                const symbol = member.getSymbol();
                return (
                    declaredInDomLibrary(symbol) &&
                    /^(?:Element|(?:HTML|SVG|MathML)\w*Element)$/.test(
                        symbol?.name ?? "",
                    )
                );
            });
        };
        // `element.dataset.key` and `element.style.color` write through the
        // element that owns the receiver.
        let owner: ts.Expression | undefined = receiver;
        while (owner) {
            const value = this.unwrap(owner);
            if (isElement(owner)) {
                this.erasedElementWrites.set(site.pos, {
                    site,
                    element: owner,
                });
                return;
            }
            owner =
                ts.isPropertyAccessExpression(value) ||
                ts.isElementAccessExpression(value)
                    ? value.expression
                    : undefined;
        }
    }

    /**
     * A program with retained UI projects its DOM elements natively, so a write
     * through an element the projection did not represent would vanish: it must
     * lower or refuse, never erase as browser instrumentation.
     */
    private refuseErasedElementWrites(): void {
        if (!this.features.has("ui:rml")) return;
        for (const { site, element } of this.erasedElementWrites.values())
            this.refuseLoweredSite(
                site,
                "A write through a DOM element that the retained UI does not represent cannot be erased in a program with retained UI.",
                element,
            );
    }

    public refuseLoweredSite(
        site: ts.Node,
        message: string,
        subject: ts.Node,
    ): void {
        this.surveyRefusal(
            site,
            this.refusal(site, message, "unsupported", subject),
        );
    }

    /**
     * A refusal at `site` decided outside its statement's lowering: a
     * survey's census records it against the statement holding `site`;
     * anywhere else (a plan included) it is the compile's.
     */
    private surveyRefusal(site: ts.Node, error: CompileError): void {
        const survey = activeStorageDemandPlanner()
            ? undefined
            : activeSurvey();
        const statement = ts.findAncestor(site, ts.isStatement);
        if (!survey || !statement) throw error;
        survey.refuseLowered(this.checker, statement, error);
    }

    public expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void {
        if (
            call.arguments.length < minimum ||
            call.arguments.length > maximum
        ) {
            const expected =
                minimum === maximum ? `${minimum}` : `${minimum}-${maximum}`;
            this.fail(
                call,
                `Expected ${expected} arguments, received ${call.arguments.length}.`,
            );
        }
    }

    public cppString(value: string): string {
        return stringLiteral(value);
    }

    public hasRegisteredScene(): boolean {
        return this.admissions.temporalSceneRegistration !== undefined;
    }

    public emit(line: string | NativeStatement): void {
        const code =
            typeof line === "string" ? line : nativeStatementCode(line);
        if (typeof line !== "string" && line.kind === "declaration") {
            const facts = nativeDeclarationFacts(line);
            const aliased =
                facts.type === undefined && facts.reference
                    ? this.nativeBindingTypes.get(line.initializer)
                    : undefined;
            // A declaration starts this local's storage facts. An earlier
            // speculative shared-cell description cannot type its new local.
            this.nativeBindingTypes.set(line.name, {
                type: facts.type?.replace(/^const /, "") ?? aliased?.type,
                constant: facts.constant || aliased?.constant === true,
                owned: facts.type !== undefined && !facts.reference,
            });
            line = {
                ...line,
                ...(nativeDeclarationDiscardIfUnused(line)
                    ? { discardIfUnused: true as const }
                    : {}),
                dependencies: [
                    ...(this.statementDependencies.at(-1) ?? []),
                ].map((binding) => binding.name),
            };
            this.nativeDeclarations.set(code, line);
        }
        const emitted = `${"    ".repeat(this.indentLevel)}${code}`;
        this.staticExpansionBudget.emit(emitted);
        this.body.push({
            statement:
                typeof line === "string"
                    ? { kind: "verbatim", code: line }
                    : line,
            indent: "    ".repeat(this.indentLevel),
            ...(this.emissionSource ? { source: this.emissionSource } : {}),
        });
    }

    /**
     * Whether lowering is at the entry body's own top level rather than
     * inside a block it opened. What it decides: a binding emitted here
     * lives as long as the frame loop, which is what the pinned
     * `setThinInstances` alias contract needs of the array it adopts.
     */
    public isEntryBodyScope(): boolean {
        return this.indentLevel === 2;
    }

    public increaseIndent(): void {
        this.indentLevel += 1;
        this.emissionBlocks.push(this.nextEmissionBlock++);
    }

    public decreaseIndent(): void {
        this.indentLevel -= 1;
        this.emissionBlocks.pop();
    }

    public functionEmissionScope(): import("./compiler/function-specializations.js").FunctionEmissionScope {
        return {
            lexical: this.bindings.variableScopes.at(-1)!,
            ...this.emissionMark(),
            continuation: this.engineLifecycle.engineStartMark?.index ?? -1,
        };
    }

    private renderCpp(features: Feature[]): ApplicationCpp {
        if (this.presentationHostCpp && !this.ui.presentationCanvasValue) {
            this.failAtFile(
                "An engine-less animation manager needs a reached primary Canvas2D surface for native presentation.",
            );
        }
        if (
            this.presentationHostCpp &&
            this.defaultEngineCpp !== this.presentationHostCpp
        ) {
            this.failAtFile(
                "A primary Canvas2D presentation host cannot also acquire a source-created GPU engine.",
            );
        }
        let physicsDebugConstructionBody: string[] | undefined;
        if (features.includes("physics:viewer")) {
            if (
                !this.engineLifecycle.engineStartMark ||
                this.options.workers ||
                this.presentationHostCpp ||
                this.engineLifecycle.engineStartMark.indentLevel !== 2
            ) {
                this.failAtFile(
                    "Physics debug geometry extraction requires one top-level startEngine after the admitted construction graph.",
                );
            }
            physicsDebugConstructionBody = this.body
                .slice(0, this.engineLifecycle.engineStartMark.index)
                .map(renderNativeEmission);
        }
        this.engineLifecycle.hoistEngineContinuation();
        if (
            this.body.some(
                (line) =>
                    renderNativeEmission(line).trim() ===
                    EngineLifecycle.frameYieldRequeueMarker,
            )
        ) {
            this.failAtFile(
                "A frame-yield re-queue marker survived outside the " +
                    "hoisted continuation; the frame boundary it parks " +
                    "the rest of the continuation behind was never " +
                    "emitted.",
            );
        }
        if (
            this.body.some((line) =>
                renderNativeEmission(line)
                    .trim()
                    .startsWith(EngineLifecycle.startContinuationGatePrefix),
            )
        ) {
            this.failAtFile(
                "A gated continuation marker survived outside the " +
                    "hoisted continuation; the latch it parks the rest " +
                    "of the continuation behind was never emitted.",
            );
        }
        const body = this.outlineNativeBody(this.body, [
            ...(this.audioSessionReached
                ? [
                      {
                          name: "bbl_audio_session",
                          type: "std::shared_ptr<bbl::pal::AudioSession>",
                      },
                  ]
                : []),
            ...(this.presentationHostCpp
                ? [{ name: this.presentationHostCpp, type: "bbl::Engine" }]
                : []),
        ]).map(renderNativeEmission);
        // The worker runtime declares the messaging objects storage holds.
        if (!this.options.workers && this.dataTypes.usesWorkerStorage())
            throw new ApplicationRealmRequired();
        return renderMainCpp({
            source: this.options.fileName,
            ...(this.options.workers
                ? {
                      workers: {
                          namespace: this.options.workers.namespace,
                          declarations: this.options.workers.declarations(),
                          hasEngine: this.defaultEngineCpp !== undefined,
                          waitForCanvasReady: this.ui.windowCanvasReadyGate,
                          ...(features.includes("platform:window")
                              ? {
                                    windowOptions: `bbl::EngineOptions{${this.cppString(this.options.title)}, ${this.options.width}, ${this.options.height}}`,
                                }
                              : {}),
                      },
                  }
                : {}),
            features,
            jsDataReached: this.jsDataReached,
            deferredCapabilitiesReached:
                this.deferredCapabilities.sites.length > 0,
            windowStorageReached: this.dataTypes.usesWindowStorage(),
            responseStorageReached: this.dataTypes.usesResponseStorage(),
            webPlatformHeaders: this.dataTypes.webPlatformHeaders(),
            imageDecodeReached: this.imageDecodeReached,
            runtimeMeshProfiles: this.sceneManifest.hasRuntimeMeshProfiles(),
            jsRandomReached: this.jsRandomReached,
            audioSessionReached: this.audioSessionReached,
            continuationStorageReached:
                this.engineLifecycle.continuationStorageReached,
            pendingActivations: !!this.options.pendingActivations,
            throwReached: this.throwReached,
            postProcessCompositeCount:
                this.sceneManifest.postProcessComposites.length,
            screenSpaceTaskCount: this.sceneManifest.screenSpaceTasks.length,
            renderMaterialFunctions: () =>
                this.sceneManifest.materialFunctionsCpp(),
            // Worker messages and IndexedDB values clone records field by field.
            renderDataPreamble: () =>
                this.dataTypes.renderPreamble(
                    !!this.options.workers ||
                        features.includes("storage:indexeddb"),
                ),
            nativeFunctions: this.nativeEmission.nativeDefinitions,
            nativeDeclarations: this.nativeDeclarations,
            staticNativeDeclarations:
                this.nativeEmission.staticNativeDeclarations,
            ...(physicsDebugConstructionBody
                ? { physicsDebugConstructionBody }
                : {}),
            body: this.presentationHostCpp
                ? [
                      `        auto ${this.presentationHostCpp} = bbl::create_engine(bbl::EngineOptions{${this.cppString(this.options.title)}, ${this.options.width}, ${this.options.height}});`,
                      ...body,
                      `        bbl::start_engine(${this.presentationHostCpp});`,
                  ]
                : body,
        });
    }

    public fail(
        node: ts.Node,
        message: string,
        reason: CompileError["reason"] = "unsupported",
    ): never {
        throw this.refusal(node, message, reason, node);
    }

    /**
     * A refusal the storage `demand` names would lower: a committed lowering
     * replays with it; a probe refuses, and the demand replays once the
     * refusal leaves every probe (`probeEmission`).
     */
    public refuseWithDemand(
        node: ts.Node,
        message: string,
        demand: StorageDemand,
    ): never {
        if (!this.speculating) throw demand;
        const refusal = this.refusal(node, message, "unsupported", node);
        refusal.demand = demand;
        throw refusal;
    }

    private refusal(
        site: ts.Node,
        message: string,
        reason: CompileError["reason"],
        subject: ts.Node,
    ): CompileError {
        const { file, line, character } = sourceLocation(site);
        return new CompileError(
            file === this.sourceFile ? this.options.fileName : file.fileName,
            line,
            character,
            message,
            reason,
            subject,
        );
    }

    public failAtFile(message: string): never {
        const site = this.failureSite ?? {
            file: this.options.fileName,
            line: 1,
        };
        throw new CompileError(site.file, site.line, 1, message);
    }

    /** Where a refusal without a source node points: the entry otherwise. */
    @journaled private accessor failureSite: RefusalSite | undefined;

    /**
     * Run `materialize` with refusals that have no source node pointing at
     * `site`, whose line the caller may advance as it walks a host file.
     */
    public attributeRefusalsTo<T>(site: RefusalSite, materialize: () => T): T {
        const previous = this.failureSite;
        this.failureSite = site;
        try {
            return materialize();
        } finally {
            this.failureSite = previous;
        }
    }
}
