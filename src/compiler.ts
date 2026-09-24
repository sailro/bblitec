import {
    assetRootMutationStates,
    isStringValue,
    optionalPresentCpp,
    presenceCpp,
    presenceFlagCpp,
    valueForKind,
} from "./compiler/types.js";
import {
    forEachAnalysisNode,
    findAnalysisNodeWithState,
    someAnalysisNode,
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
    NativeFunctionBodyOptions,
    NativeReturnValueCompiler,
} from "./compiler/lowering-services.js";
import { SharedNativeFunctions } from "./compiler/shared-native-functions.js";
import type {
    ApplicationCpp,
    NativeFunctionDefinition,
} from "./compiler/source-units.js";
import {
    renderNativeDeclaration,
    type NativeDeclaration,
} from "./compiler/native-declarations.js";
import { persistContinuationLocals } from "./compiler/continuation-storage.js";
import ts from "typescript";
import {
    traceSourceApplication,
    traceSourceProgram,
    traceSourceNode,
} from "./compiler/source-trace.js";
import {
    activeSurvey,
    SurveyCollector,
    withSurvey,
    type SurveyReport,
} from "./compiler/survey.js";
import { isJsonValue } from "./compiler/json-bridge.js";
import { DynamicBindingStorageRequired } from "./compiler/dynamic-binding-storage.js";
import {
    NativeRecordStorageRequired,
    type NativeRecordStorageDemand,
} from "./compiler/native-record-storage.js";
import { resolve } from "node:path";
import { framePollExecutor } from "./compiler/frame-poll.js";
import { PendingActivations } from "./compiler/pending-activations.js";
import { reachPhysicsViewerMaterialProgram } from "./compiler/physics-viewer-material.js";
import {
    compileTextModuleValue,
    compileTextMutation,
} from "./compiler/text-surface.js";
import { promoteLiveTextData } from "./compiler/intrinsics/text.js";
import { compileNodeInputMutation } from "./compiler/node-input-surface.js";
import { checkNodeGeometryMutation } from "./compiler/node-geometry-admission.js";
import {
    compileWorkerApplication,
    usesWorkers,
    ApplicationRealmRequired,
} from "./compiler/worker-modules.js";
import {
    compileWorkerValue,
    isNativeWorkerExpression,
} from "./compiler/workers.js";
import { compileCanvasValue, emitCanvasAssignment } from "./compiler/canvas.js";
import {
    compileWindowIdentity,
    emitWindowLocationAssignment,
} from "./compiler/window-events.js";
import { RuntimeSearchParamsRequired } from "./compiler/search-params.js";
import { WindowProperties } from "./compiler/window-properties.js";
import { AsyncLowerer, PendingActivationsRequired } from "./compiler/async.js";
import { sourceLocation } from "./source-location.js";
import {
    cppIdentifierPattern,
    sanitizeCppIdentifier,
    stringLiteral,
} from "./cpp-literals.js";
import { compileAdaptations } from "./compiler/adaptations.js";
import {
    emitPropertyAssignment,
    emitStructuralPropertyAssignment,
} from "./compiler/assignments.js";
import {
    probePixelsAsset,
    registerAsset,
    registerSpriteAtlasAsset,
    resolveBundledAsset,
} from "./compiler/assets.js";
import {
    compileStaticFetch,
    compileStaticFetchMethod,
} from "./compiler/static-fetch.js";
import {
    BrowserErasure,
    browserEnvironmentValue,
} from "./compiler/browser-erasure.js";
import {
    deploymentEnvironment,
    deploymentPublicUrl,
    deploymentUrl,
} from "./compiler/deployment.js";
import { browserGeneratedString } from "./compiler/browser-generated-string.js";
import { compileBrowserTextureFunctionCall } from "./compiler/browser-texture-function.js";
import { compileExecutedUrlFunctionCall } from "./compiler/executed-url-function.js";
import {
    compileDdsEnvironmentBackgroundOptions,
    compileDdsEnvironmentOptions,
    compileEnvironmentOptions,
    compileHdrEnvironmentOptions,
} from "./compiler/intrinsics/asset-options.js";
import {
    compileCopyTaskOptions,
    compileEnginePixelRatioCap,
    compileEnginePrecisionPolicy,
    compileGeometryTaskOptions,
    compileRenderTargetOptions,
    compileRenderTaskOptions,
    compileSceneDefaultRenderTask,
    type CompiledRenderTargetOptions,
} from "./compiler/intrinsics/engine-options.js";
import {
    compileAnisotropyOptions,
    compileClearCoatOptions,
    compileIridescenceOptions,
    compileMetallicReflectanceOptions,
    compilePbrMaterialOptions,
    compileSheenOptions,
    compileSubsurfaceOptions,
    type CompiledAnisotropyOptions,
    type CompiledClearCoatOptions,
    type CompiledIridescenceOptions,
    type CompiledMetallicReflectanceOptions,
    type CompiledPbrMaterialOptions,
    type CompiledSheenOptions,
    type CompiledSubsurfaceOptions,
} from "./compiler/intrinsics/material-options.js";
import {
    compileBoxOptions,
    compileGroundFromHeightMapOptions,
    compileGroundOptions,
    compilePlaneOptions,
    compileSphereOptions,
    compileTorusOptions,
} from "./compiler/intrinsics/mesh-options.js";
import {
    compileRegisteredConstant,
    compileRegisteredIntrinsic,
} from "./compiler/intrinsics/registry.js";
import {
    selectedStaticExpression,
    selectedStaticNumberValue,
    staticNumberValue,
    validateObjectProperties,
} from "./compiler/option-helpers.js";
import {
    PropertyAnimationTargetLowerer,
    compilePropertyAnimationClip,
    compilePropertyAnimationGroupOptions,
} from "./compiler/property-animation.js";
import {
    compileNodeMaterialOptions,
    type CompiledNodeMaterialCall,
} from "./compiler/node-material.js";
import {
    lineMaterialPermutation,
    reachLineMaterialProgram,
    type LineMaterialPermutation,
    type ReachedLineMaterial,
} from "./compiler/line-material.js";
import { reachLinearDepthMaterialProgram } from "./compiler/linear-depth-material.js";
import {
    reachGridMaterial,
    type ReachedGridMaterial,
} from "./compiler/grid-material.js";
import type { LinearDepthMaterialOptions } from "./lowering/linear-depth-lowerer.js";
import {
    executeApplicationFunction,
    type ExecutedScalar,
} from "./compiler/executed-application-function.js";
import { liftWgslModuleConstant } from "./shader-ir.js";
import {
    compileShaderMaterialOptions,
    compileShaderUniformComponents,
    resolveShaderStorageBufferSlot,
    resolveShaderTextureSlot,
    resolveShaderUniform,
} from "./compiler/shader-material.js";
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
    isPinnedType,
    opaqueEngineValue,
    pinnedHandleKind,
    type DataIterationElement,
    type DataType,
    type TypedArrayKind,
} from "./compiler/data-types.js";
import {
    ExpressionLowerer,
    PURE_NUMBER_FORMATTERS,
} from "./compiler/expressions.js";
import { NativeFunctionLowerer } from "./compiler/native-functions.js";
import {
    emitReachableStatements,
    firstReturn,
} from "./compiler/loop-control.js";
import {
    collectReboundSymbols,
    isModuleInitializerStatement,
    planEntryModuleState,
    planImportedModuleInitializers,
} from "./compiler/module-initializers.js";
import { compileSpriteAtlasRecord } from "./compiler/sprite-atlas-record.js";
import type { AssetDecoderConfiguration } from "./asset-decoders.js";
import { createCompilerProgram } from "./compiler/program.js";
import { PropertyAccessLowerer } from "./compiler/properties.js";
import {
    CompilerSymbols,
    declaredIn,
    declaredInDomLibrary,
    resolvedSymbol,
    type DeclarationOrigin,
} from "./compiler/symbols.js";
import { isNullable, presentMembers } from "./compiler/type-facts.js";
import { StaticEvaluator } from "./compiler/static-evaluator.js";
import { StatementLowerer } from "./compiler/statements.js";
import {
    HandleCollections,
    type HandleCollectionTarget,
} from "./compiler/handle-collections.js";
import {
    UserFunctionLowerer,
    aliasedMutationScan,
    callArgumentIsReadOnly,
    isSupportedFunction,
    parameterIsReadOnly,
    resolveFunctionDeclaration,
    retainedNativeMutationTarget,
    tryResolveFunctionDeclaration,
    writesThroughTrackedRoot,
    type AliasedMutationScan,
    type SupportedFunction,
    type CallbackInvocationOptions,
} from "./compiler/user-functions.js";
import {
    argumentAt,
    identifierText,
    isAssignmentExpression,
    isUpdateExpression,
    objectProperty,
    rootIdentifier,
    stringLiteralText,
    unwrapExpression,
    unwrappedIdentifier,
} from "./compiler/syntax.js";
import { CompileError } from "./compiler/compile-error.js";
import { mutatingArrayMethods } from "./compiler/data-methods.js";
import {
    ClosureCaptures,
    nativeCompanionKeys,
    renderCoroutineInvocation,
    type CapturedClosure,
    type NativeCaptureBinding,
} from "./compiler/closure-captures.js";
import {
    parameterizedResourceLoop,
    requiresStaticDataIteration,
    canShareFunctionBody,
    sharedFunctionHasCallEffects,
    requiresStaticLoopIteration,
    runtimeProfileConstructionIntrinsics,
    type ParameterizedResourceLoop,
    type ResourceLoop,
} from "./compiler/resource-loops.js";
import { StaticExpansionBudget } from "./compiler/static-expansion.js";
import type {
    CollectionCardinality,
    CompileAsset,
    CompileOptions,
    CompileResult,
    DefaultRenderTaskEmission,
    Feature,
    FrameCallbackSignature,
    GeometryOutputTaskManifest,
    ResolvedCompileOptions,
    Value,
    ValueKind,
    VariableBinding,
} from "./compiler/types.js";
import { isCompileTimeOnlyValue } from "./compiler/types.js";
import { ClassLowerer } from "./compiler/classes.js";
import { ClassHierarchy } from "./compiler/class-members.js";
import {
    assertDeterministicRandomUnreached,
    isDeterministicRandomRead,
} from "./compiler/deterministic-random.js";
import {
    physicsEventInfoType,
    physicsEventInfoValue,
} from "./compiler/intrinsics/physics.js";
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
import {
    BindingScopes,
    valueContainsPlatformEvent,
} from "./compiler/binding-scopes.js";
import { ConditionLowerer } from "./compiler/conditions.js";
import { DeclarationLowerer } from "./compiler/declarations.js";
import { PlatformCalls } from "./compiler/platform-calls.js";
import { UiProjection } from "./compiler/ui-projection.js";
import { recordAt } from "./compiler/record-access.js";

export type {
    CompileAsset,
    CompileOptions,
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
): boolean {
    return (
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

const NULLABLE_UI_ELEMENT = {
    origin: "dom",
    kind: "ui-element",
    cppType: handleCppType("ui-element"),
} as const;

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
    { origin: DeclarationOrigin; kind: ValueKind; cppType: string }
>([
    [
        "AudioEngine",
        {
            origin: "babylon",
            kind: "audio-engine",
            cppType: "bbl::pal::AudioContextHandle",
        },
    ],
    [
        "SpriteRenderer",
        {
            origin: "babylon",
            kind: "sprite-renderer",
            cppType: "bbl::SpriteRendererHandle",
        },
    ],
    [
        "AssetContainer",
        { origin: "babylon", kind: "asset", cppType: handleCppType("asset") },
    ],
    // The element interfaces a scene declares empty and fills from a lookup.
    ["Element", NULLABLE_UI_ELEMENT],
    ["HTMLElement", NULLABLE_UI_ELEMENT],
    ["HTMLDivElement", NULLABLE_UI_ELEMENT],
    ["HTMLCanvasElement", NULLABLE_UI_ELEMENT],
]);

/**
 * The two VAT rows, kept in their own table because they are classified
 * AFTER the data model has been asked about the type.
 *
 * `fromTsType` is not a pure classifier -- reaching it can register a
 * native record for the type it is handed -- so moving these two names in
 * front of it would silently withdraw that call. They stay where they are.
 *
 * `VatHandle`: `let handle: VatHandle | null = null` then a guarded
 * assignment inside the "did the asset carry a skinned mesh and clips" arm,
 * the shape both VAT scenes are written in. `VatClip`: `let swim: VatClip |
 * null = null` then the guarded row read, the per-instance scene's shape for
 * holding one clip's row block. Both are pinned types.
 */
const NULLABLE_VAT_RESOURCE_TYPES = new EmissionMap<
    string,
    { kind: ValueKind; cppType: string }
>([
    ["VatHandle", { kind: "vat-handle", cppType: "bbl::VatHandle" }],
    ["VatClip", { kind: "vat-clip", cppType: "bbl::VatClipRow" }],
]);

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

/** Whether a node is written inside another. */
function isDeclaredInside(node: ts.Node, target: ts.Node | undefined): boolean {
    return (
        target !== undefined &&
        ts.findAncestor(node, (owner) => owner === target) !== undefined
    );
}

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

export function compileSource(
    source: string,
    options: CompileOptions = {},
): CompileResult {
    return traceSourceApplication(() =>
        compileSourceApplication(source, options),
    );
}

export interface SurveyOutcome {
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
): SurveyOutcome {
    const collector = new SurveyCollector();
    return withSurvey(collector, () => {
        try {
            const result = compileSourceApplication(source, options);
            return { report: collector.report(), result };
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            return { report: collector.report(error.message) };
        }
    });
}

function compileSourceApplication(
    source: string,
    options: CompileOptions,
): CompileResult {
    const fileName = options.fileName ?? "input.ts";
    const environment = deploymentEnvironment(options);
    const frontend = createCompilerProgram(source, fileName);
    const survey = activeSurvey();
    const compile = (
        input: typeof frontend,
        workers?: ResolvedCompileOptions["workers"],
    ): CompileResult => {
        const resolved: ResolvedCompileOptions = {
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
            ...(options.nativeHostUi && !workers?.namespace
                ? { nativeHostUi: options.nativeHostUi }
                : {}),
        };
        // Each demand belongs to a source binding, not its spelling. Reuse the
        // frontend and rebuild emission so earlier aliases use the same storage.
        const dynamicBindings = new Map<
            ts.VariableDeclaration,
            DataType | undefined
        >();
        const ownedRecords = new Map<
            NativeRecordStorageDemand["identity"],
            NativeRecordStorageDemand
        >();
        // A replay lowers the realm again from the start, so a survey keeps
        // only the attempt that ran to the end.
        const lower = (): CompileResult => {
            const compiler = new Compiler(
                input.program,
                input.sourceFile,
                input.checker,
                resolved,
                dynamicBindings,
                ownedRecords,
            );
            const result = traceSourceProgram(input.program, () =>
                compiler.compile(),
            );
            result.manifest.inputs = input.localFiles;
            return result;
        };
        for (;;) {
            try {
                return survey
                    ? survey.attempt(input.sourceFile.fileName, lower)
                    : lower();
            } catch (error) {
                if (
                    error instanceof DynamicBindingStorageRequired &&
                    (!dynamicBindings.has(error.declaration) ||
                        (error.dataType &&
                            !dynamicBindings.get(error.declaration)))
                ) {
                    dynamicBindings.set(error.declaration, error.dataType);
                } else if (
                    error instanceof NativeRecordStorageRequired &&
                    !ownedRecords.has(error.demand.identity)
                ) {
                    ownedRecords.set(error.demand.identity, error.demand);
                } else if (
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
                } else throw error;
            }
        }
    };
    const application = () =>
        compileWorkerApplication(frontend, compile, (node, message) => {
            const { file, line, character } = sourceLocation(node);
            throw new CompileError(file.fileName, line, character, message);
        });
    if (usesWorkers(frontend)) return application();
    try {
        return compile(frontend);
    } catch (error) {
        if (!(error instanceof ApplicationRealmRequired)) throw error;
        return application();
    }
}

interface SharedClosureBindings {
    captured: ReadonlySet<ts.Symbol>;
    forwarded: ReadonlySet<ts.Symbol>;
}

class Compiler implements LoweringServices {
    public readonly symbols: CompilerSymbols;
    public readonly evaluator: StaticEvaluator;
    /** The handle-collection concept: every collection operation. */
    public readonly handleCollections: HandleCollections =
        new HandleCollections(this);
    /** The scene composition records this compilation projects into its manifest. */
    public readonly sceneManifest: SceneManifestRecorder =
        new SceneManifestRecorder(this);
    /** The lexical scope stack: every source name's current binding. */
    public readonly bindings: BindingScopes = new BindingScopes(this);
    /** The C++ truth test of a source condition. */
    public readonly conditions: ConditionLowerer = new ConditionLowerer(this);
    /** Variable declarations and binding patterns. */
    public readonly declarations: DeclarationLowerer = new DeclarationLowerer(
        this,
    );
    /** Property access on every represented owner. */
    public readonly propertyAccess: PropertyAccessLowerer =
        new PropertyAccessLowerer(this);
    private readonly statements = new StatementLowerer();
    public readonly userFunctions: UserFunctionLowerer;
    public readonly ui: UiProjection = new UiProjection(this);
    private readonly platform = new PlatformCalls(this, this.ui);
    public get uiDegradedStyleProperties(): Set<string> {
        return this.ui.uiDegradedStyleProperties;
    }
    public get uiScopedSheetSelectors(): Set<string> {
        return this.ui.uiScopedSheetSelectors;
    }
    private readonly asyncLowerer = new AsyncLowerer(this);
    public readonly windowProperties: WindowProperties = new WindowProperties(
        this,
    );
    public readonly dataTypes: DataTypeRegistry;
    public readonly dataLowerer: DataLowerer;
    public readonly classLowerer: ClassLowerer;
    public readonly nativeFunctions: NativeFunctionLowerer;
    public readonly browserErasure: BrowserErasure;
    /** One rebound-name walk per file, shared by every `identifierIsRebound`. */
    private readonly reboundSymbolsByFile = new EmissionMap<
        ts.SourceFile,
        ReadonlySet<ts.Symbol>
    >();
    private readonly sharedClosureSymbols = new EmissionWeakMap<
        ts.Node,
        SharedClosureBindings
    >();
    @journaled private accessor staticAssetUrlCandidateCache:
        readonly string[] | undefined;
    private readonly expressions: ExpressionLowerer;
    private readonly nativeDefinitions =
        emissionArray<NativeFunctionDefinition>();
    private readonly sharedNativeFunctions = new SharedNativeFunctions();
    private readonly staticNativeDeclarations: string[] = emissionArray([]);
    private readonly returnFrames: Array<
        | ({
              kind: "native";
              type: DataType | "void";
              contextualVoid?: boolean;
          } & NativeFunctionBodyOptions)
        | { kind: "inline"; wrapped: boolean }
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
    @journaled public accessor jsDataReached = false;
    @journaled public accessor fileReaderReached = false;
    /** Whether the entry body itself decodes an image (drawn-atlas records). */
    @journaled public accessor imageDecodeReached = false;
    @journaled public accessor jsRandomReached = false;
    @journaled private accessor audioSessionReached = false;
    /**
     * The bounded canvas-owning functions this compilation executed at
     * generation, by name. It is the fidelity adaptation's reach test: the
     * assets they produce are ordinary data-URL payloads by the time they
     * reach the manifest, so nothing downstream can tell them apart.
     */
    public readonly browserTextureFunctions = new EmissionSet<string>();
    public readonly canvasReadbackFunctions = new EmissionSet<string>();
    /** Whether a scene threw one of its own preconditions. */
    @journaled public accessor throwReached = false;
    public readonly staticConstants = new EmissionMap<
        ts.Symbol,
        ts.Expression
    >();
    private readonly sourceCppNames = new EmissionSet<string>();
    private readonly features = new EmissionSet<Feature>(["core"]);
    private readonly featureSites = new EmissionMap<Feature, string>();
    public readonly assets = new EmissionMap<string, CompileAsset>();
    public readonly assetPayloads = new EmissionMap<string, string>();
    private readonly assetDecoders = new EmissionMap<
        "configuration",
        AssetDecoderConfiguration
    >();
    private readonly decoderBootstrapDepths: number[] = emissionArray([]);
    /** The source-keyed record for the most recent `loadGltf` call. */
    @journaled private accessor lastGltfContainerAsset:
        CompileAsset | undefined;
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
        ts.ClassDeclaration
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
    private readonly nativeBindingTypes = new EmissionMap<string, string>();
    private readonly allocatedCppNames = new EmissionMap<string, number>();
    private readonly nativeTemporaries =
        new EmissionWeakSet<NativeCaptureBinding>();
    private readonly nativeConstBindings =
        new EmissionWeakSet<NativeCaptureBinding>();
    private readonly nativeStoredValues = new EmissionWeakSet<Value>();
    private readonly nativeDependencyStack: Set<NativeCaptureBinding>[] =
        emissionArray([]);
    private readonly realmEngineCaptures = new EmissionMap<
        string,
        readonly NativeCaptureBinding[]
    >();
    private readonly managedCaptures: ClosureCaptures[] = emissionArray([]);
    private readonly body: string[] = emissionArray([]);
    private readonly nativeDeclarations = new EmissionMap<
        string,
        NativeDeclaration
    >();
    private readonly statementDependencies: Set<NativeCaptureBinding>[] =
        emissionArray([]);
    private readonly continuationUses = new EmissionMap<string, Set<number>>();
    private readonly continuationLocals = new EmissionMap<string, number>();
    @journaled private accessor continuationSequence = 0;
    /**
     * Collision listeners are registered before every startup assignment has
     * necessarily run. Their native bodies are specialized only after the
     * entry walk is complete, while retaining registration-site scopes.
     */
    private readonly deferredPhysicsCallbacks: Array<{
        /** Which pinned event stream the handler is registered on. */
        event: "collision" | "trigger" | "character";
        callback: ts.Identifier | ts.ArrowFunction | ts.FunctionExpression;
        cppName: string;
        eventName: string;
        node: ts.Node;
        scopes: ReadonlyArray<Map<ts.Symbol, VariableBinding>>;
    }> = emissionArray([]);
    public readonly erasedBrowserExpressions = new EmissionSet<number>();
    public readonly erasedBrowserInstrumentation = new EmissionSet<number>();
    public readonly unwrappedAwaitExpressions = new EmissionSet<number>();
    private readonly untrackedTaaCameraWrites: Array<{
        node: ts.Node;
        reason: string;
        cameraVersionSafe?: true;
    }> = emissionArray([]);
    private readonly deferredAdmissionFailures: Array<{
        capability:
            | "taa"
            | "text"
            | "node-input"
            | "node-geometry"
            | "material-colors"
            | "diffuseColor";
        node: ts.Node;
        message: string;
    }> = emissionArray([]);
    private readonly materialColorReads: Array<
        "baseColorFactor" | "diffuseColor"
    > = emissionArray([]);
    @journaled private accessor temporalSceneRegistration: ts.Node | undefined;
    private readonly temporalRegisteredScenes: Array<
        Value["sceneTopologyState"]
    > = emissionArray([]);
    @journaled private accessor temporalControlAttachment: ts.Node | undefined;
    public readonly localCubemapState: { maxCandidates?: number } =
        emissionRecord({});
    /** `constArrayIsWritten` answers, by binding: the scan walks a file. */
    private readonly writtenConstArrays = new EmissionMap<ts.Symbol, boolean>();
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
    @journaled private accessor indentLevel = 2;
    private readonly emissionBlocks = emissionArray([0]);
    @journaled private accessor nextEmissionBlock = 1;
    @journaled private accessor temporaryIndex = 0;
    @journaled public accessor defaultRenderTaskAdapted = false;
    @journaled private accessor sceneRegistrationSite: ts.Node | undefined;

    public constructor(
        private readonly program: ts.Program,
        public readonly sourceFile: ts.SourceFile,
        public readonly checker: ts.TypeChecker,
        public readonly options: ResolvedCompileOptions,
        public readonly dynamicBindings: ReadonlyMap<
            ts.VariableDeclaration,
            DataType | undefined
        >,
        private readonly ownedRecords: ReadonlyMap<
            NativeRecordStorageDemand["identity"],
            NativeRecordStorageDemand
        >,
    ) {
        this.symbols = new CompilerSymbols(checker);
        this.userFunctions = new UserFunctionLowerer(checker);
        this.dataTypes = new DataTypeRegistry(
            checker,
            (node, message) => this.fail(node, message),
            new ClassHierarchy(checker, program),
            options.workers !== undefined,
        );
        this.dataLowerer = new DataLowerer(this);
        this.classLowerer = new ClassLowerer(this);
        this.nativeFunctions = new NativeFunctionLowerer(this);
        this.browserErasure = new BrowserErasure(this);
        this.expressions = new ExpressionLowerer(this);
        this.evaluator = new StaticEvaluator(
            this.staticConstants,
            this.checker,
            (identifier) => this.symbols.valueSymbol(identifier),
            (expression) =>
                compileCanvasValue(this, expression) ??
                this.canvasSizeValue(expression) ??
                this.enumMemberValue(expression) ??
                this.dataLowerer.compileDataPath(expression, "read") ??
                this.propertyAccess.lookupRecordProperty(expression) ??
                this.propertyAccess.compilePropertyAccess(expression),
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
            (expression) => this.unwrappedAwaitExpressions.add(expression.pos),
            () => this.reachJsData(),
            (value, arity) => this.bindings.bindDataTuple(value, arity),
            (expression) => this.symbols.pinnedWgslTemplate(expression),
            (value) => this.dataLowerer.truthinessCondition(value),
        );
    }

    public compile(): CompileResult {
        // The session is emitted at entry scope when reached, even if its first
        // use occurs while compiling a nested coroutine or callback.
        this.registerNativeBinding("bbl_audio_session");
        if (this.options.workers)
            this.reachFeature("platform:workers", this.sourceFile);
        this.dataTypes.registerPartialRecords(this.program.getSourceFiles());
        this.collectSourceCppNames();
        this.collectStaticConstants();
        this.predeclareStoredObjectReferences();
        this.emitImportedModuleInitializers();
        const entry = this.entryStatements();
        this.emitEntryModuleState(entry);
        this.emitEntryBody(entry);
        this.finalizeSceneRegistration();
        if (this.features.has("engine:device-recovery")) {
            if (
                this.features.has("platform:workers") ||
                this.features.has("platform:window")
            )
                this.fail(
                    this.sourceFile,
                    "Device recovery does not represent shared worker/offscreen device ownership.",
                );
            if (this.temporalRegisteredScenes.length > 1)
                this.fail(
                    this.sourceFile,
                    "Device recovery resource observations currently require one registered scene.",
                );
        }
        if (
            this.sceneManifest.reachedNodeMaterials.length > 0 &&
            this.sceneManifest.geometryOutputTasks.length > 0 &&
            this.features.has("loader:gltf")
        ) {
            const boundary = this.deferredAdmissionFailures.find(
                (failure) => failure.capability === "node-geometry",
            );
            if (boundary) this.fail(boundary.node, boundary.message);
            if (this.features.has("animation:property"))
                this.fail(
                    this.sourceFile,
                    "Node geometry views with glTF do not represent property-animation transform producers.",
                );
        }
        if (this.features.has("material:node")) {
            const admission = this.deferredAdmissionFailures.find(
                (failure) => failure.capability === "node-input",
            );
            if (admission) this.fail(admission.node, admission.message);
            if (
                this.features.has("material:node-inputs") &&
                this.temporalRegisteredScenes.length > 1
            )
                this.fail(
                    this.sourceFile,
                    "Node input bindings support one registered scene until per-scene binding snapshots are represented.",
                );
        }
        const colorAdmission = this.materialColorReads.includes("diffuseColor")
            ? this.deferredAdmissionFailures.find(
                  (failure) => failure.capability === "diffuseColor",
              )
            : undefined;
        if (colorAdmission)
            this.fail(colorAdmission.node, colorAdmission.message);
        if (this.materialColorReads.length) {
            const boundary = this.deferredAdmissionFailures.find(
                (failure) => failure.capability === "material-colors",
            );
            if (boundary) this.fail(boundary.node, boundary.message);
            if (this.temporalRegisteredScenes.length > 1)
                this.fail(
                    this.sourceFile,
                    "Numeric material-color reads currently support one registered scene; independent material-group UBO snapshots are not represented.",
                );
        }
        if (this.features.has("text:renderable")) {
            const camera =
                this.textCameraMutation ??
                this.untrackedTaaCameraWrites[0]?.node;
            if (camera)
                this.fail(
                    camera,
                    "Text currently requires a static camera; live camera writers and controls are not represented.",
                );
            if (this.temporalRegisteredScenes.length > 1)
                this.fail(
                    this.sourceFile,
                    "Text currently supports one registered scene; layered text update/draw ordering is not represented.",
                );
            const admission = this.deferredAdmissionFailures.find(
                (failure) => failure.capability === "text",
            );
            if (admission) this.fail(admission.node, admission.message);
        }
        if (this.features.has("camera:world-matrix-version")) {
            const unsupported = this.untrackedTaaCameraWrites.find(
                (write) => !write.cameraVersionSafe,
            );
            if (unsupported)
                this.fail(
                    unsupported.node,
                    `Camera worldMatrixVersion requires tracked mutations: ${unsupported.reason}.`,
                );
        }
        if (
            this.sceneManifest.postProcessComposites.some(
                (composite) =>
                    composite.intrinsic === "createTaaPostProcessTask",
            )
        ) {
            const unsupported = this.untrackedTaaCameraWrites[0];
            if (unsupported)
                this.fail(
                    unsupported.node,
                    `TAA requires tracked camera mutations: ${unsupported.reason}.`,
                );
            const admission = this.deferredAdmissionFailures.find(
                (failure) => failure.capability === "taa",
            );
            if (admission) this.fail(admission.node, admission.message);
        }
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
        this.refuseUiWithoutPresentation();
        this.ui.validateUiStaticProjection();

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
            manifest: {
                source: this.options.fileName,
                // The compiler's half of the reached-file list is the
                // program's, filled in by `compileSource`; generation
                // appends the files it reads beside the program.
                inputs: [],
                features,
                ...(this.engineMsaaSamples !== undefined
                    ? { engineMsaaSamples: this.engineMsaaSamples }
                    : {}),
                featureSites,
                runtimeSources,
                generatedSources,
                sourceUnits: application.sourceUnits,
                assets: [...this.assets.values()],
                ...(this.assetDecoders.has("configuration")
                    ? {
                          assetDecoders:
                              this.assetDecoders.get("configuration")!,
                      }
                    : {}),
                ...this.sceneManifest.manifestRecords(
                    compileAdaptations(this, features),
                ),
            },
        };
    }

    /**
     * Materialize an audited host-page companion into the same retained UI IR
     * as scene-created DOM. The registered scene supplies this data because
     * the immutable TypeScript module cannot observe elements owned by its
     * browser HTML host in a native process.
     */
    public readonly pendingHostUiLookups: Value[] = emissionArray([]);

    private emitNativeHostUi(): void {
        const emitted = this.ui.compileHostUi();
        const insertion = this.options.workers
            ? 0
            : (this.engineCreationInsertion ?? this.body.length);
        this.body.splice(insertion, 0, ...emitted);
    }

    /**
     * A host lookup becomes native only when its literal id is present in the
     * audited companion, including explicitly represented canvas elements.
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
        for (const demand of this.ownedRecords.values())
            this.dataTypes.predeclareOwnedRecord(demand);
        for (const declaration of this.dynamicBindings.keys()) {
            const type = this.dataTypes.fromTsType(
                this.checker.getTypeAtLocation(declaration.name),
                declaration,
            );
            if (type) this.dataTypes.markStoredObjectReferences(type);
        }
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                const target = retainedNativeMutationTarget(this.symbols, node);
                if (target) {
                    const targetType = this.checker.getTypeAtLocation(target);
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
                            target,
                        );
                        if (dataType?.kind === "struct") {
                            this.dataTypes.markStoredObjectReferences(dataType);
                        }
                    }
                } else if (
                    (ts.isInterfaceDeclaration(node) ||
                        ts.isTypeAliasDeclaration(node)) &&
                    node.name
                ) {
                    this.dataTypes.fromTsType(
                        this.checker.getTypeAtLocation(node.name),
                        node,
                    );
                } else if (ts.isVariableDeclaration(node) && node.type) {
                    // Mapping an explicitly stored container eagerly marks any
                    // object-valued entries as shared references. Do this before
                    // function bodies are emitted so an earlier object literal
                    // cannot use value syntax for a type that a later Map/Array
                    // declaration makes reference-backed.
                    this.dataTypes.fromTsType(
                        this.checker.getTypeFromTypeNode(node.type),
                        node.type,
                    );
                } else if (
                    ts.isParameter(node) &&
                    (ts.isConstructorDeclaration(node.parent) ||
                        ts.isMethodDeclaration(node.parent))
                ) {
                    // Class argument binding preserves JavaScript object identity.
                    // Predeclare that representation before helpers returning the
                    // same structural type are lowered.
                    const dataType = this.dataTypes.fromTsType(
                        this.checker.getTypeAtLocation(node),
                        node,
                    );
                    if (dataType?.kind === "struct") {
                        this.dataTypes.markStoredObjectReferences(dataType);
                    }
                } else if (ts.isPropertyDeclaration(node)) {
                    const dataType = this.dataTypes.fromTsType(
                        this.checker.getTypeAtLocation(node),
                        node,
                    );
                    if (dataType) {
                        this.dataTypes.markStoredObjectReferences(dataType);
                    }
                } else if (
                    ts.isParameter(node) &&
                    node.parent &&
                    ts.isParameterPropertyDeclaration(node, node.parent)
                ) {
                    const dataType = this.dataTypes.fromTsType(
                        this.checker.getTypeAtLocation(node),
                        node,
                    );
                    if (dataType) {
                        this.dataTypes.markStoredObjectReferences(dataType);
                    }
                }
            });
        for (const source of this.sourceFiles()) {
            if (!source.isDeclarationFile) visit(source);
        }
    }

    private collectStaticConstants(): void {
        for (const file of this.program.getSourceFiles()) {
            if (file.isDeclarationFile) {
                continue;
            }
            for (const statement of file.statements) {
                if (
                    !ts.isVariableStatement(statement) ||
                    (file !== this.sourceFile &&
                        (statement.declarationList.flags &
                            ts.NodeFlags.Const) ===
                            0)
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
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (
                    (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
                    ts.isIdentifier(node.name)
                ) {
                    this.sourceCppNames.add(
                        this.bindings.cppIdentifier(node.name.text),
                    );
                }
            });
        for (const file of this.program.getSourceFiles()) {
            if (!file.isDeclarationFile) {
                visit(file);
            }
        }
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
        const modules = planImportedModuleInitializers(
            this.program,
            this.sourceFile,
            this.checker,
            this.symbols,
        );
        if (modules.length === 0) return;

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

    /**
     * Creates storage for the entry module's own rebound top-level names.
     *
     * `main()` is a body, not the module: a scene written that way leaves its
     * module-scope statements out of the emitted program entirely, so a `let`
     * declared beside `main` and written by the functions `main` calls has
     * nothing behind it. Reads folded back to the declaration's initializer
     * -- which is what `staticConstants` does for the entry file -- would give
     * every reader the value the first write replaced.
     *
     * The declaration is emitted here, before the entry body, which is where
     * JavaScript creates that storage: after the imported modules it depends
     * on have initialized and before `main` can run. It goes through the same
     * declaration lowering a `let` inside `main` takes, so the shared-closure
     * analysis decides its native form -- a plain local, or a `gc_shared` cell
     * when a stored callback captures it -- and that lowering drops the symbol
     * from `staticConstants` so every later read and write resolves through
     * the binding.
     *
     * A scene with no `main` already emits its module-scope statements as the
     * entry, so those are skipped here rather than declared twice.
     */
    private emitEntryModuleState(entry: readonly ts.Statement[]): void {
        const emitted = new EmissionSet<ts.Statement>(entry);
        for (const statement of planEntryModuleState(
            this.program,
            this.sourceFile,
            this.checker,
            this.symbols,
        )) {
            if (!emitted.has(statement)) this.emitStatement(statement);
        }
    }

    private emitEntryBody(entry: readonly ts.Statement[]): void {
        const emitBody = (): boolean => {
            const terminated = emitReachableStatements(this, entry);
            this.emitDeferredPhysicsCallbacks();
            this.emitNativeHostUi();
            return terminated;
        };
        const suspends =
            this.options.workers &&
            entry.some((statement) =>
                someAnalysisNode(statement, ts.isAwaitExpression, {
                    functions: "skip",
                }),
            );
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
            closure = this.withAsyncActivation(() =>
                this.captureManagedClosureLines(() => {
                    this.beginNativeFunctionBody(undefined, false, {
                        coroutine: true,
                    });
                    try {
                        if (!emitBody())
                            this.emit("co_return bbl::js::PromiseVoid{};");
                    } finally {
                        this.endNativeFunctionBody();
                    }
                }),
            );
        } finally {
            this.bindings.popScope();
        }
        this.emit(
            `static_cast<void>(${renderCoroutineInvocation(closure, "bbl::js::Promise<bbl::js::PromiseVoid>")});`,
        );
    }

    private entryStatements(): readonly ts.Statement[] {
        if (this.options.workers?.namespace) {
            return this.sourceFile.statements.filter(
                (statement) =>
                    !ts.isImportDeclaration(statement) &&
                    !ts.isFunctionDeclaration(statement) &&
                    !ts.isExportDeclaration(statement),
            );
        }
        const main = this.sourceFile.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === "main" &&
                statement.body !== undefined,
        );
        if (main) {
            this.hasMainEntry = true;
            return main.body!.statements;
        }

        const statements = this.sourceFile.statements
            .filter(
                (statement) =>
                    !ts.isImportDeclaration(statement) &&
                    !ts.isFunctionDeclaration(statement) &&
                    !ts.isExportDeclaration(statement),
            )
            .map((statement) => this.unwrapEntryReporter(statement));
        if (statements.length === 0) {
            this.failAtFile(
                "Expected top-level scene statements or a function named main with a body.",
            );
        }
        return statements;
    }

    /**
     * `entry(...).catch(<reporter>)`, which is how a scene whose entry is an
     * imported async helper ends.
     *
     * The `main` form above erases the same wrapper by never treating it as
     * entry text: the body becomes the program and the trailing
     * `main().catch(console.error)` goes with the declaration. A scene with
     * no `main` has no body to take, so the chain IS the program -- and the
     * `.catch` on it is the browser's unhandled-rejection reporting, which a
     * native program does by aborting. Both forms therefore record the same
     * adaptation.
     *
     * This is an entry-point rule, so it is applied to entry text once per
     * compile rather than to every `.catch` a program contains: mid-scene,
     * a rejection handler is a recovery path and lowering it away would be
     * a silent change of meaning.
     */
    private unwrapEntryReporter(statement: ts.Statement): ts.Statement {
        if (this.options.workers) return statement;
        if (!ts.isExpressionStatement(statement)) return statement;
        const call = this.unwrap(statement.expression);
        if (
            !ts.isCallExpression(call) ||
            !ts.isPropertyAccessExpression(call.expression) ||
            call.expression.name.text !== "catch" ||
            call.arguments.length !== 1
        ) {
            return statement;
        }
        const promise = this.unwrap(call.expression.expression);
        if (
            !ts.isCallExpression(promise) ||
            this.checker.getAwaitedType(
                this.checker.getTypeAtLocation(promise),
            ) === this.checker.getTypeAtLocation(promise)
        ) {
            return statement;
        }
        const handler = this.unwrap(argumentAt(call, 0));
        if (!this.browserErasure.isBrowserOnlyHandler(handler)) {
            this.fail(
                handler,
                "A scene's entry may end in `.catch(<reporter>)`, whose " +
                    "handler reports and nothing more -- a native program " +
                    "reports a rejection by aborting. This handler does " +
                    "something else, which would be a recovery path the " +
                    "native entry has no place to run.",
            );
        }
        this.hasMainEntry = true;
        return ts.factory.createExpressionStatement(promise);
    }

    public emitStatement(statement: ts.Statement): void {
        this.statementDependencies.push(new EmissionSet());
        try {
            this.statements.emit(this, statement);
        } finally {
            this.statementDependencies.pop();
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
    ): { kind: ValueKind; cppType: string } | undefined {
        const type = this.checker.getTypeAtLocation(node);
        const present = presentMembers(type);
        if (present.length !== 1 || (!allowDirect && !isNullable(type)))
            return undefined;
        const member = present[0]!;
        if (this.options.workers && isPinnedType(member, ["EngineContext"])) {
            return { kind: "engine", cppType: "std::shared_ptr<bbl::Engine>" };
        }
        const pinned = pinnedHandleKind(member);
        switch (pinned) {
            case "mesh":
            case "sprite-layer":
            case "navigation-obstacle":
            case "storage-buffer":
                return { kind: pinned, cppType: handleCppType(pinned) };
        }
        const audio = domAudioHandleKind(member);
        switch (audio) {
            case "audio-context":
            case "audio-param":
            case "audio-buffer":
                return { kind: audio, cppType: handleCppType(audio) };
        }
        const name = member.symbol?.name;
        const named = name ? NULLABLE_RESOURCE_TYPES.get(name) : undefined;
        if (named && declaredIn(member.symbol, named.origin)) {
            return { kind: named.kind, cppType: named.cppType };
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
            (mappedHandle.handle === "pointer-drag" ||
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
        visited = new EmissionSet<ts.Type>(),
    ): boolean {
        if (type.symbol?.name === name && declaredBy(type.symbol)) return true;
        if (visited.has(type) || (type.flags & ts.TypeFlags.Object) === 0) {
            return false;
        }
        visited.add(type);
        const objectType = type as ts.ObjectType;
        if (
            (objectType.objectFlags &
                (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) ===
            0
        ) {
            return false;
        }
        return (
            this.checker
                .getBaseTypes(type as ts.InterfaceType)
                ?.some((base) =>
                    this.typeIsOrExtendsNamed(base, name, declaredBy, visited),
                ) ?? false
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
                if (
                    ts.isBinaryExpression(candidate) &&
                    candidate.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    this.unwrappedValueSymbol(candidate.left) === symbol
                ) {
                    const right = this.unwrap(candidate.right);
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

    public noteNodeGeometryMutation(node: ts.Node): void {
        this.deferredAdmissionFailures.push({
            capability: "node-geometry",
            node,
            message:
                "Node geometry views require static imported mesh transforms; mutation, cloning and unproven transform aliases are not represented.",
        });
    }

    public assertNodeInputMutable(node: ts.Node): void {
        if (
            this.frameCallbackDepth > 0 ||
            this.engineStartMark !== undefined ||
            this.temporalSceneRegistration
        ) {
            this.fail(
                node,
                "Node input texture changes require setup before scene registration; captured bind-group replacement is not represented.",
            );
        }
    }

    public noteNodeInputAdmissionFailure(node: ts.Node, message: string): void {
        if (this.features.has("material:node")) this.fail(node, message);
        this.deferredAdmissionFailures.push({
            capability: "node-input",
            node,
            message,
        });
    }

    @journaled private accessor textAttachmentReached = false;
    private readonly reachedRenderContextRegistrations =
        new EmissionSet<string>();
    @journaled private accessor textCameraMutation: ts.Node | undefined;

    public noteTextCameraControl(
        node: ts.Node,
        camera: Value,
        arcRotate: boolean,
    ): void {
        if (
            !arcRotate ||
            (camera.cameraKind !== undefined &&
                camera.cameraKind !== "arc-rotate")
        )
            this.textCameraMutation ??= node;
    }

    public noteTextSceneLifecycle(
        node: ts.Node,
        message = "Text scene disposal, removal and explicit rebuilding require retained binding topology that is not represented.",
    ): void {
        this.deferredAdmissionFailures.push({
            capability: "text",
            node,
            message,
        });
    }

    public noteTextSceneCameraAssignment(node: ts.Node): void {
        if (
            this.isRuntimeResourceConstruction() ||
            this.engineStartMark !== undefined
        )
            this.textCameraMutation ??= node;
    }

    public assertTextPipelineMutable(node: ts.Node): void {
        if (
            this.isRuntimeResourceConstruction() ||
            this.textAttachmentReached ||
            this.engineStartMark !== undefined
        ) {
            this.fail(
                node,
                "Text pipeline/order changes require definite initialization before text attachment; live pipeline rebinding and list rebuilding are not represented.",
            );
        }
    }

    public promoteTextData(node: ts.Node): void {
        promoteLiveTextData(this);
        this.reachFeature("text:layout", node);
    }

    public recordTextAttachment(node: ts.Node): void {
        if (
            this.isRuntimeResourceConstruction() ||
            this.engineStartMark !== undefined
        )
            this.fail(
                node,
                "Text attachment requires definite initialization; live text list rebuilding is not represented.",
            );
        this.textAttachmentReached = true;
    }

    public assertTextDisposal(node: ts.Node): void {
        if (
            this.textAttachmentReached ||
            this.isRuntimeResourceConstruction() ||
            this.engineStartMark !== undefined
        ) {
            this.fail(
                node,
                "Text disposal requires setup before text attachment; destroying retained draw bindings is not represented.",
            );
        }
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
        this.emit(
            value.kind !== "void" || value.requiresExplicitDiscard
                ? `static_cast<void>(${value.cpp});`
                : `${value.cpp};`,
        );
    }

    /**
     * JavaScript stored callbacks capture mutable bindings, not snapshots of
     * their current values. A `let` read by a function-valued object member or
     * retained file-change listener therefore needs a shared native cell:
     * separately emitted callbacks all dereference the same storage.
     */
    public needsSharedClosureStorage(
        declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
        binding = ts.isIdentifier(declaration.name)
            ? declaration.name
            : undefined,
    ): boolean {
        if (
            !binding ||
            !declaration.parent ||
            (ts.isVariableDeclaration(declaration) &&
                (!ts.isVariableDeclarationList(declaration.parent) ||
                    (declaration.parent.flags & ts.NodeFlags.Const) !== 0))
        ) {
            return false;
        }
        if (
            ts.isVariableDeclaration(declaration) &&
            ts.isVariableStatement(declaration.parent.parent) &&
            ts.isSourceFile(declaration.parent.parent.parent) &&
            declaration.getSourceFile() !== this.sourceFile
        ) {
            return true;
        }
        const symbol = this.symbols.valueSymbol(binding);
        if (!symbol) return false;
        let owner: ts.Node = declaration;
        while (owner.parent && !ts.isFunctionLike(owner.parent)) {
            owner = owner.parent;
        }
        if (owner.parent) owner = owner.parent;
        return (
            this.sharedClosureSymbolsFor(
                owner,
                this.bindings.variableScopes.length !== 1 ||
                    this.activeEmissionScope !== 0,
            )?.captured.has(symbol) ?? false
        );
    }

    /** Owners under analysis: a helper reached through its own call adds nothing. */
    private readonly sharedClosureAnalysisInProgress =
        new EmissionSet<ts.Node>();
    private readonly sharedFrameClosureSymbols = new EmissionWeakMap<
        ts.Node,
        SharedClosureBindings
    >();

    private sharedClosureSymbolsFor(
        owner: ts.Node,
        includeFrameRegistrations = false,
    ): SharedClosureBindings | undefined {
        const cache = includeFrameRegistrations
            ? this.sharedFrameClosureSymbols
            : this.sharedClosureSymbols;
        const cached = cache.get(owner);
        if (cached) return cached;
        if (this.sharedClosureAnalysisInProgress.has(owner)) return undefined;
        this.sharedClosureAnalysisInProgress.add(owner);
        try {
            const captured = this.collectSharedClosureSymbols(
                owner,
                includeFrameRegistrations,
            );
            cache.set(owner, captured);
            return captured;
        } finally {
            this.sharedClosureAnalysisInProgress.delete(owner);
        }
    }

    /**
     * The argument a call keeps past its own return: a listener
     * registration its second, a browser timer or RAF its first.
     * Frame registrations also retain callbacks past a helper/block's end.
     */
    private retainsCallbackArgument(
        call: ts.CallExpression,
        index: number,
        includeFrameRegistrations: boolean,
    ): boolean {
        const callee = this.unwrap(call.expression);
        if (ts.isIdentifier(callee)) {
            switch (this.symbols.importedName(callee)) {
                case "withNodeParticleEmitterProvider":
                    return index === 0;
                case "onBeforeRender":
                case "onPhysicsAfterStep":
                case "onCsmReceiverUpdate":
                    return includeFrameRegistrations && index === 1;
            }
        }
        if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "addEventListener" &&
            call.arguments.length >= 2
        ) {
            return index === 1;
        }
        const global = this.libraryGlobal(call.expression);
        if (
            ts.isPropertyAccessExpression(callee) &&
            ["then", "catch", "finally"].includes(callee.name.text) &&
            this.checker.getTypeAtLocation(callee.expression).symbol?.name ===
                "Promise"
        )
            return index === 0 || (callee.name.text === "then" && index === 1);
        return (
            (global === "setTimeout" ||
                global === "setInterval" ||
                global === "queueMicrotask" ||
                (includeFrameRegistrations &&
                    global === "requestAnimationFrame")) &&
            index === 0 &&
            call.arguments.length >= 1
        );
    }

    /**
     * Whether a call keeps its argument at `index` in a retained callback:
     * a listener or timer registration, or a repository helper that invokes
     * that parameter from one of its own stored callbacks (freeciv's
     * `installControls(engine, view, zoomCtl, hover, onMapClick)` calls
     * `onClick` from its pointer-up listener). The helper may live in any
     * repository module; the pinned package has no bodies to resolve.
     */
    public callRetainsArgument(
        call: ts.CallExpression,
        index: number,
        includeFrameRegistrations: boolean,
    ): boolean {
        if (
            this.retainsCallbackArgument(call, index, includeFrameRegistrations)
        )
            return true;
        const callee = this.unwrap(call.expression);
        if (!ts.isIdentifier(callee)) return false;
        const target = tryResolveFunctionDeclaration(this.checker, callee);
        if (!target) return false;
        const parameter = target.parameters[index];
        if (!parameter || !ts.isIdentifier(parameter.name)) return false;
        const symbol = this.symbols.valueSymbol(parameter.name);
        const info = this.sharedClosureSymbolsFor(
            target,
            includeFrameRegistrations,
        );
        return (
            !!symbol &&
            !!info &&
            (info.captured.has(symbol) || info.forwarded.has(symbol))
        );
    }

    @journaled private accessor nativeParticleProviderUse: boolean | undefined;

    /** Closure ownership is decided before the first resource is emitted. */
    private sourceUsesNativeParticleProvider(): boolean {
        if (this.nativeParticleProviderUse !== undefined)
            return this.nativeParticleProviderUse;
        let found = false;
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (found) return "skip";
                if (ts.isCallExpression(node)) {
                    const callee = this.unwrap(node.expression);
                    if (
                        ts.isIdentifier(callee) &&
                        this.symbols.importedName(callee) ===
                            "withNodeParticleEmitterProvider"
                    ) {
                        found = true;
                        return "skip";
                    }
                }
            });
        for (const file of this.program.getSourceFiles()) {
            if (!file.isDeclarationFile) visit(file);
        }
        return (this.nativeParticleProviderUse = found);
    }

    /**
     * The bindings a stored callback of `owner` closes over; every closure
     * over one of them must share a single cell, because a stored
     * closure's environment owns its captures by value. A callback is
     * stored when the program keeps the function value past the statement
     * naming it: a local function referenced anywhere but as a direct
     * callee (the rule `recursiveStorageEscapes` applies), a record member
     * or accessor, a returned function, an argument the call retains, a
     * function pushed into a container or assigned to a property, and any
     * callback registered from inside another callback, whose environment
     * the emitter copies whatever registers it. A local function a stored
     * callback calls runs from it and is stored with it. The owner itself
     * is never a root: its own locals live in its frame.
     */
    private collectSharedClosureSymbols(
        owner: ts.Node,
        includeFrameRegistrations: boolean,
    ): SharedClosureBindings {
        const captured = new EmissionSet<ts.Symbol>();
        const forwarded = new EmissionSet<ts.Symbol>();
        const storedLocalFunctions = new EmissionSet<ts.Symbol>();
        const localFunctions = new EmissionMap<
            ts.Symbol,
            ts.FunctionLikeDeclaration
        >();
        const localFunctionNames = new EmissionSet<string>();
        const forwardedParameters = new EmissionSet<ts.Symbol>();
        if (isSupportedFunction(owner)) {
            for (const parameter of owner.parameters) {
                if (!ts.isIdentifier(parameter.name)) continue;
                const symbol = this.symbols.valueSymbol(parameter.name);
                if (symbol) {
                    localFunctionNames.add(parameter.name.text);
                    forwardedParameters.add(symbol);
                }
            }
        }
        const roots: ts.FunctionLikeDeclaration[] = [];
        const rootSet = new EmissionSet<ts.Node>();
        const isClosure = (
            node: ts.Node,
        ): node is ts.ArrowFunction | ts.FunctionExpression =>
            ts.isArrowFunction(node) || ts.isFunctionExpression(node);
        const isRecordMember = (node: ts.Node): boolean =>
            ((ts.isMethodDeclaration(node) ||
                ts.isGetAccessorDeclaration(node) ||
                ts.isSetAccessorDeclaration(node)) &&
                ts.isObjectLiteralExpression(node.parent)) ||
            (isClosure(node) &&
                ts.isPropertyAssignment(node.parent) &&
                ts.isObjectLiteralExpression(node.parent.parent));
        const localFunctionName = (node: ts.Node): ts.Identifier | undefined =>
            ts.isFunctionDeclaration(node) && node.name
                ? node.name
                : isClosure(node) &&
                    ts.isVariableDeclaration(node.parent) &&
                    ts.isIdentifier(node.parent.name)
                  ? node.parent.name
                  : undefined;
        const storeNamed = (identifier: ts.Identifier): void => {
            const symbol = this.symbols.valueSymbol(identifier);
            if (symbol) storedLocalFunctions.add(symbol);
        };
        const isStoredLocal = (identifier: ts.Identifier): boolean => {
            const symbol = this.symbols.valueSymbol(identifier);
            return !!symbol && storedLocalFunctions.has(symbol);
        };
        const isDataSinkClosure = (node: ts.Node): boolean => {
            if (!isClosure(node)) return false;
            const parent = node.parent;
            // An explicitly callable local is emitted as a stored callback,
            // including when every use is a direct call. Its helpers must
            // share captured mutable bindings with the surrounding scope.
            if (
                ts.isVariableDeclaration(parent) &&
                parent.type &&
                this.checker
                    .getTypeFromTypeNode(parent.type)
                    .getCallSignatures().length > 0
            )
                return true;
            // Constructors and instance fields can retain the function for
            // the object's lifetime, including a callback supplied as a
            // parameter property. Mutable outer bindings remain shared.
            if (
                (ts.isNewExpression(parent) &&
                    parent.arguments?.includes(node) &&
                    this.libraryGlobal(parent.expression) === undefined) ||
                (ts.isPropertyDeclaration(parent) &&
                    parent.initializer === node)
            )
                return true;
            if (
                ts.isCallExpression(parent) &&
                parent.arguments.includes(node)
            ) {
                const callee = this.unwrap(parent.expression);
                return (
                    ts.isPropertyAccessExpression(callee) &&
                    ["push", "unshift", "add", "set"].includes(callee.name.text)
                );
            }
            if (
                ts.isBinaryExpression(parent) &&
                parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                parent.right === node
            ) {
                // A property of the program's own data keeps the function;
                // a library global's (`Math.random = () => ...`, which a
                // bake moves to generation) does not.
                const target = this.unwrap(parent.left);
                const root = rootIdentifier(target, (chain) =>
                    this.unwrap(chain),
                );
                return (
                    (ts.isIdentifier(target) ||
                        ts.isPropertyAccessExpression(target) ||
                        ts.isElementAccessExpression(target)) &&
                    (!(root && this.libraryGlobal(root) !== undefined) ||
                        (isDeterministicRandomRead(this, parent.left) &&
                            this.sourceUsesNativeParticleProvider()))
                );
            }
            return ts.isArrayLiteralExpression(parent);
        };
        const addRoot = (node: ts.FunctionLikeDeclaration): void => {
            roots.push(node);
            rootSet.add(node);
        };
        // Local functions and inline roots. `callbackDepth` counts the
        // enclosing callback arguments: below one, every callback argument
        // is a root.
        findAnalysisNodeWithState(
            owner,
            0,
            (node, callbackDepth) => {
                // A realm activation owns its environment even for a direct call
                // or IIFE: it can suspend past the caller's return. Its mutable
                // outer bindings must therefore use the same cells as callbacks.
                if (
                    this.options.workers &&
                    isSupportedFunction(node) &&
                    ts
                        .getModifiers(node)
                        ?.some(
                            (modifier) =>
                                modifier.kind === ts.SyntaxKind.AsyncKeyword,
                        )
                ) {
                    addRoot(node);
                }
                const name = localFunctionName(node);
                if (name) {
                    localFunctionNames.add(name.text);
                    const symbol = this.symbols.valueSymbol(name);
                    if (symbol && isSupportedFunction(node)) {
                        localFunctions.set(symbol, node);
                    }
                }
                if (isClosure(node)) {
                    const call = ts.isCallExpression(node.parent)
                        ? node.parent
                        : undefined;
                    const index = call ? call.arguments.indexOf(node) : -1;
                    if (
                        isRecordMember(node) ||
                        (ts.isReturnStatement(node.parent) &&
                            node.parent.expression === node) ||
                        isDataSinkClosure(node) ||
                        (call !== undefined &&
                            index >= 0 &&
                            (callbackDepth > 0 ||
                                this.callRetainsArgument(
                                    call,
                                    index,
                                    includeFrameRegistrations,
                                )))
                    ) {
                        addRoot(node);
                    }
                } else if (
                    isRecordMember(node) &&
                    (ts.isMethodDeclaration(node) ||
                        ts.isGetAccessorDeclaration(node) ||
                        ts.isSetAccessorDeclaration(node))
                ) {
                    addRoot(node);
                }
                return false;
            },
            (node, depth) =>
                isClosure(node) &&
                ts.isCallExpression(node.parent) &&
                node.parent.arguments.includes(node)
                    ? depth + 1
                    : depth,
            { includeRoot: false },
        );
        // A local function referenced anywhere but as a direct callee is a
        // value the program keeps: passed by name, assigned, pushed, returned
        // or captured. A parameter used as a value may likewise escape through
        // a container or another helper, so its caller must retain the callback's
        // environment. Direct calls alone do not require that ownership.
        forEachAnalysisNode(owner, (node) => {
            if (ts.isShorthandPropertyAssignment(node)) {
                if (localFunctionNames.has(node.name.text)) {
                    storeNamed(node.name);
                    const symbol = this.symbols.valueSymbol(node.name);
                    if (symbol && forwardedParameters.has(symbol))
                        forwarded.add(symbol);
                }
            } else if (
                ts.isIdentifier(node) &&
                localFunctionNames.has(node.text)
            ) {
                const parent = node.parent;
                const declared =
                    (ts.isFunctionDeclaration(parent) ||
                        ts.isVariableDeclaration(parent)) &&
                    parent.name === node;
                const callee =
                    ts.isCallExpression(parent) && parent.expression === node;
                const member =
                    ts.isPropertyAccessExpression(parent) &&
                    parent.name === node;
                if (!declared && !callee && !member) {
                    const symbol = this.symbols.valueSymbol(node);
                    if (symbol && localFunctions.has(symbol)) storeNamed(node);
                    if (
                        symbol &&
                        forwardedParameters.has(symbol) &&
                        !(ts.isParameter(parent) && parent.name === node)
                    )
                        forwarded.add(symbol);
                }
            }
        });
        for (const symbol of storedLocalFunctions) {
            const declaration = localFunctions.get(symbol);
            if (declaration) addRoot(declaration);
        }
        // A local function a root calls runs from that stored callback.
        const visitedRoots = new EmissionSet<ts.Node>();
        for (let index = 0; index < roots.length; ++index) {
            const root = roots[index]!;
            if (visitedRoots.has(root)) continue;
            visitedRoots.add(root);
            forEachAnalysisNode(root, (node) => {
                if (
                    ts.isIdentifier(node) &&
                    localFunctionNames.has(node.text)
                ) {
                    const symbol = this.symbols.valueSymbol(node);
                    const declaration = symbol
                        ? localFunctions.get(symbol)
                        : undefined;
                    if (
                        symbol &&
                        declaration &&
                        !storedLocalFunctions.has(symbol)
                    ) {
                        storedLocalFunctions.add(symbol);
                        addRoot(declaration);
                    }
                }
            });
        }
        const insideStoredClosure = (
            node: ts.Node,
            inside: boolean,
        ): boolean => {
            const name = localFunctionName(node);
            return (
                inside || rootSet.has(node) || (!!name && isStoredLocal(name))
            );
        };
        findAnalysisNodeWithState(
            owner,
            false,
            (node, inside) => {
                if (
                    insideStoredClosure(node, inside) &&
                    ts.isIdentifier(node)
                ) {
                    const symbol = this.symbols.valueSymbol(node);
                    if (symbol) captured.add(symbol);
                }
                return false;
            },
            insideStoredClosure,
            { includeRoot: false },
        );
        return { captured, forwarded };
    }

    public isSharedClosureScalar(kind: string): boolean {
        return (
            kind === "number" ||
            kind === "boolean" ||
            kind === "string" ||
            kind === "enum" ||
            kind === "promise"
        );
    }

    public hasStableNativeBinding(value: Value): boolean {
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
            !cppIdentifierPattern.test(value.stableOwnerCpp ?? value.cpp)
        )
            return false;
        return this.hasStableNativeExpression(
            value.stableOwnerCpp ?? value.cpp,
        );
    }

    private hasStableNativeExpression(cpp: string): boolean {
        const binding = this.nativeBindings.get(cpp);
        return binding !== undefined && this.nativeConstBindings.has(binding);
    }

    /**
     * A non-literal inferred struct needs storage only when its binding
     * changes.
     *
     * The answer is a property of the file, not of the identifier, so the
     * file's assigned names are resolved once and every later question is a
     * set membership -- a scene asks this for most of its declarations, and
     * a walk each turned that into a scan of the whole file per name.
     * `false` keeps `++`/`--` out of the set, which is the answer every
     * caller here has always had.
     */
    public identifierIsRebound(identifier: ts.Identifier): boolean {
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) return false;
        const file = identifier.getSourceFile();
        let rebound = this.reboundSymbolsByFile.get(file);
        if (!rebound) {
            rebound = collectReboundSymbols(file, this.symbols, false);
            this.reboundSymbolsByFile.set(file, rebound);
        }
        return rebound.has(symbol);
    }

    public emitLogicalAssignment(expression: ts.BinaryExpression): void {
        this.dataLowerer.emitLogicalAssignment(expression);
    }

    public emitDelete(expression: ts.DeleteExpression): void {
        if (this.windowProperties.remove(expression)) return;
        this.dataLowerer.emitDelete(expression);
    }

    public emitAssignment(expression: ts.BinaryExpression): void {
        traceSourceNode(expression.left);
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
        if (emitCanvasAssignment(this, expression)) return;
        if (this.options.workers && this.emitUiPropertyAssignment(expression))
            return;
        if (emitStructuralPropertyAssignment(this, expression)) {
            return;
        }
        const left = this.unwrap(expression.left);
        if (
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(left) &&
            this.resolveRecordValue(left.expression)?.recordSetters?.[
                left.name.text
            ]
        ) {
            emitPropertyAssignment(this, expression);
            return;
        }
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
                ? ts.isArrayLiteralExpression(right) ||
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
    ): boolean {
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
     * `ui:rml` presents through the scene and sprite loops only; the
     * standalone fullscreen-effect and frame-graph drivers have no UI path
     * on either backend (`pal_sdl_gpu_effect.cpp`/`pal_sdl_gpu_frame_graph
     * .cpp` and their Dawn twins render no `UiRenderFrame`). Refuse the
     * combination while nothing reaches it so retained chrome cannot
     * silently vanish from a task-only program. The driver mirror follows
     * `pal_sdl.cpp`'s `renderer_kind` priority: a scene wins, then a frame
     * graph, then an effect renderer, then sprites.
     */
    private refuseUiWithoutPresentation(): void {
        if (
            !this.features.has("ui:rml") ||
            this.features.has("renderer:scene")
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

    public emitUiPropertyAssignment(expression: ts.BinaryExpression): boolean {
        if (this.windowProperties.assign(expression)) return true;
        return this.ui.emitUiPropertyAssignment(expression);
    }

    public compileValue(expression: ts.Expression): Value {
        traceSourceNode(expression);
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
            this.nativeDependencyStack.pop();
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
        if (
            value.kind === "boolean" &&
            (value.cpp === "true" || value.cpp === "false")
        ) {
            value = { ...value, staticBoolean: value.cpp === "true" };
        }
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
        if (this.options.workers && value.engineCpp) {
            if (value.kind === "engine" && value.ownedEngineCpp) {
                const owner = this.nativeBindings.get(value.ownedEngineCpp);
                if (owner)
                    this.realmEngineCaptures.set(value.engineCpp, [owner]);
            }
            const owners = this.realmEngineCaptures.get(value.engineCpp);
            if (owners)
                writable(value).nativeCompanionCaptures = {
                    ...value.nativeCompanionCaptures,
                    engineCpp: owners,
                };
        }
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
        if (this.options.workers) {
            const canvas = compileCanvasValue(this, expression);
            if (canvas) return canvas;
            const promise = this.asyncLowerer.compile(expression);
            if (promise) return promise;
        }
        return compileWorkerValue(this, expression);
    }

    public emitAwaitExpression(expression: ts.Expression): boolean {
        if (!this.options.workers) return false;
        const node = unwrapExpression(expression);
        if (!ts.isAwaitExpression(node)) return false;
        this.compileValue(expression);
        return true;
    }

    public withAsyncActivation<T>(work: () => T): T {
        return this.asyncLowerer.withActivation(work);
    }

    public compileAsyncCall(
        declaration: SupportedFunction,
        arguments_: readonly Value[],
        node: ts.Node,
    ): Value | undefined {
        return this.options.workers
            ? this.asyncLowerer.compileCall(declaration, arguments_, node)
            : undefined;
    }

    public compileSynchronousPromise(node: ts.NewExpression): Value {
        return this.asyncLowerer.compileSynchronousConstructor(node);
    }

    private pendingActivationAnalysis: PendingActivations | undefined;

    /** Built once a reached constructed promise sets `pendingActivations`. */
    public pendingActivations(): PendingActivations {
        this.pendingActivationAnalysis ??= new PendingActivations(
            this.checker,
            this.sourceFiles(),
            (construction) =>
                this.browserErasure.isFrameYield(construction) ||
                this.browserErasure.isBoundedNestedFrameYield(construction) ||
                this.browserErasure.frameDrainCondition(construction) !==
                    undefined ||
                framePollExecutor(construction, this.checker, (expression) =>
                    this.libraryGlobal(expression),
                ) !== undefined,
            (node, message) => this.fail(node, message),
        );
        return this.pendingActivationAnalysis;
    }

    /**
     * An expression statement that discards the promise of an activation
     * which can end at a pending await is where that ending stops: the
     * statements after it run, as they do after JavaScript's suspension.
     */
    public emitActivationBoundary(
        statement: ts.ExpressionStatement,
        emit: () => boolean | void,
    ): boolean | void {
        if (
            !this.options.pendingActivations ||
            !this.pendingActivations().discards(statement)
        )
            return emit();
        const lines = this.captureEmittedLines(() => {
            emit();
        });
        this.emit("try {");
        this.increaseIndent();
        for (const line of lines) this.emit(line);
        this.decreaseIndent();
        this.emit("} catch (const bbl::js::PendingActivation&) {");
        this.emit("    bbl::js::end_abandoned_activation();");
        this.emit("}");
        return false;
    }

    public withEngineBootstrap<T>(
        declaration: SupportedFunction,
        work: () => T,
    ): T {
        // Worker bootstrap helpers can run under a message guard. Their own
        // unconditional pre-engine setup remains fixed for every invocation.
        const ownsEngine =
            declaration.body &&
            ts.isBlock(declaration.body) &&
            declaration.body.statements.some(
                (statement) =>
                    ts.isVariableStatement(statement) &&
                    statement.declarationList.declarations.some((variable) => {
                        const call =
                            variable.initializer &&
                            this.unwrap(variable.initializer);
                        return (
                            call &&
                            ts.isCallExpression(call) &&
                            ts.isIdentifier(call.expression) &&
                            this.symbols.importedName(call.expression) ===
                                "createEngine"
                        );
                    }),
            );
        if (ownsEngine)
            this.decoderBootstrapDepths.push(this.runtimeControlFlowDepth);
        try {
            return work();
        } finally {
            if (ownsEngine) this.decoderBootstrapDepths.pop();
        }
    }

    public compileAsyncReturn(
        expression: ts.Expression,
        type: DataType | undefined,
        compileResult?: NativeReturnValueCompiler,
    ): string {
        return this.asyncLowerer.compileReturn(expression, type, compileResult);
    }

    public withOwnedCallbackBody<T>(body: () => T): T {
        this.frameCallbackDepth++;
        try {
            return body();
        } finally {
            this.frameCallbackDepth--;
        }
    }

    @journaled private accessor awaitedSetupDepth = 0;

    /** Immediately awaited helpers preserve their new engine's resource order. */
    public withAsyncInvocation<T>(node: ts.Node, body: () => T): T {
        const ordered =
            this.engineCreationExecution !== undefined &&
            ts.isAwaitExpression(node.parent) &&
            !this.isRuntimeResourceConstruction();
        if (ordered) this.awaitedSetupDepth++;
        try {
            return this.withOwnedCallbackBody(body);
        } finally {
            if (ordered) this.awaitedSetupDepth--;
        }
    }

    public isNativeWorkerExpression(expression: ts.Expression): boolean {
        return isNativeWorkerExpression(this, expression);
    }

    public workerCheckpointCpp(): string | undefined {
        return this.options.workers
            ? "bbl::pal::EventLoop::current().checkpoint()"
            : undefined;
    }

    public workerAbortCpp(): string | undefined {
        return this.options.workers
            ? "bbl::pal::EventLoop::current().aborting()"
            : undefined;
    }

    public compileAsyncEngineStart(
        engine: Value,
        node: ts.Node,
    ): Value | undefined {
        if (!this.options.workers) return undefined;
        if (!engine.ownedEngineCpp)
            this.fail(
                node,
                "Asynchronous engine startup requires an owned engine.",
            );
        return {
            kind: "promise",
            cpp: `bbl::pal::start_realm_engine(${engine.ownedEngineCpp})`,
            promiseResult: { kind: "void", cpp: "" },
            promiseType: "bbl::js::PromiseVoid",
        };
    }

    public compileWorkerCallback(
        expression: ts.Expression,
        event: "message" | "error",
    ): string {
        const name = this.allocateTemporaryCppName("worker_event");
        const type =
            event === "message"
                ? "const bbl::pal::WorkerMessage&"
                : "bbl::pal::WorkerErrorEvent&";
        const callback = this.compilePlatformCallback(
            expression,
            { name, cppType: type },
            [
                {
                    kind:
                        event === "message"
                            ? "worker-message-event"
                            : "worker-error-event",
                    cpp: name,
                },
            ],
        );
        return `bbl::js::Callback<void(${type})>(${callback.identity}, ${callback.cpp})`;
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
            return ts.isIdentifier(unwrapped)
                ? this.bindings.lookupOptional(unwrapped)?.staticStrings
                : undefined;
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
            (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
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

    /**
     * One node's verdict for `constArrayIsWritten`'s scan.
     *
     * The three write shapes come from `writesThroughTrackedRoot`, the one
     * recognizer `parameterIsReadOnly` and `returnedValueCanMove` also
     * read; this caller supplies the two things that are its own. The
     * target is the alias OR an element of it, because writing one slot
     * writes the array. And the mutating-method set is the exact one:
     * the tracked value is known to be an array here, so its method set
     * is closed, where the shared default has to treat anything not
     * proven read-only as a write.
     */
    private writesThroughArray(
        node: ts.Node,
        scan: AliasedMutationScan,
    ): boolean {
        const isTarget = (expression: ts.Expression): boolean => {
            const target = this.unwrap(expression);
            return (
                scan.namesAlias(target) ||
                (ts.isElementAccessExpression(target) &&
                    scan.namesAlias(this.unwrap(target.expression)))
            );
        };
        if (
            writesThroughTrackedRoot(node, isTarget, (method) =>
                mutatingArrayMethods.has(method),
            )
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
            this.checker.getConstantValue(expression) ??
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
            (this.frameCallbackDepth > 0 ||
                this.engineStartMark !== undefined ||
                this.temporalSceneRegistration)
        ) {
            this.fail(
                call,
                "Node material construction requires setup before scene registration; live group rebuilding is not represented.",
            );
        }
        if (
            this.sceneManifest.hasRuntimeMaterialProfiles() &&
            (importedName === "createPbrMaterial" ||
                importedName === "loadGltf")
        ) {
            this.fail(
                call,
                "Runtime material construction leaves no generation-known physical material slot for a later PBR material or glTF load.",
            );
        }
        if (
            (importedName === "createPbrMaterial" ||
                importedName === "loadGltf") &&
            this.isRuntimeResourceConstruction() &&
            (this.frameCallbackDepth > 0 || this.isInRuntimeControlFlow())
        ) {
            this.fail(
                call,
                "Runtime resource construction requires a generation-known iteration count for PBR material slots and glTF load order.",
            );
        }
        const profile =
            runtimeProfileConstructionIntrinsics.has(importedName) &&
            this.isRuntimeResourceConstruction();
        const mark = this.sceneManifest.compositionMark();
        const value = compileRegisteredIntrinsic(this, importedName, call);
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
                `bbl::upstream::bind_scene_mesh_profile(${this.requireEngine(value, call)}, ${value.cpp}, ${index}u)`;
        }
        return value;
    }

    public isRuntimeResourceConstruction(): boolean {
        if (
            this.options.workers &&
            this.engineCreationExecution &&
            this.frameCallbackDepth ===
                this.engineCreationExecution.callback +
                    this.awaitedSetupDepth -
                    this.engineCreationExecution.awaited &&
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
                    this.awaitedSetupDepth -
                    this.engineCreationExecution.awaited
        ) {
            // Resource order is relative to this newly allocated engine.
            // A worker message can invoke the same factory again, creating
            // another engine with the same independently owned slot layout.
            return false;
        }
        return !this.definiteCollectionMutation();
    }

    @journaled private accessor engineCreationExecution:
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
     * so the exact helper shape lowers to one pool-copy/version operation while
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
        const mesh = this.compileValue(argumentAt(call, 0));
        this.expectKind(mesh, "mesh", argumentAt(call, 0));
        const matrices = this.compileTypedArrayArgument(
            argumentAt(call, 1),
            "f32array",
        );
        const count = this.compileNumber(argumentAt(call, 2));
        this.reachFeature("mesh:thin-instances", call);
        this.reachFeature("mesh:thin-instances-dynamic", call);
        this.sceneManifest.recordThinInstanceMesh(mesh.sceneMeshIndex);
        return {
            kind: "void",
            cpp:
                `bbl::upload_thin_instance_matrices(${this.requireEngine(mesh, call)}, ` +
                `${mesh.cpp}, ${matrices}, ${count})`,
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
        const callee = this.unwrap(call.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            callee.name.text !== "writeTexture" ||
            !ts.isPropertyAccessExpression(callee.expression) ||
            callee.expression.name.text !== "queue" ||
            !ts.isIdentifier(callee.expression.expression)
        ) {
            return undefined;
        }
        // A reached upload commonly captures `const device = engine._device`
        // in a later callback. Resolve the identifier through ordinary value
        // compilation so the outer lexical binding remains visible here;
        // lookupOptional only describes bindings installed in this immediate
        // compiler scope.
        const device = this.compileValue(callee.expression.expression);
        if (device.kind !== "gpu-device") return undefined;
        this.expectArgumentCount(call, 4, 4);
        const destination = this.unwrap(argumentAt(call, 0));
        if (!ts.isObjectLiteralExpression(destination)) {
            this.fail(
                destination,
                "GPUQueue.writeTexture destination must name a pixels texture.",
            );
        }
        const textureProperty = destination.properties.find(
            (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) &&
                this.propertyName(property.name) === "texture",
        );
        const textureMember = textureProperty
            ? this.unwrap(textureProperty.initializer)
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
        this.noteNodeInputAdmissionFailure(
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
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === "writeBuffer" &&
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

    public compileBoxOptions(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): [string, string, string] {
        return compileBoxOptions(this, expression, precision);
    }

    public compileRenderTargetOptions(
        expression: ts.Expression,
    ): CompiledRenderTargetOptions {
        return compileRenderTargetOptions(this, expression);
    }

    public compileRenderTaskOptions(expression: ts.Expression): string {
        return compileRenderTaskOptions(this, expression);
    }

    public compileGeometryTaskOptions(expression: ts.Expression): {
        cpp: string;
        manifest: GeometryOutputTaskManifest;
    } {
        return compileGeometryTaskOptions(this, expression);
    }

    public compileCopyTaskOptions(expression: ts.Expression): string {
        return compileCopyTaskOptions(this, expression);
    }

    public compileGroundOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string] {
        return compileGroundOptions(this, expression);
    }

    public compileGroundFromHeightMapOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string, string, string] {
        return compileGroundFromHeightMapOptions(this, expression);
    }

    public compilePlaneOptions(expression: ts.Expression): [string, string] {
        return compilePlaneOptions(this, expression);
    }

    public compileSphereOptions(
        expression: ts.Expression,
    ): [string, string, string, string] {
        return compileSphereOptions(this, expression);
    }

    public compileTorusOptions(
        expression: ts.Expression,
    ): [string, string, string] {
        return compileTorusOptions(this, expression);
    }

    public compilePbrMaterialOptions(
        expression: ts.Expression,
    ): CompiledPbrMaterialOptions {
        return compilePbrMaterialOptions(this, expression);
    }

    public compileMetallicReflectanceOptions(
        expression: ts.Expression,
    ): CompiledMetallicReflectanceOptions {
        return compileMetallicReflectanceOptions(this, expression);
    }

    public reachGridMaterial(
        call: ts.CallExpression,
        options: ts.Expression | undefined,
    ): ReachedGridMaterial {
        return reachGridMaterial(this, call, options);
    }

    public compileClearCoatOptions(
        expression: ts.Expression,
    ): CompiledClearCoatOptions {
        return compileClearCoatOptions(this, expression);
    }

    public compileIridescenceOptions(
        expression: ts.Expression,
    ): CompiledIridescenceOptions {
        return compileIridescenceOptions(this, expression);
    }

    public compileAnisotropyOptions(
        expression: ts.Expression,
    ): CompiledAnisotropyOptions {
        return compileAnisotropyOptions(this, expression);
    }

    public compileSheenOptions(
        expression: ts.Expression,
    ): CompiledSheenOptions {
        return compileSheenOptions(this, expression);
    }

    public compileSubsurfaceOptions(
        expression: ts.Expression,
    ): CompiledSubsurfaceOptions {
        return compileSubsurfaceOptions(this, expression);
    }

    public compileShaderMaterialOptions(expression: ts.Expression): {
        name: string;
        id: number;
        dynamicUniforms?: Array<{
            offset: number;
            components: string[];
        }>;
    } {
        return compileShaderMaterialOptions(this, expression);
    }

    /**
     * Registers the shader variant a `createLineMaterial` (or the material a
     * `createLineSystem` builds for itself) composes. The program is folded
     * from the pin's own factory; what is decided here is only that this
     * scene reached it.
     */
    public reachLineMaterial(
        node: ts.Node,
        options: ReachedLineMaterial,
    ): { name: string; id: number } {
        return reachLineMaterialProgram(this, node, options);
    }

    public reachPhysicsViewerMaterial(
        node: ts.Node,
        color: readonly [number, number, number, number],
    ): { name: string; id: number } {
        return reachPhysicsViewerMaterialProgram(this, node, color);
    }

    public guardStaticConstructionRead(operation: string): void {
        if (this.features.has("physics:viewer"))
            this.emit(
                `bbl::pal::require_runtime_execution(${this.cppString(operation)});`,
            );
    }

    public reachLinearDepthMaterial(
        node: ts.Node,
        options: LinearDepthMaterialOptions,
    ): { name: string; id: number } {
        return reachLinearDepthMaterialProgram(this, node, options);
    }

    /** What a registered line variant settled, by variant name. */
    public lineMaterialPermutation(
        name: string,
        node: ts.Node,
    ): LineMaterialPermutation | undefined {
        return lineMaterialPermutation(this, name, node);
    }

    public compileNodeMaterialOptions(
        snippetExpression: ts.Expression,
        optionsExpression: ts.Expression | undefined,
    ): CompiledNodeMaterialCall {
        return compileNodeMaterialOptions(
            this,
            snippetExpression,
            optionsExpression,
        );
    }

    public resolveShaderUniform(
        material: Value,
        nameExpression: ts.Expression,
        expectedCounts: number[],
    ): { offset: number; count: number } {
        return resolveShaderUniform(
            this,
            material,
            nameExpression,
            expectedCounts,
        );
    }

    public resolveShaderTextureSlot(
        material: Value,
        nameExpression: ts.Expression,
    ): number {
        return resolveShaderTextureSlot(this, material, nameExpression);
    }

    public resolveShaderStorageBufferSlot(
        material: Value,
        nameExpression: ts.Expression,
    ): number {
        return resolveShaderStorageBufferSlot(this, material, nameExpression);
    }

    public compileShaderUniformComponents(
        expression: ts.Expression,
        count: number,
    ): string[] {
        return compileShaderUniformComponents(this, expression, count);
    }

    public compilePropertyAnimationClip(
        nameExpression: ts.Expression,
        tracksExpression: ts.Expression,
        optionsExpression: ts.Expression | undefined,
    ): {
        cpp: string;
        frameRate: string;
        duration: string;
        target: "mesh" | "camera" | "record";
        paths: readonly string[];
    } {
        return compilePropertyAnimationClip(
            this,
            nameExpression,
            tracksExpression,
            optionsExpression,
        );
    }

    private readonly propertyAnimationTargets =
        new PropertyAnimationTargetLowerer();

    public compilePropertyAnimationTargets(
        target: Value,
        paths: readonly string[],
        node: ts.Expression,
    ): { cpp: string; engineCpp: string } {
        return this.propertyAnimationTargets.compile(this, target, paths, node);
    }

    public compileRecordSetterValue(
        owner: Value,
        setter: ts.SetAccessorDeclaration,
        node: ts.Expression,
        value: Value,
    ): void {
        this.classLowerer.compileSetter(owner, setter, node, value);
    }

    public compilePropertyAnimationGroupOptions(
        expression: ts.Expression | undefined,
        clip: Value,
    ): string {
        return compilePropertyAnimationGroupOptions(this, expression, clip);
    }

    public expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression {
        return this.evaluator.expectStaticArrayLiteral(expression);
    }

    public compileEnvironmentOptions(expression: ts.Expression): {
        groundTextureUrl: string;
        skyboxUrl: string;
        skyboxSize: string;
        brdfUrl: string;
        brdfPathCpp?: string;
        skipSkybox: boolean;
        skipGround: boolean;
    } {
        return compileEnvironmentOptions(this, expression);
    }

    public compileDdsEnvironmentOptions(expression: ts.Expression): string {
        return compileDdsEnvironmentOptions(this, expression);
    }

    public compileDdsEnvironmentBackgroundOptions(expression: ts.Expression): {
        groundTextureUrl: string;
        skyboxUrl: string;
        skyboxSize: string;
        enableNoise: boolean;
    } {
        return compileDdsEnvironmentBackgroundOptions(this, expression);
    }

    public referenceSearch(): string {
        return this.options.search;
    }

    /** See `libraryGlobal` (symbols.ts). */
    public libraryGlobal(expression: ts.Expression): string | undefined {
        return this.symbols.libraryGlobal(expression);
    }

    /** The value symbol an expression names once unwrapped, or undefined. */
    public unwrappedValueSymbol(
        expression: ts.Expression,
    ): ts.Symbol | undefined {
        const identifier = unwrappedIdentifier(expression, (wrapped) =>
            this.unwrap(wrapped),
        );
        return identifier && this.symbols.valueSymbol(identifier);
    }

    public compileSceneDefaultRenderTask(
        expression: ts.Expression | undefined,
    ): boolean {
        return compileSceneDefaultRenderTask(this, expression);
    }

    public compileHdrEnvironmentOptions(expression: ts.Expression): {
        faceSize: number;
        useCubemapSkybox: boolean;
        skipGround: boolean;
        skyboxSize: string;
        skyboxPosition: string;
    } {
        return compileHdrEnvironmentOptions(this, expression);
    }

    public compileVec3(
        expression: ts.Expression,
        precision: "float" | "double" = "float",
    ): string {
        const unwrapped = this.unwrap(expression);
        if (
            ts.isObjectLiteralExpression(unwrapped) &&
            unwrapped.properties.length === 1 &&
            ts.isSpreadAssignment(unwrapped.properties[0]!)
        ) {
            return this.vec3FromRecord(
                this.compileValue(unwrapped.properties[0].expression),
                unwrapped.properties[0].expression,
                precision,
            );
        }
        if (
            ts.isIdentifier(unwrapped) ||
            ts.isElementAccessExpression(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped)
        ) {
            const value = this.compileValue(unwrapped);
            if (
                (value.kind === "data" && value.dataType?.kind === "struct") ||
                value.kind === "record"
            ) {
                return this.vec3FromRecord(value, unwrapped, precision);
            }
            return this.evaluator.compileVec3(expression, precision, value);
        }
        return this.evaluator.compileVec3(expression, precision);
    }

    public vec3FromRecord(
        value: Value,
        node: ts.Node,
        precision: "float" | "double" = "float",
    ): string {
        if (value.kind === "data" && value.dataType?.kind === "struct") {
            const type = precision === "float" ? "bbl::Vec3" : "bbl::Vec3d";
            const arrow = this.dataTypes.isReferenceStruct(value.dataType.name)
                ? "->"
                : ".";
            const lanes = ["x", "y", "z"].map((name) => {
                const field = this.dataTypes.structField(
                    value.dataType!.kind === "struct"
                        ? value.dataType!.name
                        : "",
                    name,
                    node,
                );
                if (field.type.kind !== "number") {
                    this.fail(
                        node,
                        `Vec3 data field '${name}' must be numeric.`,
                    );
                }
                return this.castNumber(
                    {
                        kind: "number",
                        cpp: `${value.cpp}${arrow}${field.name}`,
                    },
                    precision,
                );
            });
            return `${type}{${lanes.join(", ")}}`;
        }
        return this.evaluator.vec3FromRecord(value, node, precision);
    }

    /** One number Value at one sink's width — the rule, in one place. */
    public castNumber(value: Value, precision: "float" | "double"): string {
        return this.evaluator.castNumber(value, precision);
    }

    public compileVec2(expression: ts.Expression): string {
        return this.evaluator.compileVec2(expression);
    }

    public compileVec4(expression: ts.Expression): string {
        return this.evaluator.compileVec4(expression);
    }

    public compileBoolean(expression: ts.Expression): string {
        return this.evaluator.compileBoolean(expression);
    }

    /** Nonzero while a frame callback's statements are being lowered. */
    @journaled private accessor frameCallbackDepth = 0;
    /** Native path-dependent bodies currently being lowered. */
    @journaled private accessor runtimeControlFlowDepth = 0;
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

    public meshTransformDirtyEntry():
        "mark_mesh_dirty" | "mark_mesh_runtime_transform" {
        return this.frameCallbackDepth > 0
            ? "mark_mesh_runtime_transform"
            : "mark_mesh_dirty";
    }

    /**
     * An inline callback, as the lambda the caller's entry point takes.
     *
     * `signature` is what that entry point declares: a before-render or
     * after-step callback receives the frame delta, and a deferred
     * (`setTimeout`) one receives nothing, because a timeout is not a
     * frame. The body lowers identically either way -- only what the
     * lambda is allowed to name differs, and a deferred callback naming a
     * delta parameter has nowhere to get one, so it refuses.
     */
    public compileFrameCallback(
        expression: ts.Expression,
        signature: FrameCallbackSignature = "delta",
        retainCaptures = false,
    ): string {
        const unwrapped = this.unwrap(expression);
        const asyncType = this.dataLowerer.promiseCallbackType(unwrapped);
        if (asyncType) {
            const noArguments =
                signature === "void" || signature === "interval";
            if (asyncType.parameters.length > (noArguments ? 0 : 1))
                this.fail(
                    expression,
                    "Deferred async callback declares more parameters than its scheduler supplies.",
                );
            const callback = this.dataLowerer.prepareCallbackValue(
                unwrapped,
                "deferred_async",
            )!;
            const parameter = noArguments
                ? undefined
                : this.allocateTemporaryCppName("frame_delta");
            const compiled = this.captureManagedClosureLines(() => {
                const arguments_: Value[] = parameter
                    ? [
                          {
                              kind: "number",
                              cpp: parameter,
                              nativeCaptures: [
                                  this.registerNativeBinding(
                                      parameter,
                                      false,
                                      false,
                                      signature === "timestamp"
                                          ? "double"
                                          : "float",
                                  ),
                              ],
                          },
                      ]
                    : [];
                this.emitDiscardedValue(
                    this.dataLowerer.compileFunctionValueCall(
                        callback,
                        arguments_,
                        expression,
                    ),
                );
            });
            return this.renderSharedClosure(
                compiled,
                "void",
                unwrapped,
                parameter
                    ? `[[maybe_unused]] ${signature === "timestamp" ? "double" : "float"} ${parameter}`
                    : "",
                parameter ? [parameter] : [],
            );
        }
        if (ts.isIdentifier(unwrapped)) {
            if (signature === "void") {
                const bound = this.bindings.lookupOptional(unwrapped);
                if (
                    bound?.kind === "callback" &&
                    bound.cpp.length > 0 &&
                    bound.nativeCallbackParameterTypes?.length === 0
                ) {
                    const captureByValue =
                        retainCaptures ||
                        !!this.options.workers ||
                        this.frameCallbackDepth > 0 ||
                        this.managedCaptures.length > 0;
                    const emitBody = () => {
                        this.useNativeValue(bound);
                        this.emit(`${bound.cpp}();`);
                    };
                    const compiled = this.captureManagedClosureLines(
                        emitBody,
                        captureByValue ? false : "entry",
                    );
                    return this.renderSharedClosure(
                        compiled,
                        "void",
                        unwrapped,
                        "",
                        [],
                    );
                }
                if (
                    this.options.workers &&
                    (bound?.kind === "callback" || !bound)
                ) {
                    return this.compilePlatformCallback(
                        unwrapped,
                        undefined,
                        [],
                        undefined,
                        true,
                        false,
                    ).cpp;
                }
                this.fail(
                    unwrapped,
                    `A named deferred callback must resolve to a native zero-argument function (received ${bound?.kind ?? "unbound"}).`,
                );
            }
            return this.compileNamedFrameCallback(
                unwrapped,
                signature,
                retainCaptures,
            );
        }
        if (
            !ts.isArrowFunction(unwrapped) &&
            !ts.isFunctionExpression(unwrapped)
        ) {
            this.fail(
                unwrapped,
                "A frame, timer or listener callback must be an inline function or a named local function.",
            );
        }
        if (unwrapped.parameters.length > 1) {
            this.fail(
                unwrapped,
                "onBeforeRender callback supports at most one deltaMs parameter.",
            );
        }
        if (
            (signature === "void" || signature === "interval") &&
            unwrapped.parameters.length > 0
        ) {
            this.fail(unwrapped, "A timer callback takes no parameters.");
        }

        const parameter = unwrapped.parameters[0];
        if (parameter && !ts.isIdentifier(parameter.name)) {
            this.fail(
                parameter.name,
                "onBeforeRender deltaMs parameter must be an identifier.",
            );
        }
        const parameterName =
            parameter && ts.isIdentifier(parameter.name)
                ? parameter.name.text
                : undefined;
        const parameterCppName = parameterName
            ? this.allocateTemporaryCppName("frame_delta")
            : undefined;

        // Everything the outermost frame callback pushes lives on its own
        // stack frame; a deferred body may not reach into it.
        const previousFrameFloor = this.bindings.frameCallbackScopeFloor;
        if (this.frameCallbackDepth === 0) {
            this.bindings.frameCallbackScopeFloor =
                this.bindings.variableScopes.length;
        }
        const previousDeferredScopes = this.bindings.deferredCaptureScopes;
        const previousPlatformEventCaptureFloor =
            this.bindings.escapingPlatformEventCaptureFloor;
        if (this.frameCallbackDepth > 0) {
            this.bindings.escapingPlatformEventCaptureFloor =
                this.bindings.variableScopes.length;
        }
        this.bindings.refuseEscapingPlatformEventCapturesIn(unwrapped);
        this.bindings.deferredCaptureScopes =
            (signature === "void" || signature === "interval") &&
            this.bindings.frameCallbackScopeFloor !== undefined
                ? new EmissionSet(
                      this.bindings.variableScopes.slice(
                          this.bindings.frameCallbackScopeFloor,
                      ),
                  )
                : undefined;
        this.bindings.pushScope(this.allocateBlockPrefix());
        // This body is emitted into a real native callback lambda. A source
        // `return` therefore leaves that lambda directly, including when it
        // guards statements later in the callback; it is not an inlined
        // function return that needs the breakable wrapper path.
        this.beginNativeFunctionBody(undefined, true);
        const captureByValue =
            retainCaptures ||
            !!this.options.workers ||
            this.frameCallbackDepth > 0 ||
            this.managedCaptures.length > 0;
        let compiled: CapturedClosure;
        try {
            const emitBody = () => {
                if (parameter && ts.isIdentifier(parameter.name)) {
                    this.registerNativeBindingType(
                        parameterCppName!,
                        signature === "timestamp" ? "double" : "float",
                    );
                    this.bindings.defineVariable(parameter.name, {
                        kind: "number",
                        cpp: parameterCppName!,
                    });
                }
                this.frameCallbackDepth += 1;
                try {
                    // A concise arrow body is one expression whose value the
                    // pinned callback contract discards, so it lowers as the
                    // statement it would have been written as.
                    if (ts.isBlock(unwrapped.body)) {
                        emitReachableStatements(
                            this,
                            unwrapped.body.statements,
                        );
                    } else {
                        this.emitExpressionAsStatement(unwrapped.body);
                    }
                } finally {
                    this.frameCallbackDepth -= 1;
                }
            };
            compiled = this.captureManagedClosureLines(
                emitBody,
                captureByValue ? false : "entry",
            );
        } finally {
            this.endNativeFunctionBody();
            this.bindings.popScope();
            this.bindings.deferredCaptureScopes = previousDeferredScopes;
            this.bindings.escapingPlatformEventCaptureFloor =
                previousPlatformEventCaptureFloor;
            this.bindings.frameCallbackScopeFloor = previousFrameFloor;
        }
        // A source callback may name its delta and then not reach it --
        // most often because a branch the scene's own query folds away was
        // the only reader, as `?freeze=1` does to a crowd step. The
        // parameter still has to be there, because the signature is the
        // pin's, so it is announced unused unconditionally, exactly as
        // `compileNamedFrameCallback` below does: the attribute is legal on
        // a parameter that IS read, and asking the question per callback
        // would be a second answer to it.
        const cppParameter = parameterName
            ? `[[maybe_unused]] ` +
              `${signature === "timestamp" ? "double" : "float"} ` +
              `${parameterCppName}`
            : signature === "timestamp"
              ? "double"
              : "float";
        const lambdaParameter =
            signature === "void" || signature === "interval"
                ? ""
                : cppParameter;
        return this.renderSharedClosure(
            compiled,
            "void",
            unwrapped,
            lambdaParameter,
            parameterCppName ? [parameterCppName] : [],
        );
    }

    /** A retained zero-argument callback with the same capture checks as timers. */
    public compileVoidCallback(expression: ts.Expression): string {
        const node = this.unwrap(expression);
        if (
            ts.isCallExpression(node) ||
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node) ||
            (ts.isIdentifier(node) &&
                this.bindings.lookupOptional(node)?.dataType?.kind ===
                    "function")
        )
            return this.dataLowerer.compileForSink(expression, {
                kind: "function",
                parameters: [],
            });
        return this.compileFrameCallback(expression, "void");
    }

    /** A retained CSM receiver callback over the pin's 80-float payload. */
    public compileF32ArrayCallback(expression: ts.Expression): string {
        const callback = this.unwrap(expression);
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            this.fail(
                callback,
                "A CSM receiver update requires a local function or function literal.",
            );
        }
        const dataName = this.allocateTemporaryCppName("csm_receiver_data");
        this.registerNativeBindingType(dataName, "const bbl::js::F32Array");
        const previousDepth = this.frameCallbackDepth;
        this.frameCallbackDepth += 1;
        let compiled: CapturedClosure;
        try {
            const emitBody = () => {
                const result = this.compileCallbackWithValues(
                    callback,
                    [
                        {
                            kind: "data",
                            cpp: dataName,
                            dataType: { kind: "f32array" },
                            borrowedData: true,
                        },
                    ],
                    expression,
                );
                this.emitDiscardedValue(result);
            };
            compiled = this.captureManagedClosureLines(
                emitBody,
                previousDepth === 0 ? "entry" : false,
            );
        } finally {
            this.frameCallbackDepth = previousDepth;
        }
        return this.renderSharedClosure(
            compiled,
            "void",
            expression,
            `[[maybe_unused]] const bbl::js::F32Array& ${dataName}`,
            [dataName],
        );
    }

    private compileNamedFrameCallback(
        identifier: ts.Identifier,
        signature: Exclude<FrameCallbackSignature, "void">,
        retainCaptures: boolean,
    ): string {
        const parameter =
            signature === "interval"
                ? undefined
                : this.allocateTemporaryCppName("frame_callback_value");
        const previousDeferredScopes = this.bindings.deferredCaptureScopes;
        const previousPlatformEventCaptureFloor =
            this.bindings.escapingPlatformEventCaptureFloor;
        if (this.frameCallbackDepth > 0) {
            this.bindings.escapingPlatformEventCaptureFloor =
                this.bindings.variableScopes.length;
        }
        this.bindings.refuseEscapingPlatformEventCapturesIn(identifier);
        if (signature === "interval") {
            this.bindings.deferredCaptureScopes =
                this.bindings.frameCallbackScopeFloor === undefined
                    ? undefined
                    : new EmissionSet(
                          this.bindings.variableScopes.slice(
                              this.bindings.frameCallbackScopeFloor,
                          ),
                      );
        }
        const captureByValue =
            retainCaptures ||
            !!this.options.workers ||
            this.frameCallbackDepth > 0 ||
            this.managedCaptures.length > 0;
        this.frameCallbackDepth += 1;
        let compiled: CapturedClosure;
        try {
            const emitBody = () => {
                if (parameter)
                    this.registerNativeBinding(
                        parameter,
                        false,
                        false,
                        signature === "timestamp" ? "double" : "float",
                    );
                const stored = this.bindings.lookupOptional(identifier);
                const parameters = stored?.nativeCallbackParameterTypes;
                if (
                    stored?.kind === "callback" &&
                    stored.cpp.length > 0 &&
                    parameters &&
                    parameters.length <= 1 &&
                    parameters.every((type) => type?.kind === "number") &&
                    (parameters.length === 0 || parameter)
                ) {
                    this.useNativeValue(stored);
                    this.emit(
                        `${stored.cpp}(${parameters.length === 0 ? "" : parameter});`,
                    );
                    return;
                }
                const value = this.compileCallbackWithValues(
                    identifier,
                    parameter ? [{ kind: "number", cpp: parameter }] : [],
                    identifier,
                    false,
                    { frameDriven: true },
                );
                if (value.cpp.length > 0) {
                    this.emit(`${value.cpp};`);
                }
            };
            compiled = this.captureManagedClosureLines(
                emitBody,
                captureByValue ? false : "entry",
            );
        } finally {
            this.frameCallbackDepth -= 1;
            this.bindings.deferredCaptureScopes = previousDeferredScopes;
            this.bindings.escapingPlatformEventCaptureFloor =
                previousPlatformEventCaptureFloor;
        }
        const lambdaParameter = parameter
            ? `[[maybe_unused]] ${signature === "timestamp" ? "double" : "float"} ${parameter}`
            : "";
        return this.renderSharedClosure(
            compiled,
            "void",
            identifier,
            lambdaParameter,
            parameter ? [parameter] : [],
        );
    }

    public compileColor3(expression: ts.Expression): string {
        return this.evaluator.compileColor3(expression);
    }

    public compileColor4(expression: ts.Expression): string {
        return this.evaluator.compileColor4(expression);
    }

    public compileNumber(
        expression: ts.Expression,
        precision: "float" | "double" = "float",
    ): string {
        return this.evaluator.compileNumber(expression, precision);
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

    public isNumberExpression(expression: ts.Expression): boolean {
        return this.evaluator.isNumberExpression(expression);
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
        const resolved = this.evaluator.resolveStaticExpression(expression);
        if (!ts.isObjectLiteralExpression(resolved)) {
            this.fail(resolved, "Expected an object literal.");
        }
        return resolved;
    }

    public objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined {
        return objectProperty(object, name, (key) => this.propertyName(key));
    }

    public propertyName(name: ts.PropertyName): string | undefined {
        if (
            ts.isIdentifier(name) ||
            ts.isStringLiteral(name) ||
            ts.isNumericLiteral(name)
        ) {
            return name.text;
        }
        if (ts.isComputedPropertyName(name)) {
            const value = this.compileValue(name.expression);
            if (value.staticString !== undefined) return value.staticString;
            if (value.staticNumber !== undefined) {
                return String(value.staticNumber);
            }
        }
        return undefined;
    }

    public compileStringLiteral(expression: ts.Expression): string {
        const moduleAsset = this.moduleRelativeAssetUrl(expression);
        if (moduleAsset !== undefined) return moduleAsset;
        const unwrapped = this.unwrap(expression);
        const carried =
            ts.isIdentifier(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped) ||
            ts.isTemplateExpression(unwrapped)
                ? this.probeEmission(
                      () => this.compileValue(unwrapped),
                      (value) => value.staticString !== undefined,
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
                        ts.isStringLiteral(returned) ||
                        ts.isNoSubstitutionTemplateLiteral(returned))
                ) {
                    // This is a generation-time source factory, so keep its
                    // numeric arguments in the inliner's static domain. The
                    // ordinary value path is allowed to hoist a plain-data
                    // string helper into a native function, which would turn
                    // the shader source into a runtime string after the
                    // variant table has already been generated.
                    const value =
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
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (
                    ts.isCallExpression(node) &&
                    node.arguments.length === 2 &&
                    (ts.isStringLiteral(argumentAt(node, 0)) ||
                        ts.isNoSubstitutionTemplateLiteral(argumentAt(node, 0)))
                ) {
                    const url = this.moduleRelativeAssetUrl(node);
                    if (url !== undefined) candidates.add(url);
                }
            });
        for (const source of this.sourceFiles()) {
            visit(source);
        }
        this.staticAssetUrlCandidateCache = [...candidates].sort();
        return this.staticAssetUrlCandidateCache;
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
        const owner = parameter.parent;
        const index = owner.parameters.indexOf(parameter);
        if (index < 0) return undefined;
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
                    (this.checker.getResolvedSignature(candidate)
                        ?.declaration === owner ||
                        (ownerSymbol !== undefined &&
                            this.unwrappedValueSymbol(candidate.expression) ===
                                ownerSymbol))
                ) {
                    reachedCall = true;
                    if (candidate.arguments.length > index) {
                        passedExplicitly = true;
                        return "skip";
                    }
                }
            });
        for (const source of this.sourceFiles()) visit(source);
        return reachedCall && !passedExplicitly
            ? parameter.initializer
            : undefined;
    }

    /**
     * A browser module resolves runtime assets with a tiny `new URL(path,
     * import.meta.url)` helper. Native packaging needs the logical public-root
     * path, not the browser bundle URL, so recognize that pure helper by its
     * structure and fold it before the ordinary string evaluator runs.
     */
    public moduleRelativeAssetUrl(
        expression: ts.Expression,
    ): string | undefined {
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
        if (!declaration?.body || declaration.parameters.length !== 2) {
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
        if (!replacements) return undefined;
        if (ts.isTemplateExpression(argumentAt(resolved, 0))) {
            return undefined;
        }
        const path = this.evaluator.compileStringLiteral(
            argumentAt(resolved, 0),
        );
        const url = new URL(path, "https://bblite.invalid/");
        for (const [search, replacement] of replacements) {
            url.pathname = url.pathname.replace(search, replacement);
        }
        return url.origin === "https://bblite.invalid"
            ? `${url.pathname}${url.search}${url.hash}`
            : url.href;
    }

    /** Runtime final segment of the same pure module-relative URL helper. */
    public compileDynamicModuleRelativeAssetUrl(
        expression: ts.Expression,
    ): Value | undefined {
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
        if (!declaration?.body || declaration.parameters.length !== 2) {
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
        if (!replacements) return undefined;
        const path = this.unwrap(argumentAt(resolved, 0));
        if (
            !ts.isTemplateExpression(path) ||
            path.templateSpans.length !== 1 ||
            path.templateSpans[0]!.literal.text.length !== 0
        ) {
            return undefined;
        }
        const suffix = this.compileValue(path.templateSpans[0]!.expression);
        if (!isStringValue(suffix)) {
            return undefined;
        }
        const url = new URL(path.head.text, "https://bblite.invalid/");
        for (const [search, replacement] of replacements) {
            url.pathname = url.pathname.replace(search, replacement);
        }
        const prefix =
            url.origin === "https://bblite.invalid"
                ? `${url.pathname}${url.search}${url.hash}`
                : url.href;
        if (suffix.staticString !== undefined) {
            const staticString = prefix + suffix.staticString;
            return {
                kind: "string",
                cpp: this.cppString(staticString),
                staticString,
            };
        }
        return {
            kind: "data",
            cpp: `(${this.cppString(prefix)} + ${suffix.cpp})`,
            dataType: { kind: "string" },
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
            const left = assignment.left;
            const call = assignment.right;
            if (
                !ts.isPropertyAccessExpression(left) ||
                !ts.isIdentifier(left.expression) ||
                left.expression.text !== urlVariable ||
                left.name.text !== "pathname" ||
                !ts.isCallExpression(call) ||
                !ts.isPropertyAccessExpression(call.expression) ||
                call.expression.name.text !== "replace" ||
                !ts.isPropertyAccessExpression(call.expression.expression) ||
                !ts.isIdentifier(call.expression.expression.expression) ||
                call.expression.expression.expression.text !== urlVariable ||
                call.expression.expression.name.text !== "pathname" ||
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

    public compileEngineCreation(
        call: ts.CallExpression,
        cppName: string,
    ): Value {
        this.expectArgumentCount(call, 1, 2);
        let canvasArgument = "";
        if (this.options.workers) {
            const canvas = this.compileValue(argumentAt(call, 0));
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
        let pixelRatioCap: number | undefined;
        let highPrecisionMatrix = false;
        let floatingOrigin = false;
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
                    if (staticSamples !== 1 && staticSamples !== 4)
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
            if (limits) {
                this.expectObjectLiteral(limits);
            }
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
        if (pixelRatioCap !== undefined)
            engineOptions.push(String(pixelRatioCap));
        this.emit({
            kind: "declaration",
            type: "auto",
            name: cppName,
            initializer: `${this.options.workers ? "bbl::pal::create_realm_engine" : "bbl::create_engine"}(bbl::EngineOptions{${engineOptions.join(", ")}}${canvasArgument})`,
        });
        this.registerNativeBindingType(
            cppName,
            this.options.workers
                ? "std::shared_ptr<bbl::Engine>"
                : "bbl::Engine",
        );
        this.engineCreationInsertion = this.body.length;
        if (this.options.workers)
            this.engineCreationExecution = {
                awaited: this.awaitedSetupDepth,
                callback: this.frameCallbackDepth,
                control: this.runtimeControlFlowDepth,
                iteration: this.runtimeIterationDepth,
                native: this.returnFrames.filter(
                    (frame) => frame.kind === "native",
                ).length,
            };
        const engineCpp = this.options.workers ? `(*${cppName})` : cppName;
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
            if (canvas.kind === "ui-element") {
                if (canvas.uiTag !== "canvas")
                    this.fail(
                        argumentAt(call, 0),
                        "An engine surface requires a retained canvas element.",
                    );
                this.emit(`${engineCpp}.surface_canvas = ${canvas.cpp};`);
                this.emit(
                    `${recordAt(`${engineCpp}.ui_elements`, canvas.cpp)}.client_rect_requested = true;`,
                );
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
        return {
            kind: "engine",
            cpp: engineCpp,
            engineCpp,
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

    /**
     * A shader stage's generation-time text, with a runtime numeric template
     * constant lifted into a material uniform when necessary.
     *
     * LibreQuake builds one vertex source by formatting its mover depth bias.
     * Native pipelines are generated ahead of the BSP parse, so the equivalent
     * representation is one pipeline whose material block receives that float
     * when the material is created.
     */
    public compileShaderSource(expression: ts.Expression): {
        source: string;
        dynamicUniforms: Array<{
            name: string;
            type: "f32";
            components: string[];
        }>;
    } {
        const resolved = this.resolveStaticExpression(expression);
        const callee = ts.isCallExpression(resolved)
            ? this.unwrap(resolved.expression)
            : undefined;
        if (
            !ts.isCallExpression(resolved) ||
            !callee ||
            !ts.isIdentifier(callee)
        ) {
            return {
                source: this.compileStaticString(expression),
                dynamicUniforms: [],
            };
        }
        const declaration = resolveFunctionDeclaration(
            this.checker,
            callee,
            (node, message) => this.fail(node, message),
        );
        const body = declaration?.body;
        if (
            declaration &&
            ts.isFunctionDeclaration(declaration) &&
            body &&
            ts.isBlock(body)
        ) {
            // A builder called with generation-known arguments is run: its
            // text is what the browser compiles.
            const args: Array<ExecutedScalar | undefined> = [];
            let allStatic = true;
            declaration.parameters.forEach((parameter, index) => {
                if (!ts.isIdentifier(parameter.name)) {
                    allStatic = false;
                    return;
                }
                const argument =
                    resolved.arguments[index] ?? parameter.initializer;
                if (!argument) {
                    args.push(undefined);
                    return;
                }
                const value = this.staticScalar(
                    this.alwaysUsedParameterDefault(argument) ?? argument,
                );
                if (value === undefined) {
                    allStatic = false;
                    return;
                }
                args.push(value);
            });
            if (allStatic) {
                const source = executeApplicationFunction(
                    {
                        checker: this.checker,
                        fail: (node, message) => this.fail(node, message),
                        foldEnclosing: (identifier) =>
                            this.staticScalar(identifier),
                    },
                    declaration,
                    args,
                    `Shader builder '${callee.text}'`,
                );
                if (typeof source !== "string") {
                    this.fail(
                        resolved,
                        `Shader builder '${callee.text}' returned ${typeof source}, not WGSL text.`,
                    );
                }
                return { source, dynamicUniforms: [] };
            }
        }
        const returned = this.builderReturn(declaration);
        const template =
            returned &&
            ts.isTemplateExpression(returned) &&
            returned.templateSpans.length === 1
                ? returned
                : undefined;
        if (!declaration || !template) {
            return {
                source: this.compileStaticString(expression),
                dynamicUniforms: [],
            };
        }
        const span = template.templateSpans[0]!;
        const formatted = this.unwrap(span.expression);
        if (
            !ts.isCallExpression(formatted) ||
            !ts.isPropertyAccessExpression(formatted.expression) ||
            !PURE_NUMBER_FORMATTERS.has(formatted.expression.name.text) ||
            !ts.isIdentifier(formatted.expression.expression)
        ) {
            return {
                source: this.compileStaticString(expression),
                dynamicUniforms: [],
            };
        }
        const formatterTarget = formatted.expression.expression;
        const parameterIndex = declaration.parameters.findIndex(
            ({ name }) =>
                ts.isIdentifier(name) &&
                this.symbols.valueSymbol(name) ===
                    this.symbols.valueSymbol(formatterTarget),
        );
        const argument =
            parameterIndex >= 0
                ? (resolved.arguments[parameterIndex] ??
                  declaration.parameters[parameterIndex]!.initializer)
                : undefined;
        if (!argument) {
            return {
                source: this.compileStaticString(expression),
                dynamicUniforms: [],
            };
        }

        // The builder's one runtime number is a module-scope `f32` constant;
        // it becomes a uniform read, located by the stage's own syntax tree.
        const marker = "__BBL_DYNAMIC_SHADER_FLOAT__";
        const uniformName = "bblDynamicDepthBias";
        const lifted = liftWgslModuleConstant(
            template.head.text + marker + span.literal.text,
            marker,
            () => `shaderUniforms.${uniformName}`,
        );
        if (!lifted) {
            return {
                source: this.compileStaticString(expression),
                dynamicUniforms: [],
            };
        }
        return {
            source: lifted.source,
            dynamicUniforms: [
                {
                    name: uniformName,
                    type: "f32",
                    components: [this.compileNumber(argument)],
                },
            ],
        };
    }

    /** The generation-known scalar an expression folds to, if any. */
    private staticScalar(
        expression: ts.Expression,
    ): ExecutedScalar | undefined {
        const value = this.compileValue(expression);
        return value.staticString ?? value.staticBoolean ?? value.staticNumber;
    }

    public resolveStaticExpression(
        expression: ts.Expression,
        resolving: ReadonlySet<ts.Symbol> = new EmissionSet(),
    ): ts.Expression {
        return this.evaluator.resolveStaticExpression(expression, resolving);
    }

    public compileTypedArrayArgument(
        expression: ts.Expression,
        kind: TypedArrayKind,
    ): string {
        return this.dataLowerer.compileForSink(expression, { kind });
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
        // The condition goes through `probeEmission`, unlike the
        // evaluator's copy of this: several callers fall through on
        // undefined, so a condition that emits a temporary and then fails
        // to fold would leak that emission into a lowering nobody kept.
        const resolved = selectedStaticExpression(
            {
                conditions: {
                    compileCondition: (node) =>
                        this.probeEmission(
                            () => this.conditions.compileCondition(node),
                            (folded) => folded === "true" || folded === "false",
                        ),
                },
                resolveStaticExpression: (node) =>
                    this.resolveStaticExpression(node),
            },
            expression,
        );
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
        this.emit(`${cppName}.reserve(${sourceCpp}.size());`);
        this.emit(`for (const auto& ${elementName} : ${sourceCpp}) {`);
        this.increaseIndent();
        this.emit(
            `${cppName}.push_back(` +
                `${this.dataLowerer.structAggregate(dataType.element, parts)});`,
        );
        this.decreaseIndent();
        this.emit(`}`);
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

    public reachLocalStorage(): void {
        this.reachFeature("storage:local");
    }

    public reachImageDecode(): void {
        this.imageDecodeReached = true;
    }

    public snapshotAliasState(): Map<string, string> {
        return this.dataLowerer.snapshotAliasState();
    }

    public restoreAliasState(snapshot: Map<string, string>): void {
        this.dataLowerer.restoreAliasState(snapshot);
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

    public enterRuntimeIteration(): void {
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
            ? this.bindings.lookupOptional(ownerExpression)
            : ownerExpression.kind === ts.SyntaxKind.ThisKeyword
              ? this.activeThis()
              : ts.isPropertyAccessExpression(ownerExpression)
                ? (this.resolveRecordMember(ownerExpression) ??
                  this.propertyAccess.lookupRecordProperty(ownerExpression))
                : undefined;
        if (owner?.kind !== "record") {
            return undefined;
        }
        const accessor = owner.recordGetters?.[expression.name.text];
        if (accessor) {
            return this.compileRecordGetter(owner, accessor);
        }
        const property = owner.recordProperties?.[expression.name.text];
        if (property) {
            return property;
        }
        // A property the record was built without reads as `undefined`
        // when its type declares it optional: `{ b: 2 } as { a?: number }`
        // has no `a`, and `r.a ?? 0` is the source's own way of saying so.
        const declared = this.checker
            .getTypeAtLocation(expression.expression)
            .getProperty(expression.name.text);
        return declared !== undefined &&
            (declared.flags & ts.SymbolFlags.Optional) !== 0
            ? { kind: "json-null", cpp: "std::nullopt" }
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
    ): void {
        const parameter = setter.parameters[0];
        if (!parameter || !ts.isIdentifier(parameter.name)) {
            this.classLowerer.compileSetter(owner, setter, value);
            return;
        }
        const argument = this.compileClassParameterValue(parameter.name, value);
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
        const previousThis = this.activeThis();
        if (owner.recordScopes) {
            this.bindings.variableScopes.length = 0;
            this.bindings.variableScopes.push(...owner.recordScopes);
        }
        if (bindThis) {
            this.defineThis(owner);
        }
        try {
            return this.dataTypes.withTypeArguments(
                owner.recordTypeArguments,
                work,
            );
        } finally {
            this.defineThis(previousThis);
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
        if (earlyReturn)
            this.fail(
                earlyReturn,
                "A getter with early returns requires a represented result flow.",
            );
        return this.withRecordScopes(owner, () => {
            if (leading.length)
                this.bindings.pushScope(this.allocateUserFunctionPrefix());
            const previousThis = this.activeThis();
            // A getter's `this` is its receiver for both class instances and
            // object-literal accessors. The record may have crossed a return
            // boundary that copied its compile-time Value wrapper, so its
            // identity in classInstances is not a reliable dispatch guard.
            this.defineThis(owner);
            try {
                emitReachableStatements(this, leading);
                // A getter is an evaluation, even when its return happens
                // to lower to a field read. Optional chains must consume it
                // once and keep any nested method calls behind their guard.
                return { ...this.compileValue(expression), impure: true };
            } finally {
                this.defineThis(previousThis);
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
            const cppName = this.allocateTemporaryCppName(
                `class_field_${name.text}`,
            );
            const storage = sharedStorage ? `(*${cppName})` : cppName;
            this.emit({
                kind: "declaration",
                type: sharedStorage
                    ? `std::shared_ptr<std::optional<${nullableResource.cppType}>>`
                    : `std::optional<${nullableResource.cppType}>`,
                name: cppName,
                initializer: sharedStorage
                    ? `bbl::js::make_gc_shared<std::optional<${nullableResource.cppType}>>()`
                    : "{}",
            });
            this.bindings.defineVariable(
                name,
                valueForKind(nullableResource.kind, {
                    cpp: `(*${storage})`,
                    ...((nullableResource.kind === "ui-element" ||
                        nullableResource.kind === "pointer-drag") &&
                    this.defaultEngineCpp
                        ? { engineCpp: this.defaultEngineCpp }
                        : {}),
                    optionalFoundCpp: optionalPresentCpp(storage),
                    optionalStorageCpp: storage,
                    ...(sharedStorage ? { sharedStorageCpp: cppName } : {}),
                }),
            );
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
        const sharedStorage = this.classFieldNeedsSharedStorage(name);
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        const storage = sharedStorage ? `(*${cppName})` : cppName;
        this.emit({
            kind: "declaration",
            type: sharedStorage
                ? `std::shared_ptr<std::optional<${resource.cppType}>>`
                : `std::optional<${resource.cppType}>`,
            name: cppName,
            initializer: sharedStorage
                ? `bbl::js::make_gc_shared<std::optional<${resource.cppType}>>()`
                : "{}",
        });
        const value: Value = valueForKind(resource.kind, {
            cpp: `(*${storage})`,
            ...((resource.kind === "ui-element" ||
                resource.kind === "pointer-drag") &&
            this.defaultEngineCpp
                ? { engineCpp: this.defaultEngineCpp }
                : {}),
            optionalFoundCpp: optionalPresentCpp(storage),
            optionalStorageCpp: storage,
            ...(sharedStorage ? { sharedStorageCpp: cppName } : {}),
        });
        this.bindings.defineVariable(name, value);
        return value;
    }

    /**
     * Predeclare class data that needs storage before the constructor body.
     * Optional fields begin at JavaScript undefined. Arrays are also created
     * here because a readonly array field must own the constructor value;
     * wiring it only at `this.field = value` would otherwise infer the
     * parameter's non-owning span representation.
     */
    public bindUninitializedClassDataField(
        name: ts.MemberName,
        declared?: DataType,
    ): Value | undefined {
        const dataType = declared ?? this.dataLowerer.dataTypeAt(name);
        if (dataType?.kind !== "optional" && dataType?.kind !== "vector") {
            return undefined;
        }
        const sharedStorage = this.classFieldNeedsSharedStorage(name);
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        const storage = sharedStorage ? `(*${cppName})` : cppName;
        const cppType = this.dataTypes.cppType(dataType);
        this.emit(
            sharedStorage
                ? `auto ${cppName} = bbl::js::make_gc_shared<${cppType}>();`
                : `${cppType} ${cppName}{};`,
        );
        this.dataLowerer.registerLocal(storage, "owned");
        const value = this.dataLowerer.leafValue(storage, dataType);
        writable(value).nativeLvalue = true;
        if (sharedStorage) writable(value).sharedStorageCpp = cppName;
        this.bindings.defineVariable(name, value);
        return value;
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
        const value: Value = valueForKind(resource.kind, {
            cpp: `(*${cppName})`,
            ...((resource.kind === "ui-element" ||
                resource.kind === "pointer-drag") &&
            this.defaultEngineCpp
                ? { engineCpp: this.defaultEngineCpp }
                : {}),
            optionalFoundCpp: optionalPresentCpp(cppName),
            optionalStorageCpp: cppName,
        });
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
        const sharedStorage = this.classFieldNeedsSharedStorage(name);
        const storage = sharedStorage ? `(*${cppName})` : cppName;
        const cpp = knownValue
            ? this.dataLowerer.compileKnownValueForSink(
                  knownValue,
                  dataType,
                  initializer,
              )
            : this.dataLowerer.compileForSink(initializer, dataType);
        const cppType = this.dataTypes.cppType(dataType);
        this.emit(
            sharedStorage
                ? `auto ${cppName} = bbl::js::make_gc_shared<${cppType}>(${cpp});`
                : `${cppType} ${cppName} = ${cpp};`,
        );
        this.dataLowerer.registerLocal(storage, "owned");
        // Leaves use the same surface as a container read: numbers stay
        // numeric and stored resource handles remain resources.
        const value = this.dataLowerer.leafValue(storage, dataType);
        writable(value).nativeLvalue = true;
        if (sharedStorage) writable(value).sharedStorageCpp = cppName;
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

    public registerClassInstance(
        instance: Value,
        declaration: ts.ClassDeclaration,
    ): void {
        writable(instance).classDeclaration = declaration;
        this.classInstances.set(instance, declaration);
    }

    public classOf(instance: Value): ts.ClassDeclaration | undefined {
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
     * A declaration owned by a shared class has no such owner to key on --
     * its `this` is rebuilt at every access, and one identity would make
     * every instance's handler the same handler. That is refused rather
     * than conflated, as is a closure this cannot name at all.
     */
    public callbackIdentity(
        declaration: ts.Node,
        owner: Value | undefined,
    ): number {
        if (ts.isIdentifier(declaration)) {
            declaration =
                tryResolveFunctionDeclaration(this.checker, declaration) ??
                this.fail(
                    declaration,
                    "Callback identity requires a function declaration.",
                );
        }
        const key = this.callbackClosureKey(declaration, owner);
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
        const container = callbackClosureContainer(declaration);
        if (!container) {
            if (owner?.callbackEvaluationIdentity) {
                return owner.callbackEvaluationIdentity;
            }
            // Module scope: the program evaluates the declaration once, so
            // every materialization names the same function object.
            return unownedCallbackScope;
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
                this.fail(
                    declaration,
                    "A callback declared per instance of a shared class has " +
                        "no identity a container could compare: every " +
                        "instance would register the same handler.",
                );
            }
            const properties = instance?.recordProperties;
            if (!properties) {
                this.fail(
                    declaration,
                    "A callback declared in a class body is one function " +
                        "object per instance, and this materialization names " +
                        "no instance to compare it by.",
                );
            }
            return properties;
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
                this.fail(
                    declaration,
                    "A callback declared by a shared class constructor has " +
                        "no per-instance identity a container could compare.",
                );
            }
            // A constructor evaluates once for this exact instance, so its
            // field record is also the identity of every function literal
            // created by that evaluation.
            return owner.recordProperties;
        }
        // Declared inside a function: one function object per evaluation of
        // that body, and the innermost scope the evaluation pushed is what
        // the declaration closed over.
        const scope = owner?.recordScopes?.at(-1);
        if (scope) return scope;
        // A body emitted once as a native function runs many times behind one
        // emission, so its evaluations have no compile-time scope to tell
        // them apart and are refused rather than conflated.
        if (this.returnFrames.some((frame) => frame.kind === "native")) {
            this.fail(
                declaration,
                "A callback declared inside a function emitted as a native " +
                    "function is a new function object at every call, and " +
                    "one identity would make them all the same handler.",
            );
        }
        this.fail(
            declaration,
            "A callback declared inside a function is a new function " +
                "object at every evaluation, and this materialization " +
                "carries no closure to tell those evaluations apart.",
        );
    }

    public defaultEngine(): string | undefined {
        return this.defaultEngineCpp;
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
                nativeCaptures: [
                    this.registerNativeBinding(cppName, false, true, type),
                ],
            };
        }
        const owner = `${cppName}_owner`;
        this.emit({
            kind: "declaration",
            type: "auto",
            name: owner,
            initializer: `bbl::js::make_gc_shared<${type}>()`,
        });
        return {
            kind: "callback",
            cpp: `(*${owner})`,
            sharedStorageCpp: owner,
            nativeCaptures: [
                this.registerNativeBinding(
                    owner,
                    false,
                    false,
                    `std::shared_ptr<${type}>`,
                ),
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
        try {
            return this.emissionTransaction(probe, answered);
        } finally {
            this.probeDepth--;
        }
    }

    public transaction(work: () => void): void {
        this.emissionTransaction(work, commitAlways);
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
    public captureEmittedLines(emitBody: () => void): string[] {
        const start = this.body.length;
        const previousIndent = this.indentLevel;
        const previousScope = this.activeEmissionScope;
        this.activeEmissionScope = this.nextEmissionScope++;
        this.indentLevel = 0;
        try {
            emitBody();
        } finally {
            this.indentLevel = previousIndent;
            this.activeEmissionScope = previousScope;
        }
        return this.body.splice(start);
    }

    /**
     * One native accessor per materialized compile-time table: a record
     * read under a run-time key lowers to a lookup in a `bbl::js::Map`
     * built from the record's entries, and every function reading the same
     * record used to carry its own function-local copy of that map -- five
     * 23-entry block registries in the voxel demo. The map is keyed by its
     * full initializer text, so two reads that materialize the same table
     * at the same types share one definition, and a read whose entries
     * emitted helper lines at the call site keeps its inline form.
     */
    private readonly staticRecordAccessors = new EmissionMap<string, string>();

    /**
     * Identity of the C++ lexical scope currently receiving emitted lines.
     * Captured callback/IIFE bodies get their own identity so a lazily
     * materialized local cannot be reused by code emitted outside that body.
     */
    @journaled private accessor activeEmissionScope = 0;
    @journaled private accessor nextEmissionScope = 1;

    public recordAccessor(
        owner: Value,
        mapType: string,
        entries: readonly string[],
        canHoist: boolean,
    ): string {
        if (!canHoist) {
            if (
                !owner.runtimeRecordCpp ||
                owner.runtimeRecordScope !== this.activeEmissionScope
            ) {
                const table = writable(owner);
                const cppName = this.allocateTemporaryCppName("record_table");
                table.runtimeRecordCpp = cppName;
                table.runtimeRecordScope = this.activeEmissionScope;
                this.emit(`${mapType} ${cppName}{${entries.join(", ")}};`);
                return cppName;
            }
            return owner.runtimeRecordCpp;
        }
        const initializer = `${mapType} values{${entries.join(", ")}};`;
        const existing = this.staticRecordAccessors.get(initializer);
        if (existing) return `bblscene::${existing}()`;
        const name = `bbl_static_table_${this.staticRecordAccessors.size}`;
        this.registerNativeFunction(`${mapType}& ${name}();`, [
            `${mapType}& ${name}() {`,
            `    static thread_local ${initializer}`,
            `    return values;`,
            `}`,
        ]);
        this.staticRecordAccessors.set(initializer, name);
        return `bblscene::${name}()`;
    }

    public registerNativeFunction(
        prototype: string,
        definitionLines: string[],
        source: ts.Node = this.sourceFile,
    ): void {
        this.nativeDefinitions.push({
            kind: "function",
            source: source.getSourceFile().fileName,
            prototype,
            lines: definitionLines,
        });
    }

    public registerSharedNativeFunction(
        name: string,
        definitionLines: string[],
        localBindings: readonly string[],
        declaration?: { source: ts.Node; prototype: string },
    ): string {
        const entry = this.sharedNativeFunctions.intern(
            name,
            definitionLines.join("\n"),
            new Set(localBindings),
        );
        if (entry.added) {
            if (declaration)
                this.registerNativeFunction(
                    declaration.prototype,
                    definitionLines,
                    declaration.source,
                );
            else this.registerNativeTemplate(entry.name, definitionLines);
        }
        return entry.name;
    }

    public renderSharedCoroutine(
        closure: CapturedClosure,
        returnType: string,
        source: ts.Node,
        parameters = "",
        args = "",
        environment = closure.initializer,
        parameterNames: readonly string[] = [],
    ): string {
        const shared = this.registerSharedClosureBody(
            this.allocateTemporaryCppName("async_body"),
            closure,
            returnType,
            source,
            parameters,
            parameterNames,
            "value",
        );
        return `bblscene::${shared}(${environment}${args ? `, ${args}` : ""})`;
    }

    public renderSharedClosure(
        closure: CapturedClosure,
        returnType: string,
        source: ts.Node,
        parameters: string,
        parameterNames: readonly string[],
        name = this.allocateTemporaryCppName("closure_body"),
    ): string {
        const shared = this.registerSharedClosureBody(
            name,
            closure,
            returnType,
            source,
            parameters,
            parameterNames,
            "reference",
        );
        const invocation = closure.environmentType
            ? shared
            : `${shared}<decltype(${closure.initializer})>`;
        return `bbl::js::make_closure(${closure.initializer}, bblscene::${invocation})`;
    }

    private registerSharedClosureBody(
        name: string,
        closure: CapturedClosure,
        returnType: string,
        source: ts.Node,
        parameters: string,
        parameterNames: readonly string[],
        passing: "value" | "reference",
    ): string {
        const signature = `${returnType} ${name}([[maybe_unused]] ${closure.environmentType ?? "Environment"}${passing === "reference" ? "&" : ""} ${closure.environment}${parameters ? `, ${parameters}` : ""})`;
        return this.registerSharedNativeFunction(
            name,
            [
                ...(closure.environmentType
                    ? []
                    : ["template<typename Environment>"]),
                `${signature} {`,
                ...closure.lines,
                "}",
            ],
            [...closure.localBindings, ...parameterNames],
            closure.environmentType
                ? { source, prototype: `${signature};` }
                : undefined,
        );
    }

    public registerNativeTemplate(
        name: string,
        lines: string[],
        prototype?: string,
    ): void {
        this.nativeDefinitions.push({
            kind: "template",
            name,
            lines,
            ...(prototype === undefined ? {} : { prototype }),
        });
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
            sequence: ++this.nextNativeBindingSequence,
            entryLifetime:
                this.bindings.variableScopes.length === 1 &&
                this.activeEmissionScope === 0 &&
                !this.engineStartMark,
        };
        this.nativeBindings.set(name, binding);
        if (
            this.engineStartMark &&
            this.indentLevel === this.engineStartMark.indentLevel
        ) {
            this.continuationLocals.set(name, this.continuationSequence);
        }
        return binding;
    }

    public registerNativeBindingType(name: string, cppType: string): void {
        if (
            cppIdentifierPattern.test(name) &&
            !this.nativeBindingTypes.has(name)
        )
            this.nativeBindingTypes.set(name, cppType);
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
    ): NativeCaptureBinding {
        const binding = this.registerNativeBinding(name, false, allowReference);
        this.nativeConstBindings.add(binding);
        return binding;
    }

    public takeNativeTemporary(cpp: string, boundary: number): string {
        const binding = this.nativeBindings.get(cpp);
        if (
            !binding ||
            binding.sequence <= boundary ||
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
            this.nativeDependencyStack.pop();
        }
        for (const binding of dependencies) {
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

    public describeNativeValue(value: Value): void {
        this.nativeStoredValues.add(value);
        const storage =
            value.sharedStorageCpp ??
            (cppIdentifierPattern.test(value.cpp)
                ? value.cpp
                : (value.optionalStorageCpp ?? value.cpp));
        if (
            isCompileTimeOnlyValue(value.kind) ||
            value.kind === "browser" ||
            !cppIdentifierPattern.test(storage) ||
            ["true", "false", "nullptr"].includes(storage)
        )
            return;
        const cppType =
            value.kind === "engine"
                ? value.ownedEngineCpp
                    ? "std::shared_ptr<bbl::Engine>"
                    : "bbl::Engine"
                : value.kind === "texture" && value.textureStorage === "solid"
                  ? "bbl::SolidTexture"
                  : value.kind === "texture" && value.textureStorage === "file"
                    ? "bbl::FileTexture"
                    : value.kind === "texture" &&
                        value.textureStorage === "pixels"
                      ? "bbl::PixelsTexture"
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

    /** An immutable source binding's native storage and captures are const. */
    public markImmutableNativeStorage(value: Value, immutable: boolean): void {
        const binding = this.nativeBindings.get(value.cpp);
        if (
            binding &&
            !value.sharedStorageCpp &&
            !value.borrowedData &&
            !value.runtimeIteration &&
            immutable
        ) {
            this.nativeConstBindings.add(binding);
        }
        if (immutable && !value.sharedStorageCpp) {
            for (const capture of value.nativeCaptures ?? [])
                this.nativeConstBindings.add(capture);
            for (const captures of Object.values(
                value.nativeCompanionCaptures ?? {},
            )) {
                for (const capture of captures ?? [])
                    this.nativeConstBindings.add(capture);
            }
        }
    }

    public useNativeBinding(binding: NativeCaptureBinding): void {
        // Stored Values keep their own home rather than initializer dependencies.
        // Propagate reads here so a parent expression still sees those reads when
        // its child returns an existing stored Value.
        for (const dependencies of this.nativeDependencyStack)
            dependencies.add(binding);
        for (const capture of this.managedCaptures) capture.use(binding);
        for (const dependencies of this.statementDependencies)
            dependencies.add(binding);
        if (this.engineStartMark) {
            let sequences = this.continuationUses.get(binding.name);
            if (!sequences) {
                sequences = new EmissionSet();
                this.continuationUses.set(binding.name, sequences);
            }
            sequences.add(this.continuationSequence);
        }
    }

    public useNativeValue(value: Value, seen = new EmissionSet<Value>()): void {
        if (seen.has(value)) return;
        seen.add(value);
        if (value.kind !== "record" && value.kind !== "tuple") {
            for (const binding of value.nativeCaptures ?? [])
                this.useNativeBinding(binding);
            const binding = this.nativeBindings.get(value.cpp);
            if (binding) this.useNativeBinding(binding);
        }
        for (const key of nativeCompanionKeys) {
            const companion = value[key];
            if (companion === undefined) continue;
            const dependencies = value.nativeCompanionCaptures?.[key];
            if (dependencies) {
                for (const binding of dependencies)
                    this.useNativeBinding(binding);
            } else {
                const binding = this.nativeBindings.get(companion);
                if (binding) this.useNativeBinding(binding);
            }
        }
        if (value.kind === "record") {
            if (value.sceneNodeVector)
                this.useNativeValue(value.sceneNodeVector.owner, seen);
            if (value.cameraVector)
                this.useNativeValue(value.cameraVector.owner, seen);
            for (const field of Object.values(value.recordProperties ?? {}))
                this.useNativeValue(field, seen);
        }
        if (value.kind === "tuple") {
            for (const field of value.tupleElements ?? [])
                this.useNativeValue(field, seen);
        }
        for (const expression of value.materialUboArrayFields?.values() ?? []) {
            for (const binding of expression.nativeCaptures)
                this.useNativeBinding(binding);
        }
    }

    public captureNativeExpression(
        compile: () => string,
    ): import("./compiler/closure-captures.js").NativeExpression {
        const dependencies = new EmissionSet<NativeCaptureBinding>();
        this.nativeDependencyStack.push(dependencies);
        try {
            return { cpp: compile(), nativeCaptures: [...dependencies] };
        } finally {
            this.nativeDependencyStack.pop();
        }
    }

    public captureManagedClosureLines(
        emitBody: () => void,
        byReference: boolean | "entry" = false,
    ): CapturedClosure {
        const capture = new ClosureCaptures(
            this.allocateTemporaryCppName("environment"),
            this.nextNativeBindingSequence,
            byReference,
            (binding) => this.nativeBindingTypes.get(binding.name),
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
        try {
            lines = this.captureEmittedLines(emitBody);
        } finally {
            if (deferred) {
                this.deferredResourceCaptureDepths.delete(
                    deferred.callbackDepth,
                );
                this.resourceConstructionCheckpoints.delete(deferred);
                this.excludeDeferredResourceConstruction(deferred);
            }
            this.managedCaptures.pop();
        }
        const identifiers = capture.retainReferenced(lines);
        const localBindings = [...identifiers].filter(
            (name) =>
                (this.nativeBindings.get(name)?.sequence ?? 0) >
                    capture.boundary ||
                (this.allocatedCppNames.get(name) ?? 0) > allocationBoundary,
        );
        const environmentType = capture.environmentType;
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
    }

    public beginInlineFrame(wrapped: boolean): void {
        this.returnFrames.push({
            kind: "inline",
            wrapped,
        });
    }

    public endInlineFrame(): void {
        this.validateResourceLoopReturn(this.returnFrames.pop());
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

    public activeInlineWrapper(): boolean {
        const top = this.returnFrames.at(-1);
        return top?.kind === "inline" && top.wrapped;
    }

    public emitNativeReturn(statement: ts.ReturnStatement): void {
        const frame = this.returnFrames.at(-1);
        const coroutine = frame?.kind === "native" && frame.coroutine;
        const returnKeyword = coroutine ? "co_return" : "return";
        const returnType = this.activeNativeReturnType();
        if (returnType === undefined) {
            this.fail(statement, "Return outside a native function.");
        }
        if (coroutine && statement.expression) {
            const result =
                returnType !== "void" && frame.compileReturn
                    ? frame.compileReturn(statement.expression, returnType)
                    : this.compileAsyncReturn(
                          statement.expression,
                          returnType === "void" ? undefined : returnType,
                      );
            this.emit(`co_return ${result};`);
            return;
        }
        if (returnType === "void") {
            if (statement.expression) {
                if (frame?.kind !== "native" || !frame.contextualVoid) {
                    this.fail(
                        statement.expression,
                        "Void functions cannot return a value.",
                    );
                }
                // TypeScript's contextual-void callback rule discards the
                // expression's value but not its side effects. Preserve the
                // same boundary for `return stopEngine(engine)` and for
                // value-returning expressions accepted by a void callback.
                this.emitExpressionAsStatement(statement.expression);
            }
            this.emit(
                coroutine ? "co_return bbl::js::PromiseVoid{};" : "return;",
            );
            return;
        }
        if (!statement.expression) {
            if (returnType.kind === "optional") {
                this.emit(`${returnKeyword} std::nullopt;`);
                return;
            }
            this.fail(
                statement,
                "Non-void native functions must return a value.",
            );
        }
        if (frame?.kind === "native" && frame.compileReturn) {
            this.emit(
                `${returnKeyword} ${frame.compileReturn(statement.expression, returnType)};`,
            );
            return;
        }
        if (returnType.kind === "number") {
            this.emit(
                `${returnKeyword} ${this.compileNumber(statement.expression, "double")};`,
            );
            return;
        }
        if (returnType.kind === "boolean") {
            this.emit(
                `${returnKeyword} ${this.conditions.compileCondition(statement.expression)};`,
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
        this.emit(
            `${returnKeyword} ${this.dataLowerer.compileForSink(statement.expression, returnType)};`,
        );
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
            this.emit(`co_return [&]() -> ${type} { ${statement} }();`);
        } else this.emit(statement);
    }

    public emitDataAssignment(expression: ts.BinaryExpression): boolean {
        return this.dataLowerer.emitAssignment(expression);
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
            const owner = this.unwrap(left.expression);
            if (
                this.resolveRecordValue(owner)?.cameraVector ||
                isCameraExpression(this, owner) ||
                (ts.isPropertyAccessExpression(owner) &&
                    ["target", "position", "upVector"].includes(
                        owner.name.text,
                    ) &&
                    isCameraExpression(this, owner.expression))
            ) {
                this.untrackedTaaCameraWrites.push({
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
            this.untrackedTaaCameraWrites.push({
                node: left,
                reason: `replacing camera.${left.name.text} changes its observable owner`,
            });
        }
        const target = cameraNumberWrite(this, left);
        if (!target) return undefined;
        this.textCameraMutation ??= left;
        noteCameraRecordWrite(
            this,
            target.camera,
            target.property,
            unary ? undefined : node.right,
            operator === "=" &&
                !["target", "position", "up_vector"].includes(target.property),
        );
        if (target.property === "position" || target.property === "up_vector") {
            this.untrackedTaaCameraWrites.push({
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

    public noteCameraVectorSet(
        vector: NonNullable<Value["cameraVector"]>,
        site: ts.Node,
    ): void {
        this.textCameraMutation ??= site;
        noteCameraRecordWrite(
            this,
            vector.owner,
            vector.field,
            undefined,
            false,
        );
        if (vector.field !== "target")
            this.untrackedTaaCameraWrites.push({
                node: site,
                reason: `camera.${vector.field} is not the arc camera's observable target`,
                ...(vector.owner.cameraKind === "free"
                    ? { cameraVersionSafe: true as const }
                    : {}),
            });
    }

    public noteCameraVectorCopy(value: Value, site: ts.Node): void {
        if (value.cameraVector)
            this.untrackedTaaCameraWrites.push({
                node: site,
                reason: "an observable camera vector cannot be copied into a plain data aggregate",
            });
    }

    public noteTemporalAdmissionFailure(node: ts.Node, message: string): void {
        this.deferredAdmissionFailures.push({
            capability: "taa",
            node,
            message,
        });
    }

    public noteMaterialColorRead(
        property: "baseColorFactor" | "diffuseColor",
    ): void {
        this.materialColorReads.push(property);
    }

    public noteLegacyDiffuseColorWrite(node: ts.Node): void {
        this.deferredAdmissionFailures.push({
            capability: "diffuseColor",
            node,
            message:
                "Reading material.diffuseColor requires retained numeric-array producers; the legacy color producer cannot preserve its source shape.",
        });
    }

    public noteMaterialColorRenderBoundary(
        node: ts.Node,
        reason: string,
        always = false,
    ): void {
        if (
            always ||
            this.frameCallbackDepth > 0 ||
            this.engineStartMark !== undefined ||
            this.temporalSceneRegistration
        ) {
            this.deferredAdmissionFailures.push({
                capability: "material-colors",
                node,
                message: `Numeric material-color reads do not yet represent per-group UBO snapshots for ${reason}.`,
            });
        }
    }

    public noteTemporalRecordBoundary(
        node: ts.Node,
        reason: string,
        mode: "runtime" | "registration" | "always" = "runtime",
        scene?: Value,
    ): void {
        const runtime =
            this.frameCallbackDepth > 0 || this.engineStartMark !== undefined;
        if (
            mode === "always" ||
            runtime ||
            (mode !== "registration" && this.temporalSceneRegistration)
        ) {
            this.noteTemporalAdmissionFailure(
                node,
                `TAA task record epochs are not represented for ${runtime ? `runtime ${reason}` : reason}.`,
            );
        }
        if (
            runtime ||
            (mode !== "registration" && this.temporalSceneRegistration) ||
            reason === "rebuildSceneRenderables"
        ) {
            this.deferredAdmissionFailures.push({
                capability: "node-input",
                node,
                message: `Node material binding snapshots do not cover ${runtime ? `runtime ${reason}` : reason}.`,
            });
        }
        if (mode === "registration") {
            this.temporalSceneRegistration ??= node;
            const identity = scene?.sceneTopologyState;
            if (
                !identity ||
                !this.temporalRegisteredScenes.includes(identity)
            ) {
                if (!identity || this.temporalRegisteredScenes.length > 0)
                    this.noteTemporalAdmissionFailure(
                        node,
                        "TAA task record epochs are not represented for TAA supports one proven registered scene until per-scene update/record ordering is represented.",
                    );
                this.temporalRegisteredScenes.push(identity);
            }
        }
    }

    public noteTemporalCameraControl(
        node: ts.Node,
        tracksWorldMatrixVersion = false,
    ): void {
        if (
            this.temporalControlAttachment ||
            this.frameCallbackDepth > 0 ||
            this.engineStartMark !== undefined
        ) {
            this.untrackedTaaCameraWrites.push({
                node,
                reason: "TAA supports one startup control attachment until per-attachment inertia callbacks are represented",
                ...(tracksWorldMatrixVersion && !this.temporalControlAttachment
                    ? { cameraVersionSafe: true as const }
                    : {}),
            });
        }
        this.temporalControlAttachment ??= node;
    }

    public bindAudioMainBusStorage(value: Value): void {
        if (
            value.kind !== "audio-engine" ||
            (value.audioMainBusCpp === undefined &&
                value.optionalStorageCpp === undefined)
        )
            return;
        const owner =
            value.sharedStorageCpp ??
            (cppIdentifierPattern.test(value.cpp)
                ? value.cpp
                : value.optionalStorageCpp) ??
            value.cpp;
        if (value.audioMainBusOwnerCpp === owner) return;
        const name = this.allocateTemporaryCppName("audio_main_bus");
        const initial = value.audioMainBusCpp ?? "bbl::pal::AudioNodeHandle{}";
        const shared = value.sharedStorageCpp !== undefined;
        const borrows =
            !shared &&
            value.audioMainBusCpp !== undefined &&
            this.hasStableNativeExpression(value.audioMainBusCpp);
        this.useNativeValue(value);
        this.emit(
            shared
                ? `[[maybe_unused]] auto ${name} = bbl::js::make_gc_shared<bbl::pal::AudioNodeHandle>(${initial});`
                : borrows
                  ? `[[maybe_unused]] auto& ${name} = ${initial};`
                  : `[[maybe_unused]] bbl::pal::AudioNodeHandle ${name} = ${initial};`,
        );
        writable(value).audioMainBusCpp = shared ? `(*${name})` : name;
        writable(value).audioMainBusOwnerCpp = owner;
        const binding = this.registerNativeBinding(name, false, !shared);
        if (borrows) this.nativeConstBindings.add(binding);
        writable(value).nativeCompanionCaptures = {
            ...value.nativeCompanionCaptures,
            audioMainBusCpp: [binding],
        };
    }

    public assignAudioMainBus(
        target: Value,
        value: Value | undefined,
        node: ts.Node,
    ): void {
        if (target.kind !== "audio-engine") return;
        const destination =
            target.audioMainBusCpp ??
            this.fail(
                node,
                "An audio engine assignment requires materialized main-bus storage.",
            );
        const source = value
            ? (value.audioMainBusCpp ??
              this.fail(
                  node,
                  "An audio engine assignment requires its source main bus.",
              ))
            : "bbl::pal::AudioNodeHandle{}";
        const present = value && presenceCpp(value);
        this.emit(
            `${destination} = ${
                present
                    ? `(${present}) ? ${source} : bbl::pal::AudioNodeHandle{}`
                    : source
            };`,
        );
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
        const cpp = value.ownedEngineCpp ?? value.cpp;
        const found = presenceFlagCpp(value);
        return found !== undefined && found !== "true"
            ? `(${found} ? std::optional{${cpp}} : std::nullopt)`
            : cpp;
    }

    public assignOptionalResourceValue(
        target: Value,
        value: Value,
        node: ts.Node,
    ): void {
        const storage =
            target.optionalStorageCpp ??
            this.fail(
                node,
                `Nullable ${target.kind} value has no optional storage.`,
            );
        if (
            value.kind === "data" &&
            value.dataType?.kind === "optional" &&
            value.dataType.inner.kind === "handle" &&
            value.dataType.inner.handle === target.kind
        ) {
            this.emit(`if (${optionalPresentCpp(value.cpp)}) {`);
            this.emit(`    ${storage} = *${value.cpp};`);
            this.emit("} else {");
            this.emit(`    ${storage}.reset();`);
            this.emit("}");
            this.assignAudioMainBus(target, value, node);
            return;
        }
        if (value.kind !== target.kind) {
            this.fail(
                node,
                `Nullable ${target.kind} assignment received ${value.kind}.`,
            );
        }
        this.emit(`${storage} = ${this.optionalResourceCpp(value)};`);
        this.assignAudioMainBus(target, value, node);
        if (value.engineCpp !== undefined && target.kind !== "engine") {
            writable(target).engineCpp = value.engineCpp;
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
        const right = this.unwrap(expression.right);
        if (right.kind === ts.SyntaxKind.NullKeyword) {
            this.emit(`${storage}.reset();`);
            this.assignAudioMainBus(target, undefined, right);
            delete writable(target).spriteDepthMode;
            return true;
        }
        const value = this.compileValue(right);
        if (value.kind === "json-null") {
            this.emit(`${storage}.reset();`);
            this.assignAudioMainBus(target, undefined, right);
            delete writable(target).spriteDepthMode;
            return true;
        }
        this.assignOptionalResourceValue(target, value, right);
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
        return requiresStaticDataIteration(this, statement);
    }

    public canShareFunctionBody(body: ts.Node): boolean {
        return canShareFunctionBody(
            this,
            body,
            this.definiteCollectionMutation(),
        );
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

    /**
     * The glTF animation groups a call names — the handle-collection
     * concept's list resolution, delegated so intrinsic contexts keep
     * their method.
     */
    public compileAnimationGroupList(expression: ts.Expression): {
        cpp: string;
        engineCpp: string;
    } {
        return this.handleCollections.compileAnimationGroupList(expression);
    }

    /** `<container>.entities` — the concept's entity-walk fold. */
    public assetEntitiesIterationTarget(
        expression: ts.Expression,
    ): Value | undefined {
        return this.handleCollections.assetEntitiesIterationTarget(expression);
    }

    /** `<gltf container>.entities[0]` — the concept's root indexing. */
    public assetRootElementAccess(
        expression: ts.ElementAccessExpression,
    ): Value | undefined {
        return this.handleCollections.assetRootElementAccess(expression);
    }

    /**
     * A proven container flatten's mesh collection, with the container it
     * flattened — the licence a whole-list setter needs.
     */
    public assetFlattenedMeshesIterationTarget(
        expression: ts.Expression,
    ): { target: HandleCollectionTarget; asset: CompileAsset } | undefined {
        return this.handleCollections.assetFlattenedMeshesIterationTarget(
            expression,
        );
    }

    /**
     * Whether a driver loop was already folded into the collection binding
     * its declaration carries — the recursive-visitor flatten's second half.
     */
    public isFoldedFlattenLoop(statement: ts.Statement): boolean {
        return this.handleCollections.isFoldedFlattenLoop(statement);
    }

    /** An imported root's flattened descendants — the concept's walk target. */
    public assetRootChildrenIterationTarget(
        expression: ts.Expression,
    ): HandleCollectionTarget | undefined {
        return this.handleCollections.assetRootChildrenIterationTarget(
            expression,
        );
    }

    /** The loop target a collection expression or binding names. */
    public handleCollectionIterationTarget(
        expression: ts.Expression,
    ): HandleCollectionTarget | undefined {
        return this.handleCollections.iterationTarget(expression);
    }

    public assetMeshCollection(owner: Value, expression: ts.Expression): Value {
        return this.handleCollections.assetMeshCollection(owner, expression);
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

    public setAssetDecoderConfiguration(
        configuration: AssetDecoderConfiguration,
        node: ts.Node,
    ): void {
        const current = this.assetDecoders.get("configuration");
        if (
            Object.entries(configuration).every(
                ([key, value]) =>
                    JSON.stringify(
                        current?.[key as keyof AssetDecoderConfiguration],
                    ) === JSON.stringify(value),
            )
        )
            return;
        if (
            (this.isInRuntimeControlFlow() &&
                this.decoderBootstrapDepths.at(-1) !==
                    this.runtimeControlFlowDepth) ||
            [...this.assets.values()].some(
                (asset) => asset.kind === "gltf" || asset.kind === "basis",
            )
        )
            this.fail(
                node,
                "Asset decoder configuration requires definite setup before compressed asset loads.",
            );
        this.assetDecoders.set("configuration", {
            ...current,
            ...configuration,
        });
    }

    public registerAsset(
        source: string,
        kind: CompileAsset["kind"],
        faceSize?: number,
    ): CompileAsset {
        const asset = registerAsset(this, source, kind, faceSize);
        const decoders = this.assetDecoders.get("configuration");
        if (kind === "gltf" && decoders)
            writable(asset).assetDecoders = decoders;
        return asset;
    }

    /**
     * Records that `setParent` transferred this imported root's hierarchy.
     * The token follows aliases of this handle, rather than the source-keyed
     * asset record shared by repeated loads.
     */
    public markAssetRootReparented(root: Value, node: ts.Node): void {
        if (!root.assetRootState) {
            this.fail(
                node,
                "An imported root is missing its compile-time handle identity.",
            );
        }
        for (const state of assetRootMutationStates(root))
            writable(state).reparented = true;
    }

    /**
     * The current root setters address the asset's outer transform. After
     * `setParent`, the hierarchy follows the new TransformNode instead, so a
     * later write through the old root handle would mutate stale state.
     */
    public assertAssetRootWritable(root: Value, node: ts.Node): void {
        if (assetRootMutationStates(root).some((state) => state.reparented)) {
            this.fail(
                node,
                "Writing an imported root after setParent is not lowered; " +
                    "the hierarchy now follows its new TransformNode parent.",
            );
        }
    }

    public enableGltfCameras(node: ts.Node): void {
        if (!this.definiteCollectionMutation()) {
            this.fail(
                node,
                "glTF camera activation requires a definite setup call; runtime activation order is not represented by packaged assets.",
            );
        }
        this.reachFeature("loader:gltf-cameras", node);
        this.reachFeature("camera:free", node);
    }

    /**
     * Records one run-time glTF container while preserving the order that
     * generation can represent.
     *
     * The asset manifest is keyed by source, and composition expands each
     * record by `containerCount`. Contiguous repeats therefore preserve
     * A,A,B,B exactly, while an interleaved repeat such as A,B,A would be
     * emitted as A,A,B. Refuse the latter at its returning load instead of
     * assigning composed material/mesh handles to the wrong container.
     */
    public recordGltfContainerLoad(asset: CompileAsset, node: ts.Node): void {
        if (
            (asset.containerCount ?? 0) > 0 &&
            this.lastGltfContainerAsset !== asset
        ) {
            this.fail(
                node,
                `glTF asset '${asset.source}' is loaded again after a ` +
                    "different glTF source; repeated loads must be " +
                    "contiguous because generation groups containers by " +
                    "their source-keyed asset record.",
            );
        }
        // One record can back several containers, because assets are keyed
        // by source. A fact generation stamps on the record reaches all of
        // them, so the count is also what lets such a fact refuse instead of
        // widening silently.
        writable(asset).containerCount = (asset.containerCount ?? 0) + 1;
        if (this.hasFeature("loader:gltf-cameras"))
            writable(asset).gltfCameras = true;
        this.lastGltfContainerAsset = asset;
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

    public registerSpriteAtlasAsset(expression: ts.Expression): string {
        return registerSpriteAtlasAsset(this, expression);
    }

    /**
     * Records the one `KHR_materials_variants` selection a scene makes.
     *
     * The fold represents a selection that holds for the whole run, so every
     * shape it cannot produce refuses here rather than compiling to a state
     * the pin never reaches: a second, differing selection on one asset (only
     * the last would render), a selection on a second asset (one name is
     * compiled in and the generated loader matches it against every document
     * it loads), and a selection made from a frame callback (per-frame
     * reassignment folded into frame zero).
     */
    public selectGltfVariant(
        asset: CompileAsset,
        variantName: string,
        node: ts.Node,
    ): void {
        if (this.frameCallbackDepth > 0) {
            this.fail(
                node,
                "selectVariant is folded to one selection for the whole run, " +
                    "so it cannot be called from a frame callback; that " +
                    "would need the pin's run-time variant table.",
            );
        }
        if (
            asset.selectedVariant !== undefined &&
            asset.selectedVariant !== variantName
        ) {
            this.fail(
                node,
                `selectVariant already chose '${asset.selectedVariant}' on ` +
                    "this asset; a second selection would need the pin's " +
                    "run-time variant table.",
            );
        }
        const other = [...this.assets.values()].find(
            (candidate) =>
                candidate !== asset && candidate.selectedVariant !== undefined,
        );
        if (other) {
            this.fail(
                node,
                `selectVariant already chose '${other.selectedVariant}' on ` +
                    `'${other.output}'; one name is compiled in for the ` +
                    "scene, so a second selecting asset would need the pin's " +
                    "run-time variant table.",
            );
        }
        writable(asset).selectedVariant = variantName;
    }

    /**
     * Records the `setPbrUnlit` a scene applied to a loaded container's
     * materials.
     *
     * The pin's setter flags the material object, and its extension's
     * `detect` reads that flag when the variant is composed — so for a
     * loaded material the flag has to reach generation, not just the
     * record. It is kept on the container because the reached shape is a
     * proven walk over every renderable it carries; a single loaded
     * material has no compile-time identity a setter could name.
     */
    public recordAssetSceneUnlit(
        asset: CompileAsset,
        tint: readonly [number, number, number] | undefined,
        node: ts.Node,
    ): void {
        // The record is shared by every `loadGltf` of one source, so a
        // second container would compose unlit without ever being walked.
        if ((asset.containerCount ?? 0) > 1) {
            this.fail(
                node,
                `'${asset.output}' is loaded more than once, and the unlit ` +
                    "arm is composed per document rather than per container, " +
                    "so stamping one container would compose the others " +
                    "unlit too.",
            );
        }
        const existing = asset.sceneUnlit;
        if (existing && existing.tint?.join() !== tint?.join()) {
            this.fail(
                node,
                "setPbrUnlit already tinted this container's materials " +
                    "differently; generation composes one unlit arm per " +
                    "document, so a second tint would need the tint to be a " +
                    "per-material record read.",
            );
        }
        writable(asset).sceneUnlit = tint ? { tint } : {};
    }

    public resolveBundledAsset(source: string): string {
        return resolveBundledAsset(source, this.options.fileName, this.options);
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

    public staticCanvasSize(expression: ts.Expression): number | undefined {
        const property = this.canvasSizeInfo(expression);
        if (!property) return undefined;
        // A retained primary canvas can redraw after a window resize; its
        // client extent is a host observation, including inside Math calls.
        if (this.presentationHostCpp) return undefined;
        return property.axis === "width"
            ? this.options.width
            : this.options.height;
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

    /**
     * Recognize either the pinned two-RAF Promise directly or the exact
     * zero-argument local helper that returns it. The call itself must be
     * awaited and discarded as an expression statement; a returned timestamp
     * used as data is a different contract and must continue through ordinary
     * Promise lowering (which currently refuses it).
     */
    public isBoundedNestedFrameYield(expression: ts.Expression): boolean {
        const awaited = expression.parent;
        if (
            !ts.isAwaitExpression(awaited) ||
            awaited.expression !== expression ||
            !ts.isExpressionStatement(awaited.parent)
        ) {
            return false;
        }
        if (this.browserErasure.isBoundedNestedFrameYield(expression)) {
            return this.requireClosedBoundedFrameYield(expression);
        }
        if (
            !ts.isCallExpression(expression) ||
            expression.arguments.length !== 0 ||
            !ts.isIdentifier(expression.expression)
        ) {
            return false;
        }
        const declaration = resolveFunctionDeclaration(
            this.checker,
            expression.expression,
            (node, message) => this.fail(node, message),
        );
        if (
            !declaration ||
            declaration.parameters.length !== 0 ||
            !declaration.body ||
            !ts.isBlock(declaration.body) ||
            declaration.body.statements.length !== 1
        ) {
            return false;
        }
        const returned = declaration.body.statements[0];
        if (
            returned === undefined ||
            !ts.isReturnStatement(returned) ||
            returned.expression === undefined ||
            !this.browserErasure.isBoundedNestedFrameYield(returned.expression)
        ) {
            return false;
        }
        return this.requireClosedBoundedFrameYield(returned.expression);
    }

    /**
     * Erasing a wait is sound only while its two callbacks are the complete
     * user RAF set. Another callback can mutate state between the current
     * turn and the continuation even when the wait's timestamp is discarded.
     * Scan every non-declaration module in this program and refuse that
     * interleaving instead of silently moving the continuation earlier.
     */
    private requireClosedBoundedFrameYield(allowed: ts.Expression): true {
        let other: ts.CallExpression | undefined;
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (other) return "skip";
                if (
                    ts.isCallExpression(node) &&
                    this.browserErasure.isDefaultRequestAnimationFrameCall(
                        node,
                    ) &&
                    !isDeclaredInside(node, allowed)
                ) {
                    other = node;
                    return "skip";
                }
            });
        for (const source of this.program.getSourceFiles()) {
            if (!source.isDeclarationFile) visit(source);
        }
        if (other) {
            this.fail(
                other,
                "A bounded nested frame yield cannot be erased while " +
                    "another requestAnimationFrame callback can interleave.",
            );
        }
        return true;
    }

    public isBrowserInstrumentationCall(call: ts.CallExpression): boolean {
        const callee = this.unwrap(call.expression);
        if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "addEventListener"
        ) {
            const device = this.unwrap(callee.expression);
            if (
                ts.isPropertyAccessExpression(device) &&
                device.name.text === "_device" &&
                ts.isIdentifier(device.expression) &&
                this.bindings.lookupOptional(device.expression)?.kind ===
                    "engine"
            )
                return false;
        }
        if (
            ts.isPropertyAccessExpression(call.expression) &&
            call.expression.name.text === "assign" &&
            this.libraryGlobal(call.expression.expression) === "Object"
        ) {
            // This erased browser helper cannot invoke observable setters,
            // including through a helper-returned camera/vector argument.
            this.untrackedTaaCameraWrites.push({
                node: call,
                reason: "Object.assign does not lower observable camera setters",
            });
        }
        return this.browserErasure.isBrowserInstrumentationCall(call);
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

    public platformEventCallbackIdentity(
        callback: Value,
        node: ts.Node,
    ): string {
        return this.platform.platformEventCallbackIdentity(callback, node);
    }

    /**
     * Whether every member of an expression's type is one of the DOM
     * library's two canvas types. A program's own type that shares a canvas
     * name is not a canvas, and neither is a member without a symbol.
     */
    public isCanvasElement(expression: ts.Expression): boolean {
        const type = this.checker.getTypeAtLocation(expression);
        const members = type.isUnion() ? type.types : [type];
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

    public readonly hoistedCallbackBindings = new EmissionSet<ts.Symbol>();

    /**
     * JavaScript closures may name a `const` declared later in the same
     * function. Native callback lambdas need that storage to exist before
     * registration, so materialize such locals just ahead of the listener
     * and skip their original declaration when the source walk reaches it.
     */
    public hoistForwardCallbackBindings(
        callback: ts.Expression,
        before: number,
    ): void {
        const candidates = new EmissionMap<ts.Symbol, ts.VariableDeclaration>();
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (ts.isIdentifier(node)) {
                    const symbol = this.symbols.valueSymbol(node);
                    const declaration = symbol?.valueDeclaration;
                    if (
                        symbol &&
                        declaration &&
                        ts.isVariableDeclaration(declaration) &&
                        declaration.initializer &&
                        declaration.pos > before &&
                        ts.isIdentifier(declaration.name) &&
                        !isDeclaredInside(declaration, callback) &&
                        !this.bindings.lookupOptional(declaration.name)
                    ) {
                        candidates.set(symbol, declaration);
                    }
                }
            });
        visit(callback);
        for (const [symbol, declaration] of candidates) {
            this.declarations.emitVariableDeclaration(declaration);
            this.hoistedCallbackBindings.add(symbol);
        }
    }

    /**
     * A platform event callback, with the pin's own parameter announced
     * unused: the signature belongs to the event, not to whether this
     * scene's handler happens to read it. Rendered here rather than at each
     * caller, because the one caller that spelled it by hand was the one that
     * forgot the attribute.
     */
    public compilePlatformCallback(
        callback: ts.Expression,
        parameter: { cppType: string; name: string } | undefined,
        values: readonly Value[],
        documentHiddenCpp?: string,
        captureByValue = true,
        assignIdentity = true,
    ): { cpp: string; identity: string } {
        const asynchronous = this.dataLowerer.promiseCallbackType(callback)
            ? this.dataLowerer.prepareCallbackValue(callback, "platform_async")
            : undefined;
        const stored =
            asynchronous ??
            this.probeEmission(() => {
                const value = this.compileValue(callback);
                return value.kind === "data" &&
                    value.dataType?.kind === "function"
                    ? value
                    : undefined;
            });
        if (stored) {
            this.bindings.refuseEscapingPlatformEventCapturesIn(callback);
            const snapshot = this.allocateTemporaryCppName("platform_callback");
            this.emit({
                kind: "declaration",
                type: "const auto",
                name: snapshot,
                initializer: stored.cpp,
            });
            const binding = this.registerNativeBinding(
                snapshot,
                false,
                false,
                stored.dataType
                    ? `const ${this.dataTypes.cppType(stored.dataType)}`
                    : undefined,
            );
            const closure = this.captureManagedClosureLines(
                () => {
                    if (parameter) {
                        this.registerNativeBindingType(
                            parameter.name,
                            parameter.cppType.replace(/&+\s*$/, "").trim(),
                        );
                        this.registerNativeConstBinding(parameter.name, true);
                    }
                    this.useNativeBinding(binding);
                    this.emitDiscardedValue(
                        this.dataLowerer.compileFunctionValueCall(
                            { ...stored, cpp: snapshot },
                            values,
                            callback,
                        ),
                    );
                },
                captureByValue ? false : "entry",
            );
            return {
                identity: assignIdentity
                    ? this.platformEventCallbackIdentity(
                          { ...stored, cpp: snapshot },
                          callback,
                      )
                    : "0u",
                cpp: this.renderSharedClosure(
                    closure,
                    "void",
                    callback,
                    parameter
                        ? `[[maybe_unused]] ${parameter.cppType} ${parameter.name}`
                        : "",
                    parameter ? [parameter.name] : [],
                ),
            };
        }
        const previousHidden = this.platformDocumentHiddenCpp;
        const previousFrameFloor = this.bindings.frameCallbackScopeFloor;
        const previousPlatformEventCaptureFloor =
            this.bindings.escapingPlatformEventCaptureFloor;
        if (this.frameCallbackDepth === 0) {
            this.bindings.frameCallbackScopeFloor =
                this.bindings.variableScopes.length;
        } else {
            this.bindings.escapingPlatformEventCaptureFloor =
                this.bindings.variableScopes.length;
        }
        this.bindings.refuseEscapingPlatformEventCapturesIn(callback);
        // The scan above compares against the enclosing handler's live scope
        // chain. Callback records may restore the scope chain they closed over
        // while their own body is compiled, so that numeric floor cannot stay
        // active across the restore. Any callback created by this body performs
        // its own scan against the restored chain before it escapes.
        this.bindings.escapingPlatformEventCaptureFloor =
            previousPlatformEventCaptureFloor;
        this.platformDocumentHiddenCpp = documentHiddenCpp;
        this.frameCallbackDepth += 1;
        let compiled: CapturedClosure;
        let identity: string | undefined;
        try {
            compiled = this.captureManagedClosureLines(
                () => {
                    if (parameter) {
                        this.registerNativeBindingType(
                            parameter.name,
                            parameter.cppType.replace(/&+\s*$/, "").trim(),
                        );
                        this.registerNativeConstBinding(parameter.name, true);
                    }
                    const unwrapped = this.unwrap(callback) as
                        | ts.Identifier
                        | ts.PropertyAccessExpression
                        | ts.ArrowFunction
                        | ts.FunctionExpression;
                    const bound = ts.isIdentifier(unwrapped)
                        ? (this.bindings.lookupOptional(unwrapped) ??
                          (() => {
                              const declaration = tryResolveFunctionDeclaration(
                                  this.checker,
                                  unwrapped,
                              );
                              return declaration
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
                                  : this.compileValue(unwrapped);
                          })())
                        : this.compileValue(unwrapped);
                    if (assignIdentity) {
                        identity = this.platformEventCallbackIdentity(
                            bound,
                            callback,
                        );
                    }
                    if (bound.nativePromiseSettlement) {
                        this.emitDiscardedValue(
                            this.dataLowerer.compilePromiseSettlement(
                                bound,
                                values,
                                callback,
                            ),
                        );
                        return;
                    }
                    if (
                        bound.kind === "callback" &&
                        !bound.callbackDeclaration &&
                        bound.cpp.length > 0
                    ) {
                        const parameterTypes =
                            bound.nativeCallbackParameterTypes;
                        if (
                            parameterTypes &&
                            parameterTypes.length > values.length
                        ) {
                            this.fail(
                                callback,
                                "Stored platform callback received the wrong number of arguments.",
                            );
                        }
                        const argumentsCpp = values
                            .slice(0, parameterTypes?.length ?? values.length)
                            .map((value, index) => {
                                const type = parameterTypes?.[index];
                                return type
                                    ? this.dataLowerer.compileKnownValueForSink(
                                          value,
                                          type,
                                          callback,
                                      )
                                    : value.cpp;
                            });
                        this.emit(`${bound.cpp}(${argumentsCpp.join(", ")});`);
                        return;
                    }
                    const declaration =
                        bound.kind === "callback" &&
                        bound.callbackDeclaration &&
                        !ts.isMethodDeclaration(bound.callbackDeclaration)
                            ? bound.callbackDeclaration
                            : ts.isPropertyAccessExpression(unwrapped)
                              ? this.fail(
                                    unwrapped,
                                    "Platform callback property does not resolve to a function value.",
                                )
                              : unwrapped;
                    const compile = () =>
                        this.compileCallbackWithValues(
                            declaration,
                            values,
                            callback,
                        );
                    const result = bound.callbackRecordOwner
                        ? this.withRecordScopes(
                              bound.callbackRecordOwner,
                              compile,
                          )
                        : compile();
                    this.emitDiscardedValue(result);
                },
                captureByValue ? false : "entry",
            );
        } finally {
            this.frameCallbackDepth -= 1;
            this.platformDocumentHiddenCpp = previousHidden;
            this.bindings.frameCallbackScopeFloor = previousFrameFloor;
            this.bindings.escapingPlatformEventCaptureFloor =
                previousPlatformEventCaptureFloor;
        }
        const cppParameter = parameter
            ? `[[maybe_unused]] ${parameter.cppType} ${parameter.name}`
            : "";
        if (assignIdentity && identity === undefined) {
            this.fail(
                callback,
                "Platform event listener has no stable callback identity.",
            );
        }
        return {
            identity: identity ?? "0u",
            cpp: this.renderSharedClosure(
                compiled,
                "void",
                callback,
                cppParameter,
                parameter ? [parameter.name] : [],
            ),
        };
    }

    public isFrameYield(expression: ts.Expression): boolean {
        if (this.browserErasure.isFrameYield(expression)) {
            return true;
        }
        // A zero-argument helper whose whole body returns the same closed
        // Promise is the same yield, not a general async call. Keep the
        // proof structural so a helper with setup, cleanup, parameters, or
        // any other Promise body still takes ordinary lowering and refuses.
        if (
            !ts.isCallExpression(expression) ||
            expression.arguments.length !== 0 ||
            !ts.isIdentifier(expression.expression)
        ) {
            return false;
        }
        const declaration = resolveFunctionDeclaration(
            this.checker,
            expression.expression,
            (node, message) => this.fail(node, message),
        );
        if (
            !declaration ||
            declaration.parameters.length !== 0 ||
            !declaration.body
        ) {
            return false;
        }
        const returned = ts.isBlock(declaration.body)
            ? declaration.body.statements.length === 1 &&
              ts.isReturnStatement(declaration.body.statements[0]!)
                ? declaration.body.statements[0].expression
                : undefined
            : declaration.body;
        return Boolean(returned && this.browserErasure.isFrameYield(returned));
    }

    public emitFramePollAwait(call: ts.CallExpression): boolean {
        if (!ts.isIdentifier(call.expression)) return false;
        const declaration = tryResolveFunctionDeclaration(
            this.checker,
            call.expression,
        );
        if (
            !declaration?.body ||
            !ts.isBlock(declaration.body) ||
            declaration.body.statements.length !== 1
        )
            return false;
        const returned = declaration.body.statements[0]!;
        if (!ts.isReturnStatement(returned) || !returned.expression)
            return false;
        const poll = framePollExecutor(
            this.unwrap(returned.expression),
            this.checker,
            (callee) => this.libraryGlobal(callee),
        );
        if (!poll) return false;
        if (!this.engineStartMark)
            this.fail(call, "A polling Promise requires a running engine.");
        const args = call.arguments.map((argument) =>
            this.compileValue(argument),
        );
        this.bindings.pushScope(this.allocateBlockPrefix());
        let condition: string;
        try {
            for (const [index, parameter] of declaration.parameters.entries()) {
                if (
                    !ts.isIdentifier(parameter.name) ||
                    parameter.dotDotDotToken
                )
                    this.fail(
                        parameter,
                        "Polling helper requires ordinary named parameters.",
                    );
                const argument =
                    args[index] ??
                    (parameter.initializer
                        ? this.compileValue(parameter.initializer)
                        : undefined);
                if (!argument)
                    this.fail(call, "Polling helper argument is missing.");
                this.bindings.bindLocalValue(parameter.name, argument);
            }
            for (const statement of poll.setup) this.emitStatement(statement);
            let conditionCpp = "";
            const lines = this.captureEmittedLines(() => {
                conditionCpp = this.conditions.compileCondition(poll.condition);
            });
            condition =
                lines.length === 0
                    ? conditionCpp
                    : `([&]() { ${lines.join(" ")} return ${conditionCpp}; }())`;
        } finally {
            this.bindings.popScope();
        }
        this.emitStartContinuationGate(call, condition);
        return true;
    }

    /**
     * The line `hoistEngineContinuation` cuts the continuation at. Spelled
     * as a C++-invalid statement so a marker that ever escaped the hoist
     * would refuse to build rather than ship silently; `renderCpp` also
     * fails generation if one survives.
     */
    private static readonly frameYieldRequeueMarker =
        "__bblite_frame_yield_requeue__;";

    /**
     * The line a gated continuation cut leaves behind, carrying the latch
     * the rest of the continuation waits on. Spelled the same
     * C++-invalid way as the yield marker and checked the same way, so
     * one that escaped the hoist refuses rather than shipping.
     */
    private static readonly startContinuationGatePrefix =
        "__bblite_start_continuation_until__(";

    /**
     * A frame yield lowered after `startEngine` sits inside the hoisted
     * continuation, which `finish_frame` drains at the END of a frame --
     * after that frame's uploads and render. Erasing the yield there would
     * run the statements after it at the same boundary as the ones before
     * it, so "one more frame has drawn" would be a claim about nothing.
     * Instead the continuation is cut here: `hoistEngineContinuation`
     * turns the marker into a nested `defer_start_continuation`, whose
     * body the conductor runs at the NEXT frame's drain -- the queue is
     * moved out before draining, so a callback queued during a drain
     * always waits a full frame. That makes the yield (and the
     * `firstSortReady` barrier a splat scene pairs it with) truthful by
     * construction. Before the loop exists the yield stays erased: entry
     * code runs before the first frame's own work, which is the original
     * claim, still true there.
     */
    public emitFrameYieldRequeue(expression: ts.Expression): void {
        const mark = this.engineStartMark;
        if (!mark) {
            return;
        }
        // The re-queue is a cut between EMITTED LINES: `hoistEngineContinuation`
        // splits the tail at each marker and wraps the parts, so a marker at
        // any other depth would cut a C++ block in half. The proof is
        // therefore over the emission rather than over the source AST --
        // where lowering stands when the marker lands, which is exactly
        // where `startEngine` itself landed. That accepts the shapes whose
        // statements are written out FLAT at that level (an inlined helper's
        // body, a statically unrolled loop's iterations) without asking this
        // to re-derive which of them applied, and still refuses a yield
        // inside an emitted block, a value lambda, a callback body, or any
        // other captured region, because none of those is at this depth.
        if (this.indentLevel !== mark.indentLevel) {
            this.fail(
                expression,
                "A frame yield after startEngine re-queues the rest of " +
                    "the continuation to the next frame boundary, which " +
                    "needs the yield to lower at the entry body's own " +
                    "level; inside a block there is no statement " +
                    "boundary to cut at.",
            );
        }
        this.emit(Compiler.frameYieldRequeueMarker);
        this.continuationSequence += 1;
    }

    /**
     * The latch a `new Promise` binding waits on, keyed by the binding's
     * symbol. Empty for every scene but the one that writes the escaping
     * handshake, and the reason the promise value itself has no native
     * representation: what a scene can do with one of these is await it.
     */
    private readonly promiseLatches = new EmissionMap<ts.Symbol, string>();

    /**
     * Declare the latch behind `const p = new Promise((resolve) => {
     * target = resolve; })` and bind `resolve` to it.
     *
     * The executor runs synchronously in JavaScript, so running it here is
     * the faithful reading: after this statement the target holds a
     * callable, and calling it is what the await ends on. The callable is
     * emitted rather than routed through the stored-callback path on
     * purpose -- a stored callback closes over its captures BY VALUE
     * (`plain-data-value-model`), so a generic lowering would latch a copy
     * and the wait would never end.
     */
    public emitEscapingResolvePromise(
        declaration: ts.VariableDeclaration,
        cppName: string,
    ): boolean {
        if (this.options.workers) return false;
        if (!declaration.initializer) return false;
        const target = this.browserErasure.escapingResolveTarget(
            declaration.initializer,
        );
        if (!target) return false;
        if (this.engineStartMark) {
            this.fail(
                declaration,
                "A promise a scene callback resolves is the handshake " +
                    "installed before startEngine; after it the " +
                    "continuation is already running at frame boundaries.",
            );
        }
        const bound = this.bindings.lookupOptional(target);
        if (!bound) {
            this.fail(
                target,
                `Unable to resolve the binding '${target.text}' the ` +
                    "promise's resolve escapes into.",
            );
        }
        const symbol = ts.isIdentifier(declaration.name)
            ? this.symbols.valueSymbol(declaration.name)
            : undefined;
        if (!symbol) {
            this.fail(
                declaration,
                "A promise a scene callback resolves needs a named binding.",
            );
        }
        this.emit({
            kind: "declaration",
            type: "bool",
            name: cppName,
            initializer: "false",
        });
        this.emit(`${bound.cpp} = [&${cppName}]() { ${cppName} = true; };`);
        this.promiseLatches.set(symbol, cppName);
        return true;
    }

    /**
     * The latch `await <binding>` waits on, or undefined when the awaited
     * expression is not one of this scene's handshake promises.
     */
    public promiseLatchCondition(
        expression: ts.Expression,
    ): string | undefined {
        if (!ts.isIdentifier(expression)) return undefined;
        const symbol = this.symbols.valueSymbol(expression);
        return symbol ? this.promiseLatches.get(symbol) : undefined;
    }

    /**
     * `await <handshake promise>`: park the rest of the continuation until
     * the scene's own callback resolves it.
     *
     * This is the frame-yield cut with a condition on it. A yield names a
     * COUNT of boundaries; this names none -- the scene installed a
     * callback and the wait ends when that callback runs -- so the
     * re-queue repeats until the latch is set instead of once. The
     * capture gate rides along unchanged, because a start continuation
     * that has not run yet already holds it.
     */
    public emitStartContinuationGate(
        expression: ts.Expression,
        latch: string,
    ): void {
        const mark = this.engineStartMark;
        if (!mark) {
            this.fail(
                expression,
                "A promise a scene callback resolves is awaited after " +
                    "startEngine, where the frame boundaries that run " +
                    "that callback exist.",
            );
        }
        if (this.indentLevel !== mark.indentLevel) {
            this.fail(
                expression,
                "Awaiting a scene-resolved promise parks the rest of the " +
                    "continuation, which needs the await to lower at the " +
                    "entry body's own level; inside a block there is no " +
                    "statement boundary to cut at.",
            );
        }
        this.emit(`${Compiler.startContinuationGatePrefix}${latch});`);
        this.continuationSequence += 1;
        for (const binding of this.statementDependencies.at(-1) ?? [])
            this.useNativeBinding(binding);
    }

    /**
     * A module-level `const`'s own initializer, for a reader that may only
     * answer from an immutable binding.
     *
     * `staticConstants` deliberately admits the ENTRY file's `let` and `var`
     * too -- the emitter deletes each one as it reaches its declaration, so
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
            (declaration.parent.flags & ts.NodeFlags.Const) === 0
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
        if (!valueContainsPlatformEvent(this.dataTypes, value)) return;
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
    public unwrap(expression: ts.Expression): ts.Expression {
        return this.evaluator.unwrap(expression);
    }

    public materializeStaticNativeValue(
        identifier: ts.Identifier,
        value: Value,
    ): Value {
        const existing = this.bindings.lookupOptional(identifier);
        if (existing) return existing;
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        const cppName = this.bindings.cppIdentifier(identifier.text);
        this.staticNativeDeclarations.push(`auto ${cppName} = ${value.cpp};`);
        const stored = { ...value, cpp: cppName };
        this.bindings.variableScopes[0]!.set(symbol, {
            name: identifier.text,
            value: stored,
        });
        return stored;
    }

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
            this.needsSharedClosureStorage(declaration, identifier) &&
            (this.isSharedClosureScalar(value.dataType?.kind ?? value.kind)
                ? isSupportedFunction(declaration.parent) &&
                  !parameterIsReadOnly(
                      this.checker,
                      declaration.parent,
                      identifier,
                  )
                : this.identifierIsRebound(identifier))
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

    public compileStoredDataFunction(
        expression:
            | ts.Identifier
            | ts.FunctionDeclaration
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        dataType: DataType & { kind: "function" },
        owner?: Value,
    ): string {
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
                      ...(this.isInRuntimeIteration() ||
                      this.isInNativeFunctionBody() ||
                      (lexicalThis?.dataType?.kind === "struct" &&
                          this.dataTypes.isClassStruct(
                              lexicalThis.dataType.name,
                          ))
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
        const compile = (): string => {
            if (effectiveOwner?.runtimeCallbackIdentityCpp) {
                this.useNativeValue({
                    kind: "number",
                    cpp: effectiveOwner.runtimeCallbackIdentityCpp,
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
            );
            this.registerNativeBinding(cpp);
            return cpp;
        };
        if (!effectiveOwner) {
            return compile();
        }
        return this.withRecordScopes(effectiveOwner, () => {
            if (!effectiveOwner.recordProperties) {
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
            const previousThis = this.thisInstance;
            this.defineThis(effectiveOwner);
            try {
                return compile();
            } finally {
                this.defineThis(previousThis);
            }
        });
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

    /**
     * Register the callback shape emitted by the pinned collision-event walk.
     *
     * The body is specialized after startup lowering has seen later callback
     * assignments, then inserted before `startEngine`. Registration itself
     * stays at the source site through the forwarding lambda returned here.
     */
    public compilePhysicsCollisionCallback(expression: ts.Expression): string {
        return this.compilePhysicsEventCallback(expression, "collision");
    }

    public compilePhysicsTriggerCallback(expression: ts.Expression): string {
        return this.compilePhysicsEventCallback(expression, "trigger");
    }
    public compilePhysicsCharacterCallback(expression: ts.Expression): string {
        return this.compilePhysicsEventCallback(expression, "character");
    }

    /**
     * A handler on one of the two pinned physics event streams.
     *
     * Both are registered before every startup assignment has necessarily
     * run, so both defer their native body until the entry walk completes
     * while retaining the registration site's scopes. What differs is the
     * info record the pin hands the callback, which
     * `physicsEventInfoValue` builds.
     */
    private compilePhysicsEventCallback(
        expression: ts.Expression,
        event: "collision" | "trigger" | "character",
    ): string {
        const callback = this.unwrap(expression);
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            this.fail(
                callback,
                `Physics ${event} callbacks must be a local function or function literal.`,
            );
        }
        const infoType = physicsEventInfoType(event);
        const eventName = this.allocateTemporaryCppName(`physics_${event}`);
        const callbackName = this.allocateTemporaryCppName(
            `physics_${event}_callback`,
        );
        this.reachJsData();
        this.emit(`std::function<void(const ${infoType}&)> ${callbackName};`);
        this.deferredPhysicsCallbacks.push({
            event,
            callback,
            cppName: callbackName,
            eventName,
            node: expression,
            scopes: this.bindings.variableScopes.map(
                (scope) => new EmissionMap(scope),
            ),
        });
        return (
            `[&](const ${infoType}& ${eventName}) { ` +
            `if (${callbackName}) { ${callbackName}(${eventName}); } }`
        );
    }

    /** Emit deferred physics event bodies immediately before the engine starts. */
    private emitDeferredPhysicsCallbacks(): void {
        if (this.deferredPhysicsCallbacks.length === 0) return;
        const emitted: string[] = [];
        for (const deferred of this.deferredPhysicsCallbacks) {
            const savedScopes = [...this.bindings.variableScopes];
            this.bindings.variableScopes.length = 0;
            this.bindings.variableScopes.push(...deferred.scopes);
            const event = deferred.eventName;
            const info = physicsEventInfoValue(deferred.event, event);
            const previousDepth = this.frameCallbackDepth;
            this.frameCallbackDepth += 1;
            try {
                const lines = this.captureEmittedLines(() => {
                    const result = this.compileCallbackWithValues(
                        deferred.callback,
                        [info],
                        deferred.node,
                    );
                    this.emitDiscardedValue(result);
                });
                const indent = "    ".repeat(2);
                // The signature is the pin's, so the parameter stays whether
                // the body reads it or not -- scene 100's collision handler
                // logs and writes a dataset flag, both of which erase, so it
                // reads nothing at all. Announced unused unconditionally, as
                // `compileFrameCallback` announces its delta.
                emitted.push(
                    `${indent}${deferred.cppName} = [&]([[maybe_unused]] const ${physicsEventInfoType(deferred.event)}& ${event}) {`,
                    ...lines.map((line) => `    ${line}`),
                    `${indent}};`,
                );
            } finally {
                this.frameCallbackDepth = previousDepth;
                this.bindings.variableScopes.length = 0;
                this.bindings.variableScopes.push(...savedScopes);
            }
        }
        const insertion = this.engineStartMark?.index ?? this.body.length;
        this.body.splice(insertion, 0, ...emitted);
        this.deferredPhysicsCallbacks.length = 0;
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
        if (carriedState) {
            return carriedState.untrackedAliases ||
                this.parameterizedResourceIterations.some((frame) =>
                    carriedState.varyingIn.has(frame),
                )
                ? undefined
                : carriedState.count;
        }
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
        const state =
            value?.collectionCardinality ??
            value?.staticElementsOwner?.collectionCardinality;
        if (state) {
            return state.untrackedAliases ||
                this.parameterizedResourceIterations.some((frame) =>
                    state.varyingIn.has(frame),
                )
                ? undefined
                : state.count;
        }
        return (
            value?.tupleElements ??
            value?.staticElementsOwner?.staticElements ??
            value?.staticElements
        )?.length;
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

    private definiteCollectionMutation(): boolean {
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
            !this.definiteCollectionMutation() ||
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
        if (value.kind !== kind) {
            this.fail(node, `Expected ${kind}, received ${value.kind}.`);
        }
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
            this.fail(
                node,
                `A ${value.kind} value is not associated with an engine.`,
            );
        }
        this.trackRetainedCaptureName(value.engineCpp);
        return value.engineCpp;
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
        if (!this.defaultEngineCpp) {
            this.fail(
                node,
                "This intrinsic requires createEngine to run first.",
            );
        }
        if (
            this.returnFrames.some(
                (frame) => frame.kind === "native" && frame.namespaceScope,
            )
        )
            this.fail(
                node,
                "A namespace-scope function has no binding for the entry's engine.",
                "entry-scope-required",
            );
        this.trackRetainedCaptureName(this.defaultEngineCpp);
        return this.defaultEngineCpp;
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
     * feature an audited companion file reaches with no call in the scene
     * to name — the already-formatted location of that file.
     */
    public reachFeature(feature: Feature, site?: ts.Node | string): void {
        if (
            !this.options.workers &&
            (feature === "frame-graph:surface-target" ||
                feature === "environment:procedural-sky" ||
                feature === "compute:storage-texture" ||
                feature === "compute:storage-buffer" ||
                feature === "compute:task" ||
                feature === "compute:shader" ||
                feature === "compute:uniform-buffer" ||
                feature === "engine:gpu-retirement")
        )
            throw new ApplicationRealmRequired();
        if (
            ((feature === "math:mat4-invert" ||
                feature === "math:mat4-create") &&
                this.features.has("renderer:high-precision-matrix")) ||
            (feature === "renderer:high-precision-matrix" &&
                (this.features.has("math:mat4-invert") ||
                    this.features.has("math:mat4-create")))
        ) {
            this.fail(
                typeof site === "object" ? site : this.sourceFile,
                "Scene-code matrix intrinsics currently require Float32 Mat4 storage; high-precision matrix allocation is not supported.",
            );
        }
        for (const implied of impliedFeatures(feature))
            this.reachFeature(implied, site);
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

    /**
     * Whether a glTF has already been loaded at this point in the walk.
     *
     * The one question this compiler asks of the reached-feature set
     * *during* the walk rather than after it, and it is deliberately
     * narrow: the set is otherwise an accumulate-only inventory, and a
     * general "has this been reached yet" query would make every consumer
     * order-sensitive. `enableBoneControl` needs it because upstream the
     * call installs a builder hook, so only the loads after it carry
     * skeletons — and this port emits ONE loader for every load, so it
     * cannot give two assets different builders and refuses the order
     * instead.
     */
    public gltfAlreadyLoaded(): boolean {
        return this.features.has("loader:gltf");
    }

    public compileSceneRegistration(scene: Value, node: ts.Node): string {
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
        this.registerNativeFunction(
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
        if (!this.defaultRenderTaskAdapted) {
            this.registerNativeFunction(
                "void bbl_ensure_default_render_task(bbl::Scene& scene);",
                [
                    "void bbl_ensure_default_render_task(bbl::Scene& scene) {",
                    '    if (!scene.engine) throw std::runtime_error("A scene render task requires its owning engine.");',
                    "    if (scene.state->default_render_task && !scene.state->default_render_task_created) {",
                    "        auto& engine = *scene.engine;",
                    "        auto target = bbl::create_render_target(engine, " +
                        "bbl::RenderTargetOptions{scene.state->default_render_task_samples, true, true, false, 0u, 0u});",
                    "        auto resolve_target = bbl::create_render_target(engine, " +
                        "bbl::RenderTargetOptions{1u, true, false, false, 0u, 0u});",
                    `        ${recordAt("engine.render_targets", "target")}.surface_canvas = scene.surface_canvas;`,
                    `        ${recordAt("engine.render_targets", "resolve_target")}.surface_canvas = scene.surface_canvas;`,
                    "        auto render_task = bbl::create_render_task(engine, scene, " +
                        'bbl::RenderTaskOptions{"default-render-task", target, std::nullopt, true, ' +
                        `${handleCppType("camera")}{}, false, true, true, true});`,
                    "        bbl::add_task(scene, render_task);",
                    "        auto resolve_task = bbl::create_copy_to_texture_task(engine, scene, " +
                        'bbl::CopyTaskOptions{"default-resolve", bbl::render_target_texture(target), ' +
                        "bbl::RenderTargetHandle{}, resolve_target, false, bbl::NormalizedViewport{}});",
                    "        bbl::add_task(scene, resolve_task);",
                    "        auto present_task = bbl::create_copy_to_texture_task(engine, scene, " +
                        'bbl::CopyTaskOptions{"default-present", bbl::render_target_texture(resolve_target), ' +
                        "bbl::swapchain_render_target(engine), bbl::RenderTargetHandle{}, false, bbl::NormalizedViewport{}});",
                    "        bbl::add_task(scene, present_task);",
                    "        scene.state->default_render_task_created = true;",
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

    public engineHasStarted(): boolean {
        return this.engineStartMark !== undefined;
    }

    public hasRegisteredScene(): boolean {
        return this.temporalSceneRegistration !== undefined;
    }

    public emit(line: string | NativeDeclaration): void {
        const code =
            typeof line === "string" ? line : renderNativeDeclaration(line);
        if (typeof line !== "string") {
            if (!/\bauto\b|\bdecltype\b/.test(line.type))
                this.registerNativeBindingType(
                    line.name,
                    line.type.replace(/&+$/, "").trim(),
                );
            else if (line.type === "auto&" || line.type === "auto&&") {
                const sourceType = this.nativeBindingTypes.get(
                    line.initializer,
                );
                if (sourceType)
                    this.registerNativeBindingType(line.name, sourceType);
            }
            this.nativeDeclarations.set(code, {
                ...line,
                dependencies: [
                    ...(this.statementDependencies.at(-1) ?? []),
                ].map((binding) => binding.name),
            });
        }
        const emitted = `${"    ".repeat(this.indentLevel)}${code}`;
        this.staticExpansionBudget.emit(emitted);
        this.body.push(emitted);
    }

    /**
     * Where `startEngine` lands in the entry body.
     *
     * Upstream `startEngine` schedules the render loop and RETURNS, so the
     * rest of `main` runs interleaved with the frames it started -- which is
     * how a scene picks, reads the result and mutates the scene before the
     * capture. `pal::run_engine` does not return until the loop ends, so the
     * same statements emitted in place would run after the capture and
     * decide nothing. They are the browser's continuation, and the frame
     * conductor already has the boundary it wants: the deferred-callback
     * queue `finish_frame` drains at the end of each frame, after that
     * frame's uploads and render.
     */
    @journaled private accessor engineStartMark:
        | {
              index: number;
              engine: string;
              node: ts.Node;
              indentLevel: number;
          }
        | undefined;

    @journaled private accessor continuationStorageReached = false;

    private readonly deviceRecoveryCallbacks: Array<{
        cpp: string;
        options: Value;
        node: ts.Expression;
    }> = emissionArray([]);

    public compileDeviceRecoveryIntrinsic(
        name: string,
        call: ts.CallExpression,
    ): Value | undefined {
        if (
            ![
                "enableDeviceLostSceneRecovery",
                "forceWebGpuDeviceLossForTesting",
                "disposeEngine",
            ].includes(name)
        )
            return undefined;
        this.expectArgumentCount(
            call,
            1,
            name === "enableDeviceLostSceneRecovery" ? 2 : 1,
        );
        const engine = this.compileValue(argumentAt(call, 0));
        this.expectKind(engine, "engine", argumentAt(call, 0));
        this.reachFeature(
            name === "disposeEngine"
                ? "engine:dispose"
                : "engine:device-recovery",
            call,
        );
        if (name === "enableDeviceLostSceneRecovery") {
            if (this.engineHasStarted() || this.isRuntimeResourceConstruction())
                this.fail(
                    call,
                    "Device recovery registration requires unconditional construction before engine startup.",
                );
            const cpp = this.allocateTemporaryCppName("device_recovery");
            this.emit({
                kind: "declaration",
                type: "auto",
                name: cpp,
                initializer: `bbl::enable_device_lost_scene_recovery(${engine.cpp})`,
            });
            if (call.arguments[1]) {
                const node = call.arguments[1];
                const options = this.compileValue(node);
                this.expectKind(options, "record", node);
                const allowed = new EmissionSet([
                    "onLost",
                    "onRecovered",
                    "onRecoveryFailed",
                ]);
                for (const key of [
                    ...Object.keys(options.recordProperties ?? {}),
                    ...Object.keys(options.recordMethods ?? {}),
                ]) {
                    if (!allowed.has(key))
                        this.fail(
                            node,
                            `Unrepresented device recovery option '${key}'.`,
                        );
                }
                this.deviceRecoveryCallbacks.push({ cpp, options, node });
            }
            return {
                kind: "device-recovery",
                cpp,
                engineCpp: engine.cpp,
                dataType: { kind: "handle", handle: "device-recovery" },
            };
        }
        return {
            kind: "void",
            cpp:
                name === "disposeEngine"
                    ? `bbl::dispose_engine(${engine.cpp})`
                    : `bbl::force_device_loss(${engine.cpp})`,
        };
    }

    private emitDeviceRecoveryCallbacks(): void {
        for (const registration of this.deviceRecoveryCallbacks.splice(0)) {
            const options = registration.options;
            for (const [source, target] of [
                ["onLost", "on_lost"],
                ["onRecovered", "on_recovered"],
                ["onRecoveryFailed", "on_failed"],
            ] as const) {
                const callback =
                    options.recordMethods?.[source] ??
                    options.recordProperties?.[source]?.callbackDeclaration;
                if (!callback) {
                    if (options.recordProperties?.[source])
                        this.fail(
                            registration.node,
                            `Device recovery '${source}' requires a callback declaration.`,
                        );
                    continue;
                }
                const declaration = ts.isIdentifier(callback)
                    ? tryResolveFunctionDeclaration(this.checker, callback)
                    : callback;
                if (
                    !declaration ||
                    declaration.parameters.length >
                        (target === "on_failed" ? 1 : 0)
                )
                    this.fail(
                        callback,
                        `The recovery '${source}' callback parameters are not represented.`,
                    );
                const error =
                    target === "on_failed"
                        ? this.allocateTemporaryCppName("recovery_error")
                        : undefined;
                const parameter =
                    target === "on_failed"
                        ? ({
                              kind: "record",
                              cpp: "",
                              nativeError: true,
                              truthinessCpp: "true",
                              recordProperties: {
                                  message: {
                                      kind: "string",
                                      cpp: error!,
                                      dataType: { kind: "string" },
                                  },
                              },
                          } satisfies Value)
                        : undefined;
                const lines = this.captureEmittedLines(() => {
                    if (error) this.registerNativeConstBinding(error, true);
                    const result = this.compileCallbackWithValues(
                        callback,
                        parameter ? [parameter] : [],
                        registration.node,
                    );
                    this.emitDiscardedValue(result);
                });
                this.emit(
                    `${registration.cpp}->${target} = [&](${error ? `[[maybe_unused]] const std::string& ${error}` : ""}) {`,
                );
                this.increaseIndent();
                for (const line of lines) this.emit(line);
                this.decreaseIndent();
                this.emit("};");
            }
        }
    }

    public markEngineStart(engineCpp: string, node: ts.Node): void {
        this.emitDeviceRecoveryCallbacks();
        if (this.ui.primaryCanvasReadyGate)
            this.emit(
                `bbl::defer_capture_until(${engineCpp}, [&]() { return bbl::canvas_dataset(${engineCpp}, "ready") == "true"; });`,
            );
        if (this.engineStartMark) {
            this.fail(
                node,
                "A second startEngine is a restart this runtime does not " +
                    "lower; the first one already owns the continuation.",
            );
        }
        this.engineStartMark = {
            index: this.body.length,
            engine: engineCpp,
            node,
            indentLevel: this.indentLevel,
        };
    }

    /** Emit the same worker-aware cleanup for synchronous and suspended scopes. */
    public emitFinallyGuard(cleanup: readonly string[]): string {
        this.reachJsData();
        const guard = this.allocateTemporaryCppName("finally");
        this.emit(`[[maybe_unused]] auto ${guard} = bbl::js::finally([&]() {`);
        this.increaseIndent();
        const workerAbort = this.workerAbortCpp();
        if (workerAbort) this.emit(`if (${workerAbort}) return;`);
        else if (this.options.pendingActivations)
            this.emit("if (bbl::js::activation_abandoned()) return;");
        for (const line of cleanup) this.emit(line);
        this.decreaseIndent();
        this.emit("});");
        return guard;
    }

    /** Keep a flat try/finally alive across the startEngine continuation. */
    public emitEngineFinally(
        body: readonly string[],
        cleanup: () => readonly string[],
        site: ts.TryStatement,
    ): boolean {
        const mark = this.engineStartMark;
        if (!mark || site.catchClause) return false;
        const start = body.findIndex((line) =>
            line.startsWith("bbl::start_engine("),
        );
        if (start < 0) return false;
        // The two lifetime guards can run while C++ is unwinding. A second
        // exception would terminate rather than replace the source exception.
        // Until finally has explicit completion lowering, admit plain cleanup
        // writes and refuse calls/accessors whose exception effects are unknown.
        const checkCleanup = (node: ts.Node): void => {
            if (ts.isFunctionLike(node)) return;
            // Erased browser calls with no arguments have no native cleanup
            // effects. Platform-backed calls remain outside browser erasure.
            if (
                ts.isCallExpression(node) &&
                node.arguments.length === 0 &&
                this.browserErasure.isBrowserOnlyExpression(node)
            )
                return;
            const properties = ts.isPropertyAccessExpression(node)
                ? [resolvedSymbol(this.checker, node)]
                : ts.isElementAccessExpression(node)
                  ? this.checker
                        .getTypeAtLocation(node.expression)
                        .getProperties()
                  : [];
            const accessor = properties.some((property) =>
                property?.declarations?.some(
                    (declaration) =>
                        ts.isGetAccessorDeclaration(declaration) ||
                        ts.isSetAccessorDeclaration(declaration),
                ),
            );
            if (
                ts.isThrowStatement(node) ||
                ts.isCallExpression(node) ||
                ts.isNewExpression(node) ||
                accessor
            ) {
                this.fail(
                    node,
                    "A finally block spanning startEngine requires non-throwing cleanup; calls, accessors and throw are not admitted.",
                );
            }
            ts.forEachChild(node, checkCleanup);
        };
        if (site.finallyBlock) checkCleanup(site.finallyBlock);
        if (
            body
                .slice(start + 1)
                .some(
                    (line) =>
                        line.trim() === Compiler.frameYieldRequeueMarker ||
                        line
                            .trim()
                            .startsWith(Compiler.startContinuationGatePrefix),
                )
        ) {
            this.fail(
                site,
                "A finally block spanning startEngine cannot also span a later frame yield.",
            );
        }
        const cleanupLines = cleanup();
        const guard = cleanupLines.length
            ? this.emitFinallyGuard(cleanupLines)
            : undefined;
        for (const line of body.slice(0, start)) this.emit(line);
        const started = writable(mark);
        started.index = this.body.length;
        started.indentLevel = this.indentLevel;
        this.emit(body[start]!);
        if (!guard) {
            for (const line of body.slice(start + 1)) this.emit(line);
            return true;
        }
        // The outer guard covers setup/start failures. The continuation
        // guard finishes cleanup on its own normal, return or exception
        // completion, while the outer guard remains safe to destroy later.
        const completion = this.allocateTemporaryCppName("finally_completion");
        this.emit({
            kind: "declaration",
            type: "auto",
            name: completion,
            initializer: `bbl::js::finally([&]() { ${guard}.run(); })`,
        });
        for (const line of body.slice(start + 1)) this.emit(line);
        this.emit(`${completion}.run();`);
        return true;
    }

    /** Move the post-start body to frame drains, counting consecutive empty waits. */
    private hoistEngineContinuation(): void {
        const mark = this.engineStartMark;
        if (!mark) {
            return;
        }
        let index = mark.index;
        while (
            index < this.body.length &&
            !this.body[index]!.includes("bbl::start_engine(")
        ) {
            index += 1;
        }
        if (index >= this.body.length) {
            return;
        }
        const tail = this.body.splice(index + 1);
        if (tail.length === 0) {
            return;
        }
        // The continuation has to be a run of statements at the call's own
        // depth. A `startEngine` inside a block would leave that block's
        // closing brace in the tail at a shallower indent, and moving it
        // into the lambda would emit unbalanced C++ -- so the shape is
        // checked here, where the emitted lines say what it is, rather
        // than guessed from the lowering scope.
        const depth = (line: string): number =>
            line.length - line.trimStart().length;
        const startDepth = depth(this.body[index]!);
        const escapes = tail.find(
            (line) => line.trim().length > 0 && depth(line) < startDepth,
        );
        if (escapes !== undefined) {
            this.fail(
                mark.node,
                "startEngine is lowered at the entry body's top level " +
                    "alone: the statements after it become the frame " +
                    "conductor's deferred callback, and a block that " +
                    "closes after it has no boundary for one.",
            );
        }
        const indent = " ".repeat(startDepth);
        // A part runs after its frame count or promise gate. Statement-bearing
        // parts stay nested so later parts can name earlier persistent locals.
        let sequence = 0;
        const parts: {
            gate?: string;
            frames: number;
            lines: string[];
            sequence: number;
        }[] = [{ frames: 1, lines: [], sequence }];
        for (const line of tail) {
            const trimmed = line.trim();
            if (trimmed === Compiler.frameYieldRequeueMarker) {
                sequence += 1;
                const previous = parts.at(-1)!;
                if (
                    previous.lines.length === 0 &&
                    previous.gate === undefined
                ) {
                    previous.frames += 1;
                    previous.sequence = sequence;
                } else {
                    parts.push({ frames: 1, lines: [], sequence });
                }
            } else if (
                trimmed.startsWith(Compiler.startContinuationGatePrefix) &&
                trimmed.endsWith(");")
            ) {
                parts.push({
                    frames: 1,
                    sequence: ++sequence,
                    gate: trimmed.slice(
                        Compiler.startContinuationGatePrefix.length,
                        -2,
                    ),
                    lines: [],
                });
            } else {
                parts.at(-1)!.lines.push(line);
            }
        }
        const storage = this.allocateTemporaryCppName("continuation_storage");
        const retainsLocals = persistContinuationLocals(
            parts,
            this.nativeDeclarations,
            this.continuationUses,
            this.continuationLocals,
            startDepth,
            storage,
        );
        this.continuationStorageReached = retainsLocals;
        const captures = retainsLocals ? `[&, ${storage}]` : "[&]";
        let nested: string[] = [];
        // Bound indentation for continuations with many statement-bearing parts.
        const maxIndentedDepth = 8;
        for (let part = parts.length - 1; part >= 0; part -= 1) {
            const step = parts.length - part <= maxIndentedDepth ? "    " : "";
            const { gate, frames } = parts[part]!;
            const resolved =
                gate !== undefined
                    ? `${captures}() { return ${gate}; }`
                    : frames > 1
                      ? `[remaining = ${frames}u]() mutable { return --remaining == 0; }`
                      : undefined;
            nested = [
                resolved === undefined
                    ? `${indent}bbl::defer_start_continuation(` +
                      `${mark.engine}, ${captures}() {`
                    : `${indent}bbl::defer_start_continuation_until(` +
                      `${mark.engine}, ${resolved}, ` +
                      `${captures}() {`,
                ...[...parts[part]!.lines, ...nested].map(
                    (line) => `${step}${line}`,
                ),
                `${indent}});`,
            ];
        }
        if (retainsLocals)
            nested.unshift(
                `${indent}auto ${storage} = std::make_shared<bbl::ContinuationStorage>();`,
            );
        this.body.splice(index, 0, ...nested);
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
            emission: this.activeEmissionScope,
            block: this.emissionBlocks.at(-1)!,
            continuation: this.engineStartMark?.index ?? -1,
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
                !this.engineStartMark ||
                this.options.workers ||
                this.presentationHostCpp ||
                this.engineStartMark.indentLevel !== 2
            ) {
                this.failAtFile(
                    "Physics debug geometry extraction requires one top-level startEngine after the admitted construction graph.",
                );
            }
            physicsDebugConstructionBody = this.body.slice(
                0,
                this.engineStartMark.index,
            );
        }
        this.hoistEngineContinuation();
        if (
            this.body.some(
                (line) => line.trim() === Compiler.frameYieldRequeueMarker,
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
                line.trim().startsWith(Compiler.startContinuationGatePrefix),
            )
        ) {
            this.failAtFile(
                "A gated continuation marker survived outside the " +
                    "hoisted continuation; the latch it parks the rest " +
                    "of the continuation behind was never emitted.",
            );
        }
        return renderMainCpp({
            source: this.options.fileName,
            ...(this.options.workers
                ? {
                      workers: {
                          namespace: this.options.workers.namespace,
                          declarations: this.options.workers.declarations(),
                          hasEngine: this.defaultEngineCpp !== undefined,
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
            imageDecodeReached: this.imageDecodeReached,
            runtimeMeshProfiles: this.sceneManifest.hasRuntimeMeshProfiles(),
            jsRandomReached: this.jsRandomReached,
            audioSessionReached: this.audioSessionReached,
            continuationStorageReached: this.continuationStorageReached,
            pendingActivations: !!this.options.pendingActivations,
            throwReached: this.throwReached,
            postProcessCompositeCount:
                this.sceneManifest.postProcessComposites.length,
            screenSpaceTaskCount: this.sceneManifest.screenSpaceTasks.length,
            renderDataPreamble: () =>
                this.dataTypes.renderPreamble(!!this.options.workers),
            nativeFunctions: this.nativeDefinitions,
            staticNativeDeclarations: this.staticNativeDeclarations,
            ...(physicsDebugConstructionBody
                ? { physicsDebugConstructionBody }
                : {}),
            body: this.presentationHostCpp
                ? [
                      `        auto ${this.presentationHostCpp} = bbl::create_engine(bbl::EngineOptions{${this.cppString(this.options.title)}, ${this.options.width}, ${this.options.height}});`,
                      ...this.body,
                      `        bbl::start_engine(${this.presentationHostCpp});`,
                  ]
                : this.body,
        });
    }

    public fail(
        node: ts.Node,
        message: string,
        reason: CompileError["reason"] = "unsupported",
    ): never {
        const { file, line, character } = sourceLocation(node);
        throw new CompileError(
            file === this.sourceFile ? this.options.fileName : file.fileName,
            line,
            character,
            message,
            reason,
            node,
        );
    }

    public failAtFile(message: string): never {
        throw new CompileError(this.options.fileName, 1, 1, message);
    }
}
