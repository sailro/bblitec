import { assetRootMutationStates, nativeDataMetadata, valueForKind } from "./compiler/types.js";
import { forEachAnalysisNode, findAnalysisNodeWithState, someAnalysisNode } from "./compiler/analysis-walk.js";
import { emissionArray, EmissionMap, EmissionSet, EmissionTransaction, EmissionWeakMap, EmissionWeakSet } from "./compiler/emission-transaction.js";
import type { LoweringServices, NativeFunctionBodyOptions } from "./compiler/lowering-services.js";
import { SharedNativeFunctions } from "./compiler/shared-native-functions.js";
import { renderNativeDeclaration, type NativeDeclaration } from "./compiler/native-declarations.js";
import { persistContinuationLocals } from "./compiler/continuation-storage.js";
import ts from "typescript";
import { resolve } from "node:path";
import { inferUninitializedHandle } from "./compiler/uninitialized-handle.js";
import { framePollExecutor } from "./compiler/frame-poll.js";
import { reachPhysicsViewerMaterialProgram } from "./compiler/physics-viewer-material.js";
import { compileTextModuleValue, compileTextMutation, readTextProperty, retainTextValue } from "./compiler/text-surface.js";
import { promoteLiveTextData } from "./compiler/intrinsics/text.js";
import { compileNodeInputMutation, readNodeInputProperty } from "./compiler/node-input-surface.js";
import { checkNodeGeometryMutation } from "./compiler/node-geometry-admission.js";
import type { CompiledMeshWalk } from "./gltf-mesh-walks.js";
import { compileWorkerApplication, usesWorkers } from "./compiler/worker-modules.js";
import { compileWorkerValue, isNativeWorkerExpression } from "./compiler/workers.js";
import { compileCanvasValue, emitCanvasAssignment } from "./compiler/canvas.js";
import { compileWindowIdentity } from "./compiler/window-events.js";
import { writesUnobservedCanvasMetadata } from "./compiler/canvas-instrumentation.js";
import { AsyncLowerer } from "./compiler/async.js";
import { sourceLocation } from "./source-location.js";
import { cppIdentifierPattern, doubleLiteral, sanitizeCppIdentifier, stringLiteral } from "./cpp-literals.js";
import { CPP_SCALAR } from "./lowering/cpp-types.js";
import { compileAdaptations } from "./compiler/adaptations.js";
import { emitPropertyAssignment, emitStructuralPropertyAssignment } from "./compiler/assignments.js";
import { sceneNodeTransformDescriptor, type SceneNodeTransformDescriptor } from "./scene-node-transform-descriptor.js";
import { probePixelsAsset, registerAsset, registerSpriteAtlasAsset, resolveBundledAsset } from "./compiler/assets.js";
import { compileStaticFetch, compileStaticFetchMethod, staticFetchProperty } from "./compiler/static-fetch.js";
import { BrowserErasure, browserGlobalNamed, browserDeploymentValue, browserEnvironmentPropertyValue, browserEnvironmentValue } from "./compiler/browser-erasure.js";
import { deploymentUrl, deploymentEnvironment } from "./compiler/deployment.js";
import { httpResponseProperty } from "./compiler/http.js";
import { numberConstantValue } from "./compiler/number-intrinsics.js";
import { compileBrowserFileProperty, isNativeBrowserFileExpression } from "./compiler/browser-file.js";
import { browserGeneratedString } from "./compiler/browser-generated-string.js";
import { compileBrowserTextureFunctionCall } from "./compiler/browser-texture-function.js";
import { compileExecutedUrlFunctionCall } from "./compiler/executed-url-function.js";
import {
    compileDdsEnvironmentBackgroundOptions,
    compileDdsEnvironmentOptions,
    compileEnvironmentOptions,
    compileHdrEnvironmentOptions,
} from "./compiler/intrinsics/asset-options.js";
import { screenSpaceFacts } from "./pinned-screen-space.js";
import {
    compileCopyTaskOptions,
    compileEnginePixelRatioCap,
    compileEnginePrecisionPolicy,
    compileGeometryTaskOptions,
    compileRenderTargetOptions,
    compileRenderTaskOptions,
    compileSceneDefaultRenderTask,
    geometryEnumMember,
    type CompiledRenderTargetOptions,
} from "./compiler/intrinsics/engine-options.js";
import {
    compileAnisotropyOptions,
    compileClearCoatOptions,
    compileGridMaterialOptions,
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
import { compileRegisteredConstant, compileRegisteredIntrinsic } from "./compiler/intrinsics/registry.js";
import { selectedStaticExpression, selectedStaticNumberValue, staticNumberValue, validateObjectProperties } from "./compiler/option-helpers.js";
import { PropertyAnimationTargetLowerer, compilePropertyAnimationClip, compilePropertyAnimationGroupOptions } from "./compiler/property-animation.js";
import { compileNodeMaterialOptions, type CompiledNodeMaterialCall } from "./compiler/node-material.js";
import {
    lineMaterialPermutation,
    reachLineMaterialProgram,
    type LineMaterialPermutation,
    type ReachedLineMaterial,
} from "./compiler/line-material.js";
import { reachLinearDepthMaterialProgram } from "./compiler/linear-depth-material.js";
import type { LinearDepthMaterialOptions } from "./lowering/linear-depth-lowerer.js";
import { PinnedShaderText, type ShaderTextBinding, type ShaderTextContext } from "./lowering/pinned-shader-text.js";
import {
    compileShaderMaterialOptions,
    compileShaderUniformComponents,
    reachedShaderProgram,
    resolveShaderStorageBufferSlot,
    resolveShaderTextureSlot,
    resolveShaderUniform,
    shaderThinInstanceLanes,
} from "./compiler/shader-material.js";
import { DataLowerer, isNeverResized } from "./compiler/data-lowering.js";
import { cameraNumberWrite, isCameraExpression } from "./compiler/camera-writes.js";
import { noteCameraRecordWrite } from "./compiler/intrinsics/camera.js";
import {
    BUFFER_VIEW_KINDS,
    DataTypeRegistry,
    TYPED_ARRAY_KINDS,
    doubleLiteral as dataDoubleLiteral,
    declaredInDomLibrary,
    handleCppType,
    isHandleKind,
    isOpaqueReference,
    isPinnedType,
    isTypedArrayType,
    opaqueEngineValue,
    passesByReference,
    passesByReferenceKind,
    type DataIterationElement,
    type DataType,
    type TypedArrayKind,
} from "./compiler/data-types.js";
import { ExpressionLowerer, PURE_NUMBER_FORMATTERS } from "./compiler/expressions.js";
import { NativeFunctionLowerer, captureDataFunctionBody } from "./compiler/native-functions.js";
import { emitReachableStatements } from "./compiler/loop-control.js";
import {
    collectReboundSymbols,
    isModuleInitializerStatement,
    planEntryModuleState,
    planImportedModuleInitializers,
} from "./compiler/module-initializers.js";
import { compileSpriteAtlasRecord } from "./compiler/sprite-atlas-record.js";
import { readPngDimensionsSync } from "./compiler/asset-bytes-sync.js";
import { createCompilerProgram } from "./compiler/program.js";
import { nativeReturnTsType } from "./compiler/native-return-type.js";
import { readProperty } from "./compiler/properties.js";
import { CompilerSymbols } from "./compiler/symbols.js";
import { StaticEvaluator } from "./compiler/static-evaluator.js";
import { StatementLowerer } from "./compiler/statements.js";
import { HandleCollections, type HandleCollectionTarget } from "./compiler/handle-collections.js";
import {
    UserFunctionLowerer,
    aliasedMutationScan,
    callArgumentIsReadOnly,
    isSupportedFunction,
    parameterIsMutated,
    parameterIsReadOnly,
    recursiveStorageEscapes,
    resolveFunctionDeclaration,
    retainedNativeMutationTarget,
    tryResolveFunctionDeclaration,
    writesThroughTrackedRoot,
    type AliasedMutationScan,
    type SupportedFunction,
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
import { isStoringDataCall, mutatingArrayMethods } from "./compiler/data-methods.js";
import type { MaterialPluginManifest } from "./pinned-material-plugins.js";
import {
    ClosureCaptures,
    nativeCompanionKeys,
    renderClosure,
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
    walkReachedLoopNodes,
    type ParameterizedResourceLoop,
    type ResourceLoop,
} from "./compiler/resource-loops.js";
import { StaticExpansionBudget } from "./compiler/static-expansion.js";
import type {
    ClusteredContainerState,
    CollectionCardinality,
    CompileAsset,
    CompileOptions,
    CompileResult,
    CompiledNodeMaterial,
    CompiledNodeParticles,
    CompiledShaderProgram,
    DefaultRenderTaskEmission,
    EffectManifest,
    Feature,
    FrameCallbackSignature,
    GeometryOutputTaskManifest,
    GeometryTextureTypeName,
    LightKind,
    PostProcessCompositeManifest,
    PostProcessTaskManifest,
    ResolvedCompileOptions,
    SceneMeshManifest,
    SceneMeshNamePredicate,
    ScenePbrAnisotropyManifest,
    ScenePbrClearCoatManifest,
    ScenePbrIridescenceManifest,
    ScenePbrLightmapManifest,
    ScenePbrMaterialManifest,
    ScenePbrMetallicReflectanceManifest,
    ScenePbrSheenManifest,
    ScenePbrSubsurfaceManifest,
    ScreenSpaceTaskManifest,
    ShadowCasterMeshManifest,
    ShadowGeneratorManifest,
    SplatFragmentManifest,
    SpriteCustomShaderManifest,
    Value,
    ValueKind,
    VariableBinding,
} from "./compiler/types.js";
import { isCompileTimeOnlyValue, sameCompiledValue } from "./compiler/types.js";
import { ClassLowerer } from "./compiler/classes.js";
import { shaderMaterialPrograms } from "./shader-material-programs.js";
import { assertDeterministicRandomUnreached, isDeterministicRandomRead } from "./compiler/deterministic-random.js";
import { nodeParticleManifest } from "./compiler/intrinsics/particle.js";
import type { CompiledTextData } from "./pinned-text-data.js";
import { readFrozenParticleProperty } from "./compiler/particle-buffer.js";
import { readCharacterProperty } from "./compiler/intrinsics/character-controller.js";
import { physicsEventInfoType, physicsEventInfoValue } from "./compiler/intrinsics/physics.js";
import { reachedGeneratedSources } from "./generated-sources.js";
import { featureOrder, featureSources, renderFeaturesCmake, renderMainCpp } from "./compiler/output-projection.js";
import { SceneMaterialRecorder } from "./compiler/scene-materials.js";
import { PlatformCalls } from "./compiler/platform-calls.js";
import { UiProjection } from "./compiler/ui-projection.js";

export type {
CompileAsset,
CompileOptions,
CompileResult,
CompiledShaderProgram,
GeometryOutputTaskManifest,
GeometryTextureTypeName,
PostProcessCompositeManifest,
PostProcessTaskManifest,
ShaderMaterialVariantName
} from "./compiler/types.js";
export { renderFeaturesCmake };

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
interface ResourceConstructionState {
    counters: number[];
    lightIdentities: NonNullable<Value["lightIdentity"]>[];
}
interface ResourceConstructionCheckpoint {
    state: ResourceConstructionState;
    callbackDepth: number;
}
function resourceConstructionStatesEqual(left: ResourceConstructionState, right: ResourceConstructionState): boolean {
    return left.counters.length === right.counters.length &&
        left.counters.every((value, index) => value === right.counters[index]) &&
        left.lightIdentities.length === right.lightIdentities.length &&
        left.lightIdentities.every((value, index) => value === right.lightIdentities[index]);
}

const CANVAS_SIZE_AXES = new EmissionMap<string, CanvasSizeProperty>([
    ["width", { axis: "width", client: false }],
    ["height", { axis: "height", client: false }],
    ["clientWidth", { axis: "width", client: true }],
    ["clientHeight", { axis: "height", client: true }],
]);

const KEY_EVENT_FIELDS = new EmissionMap<string, string>([
    ["repeat", "repeat"],
    ["shiftKey", "shift_key"],
    ["ctrlKey", "ctrl_key"],
    ["altKey", "alt_key"],
    ["metaKey", "meta_key"],
]);

/**
 * A nullable name's resource kind, keyed by the type's name alone.
 *
 * These rows are deliberately ungated, unlike `opaqueEngineValue`'s table:
 * half of them are DOM types (`AudioContext`, `Element` and the three
 * HTML element interfaces) that the pinned package does not declare, so
 * `declaredInBabylonLite` would drop them. `nullableResourceKind` consults
 * this where its name chain used to start -- after the workers-only
 * `EngineContext` row and before the `createRenderTexture2D`-guarded
 * `Texture2D` one, which no name here collides with.
 *
 * A Map, like the two tables above: the key is a type's symbol name, and an
 * object literal would answer `Object.prototype` for one spelled `toString`.
 */
const NULLABLE_RESOURCE_TYPES = new EmissionMap<
    string,
    { kind: ValueKind; cppType: string }
>([
    [
        "AudioEngine",
        { kind: "audio-engine", cppType: "bbl::pal::AudioContextHandle" },
    ],
    [
        "AudioContext",
        { kind: "audio-context", cppType: "bbl::pal::AudioContextHandle" },
    ],
    [
        "BaseAudioContext",
        { kind: "audio-context", cppType: "bbl::pal::AudioContextHandle" },
    ],
    [
        "OfflineAudioContext",
        { kind: "audio-context", cppType: "bbl::pal::AudioContextHandle" },
    ],
    [
        "AudioParam",
        { kind: "audio-param", cppType: "bbl::pal::AudioParamHandle" },
    ],
    [
        "AudioBuffer",
        { kind: "audio-buffer", cppType: handleCppType("audio-buffer") },
    ],
    [
        "SpriteRenderer",
        { kind: "sprite-renderer", cppType: "bbl::SpriteRendererHandle" },
    ],
    [
        "Sprite2DLayer",
        { kind: "sprite-layer", cppType: handleCppType("sprite-layer") },
    ],
    ["Element", { kind: "ui-element", cppType: handleCppType("ui-element") }],
    ["HTMLElement", { kind: "ui-element", cppType: handleCppType("ui-element") }],
    [
        "HTMLDivElement",
        { kind: "ui-element", cppType: handleCppType("ui-element") },
    ],
    [
        "HTMLCanvasElement",
        { kind: "ui-element", cppType: handleCppType("ui-element") },
    ],
    [
        "ObstacleHandle",
        {
            kind: "navigation-obstacle",
            cppType: handleCppType("navigation-obstacle"),
        },
    ],
    ["Mesh", { kind: "mesh", cppType: handleCppType("mesh") }],
    ["AssetContainer", { kind: "asset", cppType: "bbl::AssetHandle" }],
    [
        "StorageBuffer",
        { kind: "storage-buffer", cppType: handleCppType("storage-buffer") },
    ],
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
 * holding one clip's row block.
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
    [ts.SyntaxKind.EqualsToken, "="], [ts.SyntaxKind.PlusEqualsToken, "+"],
    [ts.SyntaxKind.MinusEqualsToken, "-"], [ts.SyntaxKind.AsteriskEqualsToken, "*"],
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

export function compileSource(
    source: string,
    options: CompileOptions = {},
): CompileResult {
    const fileName = options.fileName ?? "input.ts";
    const environment = deploymentEnvironment(options);
    const frontend = createCompilerProgram(source, fileName);
    const compile = (input: typeof frontend, workers?: ResolvedCompileOptions["workers"]): CompileResult => {
    const compiler = new Compiler(
        input.program,
        input.sourceFile,
        input.checker,
        {
            fileName: workers?.namespace ? input.sourceFile.fileName : fileName,
            title: options.title ?? "Babylon Lite Native",
            width: options.width ?? 1280,
            height: options.height ?? 720,
            search: options.search ?? "",
            siteUrl: deploymentUrl(options).href,
            environment,
            ...(options.publicDir ? { publicDir: resolve(options.publicDir) } : {}),
            ...(workers ? { workers } : {}),
            ...(options.nativeHostUi && !workers?.namespace
                ? { nativeHostUi: options.nativeHostUi }
                : {}),
        },
    );
    const result = compiler.compile();
    result.manifest.inputs = input.localFiles;
    return result;
    };
    return usesWorkers(frontend)
        ? compileWorkerApplication(frontend, compile, (node, message) => {
            const { file, line, character } = sourceLocation(node);
            throw new CompileError(file.fileName, line, character, message);
        })
        : compile(frontend);
}

class Compiler
    implements LoweringServices
{
    public readonly symbols: CompilerSymbols;
    public readonly evaluator: StaticEvaluator;
    /** The handle-collection concept: every collection operation. */
    public readonly handleCollections: HandleCollections =
        new HandleCollections(this);
    private readonly statements = new StatementLowerer();
    public readonly userFunctions: UserFunctionLowerer;
    private readonly ui = new UiProjection(this);
    private readonly platform = new PlatformCalls(this, this.ui);
    public get uiDegradedStyleProperties(): Set<string> { return this.ui.uiDegradedStyleProperties; }
    public get uiScopedSheetSelectors(): Set<string> { return this.ui.uiScopedSheetSelectors; }
    public get uiGridSubstitutions(): Set<string> { return this.ui.uiGridSubstitutions; }
    private readonly asyncLowerer = new AsyncLowerer(this);
    public readonly dataTypes: DataTypeRegistry;
    public readonly dataLowerer: DataLowerer;
    public readonly classLowerer: ClassLowerer;
    public readonly nativeFunctions: NativeFunctionLowerer;
    private readonly browserErasure: BrowserErasure;
    private readonly browserUtilitySources = new EmissionMap<ts.SourceFile, boolean>();
    /** One rebound-name walk per file, shared by every `identifierIsRebound`. */
    private readonly reboundSymbolsByFile = new EmissionMap<
        ts.SourceFile,
        ReadonlySet<ts.Symbol>
    >();
    private readonly sharedClosureSymbols = new EmissionWeakMap<
        ts.Node,
        ReadonlySet<ts.Symbol>
    >();
    private staticAssetUrlCandidateCache: readonly string[] | undefined;
    private readonly expressions: ExpressionLowerer;
    private readonly nativeFunctionPrototypes: string[] = emissionArray([]);
    private readonly nativeFunctionDefinitions: string[] = emissionArray([]);
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
    private readonly resourceLoopReturns = new EmissionWeakMap<object, {
        condition: ts.Expression;
        checkpoint: ResourceConstructionCheckpoint;
    }>();
    private readonly resourceConstructionCheckpoints = new EmissionSet<ResourceConstructionCheckpoint>();
    private readonly deferredResourceCaptureDepths = new EmissionSet<number>();
    private readonly collectionCardinalities = new EmissionSet<CollectionCardinality>();
    public jsDataReached = false;
    /** Whether the entry body itself decodes an image (drawn-atlas records). */
    public imageDecodeReached = false;
    public jsRandomReached = false;
    private audioSessionReached = false;
    public voxelFileStorageReached = false;
    /**
     * The bounded canvas-owning functions this compilation executed at
     * generation, by name. It is the fidelity adaptation's reach test: the
     * assets they produce are ordinary data-URL payloads by the time they
     * reach the manifest, so nothing downstream can tell them apart.
     */
    public readonly browserTextureFunctions = new EmissionSet<string>();
    public readonly canvasReadbackFunctions = new EmissionSet<string>();
    /** Whether a scene threw one of its own preconditions. */
    public throwReached = false;
    private readonly staticConstants = new EmissionMap<ts.Symbol, ts.Expression>();
    private readonly sourceCppNames = new EmissionSet<string>();
    private readonly transparentRebindingScopes = new EmissionWeakSet<Map<ts.Symbol, VariableBinding>>();
    public readonly variableScopes: Array<Map<ts.Symbol, VariableBinding>> = emissionArray([
        new EmissionMap(),
    ]);
    private readonly cppNamePrefixes: string[] = emissionArray([""]);
    private readonly features = new EmissionSet<Feature>(["core"]);
    /** The clustered container this scene added, if it added one. */
    private clusteredContainer: ClusteredContainerState | undefined;
    private readonly featureSites = new EmissionMap<Feature, string>();
    public readonly assets = new EmissionMap<string, CompileAsset>();
    public readonly assetPayloads = new EmissionMap<string, string>();
    public readonly reachedTextData: CompiledTextData[] = emissionArray([]);
    /** The source-keyed record for the most recent `loadGltf` call. */
    private lastGltfContainerAsset: CompileAsset | undefined;
    public readonly reachedShaderPrograms: CompiledShaderProgram[] = emissionArray([]);
    public readonly reachedNodeMaterials: CompiledNodeMaterial[] = emissionArray([]);
    public readonly meshWalks: CompiledMeshWalk[] = emissionArray([]);
    public readonly reachedNodeParticles: CompiledNodeParticles = {
        sets: [],
        steps: [],
        billboards: [],
        registrations: [],
        textures: [],
        sprite2d: [],
        buffers: [],
    };
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
    /** The pinned tone-mapping export the scene selected, if any. */
    private selectedToneMapping: string | undefined;
    private readonly reachedEffects_: EffectManifest[] = emissionArray([]);
    private thisInstance: Value | undefined;
    private readonly classInstances = new EmissionMap<Value, ts.ClassDeclaration>();
    /**
     * JavaScript identities minted for materialized callbacks, per
     * declaration and per owning object.
     */
    private readonly callbackIdentities = new EmissionMap<
        ts.Node,
        Map<object, number>
    >();
    private nextCallbackIdentity = 0;
    private nextNativeBindingSequence = 0;
    private readonly nativeBindings = new EmissionMap<string, NativeCaptureBinding>();
    private readonly nativeStoredValues = new EmissionWeakSet<Value>();
    private readonly nativeDependencyStack: Set<NativeCaptureBinding>[] = emissionArray([]);
    private readonly realmEngineCaptures = new EmissionMap<string, readonly NativeCaptureBinding[]>();
    private readonly managedCaptures: ClosureCaptures[] = emissionArray([]);
    private readonly body: string[] = emissionArray([]);
    private readonly nativeDeclarations = new EmissionMap<string, NativeDeclaration>();
    private readonly statementDependencies: Set<NativeCaptureBinding>[] = emissionArray([]);
    private readonly continuationUses = new EmissionMap<string, Set<number>>();
    private readonly continuationLocals = new EmissionMap<string, number>();
    private continuationSequence = 0;
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
    public readonly geometryOutputTasks: GeometryOutputTaskManifest[] = emissionArray([]);
    public readonly postProcessTasks: PostProcessTaskManifest[] = emissionArray([]);
    public readonly postProcessComposites: PostProcessCompositeManifest[] = emissionArray([]);
    private readonly untrackedTaaCameraWrites: Array<{ node: ts.Node; reason: string }> = emissionArray([]);
    private readonly deferredAdmissionFailures: Array<{ capability: "taa" | "text" | "node-input" | "node-geometry" | "material-colors" | "baseColorFactor" | "diffuseColor"; node: ts.Node; message: string }> = emissionArray([]);
    private readonly materialColorReads: Array<"baseColorFactor" | "diffuseColor"> = emissionArray([]);
    private temporalSceneRegistration: ts.Node | undefined;
    private readonly temporalRegisteredScenes: Array<Value["sceneTopologyState"]> = emissionArray([]);
    private temporalControlAttachment: ts.Node | undefined;
    public readonly screenSpaceTasks: ScreenSpaceTaskManifest[] = emissionArray([]);
    private readonly sceneMaterials = new SceneMaterialRecorder();
    public readonly localCubemapState: {maxCandidates?: number} = {};
    private readonly sceneMaterialGltfAssetsBefore: number[] = emissionArray([]);
    private readonly sceneMeshes: SceneMeshManifest[] = emissionArray([]);
    private readonly shadowGenerators: Array<
        Omit<ShadowGeneratorManifest, "casters"> & {
            casters: ShadowCasterMeshManifest[];
            lightIdentity?: NonNullable<Value["lightIdentity"]>;
        }
    > = emissionArray([]);
    private readonly shadowReceiverMeshes = new EmissionSet<number>();
    private dynamicShadowReceivers = false;
    /**
     * `mesh.id`, by the handle spelling the write named, and the meshes each
     * id names.
     *
     * `Mesh.id` is not `SceneNode.name`: the pin declares it separately as
     * the unique id a source file carries, and `src/render/lights-ubo.ts`
     * `affectsMesh` is its only reader. So the string is a join key rather
     * than record state, and the join folds here exactly as the `.babylon`
     * loader folds its own `mesh_records_by_id` — an id names a LIST,
     * because nothing upstream enforces uniqueness.
     */
    private readonly sceneMeshesById = new EmissionMap<string, string[]>();
    /** The id each mesh handle currently carries, so a rewrite is visible. */
    private readonly sceneMeshIdByHandle = new EmissionMap<string, string>();
    /** Every id an emitted light include set has already resolved against. */
    private readonly resolvedLightMeshIds = new EmissionSet<string>();
    /** `constArrayIsWritten` answers, by binding: the scan walks a file. */
    private readonly writtenConstArrays = new EmissionMap<ts.Symbol, boolean>();
    /** The active lights and kinds, kept in one receiver-binding order. */
    private readonly sceneLights: Array<{
        identity: NonNullable<Value["lightIdentity"]>;
        kind: LightKind;
    }> = emissionArray([]);
    /** Scene topology survives value reconstruction through record fields. */
    private readonly sceneTopologyStates = new EmissionMap<
        string,
        NonNullable<Value["sceneTopologyState"]>
    >();
    private dynamicSceneLights = false;
    private mutableToneMappingEnabled = false;
    private readonly sceneSpriteCustomShaders: SpriteCustomShaderManifest[] =
        emissionArray([]);
    /**
     * The splat shader plugins one `loadSplat` call passed, in its order.
     * Undefined until a call records one, so an empty list stays
     * distinguishable from no list at all.
     */
    private sceneSplatFragments: SplatFragmentManifest[] | undefined;
    /**
     * Which material each scene-code mesh ended up carrying.
     *
     * A caster's material is a LAZY task input upstream --
     * `setShadowTaskCasterMeshes` stores the mesh list and
     * `getEsmShadowView(mesh.material, ...)` reads the material when the
     * pass builds -- so a scene may name its casters before assigning
     * their materials, and scene 65 does exactly that. Recorded per mesh
     * here and joined to the casters when the manifest is built.
     */
    private readonly sceneMeshMaterials = new EmissionMap<
        number,
        { pbrMaterial: number | null; nodeMaterial: number | null }
    >();
    /** Every reachable assignment, rather than only the final assignment the
     *  lazy shadow view needs. This closes each PBR material over the meshes
     *  it can actually draw on. */
    private readonly scenePbrMaterialMeshes = new EmissionMap<number, Set<number>>();
    private readonly scenePbrMaterialsWithUnknownMesh = new EmissionSet<number>();
    private unknownSceneMaterialAssignment = false;
    private standardMaterialUnknownMesh = false;
    private readonly runtimeMaterialProfiles = new EmissionSet<number>();
    private runtimeMeshProfileCount = 0;
    private readonly runtimeShaderProfiles = new EmissionSet<number>();
    private readonly runtimeNodeProfiles = new EmissionSet<number>();
    private reachedPlainSpriteLayer = false;
    /** A standalone SpriteRenderer needs the pure-2D vertex permutation. */
    private reachedPureSpriteVertex = false;
    private reachedPlainBillboardSystem = false;
    public hasMainEntry = false;
    private defaultEngineCpp: string | undefined;
    /** Platform owner for an entry that has no source-created Babylon engine. */
    private presentationHostCpp: string | undefined;
    /** First statement after the one engine is created. */
    private engineCreationInsertion: number | undefined;
    /** Explicit static surface sample count; absence means the pinned default. */
    private engineMsaaSamples: 1 | 4 | undefined;
    /** Bound only while lowering a platform visibility callback body. */
    private platformDocumentHiddenCpp: string | undefined;
    private indentLevel = 2;
    private readonly emissionBlocks = emissionArray([0]);
    private nextEmissionBlock = 1;
    private temporaryIndex = 0;
    public defaultRenderTaskAdapted = false;

    public constructor(
        private readonly program: ts.Program,
        public readonly sourceFile: ts.SourceFile,
        public readonly checker: ts.TypeChecker,
        public readonly options: ResolvedCompileOptions,
    ) {
        this.symbols = new CompilerSymbols(checker);
        this.userFunctions = new UserFunctionLowerer(checker);
        this.dataTypes = new DataTypeRegistry(
            checker,
            (node, message) => this.fail(node, message),
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
                this.lookupRecordProperty(expression) ??
                this.compilePropertyAccess(expression),
            (expression) => this.compileValue(expression),
            (expression) => this.compileValue(expression),
            (expression) => this.compileValue(expression),
            (expression) => this.compileCondition(expression),
            (expression) => this.evaluateBrowserValue(expression),
            (expression) => this.isBrowserOnlyExpression(expression),
            (identifier) => this.isDefaultLibraryIdentifier(identifier),
            (value, expression, assertedNonNull) =>
                this.dataLowerer.narrowOptional(value, expression, assertedNonNull),
            (identifier) => this.lookup(identifier),
            (identifier) => this.lookupOptional(identifier),
            (node, message, reason) => this.fail(node, message, reason),
            (expression) => this.unwrappedAwaitExpressions.add(expression.pos),
            () => this.reachJsData(),
            (value, arity) => this.bindDataTuple(value, arity),
            (expression) => this.symbols.pinnedWgslTemplate(expression),
        );
    }

    public compile(): CompileResult {
        if (this.options.workers) this.reachFeature("platform:workers", this.sourceFile);
        this.dataTypes.registerPartialRecords(this.program.getSourceFiles());
        this.collectSourceCppNames();
        this.collectStaticConstants();
        this.predeclareStoredObjectReferences();
        this.emitImportedModuleInitializers();
        const entry = this.entryStatements();
        this.emitEntryModuleState(entry);
        emitReachableStatements(this, entry);
        this.emitDeferredPhysicsCallbacks();
        this.emitNativeHostUi();
        if (this.features.has("engine:device-recovery")) {
            if (this.features.has("platform:workers") || this.features.has("platform:window")) this.fail(this.sourceFile,
                "Device recovery does not represent shared worker/offscreen device ownership.");
            if (this.temporalRegisteredScenes.length > 1) this.fail(this.sourceFile,
                "Device recovery resource observations currently require one registered scene.");
        }
        if (this.reachedNodeMaterials.length > 0 && this.geometryOutputTasks.length > 0 && this.features.has("loader:gltf")) {
            const boundary = this.deferredAdmissionFailures.find(failure => failure.capability === "node-geometry");
            if (boundary) this.fail(boundary.node, boundary.message);
            if (this.features.has("animation:property")) this.fail(this.sourceFile,
                "Node geometry views with glTF do not represent property-animation transform producers.");
        }
        if (this.features.has("material:node")) {
            const admission = this.deferredAdmissionFailures.find((failure) => failure.capability === "node-input");
            if (admission) this.fail(admission.node, admission.message);
            if (this.features.has("material:node-inputs") && this.temporalRegisteredScenes.length > 1) this.fail(this.sourceFile,
                "Node input bindings support one registered scene until per-scene binding snapshots are represented.");
        }
        const colorAdmission = this.deferredAdmissionFailures.find(failure =>
            (failure.capability === "baseColorFactor" || failure.capability === "diffuseColor") &&
            this.materialColorReads.includes(failure.capability));
        if (colorAdmission) this.fail(colorAdmission.node, colorAdmission.message);
        if (this.materialColorReads.length) {
            const boundary = this.deferredAdmissionFailures.find(failure => failure.capability === "material-colors");
            if (boundary) this.fail(boundary.node, boundary.message);
            if (this.temporalRegisteredScenes.length > 1) this.fail(this.sourceFile,
                "Numeric material-color reads currently support one registered scene; independent material-group UBO snapshots are not represented.");
        }
        if (this.features.has("text:renderable")) {
            const camera = this.textCameraMutation ?? this.untrackedTaaCameraWrites[0]?.node;
            if (camera) this.fail(camera, "Text currently requires a static camera; live camera writers and controls are not represented.");
            if (this.temporalRegisteredScenes.length > 1) this.fail(this.sourceFile,
                "Text currently supports one registered scene; layered text update/draw ordering is not represented.");
            const admission = this.deferredAdmissionFailures.find((failure) => failure.capability === "text");
            if (admission) this.fail(admission.node, admission.message);
        }
        if (this.postProcessComposites.some((composite) => composite.intrinsic === "createTaaPostProcessTask")) {
            const unsupported = this.untrackedTaaCameraWrites[0];
            if (unsupported) this.fail(unsupported.node, `TAA requires tracked camera mutations: ${unsupported.reason}.`);
            const admission = this.deferredAdmissionFailures.find((failure) => failure.capability === "taa");
            if (admission) this.fail(admission.node, admission.message);
        }
        if (this.reachedNodeParticles.nativeProvider &&
            !this.reachedNodeParticles.sets.some((set) => set.native)) {
            this.fail(this.sourceFile, "A reached native emitter provider must feed a built particle set; standalone provider options are not lowered.");
        }
        assertDeterministicRandomUnreached(
            this,
            this.jsRandomReached,
            this.sourceFile,
        );
        if (this.unknownSceneMaterialAssignment) {
            if (this.features.has("material:standard")) {
                for (const mesh of this.sceneMeshes) mesh.standardMaterial = true;
            }
            // A runtime material choice can make an otherwise-known caster
            // PBR. Its views must use the existing unknown-caster product.
            for (const generator of this.shadowGenerators) generator.dynamicCasters = true;
        }
        // After the whole entry, because the mesh a shader material ends up
        // on is what decides its instanced form and either may come first.
        this.settleShaderThinInstances();

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
        // Two features can name the same PAL translation unit (the sprite
        // and PBR renderers share one), and CMake must list it once.
        const runtimeSources = [
            ...new EmissionSet(features.flatMap((feature) => featureSources[feature])),
        ];
        // The manifest and CMake projection of the same table the upstream
        // lowerer emits from, so a feature's sources are declared once.
        const generatedSources = reachedGeneratedSources(features);
        const cpp = this.renderCpp(features);
        this.staticExpansionBudget.assertWithinBudget();
        return {
            cpp,
            cmake: this.renderCmake(features, runtimeSources, generatedSources),
            assetPayloads: this.assetPayloads,
            ...(this.reachedNodeParticles.sets.length > 0
                ? { nodeParticles: this.reachedNodeParticles }
                : {}),
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
                assets: [...this.assets.values()],
                shaderVariants: this.reachedShaderPrograms.map(
                    ({ name }) => name,
                ),
                customShaderPrograms: this.reachedShaderPrograms.filter(
                    ({ name }) =>
                        !shaderMaterialPrograms.some(
                            (predeclared) => predeclared.name === name,
                        ),
                ),
                nodeMaterials: this.reachedNodeMaterials,
                ...(this.meshWalks.length ? {meshWalks: this.meshWalks} : {}),
                ...(this.reachedTextData.length > 0 ? { textData: this.reachedTextData } : {}),
                ...(this.reachedNodeParticles.sets.length > 0
                    ? {
                          nodeParticles: nodeParticleManifest(
                              this.reachedNodeParticles,
                          ),
                      }
                    : {}),
                ...(this.selectedToneMapping
                    ? { toneMapping: this.selectedToneMapping }
                    : {}),
                geometryOutputTasks: this.geometryOutputTasks,
                postProcessTasks: this.postProcessTasks,
                postProcessComposites: this.postProcessComposites,
                screenSpaceTasks: this.screenSpaceTasks,
                adaptations: compileAdaptations(this, features),
                scenePbrMaterials: this.scenePbrMaterials.map(
                    (material, index) => ({
                        ...material,
                        sceneMeshIndices: [
                            ...(this.scenePbrMaterialMeshes.get(index) ?? []),
                        ].sort((left, right) => left - right),
                        ...(this.unknownSceneMaterialAssignment || this.scenePbrMaterialsWithUnknownMesh.has(index)
                            ? { unknownSceneMesh: true as const }
                            : {}),
                    }),
                ),
                standardMaterialPlugins:
                    this.sceneMaterials.standardMaterialPlugins,
                standardMaterialPluginInputs:
                    this.sceneMaterials.standardMaterialPluginInputs,
                ...(this.standardMaterialUnknownMesh ||
                    (this.unknownSceneMaterialAssignment && this.features.has("material:standard"))
                    ? { standardMaterialUnknownMesh: true as const }
                    : {}),
                sceneMaterialCount: this.sceneMaterials.count,
                sceneMaterialGltfAssetsBefore:
                    this.sceneMaterialGltfAssetsBefore,
                ...(this.runtimeMaterialProfiles.size > 0
                    ? { runtimeMaterialProfiles: [...this.runtimeMaterialProfiles] }
                    : {}),
                sceneMeshes: this.sceneMeshes,
                sceneLightKinds: this.sceneLights.map(({ kind }) => kind),
                dynamicSceneLights: this.dynamicSceneLights,
                mutableToneMappingEnabled: this.mutableToneMappingEnabled,
                ...(this.clusteredContainer
                    ? {
                          clusteredLights: {
                              hasSpots: this.clusteredContainer.hasSpots,
                          },
                      }
                    : {}),
                shadowGenerators: this.shadowGenerators.map(
                    (generator, index) => {
                        const lightIndex =
                            generator.lightIndex >= 0
                                ? generator.lightIndex
                                : this.dynamicShadowLightIndex(index);
                        if (lightIndex === undefined) {
                            throw new Error(
                                "A shadow generator's light was never added to the scene.",
                            );
                        }
                        const { lightIdentity, ...manifest } = generator;
                        void lightIdentity;
                        return {
                            ...manifest,
                            lightIndex,
                            // The caster's material as the mesh finally carried
                            // it, which is what the pin's lazy view lookup reads.
                            casters: generator.casters.map((caster) => ({
                                meshIndex: caster.meshIndex,
                                pbrMaterial: null,
                                nodeMaterial: null,
                                ...(this.sceneMeshMaterials.get(
                                    caster.meshIndex,
                                ) ?? {}),
                            })),
                        };
                    },
                ),
                shadowReceiverMeshes: [...this.shadowReceiverMeshes].sort(
                    (left, right) => left - right,
                ),
                dynamicShadowReceivers: this.dynamicShadowReceivers,
                splatFragments: this.sceneSplatFragments ?? [],
                spriteCustomShaders: this.sceneSpriteCustomShaders,
                effects: this.reachedEffects_,
                pureSpriteVertex: this.reachedPureSpriteVertex,
                plainSpriteLayer: this.reachedPlainSpriteLayer,
                plainBillboardSystem: this.reachedPlainBillboardSystem,
            },
        };
    }

    /**
     * Materialize an audited host-page companion into the same retained UI IR
     * as scene-created DOM. The registered scene supplies this data because
     * the immutable TypeScript module cannot observe elements owned by its
     * browser HTML host in a native process.
     */
    private readonly pendingHostUiLookups: Value[] = emissionArray([]);

    private emitNativeHostUi(): void {
        const emitted = this.ui.compileHostUi();
        const insertion = this.options.workers ? 0 : this.engineCreationInsertion ?? this.body.length;
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
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                // The file adapter stores both its input and result as object
                // references. Fix that representation before earlier literals.
                const file = this.voxelFileContract(node, node.expression);
                if (file?.dataType) this.dataTypes.markStoredObjectReferences(file.dataType);
            }
            const target = retainedNativeMutationTarget(this.symbols, node);
            if (target) {
                const targetType = this.checker.getTypeAtLocation(target);
                // Existing accessor records keep their getter/setter lowering.
                // Plain targets are retained by the group's generated writer.
                const hasAccessors = targetType.getProperties().some((property) =>
                    property.declarations?.some((declaration) =>
                        ts.isAccessor(declaration) || ts.isMethodDeclaration(declaration)));
                if (!hasAccessors) {
                    const dataType = this.dataTypes.fromTsType(targetType, target);
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
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
            if (
                (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
                ts.isIdentifier(node.name)
            ) {
                this.sourceCppNames.add(this.cppIdentifier(node.name.text));
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
            this.pushScope(`module${index}_`);
            const moduleScope = this.variableScopes.at(-1)!;
            try {
                for (const statement of file.statements) {
                    if (isModuleInitializerStatement(statement)) {
                        this.emitStatement(statement);
                    }
                }
            } finally {
                // Module bindings remain visible to imported functions after
                // initialization, but their source names live under a module
                // prefix so two files may both export (say) `values`.
                const root = this.variableScopes[0]!;
                for (const [symbol, binding] of moduleScope) {
                    root.set(symbol, binding);
                }
                this.popScope();
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

    private entryStatements(): readonly ts.Statement[] {
        if (this.options.workers?.namespace) {
            return this.sourceFile.statements.filter(statement => !ts.isImportDeclaration(statement) &&
                !ts.isFunctionDeclaration(statement) && !ts.isExportDeclaration(statement));
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
    /**
     * Whether a callback only reports: its body observes or mutates browser
     * state and nothing else.
     *
     * The entry reporter and `setTimeout`'s browser-only arm ask this of the
     * same shapes, so it is one question with one answer.
     *
     * NOT `statementIsBrowserOnly`, which looks deeper but answers a
     * different question: it is what decides whether a statement inside a
     * RETAINED function may be erased, and it deliberately excludes console
     * and document so an unresolved guard stays a refusal rather than
     * swallowing a nested call. Reporting is exactly what those globals do.
     */
    /**
     * `<boolean> === <boolean>` where both sides settle at generation.
     *
     * Returns the answer as `"true"`/`"false"`, or nothing where either side
     * is a run-time value -- in which case the comparison arms below emit
     * one, exactly as they did before.
     */
    private foldBooleanComparison(
        expression: ts.BinaryExpression,
    ): string | undefined {
        const equals =
            expression.operatorToken.kind ===
            ts.SyntaxKind.EqualsEqualsEqualsToken;
        if (
            !equals &&
            expression.operatorToken.kind !==
                ts.SyntaxKind.ExclamationEqualsEqualsToken
        ) {
            return undefined;
        }
        const booleanLike = (side: ts.Expression): boolean =>
            (this.checker.getNonNullableType(this.checker.getTypeAtLocation(side)).flags & ts.TypeFlags.BooleanLike) !== 0;
        if (!booleanLike(expression.left) || !booleanLike(expression.right)) return undefined;
        const settled = (side: ts.Expression): string | undefined => {
            const resolved = this.evaluator.resolveStaticExpression(side);
            if (resolved.kind === ts.SyntaxKind.TrueKeyword) return "true";
            if (resolved.kind === ts.SyntaxKind.FalseKeyword) return "false";
            const value = ts.isIdentifier(resolved)
                ? this.lookupOptional(resolved)
                : ts.isPropertyAccessExpression(resolved)
                  ? this.compilePropertyAccess(resolved)
                  : undefined;
            if (value?.kind === "json-null") return "nullish";
            return value?.kind === "boolean" &&
                (value.cpp === "true" || value.cpp === "false")
                ? value.cpp
                : undefined;
        };
        return this.probeEmission(() => {
            const left = settled(expression.left);
            const right = settled(expression.right);
            if (left === undefined || right === undefined) return undefined;
            // Nullable booleans can still distinguish null from undefined;
            // only their inequality with a concrete boolean is established.
            if (left === "nullish" && right === "nullish") return undefined;
            return String((left === right) === equals);
        });
    }

    public isBrowserOnlyHandler(handler: ts.Expression): boolean {
        const body =
            ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)
                ? handler.body
                : undefined;
        if (body && ts.isBlock(body)) {
            return body.statements.every(
                (statement) =>
                    ts.isExpressionStatement(statement) &&
                    this.isBrowserOnlyExpression(statement.expression),
            );
        }
        // A concise body is the expression itself; anything that is not a
        // function literal is asked directly, which lets a bare
        // `console.error` pass and a named recovery routine not.
        return this.isBrowserOnlyExpression(body ?? handler);
    }

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
        if (!this.isBrowserOnlyHandler(handler)) {
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

    private nullableResourceKind(
        node: ts.Node,
        allowDirect = false,
    ): { kind: ValueKind; cppType: string } | undefined {
        const type = this.checker.getTypeAtLocation(node);
        const members =
            (type.flags & ts.TypeFlags.Union) !== 0
                ? (type as ts.UnionType).types.filter(
                      (member) =>
                          (member.flags &
                              (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) ===
                          0,
                  )
                : allowDirect
                  ? [type]
                  : [];
        if (members.length !== 1) return undefined;
        if (this.options.workers && isPinnedType(members[0]!, ["EngineContext"])) {
            return { kind: "engine", cppType: "std::shared_ptr<bbl::Engine>" };
        }
        const name = members[0]!.symbol?.name;
        const named = name ? NULLABLE_RESOURCE_TYPES.get(name) : undefined;
        if (named) return named;
        if (
            name === "Texture2D" &&
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
        const mappedHandle = this.dataTypes.fromTsType(members[0]!, node);
        if (
            mappedHandle?.kind === "handle" &&
            (mappedHandle.handle === "pointer-drag" ||
                (this.options.workers && mappedHandle.handle === "offscreen-canvas"))
        ) {
            return {
                kind: mappedHandle.handle,
                cppType: this.dataTypes.cppType(mappedHandle),
            };
        }
        if (this.typeIsOrExtendsNamed(members[0]!, "Material")) {
            return {
                kind: "material",
                cppType: handleCppType("material"),
            };
        }
        const vat = name ? NULLABLE_VAT_RESOURCE_TYPES.get(name) : undefined;
        if (vat) return vat;
        // Resolved through the DOM library's own `AudioNode`: a scene's
        // `SceneNode`, or the pin's `TransformNode`, is not a Web Audio node.
        if (
            this.typeIsOrExtendsNamed(
                members[0]!,
                "AudioNode",
                new EmissionSet(),
                declaredInDomLibrary,
            )
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
        const opaque = opaqueEngineValue(members[0]!);
        if (opaque) {
            return opaque;
        }
        return undefined;
    }

    /**
     * Whether a type is, or derives from, the class or interface named
     * `name`; `declaredBy` narrows which declaration of that name counts
     * (the DOM library's `AudioNode`, not a scene's own class of that name).
     */
    private typeIsOrExtendsNamed(
        type: ts.Type,
        name: string,
        visited = new EmissionSet<ts.Type>(),
        declaredBy: (symbol: ts.Symbol) => boolean = () => true,
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
                    this.typeIsOrExtendsNamed(base, name, visited, declaredBy),
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
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (candidate) => {
            if (found) return "skip";
            if (
                ts.isBinaryExpression(candidate) &&
                candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                this.unwrappedValueSymbol(candidate.left) === symbol
            ) {
                const right = this.unwrap(candidate.right);
                const callee = ts.isCallExpression(right)
                    ? unwrappedIdentifier(right.expression, (wrapped) =>
                          this.unwrap(wrapped),
                      )
                    : undefined;
                if (callee && this.symbols.importedName(callee) === intrinsic) {
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

    public compileNodeInputMutation(expression: ts.Expression): Value | undefined {
        return compileNodeInputMutation(this, expression);
    }

    public checkNodeGeometryMutation(expression: ts.Expression): void {
        checkNodeGeometryMutation(this, expression);
    }

    public noteNodeGeometryMutation(node: ts.Node): void {
        this.deferredAdmissionFailures.push({ capability: "node-geometry", node,
            message: "Node geometry views require static imported mesh transforms; mutation, cloning and unproven transform aliases are not represented." });
    }

    public assertNodeInputMutable(node: ts.Node): void {
        if (this.frameCallbackDepth > 0 || this.engineStartMark !== undefined || this.temporalSceneRegistration) {
            this.fail(node, "Node input texture changes require setup before scene registration; captured bind-group replacement is not represented.");
        }
    }

    public noteNodeInputAdmissionFailure(node: ts.Node, message: string): void {
        if (this.features.has("material:node")) this.fail(node, message);
        this.deferredAdmissionFailures.push({ capability: "node-input", node, message });
    }

    private textAttachmentReached = false;
    private reachedRenderContextRegistrations = new EmissionSet<string>();
    private textCameraMutation: ts.Node | undefined;

    public noteTextCameraControl(node: ts.Node, camera: Value, arcRotate: boolean): void {
        if (!arcRotate || (camera.cameraKind !== undefined && camera.cameraKind !== "arc-rotate")) this.textCameraMutation ??= node;
    }

    public noteTextSceneLifecycle(node: ts.Node, message = "Text scene disposal, removal and explicit rebuilding require retained binding topology that is not represented."): void {
        this.deferredAdmissionFailures.push({ capability: "text", node, message });
    }

    public noteTextSceneCameraAssignment(node: ts.Node): void {
        if (this.isRuntimeResourceConstruction() || this.engineStartMark !== undefined) this.textCameraMutation ??= node;
    }

    public assertTextPipelineMutable(node: ts.Node): void {
        if (this.isRuntimeResourceConstruction() || this.textAttachmentReached || this.engineStartMark !== undefined) {
            this.fail(node, "Text pipeline/order changes require definite initialization before text attachment; live pipeline rebinding and list rebuilding are not represented.");
        }
    }

    public promoteTextData(node: ts.Node): void {
        promoteLiveTextData(this);
        this.reachFeature("text:layout", node);
    }

    public recordTextAttachment(node: ts.Node): void {
        if (this.isRuntimeResourceConstruction() || this.engineStartMark !== undefined) this.fail(node, "Text attachment requires definite initialization; live text list rebuilding is not represented.");
        this.textAttachmentReached = true;
    }

    public assertTextDisposal(node: ts.Node): void {
        if (this.textAttachmentReached || this.isRuntimeResourceConstruction() || this.engineStartMark !== undefined) {
            this.fail(node, "Text disposal requires setup before text attachment; destroying retained draw bindings is not represented.");
        }
    }

    public emitDiscardedValue(value: Value): void {
        if (value.kind === "engine") return;
        if (value.cpp.length === 0) {
            for (const element of value.tupleElements ?? Object.values(value.recordProperties ?? {})) {
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
    private needsSharedClosureStorage(
        declaration: ts.VariableDeclaration,
    ): boolean {
        if (
            !ts.isIdentifier(declaration.name) ||
            !declaration.parent ||
            !ts.isVariableDeclarationList(declaration.parent) ||
            (declaration.parent.flags & ts.NodeFlags.Const) !== 0
        ) {
            return false;
        }
        if (
            ts.isVariableStatement(declaration.parent.parent) &&
            ts.isSourceFile(declaration.parent.parent.parent) &&
            declaration.getSourceFile() !== this.sourceFile
        ) {
            return true;
        }
        const symbol = this.symbols.valueSymbol(declaration.name);
        if (!symbol) return false;
        let owner: ts.Node = declaration;
        while (owner.parent && !ts.isFunctionLike(owner.parent)) {
            owner = owner.parent;
        }
        if (owner.parent) owner = owner.parent;
        return this.sharedClosureSymbolsFor(owner,
            this.variableScopes.length !== 1 || this.activeEmissionScope !== 0)?.has(symbol) ?? false;
    }

    /** Owners under analysis: a helper reached through its own call adds nothing. */
    private readonly sharedClosureAnalysisInProgress = new EmissionSet<ts.Node>();
    private readonly sharedFrameClosureSymbols = new EmissionWeakMap<ts.Node, ReadonlySet<ts.Symbol>>();

    private sharedClosureSymbolsFor(
        owner: ts.Node,
        includeFrameRegistrations = false,
    ): ReadonlySet<ts.Symbol> | undefined {
        const cache = includeFrameRegistrations ? this.sharedFrameClosureSymbols : this.sharedClosureSymbols;
        const cached = cache.get(owner);
        if (cached) return cached;
        if (this.sharedClosureAnalysisInProgress.has(owner)) return undefined;
        this.sharedClosureAnalysisInProgress.add(owner);
        try {
            const captured = this.collectSharedClosureSymbols(owner, includeFrameRegistrations);
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
    private retainedArgumentIndex(
        call: ts.CallExpression,
        includeFrameRegistrations: boolean,
    ): number | undefined {
        const callee = this.unwrap(call.expression);
        if (ts.isIdentifier(callee)) {
            switch (this.symbols.importedName(callee)) {
                case "withNodeParticleEmitterProvider": return 0;
                case "onBeforeRender":
                case "onPhysicsAfterStep":
                case "onCsmReceiverUpdate": return includeFrameRegistrations ? 1 : undefined;
            }
        }
        if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "addEventListener" &&
            call.arguments.length >= 2
        ) {
            return 1;
        }
        const global = browserGlobalNamed(this, call.expression)?.text;
        if (ts.isPropertyAccessExpression(callee) && ["then", "catch", "finally"].includes(callee.name.text) &&
            this.checker.getTypeAtLocation(callee.expression).symbol?.name === "Promise") return 0;
        return (global === "setTimeout" || global === "setInterval" || global === "queueMicrotask" ||
            (includeFrameRegistrations && global === "requestAnimationFrame")) &&
            call.arguments.length >= 1
            ? 0
            : undefined;
    }

    /**
     * Whether a call keeps its argument at `index` in a retained callback:
     * a listener or timer registration, or a repository helper that invokes
     * that parameter from one of its own stored callbacks (freeciv's
     * `installControls(engine, view, zoomCtl, hover, onMapClick)` calls
     * `onClick` from its pointer-up listener). The helper may live in any
     * repository module; the pinned package has no bodies to resolve.
     */
    private callRetainsArgument(
        call: ts.CallExpression,
        index: number,
        includeFrameRegistrations: boolean,
    ): boolean {
        if (this.retainedArgumentIndex(call, includeFrameRegistrations) === index) return true;
        const callee = this.unwrap(call.expression);
        if (!ts.isIdentifier(callee)) return false;
        const target = tryResolveFunctionDeclaration(this.checker, callee);
        if (!target) return false;
        const parameter = target.parameters[index];
        if (!parameter || !ts.isIdentifier(parameter.name)) return false;
        const symbol = this.symbols.valueSymbol(parameter.name);
        return (
            !!symbol &&
            (this.sharedClosureSymbolsFor(target, includeFrameRegistrations)?.has(symbol) ?? false)
        );
    }

    private nativeParticleProviderUse: boolean | undefined;

    /** Closure ownership is decided before the first resource is emitted. */
    private sourceUsesNativeParticleProvider(): boolean {
        if (this.nativeParticleProviderUse !== undefined) return this.nativeParticleProviderUse;
        let found = false;
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
            if (found) return "skip";
            if (ts.isCallExpression(node)) {
                const callee = this.unwrap(node.expression);
                if (ts.isIdentifier(callee) && this.symbols.importedName(callee) === "withNodeParticleEmitterProvider") {
                    found = true;
                    return "skip";
                }
            }
        });
        for (const file of this.program.getSourceFiles()) {
            if (!file.isDeclarationFile) visit(file);
        }
        return this.nativeParticleProviderUse = found;
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
    ): ReadonlySet<ts.Symbol> {
        const captured = new EmissionSet<ts.Symbol>();
        const storedLocalFunctions = new EmissionSet<ts.Symbol>();
        const localFunctions = new EmissionMap<ts.Symbol, ts.FunctionLikeDeclaration>();
        const localFunctionNames = new EmissionSet<string>();
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
        const localFunctionName = (
            node: ts.Node,
        ): ts.Identifier | undefined =>
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
            // Constructors and instance fields can retain the function for
            // the object's lifetime, including a callback supplied as a
            // parameter property. Mutable outer bindings remain shared.
            if ((ts.isNewExpression(parent) && parent.arguments?.includes(node) &&
                    !(ts.isIdentifier(parent.expression) && this.isDefaultLibraryIdentifier(parent.expression))) ||
                (ts.isPropertyDeclaration(parent) && parent.initializer === node)) return true;
            if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
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
                const root = rootIdentifier(target, (chain) => this.unwrap(chain));
                return (
                    (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target) ||
                        ts.isElementAccessExpression(target)) &&
                    (!(root && this.isDefaultLibraryIdentifier(root)) ||
                        (isDeterministicRandomRead(this, parent.left) && this.sourceUsesNativeParticleProvider()))
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
        findAnalysisNodeWithState(owner, 0, (node, callbackDepth) => {
            const name = localFunctionName(node);
            if (name) {
                localFunctionNames.add(name.text);
                const symbol = this.symbols.valueSymbol(name);
                if (symbol && isSupportedFunction(node)) {
                    localFunctions.set(symbol, node);
                }
            }
            if (isClosure(node)) {
                const call = ts.isCallExpression(node.parent) ? node.parent : undefined;
                const index = call ? call.arguments.indexOf(node) : -1;
                if (
                    isRecordMember(node) ||
                    (ts.isReturnStatement(node.parent) &&
                        node.parent.expression === node) ||
                    isDataSinkClosure(node) ||
                    (call !== undefined &&
                        index >= 0 &&
                        (callbackDepth > 0 ||
                            this.callRetainsArgument(call, index, includeFrameRegistrations)))
                ) {
                    addRoot(node);
                }
            } else if (isRecordMember(node) && (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))) {
                addRoot(node);
            }
            return false;
        }, (node, depth) => isClosure(node) && ts.isCallExpression(node.parent) && node.parent.arguments.includes(node)
            ? depth + 1 : depth, { includeRoot: false });
        // A local function referenced anywhere but as a direct callee is a
        // value the program keeps: passed by name, assigned, pushed, returned
        // or captured.
        forEachAnalysisNode(owner, (node) => {
            if (ts.isShorthandPropertyAssignment(node)) {
                if (localFunctionNames.has(node.name.text)) storeNamed(node.name);
            } else if (ts.isIdentifier(node) && localFunctionNames.has(node.text)) {
                const parent = node.parent;
                const declared =
                    (ts.isFunctionDeclaration(parent) ||
                        ts.isVariableDeclaration(parent)) &&
                    parent.name === node;
                const callee =
                    ts.isCallExpression(parent) && parent.expression === node;
                const member =
                    ts.isPropertyAccessExpression(parent) && parent.name === node;
                if (!declared && !callee && !member) {
                    const symbol = this.symbols.valueSymbol(node);
                    if (symbol && localFunctions.has(symbol)) storeNamed(node);
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
                if (ts.isIdentifier(node) && localFunctionNames.has(node.text)) {
                    const symbol = this.symbols.valueSymbol(node);
                    const declaration = symbol
                        ? localFunctions.get(symbol)
                        : undefined;
                    if (symbol && declaration && !storedLocalFunctions.has(symbol)) {
                        storedLocalFunctions.add(symbol);
                        addRoot(declaration);
                    }
                }
            });
        }
        const insideStoredClosure = (node: ts.Node, inside: boolean): boolean => {
            const name = localFunctionName(node);
            return inside || rootSet.has(node) || (!!name && isStoredLocal(name));
        };
        findAnalysisNodeWithState(owner, false, (node, inside) => {
            if (insideStoredClosure(node, inside) && ts.isIdentifier(node)) {
                const symbol = this.symbols.valueSymbol(node);
                if (symbol) captured.add(symbol);
            }
            return false;
        }, insideStoredClosure, { includeRoot: false });
        return captured;
    }

    private isSharedClosureScalar(kind: string): boolean {
        return (
            kind === "number" ||
            kind === "boolean" ||
            kind === "string" ||
            kind === "enum"
        );
    }

    public emitVariableDeclaration(declaration: ts.VariableDeclaration): void {
        if (!declaration.initializer && declaration.type && ts.isTypeReferenceNode(declaration.type) &&
            ts.isIdentifier(declaration.type.typeName) && declaration.type.typeName.text === "GPUTexture" &&
            !this.checker.getSymbolAtLocation(declaration.type.typeName)?.declarations?.length &&
            ts.isIdentifier(declaration.name)) {
            const cpp = this.cppIdentifier(declaration.name.text);
            this.emit({ kind: "declaration", type: "bbl::GpuTextureIdentity", name: cpp, initializer: "", initialization: "direct" });
            this.defineVariable(declaration.name, { kind: "gpu-texture", cpp, dataType: { kind: "handle", handle: "gpu-texture" }, engineCpp: this.requireDefaultEngine(declaration) });
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
            this.fail(
                declaration.name,
                "Only identifier variable declarations are supported.",
            );
        }
        // An empty `Mesh[]` and the entity loop that fills it are one
        // construct — the recursive-visitor spelling of a container
        // flatten — so the pair is answered here, before the declaration
        // could become a runtime vector this port does not materialize.
        const flattened =
            this.handleCollections.assetRecursiveFlattenDeclaration(
                declaration,
            );
        if (flattened) {
            this.defineVariable(declaration.name, flattened);
            return;
        }
        const declarationSymbol = this.symbols.valueSymbol(declaration.name);
        if (
            declarationSymbol &&
            this.hoistedCallbackBindings.has(declarationSymbol) &&
            this.lookupOptional(declaration.name)
        ) {
            this.hoistedCallbackBindings.delete(declarationSymbol);
            return;
        }
        const sourceName = declaration.name.text;
        const cppName = this.cppIdentifier(sourceName);
        const sharedClosureStorage =
            this.needsSharedClosureStorage(declaration);
        if (!declaration.initializer) {
            if (
                declaration.parent === undefined ||
                !ts.isVariableDeclarationList(declaration.parent) ||
                (declaration.parent.flags & ts.NodeFlags.Const) !== 0
            ) {
                this.fail(
                    declaration,
                    `Constant '${sourceName}' requires an initializer.`,
                );
            }
            const resource = this.nullableResourceKind(declaration.name, true);
            if (resource) {
                this.emit(
                    sharedClosureStorage
                        ? { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<std::optional<${resource.cppType}>>()` }
                        : { kind: "declaration", type: `std::optional<${resource.cppType}>`, name: cppName, initializer: "", initialization: "default" },
                );
                this.defineVariable(declaration.name, valueForKind(resource.kind, {
                    cpp: sharedClosureStorage
                        ? `(**${cppName})`
                        : `(*${cppName})`,
                    ...((resource.kind === "ui-element" ||
                        resource.kind === "pointer-drag") &&
                    this.defaultEngineCpp
                        ? { engineCpp: this.defaultEngineCpp }
                        : {}),
                    optionalFoundCpp: sharedClosureStorage
                        ? `${cppName}->has_value()`
                        : `${cppName}.has_value()`,
                    ...(sharedClosureStorage ? { sharedStorageCpp: cppName } : {}),
                    optionalStorageCpp: sharedClosureStorage
                        ? `(*${cppName})`
                        : cppName,
                }));
                return;
            }
            let dataType = this.dataTypes.fromTsType(
                this.checker.getTypeAtLocation(declaration.name),
                declaration.name,
            );
            dataType ??= inferUninitializedHandle(declaration, this.checker, this.dataTypes);
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
                this.reachJson();
            }
            if (!dataType) {
                // `let set;` -- no initializer and no native type: the
                // value is whatever the first assignment binds, and for a
                // compile-time record (a node-particle binding built inside
                // a `try`) nothing native exists to declare here. The
                // assignment decides; see `bindPendingLet`.
                this.defineVariable(declaration.name, {
                    kind: "pending-let",
                    cpp: "",
                });
                return;
            }
            if (dataType.kind === "borrowed-platform-event") {
                this.fail(
                    declaration,
                    `Variable '${sourceName}' cannot default-construct a borrowed DOM event; bind it from an active platform callback.`,
                );
            }
            if (
                dataType.kind !== "number" &&
                dataType.kind !== "boolean" &&
                dataType.kind !== "string"
            ) {
                this.reachJsData();
            }
            const cppType = this.dataTypes.cppType(dataType);
            this.emit(
                sharedClosureStorage
                    ? { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<${cppType}>()` }
                    : { kind: "declaration", type: cppType, name: cppName, initializer: "", initialization: "default" },
            );
            const boundCpp = sharedClosureStorage ? `(*${cppName})` : cppName;
            if (dataType.kind !== "number" && dataType.kind !== "boolean") {
                this.dataLowerer.registerLocal(boundCpp, "owned");
            }
            this.defineVariable(
                declaration.name,
                { ...this.dataLowerer.leafValue(boundCpp, dataType),
                    ...(sharedClosureStorage ? { sharedStorageCpp: cppName } : {}) },
            );
            return;
        }

        if (
            declaration.parent !== undefined &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.Const) === 0
        ) {
            const symbol = this.symbols.valueSymbol(declaration.name);
            if (symbol) {
                this.staticConstants.delete(symbol);
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
        if (this.emitEscapingResolvePromise(declaration, cppName)) {
            return;
        }

        // `const original = Math.random`, which the corpus writes only to
        // put the generator back after a seeded window. It names the
        // function itself rather than a value, so it emits nothing and the
        // binding exists for the restore assignment to recognize.
        if (isDeterministicRandomRead(this, declaration.initializer)) {
            const native = this.reachedNodeParticles.sets.some((set) => set.native);
            if (native) {
                this.emit({ kind: "declaration", type: "auto", name: cppName, initializer: "bbl::js::random_function()" });
                this.defineVariable(declaration.name, {
                    kind: "callback", cpp: cppName,
                    nativeCallbackParameterTypes: [], nativeCallbackReturnType: { kind: "number" },
                });
            } else {
                this.defineVariable(declaration.name, { kind: "js-random", cpp: "" });
            }
            return;
        }

        const nullableResource = this.nullableResourceKind(declaration.name);
        if (
            declaration.initializer.kind === ts.SyntaxKind.NullKeyword &&
            nullableResource
        ) {
            this.emit(
                sharedClosureStorage
                    ? { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<std::optional<${nullableResource.cppType}>>()` }
                    : { kind: "declaration", type: `std::optional<${nullableResource.cppType}>`, name: cppName, initializer: "", initialization: "default" },
            );
            this.defineVariable(declaration.name, valueForKind(nullableResource.kind, {
                cpp: sharedClosureStorage ? `(**${cppName})` : `(*${cppName})`,
                ...((nullableResource.kind === "ui-element" ||
                    nullableResource.kind === "pointer-drag") &&
                this.defaultEngineCpp
                    ? { engineCpp: this.defaultEngineCpp }
                    : {}),
                optionalFoundCpp: sharedClosureStorage
                    ? `${cppName}->has_value()`
                    : `${cppName}.has_value()`,
                ...(sharedClosureStorage ? { sharedStorageCpp: cppName } : {}),
                optionalStorageCpp: sharedClosureStorage
                    ? `(*${cppName})`
                    : cppName,
            }));
            return;
        }

        const hostLookup = this.unwrap(declaration.initializer);
        if (!this.defaultEngineCpp && !this.options.workers &&
            ts.isCallExpression(hostLookup) && this.isNativeHostUiLookup(hostLookup)) {
            const id = this.compileStringLiteral(argumentAt(hostLookup, 0));
            const value: Value = { kind: "ui-element", cpp: cppName, uiHostId: id,
                uiTag: this.ui.nativeHostUiTags().get(id)!, truthinessCpp: "true" };
            this.pendingHostUiLookups.push(value);
            this.defineVariable(declaration.name, value);
            return;
        }

        if (
            this.isBrowserOnlyExpression(declaration.initializer) &&
            this.moduleRelativeAssetUrl(declaration.initializer) === undefined
        ) {
            const browserValue = this.evaluateBrowserValue(
                declaration.initializer,
            );
            this.defineVariable(declaration.name, {
                kind: "browser",
                cpp: "",
                ...(browserValue ? { browserValue } : {}),
            });
            return;
        }

        const engineCall = this.importedCall(
            declaration.initializer,
            "createEngine",
        );
        if (engineCall && !this.options.workers) {
            const engine = this.compileEngineCreation(engineCall, cppName);
            this.defineVariable(declaration.name, engine);
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
        let value = this.compileValue(declaration.initializer);
        value = this.bindSceneNodeVector(value);
        value = this.bindCameraVector(value);
        if (forwardCallback) {
            this.completeForwardFunctionResult(
                declaration,
                forwardCallback,
                value,
            );
            return;
        }
        value = this.referenceRecordValue(value, declaration.initializer) ?? value;
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
            const initializerCpp =
                value.optionalStorageCpp ?? this.optionalResourceCpp(value);
            this.emit(
                sharedClosureStorage
                    ? { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<std::optional<${nullableResource.cppType}>>(${initializerCpp})` }
                    : { kind: "declaration", type: `std::optional<${nullableResource.cppType}>`, name: cppName, initializer: initializerCpp },
            );
            this.defineVariable(declaration.name, {
                ...value,
                cpp: sharedClosureStorage ? `(**${cppName})` : `(*${cppName})`,
                optionalFoundCpp: sharedClosureStorage
                    ? `${cppName}->has_value()`
                    : `${cppName}.has_value()`,
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
            const symbol = this.symbols.valueSymbol(
                declaration.name,
            );
            if (symbol) {
                this.staticConstants.delete(symbol);
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
            this.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "browser") {
            // A local helper can erase its DOM body statement by statement
            // and return a browser handle. The call itself is not necessarily
            // recognizable as browser-only before inlining, but its resulting
            // binding is still a valid erased browser value.
            this.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "engine") {
            // createEngine already emitted the owning engine. A helper's
            // return value or an alias names that same identity; copying it
            // would separate the scene registry from callbacks retaining it.
            if (this.identifierIsRebound(declaration.name)) {
                this.fail(
                    declaration,
                    "Reassigning an engine alias is not supported.",
                );
            }
            this.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "void") {
            this.fail(
                declaration.initializer,
                `Expression assigned to '${sourceName}' does not produce a native value.`,
            );
        }
        if (value.kind === "callback" || isCompileTimeOnlyValue(value.kind)) {
            this.defineVariable(declaration.name, value);
            if (value.kind === "record") this.materializeAssignedRecordMethods(declaration.name, value);
            return;
        }
        if (value.kind === "data") {
            const symbol = this.symbols.valueSymbol(declaration.name);
            if (symbol) this.staticConstants.delete(symbol);
            const narrowed = this.dataLowerer.narrowForDeclaration(
                value,
                declaration.name,
            );
            if (!narrowed.dataType) {
                this.fail(
                    declaration.initializer,
                    `Data expression is missing its type (${narrowed.cpp}).`,
                );
            }
            if (
                narrowed.dataType.kind === "optional" &&
                narrowed.dataType.inner.kind === "struct" &&
                narrowed.objectIdentityCpp !== undefined
            ) {
                this.emit({ kind: "declaration", type: "auto*", name: cppName, initializer: narrowed.objectIdentityCpp });
                this.dataLowerer.registerAlias(
                    cppName,
                    narrowed.objectIdentityCpp,
                );
                this.defineVariable(declaration.name, {
                    ...nativeDataMetadata(narrowed),
                    kind: "data",
                    cpp: cppName,
                    optionalFoundCpp: `${cppName} != nullptr`,
                    objectIdentityCpp: cppName,
                });
                return;
            }
            const initializer = this.unwrap(declaration.initializer);
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
                passesByReference(this.dataTypes, narrowed.dataType) &&
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
                isTypedArrayType(narrowed.dataType);
            // These copies own their references; another wrapper's resize or
            // rebind cannot invalidate them like an interior C++ reference.
            const ownsSharedStorage = wrapperCopiesIdentity &&
                !narrowed.borrowedData && !narrowed.nativeVectorData;
            const optionalFoundCpp =
                narrowed.optionalFoundCpp === undefined
                    ? undefined
                    : this.allocateTemporaryCppName("element_found");
            const referenceStruct =
                narrowed.dataType.kind === "struct" &&
                this.dataTypes.isReferenceStruct(narrowed.dataType.name);
            if (optionalFoundCpp && !referenceStruct) {
                // A JavaScript local captures whether the element existed
                // when its initializer ran. Keep that snapshot separate
                // from the safe default object used to avoid an invalid
                // native read on the missing path.
                this.emit(
                    { kind: "declaration", type: "const bool", name: optionalFoundCpp, initializer: narrowed.optionalFoundCpp!, attributes: "[[maybe_unused]] " },
                );
            }
            const localType = narrowed.nativeVectorData
                ? "auto"
                : this.dataTypes.cppType(narrowed.dataType);
            const sharedDataBinding =
                sharedClosureStorage &&
                this.identifierIsRebound(declaration.name);
            const boundCpp = sharedDataBinding ? `(*${cppName})` : cppName;
            this.emit({
                kind: "declaration", name: cppName,
                type: sharedDataBinding ? "auto" : `${localType}${(aliases && !wrapperCopiesIdentity) || narrowed.borrowedData ? "&" : ""}`,
                initializer: sharedDataBinding ? `bbl::js::make_gc_shared<${localType}>(${narrowed.cpp})` : narrowed.cpp,
            });
            if (optionalFoundCpp && referenceStruct) {
                // Reference-backed records already use an empty shared
                // pointer as their safe missing value. Test the stored local
                // instead of repeating a conditional initializer (and all
                // branch preparation it may contain) just to learn whether
                // the result exists.
                this.emit(
                    { kind: "declaration", type: "const bool", name: optionalFoundCpp, initializer: `static_cast<bool>(${boundCpp})`, attributes: "[[maybe_unused]] " },
                );
            }
            if (aliases && !ownsSharedStorage) {
                this.dataLowerer.registerAlias(cppName, narrowed.cpp);
            } else {
                this.dataLowerer.registerLocal(
                    boundCpp,
                    constructs || referenceStruct || narrowed.freshData || ownsSharedStorage
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
                    ? this.dataLowerer.leafValue(
                          `(*${boundCpp})`,
                          narrowed.dataType.inner,
                      )
                    : undefined;
            this.defineVariable(declaration.name, valueForKind(optionalHandle?.kind ?? "data", {
                ...(optionalHandle ?? {
                    kind: "data" as const,
                    cpp: boundCpp,
                    dataType: narrowed.dataType,
                }),
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
                    ? { collectionCardinality: narrowed.collectionCardinality }
                    : {}),
                ...(!narrowed.freshData && narrowed.runtimeElementTemplate
                    ? { runtimeElementTemplate: narrowed.runtimeElementTemplate }
                    : {}),
                ...(narrowed.recordProperties
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
                ...(narrowed.preserveUncheckedLookup ? {preserveUncheckedLookup: true as const} : {}),
                ...(optionalHandle
                    ? {
                          optionalStorageCpp: boundCpp,
                          optionalFoundCpp: `${boundCpp}.has_value()`,
                          truthinessCpp: `${boundCpp}.has_value()`,
                      }
                    : optionalFoundCpp
                      ? { optionalFoundCpp }
                      : {}),
                ...(narrowed.truthinessCpp
                    ? {
                          truthinessCpp: narrowed.truthinessCpp.replaceAll(
                              narrowed.cpp,
                              boundCpp,
                          ),
                      }
                    : {}),
            }));
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
                      : value.dataType?.kind === "enum"
                        ? this.dataTypes.cppType(value.dataType)
                        : "auto";
        // compileValue already emits a JS number at double precision.
        // Compiling the initializer again is observably wrong for calls and
        // other expressions that materialize temporaries.
        const initializerCpp = value.cpp;
        const maybeUnused = value.kind === "number" || value.kind === "boolean" ? "[[maybe_unused]] " : "";
        const sharedPrimitive =
            sharedClosureStorage &&
            this.isSharedClosureScalar(
                value.dataType?.kind === "enum" ? "enum" : value.kind,
            );
        const boundCpp = sharedPrimitive ? `(*${cppName})` : cppName;
        const optionalFoundCpp =
            value.optionalFoundCpp === undefined ||
            value.optionalFoundCpp === "true" ||
            value.optionalFoundCpp === "false"
                ? undefined
                : this.allocateTemporaryCppName("element_found");
        this.emit({
            kind: "declaration", name: cppName, type: sharedPrimitive ? "auto" : nativeType,
            initializer: sharedPrimitive ? `bbl::js::make_gc_shared<${nativeType}>(${initializerCpp})` : initializerCpp,
            attributes: sharedPrimitive ? "" : maybeUnused,
        });
        if (optionalFoundCpp) {
            // A local initialized from any maybe-absent handle snapshots both
            // the handle and whether it was present. Derive presence from the
            // bound handle where possible rather than re-reading an owner
            // whose slot may move later.
            const presence =
                value.cpp.length > 0
                    ? value.optionalFoundCpp!.replaceAll(value.cpp, boundCpp)
                    : value.optionalFoundCpp!;
            this.emit(
                { kind: "declaration", type: "const bool", name: optionalFoundCpp, initializer: presence, attributes: "[[maybe_unused]] " },
            );
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
        this.defineVariable(declaration.name, stored);
    }

    /** Mutable methods need a shared slot before callbacks can retain their owner. */
    private materializeAssignedRecordMethods(name: ts.Identifier, owner: Value): void {
        const initializers: Array<() => void> = [];
        const callbacks = new Map(Object.entries(owner.recordProperties ?? {}).filter(([, value]) => value.kind === "callback"));
        for (const [key, method] of Object.entries(owner.recordMethods ?? {})) callbacks.set(key,
            {kind:"callback", cpp:"", callbackDeclaration:method, callbackRecordOwner:owner});
        if (callbacks.size === 0) return;
        const assigned = new Set<string>();
        aliasedMutationScan(name, identifier => this.symbols.valueSymbol(identifier), {
                aliasingInitializer: (expression, scan) => {
                    const unwrapped = this.unwrap(expression);
                    return ts.isIdentifier(unwrapped) && scan.namesAlias(unwrapped);
                },
                mutates: (node, scan) => {
                    if (isAssignmentExpression(node) && ts.isPropertyAccessExpression(node.left) &&
                        callbacks.has(node.left.name.text) && scan.namesAlias(node.left.expression)) assigned.add(node.left.name.text);
                    return assigned.size === callbacks.size;
                },
        });
        const ownerType = this.checker.getTypeAtLocation(name);
        for (const key of assigned) {
            const callback = callbacks.get(key)!;
            const site = callback.callbackDeclaration ?? name;
            const parameters = callback.nativeCallbackParameterTypes;
            const property = ownerType.getProperty(key);
            const declaredType = property && this.dataTypes.fromTsType(this.checker.getTypeOfSymbolAtLocation(property, name), name);
            const type: DataType | undefined = declaredType?.kind === "function" ? declaredType : parameters?.every((parameter): parameter is DataType => parameter !== undefined)
                ? { kind: "function", parameters: [...parameters],
                    ...(callback.nativeCallbackReturnType ? { result: callback.nativeCallbackReturnType } : {}) }
                : this.dataLowerer.dataTypeAt(site);
            if (type?.kind !== "function") this.fail(site, "A mutable record method requires a concrete native function signature.");
            const slot = this.allocateTemporaryCppName(`record_method_${key}`);
            this.emit({kind:"declaration", type:"auto", name:slot, initializer:`bbl::js::make_gc_shared<${this.dataTypes.cppType(type)}>()`});
            const capture = this.registerNativeBinding(slot);
            owner.recordProperties ??= {};
            owner.recordProperties[key] = {...this.dataLowerer.leafValue(`(*${slot})`, type), nativeLvalue:true,
                sharedStorageCpp:slot, nativeCaptures:[capture]};
            if (owner.recordMethods) delete owner.recordMethods[key];
            initializers.push(() => this.emit(`(*${slot}) = ${this.dataLowerer.compileKnownValueForSink(callback, type, site)};`));
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
        const initializer = this.unwrap(declaration.initializer);
        if (!ts.isCallExpression(initializer)) return undefined;
        if (
            this.importedCall(initializer, "onCsmReceiverUpdate") ||
            this.importedCall(initializer, "enableSurfaceResizeObserver")
        ) {
            // The shadow intrinsic materializes and registers its native
            // disposer directly. It is already a callable value, not a
            // source callback declaration returned by an inlined builder.
            return undefined;
        }
        const signatures = this.checker
            .getTypeAtLocation(name)
            .getCallSignatures();
        if (signatures.length !== 1) return undefined;
        const signature = signatures[0]!;
        const returnType = this.checker.getReturnTypeOfSignature(signature);
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
            const type = this.dataTypes.fromTsType(
                this.checker.getTypeOfSymbolAtLocation(parameter, site),
                site,
            );
            if (
                !type ||
                type.kind === "function" ||
                this.dataTypes.carriesHandle(type)
            ) {
                return undefined;
            }
            parameterTypes.push(type);
            parameterNames.push(
                this.allocateTemporaryCppName(`forward_callback_arg_${index}`),
            );
        }
        this.reachJsData();
        const parameterCpp = parameterTypes.map((type) =>
            this.dataTypes.cppType(type),
        );
        const storage = this.emitNativeCallbackStorage(
            cppName,
            `void(${parameterCpp.join(", ")})`,
            // The slot exists because a closure handed to the builder
            // references it, and that closure's whole purpose is to run
            // when an event fires after the builder returned -- the
            // forward edge always escapes.
            true,
        );
        const storageCpp = storage.cpp;
        this.defineVariable(name, {
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
        if (!ts.isIdentifier(name)) this.fail(name, "Function bindings require an identifier.");

        if (
            value.kind === "data" &&
            value.dataType?.kind === "function" &&
            value.cpp.length > 0
        ) {
            // A function stored in a plain-data record (for example an
            // observer method returning its unsubscribe closure) is already
            // a native std::function. Fill the forward slot from that value;
            // there is no source declaration left to specialize again.
            this.emit(`${forward.storageCpp} = ${value.cpp};`);
            this.rebindVariable(name, {
                kind: "callback",
                cpp: forward.storageCpp,
                nativeCallbackParameterTypes: forward.parameterTypes,
            });
            return;
        }
        if (value.kind !== "callback" || !value.callbackDeclaration) {
            this.fail(
                declaration.initializer!,
                "Function-valued call initializer did not return a supported callback " +
                    `(received ${value.kind}, native=${value.cpp.length > 0}, ` +
                    `declaration=${value.callbackDeclaration !== undefined}, ` +
                    `data=${JSON.stringify(value.dataType)}).`,
            );
        }
        const arguments_ = forward.parameterTypes.map((type, index) =>
            this.dataValue(forward.parameterNames[index]!, type),
        );
        const compiled = this.captureManagedClosureLines(() => {
            for (const name of forward.parameterNames) this.registerNativeBinding(name);
            const compile = () =>
                this.compileCallbackWithValues(
                    value.callbackDeclaration!,
                    arguments_,
                    declaration.initializer!,
                );
            const result = value.callbackRecordOwner
                ? this.withRecordScopes(value.callbackRecordOwner, compile)
                : compile();
            this.emitDiscardedValue(result);
        });
        const parameters = forward.parameterTypes.map(
            (type, index) =>
                `${this.dataTypes.cppType(type)} ${forward.parameterNames[index]}`,
        );
        this.emit(
            `${forward.storageCpp} = ${renderClosure(compiled, parameters.join(", "))};`,
        );
        this.rebindVariable(name, {
            kind: "callback",
            cpp: forward.storageCpp,
            nativeCallbackParameterTypes: forward.parameterTypes,
            platformCallbackIdentity: this.callbackIdentity(
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
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (candidate) => {
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
        const symbol = this.symbols.valueSymbol(name);
        if (!symbol) return;
        let recursive = false;
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
            if (recursive) return "skip";
            if (this.options.workers && ts.isIdentifier(node) && this.symbols.valueSymbol(node) === symbol) {
                recursive = true;
                return "skip";
            }
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                this.symbols.valueSymbol(node.expression) === symbol
            ) {
                recursive = true;
                return "skip";
            }
            if (!this.options.workers && node !== callback && ts.isFunctionLike(node)) {
                return "skip";
            }
        });
        visit(callback.body);
        if (!recursive) return;
        if (!ts.isBlock(callback.body)) {
            this.fail(
                callback.body,
                "Recursive callbacks require a block body.",
            );
        }
        const callbackBody = callback.body;
        const signature = this.checker.getSignatureFromDeclaration(callback);
        if (!signature) {
            this.fail(
                callback,
                "Recursive callback has no callable signature.",
            );
        }
        const returnTsType = nativeReturnTsType(
            this.checker,
            this.checker.getReturnTypeOfSignature(signature),
            callback,
            { unwrapPromise: false },
        );
        const returnType = returnTsType
            ? this.dataTypes.fromTsType(returnTsType, callback)
            : undefined;
        if (returnTsType && !returnType) {
            this.fail(
                callback,
                "Recursive callback return type must be plain data or void.",
            );
        }
        const parameters = callback.parameters.map((parameter) => {
            if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) {
                this.fail(
                    parameter,
                    "Recursive callback parameters must be non-rest identifiers.",
                );
            }
            const type = this.dataTypes.fromTsType(
                this.checker.getTypeAtLocation(parameter),
                parameter,
            );
            if (!type) {
                this.fail(
                    parameter,
                    "Recursive callback parameters must have plain-data types.",
                );
            }
            const byReference = passesByReference(this.dataTypes, type);
            const readOnly = parameterIsReadOnly(
                this.checker,
                callback,
                parameter.name,
            );
            return {
                declaration: parameter,
                name: parameter.name,
                type,
                byReference,
                readOnly,
            };
        });
        const returnCpp = returnType
            ? this.dataTypes.cppType(returnType)
            : "void";
        const parameterTypes = parameters.map(
            ({ type, byReference, readOnly }) =>
                byReference
                    ? `${readOnly ? "const " : ""}${this.dataTypes.cppType(type)}&`
                    : this.dataTypes.cppType(type),
        );
        this.reachJsData();
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
                this.checker,
                new EmissionSet<SupportedFunction>([callback]),
                [enclosingBody],
            );
        if (escapes) {
            this.refuseEscapingPlatformEventCapturesIn(
                callback,
                this.variableScopes.length,
            );
        }
        const storage = this.emitNativeCallbackStorage(
            cppName,
            `${returnCpp}(${parameterTypes.join(", ")})`,
            escapes,
        );
        this.defineVariable(name, {
            ...storage,
            callbackDeclaration: callback,
            nativeCallbackParameterTypes: parameters.map(parameter => parameter.type),
            nativeCallbackStaticArguments: parameters.map(() => undefined),
            ...(returnType ? { nativeCallbackReturnType: returnType } : {}),
        });
        let parameterDeclarations: string[] = [];
        const emitCallbackBody = (): void => {
            const captured = captureDataFunctionBody(
                this,
                parameters,
                returnType,
                () => {
                    emitReachableStatements(this, callbackBody.statements);
                },
            );
            parameterDeclarations = captured.parameterDeclarations;
            for (const line of captured.lines) this.emit(line);
        };
        const compiled = this.captureManagedClosureLines(emitCallbackBody, !escapes);
        this.emit(
            `${storage.cpp} = ${renderClosure(compiled, parameterDeclarations.join(", "), returnCpp)};`,
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
        const unwrapped = this.unwrap(expression);
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
                this.symbols.valueSymbol(unwrapped)?.valueDeclaration;
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
                this.checker.getResolvedSignature(unwrapped)?.declaration;
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
            const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
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
        const annotatedResource = this.nullableResourceKind(
            name,
            true,
        );
        if (annotatedResource?.kind === "storage-buffer") {
            // StorageBuffer is an opaque engine resource even though the
            // upstream declaration is a structurally visible interface.
            // Keep an explicit `const buffer: StorageBuffer = ...` on the
            // ordinary value path instead of materializing that interface as
            // a plain-data struct.
            return false;
        }
        const typeSite = declaration.type ?? name;
        let annotated = this.dataTypes.fromTsType(
            declaration.type
                ? this.checker.getTypeFromTypeNode(declaration.type)
                : this.checker.getTypeAtLocation(name),
            typeSite,
        );
        if (
            annotated?.kind === "optional" &&
            annotated.inner.kind === "struct"
        ) {
            // A rebindable nullable object carries JavaScript object identity:
            // assigning another object selects that object, it does not copy
            // its fields into optional inline storage. Reference-backed
            // structs already encode both identity and null in their shared
            // pointer, so use that representation for this declaration.
            annotated = this.dataTypes.markStoredObjectReferences(annotated);
        }
        if (annotated?.kind === "enum" && sharedClosureStorage) {
            const initializer = this.compileValue(declaration.initializer);
            const cppType = this.dataTypes.cppType(annotated);
            const initializerCpp = this.dataLowerer.compileKnownValueForSink(
                initializer,
                annotated,
                declaration.initializer,
            );
            this.emit(
                { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<${cppType}>(${initializerCpp})` },
            );
            this.defineVariable(name, {
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
            ts.isArrayLiteralExpression(this.unwrap(declaration.initializer)) &&
            this.inferredArrayIsMutated(name);
        const initializer = this.unwrap(declaration.initializer);
        const annotatedOpenRecordLiteral =
            declaration.type !== undefined &&
            annotated?.kind === "map" &&
            ts.isObjectLiteralExpression(initializer) &&
            ts.isIdentifier(name);
        if (
            annotatedOpenRecordLiteral &&
            !this.openRecordContainerIsMutated(
                name,
            ) &&
            !this.identifierIsRebound(name)
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
            (ts.isObjectLiteralExpression(initializer) || ts.isConditionalExpression(initializer)
                ? this.inferredObjectIsMutated(name)
                : this.identifierIsRebound(name));
        const inferredMutableObject = !declaration.type && mutablePlainObject;
        const explicitlyTypedMutableEntryObject =
            declaration.type !== undefined &&
            mutablePlainObject &&
            this.defaultEngine() !== undefined;
        if (
            !declaration.type &&
            !inferredMutableArray &&
            !inferredMutableObject
        ) {
            return false;
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
            annotated = this.dataTypes.markStoredObjectReferences(annotated);
        }
        const initializerLiteral = this.unwrap(declaration.initializer);
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
            const symbol = this.symbols.valueSymbol(name);
            if (symbol) this.staticConstants.delete(symbol);
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
                ? this.handleCollections.staticHandleList(initializer)
                : undefined;
        const staticHandleElements = staticHandleEntries?.every(
            ({ value }) => value.kind === staticHandleElementType?.handle,
        )
            ? staticHandleEntries.map(({ value }) => value)
            : undefined;
        // Native numeric tuples retain generation facts on the same snapshot
        // that array writes and escaping aliases already invalidate.
        const staticTupleNumbers = annotated.kind === "tuple" &&
            ts.isArrayLiteralExpression(initializer)
            ? initializer.elements.map((element) => staticNumberValue(this, element))
            : undefined;
        const staticTupleElements: Value[] | undefined = staticTupleNumbers?.every(
            (value): value is number => value !== undefined,
        ) ? staticTupleNumbers.map((value, index) => ({
            kind: "number",
            cpp: `${cppName}[${index}]`,
            staticNumber: value,
        })) : undefined;
        const staticElements =
            annotated.kind === "vector" &&
            ts.isArrayLiteralExpression(initializer) &&
            initializer.elements.length === 0
                ? []
                : staticHandleElements ?? staticTupleElements;
        this.reachJsData();
        const spreadTarget =
            annotated.kind === "struct"
                ? annotated
                : annotated.kind === "optional" &&
                    annotated.inner.kind === "struct"
                  ? annotated.inner
                  : undefined;
        const declarationSymbol = ts.isIdentifier(name)
            ? this.symbols.valueSymbol(name)
            : undefined;
        let initializerReferencesBinding = false;
        const scannedFunctions = new EmissionSet<ts.FunctionLikeDeclaration>();
        if (declarationSymbol) {
            const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
                if (initializerReferencesBinding) return "skip";
                if (
                    ts.isIdentifier(node) &&
                    this.symbols.valueSymbol(node) === declarationSymbol
                ) {
                    initializerReferencesBinding = true;
                    return "skip";
                }
                if (ts.isCallExpression(node)) {
                    const called =
                        this.checker.getResolvedSignature(node)?.declaration;
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
                (annotated.kind === "struct" && this.dataTypes.isReferenceStruct(annotated.name)));
        const sharedDataBinding = !selfReferentialBinding &&
            sharedClosureStorage && this.identifierIsRebound(name);
        if (selfReferentialBinding) {
            // A method in the initializer closes over the JavaScript binding,
            // not over the empty value it has while that initializer is being
            // lowered. Keep the reference in a shared cell so the generated
            // lambda observes the assignment immediately below.
            this.emit(
                { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<${this.dataTypes.cppType(annotated)}>()` },
            );
            this.defineVariable(
                name,
                { ...this.dataLowerer.leafValue(`(*${cppName})`, annotated), sharedStorageCpp: cppName },
            );
        }
        const initializerSnapshot =
            spreadTarget &&
            ((ts.isObjectLiteralExpression(initializer) &&
                !initializer.properties.some(ts.isSpreadAssignment)) ||
                ts.isConditionalExpression(initializer))
                ? this.compileValue(initializer)
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
                    ? this.allocateTemporaryCppName("shared_initial")
                    : cppName;
            this.dataLowerer.emitSpreadStructDeclaration(
                targetCpp,
                initializer,
                spreadTarget,
            );
            if (sharedDataBinding) {
                this.emit(
                    { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<${this.dataTypes.cppType(annotated)}>(std::move(${targetCpp}))` },
                );
            } else if (selfReferentialBinding) {
                this.emit(`(*${cppName}) = std::move(${targetCpp});`);
            }
        } else {
            const initializerCpp =
                initializerSnapshot
                    ? this.dataLowerer.compileKnownValueForSink(
                          initializerSnapshot,
                          annotated,
                          declaration.initializer,
                      )
                    : this.dataLowerer.compileForSink(
                          declaration.initializer,
                          annotated,
                      );
            this.emit(
                sharedDataBinding
                    ? { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<${this.dataTypes.cppType(annotated)}>(${initializerCpp})` }
                    : selfReferentialBinding
                      ? `(*${cppName}) = ${initializerCpp};`
                      : { kind: "declaration", type: this.dataTypes.cppType(annotated), name: cppName, initializer: initializerCpp },
            );
        }
        if (
            ts.isArrayLiteralExpression(initializer) &&
            ts.isIdentifier(name) &&
            isNeverResized(this.checker, name)
        ) {
            this.dataLowerer.registerFixedLength(
                boundCpp,
                initializer.elements.length,
            );
        }
        this.dataLowerer.registerLocal(
            boundCpp,
            (annotated.kind === "struct" &&
                this.dataTypes.isReferenceStruct(annotated.name)) ||
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
                const value = this.lookupOptional(property.name);
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
        const boundValue: Value = {
            kind: "data",
            cpp: boundCpp,
            ...((sharedDataBinding || selfReferentialBinding) ? { sharedStorageCpp: cppName } : {}),
            dataType: annotated,
            ...(annotated.kind === "struct" && initializerSnapshot?.kind === "record" &&
                ts.isIdentifier(name) && !mutablePlainObject
                ? { recordOwnKeys: Object.keys(initializerSnapshot.recordProperties ?? {}) }
                : annotated.kind === "enummap" && ts.isObjectLiteralExpression(initializer) &&
                    !this.identifierIsRebound(name)
                  ? { recordOwnKeys: Object.keys(Object.fromEntries(
                        this.dataLowerer.literalKeyOrder(initializer).map(key => [key, undefined]),
                    )) }
                : {}),
            // Shared storage does not change a selected object's presence.
            ...(ts.isConditionalExpression(initializer) && initializerSnapshot &&
                !this.identifierIsRebound(name) &&
                (initializerSnapshot.kind === "record" || initializerSnapshot.kind === "json-null" ||
                    initializerSnapshot.optionalFoundCpp === "true" || initializerSnapshot.optionalFoundCpp === "false")
                ? { optionalFoundCpp: initializerSnapshot.kind === "json-null" ? "false" :
                    initializerSnapshot.kind === "record" ? "true" : initializerSnapshot.optionalFoundCpp }
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
        if (selfReferentialBinding) {
            this.rebindVariable(name, boundValue);
        } else {
            this.defineVariable(name, boundValue);
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
            (name) => this.symbols.valueSymbol(name),
            {
                aliasingInitializer: (initializer, scan) => {
                    const value = this.unwrap(initializer);
                    if (scan.namesAlias(value)) return true;
                    const callee = ts.isCallExpression(value) ? this.unwrap(value.expression) : undefined;
                    const called = ts.isCallExpression(value)
                        ? callee && ts.isIdentifier(callee)
                            ? tryResolveFunctionDeclaration(this.checker, callee)
                            : this.checker.getResolvedSignature(value)?.declaration
                        : ts.isPropertyAccessExpression(value)
                            ? this.checker.getSymbolAtLocation(value.name)?.declarations?.find(ts.isGetAccessorDeclaration)
                            : undefined;
                    if ((!isSupportedFunction(called) && !(called && ts.isGetAccessorDeclaration(called))) ||
                        !called.body) return false;
                    const returnsArrayAlias = (expression: ts.Expression): boolean => {
                        if (!scan.containsAlias(expression)) return false;
                        const type = this.checker.getTypeAtLocation(expression);
                        return this.checker.isArrayType(type) || this.checker.isTupleType(type);
                    };
                    if (!ts.isBlock(called.body)) return returnsArrayAlias(called.body);
                    let aliases = false;
                    walkReachedLoopNodes(this, called.body, (node) => {
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
                        scan.namesAlias(this.unwrap(node.expression)) &&
                        node.argumentExpression
                    ) {
                        const index = this.resolveStaticExpression(
                            node.argumentExpression,
                        );
                        if (
                            !ts.isNumericLiteral(index) ||
                            !Number.isInteger(Number(index.text))
                        ) {
                            // Constant numeric tables already have a lazy native
                            // representation for runtime reads. Keep their literal
                            // values available to generation-time projections too.
                            const literal = this.constArrayLiteral(identifier);
                            if (literal && this.dataLowerer.isNumericTable(literal)) {
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
                        scan.namesAlias(this.unwrap(node.operand.expression))
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
                                this.unwrap(node.expression.expression),
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
                        (((ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
                            scan.containsAlias(node.right)) ||
                          (ts.isElementAccessExpression(node.left) &&
                            scan.namesAlias(
                                this.unwrap(node.left.expression),
                            )) ||
                            scan.namesAlias(this.unwrap(node.left)))
                    );
                },
            },
        );
    }

    private openRecordContainerIsMutated(identifier: ts.Identifier): boolean {
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) return false;
        let mutated = false;
        const directlyIndexes = (expression: ts.Expression): boolean =>
            (ts.isElementAccessExpression(expression) ||
                ts.isPropertyAccessExpression(expression)) &&
            this.unwrappedValueSymbol(expression.expression) === symbol;
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
            if (mutated) return "skip";
            if (
                isAssignmentExpression(node) &&
                directlyIndexes(node.left)
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
    private identifierIsRebound(identifier: ts.Identifier): boolean {
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
        ): boolean => {
            const root = rootIdentifier(expression, (inner) =>
                this.unwrap(inner),
            );
            return root !== undefined && scan.namesAlias(root);
        };
        return aliasedMutationScan(
            identifier,
            (name) => this.symbols.valueSymbol(name),
            {
                aliasingInitializer: (initializer, scan) =>
                    isAlias(scan, initializer),
                mutates: (node, scan) => {
                    if (ts.isVariableDeclaration(node) && node.type && node.initializer && scan.containsAlias(node.initializer)) {
                        const type = this.dataTypes.fromTsType(this.checker.getTypeFromTypeNode(node.type), node.type);
                        // A typed native array retains this object's identity,
                        // including when a later dynamic tuple read mutates it.
                        if (type?.kind === "vector" || type?.kind === "product") return true;
                    }
                    if (ts.isDeleteExpression(node) && isAlias(scan, node.expression)) return true;
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
                        (ts.isPropertyAccessExpression(node.left) ||
                            ts.isElementAccessExpression(node.left)) &&
                        isAlias(scan, node.left)
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
                    if (isStoringDataCall(node) && node.arguments?.some(scan.containsAlias)) return true;
                    if (ts.isCallExpression(node)) {
                        const retainedTarget = retainedNativeMutationTarget(this.symbols, node);
                        if (retainedTarget && isAlias(scan, retainedTarget)) {
                            // The retained writer mutates this object later.
                            // Choose its shared home before a typed alias can
                            // otherwise snapshot the compile-time record.
                            return true;
                        }
                        const called =
                            this.checker.getResolvedSignature(
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
                                    this.checker,
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
            this.fail(
                declaration,
                "Array destructuring requires an initializer.",
            );
        }
        const rawValue = this.compileValue(declaration.initializer);
        const value =
            rawValue.kind === "data"
                ? this.dataLowerer.narrowOptional(
                      rawValue,
                      declaration.initializer,
                  )
                : rawValue;
        const bindings = declaration.name.elements;
        const restIndex = bindings.findIndex(
            (element) => !ts.isOmittedExpression(element) && element.dotDotDotToken !== undefined,
        );
        const rest = restIndex >= 0 ? bindings[restIndex] : undefined;
        if (rest !== undefined && restIndex !== bindings.length - 1) {
            this.fail(rest, "A rest element must be the last binding.");
        }
        // `[first, ...rest]`: the rest takes an identifier, bound per arm
        // below to what follows the named bindings.
        const restName =
            rest !== undefined && !ts.isOmittedExpression(rest) && ts.isIdentifier(rest.name)
                ? rest.name
                : undefined;
        if (rest !== undefined && restName === undefined) {
            this.fail(rest, "A rest binding takes an identifier.");
        }
        const bindElement = (
            element: ts.ArrayBindingElement,
            present: Value | undefined,
        ): void => {
            if (ts.isOmittedExpression(element)) {
                return;
            }
            if (!ts.isIdentifier(element.name) || element.dotDotDotToken) {
                this.fail(
                    element,
                    "Tuple destructuring supports plain identifiers.",
                );
            }
            // A default applies exactly when the lane is undefined: past
            // the end of the tuple, or present as `undefined`.
            const bound =
                (!present || present.kind === "json-null") && element.initializer
                    ? this.compileValue(element.initializer)
                    : present;
            if (!bound) {
                this.fail(element, "The tuple has no element for this binding and it declares no default.");
            }
            let stored = bound;
            if (bound.kind === "record") {
                const declared = this.dataTypes.fromTsType(
                    this.checker.getTypeAtLocation(element.name),
                    element.name,
                );
                if (declared?.kind === "struct") {
                    const dataType =
                        this.dataTypes.markStoredObjectReferences(declared);
                    stored = this.dataLowerer.leafValue(
                        this.dataLowerer.compileKnownValueForSink(
                            bound,
                            dataType,
                            element.name,
                        ),
                        dataType,
                    );
                }
                if (stored.kind === "record") {
                    stored = this.materializeRecordScalars(
                        stored,
                        `record_${element.name.text}`,
                    );
                }
            }
            this.bindLocalValue(element.name, stored);
        };
        if (value.kind === "tuple" && value.tupleElements) {
            const elements = value.tupleElements;
            bindings.forEach((element, index) => {
                if (index === restIndex && restName) {
                    // The rest is the tuple of what follows.
                    this.bindLocalValue(restName, {
                        kind: "tuple",
                        cpp: "",
                        tupleElements: elements.slice(index),
                    });
                    return;
                }
                bindElement(element, elements[index]);
            });
            return;
        }
        if (value.dataType?.kind === "product") {
            const temporary = this.allocateTemporaryCppName("destructure_tuple");
            this.emit(`const auto ${temporary} = ${value.cpp};`);
            bindings.forEach((element, index) => {
                if (index === restIndex) this.fail(element, "Mixed tuple rest bindings require explicit lanes.");
                bindElement(element, this.dataLowerer.fixedTupleElement({ ...value, cpp: temporary }, index, element));
            });
            return;
        }
        // A runtime index into a static numeric table leaves one table
        // dimension. Its native row is the same Tuple<N> used by data tuples.
        const tupleArity = value.dataType?.kind === "tuple"
            ? value.dataType.arity
            : value.dataType?.kind === "table" && value.dataType.dimensions.length === 1
              ? value.dataType.dimensions[0]
              : undefined;
        if (value.kind === "data" && tupleArity !== undefined) {
            if (bindings.length > tupleArity) {
                this.fail(declaration.name,
                    `Tuple has ${tupleArity} elements, destructuring expects ${bindings.length}.`);
            }
            const temporary = this.bindDataTuple(value, tupleArity);
            bindings.forEach((element, index) => {
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
                this.allocateTemporaryCppName("destructure_vector");
            this.emit({ kind: "declaration", type: "const auto&", name: temporary, initializer: value.cpp });
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
                    // The rest is a fresh array of what follows.
                    const restType = { kind: "vector", element: elementType } as const;
                    const restCpp = this.cppIdentifier(restName.text);
                    this.reachJsData();
                    this.emit(
                        `${this.dataTypes.cppType(restType)} ${restCpp}(` +
                            `${temporary}.begin() + std::min<std::size_t>(${index}, ${temporary}.size()), ${temporary}.end());`,
                    );
                    this.defineVariable(restName, this.dataLowerer.leafValue(restCpp, restType));
                    this.dataLowerer.registerLocal(restCpp, "owned");
                    return;
                }
                if (element.initializer && ts.isIdentifier(element.name)) {
                    // A default stands in for a lane past the end.
                    const fallback = this.dataLowerer.compileForSink(element.initializer, elementType);
                    this.bindCopiedDefault(
                        element.name,
                        elementType,
                        `${temporary}.size() > ${index} ? ${temporary}[${index}] : ${fallback}`,
                    );
                    return;
                }
                bindElement(
                    element,
                    this.dataLowerer.readVectorBindingElement(
                        storedVector,
                        index,
                        declaration.initializer!,
                    ),
                );
            });
            return;
        }
        this.fail(
            declaration.initializer,
            "Array destructuring requires a tuple-producing initializer.",
        );
    }

    /**
     * A destructuring default as a binding: a copied local of `type`
     * holding `initializer`, the value the lane or field would have had.
     */
    private bindCopiedDefault(name: ts.Identifier, type: DataType, initializer: string): void {
        const cppName = this.cppIdentifier(name.text);
        this.reachJsData();
        this.emit(`${this.dataTypes.cppType(type)} ${cppName} = ${initializer};`);
        this.defineVariable(name, this.dataLowerer.leafValue(cppName, type));
        this.dataLowerer.registerLocal(cppName, "copy");
    }

    private emitObjectBindingDeclaration(
        declaration: ts.VariableDeclaration,
    ): void {
        if (
            !ts.isObjectBindingPattern(declaration.name) ||
            !declaration.initializer
        ) {
            this.fail(
                declaration,
                "Object destructuring requires an initializer.",
            );
        }
        const rawValue = this.compileValue(declaration.initializer);
        const value =
            rawValue.kind === "data"
                ? this.dataLowerer.narrowOptional(
                      rawValue,
                      declaration.initializer,
                  )
                : rawValue;
        this.bindObjectPattern(declaration.name, value, declaration.initializer);
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
            const temporary = this.allocateTemporaryCppName("destructure");
            this.emit({ kind: "declaration", type: "auto&&", name: temporary, initializer: value.cpp });
            for (const element of pattern.elements) {
                const { name, property } = this.bindingProperty(element);
                const field = this.dataTypes.structField(
                    value.dataType.name,
                    property,
                    element,
                );
                const storedFieldCpp = `${temporary}${this.dataTypes.isReferenceStruct(value.dataType.name) ? "->" : "."}${field.name}`;
                if (element.initializer && field.type.kind === "optional") {
                    // The default stands in for an absent optional field; the
                    // binding is then a value of the field's inner type.
                    const fallback = this.dataLowerer.compileForSink(element.initializer, field.type.inner);
                    this.bindCopiedDefault(
                        name,
                        field.type.inner,
                        `${storedFieldCpp}.has_value() ? *${storedFieldCpp} : ${fallback}`,
                    );
                    continue;
                }
                const cppName = this.cppIdentifier(name.text);
                // A default on a required field never applies: the field is
                // never undefined, so the binding is the field itself.
                const fieldCpp = storedFieldCpp;
                const aliases =
                    field.type.kind !== "number" &&
                    field.type.kind !== "boolean" &&
                    field.type.kind !== "string" &&
                    field.type.kind !== "enum" &&
                    field.type.kind !== "handle";
                this.emit(
                    `${this.dataTypes.cppType(field.type)}${aliases ? "&" : ""} ${cppName} = ${fieldCpp};`,
                );
                const fieldValue = this.dataLowerer.leafValue(
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
                    fieldValue.collectionCardinality = staticField.collectionCardinality;
                }
                this.defineVariable(name, fieldValue);
                if (aliases) {
                    this.dataLowerer.registerAlias(cppName, fieldCpp);
                }
            }
            return;
        }
        if (value.kind === "physics-aggregate") {
            const temporary = this.allocateTemporaryCppName("destructure");
            this.emit({ kind: "declaration", type: "const auto", name: temporary, initializer: value.cpp });
            for (const element of pattern.elements) {
                if (element.initializer) {
                    this.fail(
                        element,
                        "Default values in physics aggregate destructuring are not supported.",
                    );
                }
                const { name, property } = this.bindingProperty(element);
                const propertyValue =
                    readProperty(
                        this,
                        { ...value, cpp: temporary },
                        property,
                        element,
                    ) ??
                    this.fail(
                        element,
                        `Unsupported physics aggregate property '${property}'.`,
                    );
                const cppName = this.allocateTemporaryCppName(
                    `class_field_${name.text}`,
                );
                this.emit({ kind: "declaration", type: "const auto", name: cppName, initializer: propertyValue.cpp });
                this.defineVariable(name, {
                    ...propertyValue,
                    cpp: cppName,
                });
            }
            return;
        }
        if (value.kind !== "render-target-texture") {
            this.fail(
                source,
                `Object destructuring is not supported for ${value.kind}.`,
            );
        }
        const temporary = this.allocateTemporaryCppName("destructure");
        this.emit({ kind: "declaration", type: "auto", name: temporary, initializer: value.cpp });
        for (const element of pattern.elements) {
            const { name, property } = this.bindingProperty(element);
            const cppName = this.allocateTemporaryCppName(
                `class_field_${name.text}`,
            );
            // The same properties `rtt.rt` and `rtt.texture` name, read
            // off the temporary the destructuring bound.
            const propertyValue =
                readProperty(
                    this,
                    { ...value, cpp: temporary },
                    property,
                    element,
                ) ??
                this.fail(
                    element,
                    `Unsupported render-target texture property '${property}'.`,
                );
            this.emit({ kind: "declaration", type: "auto", name: cppName, initializer: propertyValue.cpp });
            this.defineVariable(name, {
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
            this.fail(
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
                    this.fail(element, "A rest binding takes an identifier.");
                }
                const remaining = Object.fromEntries(
                    Object.entries(value.recordProperties ?? {}).filter(([key]) => !consumed.has(key)),
                );
                this.defineVariable(element.name, { kind: "record", cpp: "", recordProperties: remaining });
                continue;
            }
            const { name, property } = this.bindingProperty(element);
            consumed.add(property);
            const present = value.recordProperties?.[property];
            // A default applies exactly when the property is undefined:
            // absent from the record, or present as `undefined`.
            const propertyValue =
                (!present || present.kind === "json-null") && element.initializer
                    ? this.compileValue(element.initializer)
                    : present;
            if (!propertyValue) {
                this.fail(element, `Record has no property '${property}'.`);
            }
            if (propertyValue.kind !== "number") {
                // Compile-time records and resource handles already carry
                // their native expressions. Destructuring aliases the same
                // value just as an ordinary identifier binding does; only a
                // numeric property needs distinct mutable local storage.
                this.defineVariable(name, propertyValue);
                continue;
            }
            const cppName = this.cppIdentifier(name.text);
            this.emit(
                { kind: "declaration", type: "double", name: cppName, initializer: propertyValue.cpp, attributes: "[[maybe_unused]] " },
            );
            this.defineVariable(name, {
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

    /**
     * `value instanceof LocalClass` is decided at generation: a class
     * instance is a compile-time record that names its class, and a struct
     * stored in data names the class it was mapped from. A value that could
     * be an instance of several classes has no representation yet.
     */
    private compileClassInstanceOf(
        expression: ts.BinaryExpression,
        className: ts.Identifier,
    ): string | undefined {
        const symbol = this.symbols.valueSymbol(className);
        const declaration = symbol?.valueDeclaration;
        if (!declaration || !ts.isClassDeclaration(declaration)) {
            return undefined;
        }
        const value = this.compileValue(expression.left);
        if (value.kind === "record" && value.classDeclaration) {
            return value.classDeclaration === declaration ? "true" : "false";
        }
        if (value.kind === "data" && value.dataType?.kind === "struct") {
            const classType = this.dataTypes.fromTsType(
                this.checker.getDeclaredTypeOfSymbol(symbol),
                expression,
            );
            if (classType?.kind === "struct") {
                return classType.name === value.dataType.name ? "true" : "false";
            }
        }
        if (
            value.kind === "json-null" ||
            value.kind === "number" ||
            value.kind === "string" ||
            value.kind === "boolean" ||
            value.kind === "tuple" ||
            (value.kind === "data" &&
                value.dataType !== undefined &&
                value.dataType.kind !== "struct" &&
                value.dataType.kind !== "optional")
        ) {
            // A scalar, a tuple, a collection: never an instance.
            return "false";
        }
        this.fail(
            expression,
            `'instanceof ${className.text}' is decided for class instances and structs; this value's class is not represented.`,
        );
    }

    public emitLogicalAssignment(expression: ts.BinaryExpression): void {
        this.dataLowerer.emitLogicalAssignment(expression);
    }

    public emitDelete(expression: ts.DeleteExpression): void {
        this.dataLowerer.emitDelete(expression);
    }

    public emitAssignment(expression: ts.BinaryExpression): void {
        this.checkNodeGeometryMutation(expression);
        const input = this.compileNodeInputMutation(expression);
        if (input) { this.emitDiscardedValue(input); return; }
        const text = this.compileTextMutation(expression);
        if (text) { this.emitDiscardedValue(text); return; }
        if (this.compileCameraMutation(expression)) return;
        if (emitCanvasAssignment(this, expression)) return;
        if (this.options.workers && this.emitUiPropertyAssignment(expression)) return;
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
        const binding = left && ts.isIdentifier(left) ? this.lookupOptional(left) : undefined;
        const previous = binding ?? target;
        const previousState = previous.collectionCardinality ?? previous.staticElementsOwner?.collectionCardinality;
        const sourceValue = this.knownValueWithoutEvaluation(source);
        const sourceState = sourceValue?.collectionCardinality ?? sourceValue?.staticElementsOwner?.collectionCardinality;
        const right = this.unwrap(source);
        const nativeConstructor = ts.isNewExpression(right) &&
            ts.isIdentifier(right.expression) && this.isDefaultLibraryIdentifier(right.expression);
        const fresh = kind === "vector"
            ? ts.isArrayLiteralExpression(right) ||
                (nativeConstructor && right.expression.text === "Array")
            : nativeConstructor && right.expression.text === (kind === "map" ? "Map" : "Set");
        const literalCount = ts.isArrayLiteralExpression(right)
            ? this.knownCollectionCardinality(right)
            : undefined;
        const definite = !this.isInRuntimeControlFlow() && !this.isInRuntimeIteration() &&
            this.frameCallbackDepth === 0 && !this.isInNativeFunctionBody() &&
            !previous.sharedStorageCpp;
        const template = sourceValue?.runtimeElementTemplate;
        const sourceElements = sourceValue?.staticElementsOwner?.staticElements ?? sourceValue?.staticElements;
        const sourceOwner = sourceValue?.staticElementsOwner ?? sourceValue;
        if (binding && sourceState && previousState === sourceState) {
            target.collectionCardinality = sourceState;
            binding.collectionCardinality = sourceState;
            return;
        }
        if (sourceValue?.kind === "tuple" && !fresh) {
            this.fail(source, "Assigning an array alias requires native collection storage.");
        }
        let tainted = false;
        const taint = (state: CollectionCardinality | undefined): void => {
            if (!state) return;
            tainted = true;
            state.untrackedAliases = true;
            state.count = undefined;
            delete state.keys;
        };
        if (!definite) taint(previousState);
        if (!sourceState && !fresh) {
            for (const state of this.collectionCardinalities) {
                if (state.kind === (kind === "vector" ? "array" : "keyed")) taint(state);
            }
        } else if (!definite || !binding) {
            taint(sourceState);
        }
        if (tainted) {
            this.visitScopedValues((value) => {
                const state = value.collectionCardinality ?? value.staticElementsOwner?.collectionCardinality;
                if (state?.untrackedAliases) {
                    delete value.staticElements;
                    delete value.staticElementsOwner;
                    delete value.runtimeElementTemplate;
                }
            });
        }
        const owner = previous.staticElementsOwner ?? previous;
        if (owner === previous || owner === target) this.invalidateStaticElements(previous, true);
        for (const value of new EmissionSet([target, previous])) {
            delete value.staticElements;
            delete value.staticElementsOwner;
            delete value.runtimeElementTemplate;
            delete value.collectionCardinality;
        }
        let state: CollectionCardinality;
        if (definite && binding && sourceState) {
            state = sourceState;
            if (!state.untrackedAliases && sourceElements && sourceOwner) {
                binding.staticElements = sourceElements;
                binding.staticElementsOwner = sourceOwner;
            }
            if (!state.untrackedAliases && template) binding.runtimeElementTemplate = template;
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
                        if (length !== undefined && Number.isSafeInteger(length) && length >= 0) count = length;
                    }
                }
            }
            state = {
                kind: kind === "vector" ? "array" : "keyed",
                count,
                ...(kind !== "vector" && count === 0 ? { keys: new EmissionSet<string | number | boolean>() } : {}),
                createdIn: [...this.parameterizedResourceIterations],
                varyingIn: new EmissionSet(),
                ...(!definite || !binding || !fresh ? { untrackedAliases: true as const } : {}),
            };
        }
        this.collectionCardinalities.add(state);
        target.collectionCardinality = state;
        if (binding) binding.collectionCardinality = state;
    }

    public recordDataAssignmentMetadata(
        target: Value,
        source: ts.Expression,
        destination?: ts.Expression,
    ): boolean {
        const dataType = target.dataType;
        const storedType =
            dataType?.kind === "optional" ? dataType.inner : dataType;
        if (storedType?.kind === "vector" || storedType?.kind === "map" || storedType?.kind === "set") {
            this.recordCollectionAssignment(target, source, destination, storedType.kind);
            return true;
        }
        if (
            storedType?.kind !== "handle" ||
            storedType.handle !== "ui-element"
        ) {
            return false;
        }
        const tag =
            this.ui.uiCreationTag(source) ?? this.ui.uiCreatedElementTag(source);
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
        target.uiTag = tag;
        if (staticId !== undefined) {
            target.uiStaticId = staticId;
        }
        return false;
    }

    /** Whether an expression is already known to produce retained UI state. */
    public isNativeUiValueExpression(expression: ts.Expression): boolean {
        return this.ui.isNativeUiValueExpression(expression);
    }

    /** The text driver records text layers only, so mixed contexts require an explicit boundary. */
    private refuseMixedStandaloneTextContexts(): void {
        if (!this.reachedRenderContextRegistrations.has("registerTextRenderer")) return;
        const incompatible = ([
            ["registerScene", "renderer:scene"], ["registerSpriteRenderer", "renderer:sprite"],
            ["registerFrameGraphContext", "renderer:frame-graph"], ["registerEffectRenderer", "renderer:effect"],
        ] as const).filter(([name]) => this.reachedRenderContextRegistrations.has(name)).map(([, feature]) => feature);
        if (incompatible.length === 0) return;
        this.failAtFile(
            "Standalone text rendering cannot be combined with other reached rendering contexts: " +
                incompatible.join(", ") + ". The native text driver does not preserve mixed context registration order.",
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
        return this.ui.emitUiPropertyAssignment(expression);
    }

    public compileValue(expression: ts.Expression): Value {
        this.checkNodeGeometryMutation(expression);
        const boundary = this.nextNativeBindingSequence;
        const dependencies = new EmissionSet<NativeCaptureBinding>();
        this.nativeDependencyStack.push(dependencies);
        let value: Value;
        try {
            const unwrapped = this.unwrap(expression);
            const importedText = ts.isPropertyAccessExpression(unwrapped) ? compileTextModuleValue(this, unwrapped) : undefined;
            value = importedText ?? this.compileNodeInputMutation(expression) ?? this.compileTextMutation(expression) ?? this.compileCameraMutation(expression) ?? this.compileWorkerValue(expression) ?? this.expressions.compileValue(expression);
        } finally {
            this.nativeDependencyStack.pop();
        }
        if (value.kind === "text-vector" && (ts.isConditionalExpression(this.unwrap(expression)) || ts.isBinaryExpression(this.unwrap(expression)))) {
            this.fail(expression, "Conditional text transform objects require a runtime vector identity carrier; select the renderable before reading its transform.");
        }
        if (this.options.workers && value.kind === "boolean" && (value.cpp === "true" || value.cpp === "false")) {
            value = { ...value, staticBoolean: value.cpp === "true" };
        }
        // CSG values retain materialized geometry plans, not the native mesh
        // handles read while producing them. A later consumer can therefore
        // use the plan from a hoisted cleanup without capturing those locals.
        const geometryPlan = value.kind === "csg-solid" || value.kind === "csg2-solid";
        const retained = new EmissionSet(value.nativeCaptures);
        if (!geometryPlan) {
            for (const binding of dependencies) {
                if (binding.sequence <= boundary) retained.add(binding);
            }
        }
        if (retained.size && !this.nativeStoredValues.has(value)) value.nativeCaptures = [...retained];
        if (this.options.workers && value.engineCpp) {
            if (value.kind === "engine" && value.ownedEngineCpp) {
                const owner = this.nativeBindings.get(value.ownedEngineCpp);
                if (owner) this.realmEngineCaptures.set(value.engineCpp, [owner]);
            }
            const owners = this.realmEngineCaptures.get(value.engineCpp);
            if (owners) value.nativeCompanionCaptures = { ...value.nativeCompanionCaptures, engineCpp: owners };
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

    public withOwnedCallbackBody<T>(body: () => T): T {
        this.frameCallbackDepth++;
        try { return body(); }
        finally { this.frameCallbackDepth--; }
    }

    public isNativeWorkerExpression(expression: ts.Expression): boolean {
        return isNativeWorkerExpression(this, expression);
    }

    public workerCheckpointCpp(): string | undefined {
        return this.options.workers ? "bbl::pal::EventLoop::current().checkpoint()" : undefined;
    }

    public workerAbortCpp(): string | undefined {
        return this.options.workers ? "bbl::pal::EventLoop::current().aborting()" : undefined;
    }

    public compileAsyncEngineStart(engine: Value, node: ts.Node): Value | undefined {
        if (!this.options.workers) return undefined;
        if (!engine.ownedEngineCpp) this.fail(node, "Asynchronous engine startup requires an owned engine.");
        return { kind: "promise", cpp: `bbl::pal::start_realm_engine(${engine.ownedEngineCpp})`,
            promiseResult: { kind: "void", cpp: "" }, promiseType: "bbl::js::PromiseVoid" };
    }

    public compileWorkerCallback(expression: ts.Expression, event: "message" | "error"): string {
        const name = this.allocateTemporaryCppName("worker_event");
        const type = event === "message" ? "const bbl::pal::WorkerMessage&" : "bbl::pal::WorkerErrorEvent&";
        const callback = this.compilePlatformCallback(expression, { name, cppType: type },
            [{ kind: event === "message" ? "worker-message-event" : "worker-error-event", cpp: name }]);
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
                ? this.lookupOptional(unwrapped)?.staticStrings
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
        if (this.knownValueWithoutEvaluation(expression)?.collectionCardinality?.untrackedAliases) return undefined;
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

    /** The complete chained property path containing a failed sub-read. */
    private propertyPathForDiagnostic(
        expression: ts.PropertyAccessExpression,
    ): string {
        let path: ts.Expression = expression;
        while (
            path.parent &&
            ts.isPropertyAccessExpression(path.parent) &&
            this.unwrap(path.parent.expression) === path
        ) {
            path = path.parent;
        }
        return path.getText();
    }

    public compilePropertyAccess(
        expression: ts.PropertyAccessExpression,
    ): Value {
        const environment = browserEnvironmentPropertyValue(this, expression);
        if (environment) return environment;
        const deployed = browserDeploymentValue(this, expression);
        if (deployed === null) return {kind:"json-null", cpp:"std::nullopt"};
        if (typeof deployed === "boolean") return {kind:"boolean", cpp:deployed ? "true" : "false", staticBoolean:deployed};
        if (deployed !== undefined) return { kind: "string", cpp: this.cppString(deployed), staticString: deployed };
        const dataset = this.ui.primaryCanvasDataset(expression);
        if (dataset) return { kind: "string", cpp: `bbl::canvas_dataset(${this.requireDefaultEngine(expression)}, ${this.cppString(dataset)})`, dataType: { kind: "string" } };
        const canvas = compileCanvasValue(this, expression);
        if (canvas) return canvas;
        if (
            expression.name.text === "activeElement" &&
            ts.isIdentifier(expression.expression) &&
            expression.expression.text === "document" &&
            this.isDefaultLibraryIdentifier(expression.expression)
        ) {
            const engine = this.requireDefaultEngine(expression);
            this.reachFeature("ui:rml", expression);
            return {
                kind: "ui-element",
                cpp: `bbl::ui_active_element(${engine})`,
                engineCpp: engine,
                dataType: { kind: "handle", handle: "ui-element" },
            };
        }
        if (
            expression.questionDotToken &&
            expression.name.text === "direction" &&
            ts.isPropertyAccessExpression(this.unwrap(expression.expression))
        ) {
            const ray = this.unwrap(
                expression.expression,
            ) as ts.PropertyAccessExpression;
            if (ray.name.text === "ray") {
                const pick = this.compileValue(ray.expression);
                if (pick.kind === "picking-info") {
                    // `pickAsync` is only lowered in its pinned BASIC mode.
                    // Upstream sets `info.ray = null` in that mode, so the
                    // optional access is exactly the nullish left operand.
                    return { kind: "json-null", cpp: "std::nullopt" };
                }
            }
        }
        const ownerExpression = this.unwrap(expression.expression);
        const enumMember = this.enumMemberValue(expression);
        if (enumMember) {
            return enumMember;
        }
        if (ts.isNewExpression(ownerExpression)) {
            // `new C().member`: the temporary instance is a record like
            // any other, read once here.
            const instance = this.compileValue(ownerExpression);
            if (instance.kind === "record") {
                const accessor = instance.recordGetters?.[expression.name.text];
                const member = accessor
                    ? this.compileRecordGetter(instance, accessor)
                    : instance.recordProperties?.[expression.name.text];
                if (member) {
                    return member;
                }
            }
        }
        const staticField = this.classLowerer.resolveStaticField(expression);
        if (staticField?.initializer) {
            return this.compileValue(staticField.initializer);
        }
        if (
            ts.isPropertyAccessExpression(ownerExpression) &&
            ownerExpression.name.text === "style"
        ) {
            const element = this.ui.uiElementValue(ownerExpression.expression);
            if (element) {
                const engine = this.requireEngine(element, expression);
                const property = this.ui.nativeUiStyleProperty(
                    expression.name.text,
                );
                this.ui.auditUiStylePropertyName(property, expression.name);
                return {
                    kind: "string",
                    cpp: `bbl::ui_get_style_property(${engine}, ${element.cpp}, ${this.cppString(property)})`,
                };
            }
        }
        if (
            (expression.name.text === "body" ||
                expression.name.text === "head") &&
            ts.isIdentifier(ownerExpression) &&
            ownerExpression.text === "document" &&
            this.isDefaultLibraryIdentifier(ownerExpression)
        ) {
            return {
                kind: "ui-element",
                cpp: "",
                uiRoot: true,
                truthinessCpp: "true",
            };
        }
        if (
            expression.name.text === "hidden" &&
            ts.isIdentifier(ownerExpression) &&
            ownerExpression.text === "document" &&
            this.isDefaultLibraryIdentifier(ownerExpression) &&
            this.platformDocumentHiddenCpp !== undefined
        ) {
            return {
                kind: "boolean",
                cpp: this.platformDocumentHiddenCpp,
            };
        }
        if (
            ts.isIdentifier(ownerExpression) &&
            ownerExpression.text === "window" &&
            this.isDefaultLibraryIdentifier(ownerExpression) &&
            (expression.name.text === "innerWidth" ||
                expression.name.text === "innerHeight")
        ) {
            const property =
                expression.name.text === "innerWidth" ? "width" : "height";
            return {
                kind: "number",
                cpp:
                    `static_cast<double>(${this.requireDefaultEngine(expression)}` +
                    `.options.${property})`,
                dataType: { kind: "number" },
            };
        }
        if (ownerExpression.kind === ts.SyntaxKind.ThisKeyword) {
            // Field reads resolve through the instance record the
            // constructor built.
            const instance = this.compileValue(ownerExpression);
            const field = instance.recordProperties?.[expression.name.text];
            if (!field) {
                const accessor = instance.recordGetters?.[expression.name.text];
                if (accessor) {
                    return this.compileRecordGetter(instance, accessor);
                }
                this.fail(
                    expression,
                    `Field '${expression.name.text}' is not assigned before this read ` +
                        `(class ${instance.classDeclaration?.name?.text ?? "unknown"}; ` +
                        `fields ${Object.keys(instance.recordProperties ?? {}).join(", ") || "none"}).`,
                );
            }
            return field;
        }
        if (
            !ts.isIdentifier(ownerExpression) &&
            !ts.isPropertyAccessExpression(ownerExpression) &&
            !ts.isElementAccessExpression(ownerExpression) &&
            !ts.isCallExpression(ownerExpression) &&
            !ts.isStringLiteralLike(ownerExpression)
        ) {
            this.fail(
                expression,
                `Unsupported property value '${this.propertyPathForDiagnostic(expression)}'.`,
            );
        }
        if (
            expression.name.text === "className" &&
            this.isCanvasElement(ownerExpression) &&
            !this.ui.uiElementValue(ownerExpression)
        ) {
            // The generated host's primary renderCanvas has no class
            // attribute. Keep that browser fact available to multi-surface
            // code which mirrors its class onto an auxiliary canvas.
            return {
                kind: "string",
                cpp: this.cppString(""),
                staticString: "",
                dataType: { kind: "string" },
            };
        }
        // Through compileValue rather than lookup: a module-level
        // constant is never bound in a variable scope, so it resolves
        // through its own initializer the way an entry-scope constant
        // resolves through its binding, and a property-access owner
        // resolves by recursing here, so `camera.ortho.halfHeight` reads
        // as the path it is written as. Unknown identifiers still fail
        // in lookup at the end of that chain, and an owner that is
        // itself unsupported fails naming the sub-path that failed.
        const compiledOwner = this.compileValue(ownerExpression);
        const rawOwner = this.presentationHostCpp &&
            compiledOwner.browserValue?.kind === "object" &&
            compiledOwner.browserValue.primaryCanvas
            ? this.ui.primaryPresentationCanvas(ownerExpression)
            : compiledOwner;
        // A shared class instance read back out of a container is a `Ref`
        // with no compile-time shape of its own. Hydrating it here is what
        // gives the ordinary record path its fields, getters and setters,
        // so `part.locked` and `part.size` read the same way whether the
        // receiver was just constructed or came out of an array.
        const owner = this.classLowerer.hydrate(rawOwner) ?? rawOwner;
        const httpProperty = httpResponseProperty(this.dataLowerer, owner, expression.name.text);
        if (httpProperty) return httpProperty;
        if (owner.kind === "json-null" && (expression.questionDotToken ||
            (ts.isOptionalChain(expression) && owner.optionalChainShortCircuited))) {
            return {kind:"json-null", cpp:"std::nullopt", optionalChainShortCircuited:true};
        }
        const property = expression.name.text;
        if (owner.kind === "physics-viewer" && property === "scene") {
            return { kind: "scene", cpp: `(${owner.cpp})->scene`,
                ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}) };
        }
        if (owner.kind === "scene" && property === "_envTextures") {
            this.reachFeature("engine:device-recovery", expression);
            return { kind: "gpu-environment", cpp: `bbl::environment_identity(${owner.cpp})`, engineCpp: this.requireEngine(owner, expression), dataType: { kind: "handle", handle: "gpu-environment" }, impure: true };
        }
        if (owner.kind === "gpu-environment" && property === "specularCube") {
            return { kind: "gpu-texture", cpp: `bbl::environment_texture_identity(${owner.cpp})`, engineCpp: this.requireEngine(owner, expression), dataType: { kind: "handle", handle: "gpu-texture" }, impure: true };
        }
        if (owner.kind === "engine" && property === "_pbrFallbackTex") {
            this.reachFeature("engine:device-recovery", expression);
            return { kind: "record", cpp: "", recordProperties: { texture: { kind: "gpu-texture", cpp: `bbl::fallback_texture_identity(${owner.cpp})`, engineCpp: owner.cpp, dataType: { kind: "handle", handle: "gpu-texture" }, impure: true } } };
        }
        if (owner.kind === "shadow-generator" && property === "_depthTexture") {
            this.reachFeature("engine:device-recovery", expression);
            return { kind: "gpu-texture", cpp: `bbl::shadow_texture_identity(${this.requireEngine(owner, expression)}, ${owner.cpp})`, engineCpp: this.requireEngine(owner, expression), dataType: { kind: "handle", handle: "gpu-texture" }, impure: true };
        }
        if (owner.kind === "scene" && property === "_renderables") {
            this.reachFeature("engine:device-recovery", expression);
            return { kind: "record", cpp: "", recordProperties: { length: { kind: "number", cpp: `bbl::scene_renderable_count(${owner.cpp})`, impure: true } } };
        }
        if (owner.kind === "engine" && property === "drawCallCount") {
            this.reachFeature("engine:device-recovery", expression);
            return { kind: "number", cpp: `${owner.cpp}.draw_call_count` };
        }
        if (owner.kind === "ui-element" && property === "dataset") {
            return { ...owner, uiDataset: true };
        }
        if (owner.kind === "ui-element" && !owner.uiDataset) {
            const attribute = this.ui.booleanAttribute(owner, property, expression);
            if (attribute) return {kind:"boolean", cpp:`bbl::ui_has_attribute(${this.requireEngine(owner, expression)}, ${owner.cpp}, ${this.cppString(attribute)})`, impure:true};
        }
        if (owner.kind === "ui-element" && property === "value" && (owner.uiTag === "textarea" || owner.uiTag === "input") && !owner.uiFileInput) {
            return { kind: "string", cpp: `bbl::ui_get_form_value(${this.requireEngine(owner, expression)}, ${owner.cpp})`,
                dataType: { kind: "string" }, freshData: true };
        }
        if (owner.kind === "ui-element" && owner.uiDataset) {
            const dataName = property.replace(
                /[A-Z]/g,
                (letter) => `-${letter.toLowerCase()}`,
            );
            const engine = this.requireEngine(owner, expression);
            return {
                kind: "string",
                cpp:
                    `bbl::ui_get_attribute(${engine}, ${owner.cpp}, ` +
                    `${this.cppString(`data-${dataName}`)})`,
                dataType: { kind: "string" },
                engineCpp: engine,
            };
        }
        if (
            owner.kind === "animation-group" &&
            owner.animationGroupSource === "property"
        ) {
            if (property === "loopAnimation" || property === "isPlaying") {
                return {
                    kind: "boolean",
                    cpp:
                        `${owner.cpp}->` +
                        (property === "loopAnimation" ? "loop" : "playing"),
                    dataType: { kind: "boolean" },
                };
            }
            const field = {
                currentTime: "current_time",
                speedRatio: "speed_ratio",
                weight: "weight",
            }[property];
            if (field) {
                return {
                    kind: "number",
                    cpp: `${owner.cpp}->${field}`,
                    dataType: { kind: "number" },
                };
            }
        }
        const browserFileProperty = compileBrowserFileProperty(
            this,
            owner,
            expression,
        );
        if (browserFileProperty) {
            return browserFileProperty;
        }
        const ownerTsType = this.checker.getTypeAtLocation(ownerExpression);
        const ownerTsMembers =
            (ownerTsType.flags & ts.TypeFlags.Union) !== 0
                ? (ownerTsType as ts.UnionType).types
                : [ownerTsType];
        const sourceIsCanvas = ownerTsMembers.some(
            (member) =>
                member.getSymbol()?.getName() === "HTMLCanvasElement" ||
                member.getSymbol()?.getName() === "OffscreenCanvas",
        );
        if (
            owner.kind === "ui-element" &&
            (owner.uiCanvas || sourceIsCanvas) &&
            !owner.uiCanvasContext &&
            (property === "width" || property === "height")
        ) {
            const engine = this.requireEngine(owner, expression);
            return {
                kind: "number",
                cpp: `bbl::ui_canvas_${property}(${engine}, ${owner.cpp})`,
                dataType: { kind: "number" },
            };
        }
        if (owner.kind === "picking-info" && property === "ray") {
            // Basic GPU picks publish a null ray; only the detailed pipeline
            // carries one. Keeping that null in the value model lets the
            // source's optional chain and fallback lower unchanged.
            return { kind: "json-null", cpp: "std::nullopt" };
        }
        if (owner.platformEventBase) {
            this.fail(
                expression.name,
                `Borrowed DOM Event values do not expose '${property}'; only preventDefault is supported on the base Event view.`,
            );
        }
        if (owner.kind === "platform-keyboard-event") {
            const field = KEY_EVENT_FIELDS.get(property);
            if (field) {
                return {
                    kind: "boolean",
                    cpp: `${owner.cpp}.${field}`,
                };
            }
            if (property === "code") {
                return {
                    kind: "data",
                    cpp: `${owner.cpp}.code`,
                    dataType: { kind: "string" },
                    readOnly: true,
                };
            }
            if (property === "key") {
                return {
                    kind: "data",
                    cpp: `${owner.cpp}.key`,
                    dataType: { kind: "string" },
                    readOnly: true,
                };
            }
            this.fail(
                expression.name,
                `Platform keyboard events do not expose '${property}'.`,
            );
        }
        if (owner.kind === "platform-mouse-event") {
            if (
                property === "button" ||
                property === "buttons" ||
                property === "clientX" ||
                property === "clientY" ||
                property === "offsetX" ||
                property === "offsetY" ||
                property === "movementX" ||
                property === "movementY" ||
                property === "deltaY" ||
                property === "pointerId"
            ) {
                return {
                    kind: "number",
                    cpp:
                        property === "pointerId"
                            ? "0.0"
                            : property === "button"
                              ? `${owner.cpp}.button`
                              : property === "buttons"
                                ? `${owner.cpp}.buttons`
                                : property === "clientX" ||
                                    property === "offsetX"
                                  ? `${owner.cpp}.client_x`
                                  : property === "clientY" ||
                                      property === "offsetY"
                                    ? `${owner.cpp}.client_y`
                                    : property === "movementX"
                                      ? `${owner.cpp}.movement_x`
                                      : property === "movementY"
                                        ? `${owner.cpp}.movement_y`
                                        : `${owner.cpp}.delta_y`,
                    dataType: { kind: "number" },
                };
            }
            this.fail(
                expression.name,
                `Platform mouse events do not expose '${property}'.`,
            );
        }
        if (
            owner.kind === "browser" &&
            owner.browserValue?.kind === "dom-rect" &&
            (property === "left" ||
                property === "top" ||
                property === "width" ||
                property === "height")
        ) {
            const axis =
                property === "width" || property === "height"
                    ? property
                    : undefined;
            return {
                kind: "number",
                cpp: axis
                    ? `static_cast<double>(${this.requireDefaultEngine(expression)}.options.${axis})`
                    : "0.0",
                ...(axis ? {} : { staticNumber: 0 }),
                dataType: { kind: "number" },
            };
        }
        const fetchedProperty = staticFetchProperty(owner, property);
        if (fetchedProperty) return fetchedProperty;
        if (owner.kind === "regexp" && property === "lastIndex") {
            return {
                kind: "number",
                cpp: `${owner.cpp}.last_index`,
            };
        }
        if (
            owner.kind === "texture" &&
            (property === "width" || property === "height")
        ) {
            let size =
                property === "width" ? owner.textureWidth : owner.textureHeight;
            if (
                size === undefined &&
                owner.textureFile?.source &&
                owner.textureFile.entryFileName
            ) {
                const dimensions = readPngDimensionsSync(
                    owner.textureFile.source,
                    owner.textureFile.entryFileName,
                );
                if (dimensions) {
                    owner.textureWidth = dimensions.width;
                    owner.textureHeight = dimensions.height;
                    size =
                        property === "width"
                            ? dimensions.width
                            : dimensions.height;
                }
            }
            if (size === undefined) {
                if (owner.textureStorage === "file") {
                    return {
                        kind: "number",
                        cpp: `static_cast<double>(${owner.cpp}.${property})`,
                        dataType: { kind: "number" },
                    };
                }
                this.fail(
                    expression,
                    `Texture ${property} requires a PNG source with generation-known dimensions.`,
                );
            }
            return {
                kind: "number",
                cpp: doubleLiteral(size),
                staticNumber: size,
            };
        }
        if (owner.kind === "sprite-renderer" && property === "layers") {
            const engine = this.requireEngine(owner, expression);
            return {
                kind: "data",
                cpp:
                    `${engine}.sprite_renderers.at(` +
                    `static_cast<std::size_t>(${owner.cpp}.value)).layers`,
                dataType: {
                    kind: "vector",
                    element: {
                        kind: "handle",
                        handle: "sprite-layer",
                    },
                },
                borrowedData: true,
                nativeVectorData: true,
                engineCpp: engine,
            };
        }
        if (owner.kind === "record") {
            const accessor = owner.recordGetters?.[property];
            const value = accessor
                ? this.compileRecordGetter(owner, accessor)
                : owner.recordProperties?.[property];
            if (!value) {
                const method = owner.recordMethods?.[property];
                if (method) {
                    return {
                        kind: "callback",
                        cpp: "",
                        callbackDeclaration: method,
                        callbackRecordOwner: owner,
                    };
                }
                const declared = this.dataLowerer.dataTypeAt(expression);
                const declaredTsType =
                    this.checker.getTypeAtLocation(expression);
                const declaredMembers = declaredTsType.isUnion()
                    ? declaredTsType.types
                    : [declaredTsType];
                const optionalProperty = this.checker.getTypeAtLocation(expression.expression).getProperty(property);
                if (
                    declared?.kind === "optional" ||
                    (optionalProperty !== undefined && (optionalProperty.flags & ts.SymbolFlags.Optional) !== 0) ||
                    (declared?.kind === "function" &&
                        declaredMembers.some(
                            (member) =>
                                (member.flags &
                                    (ts.TypeFlags.Null |
                                        ts.TypeFlags.Undefined)) !==
                                0,
                        ))
                ) {
                    // Object literals omit optional fields entirely. A
                    // compile-time record preserves that absence as the
                    // nullish value consumed by `??` and equality guards.
                    return { kind: "json-null", cpp: "" };
                }
                this.fail(
                    expression,
                    `Static record has no property '${property}' ` +
                        `(fields: ${Object.keys(owner.recordProperties ?? {}).join(", ") || "none"}; ` +
                        `getters: ${Object.keys(owner.recordGetters ?? {}).join(", ") || "none"}; ` +
                        `class: ${owner.classDeclaration?.name?.text ?? "none"}).`,
                );
            }
            return this.propertyWithOwnerPresence(owner, value, expression);
        }
        // `baked.clips`: the bake's own row map. It carries the bake and
        // nothing else, so the name lookup that follows is the native row
        // read rather than a generation-time table.
        if (owner.kind === "vat-bake" && property === "clips") {
            return {
                kind: "vat-clip-map",
                cpp: owner.cpp,
                ...(owner.engineCpp !== undefined
                    ? { engineCpp: owner.engineCpp }
                    : {}),
            };
        }
        // A container's own handle collection, read without the `?? []`
        // guard the nullish resolver already claims. Asked before the
        // failure below rather than in `readOwnerProperty`, because the
        // collection concept resolves the owner itself.
        if (
            owner.kind === "asset" ||
            owner.kind === "hierarchy-instance-pool"
        ) {
            const collection =
                this.handleCollections.resolveCollectionRead(expression);
            if (collection) return collection;
        }
        if (owner.kind === "surface" && property === "engine") {
            if (!owner.engineCpp) {
                this.fail(
                    expression,
                    "A surface without an owning engine cannot expose SurfaceContext.engine.",
                );
            }
            return {
                kind: "engine",
                cpp: owner.engineCpp,
                engineCpp: owner.engineCpp,
            };
        }
        const resolved = this.readOwnerProperty(owner, expression);
        if (resolved) {
            return expression.questionDotToken
                ? this.propertyWithOwnerPresence(owner, resolved, expression)
                : resolved;
        }
        return this.fail(
            expression,
            `Unsupported property value '${this.propertyPathForDiagnostic(expression)}' (owner ${owner.kind} ${owner.dataType ? JSON.stringify(owner.dataType) : "without data type"}).`,
        );
    }

    private enumMemberValue(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const constant = this.checker.getConstantValue(expression) ??
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
        if (importedName === "parseNodeMaterialFromSnippet" &&
            (this.frameCallbackDepth > 0 || this.engineStartMark !== undefined || this.temporalSceneRegistration)) {
            this.fail(call, "Node material construction requires setup before scene registration; live group rebuilding is not represented.");
        }
        if (this.runtimeMaterialProfiles.size > 0 &&
            (importedName === "createPbrMaterial" || importedName === "loadGltf")) {
            this.fail(call, "Runtime material construction leaves no generation-known physical material slot for a later PBR material or glTF load.");
        }
        if ((importedName === "createPbrMaterial" || importedName === "loadGltf") &&
            this.isRuntimeResourceConstruction() &&
            (this.frameCallbackDepth > 0 || this.isInRuntimeControlFlow())) {
            this.fail(call, "Runtime resource construction requires a generation-known iteration count for PBR material slots and glTF load order.");
        }
        const profile = runtimeProfileConstructionIntrinsics.has(importedName) &&
            this.isRuntimeResourceConstruction();
        const firstMaterial = this.sceneMaterials.count;
        const firstShader = this.reachedShaderPrograms.length;
        const firstNode = this.reachedNodeMaterials.length;
        const value = compileRegisteredIntrinsic(this, importedName, call);
        if (value && ["registerTextRenderer", "registerScene", "registerSpriteRenderer", "registerFrameGraphContext", "registerEffectRenderer"].includes(importedName)) {
            this.reachedRenderContextRegistrations.add(importedName);
        }
        if (!profile || !value) return value;
        for (let index = firstMaterial; index < this.sceneMaterials.count; ++index) {
            this.runtimeMaterialProfiles.add(index);
        }
        for (let index = firstShader; index < this.reachedShaderPrograms.length; ++index) {
            this.runtimeShaderProfiles.add(index);
        }
        for (let index = firstNode; index < this.reachedNodeMaterials.length; ++index) {
            this.runtimeNodeProfiles.add(index);
        }
        if (value.kind === "mesh" && value.sceneMeshIndex !== undefined) {
            const index = value.sceneMeshIndex;
            this.recordRuntimeMeshProfile(index);
            value.sceneMeshProfileIndex = index;
            delete value.sceneMeshIndex;
            value.cpp = `bbl::upstream::bind_scene_mesh_profile(${this.requireEngine(value, call)}, ${value.cpp}, ${index}u)`;
        }
        return value;
    }

    public isRuntimeResourceConstruction(): boolean {
        if (this.options.workers && this.engineCreationExecution &&
            this.frameCallbackDepth === this.engineCreationExecution.callback &&
            this.runtimeControlFlowDepth === this.engineCreationExecution.control &&
            this.runtimeIterationDepth === this.engineCreationExecution.iteration &&
            this.returnFrames.filter(frame => frame.kind === "native").length === this.engineCreationExecution.native) {
            // Resource order is relative to this newly allocated engine.
            // A worker message can invoke the same factory again, creating
            // another engine with the same independently owned slot layout.
            return false;
        }
        return !this.definiteCollectionMutation();
    }

    private engineCreationExecution?: { callback: number; control: number; iteration: number; native: number };

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
        if (
            !declaration?.body ||
            declaration.parameters.length !== 3
        ) {
            return undefined;
        }
        const names = declaration.parameters.map(({ name }) => name);
        if (!names.every(ts.isIdentifier)) return undefined;
        const [meshParameter, bufferParameter, countParameter] = names.map(name => name.text);
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
        this.recordThinInstanceMesh(mesh.sceneMeshIndex);
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
        this.noteNodeInputAdmissionFailure(call, "Node input bindings do not represent later GPU writes to a texture producer.");
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
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
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
                    size.operatorToken.kind === ts.SyntaxKind.AsteriskToken &&
                    ts.isIdentifier(size.left) &&
                    size.left.text === countParameter &&
                    ts.isNumericLiteral(size.right) &&
                    Number(size.right.text) === 64;
            }
            if (
                ts.isPropertyAccessExpression(node) &&
                ["_version", "_dirtyMin", "_dirtyMax"].includes(node.name.text)
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

    public compileGridMaterialOptions(expression: ts.Expression): string[] {
        return compileGridMaterialOptions(this, expression);
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

    public reachPhysicsViewerMaterial(node: ts.Node, color: readonly [number, number, number, number]): { name: string; id: number } {
        return reachPhysicsViewerMaterialProgram(this, node, color);
    }

    public recordRuntimeMeshProfile(index: number): void {
        if (this.sceneMeshes[index]!.runtimeInstances) return;
        this.sceneMeshes[index]!.runtimeInstances = true;
        ++this.runtimeMeshProfileCount;
    }

    public guardStaticConstructionRead(operation: string): void {
        if (this.features.has("physics:viewer")) this.emit(`bbl::pal::require_runtime_execution(${this.cppString(operation)});`);
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

    /** Records one effect descriptor and returns its index in reach order. */
    public recordEffect(effect: EffectManifest): number {
        return this.reachedEffects_.push(effect) - 1;
    }

    public selectToneMapping(name: string, node: ts.Node): void {
        if (this.selectedToneMapping && this.selectedToneMapping !== name) {
            this.fail(
                node,
                "A scene selects one tone mapping; the composed arms are " +
                    `closed at generation and '${this.selectedToneMapping}' ` +
                    "was already selected.",
            );
        }
        this.selectedToneMapping = name;
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

    public reachedShaderProgram(
        name: string,
        node: ts.Node,
    ): CompiledShaderProgram {
        return reachedShaderProgram(this, name, node);
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

    public isDefaultLibraryIdentifier(identifier: ts.Identifier): boolean {
        return this.symbols.isDefaultLibraryIdentifier(identifier);
    }

    /** The value symbol an expression names once unwrapped, or undefined. */
    private unwrappedValueSymbol(expression: ts.Expression): ts.Symbol | undefined {
        const identifier = unwrappedIdentifier(expression, (wrapped) =>
            this.unwrap(wrapped),
        );
        return identifier && this.symbols.valueSymbol(identifier);
    }

    /**
     * An imported helper with no route to Babylon and no native input can
     * only observe or mutate browser state. Erasing the call as one unit is
     * both safer and more faithful than trying to lower implementation
     * details such as fetch wrappers, streams, timers, and DOM progress UI.
     *
     * The two guards are deliberately conservative: every explicit argument
     * must be a browser value or literal configuration, and the declaration's
     * entire module must reach no Babylon import. A helper receiving an engine,
     * mesh, runtime data, or callback therefore stays on the ordinary inliner.
     */
    public isBrowserOnlyLocalCall(call: ts.CallExpression): boolean {
        // A helper receiving retained controls has native effects even when
        // its returned interface consists entirely of void methods (focus,
        // navigation, click). Do not erase that interface as browser chrome.
        if (call.arguments.some((argument, index) => {
            if (this.options.workers && this.isCanvasElement(argument) &&
                writesUnobservedCanvasMetadata(this.checker, this.program, call, index, this.options.nativeHostUi)) return false;
            if (this.isNativeUiValueExpression(argument)) return true;
            const value = this.unwrap(argument);
            const type = ts.isIdentifier(value)
                ? this.lookupOptional(value)?.dataType : undefined;
            return type?.kind === "vector" &&
                type.element.kind === "handle" &&
                type.element.handle === "ui-element";
        })) return false;
        const callee = this.unwrap(call.expression);
        if (
            ts.isPropertyAccessExpression(callee) &&
            this.isBrowserOnlyNullableClassFactoryCall(call)
        ) {
            return true;
        }
        if (!ts.isIdentifier(callee)) return false;
        const declaration = this.symbols
            .valueSymbol(callee)
            ?.declarations?.find(ts.isFunctionDeclaration);
        if (!declaration?.body) return false;
        const resultType = this.checker.getTypeAtLocation(call);
        // An async browser setup helper exposes `Promise<void>` at the call
        // site, but its observable result after the surrounding `await` is
        // still void. Inspect the promised value rather than rejecting the
        // Promise object's own `then`/`catch` surface as native application
        // data.
        const observableResult =
            this.checker.getAwaitedType(resultType) ?? resultType;
        let writeOnlyObjectResult = false;
        if ((observableResult.flags & ts.TypeFlags.Object) !== 0) {
            const resultDeclarations = [
                ...(observableResult.symbol?.declarations ?? []),
                ...(observableResult.aliasSymbol?.declarations ?? []),
            ];
            const directlyDom = resultDeclarations.some((result) =>
                /(?:^|[\\/])lib\.dom\.d\.ts$/i.test(
                    result.getSourceFile().fileName,
                ),
            );
            if (!directlyDom) {
                writeOnlyObjectResult =
                    observableResult.getProperties().length > 0 &&
                    observableResult.getProperties().every((property) => {
                        const propertyDeclaration =
                            property.valueDeclaration ??
                            property.declarations?.[0];
                        if (!propertyDeclaration) return false;
                        const propertyType =
                            this.checker.getTypeOfSymbolAtLocation(
                                property,
                                propertyDeclaration,
                            );
                        const signatures = propertyType.getCallSignatures();
                        return (
                            signatures.length > 0 &&
                            signatures.every(
                                (signature) =>
                                    (this.checker.getReturnTypeOfSignature(
                                        signature,
                                    ).flags &
                                        ts.TypeFlags.Void) !==
                                    0,
                            )
                        );
                    });
                const carriesNativeData = observableResult
                    .getProperties()
                    .some((property) => {
                        const declaration =
                            property.valueDeclaration ??
                            property.declarations?.[0];
                        if (!declaration) return false;
                        const propertyType =
                            this.checker.getTypeOfSymbolAtLocation(
                                property,
                                declaration,
                            );
                        return (
                            propertyType.getCallSignatures().length === 0 &&
                            this.dataTypes.fromTsType(
                                propertyType,
                                declaration,
                            ) !== undefined
                        );
                    });
                if (carriesNativeData) {
                    // A DOM-using helper may still return an application
                    // record whose native fields are polled later (the
                    // platformer input controller). Erase its DOM statements
                    // individually rather than tainting the whole object.
                    return false;
                }
            }
        }
        if (writeOnlyObjectResult) {
            let reachesBrowser = false;
            let reachesBabylon = false;
            const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
                if (ts.isTypeNode(node)) {
                    return "skip";
                }
                if (ts.isIdentifier(node)) {
                    if (this.symbols.importedName(node) !== undefined) {
                        reachesBabylon = true;
                    }
                    if (
                        ["document", "window", "globalThis"].includes(
                            node.text,
                        ) &&
                        browserGlobalNamed(this, node) !== undefined
                    ) {
                        reachesBrowser = true;
                    }
                }
            });
            visit(declaration.body);
            if (reachesBrowser && !reachesBabylon) {
                return true;
            }
        }
        const hasBrowserInput = call.arguments.some((argument) => {
            if (!this.isBrowserOnlyExpression(argument)) return false;
            const value = this.evaluateBrowserValue(argument);
            // A query-resolved primitive is ordinary input to a helper,
            // including helpers in modules with no Babylon imports.
            return !value || !["number", "boolean", "string", "null"].includes(value.kind);
        });
        const returnsVoid = (observableResult.flags & ts.TypeFlags.Void) !== 0;
        if (
            !hasBrowserInput ||
            (!returnsVoid &&
                !call.arguments.every((argument) =>
                    this.isBrowserHelperArgument(argument),
                ))
        ) {
            return false;
        }
        const source = declaration.getSourceFile();
        return this.isBrowserUtilitySource(source);
    }

    /**
     * A local helper returning a scene-created retained element must be
     * inlined before DOM erasure gets to classify its result type. Canvas
     * helpers deliberately do not qualify: live Canvas2D belongs to its own
     * bounded IR rather than the retained element tree.
     */
    public isNativeUiHelperCall(call: ts.CallExpression): boolean {
        return this.ui.isNativeUiHelperCall(call);
    }

    /**
     * A static factory for a nullable DOM-only class has no native object to
     * construct. This recognizes the deliberately narrow shape used by
     * optional browser overlays: the class lives in a module with no Babylon
     * imports, owns at least one DOM field, and exposes no native-readable
     * public state (only void methods).
     */
    public isBrowserOnlyNullableClassFactoryCall(
        call: ts.CallExpression,
    ): boolean {
        const callee = this.unwrap(call.expression);
        if (!ts.isPropertyAccessExpression(callee)) return false;
        const owner = this.unwrap(callee.expression);
        if (!ts.isIdentifier(owner)) return false;
        const symbol = this.symbols.valueSymbol(owner);
        const target =
            symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
                ? this.checker.getAliasedSymbol(symbol)
                : symbol;
        const declaration = target?.declarations?.find(ts.isClassDeclaration);
        if (!declaration) return false;
        const method = declaration.members.find(
            (member): member is ts.MethodDeclaration =>
                ts.isMethodDeclaration(member) &&
                ts.isIdentifier(member.name) &&
                member.name.text === callee.name.text &&
                (ts.getCombinedModifierFlags(member) &
                    ts.ModifierFlags.Static) !==
                    0,
        );
        if (!method?.body) return false;

        const result = this.checker.getAwaitedType(
            this.checker.getTypeAtLocation(call),
        );
        if (!result || (result.flags & ts.TypeFlags.Union) === 0) {
            return false;
        }
        const resultMembers = (result as ts.UnionType).types;
        const nullable = resultMembers.some(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !==
                0,
        );
        const concrete = resultMembers.filter(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) ===
                0,
        );
        if (
            !nullable ||
            concrete.length !== 1 ||
            !(concrete[0]!.symbol?.declarations ?? []).includes(declaration)
        ) {
            return false;
        }

        const isPrivateOrProtected = (member: ts.ClassElement): boolean =>
            (ts.getCombinedModifierFlags(member) &
                (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !==
            0;
        const isStatic = (member: ts.ClassElement): boolean =>
            (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !==
            0;
        const domOwned = declaration.members.some(
            (member) =>
                ts.isPropertyDeclaration(member) &&
                this.typeComesFromDom(this.checker.getTypeAtLocation(member)),
        );
        if (!domOwned) return false;

        // Retained canvases are part of the native UI surface. Do not classify
        // a helper which owns one as a browser-only decoration merely because
        // its public API happens to be write-only. Such helpers (for example a
        // decoded pixel-art HUD) must pass through ordinary class lowering so
        // their bounded Canvas2D calls can be rewritten onto the PAL.
        const ownsRetainedCanvas = declaration.members.some((member) => {
            if (!ts.isPropertyDeclaration(member)) return false;
            const type = this.checker.getTypeAtLocation(member);
            const members =
                (type.flags & ts.TypeFlags.Union) !== 0
                    ? (type as ts.UnionType).types
                    : [type];
            return members.some((candidate) => {
                const name = candidate.getSymbol()?.getName();
                return (
                    name === "HTMLCanvasElement" ||
                    name === "OffscreenCanvas" ||
                    name === "CanvasRenderingContext2D"
                );
            });
        });
        if (ownsRetainedCanvas) return false;

        const publicSurfaceIsWriteOnly = declaration.members.every((member) => {
            if (
                isStatic(member) ||
                isPrivateOrProtected(member) ||
                ts.isConstructorDeclaration(member)
            ) {
                return true;
            }
            if (!ts.isMethodDeclaration(member)) return false;
            const signature = this.checker.getSignatureFromDeclaration(member);
            return (
                signature !== undefined &&
                (this.checker.getReturnTypeOfSignature(signature).flags &
                    ts.TypeFlags.Void) !==
                    0
            );
        });
        return (
            publicSurfaceIsWriteOnly &&
            this.isBrowserUtilitySource(declaration.getSourceFile())
        );
    }

    private typeComesFromDom(type: ts.Type): boolean {
        const members =
            (type.flags & ts.TypeFlags.Union) !== 0
                ? (type as ts.UnionType).types
                : [type];
        return members.some((member) =>
            (member.symbol?.declarations ?? []).some((declaration) =>
                /(?:^|[\\/])lib\.dom\.d\.ts$/i.test(
                    declaration.getSourceFile().fileName,
                ),
            ),
        );
    }

    private isBrowserUtilitySource(source: ts.SourceFile): boolean {
        const cached = this.browserUtilitySources.get(source);
        if (cached !== undefined) return cached;
        let reachesBabylon = false;
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
            if (reachesBabylon) return "skip";
            if (
                ts.isIdentifier(node) &&
                this.symbols.importedName(node) !== undefined
            ) {
                reachesBabylon = true;
                return "skip";
            }
        });
        visit(source);
        const browserOnly = !reachesBabylon;
        this.browserUtilitySources.set(source, browserOnly);
        return browserOnly;
    }

    private isBrowserHelperArgument(expression: ts.Expression): boolean {
        const unwrapped = this.unwrap(expression);
        if (this.isBrowserOnlyExpression(unwrapped)) return true;
        if (
            ts.isStringLiteral(unwrapped) ||
            ts.isNumericLiteral(unwrapped) ||
            unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
            unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
            unwrapped.kind === ts.SyntaxKind.NullKeyword
        ) {
            return true;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            return unwrapped.properties.every(
                (property) =>
                    ts.isPropertyAssignment(property) &&
                    this.isBrowserHelperArgument(property.initializer),
            );
        }
        if (ts.isArrayLiteralExpression(unwrapped)) {
            return unwrapped.elements.every(
                (element) =>
                    ts.isExpression(element) &&
                    this.isBrowserHelperArgument(element),
            );
        }
        return false;
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
                this.compileValue(unwrapped.properties[0]!.expression),
                unwrapped.properties[0]!.expression,
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

    public compileCondition(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (
            ts.isBinaryExpression(unwrapped) &&
            (unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken ||
                unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        ) {
            const left = this.compileCondition(unwrapped.left);
            // Fold browser-derived constants before lowering the remaining
            // runtime condition. Scene 12 deliberately combines its pinned
            // query pose with a frame counter in one conjunction.
            const isAnd =
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken;
            const identity = isAnd ? "true" : "false";
            const absorbing = isAnd ? "false" : "true";
            // Preserve JavaScript short circuiting: an unreachable right
            // operand may itself be outside the lowering contract.
            if (left === absorbing) {
                return absorbing;
            }
            let right = "";
            let rightLines: string[] = [];
            if (left === identity) {
                right = this.compileCondition(unwrapped.right);
            } else {
                this.enterRuntimeControlFlow();
                try {
                    rightLines = this.captureEmittedLines(() => {
                        right = this.compileCondition(unwrapped.right);
                    });
                } finally {
                    this.leaveRuntimeControlFlow();
                }
            }
            if (rightLines.length > 0) {
                const guardedLines = rightLines
                    .map((line) => `    ${line}`)
                    .join("\n");
                return (
                    `([&]() -> bool {\n` +
                    `    if (${isAnd ? `!(${left})` : left}) return ${absorbing};\n` +
                    `${guardedLines}\n` +
                    `    return ${right};\n` +
                    `}())`
                );
            }
            if (right === absorbing) return absorbing;
            if (left === identity) return right;
            if (right === identity) return left;
            return `(${left} ${isAnd ? "&&" : "||"} ${right})`;
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            (unwrapped.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken ||
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsEqualsToken)
        ) {
            const isPointerLockElement = (operand: ts.Expression): boolean => {
                const value = this.unwrap(operand);
                return (
                    ts.isPropertyAccessExpression(value) &&
                    value.name.text === "pointerLockElement" &&
                    ts.isIdentifier(value.expression) &&
                    value.expression.text === "document" &&
                    this.isDefaultLibraryIdentifier(value.expression)
                );
            };
            const isCanvas = (operand: ts.Expression): boolean => {
                const value = this.unwrap(operand);
                return ts.isIdentifier(value) && this.isCanvasElement(value);
            };
            if (
                (isPointerLockElement(unwrapped.left) &&
                    isCanvas(unwrapped.right)) ||
                (isCanvas(unwrapped.left) &&
                    isPointerLockElement(unwrapped.right))
            ) {
                const locked = `${this.requireDefaultEngine(unwrapped)}.pointer_locked`;
                return unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken
                    ? locked
                    : `!(${locked})`;
            }
        }
        if (this.isBrowserOnlyExpression(unwrapped)) {
            const condition = this.evaluateBrowserCondition(unwrapped);
            if (condition !== undefined) {
                return condition ? "true" : "false";
            }
            const comparison =
                ts.isBinaryExpression(unwrapped) &&
                [
                    ts.SyntaxKind.EqualsEqualsEqualsToken,
                    ts.SyntaxKind.ExclamationEqualsEqualsToken,
                    ts.SyntaxKind.LessThanToken,
                    ts.SyntaxKind.LessThanEqualsToken,
                    ts.SyntaxKind.GreaterThanToken,
                    ts.SyntaxKind.GreaterThanEqualsToken,
                ].includes(unwrapped.operatorToken.kind);
            const browserOperands = comparison
                ? [unwrapped.left, unwrapped.right].filter((operand) =>
                      this.isBrowserOnlyExpression(operand),
                  )
                : [];
            const resolvedNumericOperands =
                browserOperands.length > 0 &&
                browserOperands.every(
                    (operand) =>
                        this.evaluateBrowserValue(operand)?.kind === "number",
                );
            if (!resolvedNumericOperands) {
                this.fail(
                    unwrapped,
                    "Browser-dependent condition cannot be determined for native AOT lowering " +
                        `(browser operands: ${browserOperands.map((operand) => operand.getText()).join(", ") || unwrapped.getText()}).`,
                );
            }
            // This is a mixed native/browser comparison. The browser side
            // is a resolved numeric constant; continue through the ordinary
            // comparison lowering so the native side remains dynamic.
        }
        if (
            ts.isPrefixUnaryExpression(unwrapped) &&
            unwrapped.operator === ts.SyntaxKind.ExclamationToken
        ) {
            const operand = this.compileCondition(unwrapped.operand);
            if (operand === "true") return "false";
            if (operand === "false") return "true";
            return `!(${operand})`;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            if (unwrapped.operatorToken.kind === ts.SyntaxKind.InKeyword) {
                return this.dataLowerer.compileInOperator(unwrapped);
            }
            if (
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.InstanceOfKeyword &&
                ts.isIdentifier(unwrapped.right) &&
                !this.lookupOptional(unwrapped.right)
            ) {
                if (unwrapped.right.text === "Error") {
                    const value = this.compileValue(unwrapped.left);
                    if (value.nativeError) return "true";
                }
                const classInstance = this.compileClassInstanceOf(unwrapped, unwrapped.right);
                if (classInstance !== undefined) return classInstance;
                // The two buffer views answer `instanceof` beside the
                // typed arrays; neither table alone names every binary kind.
                const expected: string | undefined =
                    BUFFER_VIEW_KINDS.get(unwrapped.right.text) ??
                    TYPED_ARRAY_KINDS.get(unwrapped.right.text);
                if (expected) {
                    const value = this.compileValue(unwrapped.left);
                    if (value.dataType) {
                        return value.dataType.kind === expected
                            ? "true"
                            : "false";
                    }
                }
            }
            // Engine-handle identity first: `group === sadPose` is
            // upstream object identity, which native handles carry as
            // their creation-ordered `.value`. The probe only looks
            // bindings up, so a miss falls through without emitting.
            const handles =
                this.handleCollections.compileHandleEquality(unwrapped);
            if (handles) {
                return handles;
            }
            // Two booleans compared for identity, which is how a shared
            // module normalizes an optional flag its caller may have left
            // out (`opts.useFloatingOrigin === true`). Asked before the
            // arms that would EMIT a comparison, because where both sides
            // settle at generation the answer settles with them -- and an
            // option that decides a lowering needs that answer, not an
            // expression computing it at run time.
            const foldedBoolean = this.foldBooleanComparison(unwrapped);
            if (foldedBoolean) {
                return foldedBoolean;
            }
            // The data equality path has to inspect both operands before it
            // can decide whether it owns the comparison. Calls emit as they
            // are inspected, so discard a declined probe and let the numeric
            // path below perform JavaScript's one evaluation for real.
            const typed = this.probeEmission(() =>
                this.dataLowerer.equalityComparison(unwrapped),
            );
            if (typed) {
                return typed;
            }
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken
            ) {
                // `if (a ?? b)`: the value dispatch selects, and the
                // selected value is the condition — the call arm's
                // delegate-and-kind-check shape below.
                const value = this.compileValue(unwrapped);
                if (value.staticBoolean !== undefined) {
                    return value.staticBoolean ? "true" : "false";
                }
                if (value.kind === "boolean") {
                    return value.cpp;
                }
                this.fail(
                    unwrapped.operatorToken,
                    "'??' in a condition must select a boolean, " +
                        `received ${value.kind}.`,
                );
            }
            const operator = new EmissionMap<ts.SyntaxKind, string>([
                [ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
                [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!="],
                [ts.SyntaxKind.LessThanToken, "<"],
                [ts.SyntaxKind.LessThanEqualsToken, "<="],
                [ts.SyntaxKind.GreaterThanToken, ">"],
                [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
            ]).get(unwrapped.operatorToken.kind);
            if (!operator) {
                if (this.evaluator.isNumberExpression(unwrapped)) {
                    this.reachJsData();
                    return `bbl::js::number_truthy(${this.compileNumber(unwrapped, "double")})`;
                }
                this.fail(
                    unwrapped.operatorToken,
                    "Reached callback conditions support numeric comparisons and logical operators.",
                );
            }
            let leftValue = this.compileValue(unwrapped.left);
            const textKind = (value: Value) => ["text-data", "text-renderable", "text-vector"].includes(value.kind);
            if (textKind(leftValue)) leftValue = retainTextValue(this, leftValue);
            let rightValue = this.compileValue(unwrapped.right);
            if (textKind(rightValue)) rightValue = retainTextValue(this, rightValue);
            if (leftValue.kind === "texture" && rightValue.kind === "texture") {
                if (operator !== "==" && operator !== "!=") this.fail(unwrapped, "Texture2D values support identity comparisons.");
                const stored = (value: Value, node: ts.Expression) =>
                    this.dataLowerer.compileKnownValueForSink(value, { kind: "handle", handle: "texture" }, node);
                return `${stored(leftValue, unwrapped.left)} ${operator} ${stored(rightValue, unwrapped.right)}`;
            }
            if (textKind(leftValue) || textKind(rightValue)) {
                if (operator !== "==" && operator !== "!=") this.fail(unwrapped, "Text entities support strict identity comparisons.");
                const sameKind = leftValue.kind === rightValue.kind && leftValue.textTransform === rightValue.textTransform;
                return sameKind ? `${leftValue.cpp} ${operator} ${rightValue.cpp}` : operator === "==" ? "false" : "true";
            }
            if ([leftValue.kind, rightValue.kind].some((kind) => kind === "text-font")) {
                const token = unwrapped.operatorToken.kind;
                if (token !== ts.SyntaxKind.EqualsEqualsEqualsToken && token !== ts.SyntaxKind.ExclamationEqualsEqualsToken) {
                    this.fail(unwrapped, "Static font/text data only supports strict identity comparison.");
                }
                const equal = sameCompiledValue(leftValue, rightValue);
                return (token === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : !equal) ? "true" : "false";
            }
            const staticLeft =
                leftValue.kind === "number" && !leftValue.parameterBinding
                    ? leftValue.staticNumber
                    : undefined;
            const staticRight =
                rightValue.kind === "number" && !rightValue.parameterBinding
                    ? rightValue.staticNumber
                    : undefined;
            if (
                leftValue.staticString !== undefined &&
                rightValue.staticString !== undefined
            ) {
                const equal =
                    leftValue.staticString === rightValue.staticString;
                const folded =
                    unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken
                        ? equal
                        : unwrapped.operatorToken.kind ===
                            ts.SyntaxKind.ExclamationEqualsEqualsToken
                          ? !equal
                          : undefined;
                if (folded !== undefined) {
                    return folded ? "true" : "false";
                }
            }
            const isStringValue = (value: Value): boolean =>
                value.kind === "string" ||
                (value.kind === "data" && value.dataType?.kind === "string");
            if (
                isStringValue(leftValue) &&
                isStringValue(rightValue) &&
                (unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken ||
                    unwrapped.operatorToken.kind ===
                        ts.SyntaxKind.ExclamationEqualsEqualsToken)
            ) {
                return (
                    `std::string(${leftValue.cpp}) ` +
                    `${unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? "==" : "!="} ` +
                    `std::string(${rightValue.cpp})`
                );
            }
            if (
                leftValue.kind === "object-url" &&
                rightValue.kind === "object-url" &&
                (unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken ||
                    unwrapped.operatorToken.kind ===
                        ts.SyntaxKind.ExclamationEqualsEqualsToken)
            ) {
                this.expectSameEngine(leftValue, rightValue, unwrapped);
                return (
                    `${leftValue.cpp} ` +
                    `${unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? "==" : "!="} ` +
                    `${rightValue.cpp}`
                );
            }
            if (
                staticLeft !== undefined &&
                staticRight !== undefined &&
                Number.isFinite(staticLeft) &&
                Number.isFinite(staticRight)
            ) {
                const folded = new EmissionMap<ts.SyntaxKind, boolean>([
                    [
                        ts.SyntaxKind.EqualsEqualsEqualsToken,
                        staticLeft === staticRight,
                    ],
                    [
                        ts.SyntaxKind.ExclamationEqualsEqualsToken,
                        staticLeft !== staticRight,
                    ],
                    [ts.SyntaxKind.LessThanToken, staticLeft < staticRight],
                    [
                        ts.SyntaxKind.LessThanEqualsToken,
                        staticLeft <= staticRight,
                    ],
                    [ts.SyntaxKind.GreaterThanToken, staticLeft > staticRight],
                    [
                        ts.SyntaxKind.GreaterThanEqualsToken,
                        staticLeft >= staticRight,
                    ],
                ]).get(unwrapped.operatorToken.kind);
                if (folded !== undefined) {
                    return folded ? "true" : "false";
                }
            }
            // The statement emitter supplies the condition's outer
            // parentheses. Comparisons bind more tightly than the logical
            // expressions that compose them, so another pair here is both
            // unnecessary and diagnosed by clang-cl's
            // -Wparentheses-equality for `if ((a == b))`.
            // Both operands were already compiled above to inspect static
            // values and string identity. Reuse them: compiling their ASTs
            // again would duplicate call-shaped numeric operands.
            return `${this.castNumber(leftValue, "double")} ${operator} ${this.castNumber(rightValue, "double")}`;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
        ) {
            const data = this.dataLowerer.conditionOperand(unwrapped);
            if (data) {
                return data;
            }
        }
        if (ts.isCallExpression(unwrapped)) {
            const value = this.compileValue(unwrapped);
            const condition = this.dataLowerer.conditionFromValue(value);
            if (condition !== undefined) return condition;
            this.fail(
                unwrapped,
                `Condition call must produce a boolean, received ${value.kind}.`,
            );
        }
        if (
            unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
            unwrapped.kind === ts.SyntaxKind.FalseKeyword
        ) {
            return this.compileBoolean(unwrapped);
        }
        if (ts.isIdentifier(unwrapped)) {
            const value = this.lookupOptional(unwrapped);
            if (value) {
                const dataCondition =
                    this.dataLowerer.conditionFromValue(value);
                if (dataCondition !== undefined) {
                    return dataCondition;
                }
                if (value.kind === "callback" || value.kind === "ui-element") {
                    return "true";
                }
                if (value.kind === "json-null") {
                    return "false";
                }
            }
            return this.compileBoolean(unwrapped);
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            // A record member in condition position: a boolean member is
            // its own truth (`result.hit`), and a member that carries a
            // found flag — a search result's maybe-absent record
            // (`result.hitPoint`) — is truthy exactly when the search
            // said so.
            const value = this.compileValue(unwrapped);
            const condition = this.dataLowerer.conditionFromValue(value);
            if (condition !== undefined) return condition;
            if (value.kind === "callback") {
                return "true";
            }
            if (value.kind === "json-null") {
                return "false";
            }
            this.fail(
                unwrapped,
                "Expected a reached callback condition; property produced " +
                    `${value.kind}${value.dataType ? ` ${JSON.stringify(value.dataType)}` : ""}.`,
            );
        }
        this.fail(unwrapped, "Expected a reached callback condition.");
    }

    /** Nonzero while a frame callback's statements are being lowered. */
    private frameCallbackDepth = 0;
    /** Native path-dependent bodies currently being lowered. */
    private runtimeControlFlowDepth = 0;
    /** Native loop expressions/bodies currently being lowered. */
    private runtimeIterationDepth = 0;
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
    private readonly staticCallbackEvaluationIdentities: object[] = emissionArray([]);

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
        if (ts.isIdentifier(unwrapped)) {
            if (signature === "void") {
                const bound = this.lookupOptional(unwrapped);
                if (
                    bound?.kind === "callback" &&
                    bound.cpp.length > 0 &&
                    bound.nativeCallbackParameterTypes?.length === 0
                ) {
                    const captureByValue = retainCaptures || !!this.options.workers || this.frameCallbackDepth > 0 || this.managedCaptures.length > 0;
                    const emitBody = () => {
                        this.useNativeValue(bound);
                        this.emit(`${bound.cpp}();`);
                    };
                    const compiled = this.captureManagedClosureLines(emitBody, captureByValue ? false : "entry");
                    return renderClosure(compiled, "");
                }
                if (this.options.workers && (bound?.kind === "callback" || !bound)) {
                    return this.compilePlatformCallback(unwrapped, undefined, [], undefined, true, false).cpp;
                }
                this.fail(
                    unwrapped,
                    `A named deferred callback must resolve to a native zero-argument function (received ${bound?.kind ?? "unbound"}).`,
                );
            }
            return this.compileNamedFrameCallback(unwrapped, signature, retainCaptures);
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
            ? this.allocateTemporaryCppName("frame_delta") : undefined;

        // Everything the outermost frame callback pushes lives on its own
        // stack frame; a deferred body may not reach into it.
        const previousFrameFloor = this.frameCallbackScopeFloor;
        if (this.frameCallbackDepth === 0) {
            this.frameCallbackScopeFloor = this.variableScopes.length;
        }
        const previousDeferredFloor = this.deferredCaptureFloor;
        const previousDeferredCeiling = this.deferredCaptureCeiling;
        const previousPlatformEventCaptureFloor =
            this.escapingPlatformEventCaptureFloor;
        if (this.frameCallbackDepth > 0) {
            this.escapingPlatformEventCaptureFloor = this.variableScopes.length;
        }
        this.refuseEscapingPlatformEventCapturesIn(unwrapped);
        this.deferredCaptureFloor =
            signature === "void" || signature === "interval"
                ? this.frameCallbackScopeFloor
                : undefined;
        this.deferredCaptureCeiling =
            this.deferredCaptureFloor === undefined
                ? undefined
                : this.variableScopes.length;
        this.pushScope(this.allocateBlockPrefix());
        // This body is emitted into a real native callback lambda. A source
        // `return` therefore leaves that lambda directly, including when it
        // guards statements later in the callback; it is not an inlined
        // function return that needs the breakable wrapper path.
        this.beginNativeFunctionBody(undefined, true);
        const captureByValue = retainCaptures || !!this.options.workers || this.frameCallbackDepth > 0 || this.managedCaptures.length > 0;
        let compiled: CapturedClosure;
        try {
            const emitBody = () => {
                if (parameter && ts.isIdentifier(parameter.name)) {
                    this.defineVariable(parameter.name, {
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
                        emitReachableStatements(this, unwrapped.body.statements);
                    } else {
                        this.emitExpressionAsStatement(unwrapped.body);
                    }
                } finally {
                    this.frameCallbackDepth -= 1;
                }
            };
            compiled = this.captureManagedClosureLines(emitBody, captureByValue ? false : "entry");
        } finally {
            this.endNativeFunctionBody();
            this.popScope();
            this.deferredCaptureFloor = previousDeferredFloor;
            this.deferredCaptureCeiling = previousDeferredCeiling;
            this.escapingPlatformEventCaptureFloor =
                previousPlatformEventCaptureFloor;
            this.frameCallbackScopeFloor = previousFrameFloor;
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
        return renderClosure(compiled, lambdaParameter);
    }

    /** A retained zero-argument callback with the same capture checks as timers. */
    public compileVoidCallback(expression: ts.Expression): string {
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
            compiled = this.captureManagedClosureLines(emitBody, previousDepth === 0 ? "entry" : false);
        } finally {
            this.frameCallbackDepth = previousDepth;
        }
        return renderClosure(compiled, `[[maybe_unused]] const bbl::js::F32Array& ${dataName}`);
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
        const previousDeferredFloor = this.deferredCaptureFloor;
        const previousDeferredCeiling = this.deferredCaptureCeiling;
        const previousPlatformEventCaptureFloor =
            this.escapingPlatformEventCaptureFloor;
        if (this.frameCallbackDepth > 0) {
            this.escapingPlatformEventCaptureFloor = this.variableScopes.length;
        }
        this.refuseEscapingPlatformEventCapturesIn(identifier);
        if (signature === "interval") {
            this.deferredCaptureFloor = this.frameCallbackScopeFloor;
            this.deferredCaptureCeiling =
                this.deferredCaptureFloor === undefined
                    ? undefined
                    : this.variableScopes.length;
        }
        const captureByValue = retainCaptures || !!this.options.workers || this.frameCallbackDepth > 0 || this.managedCaptures.length > 0;
        this.frameCallbackDepth += 1;
        let compiled: CapturedClosure;
        try {
            const emitBody = () => {
                const stored = this.lookupOptional(identifier);
                const parameters = stored?.nativeCallbackParameterTypes;
                if (stored?.kind === "callback" && stored.cpp.length > 0 &&
                    parameters && parameters.length <= 1 &&
                    parameters.every((type) => type?.kind === "number") &&
                    (parameters.length === 0 || parameter)) {
                    this.useNativeValue(stored);
                    this.emit(`${stored.cpp}(${parameters.length === 0 ? "" : parameter});`);
                    return;
                }
                const value = this.compileCallbackWithValues(
                    identifier,
                    parameter ? [{ kind: "number", cpp: parameter }] : [],
                    identifier,
                );
                if (value.cpp.length > 0) {
                    this.emit(`${value.cpp};`);
                }
            };
            compiled = this.captureManagedClosureLines(emitBody, captureByValue ? false : "entry");
        } finally {
            this.frameCallbackDepth -= 1;
            this.deferredCaptureFloor = previousDeferredFloor;
            this.deferredCaptureCeiling = previousDeferredCeiling;
            this.escapingPlatformEventCaptureFloor =
                previousPlatformEventCaptureFloor;
        }
        const lambdaParameter = parameter
            ? `[[maybe_unused]] ${signature === "timestamp" ? "double" : "float"} ${parameter}`
            : "";
        return renderClosure(compiled, lambdaParameter);
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
                                  resolved.arguments.map((argument) => this.compileValue(
                                      this.alwaysUsedParameterDefault(argument) ?? argument,
                                  )),
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
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
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
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (candidate) => {
            if (passedExplicitly) return "skip";
            if (
                ts.isCallExpression(candidate) &&
                (this.checker.getResolvedSignature(candidate)?.declaration ===
                    owner ||
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
        if (
            suffix.kind !== "string" &&
            !(suffix.kind === "data" && suffix.dataType?.kind === "string")
        ) {
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
            !ts.isIdentifier(declaration.initializer.expression) ||
            declaration.initializer.expression.text !== "URL" ||
            !this.isDefaultLibraryIdentifier(declaration.initializer.expression) ||
            declaration.initializer.arguments?.length !== 2 ||
            identifierText(argumentAt(declaration.initializer, 0)) !== pathParameter ||
            identifierText(argumentAt(declaration.initializer, 1)) !== moduleParameter
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

    private importedCall(
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
        let msaaSamples: 1 | 4 = 4;
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
            compileEnginePixelRatioCap(this, options);
            // Both flags reach generation: the pin's `_setHpmAllocator`
            // swaps a process-global allocator, so `useHighPrecisionMatrix`
            // decides the width every matrix this port composes is stored
            // at, and `useFloatingOrigin` decides the frame they are
            // composed in.
            ({ highPrecisionMatrix, floatingOrigin } =
                compileEnginePrecisionPolicy(this, options));
            const samples = this.objectProperty(options, "msaaSamples");
            if (samples) {
                const staticSamples = selectedStaticNumberValue(this, samples);
                if (staticSamples !== 1 && staticSamples !== 4) {
                    this.fail(
                        samples,
                        "Native engine lowering supports explicit msaaSamples: 1 or 4 only.",
                    );
                }
                msaaSamples = staticSamples;
                this.engineMsaaSamples = staticSamples;
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
        let canvasArgument = "";
        if (this.options.workers) {
            const canvas = this.compileValue(argumentAt(call, 0));
            if (canvas.kind !== "offscreen-canvas" && canvas.kind !== "ui-element") this.fail(argumentAt(call, 0), "The realm engine requires a native canvas context.");
            canvasArgument = `, ${canvas.kind === "ui-element" ? `bbl::pal::window_canvas(${canvas.cpp})` : canvas.cpp}`;
        }
        this.emit({ kind: "declaration", type: "auto", name: cppName, initializer: `${this.options.workers ? "bbl::pal::create_realm_engine" : "bbl::create_engine"}(bbl::EngineOptions{${this.cppString(this.options.title)}, ${this.options.width}, ${this.options.height}}${canvasArgument})` });
        this.engineCreationInsertion = this.body.length;
        if (this.options.workers) this.engineCreationExecution = {
            callback: this.frameCallbackDepth, control: this.runtimeControlFlowDepth,
            iteration: this.runtimeIterationDepth, native: this.returnFrames.filter(frame => frame.kind === "native").length,
        };
        const engineCpp = this.options.workers ? `(*${cppName})` : cppName;
        this.defaultEngineCpp = engineCpp;
        for (const lookup of this.pendingHostUiLookups) {
            lookup.engineCpp = engineCpp;
            this.emit({ kind: "declaration", type: "const auto", name: lookup.cpp, initializer: `bbl::ui_get_element_by_id(${engineCpp}, ${this.cppString(lookup.uiHostId!)})` });
        }
        let surfaceCanvas = false;
        if (!this.options.workers && [...this.ui.nativeHostUiTags().values()].includes("canvas")) {
            const canvas = this.compileValue(argumentAt(call, 0));
            if (canvas.kind === "ui-element") {
                if (canvas.uiTag !== "canvas") this.fail(argumentAt(call, 0), "An engine surface requires a retained canvas element.");
                this.emit(`${engineCpp}.surface_canvas = ${canvas.cpp};`);
                this.emit(`${engineCpp}.ui_elements[${canvas.cpp}.value].client_rect_requested = true;`);
                surfaceCanvas = true;
                this.reachFeature("renderer:surface", call);
            }
        }
        const nativeBinding = this.registerNativeBinding(cppName, !this.options.workers);
        if (this.options.workers) this.nativeBindings.set(engineCpp, nativeBinding);
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
        while (true) {
            const candidate = `v_bblite_${label}_${this.temporaryIndex++}`;
            if (!this.sourceCppNames.has(candidate)) {
                this.sourceCppNames.add(candidate);
                return candidate;
            }
        }
    }

    public allocateUserFunctionPrefix(): string {
        return `fn${this.temporaryIndex++}_`;
    }

    public allocateBlockPrefix(): string {
        return `${this.cppNamePrefixes.at(-1) ?? ""}block${this.temporaryIndex++}_`;
    }

    public compileStaticString(expression: ts.Expression): string {
        return this.compileStringLiteral(expression);
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

    public compileShaderSource(expression: ts.Expression): {
        source: string;
        dynamicUniforms: Array<{
            name: string;
            type: "f32";
            components: string[];
        }>;
    } {
        const resolved = this.resolveStaticExpression(expression);
        const callee = ts.isCallExpression(resolved) ? this.unwrap(resolved.expression) : undefined;
        if (
            !ts.isCallExpression(resolved) ||
            !callee || !ts.isIdentifier(callee)
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
            const parameters = new EmissionMap<string, ShaderTextBinding>();
            // Application shader builders may splice a generation-known
            // constant imported from a sibling module (Antigravity Racer's
            // RING_COUNT/SHADOW_CASCADES are the reached case). The whole
            // application module graph is already pinned input here, so
            // carry those immutable bindings into the text evaluator just
            // like literal call arguments. Imported functions remain owned
            // by the evaluator's module traversal below.
            for (const statement of declaration.getSourceFile().statements) {
                if (
                    !ts.isImportDeclaration(statement) ||
                    !statement.importClause?.namedBindings ||
                    !ts.isNamedImports(statement.importClause.namedBindings)
                ) {
                    continue;
                }
                for (const imported of statement.importClause.namedBindings
                    .elements) {
                    const symbol = this.checker.getSymbolAtLocation(
                        imported.name,
                    );
                    const target =
                        symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
                            ? this.checker.getAliasedSymbol(symbol)
                            : symbol;
                    const variable = target?.declarations?.find(
                        (candidate): candidate is ts.VariableDeclaration =>
                            ts.isVariableDeclaration(candidate) &&
                            candidate.initializer !== undefined,
                    );
                    if (!variable?.initializer) continue;
                    const value = this.compileValue(variable.initializer);
                    const binding: ShaderTextBinding | undefined =
                        value.staticString ??
                        value.staticBoolean ??
                        value.staticNumber;
                    if (binding !== undefined) {
                        parameters.set(imported.name.text, binding);
                    }
                }
            }
            let allStatic = true;
            declaration.parameters.forEach((parameter, index) => {
                if (!ts.isIdentifier(parameter.name)) {
                    allStatic = false;
                    return;
                }
                const argument =
                    resolved.arguments[index] ?? parameter.initializer;
                if (!argument) {
                    return;
                }
                const value = this.compileValue(
                    this.alwaysUsedParameterDefault(argument) ?? argument,
                );
                const binding: ShaderTextBinding | undefined =
                    value.staticString ??
                    value.staticBoolean ??
                    value.staticNumber;
                if (binding === undefined) {
                    allStatic = false;
                    return;
                }
                parameters.set(parameter.name.text, binding);
            });
            if (allStatic) {
                const source = new PinnedShaderText(
                    this.applicationShaderTextContext(),
                ).evaluateDeclaration(
                    declaration.getSourceFile().fileName,
                    declaration,
                    parameters,
                );
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
                    this.symbols.valueSymbol(
                        formatterTarget,
                    ),
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

        const marker = "__BBL_DYNAMIC_SHADER_FLOAT__";
        const templated = template.head.text + marker + span.literal.text;
        const declarationPattern = new RegExp(
            `(^|\\n)([ \\t]*)const\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*f32\\s*=\\s*${marker}\\s*;[ \\t]*(?=\\n|$)`,
        );
        const match = declarationPattern.exec(templated);
        if (!match) {
            return {
                source: this.compileStaticString(expression),
                dynamicUniforms: [],
            };
        }
        const constant = match[3]!;
        const uniformName = "bblDynamicDepthBias";
        const withoutDeclaration = templated.replace(
            declarationPattern,
            match[1]!,
        );
        const source = withoutDeclaration.replace(
            new RegExp(`\\b${constant}\\b`, "g"),
            `shaderUniforms.${uniformName}`,
        );
        return {
            source,
            dynamicUniforms: [
                {
                    name: uniformName,
                    type: "f32",
                    components: [this.compileNumber(argument)],
                },
            ],
        };
    }

    /** Source navigation for bounded shader builders declared by the app. */
    private applicationShaderTextContext(): ShaderTextContext {
        const sourceFile = (modulePath: string): ts.SourceFile => {
            const file =
                this.program.getSourceFile(modulePath) ??
                this.sourceFiles().find(
                    (candidate) => candidate.fileName === modulePath,
                );
            if (!file) {
                this.fail(
                    this.sourceFile,
                    `Shader builder module '${modulePath}' is not in the compilation program.`,
                );
            }
            return file;
        };
        const unwrapExpression = (expression: ts.Expression): ts.Expression =>
            this.unwrap(expression);
        const propertyPath = (
            expression: ts.Expression,
        ): string[] | undefined => {
            const node = unwrapExpression(expression);
            if (ts.isIdentifier(node)) return [node.text];
            if (!ts.isPropertyAccessExpression(node)) return undefined;
            const owner = propertyPath(node.expression);
            return owner ? [...owner, node.name.text] : undefined;
        };
        const moduleScopeConstant = (
            file: ts.SourceFile,
            name: string,
        ): ts.Expression | undefined => {
            for (const statement of file.statements) {
                if (
                    !ts.isVariableStatement(statement) ||
                    (statement.declarationList.flags & ts.NodeFlags.Const) === 0
                ) {
                    continue;
                }
                for (const declaration of statement.declarationList
                    .declarations) {
                    if (
                        ts.isIdentifier(declaration.name) &&
                        declaration.name.text === name &&
                        declaration.initializer
                    ) {
                        return declaration.initializer;
                    }
                }
            }
            return undefined;
        };
        return {
            sourceFile,
            contractError: (node, message) => this.fail(node, message),
            hasNode: (root, predicate) => {
                let found = false;
                const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
                    if (found) return "skip";
                    if (predicate(node)) {
                        found = true;
                        return "skip";
                    }
                });
                visit(root);
                return found;
            },
            functionDeclaration: (modulePath, symbolName) => {
                const file = sourceFile(modulePath);
                const declaration = file.statements.find(
                    (statement): statement is ts.FunctionDeclaration =>
                        ts.isFunctionDeclaration(statement) &&
                        statement.name?.text === symbolName &&
                        statement.body !== undefined,
                );
                if (!declaration) {
                    this.fail(
                        file,
                        `Expected shader builder function '${symbolName}' with a body.`,
                    );
                }
                return { file, declaration };
            },
            propertyPath,
            moduleOfImport: (modulePath, importedName) => {
                const file = sourceFile(modulePath);
                for (const statement of file.statements) {
                    if (
                        !ts.isImportDeclaration(statement) ||
                        !statement.importClause?.namedBindings ||
                        !ts.isNamedImports(statement.importClause.namedBindings)
                    ) {
                        continue;
                    }
                    const imported =
                        statement.importClause.namedBindings.elements.find(
                            (element) => element.name.text === importedName,
                        );
                    if (!imported) continue;
                    const symbol = this.checker.getSymbolAtLocation(
                        imported.name,
                    );
                    const target =
                        symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
                            ? this.checker.getAliasedSymbol(symbol)
                            : symbol;
                    return target?.declarations?.[0]?.getSourceFile().fileName;
                }
                return undefined;
            },
            moduleScopeConstant,
            unwrapExpression,
        };
    }

    public resolveStaticExpression(
        expression: ts.Expression,
        resolving: ReadonlySet<ts.Symbol> = new EmissionSet(),
    ): ts.Expression {
        return this.evaluator.resolveStaticExpression(expression, resolving);
    }

    public lookupIdentifierValue(identifier: ts.Identifier): Value | undefined {
        return this.lookupOptional(identifier);
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
        if (this.knownValueWithoutEvaluation(expression)?.collectionCardinality?.untrackedAliases) return undefined;
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
                compileCondition: (node) =>
                    this.probeEmission(
                        () => this.compileCondition(node),
                        (folded) => folded === "true" || folded === "false",
                    ),
                resolveStaticExpression: (node) =>
                    this.resolveStaticExpression(node),
            },
            expression,
        );
        return resolved && ts.isArrayLiteralExpression(resolved)
            ? resolved
            : undefined;
    }

    public cppLocalName(sourceName: string): string {
        return this.cppIdentifier(sourceName);
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

    public reachVoxelFileStorage(site: ts.Node): void {
        this.voxelFileStorageReached = true;
        this.reachFeature("browser:file", site);
    }

    public reachJson(): void {
        this.reachFeature("data:json");
    }

    public reachLocalStorage(): void {
        this.reachFeature("storage:local");
    }

    private voxelFileContract(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): { name: "saveToFile" | "loadFromFile"; dataType: DataType | undefined } | undefined {
        const declaration = tryResolveFunctionDeclaration(this.checker, callee);
        const name = declaration?.name && ts.isIdentifier(declaration.name)
            ? declaration.name.text : undefined;
        if (name !== "saveToFile" && name !== "loadFromFile") {
            return undefined;
        }
        if (!declaration) {
            return undefined;
        }
        const fileName = declaration
            .getSourceFile()
            .fileName.replace(/\\/g, "/");
        if (!/\/demos\/minecraft\/save-load\.(?:ts|js)$/i.test(fileName)) {
            return undefined;
        }
        const parameter = declaration.parameters[0];
        const signature = this.checker.getResolvedSignature(call);
        const type = name === "saveToFile"
            ? parameter && this.checker.getTypeAtLocation(parameter)
            : signature && this.checker.getAwaitedType(this.checker.getReturnTypeOfSignature(signature));
        return { name, dataType: type ? this.dataTypes.fromTsType(type, call) : undefined };
    }

    /** Native host-file-dialog adapter for the pinned voxel save/load module. */
    public compileVoxelFileCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        const contract = this.voxelFileContract(call, callee);
        if (!contract) return undefined;
        const { name, dataType } = contract;
        if (!dataType) {
            this.fail(call, "Voxel file calls require a SaveData record or nullable load result.");
        }
        const stored = this.dataTypes.markStoredObjectReferences(dataType);
        this.reachVoxelFileStorage(call);
        this.reachJsData();
        if (name === "saveToFile") {
            this.expectArgumentCount(call, 1, 1);
            return {
                kind: "boolean",
                cpp:
                    `bbl::js::save_voxel_world(${this.requireDefaultEngine(call)}, ` +
                    `${this.dataLowerer.compileForSink(argumentAt(call, 0), stored)})`,
                dataType: { kind: "boolean" },
            };
        }
        this.expectArgumentCount(call, 0, 0);
        return this.dataValue(
            `bbl::js::load_voxel_world<${this.dataTypes.cppType(stored)}>` +
                `(${this.requireDefaultEngine(call)})`,
            stored,
        );
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
            this.variableScopes.at(-1)!,
        );
    }

    public leaveStaticIteration(): void {
        this.staticCallbackEvaluationIdentities.pop();
        this.staticExpansionBudget.leave();
    }

    public isInParameterizedResourceLoop(statement?: ts.IterationStatement): boolean {
        return statement
            ? this.parameterizedResourceIterations.some((frame) => frame.statement === statement)
            : this.parameterizedResourceIterations.length > 0;
    }

    public parameterizedResourceLoop(
        statement: ResourceLoop,
        knownIterations?: number,
    ): ParameterizedResourceLoop | undefined {
        if (this.isInRuntimeControlFlow() && !this.isInParameterizedResourceLoop()) {
            return undefined;
        }
        if (!this.requiresStaticIteration(statement.statement)) return undefined;
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
        const firstMesh = this.sceneMeshes.length;
        const firstMaterial = this.sceneMaterials.count;
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
        const meshes = this.sceneMeshes.slice(firstMesh);
        const materials = this.sceneMaterialGltfAssetsBefore.slice(firstMaterial);
        if (meshes.length === 0 && materials.length === 0) return;
        const totalMeshes = firstMesh + meshes.length * iterations;
        const totalMaterials = firstMaterial + materials.length * iterations;
        this.staticExpansionBudget.checkComposition(statement, totalMeshes, totalMaterials);
        for (let iteration = 1; iteration < iterations; ++iteration) {
            for (const [offset, mesh] of meshes.entries()) {
                const source = firstMesh + offset;
                const index = this.sceneMeshes.length;
                this.sceneMeshes.push({ ...mesh });
                const material = this.sceneMeshMaterials.get(source);
                if (material) {
                    this.recordSceneMeshMaterial(index, {
                        ...material,
                        standardMaterial: mesh.standardMaterial === true,
                        standardMaterialPluginIndex: mesh.standardMaterialPluginIndex,
                        sceneShaderVariant: mesh.shaderVariant,
                        sceneShaderVariants: mesh.shaderVariants,
                    });
                }
                if (this.shadowReceiverMeshes.has(source)) {
                    this.shadowReceiverMeshes.add(index);
                }
            }
            for (const loadCount of materials) {
                this.sceneMaterialGltfAssetsBefore.push(loadCount);
                this.sceneMaterials.recordSceneMaterialSlot();
            }
        }
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
        if (this.lookupOptional(identifier)) {
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
            ? this.lookupOptional(ownerExpression)
            : ownerExpression.kind === ts.SyntaxKind.ThisKeyword
              ? this.activeThis()
              : ts.isPropertyAccessExpression(ownerExpression)
                ? (this.resolveRecordMember(ownerExpression) ??
                  this.lookupRecordProperty(ownerExpression))
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
        return declared !== undefined && (declared.flags & ts.SymbolFlags.Optional) !== 0
            ? { kind: "json-null", cpp: "std::nullopt" }
            : undefined;
    }

    public resolveRecordValue(expression: ts.Expression): Value | undefined {
        const unwrapped = this.unwrap(expression);
        const value = ts.isIdentifier(unwrapped)
            ? this.lookupOptional(unwrapped) ?? compileWindowIdentity(this, unwrapped) ?? browserEnvironmentValue(this, unwrapped)
            : unwrapped.kind === ts.SyntaxKind.ThisKeyword
              ? this.activeThis()
              : ts.isPropertyAccessExpression(unwrapped)
                ? this.resolveRecordMember(unwrapped) ?? browserEnvironmentValue(this, unwrapped)
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
    public captureRecordScopes(): Pick<Value, "recordScopes" | "recordTypeArguments"> {
        const recordTypeArguments = this.dataTypes.captureTypeArguments();
        return {
            recordScopes: [...this.variableScopes],
            ...(recordTypeArguments ? {recordTypeArguments} : {}),
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
        const saved = [...this.variableScopes];
        const previousThis = this.activeThis();
        if (owner.recordScopes) {
            this.variableScopes.length = 0;
            this.variableScopes.push(...owner.recordScopes);
        }
        if (bindThis) {
            this.defineThis(owner);
        }
        try {
            return this.dataTypes.withTypeArguments(owner.recordTypeArguments, work);
        } finally {
            this.defineThis(previousThis);
            if (owner.recordScopes) {
                this.variableScopes.length = 0;
                this.variableScopes.push(...saved);
            }
        }
    }

    /**
     * Reads a record getter by evaluating its accessor at the read
     * site, with the record's own scope restored. The subset covers
     * the shape the reached records use: a single `return` of an
     * expression over the state the record closed over.
     */
    private compileRecordGetter(
        owner: Value,
        accessor: ts.GetAccessorDeclaration,
    ): Value {
        const statements = accessor.body?.statements ?? [];
        const [only] = statements;
        if (
            statements.length !== 1 ||
            !only ||
            !ts.isReturnStatement(only) ||
            !only.expression
        ) {
            this.fail(
                accessor,
                `Getter '${accessor.name.getText()}' must be a single return statement.`,
            );
        }
        const expression = only.expression;
        return this.withRecordScopes(owner, () => {
            const previousThis = this.activeThis();
            // A getter's `this` is its receiver for both class instances and
            // object-literal accessors. The record may have crossed a return
            // boundary that copied its compile-time Value wrapper, so its
            // identity in classInstances is not a reliable dispatch guard.
            this.defineThis(owner);
            try {
                // A getter is an evaluation, even when its return happens
                // to lower to a field read. Optional chains must consume it
                // once and keep any nested method calls behind their guard.
                return { ...this.compileValue(expression), impure: true };
            } finally {
                this.defineThis(previousThis);
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
        name: ts.Identifier,
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
                !this.lookupOptional(unwrappedInitializer)
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
            this.emit(
                sharedStorage
                    ? `auto ${cppName} = bbl::js::make_gc_shared<std::optional<${nullableResource.cppType}>>();`
                    : `std::optional<${nullableResource.cppType}> ${cppName};`,
            );
            this.defineVariable(name, valueForKind(nullableResource.kind, {
                cpp: `(*${storage})`,
                ...((nullableResource.kind === "ui-element" ||
                    nullableResource.kind === "pointer-drag") &&
                this.defaultEngineCpp
                    ? { engineCpp: this.defaultEngineCpp }
                    : {}),
                optionalFoundCpp: `${storage}.has_value()`,
                optionalStorageCpp: storage,
                ...(sharedStorage ? { sharedStorageCpp: cppName } : {}),
            }));
            return;
        }
        if (this.bindClassDataField(name, initializer, declared)) {
            return;
        }
        this.bindLocalOrParameterValue(
            name,
            nullableInitializer ?? this.compileValue(initializer),
            false,
            this.allocateTemporaryCppName(`class_field_${name.text}`),
            sharedStorage,
        );
    }

    private classFieldNeedsSharedStorage(name: ts.Identifier): boolean {
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
    public bindNullableClassField(name: ts.Identifier): Value | undefined {
        const resource = this.nullableResourceKind(name);
        if (!resource) return undefined;
        const sharedStorage = this.classFieldNeedsSharedStorage(name);
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        const storage = sharedStorage ? `(*${cppName})` : cppName;
        this.emit(
            sharedStorage
                ? `auto ${cppName} = bbl::js::make_gc_shared<std::optional<${resource.cppType}>>();`
                : `std::optional<${resource.cppType}> ${cppName};`,
        );
        const value: Value = valueForKind(resource.kind, {
            cpp: `(*${storage})`,
            ...((resource.kind === "ui-element" ||
                resource.kind === "pointer-drag") &&
            this.defaultEngineCpp
                ? { engineCpp: this.defaultEngineCpp }
                : {}),
            optionalFoundCpp: `${storage}.has_value()`,
            optionalStorageCpp: storage,
            ...(sharedStorage ? { sharedStorageCpp: cppName } : {}),
        });
        this.defineVariable(name, value);
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
        name: ts.Identifier,
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
        value.nativeLvalue = true;
        if (sharedStorage) value.sharedStorageCpp = cppName;
        this.defineVariable(name, value);
        return value;
    }

    /** Predeclare optional storage for a resource-valued expression. */
    public bindOptionalResourceValue(name: ts.Identifier): Value | undefined {
        const resource = this.nullableResourceKind(name, true);
        if (!resource) return undefined;
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        this.emit(`std::optional<${resource.cppType}> ${cppName};`);
        const value: Value = valueForKind(resource.kind, {
            cpp: `(*${cppName})`,
            ...((resource.kind === "ui-element" ||
                resource.kind === "pointer-drag") &&
            this.defaultEngineCpp
                ? { engineCpp: this.defaultEngineCpp }
                : {}),
            optionalFoundCpp: `${cppName}.has_value()`,
            optionalStorageCpp: cppName,
        });
        this.defineVariable(name, value);
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
        name: ts.Identifier,
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
            ? this.dataLowerer.compileKnownValueForSink(knownValue, dataType, initializer)
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
        value.nativeLvalue = true;
        if (sharedStorage) value.sharedStorageCpp = cppName;
        this.defineVariable(name, value);
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
        instance.classDeclaration = declaration;
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
            return { kind: "callback", cpp: cppName,
                nativeCaptures: [this.registerNativeBinding(cppName, false, true)] };
        }
        const owner = `${cppName}_owner`;
        this.emit(
            { kind: "declaration", type: "auto", name: owner, initializer: `bbl::js::make_gc_shared<${type}>()` },
        );
        return { kind: "callback", cpp: `(*${owner})`, sharedStorageCpp: owner,
            nativeCaptures: [this.registerNativeBinding(owner)] };
    }

    /** Commit a successful probe; restore all compiler-owned state on decline or throw. */
    public probeEmission<T>(
        probe: () => T,
        answered: (result: T) => boolean = (result) => result !== undefined,
    ): T {
        return new EmissionTransaction(this, [this.program, this.checker, this.sourceFile, this.options])
            .run(probe, answered);
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

    /** How many lines the body stream holds, for a caller that may undo. */

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
    private activeEmissionScope = 0;
    private nextEmissionScope = 1;

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
                owner.runtimeRecordCpp =
                    this.allocateTemporaryCppName("record_table");
                owner.runtimeRecordScope = this.activeEmissionScope;
                this.emit(
                    `${mapType} ${owner.runtimeRecordCpp}{${entries.join(", ")}};`,
                );
            }
            return owner.runtimeRecordCpp;
        }
        const initializer = `${mapType} values{${entries.join(", ")}};`;
        const existing = this.staticRecordAccessors.get(initializer);
        if (existing) return `bblscene::${existing}()`;
        const name = `bbl_static_table_${this.staticRecordAccessors.size}`;
        this.registerNativeFunction(`${mapType}& ${name}();`, [
            `${mapType}& ${name}() {`,
            `    static ${initializer}`,
            `    return values;`,
            `}`,
        ]);
        this.staticRecordAccessors.set(initializer, name);
        return `bblscene::${name}()`;
    }

    public registerNativeFunction(
        prototype: string,
        definitionLines: string[],
    ): void {
        this.nativeFunctionPrototypes.push(prototype);
        this.nativeFunctionDefinitions.push(...definitionLines, "");
    }

    public registerSharedNativeFunction(name: string, definitionLines: string[], localBindings: readonly string[]): string {
        const entry = this.sharedNativeFunctions.intern(name, definitionLines.join("\n"), new Set(localBindings));
        if (entry.added) this.registerNativeFunction("", definitionLines);
        return entry.name;
    }

    public beginNativeFunctionBody(
        returnType: DataType | undefined,
        contextualVoid = false,
        options: NativeFunctionBodyOptions = {},
    ): void {
        if (options.callSiteEffects && !this.definiteCollectionMutation()) {
            throw new Error("Shared call effects require a definite source invocation.");
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

    public registerNativeBinding(name: string, borrowed = false, allowReference = false): NativeCaptureBinding {
        const existing = this.nativeBindings.get(name);
        if (existing) return existing;
        const binding = { name, borrowed, allowReference, sequence: ++this.nextNativeBindingSequence,
            entryLifetime: this.variableScopes.length === 1 && this.activeEmissionScope === 0 && !this.engineStartMark };
        this.nativeBindings.set(name, binding);
        if (this.engineStartMark && this.indentLevel === this.engineStartMark.indentLevel) {
            this.continuationLocals.set(name, this.continuationSequence);
        }
        return binding;
    }

    public nativeBindingCheckpoint(): number {
        return this.nextNativeBindingSequence;
    }

    public captureHoistedLines(emitBody: () => void, beforeBody: number, site: ts.Node): string[] {
        const beforeGuard = this.nextNativeBindingSequence;
        const dependencies = new EmissionSet<NativeCaptureBinding>();
        this.nativeDependencyStack.push(dependencies);
        let lines: string[];
        try {
            lines = this.captureEmittedLines(emitBody);
        } finally {
            this.nativeDependencyStack.pop();
        }
        for (const binding of dependencies) {
            if (binding.sequence > beforeBody && binding.sequence <= beforeGuard) {
                this.fail(site,
                    `A hoisted finally guard cannot reference native local '${binding.name}' ` +
                    "declared inside its try/catch body; declare retained native state before the try.");
            }
        }
        return lines;
    }

    private describeNativeValue(value: Value): void {
        this.nativeStoredValues.add(value);
        const storage = value.sharedStorageCpp ??
            (cppIdentifierPattern.test(value.cpp) ? value.cpp : value.optionalStorageCpp ?? value.cpp);
        if (isCompileTimeOnlyValue(value.kind) || value.kind === "browser" ||
            !cppIdentifierPattern.test(storage) || ["true", "false", "nullptr"].includes(storage)) return;
        value.nativeCaptures = [this.registerNativeBinding(storage, value.kind === "engine" && !value.ownedEngineCpp,
            value.sharedStorageCpp === undefined)];
        for (const key of nativeCompanionKeys) {
            const companion = value[key];
            if (companion && cppIdentifierPattern.test(companion) &&
                !["true", "false", "nullptr"].includes(companion)) {
                this.registerNativeBinding(companion, key === "engineCpp");
            }
        }
    }

    private useNativeBinding(binding: NativeCaptureBinding): void {
        // Stored Values keep their own home rather than initializer dependencies.
        // Propagate reads here so a parent expression still sees those reads when
        // its child returns an existing stored Value.
        for (const dependencies of this.nativeDependencyStack) dependencies.add(binding);
        for (const capture of this.managedCaptures) capture.use(binding);
        for (const dependencies of this.statementDependencies) dependencies.add(binding);
        if (this.engineStartMark) {
            let sequences = this.continuationUses.get(binding.name);
            if (!sequences) { sequences = new EmissionSet(); this.continuationUses.set(binding.name, sequences); }
            sequences.add(this.continuationSequence);
        }
    }

    public useNativeValue(value: Value, seen = new EmissionSet<Value>()): void {
        if (seen.has(value)) return;
        seen.add(value);
        if (value.kind !== "record" && value.kind !== "tuple") {
            for (const binding of value.nativeCaptures ?? []) this.useNativeBinding(binding);
            const binding = this.nativeBindings.get(value.cpp);
            if (binding) this.useNativeBinding(binding);
        }
        for (const key of nativeCompanionKeys) {
            const companion = value[key];
            if (companion === undefined) continue;
            const dependencies = value.nativeCompanionCaptures?.[key];
            if (dependencies) {
                for (const binding of dependencies) this.useNativeBinding(binding);
            } else {
                const binding = this.nativeBindings.get(companion);
                if (binding) this.useNativeBinding(binding);
            }
        }
        if (value.kind === "record") {
            if (value.sceneNodeVector) this.useNativeValue(value.sceneNodeVector.owner, seen);
            if (value.cameraVector) this.useNativeValue(value.cameraVector.owner, seen);
            for (const field of Object.values(value.recordProperties ?? {})) this.useNativeValue(field, seen);
        }
        if (value.kind === "tuple") {
            for (const field of value.tupleElements ?? []) this.useNativeValue(field, seen);
        }
        for (const expression of value.materialUboArrayFields?.values() ?? []) {
            for (const binding of expression.nativeCaptures) this.useNativeBinding(binding);
        }
    }

    public captureNativeExpression(compile: () => string): import("./compiler/closure-captures.js").NativeExpression {
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
            this.allocateTemporaryCppName("environment"), this.nextNativeBindingSequence, byReference);
        this.managedCaptures.push(capture);
        const deferred = this.frameCallbackDepth > 0 &&
            !this.deferredResourceCaptureDepths.has(this.frameCallbackDepth)
            ? this.checkpointResourceConstruction()
            : undefined;
        if (deferred) this.deferredResourceCaptureDepths.add(deferred.callbackDepth);
        let lines: string[];
        try {
            lines = this.captureEmittedLines(emitBody);
        } finally {
            if (deferred) {
                this.deferredResourceCaptureDepths.delete(deferred.callbackDepth);
                this.resourceConstructionCheckpoints.delete(deferred);
                this.excludeDeferredResourceConstruction(deferred);
            }
            this.managedCaptures.pop();
        }
        const identifiers = capture.retainReferenced(lines);
        const localBindings = [...identifiers].filter(name =>
            (this.nativeBindings.get(name)?.sequence ?? 0) > capture.boundary);
        return {
            lines: [...capture.declarations, ...lines],
            environment: capture.environment,
            initializer: capture.initializer,
            nativeCaptures: capture.nativeCaptures,
            localBindings: [capture.environment, ...capture.nativeCaptures.map(binding => binding.name), ...localBindings],
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

    /**
     * Feature/fact writes such as thin-instance updates are not construction.
     * Only changes to generation-owned ordinals or baked work make a helper's
     * runtime return invalidate the surrounding static iteration count.
     */
    private resourceConstructionState(): ResourceConstructionState {
        return { counters: [
            this.sceneMeshes.length - this.runtimeMeshProfileCount,
            this.sceneMaterials.count - this.runtimeMaterialProfiles.size,
            this.shadowGenerators.length,
            // Packaged files are deduplicated inputs, not runtime allocation
            // ordinals. Closed-directory discovery can happen inside a loop.
            this.currentGltfAssetCount(),
            this.reachedShaderPrograms.length - this.runtimeShaderProfiles.size,
            this.reachedNodeMaterials.length - this.runtimeNodeProfiles.size,
            this.reachedEffects_.length,
            this.geometryOutputTasks.length,
            this.postProcessTasks.length,
            this.postProcessComposites.length,
            this.sceneSpriteCustomShaders.length,
            this.reachedNodeParticles.steps.length,
            this.reachedNodeParticles.registrations.length,
            this.reachedNodeParticles.textures.length,
            this.reachedNodeParticles.sprite2d.length,
            // Construction/bake entries are append-only during lowering.
            // Their counts detect changes without rehashing immutable graphs.
            this.reachedNodeParticles.sets.length,
            this.reachedNodeParticles.billboards.length,
        ], lightIdentities: this.sceneLights.map(({ identity }) => identity) };
    }

    private checkpointResourceConstruction(): ResourceConstructionCheckpoint {
        const checkpoint = {
            state: this.resourceConstructionState(),
            callbackDepth: this.frameCallbackDepth,
        };
        this.resourceConstructionCheckpoints.add(checkpoint);
        return checkpoint;
    }

    /** Compiling a retained callback does not execute its construction in the enclosing loop. */
    private excludeDeferredResourceConstruction(before: ResourceConstructionCheckpoint): void {
        const after = this.resourceConstructionState();
        const removed = new EmissionSet(before.state.lightIdentities.filter((value) => !after.lightIdentities.includes(value)));
        const added = after.lightIdentities.filter((value) => !before.state.lightIdentities.includes(value));
        for (const checkpoint of this.resourceConstructionCheckpoints) {
            if (checkpoint.callbackDepth >= before.callbackDepth) continue;
            for (const [index, baseline] of checkpoint.state.counters.entries()) {
                checkpoint.state.counters[index] = baseline + after.counters[index]! - before.state.counters[index]!;
            }
            checkpoint.state.lightIdentities = checkpoint.state.lightIdentities.filter((value) => !removed.has(value));
            checkpoint.state.lightIdentities.push(...added);
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
        const state = this.resourceConstructionState();
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
            this.emit(coroutine ? "co_return bbl::js::PromiseVoid{};" : "return;");
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
            this.emit(`${returnKeyword} ${frame.compileReturn(statement.expression, returnType)};`);
            return;
        }
        if (returnType.kind === "number") {
            this.emit(
                `${returnKeyword} ${this.compileNumber(statement.expression, "double")};`,
            );
            return;
        }
        if (returnType.kind === "boolean") {
            this.emit(`${returnKeyword} ${this.compileCondition(statement.expression)};`);
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

    public emitNativeThrow(errorCpp: string, node?: ts.ThrowStatement): void {
        const frame = this.returnFrames.at(-1);
        const type = frame?.kind === "native" && frame.coroutine
            ? frame.type === "void" ? "bbl::js::PromiseVoid" : this.dataTypes.cppType(frame.type)
            : this.asyncLowerer.isTerminalThrow(node) ? "bbl::js::PromiseVoid" : undefined;
        if (type) {
            this.emit(`co_return [&]() -> ${type} { throw ${errorCpp}; }();`);
        } else this.emit(`throw ${errorCpp};`);
    }

    public emitDataAssignment(expression: ts.BinaryExpression): boolean {
        return this.dataLowerer.emitAssignment(expression);
    }

    public emitDataPostfix(expression: ts.PostfixUnaryExpression): boolean {
        if (this.compileCameraMutation(expression)) return true;
        return this.dataLowerer.emitPostfixUnary(expression);
    }

    private compileCameraMutation(expression: ts.Expression): Value | undefined {
        const node = this.unwrap(expression);
        const unary = ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node);
        if (unary ? !isUpdateExpression(node) : !isAssignmentExpression(node)) return undefined;
        const left = this.unwrap(unary ? node.operand : (node as ts.BinaryExpression).left);
        const operator = unary ? (node.operator === ts.SyntaxKind.PlusPlusToken ? "+" :
            node.operator === ts.SyntaxKind.MinusMinusToken ? "-" : undefined) :
            ts.isBinaryExpression(node) ? CAMERA_MUTATION_OPERATORS.get(node.operatorToken.kind) : undefined;
        if ((!operator || ts.isElementAccessExpression(left)) && (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left))) {
            const owner = this.unwrap(left.expression);
            if (this.resolveRecordValue(owner)?.cameraVector || isCameraExpression(this, owner) ||
                (ts.isPropertyAccessExpression(owner) && ["target", "position", "upVector"].includes(owner.name.text) && isCameraExpression(this, owner.expression))) {
                this.untrackedTaaCameraWrites.push({ node: left, reason: "this camera mutation syntax does not invoke its pinned setter" });
            }
        }
        if (!operator || (!unary && !ts.isBinaryExpression(node))) return undefined;
        if (ts.isPropertyAccessExpression(left) && ["target", "position", "upVector", "parent"].includes(left.name.text) &&
            isCameraExpression(this, left.expression)) {
            this.untrackedTaaCameraWrites.push({ node: left, reason: `replacing camera.${left.name.text} changes its observable owner` });
        }
        const target = cameraNumberWrite(this, left);
        if (!target) return undefined;
        this.textCameraMutation ??= left;
        noteCameraRecordWrite(this, target.camera, target.property,
            unary ? undefined : node.right, operator === "=" && !["target", "position", "up_vector"].includes(target.property));
        if (target.property === "position" || target.property === "up_vector") {
            this.untrackedTaaCameraWrites.push({ node: left, reason: `camera.${target.property} is not the arc camera's observable target` });
        }
        let previous: string | undefined;
        if (operator !== "=") {
            previous = this.allocateTemporaryCppName("camera_previous");
            this.emit({ kind: "declaration", type: "const double", name: previous, initializer: target.current });
        }
        const right = unary ? "1.0" : this.compileNumber(node.right, "double");
        const value = this.allocateTemporaryCppName("camera_value");
        this.emit({ kind: "declaration", type: "const double", name: value, initializer: operator === "=" ? right : `(${previous} ${operator} ${right})` });
        this.emit(target.write(value));
        return { kind: "number", cpp: unary && ts.isPostfixUnaryExpression(node) ? previous! : value,
            dataType: { kind: "number" } };
    }

    public noteCameraVectorSet(vector: NonNullable<Value["cameraVector"]>, site: ts.Node): void {
        this.textCameraMutation ??= site;
        noteCameraRecordWrite(this, vector.owner, vector.field, undefined, false);
        if (vector.field !== "target") this.untrackedTaaCameraWrites.push({ node: site,
            reason: `camera.${vector.field} is not the arc camera's observable target` });
    }

    public noteCameraVectorCopy(value: Value, site: ts.Node): void {
        if (value.cameraVector) this.untrackedTaaCameraWrites.push({ node: site,
            reason: "an observable camera vector cannot be copied into a plain data aggregate" });
    }

    public noteTemporalAdmissionFailure(node: ts.Node, message: string): void {
        this.deferredAdmissionFailures.push({ capability: "taa", node, message });
    }

    public noteMaterialColorRead(property: "baseColorFactor" | "diffuseColor"): void {
        this.materialColorReads.push(property);
    }

    public noteMaterialColorObjectWrite(node: ts.Node, property: "baseColorFactor" | "diffuseColor"): void {
        this.deferredAdmissionFailures.push({capability: property, node,
            message: `Reading material.${property} requires retained numeric-array producers; the legacy color producer cannot preserve its source shape.`});
    }

    public noteMaterialColorRenderBoundary(node: ts.Node, reason: string, always = false): void {
        if (always || this.frameCallbackDepth > 0 || this.engineStartMark !== undefined || this.temporalSceneRegistration) {
            this.deferredAdmissionFailures.push({capability: "material-colors", node,
                message: `Numeric material-color reads do not yet represent per-group UBO snapshots for ${reason}.`});
        }
    }

    public noteTemporalRecordBoundary(node: ts.Node, reason: string, mode: "runtime" | "registration" | "always" = "runtime", scene?: Value): void {
        const runtime = this.frameCallbackDepth > 0 || this.engineStartMark !== undefined;
        if (mode === "always" || runtime || (mode !== "registration" && this.temporalSceneRegistration)) {
            this.noteTemporalAdmissionFailure(node, `TAA task record epochs are not represented for ${runtime ? `runtime ${reason}` : reason}.`);
        }
        if (runtime || (mode !== "registration" && this.temporalSceneRegistration) || reason === "rebuildSceneRenderables") {
            this.deferredAdmissionFailures.push({ capability: "node-input", node,
                message: `Node material binding snapshots do not cover ${runtime ? `runtime ${reason}` : reason}.` });
        }
        if (mode === "registration") {
            this.temporalSceneRegistration ??= node;
            const identity = scene?.sceneTopologyState;
            if (!identity || !this.temporalRegisteredScenes.includes(identity)) {
                if (!identity || this.temporalRegisteredScenes.length > 0) this.noteTemporalAdmissionFailure(node,
                    "TAA task record epochs are not represented for TAA supports one proven registered scene until per-scene update/record ordering is represented.");
                this.temporalRegisteredScenes.push(identity);
            }
        }
    }

    public noteTemporalCameraControl(node: ts.Node): void {
        if (this.temporalControlAttachment || this.frameCallbackDepth > 0 || this.engineStartMark !== undefined) {
            this.untrackedTaaCameraWrites.push({ node, reason: "TAA supports one startup control attachment until per-attachment inertia callbacks are represented" });
        }
        this.temporalControlAttachment ??= node;
    }

    private bindAudioMainBusStorage(value: Value): void {
        if (value.kind !== "audio-engine" ||
            (value.audioMainBusCpp === undefined && value.optionalStorageCpp === undefined)) return;
        const owner = value.sharedStorageCpp ??
            (cppIdentifierPattern.test(value.cpp) ? value.cpp : value.optionalStorageCpp) ?? value.cpp;
        if (value.audioMainBusOwnerCpp === owner) return;
        const name = this.allocateTemporaryCppName("audio_main_bus");
        const initial = value.audioMainBusCpp ?? "bbl::pal::AudioNodeHandle{}";
        const shared = value.sharedStorageCpp !== undefined;
        this.useNativeValue(value);
        this.emit(shared
            ? `[[maybe_unused]] auto ${name} = bbl::js::make_gc_shared<bbl::pal::AudioNodeHandle>(${initial});`
            : `[[maybe_unused]] bbl::pal::AudioNodeHandle ${name} = ${initial};`);
        value.audioMainBusCpp = shared ? `(*${name})` : name;
        value.audioMainBusOwnerCpp = owner;
        value.nativeCompanionCaptures = { ...value.nativeCompanionCaptures,
            audioMainBusCpp: [this.registerNativeBinding(name, false, !shared)] };
    }

    private assignAudioMainBus(target: Value, value: Value | undefined, node: ts.Node): void {
        if (target.kind !== "audio-engine") return;
        const destination = target.audioMainBusCpp ?? this.fail(node,
            "An audio engine assignment requires materialized main-bus storage.");
        const source = value
            ? value.audioMainBusCpp ?? this.fail(node,
                "An audio engine assignment requires its source main bus.")
            : "bbl::pal::AudioNodeHandle{}";
        const present = value?.optionalFoundCpp ??
            (value?.dataType?.kind === "optional" ? `${value.cpp}.has_value()` : undefined);
        this.emit(`${destination} = ${present
            ? `(${present}) ? ${source} : bbl::pal::AudioNodeHandle{}`
            : source};`);
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
    private optionalResourceCpp(value: Value): string {
        const cpp = value.ownedEngineCpp ?? value.cpp;
        return value.optionalFoundCpp !== undefined &&
            value.optionalFoundCpp !== "true"
            ? `(${value.optionalFoundCpp} ? std::optional{${cpp}} : std::nullopt)`
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
            this.emit(`if (${value.cpp}.has_value()) {`);
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
            target.engineCpp = value.engineCpp;
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
                delete target.sceneMeshIndex;
            } else {
                target.sceneMeshIndex = value.sceneMeshIndex;
            }
            if (value.runtimeMeshStreams === undefined) {
                delete target.runtimeMeshStreams;
            } else {
                target.runtimeMeshStreams = value.runtimeMeshStreams;
            }
            if (value.directMorphCompatible === undefined) {
                delete target.directMorphCompatible;
            } else {
                target.directMorphCompatible = value.directMorphCompatible;
            }
        }
        // The same alias rule applies when a material itself is first filled
        // through optional storage. These fields are the generation-time
        // identity and composition state paired with its native handle.
        if (target.kind === "material") {
            if (value.scenePbrMaterialIndex === undefined) {
                delete target.scenePbrMaterialIndex;
            } else {
                target.scenePbrMaterialIndex = value.scenePbrMaterialIndex;
            }
            if (value.assetPbrMaterial === undefined) {
                delete target.assetPbrMaterial;
            } else {
                target.assetPbrMaterial = value.assetPbrMaterial;
            }
            if (value.standardMaterial === undefined) {
                delete target.standardMaterial;
            } else {
                target.standardMaterial = value.standardMaterial;
            }
            if (value.standardMaterialPluginIndex === undefined) {
                delete target.standardMaterialPluginIndex;
            } else {
                target.standardMaterialPluginIndex =
                    value.standardMaterialPluginIndex;
            }
            if (value.standardMaterialInput === undefined) {
                delete target.standardMaterialInput;
            } else {
                target.standardMaterialInput = value.standardMaterialInput;
            }
            if (value.nodeMaterialIndex === undefined) {
                delete target.nodeMaterialIndex;
            } else {
                target.nodeMaterialIndex = value.nodeMaterialIndex;
            }
            if (value.sceneShaderVariant === undefined) {
                delete target.sceneShaderVariant;
            } else {
                target.sceneShaderVariant = value.sceneShaderVariant;
            }
        }
        if (value.asset === undefined) delete target.asset;
        else target.asset = value.asset;
        if (value.assetRootState === undefined) delete target.assetRootState;
        else target.assetRootState = value.assetRootState;
        if (value.assetRootClone === undefined) delete target.assetRootClone;
        else target.assetRootClone = value.assetRootClone;
        if (target.kind === "ui-element") {
            if (value.uiStaticId === undefined) delete target.uiStaticId;
            else target.uiStaticId = value.uiStaticId;
            if (value.uiTag === undefined) delete target.uiTag;
            else target.uiTag = value.uiTag;
        }
        if (value.spriteDepthMode === undefined) {
            delete target.spriteDepthMode;
        } else {
            target.spriteDepthMode = value.spriteDepthMode;
        }
        if (value.textureStorage !== undefined) {
            target.textureStorage = value.textureStorage;
            if (value.textureWidth !== undefined) {
                target.textureWidth = value.textureWidth;
            }
            if (value.textureHeight !== undefined) {
                target.textureHeight = value.textureHeight;
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
            delete target.spriteDepthMode;
            return true;
        }
        const value = this.compileValue(right);
        if (value.kind === "json-null") {
            this.emit(`${storage}.reset();`);
            this.assignAudioMainBus(target, undefined, right);
            delete target.spriteDepthMode;
            return true;
        }
        this.assignOptionalResourceValue(target, value, right);
        return true;
    }

    public dataIterationTarget(expression: ts.Expression, knownTuple?: Value):
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
        return canShareFunctionBody(this, body, this.definiteCollectionMutation());
    }

    public canReplaySharedCallEffects(body: ts.Node): boolean {
        return this.definiteCollectionMutation() && sharedFunctionHasCallEffects(this, body);
    }

    public compileSharedMethod(declaration: ts.MethodDeclaration, call: ts.CallExpression, arguments_: readonly Value[]): Value | undefined {
        return this.userFunctions.compileSharedMethod(this, declaration, call, arguments_);
    }

    public emitNativeDataIteration<T>(statement: ts.Statement, emitBody: () => T): T {
        const checkpoint = this.checkpointResourceConstruction();
        let emitted: T;
        try {
            emitted = emitBody();
        } finally {
            this.resourceConstructionCheckpoints.delete(checkpoint);
        }
        const after = this.resourceConstructionState();
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
     * The engine collection an expression names, resolved through the
     * declarative table in `properties.ts` rather than by testing one
     * property name here. A collection the table does not carry returns
     * undefined, so for-of falls through to the plain-data and
     * static-literal paths.
     */
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
            (identifier, value) => this.defineVariable(identifier, value),
        );
    }

    public registerAsset(
        source: string,
        kind: CompileAsset["kind"],
        faceSize?: number,
    ): CompileAsset {
        return registerAsset(this, source, kind, faceSize);
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
        for (const state of assetRootMutationStates(root)) state.reparented = true;
    }

    /**
     * The current root setters address the asset's outer transform. After
     * `setParent`, the hierarchy follows the new TransformNode instead, so a
     * later write through the old root handle would mutate stale state.
     */
    public assertAssetRootWritable(root: Value, node: ts.Node): void {
        if (assetRootMutationStates(root).some(state => state.reparented)) {
            this.fail(
                node,
                "Writing an imported root after setParent is not lowered; " +
                    "the hierarchy now follows its new TransformNode parent.",
            );
        }
    }

    public enableGltfCameras(node: ts.Node): void {
        if (!this.definiteCollectionMutation()) {
            this.fail(node, "glTF camera activation requires a definite setup call; runtime activation order is not represented by packaged assets.");
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
        asset.containerCount = (asset.containerCount ?? 0) + 1;
        if (this.hasFeature("loader:gltf-cameras")) asset.gltfCameras = true;
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
        asset.selectedVariant = variantName;
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
        asset.sceneUnlit = tint ? { tint } : {};
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
        if (!this.defaultEngineCpp && ts.isPropertyAccessExpression(unwrapped) &&
            CANVAS_SIZE_AXES.has(unwrapped.name.text)) {
            const owner = this.evaluateBrowserValue(unwrapped.expression);
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

    public isBrowserOnlyExpression(expression: ts.Expression): boolean {
        const unwrapped = this.unwrap(expression);
        const candidate =
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
                ? this.unwrap(unwrapped.left)
                : unwrapped;
        if (ts.isCallExpression(candidate)) {
            const callee = this.unwrap(candidate.expression);
            if (
                ts.isPropertyAccessExpression(callee) &&
                callee.name.text === "getGamepads" &&
                ts.isIdentifier(callee.expression) &&
                callee.expression.text === "navigator" &&
                this.isDefaultLibraryIdentifier(callee.expression)
            ) {
                return false;
            }
        }
        return this.browserErasure.isBrowserOnlyExpression(expression);
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
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
            if (other) return "skip";
            if (
                ts.isCallExpression(node) &&
                this.browserErasure.isDefaultRequestAnimationFrameCall(node) &&
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

    public isBrowserDomValue(expression: ts.Expression): boolean {
        const type = this.checker.getTypeAtLocation(expression);
        const members =
            (type.flags & ts.TypeFlags.Union) !== 0
                ? (type as ts.UnionType).types
                : [type];
        if (
            members.some(
                (member) =>
                    member.symbol?.name === "Gamepad" ||
                    member.symbol?.name === "GamepadButton",
            )
        ) {
            return false;
        }
        const directlyDom = members.some((member) =>
            (member.symbol?.declarations ?? []).some((declaration) =>
                /(?:^|[\\/])lib\.dom\.d\.ts$/i.test(
                    declaration.getSourceFile().fileName,
                ),
            ),
        );
        if (directlyDom) return true;
        const unwrapped = this.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            const bound = this.lookupOptional(unwrapped);
            if (
                bound &&
                bound.kind !== "browser" &&
                (bound.kind !== "node-particle-2d-binding" ||
                    bound.nodeParticleLive)
            ) {
                // A local function can bridge DOM setup and return an ordinary
                // native record. Once that record is bound, its data fields do
                // not become browser-only merely because the initializer also
                // registered DOM listeners.
                return false;
            }
            const declaration =
                this.symbols.valueSymbol(unwrapped)?.valueDeclaration;
            if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                declaration.initializer !== unwrapped &&
                this.isBrowserOnlyExpression(declaration.initializer)
            ) {
                return true;
            }
        }
        return (
            (ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped)) &&
            this.isBrowserDomValue(unwrapped.expression)
        );
    }

    public isNativeBrowserFileExpression(expression: ts.Expression): boolean {
        return isNativeBrowserFileExpression(this, expression);
    }

    /** See `BrowserErasure.isDeferredCallbackCall`. */
    public isDeferredCallbackCall(call: ts.CallExpression): boolean {
        return this.browserErasure.isDeferredCallbackCall(call);
    }

    public evaluateBrowserCondition(
        expression: ts.Expression,
    ): boolean | undefined {
        const condition =
            this.browserErasure.evaluateBrowserCondition(expression);
        this.recordBrowserExpression(expression);
        return condition;
    }

    public evaluateBrowserValue(
        expression: ts.Expression,
    ): Value["browserValue"] | undefined {
        const value = this.browserErasure.evaluateBrowserValue(expression);
        this.recordBrowserExpression(expression);
        return value;
    }

    private recordBrowserExpression(expression: ts.Expression): void {
        this.erasedBrowserExpressions.add(this.unwrap(expression).pos);
    }

    public isBrowserInstrumentationCall(call: ts.CallExpression): boolean {
        const callee = this.unwrap(call.expression);
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === "addEventListener") {
            const device = this.unwrap(callee.expression);
            if (ts.isPropertyAccessExpression(device) && device.name.text === "_device" &&
                ts.isIdentifier(device.expression) && this.lookupOptional(device.expression)?.kind === "engine") return false;
        }
        if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "assign" &&
            ts.isIdentifier(call.expression.expression) && call.expression.expression.text === "Object" &&
            this.isDefaultLibraryIdentifier(call.expression.expression)) {
            // This erased browser helper cannot invoke observable setters,
            // including through a helper-returned camera/vector argument.
            this.untrackedTaaCameraWrites.push({ node: call, reason: "Object.assign does not lower observable camera setters" });
        }
        return this.browserErasure.isBrowserInstrumentationCall(call);
    }

    public platformDocumentHidden(): string | undefined {
        return this.platformDocumentHiddenCpp;
    }

    /** Platform-backed browser APIs that remain ordinary expression values. */
    public isPrimaryCanvas2DContextCall(call: ts.CallExpression): boolean {
        return this.browserErasure.isPrimaryCanvas2DContextCall(call, expression => this.evaluateBrowserValue(expression));
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

    public requireCompatibleFrameConductor(owner: "manager" | "persistent", site: ts.Node): void {
        return this.platform.requireCompatibleFrameConductor(owner, site);
    }

    public emitPlatformEventListener(call: ts.CallExpression): boolean {
        return this.platform.emitPlatformEventListener(call);
    }

    private platformEventCallbackIdentity(
        callback: Value,
        node: ts.Node,
    ): string {
        return this.platform.platformEventCallbackIdentity(callback, node);
    }

    /**
     * Whether every member of an expression's type is one of the two canvas
     * types. A member whose symbol has no name is not a canvas, so it fails
     * the test rather than being compared under an empty name.
     */
    public isCanvasElement(expression: ts.Expression): boolean {
        const type = this.checker.getTypeAtLocation(expression);
        const members = type.isUnion() ? type.types : [type];
        return (
            members.length > 0 &&
            members.every((member) => {
                const name = member.getSymbol()?.getName();
                return name !== undefined && CANVAS_TYPE_NAMES.has(name);
            })
        );
    }

    private readonly hoistedCallbackBindings = new EmissionSet<ts.Symbol>();

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
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, (node) => {
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
                    !this.lookupOptional(declaration.name)
                ) {
                    candidates.set(symbol, declaration);
                }
            }
        });
        visit(callback);
        for (const [symbol, declaration] of candidates) {
            this.emitVariableDeclaration(declaration);
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
        const stored = this.probeEmission(() => {
            const value = this.compileValue(callback);
            return value.kind === "data" && value.dataType?.kind === "function" ? value : undefined;
        });
        if (stored) {
            this.refuseEscapingPlatformEventCapturesIn(callback);
            const snapshot = this.allocateTemporaryCppName("platform_callback");
            this.emit({ kind: "declaration", type: "const auto", name: snapshot, initializer: stored.cpp });
            const binding = this.registerNativeBinding(snapshot);
            const closure = this.captureManagedClosureLines(() => {
                if (parameter) this.registerNativeBinding(parameter.name);
                this.useNativeBinding(binding);
                this.emitDiscardedValue(this.dataLowerer.compileFunctionValueCall({...stored, cpp:snapshot}, values, callback));
            }, captureByValue ? false : "entry");
            return { identity: assignIdentity ? this.platformEventCallbackIdentity({...stored, cpp:snapshot}, callback) : "0u",
                cpp: renderClosure(closure, parameter ? `[[maybe_unused]] ${parameter.cppType} ${parameter.name}` : "") };
        }
        const previousHidden = this.platformDocumentHiddenCpp;
        const previousFrameFloor = this.frameCallbackScopeFloor;
        const previousPlatformEventCaptureFloor =
            this.escapingPlatformEventCaptureFloor;
        if (this.frameCallbackDepth === 0) {
            this.frameCallbackScopeFloor = this.variableScopes.length;
        } else {
            this.escapingPlatformEventCaptureFloor = this.variableScopes.length;
        }
        this.refuseEscapingPlatformEventCapturesIn(callback);
        // The scan above compares against the enclosing handler's live scope
        // chain. Callback records may restore the scope chain they closed over
        // while their own body is compiled, so that numeric floor cannot stay
        // active across the restore. Any callback created by this body performs
        // its own scan against the restored chain before it escapes.
        this.escapingPlatformEventCaptureFloor =
            previousPlatformEventCaptureFloor;
        this.platformDocumentHiddenCpp = documentHiddenCpp;
        this.frameCallbackDepth += 1;
        let compiled: CapturedClosure;
        let identity: string | undefined;
        try {
            compiled = this.captureManagedClosureLines(() => {
                if (parameter) this.registerNativeBinding(parameter.name);
                const unwrapped = this.unwrap(callback) as
                    | ts.Identifier
                    | ts.PropertyAccessExpression
                    | ts.ArrowFunction
                    | ts.FunctionExpression;
                const bound = ts.isIdentifier(unwrapped)
                    ? (this.lookupOptional(unwrapped) ??
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
                if (
                    bound.kind === "callback" &&
                    !bound.callbackDeclaration &&
                    bound.cpp.length > 0
                ) {
                    const parameterTypes = bound.nativeCallbackParameterTypes;
                    if (
                        parameterTypes &&
                        parameterTypes.length !== values.length
                    ) {
                        this.fail(
                            callback,
                            "Stored platform callback received the wrong number of arguments.",
                        );
                    }
                    const argumentsCpp = values.map((value, index) => {
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
                    ? this.withRecordScopes(bound.callbackRecordOwner, compile)
                    : compile();
                this.emitDiscardedValue(result);
            }, captureByValue ? false : "entry");
        } finally {
            this.frameCallbackDepth -= 1;
            this.platformDocumentHiddenCpp = previousHidden;
            this.frameCallbackScopeFloor = previousFrameFloor;
            this.escapingPlatformEventCaptureFloor =
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
            cpp: renderClosure(compiled, cppParameter),
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
                ? declaration.body.statements[0]!.expression
                : undefined
            : declaration.body;
        return Boolean(returned && this.browserErasure.isFrameYield(returned));
    }

    public frameDrainCondition(
        expression: ts.Expression,
    ): ts.Expression | undefined {
        return this.browserErasure.frameDrainCondition(expression);
    }

    public emitFramePollAwait(call: ts.CallExpression): boolean {
        if (!ts.isIdentifier(call.expression)) return false;
        const declaration = tryResolveFunctionDeclaration(this.checker, call.expression);
        if (!declaration?.body || !ts.isBlock(declaration.body) || declaration.body.statements.length !== 1) return false;
        const returned = declaration.body.statements[0]!;
        if (!ts.isReturnStatement(returned) || !returned.expression) return false;
        const poll = framePollExecutor(this.unwrap(returned.expression), this.checker, identifier => this.isDefaultLibraryIdentifier(identifier));
        if (!poll) return false;
        if (!this.engineStartMark) this.fail(call, "A polling Promise requires a running engine.");
        const args = call.arguments.map(argument => this.compileValue(argument));
        this.pushScope(this.allocateBlockPrefix());
        let condition: string;
        try {
            for (const [index, parameter] of declaration.parameters.entries()) {
                if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) this.fail(parameter, "Polling helper requires ordinary named parameters.");
                const argument = args[index] ?? (parameter.initializer ? this.compileValue(parameter.initializer) : undefined);
                if (!argument) this.fail(call, "Polling helper argument is missing.");
                this.bindLocalValue(parameter.name, argument);
            }
            for (const statement of poll.setup) this.emitStatement(statement);
            let conditionCpp = "";
            const lines = this.captureEmittedLines(() => { conditionCpp = this.compileCondition(poll.condition); });
            condition = lines.length === 0 ? conditionCpp : `([&]() { ${lines.join(" ")} return ${conditionCpp}; }())`;
        } finally { this.popScope(); }
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
    private emitEscapingResolvePromise(
        declaration: ts.VariableDeclaration,
        cppName: string,
    ): boolean {
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
        const bound = this.lookupOptional(target);
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
        this.emit({ kind: "declaration", type: "bool", name: cppName, initializer: "false" });
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
        for (const binding of this.statementDependencies.at(-1) ?? []) this.useNativeBinding(binding);
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

    public lookupOptional(identifier: ts.Identifier): Value | undefined {
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) {
            return undefined;
        }
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            const binding = this.variableScopes[index]!.get(symbol);
            if (binding) {
                // A deferred callback runs after the frame that created
                // it has returned, so a name bound inside that frame is
                // dead storage by then. The emitted lambda captures by
                // reference, so this would compile clean and read freed
                // memory; it refuses instead. Escaping captures are
                // unsolved generally (see TODO), and this is the one
                // place the reached slice can walk into them.
                this.refuseDeadDeferredCapture(
                    identifier,
                    index,
                    binding.frameLocal === true,
                );
                this.refuseEscapingPlatformEventCapture(
                    identifier,
                    index,
                    binding.value,
                );
                this.refusePoisonedRebind(identifier, binding);
                this.useNativeValue(binding.value);
                return binding.value;
            }
        }
        return undefined;
    }

    /**
     * A read of a handle a nested callback pointed somewhere else.
     *
     * The storage the outer name reads is the one that callback wrote, but
     * whether it wrote is a run-time question -- so the identity this
     * binding still carries describes the value only on one of the two
     * paths. Composition is decided from that identity, so a wrong guess
     * would stamp a material onto the wrong mesh with nothing to show for
     * it; refusing is what makes the rebind safe to allow at all.
     */
    private refusePoisonedRebind(
        identifier: ts.Identifier,
        binding: VariableBinding,
    ): void {
        if (!binding.reboundInNestedScope) return;
        this.fail(
            identifier,
            `'${identifier.text}' is read after a nested callback pointed ` +
                "it at a different handle, so which one it names depends " +
                "on whether that callback ran. Read it inside the callback, " +
                "or keep the new handle in its own name.",
        );
    }

    private refuseDeadDeferredCapture(
        identifier: ts.Identifier,
        scopeIndex: number,
        frameLocal: boolean,
    ): void {
        // Worker-enabled callbacks own their captures, including shared cells
        // for mutable bindings. Borrowed platform-event checks still apply.
        if (this.options.workers) return;
        if (
            frameLocal &&
            this.deferredCaptureFloor !== undefined &&
            this.deferredCaptureCeiling !== undefined &&
            scopeIndex >= this.deferredCaptureFloor &&
            scopeIndex < this.deferredCaptureCeiling
        ) {
            this.fail(
                identifier,
                `A deferred callback cannot name '${identifier.text}': ` +
                    "it is bound inside the callback that queued the " +
                    "timer, and that frame has returned by the time " +
                    "the timer runs. Bind it outside the enclosing " +
                    "callback.",
            );
        }
    }

    private refuseEscapingPlatformEventCapture(
        identifier: ts.Identifier,
        scopeIndex: number,
        value: Value,
        floor = this.escapingPlatformEventCaptureFloor,
    ): void {
        if (
            floor !== undefined &&
            scopeIndex < floor &&
            this.valueContainsPlatformEvent(value)
        ) {
            this.fail(
                identifier,
                `An escaping callback cannot capture platform event value ` +
                    `'${identifier.text}': the event is borrowed only while ` +
                    "its current handler executes. Copy the specific owned " +
                    "field needed by the later callback instead.",
            );
        }
    }

    private refuseEscapingPlatformEventCapturesIn(
        node: ts.Node,
        floor = this.escapingPlatformEventCaptureFloor ??
            (this.returnFrames.at(-1)?.kind === "native" ? this.variableScopes.length : undefined),
    ): void {
        if (floor === undefined) return;
        const roots: ts.Node[] = [node];
        if (ts.isIdentifier(node)) {
            const declaration =
                this.symbols.valueSymbol(node)?.valueDeclaration;
            if (declaration && ts.isFunctionLike(declaration)) {
                roots.push(declaration);
            } else if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                (ts.isArrowFunction(declaration.initializer) ||
                    ts.isFunctionExpression(declaration.initializer))
            ) {
                roots.push(declaration.initializer);
            }
        }
        const visitedSymbols = new EmissionSet<ts.Symbol>();
        const visitedFunctions = new EmissionSet<ts.Node>();
        const containingFunction = (
            declaration: ts.Declaration | undefined,
        ): ts.SignatureDeclaration | undefined => {
            let current: ts.Node | undefined = declaration;
            while (current) {
                if (ts.isFunctionLike(current)) {
                    return current;
                }
                current = current.parent;
            }
            return undefined;
        };
        const visit = (root: ts.Node): void => {
            findAnalysisNodeWithState<ts.SignatureDeclaration | undefined>(root, undefined, (current, active) => {
                const functionScope = ts.isFunctionLike(current)
                    ? current
                    : active;
                if (ts.isIdentifier(current)) {
                    const symbol = this.symbols.valueSymbol(current);
                    const declaration =
                        symbol?.valueDeclaration ?? symbol?.declarations?.[0];
                    if (
                        symbol &&
                        containingFunction(declaration) !== functionScope &&
                        !visitedSymbols.has(symbol)
                    ) {
                        visitedSymbols.add(symbol);
                        for (
                            let index = Math.min(
                                floor - 1,
                                this.variableScopes.length - 1,
                            );
                            index >= 0;
                            index -= 1
                        ) {
                            const binding =
                                this.variableScopes[index]!.get(symbol);
                            if (!binding) continue;
                            this.refuseEscapingPlatformEventCapture(
                                current,
                                index,
                                binding.value,
                                floor,
                            );
                            break;
                        }
                    }
                }
                let calledDeclaration: ts.SignatureDeclaration | undefined;
                if (ts.isCallExpression(current)) {
                    const declaration =
                        this.checker.getResolvedSignature(current)?.declaration;
                    if (
                        isSupportedFunction(declaration) &&
                        declaration.body &&
                        !visitedFunctions.has(declaration)
                    ) {
                        visitedFunctions.add(declaration);
                        calledDeclaration = declaration;
                    }
                }
                if (calledDeclaration) visit(calledDeclaration);
                return false;
            }, (current, active) => ts.isFunctionLike(current) ? current : active);
        };
        for (const root of roots) {
            if (ts.isFunctionLike(root)) {
                if (visitedFunctions.has(root)) continue;
                visitedFunctions.add(root);
            }
            visit(root);
        }
    }

    private valueContainsPlatformEvent(
        value: Value,
        seen = new EmissionSet<Value>(),
    ): boolean {
        if (seen.has(value)) return false;
        seen.add(value);
        if (
            value.kind === "platform-keyboard-event" ||
            value.kind === "platform-mouse-event" || value.nativeErrorEvent
        ) {
            return true;
        }
        if (
            value.dataType &&
            this.dataTypes.carriesBorrowedPlatformEvent(value.dataType)
        ) {
            return true;
        }
        const nested: Value[] = [
            ...Object.values(value.recordProperties ?? {}),
            ...(value.tupleElements ?? []),
            ...(value.staticElements ?? []),
            ...(value.nativeCallbackStaticArguments ?? []).filter(
                (candidate): candidate is Value => candidate !== undefined,
            ),
        ];
        if (value.staticElementsOwner) nested.push(value.staticElementsOwner);
        if (value.callbackRecordOwner) nested.push(value.callbackRecordOwner);
        if (value.sceneCamera) nested.push(value.sceneCamera);
        for (const scope of value.recordScopes ?? []) {
            for (const binding of scope.values()) nested.push(binding.value);
        }
        return nested.some((candidate) =>
            this.valueContainsPlatformEvent(candidate, seen),
        );
    }

    public refuseBorrowedPlatformEventEscape(
        value: Value,
        node: ts.Node,
        destination: string,
    ): void {
        if (!this.valueContainsPlatformEvent(value)) return;
        this.fail(
            node,
            `A borrowed platform event cannot escape its synchronous dispatch frame through ${destination}. Copy only owned scalar/string fields needed later.`,
        );
    }

    private lookupRecordProperty(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        if (ts.isPropertyAccessExpression(expression.expression)) {
            // A path resolves one link at a time, through this same
            // non-throwing lookup: an owner nobody here can name is
            // still the data lowerer's to try, not an error.
            const nested = this.lookupRecordProperty(expression.expression);
            return nested
                ? this.readOwnerProperty(nested, expression)
                : undefined;
        }
        if (!ts.isIdentifier(expression.expression)) {
            return undefined;
        }
        const owner =
            this.lookupOptional(expression.expression) ??
            (() => {
                const resolved = this.resolveStaticExpression(
                    expression.expression,
                );
                return resolved !== expression.expression
                    ? this.compileValue(resolved)
                    : undefined;
            })();
        return owner ? this.readOwnerProperty(owner, expression) : undefined;
    }

    /**
     * A declared property of an engine handle that the table types as plain
     * data. The data lowerer asks here so a comparison, a sink and a binding
     * all read the one table the expression path reads, instead of each
     * growing its own notion of which handle properties are data.
     */
    public declaredDataProperty(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        // The owner is looked up rather than compiled: this runs inside the
        // data lowerer's path resolution, which must stay free of emission
        // and of failure, and every current producer of a handle in a data
        // position is a bound local. The boundary this draws: a handle
        // STORED IN DATA (`groups[0]` out of a pushed vector) does not
        // resolve here — its owner path is data, not a local — so its
        // declared properties stay unreadable until this consults the
        // nested resolution `lookupRecordProperty` already implements.
        const owner = ts.isIdentifier(expression.expression)
            ? this.lookupOptional(expression.expression)
            : undefined;
        if (!owner || owner.kind === "data" || owner.kind === "record") {
            return undefined;
        }
        // Through the same single funnel every other read uses, so this
        // does not become a third reader of the table.
        const declared = this.readOwnerProperty(owner, expression);
        return declared?.dataType ? declared : undefined;
    }

    public readResolvedProperty(
        owner: Value,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const hydrated = this.classLowerer.hydrate(owner) ?? owner;
        const value = this.readOwnerProperty(hydrated, expression);
        return value && (hydrated.kind === "record" || expression.questionDotToken)
            ? this.propertyWithOwnerPresence(hydrated, value, expression)
            : value;
    }

    private propertyWithOwnerPresence(owner: Value, value: Value, expression: ts.PropertyAccessExpression): Value {
        const ownerPresent = owner.optionalFoundCpp ??
            (expression.questionDotToken && owner.dataType?.kind === "struct" &&
                this.dataTypes.isReferenceStruct(owner.dataType.name)
                ? `static_cast<bool>(${owner.cpp})`
                : undefined);
        if (ownerPresent === undefined) return value;
        const present = value.optionalFoundCpp === undefined
            ? ownerPresent
            : `(${ownerPresent} && ${value.optionalFoundCpp})`;
        return { ...value, optionalFoundCpp: present };
    }

    /**
     * One link of a path, once the owner is resolved. Every read site
     * ends here -- the general property path, the static evaluator's
     * lookup, the data lowerer's plain-data property bridge, and each
     * nested link -- so a path resolves the same way wherever it is
     * written and however deep it goes. The readings that are not a
     * declared field lookup live here because they are what differs, and
     * each used to sit in only one of the two paths: `camera.target` and
     * the geometry-task outputs resolved in an expression but not in a
     * numeric context.
     *
     * A record owner is the exception: this returns the property or
     * nothing, because the lookup path must stay non-throwing for the
     * data lowerer to try next. The general path handles records itself,
     * where a missing property is an error with a message.
     */
    private readOwnerProperty(
        owner: Value,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const character = readCharacterProperty(this, owner, expression.name.text);
        if (character) return character;
        if (owner.kind === "physics-body" && expression.name.text === "node") {
            return { kind: "record", cpp: "", recordProperties: { name: { kind: "string", cpp: `bbl::upstream::physics_body_node_name(${owner.cpp})`, dataType: { kind: "string" } } } };
        }
        const staticProperty = owner.recordProperties?.[expression.name.text];
        if (staticProperty) {
            // A materialized record can still carry an exact value for a
            // property produced during static iteration. Prefer that fact
            // over reconstructing the field from its wider declared type
            // (notably `boolean | undefined`), just as a plain record does.
            return staticProperty;
        }
        if (owner.kind === "record") {
            const accessor = owner.recordGetters?.[expression.name.text];
            if (accessor) {
                return this.compileRecordGetter(owner, accessor);
            }
            return undefined;
        }
        // A handle collection's size. The concept's other operations are
        // its loop and its searches; this is the same native vector read
        // through its one remaining JavaScript member, which is how both
        // VAT scenes ask whether the file carried any clips at all.
        if (
            owner.kind === "handle-collection" &&
            owner.handleCollection &&
            expression.name.text === "length"
        ) {
            return {
                kind: "number",
                cpp:
                    "static_cast<double>(" +
                    `${owner.handleCollection.containerCpp}.size())`,
                engineCpp: owner.handleCollection.engineCpp,
            };
        }
        if (owner.kind === "data") {
            const dataProperty = this.dataLowerer.compilePropertyFromValue(
                owner,
                expression,
            );
            if (dataProperty) {
                return dataProperty;
            }
        }
        const frozenParticleProperty = readFrozenParticleProperty(
            this, owner, expression.name.text, expression,
        );
        if (frozenParticleProperty) return frozenParticleProperty;
        const textProperty = readTextProperty(this, owner, expression.name.text, expression);
        if (textProperty) return textProperty;
        const inputProperty = readNodeInputProperty(this, owner, expression.name.text, expression);
        if (inputProperty) return inputProperty;
        // A live pure-2D binding's bridges, and the one path scene code
        // reads through one: `bridge.system.buffer.alive`, the simulated
        // count the generated registrar keeps. `bridges` is the pin's own
        // array, read as the binding again so the element access that
        // follows names one bridge by index -- the same shape
        // `set.systems[k]` takes.
        if (
            owner.kind === "node-particle-2d-binding" &&
            expression.name.text === "bridges" &&
            owner.nodeParticleLive
        ) {
            return owner;
        }
        if (
            owner.kind === "node-particle-2d-bridge" &&
            expression.name.text === "system"
        ) {
            return { ...owner, kind: "node-particle-system" };
        }
        if (
            owner.kind === "node-particle-system" &&
            expression.name.text === "buffer" &&
            owner.nodeParticleLive
        ) {
            return { ...owner, kind: "node-particle-buffer" };
        }
        if (
            owner.kind === "node-particle-buffer" &&
            expression.name.text === "alive" &&
            owner.nodeParticleLive
        ) {
            return {
                kind: "number",
                cpp:
                    "bbl::upstream::node_particle_2d_alive(" +
                    `${owner.nodeParticleRequestIndex!}, ` +
                    `${owner.nodeParticleBridgeIndex!})`,
                dataType: { kind: "number" },
            };
        }
        // The same table the general property path reads. Keeping a
        // second copy here is what made `camera.ortho.halfHeight`
        // resolve in an expression but not in a numeric context: the
        // copy was never told about the orthographic bounds.
        const declared = readProperty(
            this,
            owner,
            expression.name.text,
            expression,
        );
        if (declared) {
            return declared;
        }
        if (owner.kind === "tuple" && expression.name.text === "length") {
            const length = owner.tupleElements?.length ?? 0;
            return {
                kind: "number",
                cpp: `${length}.0f`,
                staticNumber: length,
            };
        }
        if (owner.kind === "string" && expression.name.text === "length") {
            const length = owner.staticString?.length;
            if (length === undefined) this.reachJsData();
            return {
                kind: "number",
                cpp:
                    length === undefined
                        ? `bbl::js::string_length(${owner.cpp})`
                        : doubleLiteral(length),
                ...(length === undefined ? {} : { staticNumber: length }),
                dataType: { kind: "number" },
            };
        }
        if (owner.kind === "engine" && expression.name.text === "msaaSamples") {
            return {
                kind: "number",
                cpp: `${owner.msaaSamples ?? 4}.0f`,
                staticNumber: owner.msaaSamples ?? 4,
            };
        }
        if (
            owner.kind === "frame-graph-context" &&
            expression.name.text === "frameGraph"
        ) {
            return owner;
        }
        if (
            owner.kind === "utility-layer" &&
            expression.name.text === "scene"
        ) {
            const engine = this.requireEngine(owner, expression);
            return {
                kind: "scene",
                cpp: `bbl::utility_layer_scene(${engine}, ${owner.cpp})`,
                engineCpp: engine,
                sceneEnvironmentState: {
                    rotationSet: false,
                    hasTexturedSkybox: false,
                },
                sceneTopologyState: { lights: [] },
            };
        }
        if (owner.kind === "position-gizmo") {
            const parts: Readonly<
                Record<
                    string,
                    {
                        index: number;
                        kind: "axis-drag-gizmo" | "plane-drag-gizmo";
                    }
                >
            > = {
                xGizmo: { index: 0, kind: "axis-drag-gizmo" },
                yGizmo: { index: 1, kind: "axis-drag-gizmo" },
                zGizmo: { index: 2, kind: "axis-drag-gizmo" },
                xPlaneGizmo: { index: 3, kind: "plane-drag-gizmo" },
                yPlaneGizmo: { index: 4, kind: "plane-drag-gizmo" },
                zPlaneGizmo: { index: 5, kind: "plane-drag-gizmo" },
            };
            const part = parts[expression.name.text];
            if (part) {
                const engine = this.requireEngine(owner, expression);
                const cpp = `${owner.cpp}.parts[${part.index}]`;
                const drag: Value = {
                    kind: "pointer-drag",
                    cpp: `${handleCppType("pointer-drag")}{${cpp}.value}`,
                    engineCpp: engine,
                    dataType: { kind: "handle", handle: "pointer-drag" },
                };
                return valueForKind(part.kind, {
                    cpp,
                    engineCpp: engine,
                    ...(part.index >= 3
                        ? {
                              optionalFoundCpp: `${owner.cpp}.part_count > ${part.index}u`,
                              truthinessCpp: `${owner.cpp}.part_count > ${part.index}u`,
                          }
                        : {}),
                    recordProperties: {
                        drag,
                        _disposePointer: {
                            kind: "data",
                            cpp: `${engine}.edit_gizmos[${cpp}.value].dispose_pointer`,
                            dataType: {
                                kind: "function",
                                parameters: [],
                            },
                        },
                    },
                });
            }
        }
        if (owner.kind === "pointer-drag") {
            const engine = this.requireEngine(owner, expression);
            const record = `${engine}.edit_gizmos[${owner.cpp}.value]`;
            if (
                expression.name.text === "enabled" ||
                expression.name.text === "dragging" ||
                expression.name.text === "hovering"
            ) {
                return {
                    kind: "boolean",
                    cpp: `${record}.${expression.name.text}`,
                    dataType: { kind: "boolean" },
                    nativeLvalue: true,
                };
            }
            if (expression.name.text === "_colliders") {
                return {
                    kind: "record",
                    cpp: "",
                    recordProperties: {
                        includes: {
                            kind: "data",
                            cpp:
                                `std::function<bool(${handleCppType("mesh")})>{` +
                                `[&](${handleCppType("mesh")} mesh) { return ` +
                                `bbl::pointer_drag_has_collider(${engine}, ` +
                                `${owner.cpp}, mesh); }}`,
                            dataType: {
                                kind: "function",
                                parameters: [
                                    { kind: "handle", handle: "mesh" },
                                ],
                                result: { kind: "boolean" },
                            },
                        },
                    },
                };
            }
            if (
                expression.name.text === "onHoverStart" ||
                expression.name.text === "onHoverEnd"
            ) {
                return {
                    kind: "record",
                    cpp: "",
                    recordProperties: {
                        notify: {
                            kind: "data",
                            cpp: `std::function<void()>{[&${engine}, drag = ${owner.cpp}]() { bbl::pointer_drag_hover(${engine}, drag, ${expression.name.text === "onHoverStart"}); }}`,
                            dataType: {
                                kind: "function",
                                parameters: [],
                            },
                        },
                    },
                };
            }
        }
        if (
            owner.kind === "camera" &&
            (expression.name.text === "position" ||
                expression.name.text === "target" ||
                expression.name.text === "upVector")
        ) {
            // Not a field but three of them: the record this synthesizes
            // is what makes `camera.position.x`, `camera.target.x`, and
            // destructuring either vector read the same components.
            const engine = this.requireEngine(owner, expression);
            const vector =
                expression.name.text === "upVector"
                    ? "up_vector"
                    : expression.name.text;
            const cameraVector = { owner: { ...owner, engineCpp: engine }, field: vector } as const;
            return {
                kind: "record",
                cpp: "",
                cameraVector,
                recordProperties: this.cameraVectorProperties(cameraVector),
            };
        }
        if (
            owner.kind === "light" &&
            (expression.name.text === "position" ||
                expression.name.text === "direction")
        ) {
            const engine = this.requireEngine(owner, expression);
            const vector = expression.name.text;
            const record = `${engine}.lights[${owner.cpp}.value]`;
            const component = (name: "x" | "y" | "z"): Value => ({
                kind: "number",
                cpp: `${record}.${vector}.${name}`,
                dataType: { kind: "number" },
                engineCpp: engine,
            });
            return {
                kind: "record",
                cpp: "",
                recordProperties: {
                    x: component("x"),
                    y: component("y"),
                    z: component("z"),
                },
            };
        }
        const sceneNodeTransform = sceneNodeTransformDescriptor(
            expression.name.text,
        );
        if (
            (owner.kind === "mesh" ||
                owner.kind === "transform-node" ||
                owner.kind === "scene-node") &&
            sceneNodeTransform
        ) {
            const engine = this.requireEngine(owner, expression);
            if (owner.kind === "scene-node") {
                this.reachFeature("scene:node-transforms", expression);
            }
            const vectorOwner = { ...owner, engineCpp: engine };
            return {
                kind: "record",
                cpp: "",
                sceneNodeVector: { owner: vectorOwner, transform: sceneNodeTransform },
                recordProperties: this.sceneNodeVectorProperties(
                    vectorOwner, sceneNodeTransform, owner.kind === "scene-node",
                ),
            };
        }
        if (owner.kind === "task" && owner.geometryTask) {
            return this.readGeometryTaskProperty(
                owner,
                owner.geometryTask,
                expression,
            );
        }
        if (
            owner.kind === "task" &&
            (owner.postProcessTask || owner.postProcessComposite) &&
            expression.name.text === "outputTexture"
        ) {
            // A pass writes into the target it was given, or into one it
            // made from the source's own descriptor. The pin resolves that
            // in `prepareOutputTarget`; the record holds whichever it is,
            // so chaining a pass onto the one before it reads a field. A
            // composite's public output may precede a history update pass;
            // generation resolves it from the pinned facade's identity.
            return {
                kind: "render-target",
                cpp: `${this.requireEngine(owner, expression)}.frame_tasks[${owner.cpp}.value].post_process.output_target`,
                ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
            };
        }
        if (owner.kind === "task" && owner.screenSpaceTask) {
            // The pin publishes three targets on a screen-space task: its
            // output (the composite's, or the stable effect target when it
            // composes nothing) and the stable target under the effect's
            // own name. All three are record fields the factory resolved.
            const fields: Readonly<Record<string, string>> = {
                outputTexture: "output_target",
                [screenSpaceFacts(owner.screenSpaceTask.intrinsic).stableTexture]:
                    "stable",
            };
            const field = fields[expression.name.text];
            if (field === undefined) return undefined;
            return {
                kind: "render-target",
                cpp: `${this.requireEngine(owner, expression)}.frame_tasks[${owner.cpp}.value].screen_space.${field}`,
                ...(owner.engineCpp ? { engineCpp: owner.engineCpp } : {}),
            };
        }
        return undefined;
    }

    /**
     * A geometry task's outputs, which are gated on what the task was
     * asked to write rather than on the property name alone.
     */
    private readGeometryTaskProperty(
        owner: Value,
        task: GeometryOutputTaskManifest,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const property = expression.name.text;
        const engineCpp = owner.engineCpp ? { engineCpp: owner.engineCpp } : {};
        if (property === "outputTexture") {
            if (!task.emitColor) {
                this.fail(
                    expression,
                    "Geometry task has no targetTexture output.",
                );
            }
            return {
                kind: "render-texture",
                cpp: `bbl::geometry_task_output_texture(${owner.cpp})`,
                renderTextureSource: "geometry-output",
                ...engineCpp,
            };
        }
        if (property === "geometryDepthTexture") {
            // The pin's eager depth wrapper over the task's MRT depth: a later
            // render task binds and loads it, and owns none of it.
            return {
                kind: "render-texture",
                cpp: `bbl::geometry_task_depth_texture(${owner.cpp})`,
                isDepthTexture: true,
                renderTextureSource: "geometry-depth",
                ...engineCpp,
            };
        }
        const geometryProperties: Record<string, GeometryTextureTypeName> = {
            geometryIrradianceTexture: "IRRADIANCE",
            geometryWorldPositionTexture: "WORLD_POSITION",
            geometryLocalPositionTexture: "LOCAL_POSITION",
            geometryReflectivityTexture: "REFLECTIVITY",
            geometryViewDepthTexture: "VIEW_DEPTH",
            geometryNormalizedViewDepthTexture: "NORMALIZED_VIEW_DEPTH",
            geometryScreenspaceDepthTexture: "SCREENSPACE_DEPTH",
            geometryViewNormalTexture: "VIEW_NORMAL",
            geometryWorldNormalTexture: "WORLD_NORMAL",
            geometryAlbedoTexture: "ALBEDO",
            geometryLinearVelocityTexture: "LINEAR_VELOCITY",
        };
        const type = geometryProperties[property];
        if (!type) {
            return undefined;
        }
        if (!task.attachments.includes(type)) {
            this.fail(expression, `Geometry task did not request ${type}.`);
        }
        return {
            kind: "render-texture",
            cpp: `bbl::geometry_task_texture(${owner.cpp}, bbl::GeometryTextureType::${geometryEnumMember(type)})`,
            renderTextureSource: "geometry",
            ...engineCpp,
        };
    }

    /**
     * The evaluator's own unwrap -- one rule for what a reader sees
     * through, including the pin's `wgsl` tag -- which records every await
     * it passes into `unwrappedAwaitExpressions` through `onAwait`.
     */
    public unwrap(expression: ts.Expression): ts.Expression {
        return this.evaluator.unwrap(expression);
    }

    /** The value symbol a name binds, or a failure naming it. */
    private requireValueSymbol(identifier: ts.Identifier): ts.Symbol {
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        return symbol;
    }

    /** The innermost scope that binds a symbol, walked as `lookup` walks. */
    private bindingScope(
        symbol: ts.Symbol,
    ): Map<ts.Symbol, VariableBinding> | undefined {
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            const scope = this.variableScopes[index]!;
            if (scope.has(symbol)) return scope;
        }
        return undefined;
    }

    public lookup(identifier: ts.Identifier): Value {
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.fail(
                identifier,
                `Unknown or unsupported variable '${identifier.text}'.`,
            );
        }
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            const binding = this.variableScopes[index]!.get(symbol);
            if (binding) {
                this.refuseDeadDeferredCapture(
                    identifier,
                    index,
                    binding.frameLocal === true,
                );
                this.refuseEscapingPlatformEventCapture(
                    identifier,
                    index,
                    binding.value,
                );
                this.refusePoisonedRebind(identifier, binding);
                this.useNativeValue(binding.value);
                return binding.value;
            }
        }
        this.fail(
            identifier,
            `Unknown or unsupported variable '${identifier.text}'.`,
        );
    }

    /**
     * Point a handle variable at a different handle of the same kind.
     *
     * A handle's C++ storage is one number, so the assignment itself is a
     * copy -- but the value the compiler holds beside it carries generation
     * identity (which scene mesh a material stamps, which slot a variant
     * table is keyed by), and that identity moves with the assignment. So
     * the binding is replaced, not just the storage.
     *
     * A rebind inside a nested callback rebinds only for the rest of that
     * callback, because on the path where the callback never runs the outer
     * variable still names what it always did. The outer binding is left
     * POISONED rather than updated: its storage now holds a handle its
     * identity does not describe, so the next outer read fails by name
     * instead of stamping the wrong mesh.
     */
    /**
     * The first assignment to a `let` declared without a type or an
     * initializer: it binds the name to a compile-time record, in the
     * scope that declared it.
     *
     * Only a record that exists at generation qualifies (`cpp` is empty),
     * because a native value would have needed storage at the declaration.
     * And only an assignment the declaring scope reaches unconditionally
     * on the way to the name's later reads -- through blocks and `try`
     * bodies, never a nested callback, branch or loop. A declaration inside
     * a statically expanded loop has its own binding on every iteration.
     */
    public bindPendingLet(identifier: ts.Identifier, value: Value): void {
        if (value.cpp !== "" || !isCompileTimeOnlyValue(value.kind)) {
            this.fail(
                identifier,
                `Variable '${identifier.text}' needs a native data type ` +
                    "before it can be assigned; only a compile-time record " +
                    `(received ${value.kind}) can bind an untyped 'let'.`,
            );
        }
        const symbol = this.requireValueSymbol(identifier);
        const declaration = symbol.valueDeclaration;
        const blockScoped = declaration && ts.isVariableDeclaration(declaration) &&
            ts.isVariableDeclarationList(declaration.parent) &&
            (declaration.parent.flags & ts.NodeFlags.BlockScoped) !== 0;
        const declaringScope = declaration
            ? ts.findAncestor(declaration, (node) =>
                  ts.isSourceFile(node) ||
                  (blockScoped ? ts.isBlock(node) : ts.isFunctionLike(node)))
            : undefined;
        for (
            let node: ts.Node | undefined = identifier.parent;
            node && node !== declaringScope;
            node = node.parent
        ) {
            if (
                ts.isBlock(node) ||
                ts.isTryStatement(node) ||
                ts.isExpressionStatement(node) ||
                ts.isBinaryExpression(node) ||
                ts.isParenthesizedExpression(node) ||
                ts.isSourceFile(node)
            ) {
                continue;
            }
            this.fail(
                identifier,
                `'${identifier.text}' is assigned inside a ${ts.SyntaxKind[node.kind]}; ` +
                    "an untyped 'let' binds only where its declaring scope reaches " +
                    "the assignment unconditionally.",
            );
        }
        const owner = this.bindingScope(symbol);
        if (!owner) {
            this.fail(identifier, `Unable to resolve variable '${identifier.text}'.`);
        }
        this.describeNativeValue(value);
        owner.set(symbol, { ...owner.get(symbol)!, value: {
            ...value,
            // A successful generation-only binding is a present object,
            // including when its annotation still admits undefined.
            optionalFoundCpp: value.optionalFoundCpp ??
                (value.kind === "json-null" ? "false" : "true"),
        } });
    }

    public rebindVariable(identifier: ts.Identifier, value: Value): void {
        const symbol = this.requireValueSymbol(identifier);
        // The same innermost-first walk `lookup` takes, so a rebind and a
        // read cannot disagree about which scope owns the name.
        const owner = this.bindingScope(symbol);
        if (!owner) {
            this.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        const innermost = this.variableScopes.at(-1)!;
        const binding = owner.get(symbol)!;
        const destination: Value = { ...value, cpp: binding.value.cpp };
        for (const property of ["sharedStorageCpp", "optionalStorageCpp"] as const) {
            const storage = binding.value[property];
            if (storage === undefined) delete destination[property];
            else destination[property] = storage;
        }
        if (binding.value.kind === "audio-engine") {
            this.assignAudioMainBus(binding.value, value, identifier);
            for (const property of ["audioMainBusCpp", "audioMainBusOwnerCpp"] as const) {
                const storage = binding.value[property];
                if (storage === undefined) delete destination[property];
                else destination[property] = storage;
            }
            destination.nativeCompanionCaptures = { ...destination.nativeCompanionCaptures,
                audioMainBusCpp: binding.value.nativeCompanionCaptures?.audioMainBusCpp ?? [] };
        }
        this.describeNativeValue(destination);
        const rebound = {
            ...binding,
            value: destination,
        };
        // Selected static branches run in the surrounding execution path.
        // A callback, runtime branch or loop still separates handle metadata.
        if (owner === innermost || this.variableScopes.slice(this.variableScopes.indexOf(owner) + 1)
            .every(scope => this.transparentRebindingScopes.has(scope))) {
            owner.set(symbol, rebound);
            return;
        }
        owner.set(symbol, {
            ...binding,
            reboundInNestedScope: true,
        });
        innermost.set(symbol, rebound);
    }

    public defineVariable(identifier: ts.Identifier, value: Value): void {
        if (this.options.workers && value.kind === "engine" && value.optionalStorageCpp && !value.ownedEngineCpp) {
            const ownedEngineCpp = value.cpp;
            value = { ...value, ownedEngineCpp, cpp: `(*${ownedEngineCpp})`, engineCpp: `(*${ownedEngineCpp})` };
        }
        if (value.kind === "data" && (value.dataType?.kind === "vector" ||
            value.dataType?.kind === "map" || value.dataType?.kind === "set")) {
            const owner = value.staticElementsOwner ?? value;
            const declaration = identifier.parent;
            const initializer = ts.isVariableDeclaration(declaration) && declaration.initializer
                ? this.unwrap(declaration.initializer)
                : undefined;
            const keyed = value.dataType.kind !== "vector";
            const emptyKeys = keyed && initializer &&
                ((ts.isNewExpression(initializer) && (initializer.arguments?.length ?? 0) === 0) ||
                    (ts.isObjectLiteralExpression(initializer) && initializer.properties.length === 0));
            const count = emptyKeys ? 0 : owner.staticElements?.length ??
                (initializer && ts.isArrayLiteralExpression(initializer) &&
                    !initializer.elements.some(ts.isSpreadElement)
                    ? initializer.elements.length
                    : undefined);
            value.collectionCardinality = owner.collectionCardinality ?? value.collectionCardinality ?? {
                kind: keyed ? "keyed" : "array",
                count,
                ...(emptyKeys ? { keys: new EmissionSet<string | number | boolean>() } : {}),
                createdIn: [...this.parameterizedResourceIterations],
                varyingIn: new EmissionSet(),
            };
            owner.collectionCardinality = value.collectionCardinality;
            this.collectionCardinalities.add(value.collectionCardinality);
        }
        this.bindAudioMainBusStorage(value);
        this.describeNativeValue(value);
        const symbol = this.requireValueSymbol(identifier);
        const scope = this.variableScopes.at(-1)!;
        if (scope.has(symbol)) {
            this.fail(
                identifier,
                `Variable shadowing is not supported for '${identifier.text}' in the same scope.`,
            );
        }
        scope.set(symbol, {
            name: identifier.text,
            value,
            ...(this.frameCallbackDepth > 0 ? { frameLocal: true } : {}),
        });
    }

    public bindLocalValue(identifier: ts.Identifier, value: Value): void {
        this.bindLocalOrParameterValue(identifier, value, false);
    }

    public bindCompileTimeValue(identifier: ts.Identifier, value: Value): void {
        this.defineVariable(identifier, value);
    }

    public rebindCompileTimeValue(
        identifier: ts.Identifier,
        value: Value,
    ): void {
        this.describeNativeValue(value);
        const symbol = this.requireValueSymbol(identifier);
        const owner = this.bindingScope(symbol);
        if (!owner) {
            this.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        const binding = owner.get(symbol)!;
        owner.set(symbol, { ...binding, value });
    }

    public materializeStaticNativeValue(
        identifier: ts.Identifier,
        value: Value,
    ): Value {
        const existing = this.lookupOptional(identifier);
        if (existing) return existing;
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
        const cppName = this.cppIdentifier(identifier.text);
        this.staticNativeDeclarations.push(`auto ${cppName} = ${value.cpp};`);
        const stored = { ...value, cpp: cppName };
        this.variableScopes[0]!.set(symbol, {
            name: identifier.text,
            value: stored,
        });
        return stored;
    }

    /**
     * Binds an inlined user-function parameter. Unlike local
     * declarations (the pinned value model copies path-bound locals),
     * JavaScript object arguments alias, and the native-function path
     * already passes struct/vector/typed-array parameters by reference
     * — so the inline path binds those through a forwarding reference:
     * lvalue arguments alias the caller's binding (writes through the
     * parameter mutate it) while temporaries stay owned. Resource handles
     * are JavaScript references but native value IDs, so they must be copied;
     * forwarding a property-backed handle could retain a reference into an
     * engine vector that a later factory call reallocates.
     */
    public bindParameterValue(identifier: ts.Identifier, value: Value): void {
        const narrowed =
            value.kind === "data"
                ? this.dataLowerer.narrowForDeclaration(value, identifier)
                : value;
        this.bindLocalOrParameterValue(identifier, narrowed, true);
    }

    public bindClassParameterValue(
        identifier: ts.Identifier,
        argument: ts.Expression,
    ): void {
        this.bindParameterValue(
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
        if (dataType && ["number", "string", "boolean"].includes(dataType.kind) && ts.isParameter(parameter) &&
            isSupportedFunction(parameter.parent) &&
            parameterIsReadOnly(this.checker, parameter.parent, identifier)) {
            const value = this.compileValue(argument);
            const cpp = this.dataLowerer.compileKnownValueForSink(value, dataType, argument);
            return {
                ...this.dataLowerer.leafValue(cpp, dataType),
                ...(value.staticNumber !== undefined && !value.parameterBinding
                    ? { staticNumber: value.staticNumber }
                    : {}),
                ...(value.staticString !== undefined && !value.parameterBinding
                    ? { staticString: value.staticString } : {}),
                ...(value.staticBoolean !== undefined && !value.parameterBinding
                    ? { staticBoolean: value.staticBoolean } : {}),
            };
        }
        if (dataType?.kind === "struct") {
            dataType = this.dataTypes.markStoredObjectReferences(dataType);
        }
        if (!dataType || dataType.kind === "handle") {
            return this.compileValue(argument);
        }
        let receivingDeclaration: ts.Node | undefined = argument.parent;
        while (receivingDeclaration && !ts.isVariableDeclaration(receivingDeclaration) && !ts.isStatement(receivingDeclaration)) {
            receivingDeclaration = receivingDeclaration.parent;
        }
        const receivingName = receivingDeclaration && ts.isVariableDeclaration(receivingDeclaration) &&
            ts.isIdentifier(receivingDeclaration.name) ? receivingDeclaration.name : undefined;
        const receivingSymbol = receivingName && !this.lookupOptional(receivingName)
            ? this.symbols.valueSymbol(receivingName) : undefined;
        if (dataType.kind === "struct" && this.dataTypes.carriesFunction(dataType) && receivingSymbol &&
            someAnalysisNode(argument, node => ts.isIdentifier(node) && this.symbols.valueSymbol(node) === receivingSymbol)) {
            // Inline class fields can retain callback wiring until a native
            // storage boundary demands it. Materializing here would compile
            // closures before the variable receiving this instance exists.
            const value = this.compileValue(argument);
            return value.kind === "record" ? value : this.dataLowerer.leafValue(
                this.dataLowerer.compileKnownValueForSink(value, dataType, argument), dataType,
            );
        }
        if (dataType.kind === "function") {
            const unwrappedCallback = this.unwrap(argument);
            const bound = ts.isIdentifier(unwrappedCallback)
                ? this.lookupOptional(unwrappedCallback)
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
        const collection = dataType.kind === "vector" || dataType.kind === "span" || dataType.kind === "map" || dataType.kind === "set";
        const structural = dataType.kind === "struct" ||
            (dataType.kind === "vector" && dataType.element.kind === "struct");
        if (
            collection ||
            (structural && (ts.isIdentifier(unwrapped) ||
                ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped)))
        ) {
            const actual = this.compileValue(unwrapped);
            if (collection && actual.kind === "data" && actual.dataType &&
                this.dataLowerer.spanCompatible(actual.dataType, dataType)) {
                return actual;
            }
            if (
                structural && actual.kind === "record" &&
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
                const cpp = this.dataLowerer.compileKnownValueForSink(actual, dataType, argument);
                return this.dataLowerer.leafValue(cpp, dataType);
            }
        }
        const cpp = this.dataLowerer.compileForSink(argument, dataType);
        return this.dataLowerer.leafValue(
            dataType.kind === "optional" && cpp === "std::nullopt"
                ? `${this.dataTypes.cppType(dataType)}{std::nullopt}`
                : cpp,
            dataType,
        );
    }

    /** Materialize mutable members when a compile-time value escapes. */
    public materializeEscapingValue(value: Value, label: string, node?: ts.Expression): Value {
        if (value.kind === "callback") {
            const resolved =
                value.callbackDeclaration &&
                ts.isIdentifier(value.callbackDeclaration)
                    ? (this.lookupOptional(value.callbackDeclaration) ?? value)
                    : value;
            if (resolved.callbackDeclaration && !resolved.callbackRecordOwner) {
                return {
                    ...resolved,
                    callbackRecordOwner: {
                        kind: "record",
                        cpp: "",
                        ...this.captureRecordScopes(),
                    },
                };
            }
            return resolved;
        }
        if (value.kind === "record") {
            if (
                value.dataType?.kind === "struct" &&
                this.dataTypes.isReferenceStruct(value.dataType.name)
            ) {
                return value;
            }
            return this.materializeRecordScalars(value, label, true, node);
        }
        if (value.kind === "tuple" && value.tupleElements) {
            return {
                ...value,
                tupleElements: value.tupleElements.map((element, index) =>
                    this.materializeEscapingValue(element, `${label}_${index}`),
                ),
            };
        }
        return value;
    }

    /**
     * The stronger guarantee: bind every leaf of a value, bare scalars
     * included, so nothing emitted after this point can move it.
     *
     * **A lowering that emits statements while producing a value binds that
     * value; it does not splice it.** `enumMapLiteral`
     * (`src/compiler/data-lowering.ts`) states the same rule for the slots of a
     * reordered `Record` literal, and the inlined-call return is the other
     * place it has to hold: the caller decides which guarantee it needs by
     * calling this or `materializeEscapingValue`, rather than either policy
     * taking a mode flag.
     *
     * The leaf is deliberately not shared with `materializeRecordScalars`
     * below. That one gives a record member a native home, so it emits a
     * mutable local and folds a static value into a literal; this one refuses
     * a folded value outright and emits `const`. One line each, and the
     * difference is the contract rather than an accident.
     */
    public pinValueToTemporary(value: Value, label: string, node?: ts.Expression): Value {
        if (["text-data", "text-renderable", "text-vector"].includes(value.kind)) {
            const retained = retainTextValue(this, value);
            this.describeNativeValue(retained);
            return retained;
        }
        if (value.kind === "callback") {
            return this.materializeEscapingValue(value, label);
        }
        if (value.kind === "data" && isOpaqueReference(value.dataType)) {
            const cpp = this.allocateTemporaryCppName(label);
            this.emit({ kind: "declaration", type: "const auto", name: cpp, initializer: value.cpp });
            const pinned = { ...value, cpp, nativeBinding: true as const };
            this.describeNativeValue(pinned);
            return pinned;
        }
        if (isHandleKind(value.kind) && !value.nativeBinding) {
            const cpp = this.allocateTemporaryCppName(label);
            this.emit({ kind: "declaration", type: value.kind === "engine" ? "auto&" : "const auto", name: cpp, initializer: value.cpp, attributes: "[[maybe_unused]] " });
            const pinned = { ...value, cpp, ...(value.kind === "engine" ? { engineCpp: cpp } : {}), nativeBinding: true as const };
            this.describeNativeValue(pinned);
            return pinned;
        }
        if (value.kind === "record") {
            if (
                value.dataType?.kind === "struct" &&
                this.dataTypes.isReferenceStruct(value.dataType.name)
            ) {
                return value;
            }
            return this.materializeRecordScalars(value, label, true, node);
        }
        if (value.kind === "tuple" && value.tupleElements) {
            return {
                ...value,
                tupleElements: value.tupleElements.map((element, index) =>
                    this.pinValueToTemporary(element, `${label}_${index}`),
                ),
            };
        }
        // A folded value is already a constant, so it is left alone -- and has
        // to be, since its width belongs to the sink that consumes it
        // ([fidelity](../docs/fidelity.md#numeric-width)).
        const cppType =
            value.kind === "number" && value.staticNumber === undefined
                ? "double"
                : value.kind === "boolean" && value.staticBoolean === undefined
                  ? "bool"
                  : (value.kind === "string" || value.dataType?.kind === "string") && value.staticString === undefined
                    ? "std::string" : undefined;
        if (!cppType) return value;
        const cppName = this.allocateTemporaryCppName(label);
        this.emit({ kind: "declaration", type: `const ${cppType}`, name: cppName, initializer: value.cpp });
        return { ...value, cpp: cppName };
    }

    /**
     * A plain-data tuple given a native home, so its lanes can be indexed.
     *
     * `tupleComponents` reads its base once per lane, which is wrong for
     * any expression carrying an effect -- a scene-local call above all,
     * since the inliner emits its body where the call sits and evaluating
     * it three times would run that body three times. Every reader that
     * indexes a tuple whose expression is not free to repeat binds it
     * here, which is the tuple-shaped case of the rule
     * `pinValueToTemporary` above states.
     */
    public bindDataTuple(value: Value, arity: number, label = "tuple"): string {
        const cppName = this.allocateTemporaryCppName(label);
        this.emit(
            { kind: "declaration", type: `const ${this.dataTypes.cppType({
                kind: "tuple",
                arity,
            })}`, name: cppName, initializer: value.cpp },
        );
        this.useNativeBinding(this.registerNativeBinding(cppName, false, true));
        return cppName;
    }

    /** Project a stored plain object once, preserving replacement of its members. */
    private referenceRecordValue(value: Value, node: ts.Expression): Value | undefined {
        if (
            value.kind !== "record" || value.staticJson !== undefined ||
            this.classOf(value) !== undefined ||
            Object.keys(value.recordMethods ?? {}).length !== 0 ||
            Object.keys(value.recordGetters ?? {}).length !== 0 ||
            Object.keys(value.recordSetters ?? {}).length !== 0 ||
            !this.recordHasMutableContainer(value)
        ) return undefined;
        const sourceType = nativeReturnTsType(this.checker,
            this.checker.getContextualType(node) ?? this.checker.getTypeAtLocation(node),
        );
        if (!sourceType) return undefined;
        const stored = this.dataTypes.fromTsType(sourceType, node);
        if (stored?.kind !== "struct" ||
            !this.dataTypes.isReferenceStruct(stored.name) ||
            this.dataTypes.carriesFunction(stored)) return undefined;
        const projected = this.dataLowerer.leafValue(
            this.dataLowerer.compileKnownValueForSink(value, stored, node), stored);
        // This expression constructs an object; it cannot be a missing
        // element. Do not snapshot a redundant presence bit at each binding.
        delete projected.optionalFoundCpp;
        return { ...projected, freshData: true };
    }

    private recordHasMutableContainer(value: Value, seen = new EmissionSet<Value>()): boolean {
        if (seen.has(value)) return false;
        seen.add(value);
        // Scalar/opaque-handle records already have shared field homes, and
        // retain generation metadata required by resource factories. Whole
        // object storage is needed when a replaceable container can escape.
        if (value.kind === "data" && value.dataType) {
            return this.isMutableRecordContainer(value.dataType);
        }
        return value.kind === "record" && Object.values(value.recordProperties ?? {})
            .some((property) => this.recordHasMutableContainer(property, seen));
    }

    private bindCameraVector(value: Value): Value {
        const vector = value.cameraVector;
        if (!vector || vector.bound) return value;
        const cpp = this.allocateTemporaryCppName("camera_vector_owner");
        this.emit({ kind: "declaration", type: "const auto", name: cpp, initializer: vector.owner.cpp, attributes: "[[maybe_unused]] " });
        const owner = { ...vector.owner, cpp };
        this.describeNativeValue(owner);
        const cameraVector = { ...vector, owner, bound: true as const };
        return { ...value, cameraVector, recordProperties: this.cameraVectorProperties(cameraVector) };
    }

    private cameraVectorProperties(vector: NonNullable<Value["cameraVector"]>): Record<string, Value> {
        const record = `${vector.owner.engineCpp}.cameras[${vector.owner.cpp}.value].${vector.field}`;
        return Object.fromEntries(["x", "y", "z"].map((axis) => [axis, {
            kind: "number", cpp: `${record}.${axis}`, dataType: { kind: "number" },
            engineCpp: vector.owner.engineCpp,
        } satisfies Value]));
    }

    private sceneNodeVectorProperties(
        owner: Value & { engineCpp: string },
        transform: SceneNodeTransformDescriptor,
        freshData = false,
    ): Record<string, Value> {
        const engine = owner.engineCpp;
        const vector = owner.kind === "scene-node"
            ? `bbl::scene_node_${transform.nativeField}(${engine}, ${owner.cpp})`
            : `${engine}.${owner.kind === "mesh" ? "meshes" : "transform_nodes"}[${owner.cpp}.value].${transform.nativeField}`;
        return Object.fromEntries(transform.components.map((name) => [name, {
            kind: "number",
            cpp: `${vector}.${name}`,
            dataType: { kind: "number" },
            engineCpp: engine,
            ...(freshData ? { freshData: true } : {}),
        } satisfies Value]));
    }

    /** Retain the handle, so vector aliases survive arena growth and source rebinding. */
    private bindSceneNodeVector(value: Value): Value {
        const vector = value.sceneNodeVector;
        if (!vector || vector.bound) return value;
        const cpp = this.allocateTemporaryCppName("vector_owner");
        this.emit({ kind: "declaration", type: "const auto", name: cpp, initializer: vector.owner.cpp, attributes: "[[maybe_unused]] " });
        const owner = { ...vector.owner, cpp };
        this.describeNativeValue(owner);
        return {
            ...value,
            sceneNodeVector: { ...vector, owner, bound: true },
            recordProperties: this.sceneNodeVectorProperties(owner, vector.transform),
        };
    }

    /** Materialize mutable members when a compile-time record escapes. */
    private materializeRecordScalars(
        record: Value,
        label: string,
        preserveIdentity = false,
        node?: ts.Expression,
    ): Value {
        if (record.retainedNativeRecord) return record;
        if (record.cameraVector) {
            return this.bindCameraVector(record);
        }
        if (record.sceneNodeVector) {
            return this.bindSceneNodeVector(record);
        }
        const stored = node && this.referenceRecordValue(record, node);
        if (stored) {
            // Choose the whole-object home before boxing individual fields.
            // Inlined calls bind it here so later sinks share this allocation.
            const cpp = this.allocateTemporaryCppName(label);
            this.emit({ kind: "declaration", type: "auto", name: cpp, initializer: stored.cpp });
            return { ...stored, cpp: `std::move(${cpp})`, objectIdentityCpp: `${cpp}.get()` };
        }
        const properties: Record<string, Value> = {};
        const classFields = this.classOf(record) !== undefined;
        const scalarFields = Object.entries(record.recordProperties ?? {}).filter(([, property]) =>
            !property.sharedRecordScalar && !property.sharedRecordContainer &&
            !(property.readOnly && property.staticString !== undefined) &&
            !(classFields && property.sharedStorageCpp && property.cpp === `(*${property.sharedStorageCpp})`) &&
            (property.kind === "number" || property.kind === "boolean" || property.staticString !== undefined));
        const packedScalars: Array<{ name: string; cpp: string; type: string; value: Value }> = [];
        for (const [name, property] of Object.entries(
            record.recordProperties ?? {},
        )) {
            if (property.readOnly && property.staticString !== undefined) {
                properties[name] = property;
                continue;
            }
            if (property.sharedRecordScalar || (classFields && property.sharedStorageCpp &&
                property.cpp === `(*${property.sharedStorageCpp})`)) {
                properties[name] = property;
                continue;
            }
            if (property.sharedRecordContainer) {
                properties[name] = property;
                continue;
            }
            if (property.kind === "record") {
                properties[name] = this.materializeRecordScalars(
                    property,
                    `${label}_${name}`,
                    preserveIdentity,
                );
                continue;
            }
            if (
                property.kind === "data" &&
                property.dataType &&
                !property.nativeBinding &&
                this.isMutableRecordContainer(property.dataType)
            ) {
                const cppName = this.allocateTemporaryCppName(
                    `${label}_${name}`,
                );
                const cppType = this.dataTypes.cppType(property.dataType);
                this.emit(
                    { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<${cppType}>(${property.cpp})`, attributes: "[[maybe_unused]] " },
                );
                properties[name] = {
                    ...property,
                    cpp: `(*${cppName})`,
                    sharedStorageCpp: cppName,
                    sharedRecordContainer: true,
                };
                continue;
            }
            const cppName = this.allocateTemporaryCppName(`${label}_${name}`);
            if (scalarFields.length > 1 &&
                (property.kind === "number" || property.kind === "boolean" || property.staticString !== undefined)) {
                const { staticNumber, staticBoolean: _staticBoolean, ...dynamicProperty } = property;
                const type = property.kind === "number" ? CPP_SCALAR.number
                    : property.kind === "boolean" ? CPP_SCALAR.boolean : CPP_SCALAR.string;
                const initial = property.kind === "number"
                    ? staticNumber === undefined ? property.cpp : numberConstantValue(staticNumber).cpp
                    : property.kind === "boolean" ? property.cpp : this.cppString(property.staticString!);
                // Snapshot in property order; the shared allocation follows all initializers.
                this.emit({ kind: "declaration", type: `const ${type}`, name: cppName, initializer: initial });
                properties[name] = property;
                packedScalars.push({ name, cpp: cppName, type, value: property.staticString !== undefined
                    ? { kind: "data", cpp: cppName, dataType: { kind: "string" } }
                    : dynamicProperty });
                continue;
            }
            if (property.kind === "number") {
                const { staticNumber: _staticNumber, ...dynamicProperty } =
                    property;
                this.emit(
                    { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<double>(${property.staticNumber === undefined
                            ? property.cpp
                            : numberConstantValue(property.staticNumber).cpp})`, attributes: "[[maybe_unused]] " },
                );
                properties[name] = {
                    ...dynamicProperty,
                    cpp: `(*${cppName})`,
                    sharedStorageCpp: cppName,
                    sharedRecordScalar: true,
                };
                continue;
            }
            if (property.kind === "boolean") {
                const { staticBoolean: _staticBoolean, ...dynamicProperty } =
                    property;
                this.emit(
                    { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<bool>(${property.cpp})`, attributes: "[[maybe_unused]] " },
                );
                properties[name] = {
                    ...dynamicProperty,
                    cpp: `(*${cppName})`,
                    sharedStorageCpp: cppName,
                    sharedRecordScalar: true,
                };
                continue;
            }
            if (property.staticString !== undefined) {
                this.emit(
                    { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<std::string>(${this.cppString(property.staticString)})`, attributes: "[[maybe_unused]] " },
                );
                properties[name] = {
                    kind: "data",
                    cpp: `(*${cppName})`,
                    sharedStorageCpp: cppName,
                    dataType: { kind: "string" },
                    sharedRecordScalar: true,
                };
                continue;
            }
            properties[name] = property;
        }
        if (packedScalars.length) {
            const storage = this.allocateTemporaryCppName(`${label}_scalars`);
            const type = `std::tuple<${packedScalars.map(field => field.type).join(", ")}>`;
            this.emit({ kind: "declaration", type: "auto", name: storage, initializer: `bbl::js::make_gc_shared<${type}>(std::tuple{${packedScalars.map(field => field.cpp).join(", ")}})` });
            packedScalars.forEach((field, index) => {
                properties[field.name] = {
                    ...field.value,
                    cpp: `std::get<${index}>(*${storage})`,
                    sharedStorageCpp: storage,
                    sharedRecordScalar: true,
                };
            });
        }
        for (const property of Object.values(properties)) this.describeNativeValue(property);
        if (preserveIdentity) {
            // Aliases (including native proxy dispatchers) key runtime identity
            // by this table. Materializing its leaves must not replace it.
            Object.assign(record.recordProperties ??= {}, properties);
            return record;
        }
        return valueForKind(record.kind, { ...record, recordProperties: properties });
    }

    private isMutableRecordContainer(dataType: DataType): boolean {
        if (dataType.kind === "optional") {
            return this.isMutableRecordContainer(dataType.inner);
        }
        return (
            passesByReferenceKind(dataType) &&
            dataType.kind !== "tuple" &&
            dataType.kind !== "enummap"
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
                          this.dataTypes.isClassStruct(lexicalThis.dataType.name))
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
            this.refuseEscapingPlatformEventCapturesIn(
                expression,
                this.variableScopes.length,
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
            scopes: this.variableScopes.map((scope) => new EmissionMap(scope)),
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
            const savedScopes = [...this.variableScopes];
            this.variableScopes.length = 0;
            this.variableScopes.push(...deferred.scopes);
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
                this.variableScopes.length = 0;
                this.variableScopes.push(...savedScopes);
            }
        }
        const insertion = this.engineStartMark?.index ?? this.body.length;
        this.body.splice(insertion, 0, ...emitted);
        this.deferredPhysicsCallbacks.length = 0;
    }

    private bindLocalOrParameterValue(
        identifier: ts.Identifier,
        value: Value,
        parameter: boolean,
        explicitCppName?: string,
        sharedStorage = false,
    ): void {
        this.useNativeValue(value);
        if (value.kind === "void") {
            this.fail(
                identifier,
                `Variable '${identifier.text}' cannot receive void.`,
            );
        }
        if (value.kind === "browser") {
            this.defineVariable(identifier, value);
            return;
        }
        if (value.uiRoot) {
            // document.body is a compile-time mount sentinel. Its inlined
            // parameter must retain that identity rather than materializing
            // a nonexistent native DOM handle.
            this.defineVariable(identifier, value);
            return;
        }
        if (
            value.kind === "string" ||
            value.kind === "callback" ||
            isCompileTimeOnlyValue(value.kind)
        ) {
            this.defineVariable(identifier, value);
            return;
        }
        const cppName = explicitCppName ?? this.cppIdentifier(identifier.text);
        const reference = value.kind === "engine" || value.kind === "scene";
        const copiesHandle =
            parameter &&
            (this.dataLowerer.dataTypeAt(identifier)?.kind === "handle" ||
                isHandleKind(value.kind));
        const platformEvent =
            value.kind === "platform-keyboard-event" ||
            value.kind === "platform-mouse-event";
        const nativeType = platformEvent
            ? "const auto&"
            : reference
              ? "auto&"
              : value.kind === "number"
                ? "double"
                : value.kind === "boolean"
                  ? "bool"
                  : value.kind === "data" && value.dataType?.kind === "string"
                    ? "std::string"
                    : parameter && !copiesHandle
                      ? "auto&&"
                      : "auto";
        const initializerCpp =
            value.kind === "number" && value.staticNumber !== undefined
                ? numberConstantValue(value.staticNumber).cpp
                : value.cpp;
        const maybeUnused =
            value.kind === "number" || value.kind === "boolean" || parameter ? "[[maybe_unused]] " : "";
        if (sharedStorage) {
            if (isHandleKind(value.kind)) {
                const cppType = this.dataTypes.cppType({
                    kind: "handle",
                    handle: value.kind,
                });
                this.emit(
                    { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<${cppType}>(${initializerCpp})`, attributes: maybeUnused },
                );
            } else {
                const initial = this.allocateTemporaryCppName(
                    `${identifier.text}_initial`,
                );
                this.emit({ kind: "declaration", type: "auto", name: initial, initializer: initializerCpp });
                this.emit(
                    { kind: "declaration", type: "auto", name: cppName, initializer: `bbl::js::make_gc_shared<std::decay_t<decltype(${initial})>>(std::move(${initial}))`, attributes: maybeUnused },
                );
            }
        } else {
            this.emit(
                { kind: "declaration", type: nativeType, name: cppName, initializer: initializerCpp, attributes: maybeUnused },
            );
        }
        const storedCpp = sharedStorage ? `(*${cppName})` : cppName;
        const constantParameter = parameter && value.kind === "number" &&
            value.staticNumber !== undefined && !value.parameterBinding &&
            ts.isParameter(identifier.parent) && isSupportedFunction(identifier.parent.parent) &&
            parameterIsReadOnly(this.checker, identifier.parent.parent, identifier);
        const stored: Value = {
            ...value,
            cpp: storedCpp,
            ...(sharedStorage ? { sharedStorageCpp: cppName } : {}),
            ...(parameter ? { parameterBinding: !constantParameter } : {}),
            ...(!parameter ? { nativeBinding: true } : {}),
            ...(parameter && value.staticElements
                ? {
                      staticElementsOwner: value.staticElementsOwner ?? value,
                  }
                : {}),
        };
        if (!sharedStorage) delete stored.sharedStorageCpp;
        if (
            value.kind === "data" &&
            value.dataType?.kind === "struct" &&
            this.dataTypes.isReferenceStruct(value.dataType.name)
        ) {
            stored.objectIdentityCpp = `${storedCpp}.get()`;
        }
        if (value.kind === "animation-clip") {
            stored.animationFrameRate = `${storedCpp}.frame_rate`;
            stored.animationDuration = `${storedCpp}.duration`;
        }
        this.defineVariable(identifier, stored);
    }

    /** Visit bindings and the generation facts nested inside their values. */
    private visitScopedValues(visitor: (value: Value) => void): void {
        const seen = new EmissionSet<Value>();
        const visit = (value: Value): void => {
            if (seen.has(value)) return;
            seen.add(value);
            const nested = [
                ...Object.values(value.recordProperties ?? {}),
                ...(value.staticElements ?? []),
                ...(value.tupleElements ?? []),
            ];
            visitor(value);
            for (const child of nested) visit(child);
        };
        for (const scope of this.variableScopes) {
            for (const binding of scope.values()) visit(binding.value);
        }
    }

    /** Invalidate one native array's complete snapshot through all aliases. */
    public invalidateStaticElements(value: Value, preserveCardinality = false): void {
        const owner = value.staticElementsOwner ?? value;
        const elements = owner.staticElements ?? value.staticElements;
        const cardinality = owner.collectionCardinality ?? value.collectionCardinality;
        if (cardinality && !preserveCardinality) {
            cardinality.count = undefined;
            delete cardinality.keys;
        }
        const invalidate = (candidate: Value): void => {
            if (
                candidate === value ||
                candidate === owner ||
                candidate.staticElementsOwner === owner ||
                (cardinality !== undefined && candidate.collectionCardinality === cardinality) ||
                (elements !== undefined &&
                    candidate.staticElements === elements)
            ) {
                if (owner.runtimeElementTemplate) {
                    candidate.runtimeElementTemplate =
                        owner.runtimeElementTemplate;
                }
                if (cardinality) candidate.collectionCardinality = cardinality;
                delete candidate.staticElements;
                delete candidate.staticElementsOwner;
            }
        };
        this.visitScopedValues(invalidate);
        invalidate(value);
        invalidate(owner);
    }

    /** Read carried facts only; accessors and runtime expressions are not evaluated. */
    public knownValueWithoutEvaluation(expression: ts.Expression): Value | undefined {
        const node = this.unwrap(expression);
        if (ts.isIdentifier(node)) return this.lookupOptional(node);
        if (node.kind === ts.SyntaxKind.ThisKeyword) return this.activeThis();
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.knownValueWithoutEvaluation(node.expression);
            if (!owner?.recordGetters?.[node.name.text]) return owner?.recordProperties?.[node.name.text];
        }
        return undefined;
    }

    public knownCollectionCardinality(expression: ts.Expression): number | undefined {
        const carried = this.knownValueWithoutEvaluation(expression);
        const carriedState = carried?.collectionCardinality ?? carried?.staticElementsOwner?.collectionCardinality;
        if (carriedState) {
            return carriedState.untrackedAliases ||
                this.parameterizedResourceIterations.some((frame) => carriedState.varyingIn.has(frame))
                ? undefined
                : carriedState.count;
        }
        const node = this.unwrap(this.resolveStaticExpression(expression));
        if (ts.isArrayLiteralExpression(node)) {
            let count = 0;
            for (const element of node.elements) {
                if (!ts.isSpreadElement(element)) { count++; continue; }
                const spread = this.knownCollectionCardinality(element.expression);
                if (spread === undefined) return undefined;
                count += spread;
            }
            return count;
        }
        const value = this.knownValueWithoutEvaluation(node);
        const state = value?.collectionCardinality ?? value?.staticElementsOwner?.collectionCardinality;
        if (state) {
            return state.untrackedAliases ||
                this.parameterizedResourceIterations.some((frame) => state.varyingIn.has(frame))
                ? undefined
                : state.count;
        }
        return (value?.tupleElements ??
            value?.staticElementsOwner?.staticElements ?? value?.staticElements)?.length;
    }

    /** A known size whose members no longer have individual static aliases. */
    public runtimeCollectionCardinality(expression: ts.Expression): number | undefined {
        const value = this.knownValueWithoutEvaluation(expression);
        return value && !value.tupleElements &&
            !(value.staticElementsOwner?.staticElements ?? value.staticElements)
            ? this.knownCollectionCardinality(expression)
            : undefined;
    }

    private definiteCollectionMutation(): boolean {
        const frame = this.parameterizedResourceIterations.at(-1);
        const definite = frame
            ? this.runtimeControlFlowDepth === frame.controlDepth + 1 &&
                this.runtimeIterationDepth === frame.iterationDepth + 1
            : this.runtimeControlFlowDepth === 0 && this.runtimeIterationDepth === 0;
        return definite && this.frameCallbackDepth === 0 &&
            (frame !== undefined || this.returnFrames.every(current => current.kind !== "native" || current.callSiteEffects)) &&
            !this.returnFrames.some((current) => this.resourceLoopReturns.has(current));
    }

    public recordArrayPush(value: Value, added: number | undefined): boolean {
        const owner = value.staticElementsOwner ?? value;
        const state = owner.collectionCardinality ?? value.collectionCardinality;
        if (state) value.collectionCardinality = state;
        if (added === undefined || !this.definiteCollectionMutation() || state?.untrackedAliases) {
            if (state) {
                state.count = undefined;
                if (this.frameCallbackDepth > 0 ||
                    (!this.parameterizedResourceIterations.length && this.isInNativeFunctionBody())) {
                    state.untrackedAliases = true;
                }
            }
            return false;
        }
        if (!state) return true;
        let repetitions = 1;
        for (const current of this.parameterizedResourceIterations) {
            if (state.createdIn.includes(current)) continue;
            repetitions *= current.iterations;
            if (added !== 0 && current.iterations > 1) state.varyingIn.add(current);
        }
        if (state.count !== undefined) {
            const count = state.count + added * repetitions;
            state.count = Number.isSafeInteger(count) ? count : undefined;
        }
        return true;
    }

    public recordCollectionKey(value: Value, key: Value, removed = false): void {
        const state = value.collectionCardinality;
        if (!state || state.kind !== "keyed") return;
        const scalar = key.staticNumber ?? key.staticString ?? key.staticBoolean;
        if (scalar === undefined || !this.definiteCollectionMutation() || state.untrackedAliases) {
            state.count = undefined;
            delete state.keys;
            if (this.frameCallbackDepth > 0 ||
                (!this.parameterizedResourceIterations.length && this.isInNativeFunctionBody())) {
                state.untrackedAliases = true;
            }
            return;
        }
        if (!state.keys) return;
        const changed = removed ? state.keys.has(scalar) : !state.keys.has(scalar);
        if (removed) state.keys.delete(scalar);
        else state.keys.add(scalar);
        state.count = state.keys.size;
        if (changed) {
            for (const current of this.parameterizedResourceIterations) {
                if (!state.createdIn.includes(current) && current.iterations > 1) state.varyingIn.add(current);
            }
        }
    }

    public recordCollectionClear(value: Value): void {
        const state = value.collectionCardinality;
        if (!state || state.kind !== "keyed") return;
        if (this.definiteCollectionMutation() && !state.untrackedAliases) {
            state.keys = new EmissionSet();
            state.count = 0;
        } else {
            delete state.keys;
            state.count = undefined;
        }
    }

    /** Invalidate one native map/object snapshot through all shared aliases. */
    public invalidateRecordProperties(value: Value): void {
        const properties = value.recordProperties;
        if (!properties) return;
        const invalidate = (candidate: Value): void => {
            if (candidate.recordProperties === properties) {
                delete candidate.recordProperties;
            }
        };
        this.visitScopedValues(invalidate);
        invalidate(value);
    }

    /**
     * The scope depth the outermost enclosing frame callback started at.
     *
     * Everything at or above it lives on that callback's own stack frame.
     * A deferred (`setTimeout`) callback runs AFTER that frame has
     * returned, so naming one of those locals would emit a reference to
     * dead storage -- which is why `deferredCaptureFloor` refuses it.
     */
    private frameCallbackScopeFloor: number | undefined;

    /**
     * Set while a deferred callback's body is being compiled. A binding
     * resolved at or above this depth belongs to a frame that will be
     * gone when the callback runs.
     */
    private deferredCaptureFloor: number | undefined;

    /** First callback-owned scope, which is safe for that callback to read. */
    private deferredCaptureCeiling: number | undefined;

    /**
     * Scope depth at which a nested persistent callback begins. Platform event
     * objects are borrowed from the dispatch stack, so only bindings introduced
     * at or below this callback may refer to one.
     */
    private escapingPlatformEventCaptureFloor: number | undefined;

    public pushScope(cppPrefix: string, propagateRebindings = false): void {
        const scope = new EmissionMap<ts.Symbol, VariableBinding>();
        if (propagateRebindings) this.transparentRebindingScopes.add(scope);
        this.variableScopes.push(scope);
        this.cppNamePrefixes.push(cppPrefix);
    }

    public popScope(): void {
        if (this.variableScopes.length === 1) {
            throw new Error("Cannot pop the compiler root scope.");
        }
        this.variableScopes.pop();
        this.cppNamePrefixes.pop();
    }

    public expectKind(value: Value, kind: ValueKind, node: ts.Node): void {
        if (value.kind !== kind) {
            this.fail(node, `Expected ${kind}, received ${value.kind}.`);
        }
    }

    public expectShaderVariant(
        value: Value,
        variant: string,
        node: ts.Node,
    ): void {
        if (value.shaderVariant !== variant) {
            this.fail(
                node,
                `Shader operation requires the '${variant}' reached variant.`,
            );
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
                this.fail(node, "Standalone Canvas2D presentation is not lowered in worker realms.");
            }
            const name = this.allocateTemporaryCppName("presentation_host");
            this.presentationHostCpp = name;
            this.defaultEngineCpp = name;
            // Preamble storage precedes every closure, even one currently
            // being compiled. Its capture boundary therefore is entry scope.
            this.nativeBindings.set(name, {
                name, sequence: 0, borrowed: true, allowReference: false, entryLifetime: true,
            });
        }
        return this.requireDefaultEngine(node);
    }

    /**
     * The scene-material manifest recorders live in
     * `compiler/scene-materials.ts`; the context surface the material
     * intrinsics stamp through delegates to one recorder instance, so
     * its callers keep one context object.
     */
    public get scenePbrMaterials(): ScenePbrMaterialManifest[] {
        return this.sceneMaterials.scenePbrMaterials;
    }

    public recordScenePbrNoColorView(sourceIndex: number | undefined): number {
        this.sceneMaterialGltfAssetsBefore.push(this.currentGltfAssetCount());
        return this.sceneMaterials.recordScenePbrNoColorView(sourceIndex);
    }

    public recordSceneMaterialSlot(): number {
        this.sceneMaterialGltfAssetsBefore.push(this.currentGltfAssetCount());
        return this.sceneMaterials.recordSceneMaterialSlot();
    }

    public currentGltfAssetCount(): number {
        return [...this.assets.values()]
            .filter((asset) => asset.kind === "gltf")
            .reduce((count, asset) => count + (asset.containerCount ?? 0), 0);
    }

    public recordScenePbrUnlit(index: number | undefined): void {
        this.sceneMaterials.recordScenePbrUnlit(index);
    }

    public recordScenePbrSkybox(index: number | undefined): void {
        this.sceneMaterials.recordScenePbrSkybox(index);
    }

    public recordScenePbrGammaAlbedo(index: number | undefined): void {
        this.sceneMaterials.recordScenePbrGammaAlbedo(index);
    }

    public recordScenePbrShadowOnly(index: number | undefined, options: NonNullable<ScenePbrMaterialManifest["shadowOnly"]>): void {
        this.sceneMaterials.recordScenePbrShadowOnly(index, options);
    }

    public recordScenePbrPlugins(
        plugins: readonly MaterialPluginManifest[],
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrPlugins(plugins, index);
    }

    public recordStandardMaterialPlugins(
        plugins: readonly MaterialPluginManifest[],
        material: NonNullable<Value["standardMaterialInput"]>,
    ): number {
        return this.sceneMaterials.recordStandardMaterialPlugins(
            plugins,
            material,
        );
    }

    /**
     * Runs `work` with an inlined function's parameters bound in a scope of
     * its own -- the same binding the user-function inliner performs before
     * it lowers a body, exposed for the folds that read a body instead.
     *
     * A `MaterialPlugin` returned by a local factory closes over the
     * arguments, so folding its members means resolving the factory's
     * parameter names to what the call site passed; nothing else about the
     * body is entered.
     *
     * The scope takes an allocated prefix, exactly as every other inliner's
     * does. A binding still DECLARES a native local, so an empty prefix
     * spells one `v_<parameter>` per call: two calls of one factory would
     * redefine it, and a parameter sharing a name with a scene local would
     * collide with that local's own declaration.
     */
    public withBoundParameters<T>(
        parameters: readonly { name: ts.Identifier; value: Value }[],
        work: () => T,
    ): T {
        if (parameters.length === 0) return work();
        this.pushScope(this.allocateBlockPrefix());
        try {
            for (const parameter of parameters) {
                this.bindParameterValue(parameter.name, parameter.value);
            }
            return work();
        } finally {
            this.popScope();
        }
    }

    public recordScenePbrSheen(
        sheen: ScenePbrSheenManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrSheen(sheen, index);
    }

    public recordScenePbrClearCoat(
        clearCoat: ScenePbrClearCoatManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrClearCoat(clearCoat, index);
    }

    public recordScenePbrEmissive(
        color: readonly [number, number, number] | undefined,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrEmissive(color, index);
    }

    public recordScenePbrIridescence(
        iridescence: ScenePbrIridescenceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrIridescence(iridescence, index);
    }

    public recordScenePbrLightmap(
        lightmap: ScenePbrLightmapManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrLightmap(lightmap, index);
    }

    /** Whether `enablePbrLightmap()` has registered the extension yet. */
    public pbrLightmapEnabled(): boolean {
        return this.features.has("material:lightmap");
    }

    /**
     * Records the `setPbrLightmap` a scene applied to a loaded container's
     * materials, with the mesh-name filter the walk selected them by.
     *
     * `sceneUnlit` beside this is container-wide; a lightmap is not. PBR
     * composition is settled per material at generation, and the reached
     * walk stamps only the meshes whose name passes its own filter — so
     * what is kept is that filter, for the DOCUMENT to evaluate against
     * its own renderables. Nothing here reads a name.
     */
    public recordAssetSceneLightmap(
        meshNamePredicate: SceneMeshNamePredicate,
        lightmap: ScenePbrLightmapManifest,
        node: ts.Node,
    ): void {
        // `scene.meshes` is walked live, so what generation folds is the
        // scene's mesh membership at this point in the program. A
        // scene-code mesh already created could be in that list under a
        // name generation does not carry, and a second container could be
        // in or out of it depending on where its `addToScene` sits —
        // neither is represented, so both refuse rather than stamping a
        // set the run-time loop will not reproduce.
        const containers = [...this.assets.values()].filter(
            (candidate) => candidate.kind === "gltf",
        );
        if (
            containers.length !== 1 ||
            (containers[0]!.containerCount ?? 0) > 1
        ) {
            this.fail(
                node,
                "A lightmap walk over `scene.meshes` folds against exactly " +
                    "one loaded glTF container: with several, which of them " +
                    "the walk has reached depends on where each " +
                    "`addToScene` sits, which generation does not model.",
            );
        }
        if (this.sceneMeshes.length > 0) {
            this.fail(
                node,
                "A lightmap walk over `scene.meshes` runs before the scene " +
                    "creates any mesh of its own: generation carries no name " +
                    "for a scene-code mesh, so it could not tell whether the " +
                    "filter selects one.",
            );
        }
        const asset = containers[0]!;
        const existing = asset.sceneLightmap;
        if (
            existing &&
            JSON.stringify(existing) !==
                JSON.stringify({ meshNamePredicate, options: lightmap })
        ) {
            this.fail(
                node,
                "setPbrLightmap already stamped this container's materials " +
                    "differently; each material composes one lightmap arm, " +
                    "so a second selection would need the blend and the UV " +
                    "set to be per-material record reads.",
            );
        }
        asset.sceneLightmap = { meshNamePredicate, options: lightmap };
    }

    public recordScenePbrSubsurface(
        subsurface: ScenePbrSubsurfaceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrSubsurface(subsurface, index);
    }

    public recordScenePbrAnisotropy(
        anisotropy: ScenePbrAnisotropyManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrAnisotropy(anisotropy, index);
    }

    public recordScenePbrMetallicReflectance(
        reflectance: ScenePbrMetallicReflectanceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrMetallicReflectance(
            reflectance,
            index,
        );
    }

    /** One layer or system built without a custom shader, so with the stock program. */
    public recordPlainSpriteProgram(family: "sprite" | "billboard"): void {
        if (family === "sprite") this.reachedPlainSpriteLayer = true;
        else this.reachedPlainBillboardSystem = true;
    }

    public recordPureSpriteVertex(): void {
        this.reachedPureSpriteVertex = true;
    }

    public spriteCustomShaders(): readonly SpriteCustomShaderManifest[] {
        return this.sceneSpriteCustomShaders;
    }

    /** One custom-shader descriptor, in the pin's own `_key` order. */
    public recordSpriteCustomShader(shader: SpriteCustomShaderManifest): void {
        this.sceneSpriteCustomShaders.push(shader);
    }

    /**
     * The shader plugins one `loadSplat` call passed.
     *
     * Upstream keys its module cache by the plugin ids, so two clouds
     * loaded with different lists compile different modules; this port
     * deploys one splat stage pair, so a second differing list refuses
     * rather than drawing both clouds through the first one's.
     */
    public recordSplatFragments(
        fragments: readonly SplatFragmentManifest[],
        node: ts.Node,
    ): void {
        if (!this.sceneSplatFragments) {
            this.sceneSplatFragments = [...fragments];
            return;
        }
        if (
            JSON.stringify(this.sceneSplatFragments) !==
            JSON.stringify(fragments)
        ) {
            this.fail(
                node,
                "A second loadSplat with a different shader-fragment list " +
                    "is not lowered: the generated splat stages are one " +
                    "composed module per scene.",
            );
        }
    }

    /**
     * Records one shadow generator, returning its reach index.
     *
     * Its casters arrive separately, through `recordShadowCasterMaterials`:
     * the pin keeps them as a lazy task input rather than on the generator,
     * and `setShadowTaskCasterMeshes` is the call that names them.
     */
    public recordShadowGenerator(
        entry: Omit<ShadowGeneratorManifest, "casters"> & {
            lightIdentity?: NonNullable<Value["lightIdentity"]>;
        },
    ): number {
        this.shadowGenerators.push({ ...entry, casters: [] });
        return this.shadowGenerators.length - 1;
    }

    private dynamicShadowLightIndex(index: number): number | undefined {
        const candidates =
            this.shadowGenerators[index]?.lightIdentity?.dataCollectionIndices;
        return candidates?.size === 1 ? [...candidates][0] : undefined;
    }

    /** Preserve a light's position when a compile-time tuple becomes data. */
    public recordDataLightSlot(value: Value, index: number): void {
        if (!value.lightIdentity) return;
        const slots =
            value.lightIdentity.dataCollectionIndices ?? new EmissionSet<number>();
        slots.add(index);
        value.lightIdentity.dataCollectionIndices = slots;
    }

    /**
     * The filter and light slot one recorded generator was built with.
     *
     * A node material names its generators rather than its lights, and the
     * pin reads only `_shadowType` off each one -- so this is the pair the
     * composition needs, resolved through the record the factory made.
     */
    public shadowGeneratorLight(
        index: number,
        node: ts.Node,
    ): { lightIndex: number } {
        const generator = this.shadowGenerators[index];
        if (!generator) {
            this.fail(node, `Shadow generator ${index} was never recorded.`);
        }
        if (generator.lightIndex < 0) {
            this.fail(
                node,
                "A node material's shadow generator light must be added to the scene before the material is parsed.",
            );
        }
        return { lightIndex: generator.lightIndex };
    }

    /** Records that a mesh carries the per-instance RGBA stream. */
    public recordThinInstanceColorMesh(
        sceneMeshIndex: number | undefined,
    ): void {
        if (sceneMeshIndex === undefined) {
            // A handle selected from a runtime pool has lost its one static
            // scene index, but it can only name a mesh that already owns a
            // thin-instance pool. Keep every such row's coloured arm; the
            // runtime key still selects it only after colors are attached.
            for (const mesh of this.sceneMeshes) {
                if (mesh.thinInstances) {
                    mesh.thinInstanceColors = true;
                }
            }
            return;
        }
        const mesh = this.sceneMeshes[sceneMeshIndex];
        if (mesh) mesh.thinInstanceColors = true;
    }

    /**
     * Settles each scene-local shader program's instanced form.
     *
     * The pin builds the instanced pipeline from the MESH -- `hasColor` is
     * `!!ti.colors && material._tic != 0`, and this port refuses the `_tic`
     * key, so the mesh decides outright -- and it builds one pipeline per
     * renderable, keyed `"" + +hasColor`. This port bakes one variant into
     * the material record instead, so the lanes are settled once, after the
     * entry, from the pairs recorded on the way through.
     */
    private settleShaderThinInstances(): void {
        for (const [variant, colors] of shaderThinInstanceLanes(
            this.sceneMeshes,
            (message) => this.failAtFile(message),
        )) {
            const program = this.reachedShaderProgram(variant, this.sourceFile);
            program.useThinInstances = true;
            if (colors) program.useThinInstanceColors = true;
        }
    }

    /** Which material a scene-code mesh was assigned, by its mesh index. */
    public recordSceneMeshMaterial(
        meshIndex: number,
        material: {
            pbrMaterial: number | null;
            nodeMaterial: number | null;
            standardMaterial: boolean;
            standardMaterialPluginIndex?: number | undefined;
            sceneShaderVariant?: string | undefined;
            sceneShaderVariants?: readonly string[] | undefined;
        },
    ): void {
        this.sceneMeshMaterials.set(meshIndex, {
            pbrMaterial: material.pbrMaterial,
            nodeMaterial: material.nodeMaterial,
        });
        if (material.standardMaterial) {
            const mesh = this.sceneMeshes[meshIndex];
            if (mesh) {
                mesh.standardMaterial = true;
                if (material.standardMaterialPluginIndex !== undefined) {
                    mesh.standardMaterialPluginIndex =
                        material.standardMaterialPluginIndex;
                }
            }
        }
        const shaderMesh = this.sceneMeshes[meshIndex];
        if (shaderMesh) {
            if (this.isInRuntimeControlFlow()) {
                const variants = new EmissionSet([
                    ...(shaderMesh.shaderVariant === undefined ? [] : [shaderMesh.shaderVariant]),
                    ...(shaderMesh.shaderVariants ?? []),
                    ...(material.sceneShaderVariant === undefined ? [] : [material.sceneShaderVariant]),
                    ...(material.sceneShaderVariants ?? []),
                ]);
                delete shaderMesh.shaderVariant;
                if (variants.size > 0) shaderMesh.shaderVariants = [...variants].sort();
            } else {
                if (material.sceneShaderVariant === undefined) delete shaderMesh.shaderVariant;
                else shaderMesh.shaderVariant = material.sceneShaderVariant;
                if (material.sceneShaderVariants === undefined) delete shaderMesh.shaderVariants;
                else shaderMesh.shaderVariants = material.sceneShaderVariants;
            }
        }
        if (material.pbrMaterial !== null) {
            const meshes =
                this.scenePbrMaterialMeshes.get(material.pbrMaterial) ??
                new EmissionSet<number>();
            meshes.add(meshIndex);
            this.scenePbrMaterialMeshes.set(material.pbrMaterial, meshes);
        }
    }

    /** A material assignment reached a mesh handle not tied to one static
     *  scene-mesh row (for example an imported collection element). */
    public recordUnknownSceneMeshMaterial(materialIndex: number): void {
        this.scenePbrMaterialsWithUnknownMesh.add(materialIndex);
    }

    public recordUnknownSceneMaterialAssignment(): void {
        this.unknownSceneMaterialAssignment = true;
    }

    public recordUnknownStandardMeshMaterial(): void {
        this.standardMaterialUnknownMesh = true;
    }

    public recordSceneMeshAssetPbrMaterial(meshIndex: number): void {
        const mesh = this.sceneMeshes[meshIndex];
        if (!mesh) {
            throw new Error(
                `Scene mesh ${meshIndex} was not recorded before its asset material assignment.`,
            );
        }
        mesh.assetPbrMaterial = true;
    }

    /**
     * A definite skeleton or morph attachment on a scene-code mesh.
     *
     * The pin's `_computeMeshFeatures` reads these mesh properties for
     * the material variant key. Record them beside the scene-created
     * mesh's streams so composition executes that same predicate.
     */
    public recordSceneMeshDeformation(
        meshIndex: number,
        property: "skinned" | "morphTargets",
        site: ts.Node,
    ): void {
        const mesh = this.sceneMeshes[meshIndex];
        if (!mesh) {
            throw new Error(
                `Scene mesh ${meshIndex} was not recorded before its ${property} assignment.`,
            );
        }
        if (property === "morphTargets" && mesh.morphTargets) {
            this.fail(site,
                "Replacing a direct morph target attachment is not supported; " +
                "updates to detached morph resources require independent storage.");
        }
        mesh[property] = true;
    }

    public recordShadowCasters(
        generatorIndex: number,
        casters: readonly ShadowCasterMeshManifest[],
    ): void {
        const generator = this.shadowGenerators[generatorIndex];
        if (!generator) {
            throw new Error(
                `Shadow generator ${generatorIndex} was never recorded.`,
            );
        }
        generator.casters = [...casters];
    }

    public recordDynamicShadowCasters(generatorIndex: number): void {
        const generator = this.shadowGenerators[generatorIndex];
        if (!generator) {
            throw new Error(
                `Shadow generator ${generatorIndex} was never recorded.`,
            );
        }
        generator.dynamicCasters = true;
    }

    /** A runtime-selected generator may denote any reached generator. */
    public recordDynamicShadowCastersForUnknownGenerator(): void {
        for (const generator of this.shadowGenerators) {
            generator.dynamicCasters = true;
        }
    }

    /**
     * Which resource row the NEXT ESM generator takes.
     *
     * Generation composes one row per ESM factory call, in reach order, so
     * the ordinal is settled here rather than counted again at run time.
     */
    public esmGeneratorOrdinal(): number {
        return this.shadowGenerators.filter(
            (generator) => generator.kind === "esm-directional",
        ).length;
    }

    /** `mesh.receiveShadows = true`, by scene-mesh index. */
    public recordShadowReceiver(sceneMeshIndex: number): void {
        this.shadowReceiverMeshes.add(sceneMeshIndex);
    }

    public recordDynamicShadowReceivers(): void {
        this.dynamicShadowReceivers = true;
    }

    /**
     * `mesh.id = "..."`, by the handle spelling the write named.
     *
     * Nothing is emitted: the pin's only reader of `Mesh.id` is
     * `affectsMesh`, whose join `resolveSceneMeshIds` folds, so the string
     * has no run-time reader to store it for. A write that would make an
     * ALREADY-emitted include set stale refuses instead, because the fold
     * cannot revisit a statement it has written.
     */
    public recordSceneMeshId(meshCpp: string, id: string, node: ts.Node): void {
        const previous = this.sceneMeshIdByHandle.get(meshCpp);
        if (previous === id) return;
        const stale = this.resolvedLightMeshIds.has(id)
            ? id
            : previous !== undefined && this.resolvedLightMeshIds.has(previous)
              ? previous
              : undefined;
        if (stale !== undefined) {
            this.fail(
                node,
                `Mesh id "${stale}" already resolved a light's ` +
                    "includedOnlyMeshIds, so this write would change a " +
                    "selection generation has emitted. Assign every " +
                    "mesh id before restricting a light by it.",
            );
        }
        if (previous !== undefined) {
            const bound = this.sceneMeshesById.get(previous);
            const at = bound?.indexOf(meshCpp) ?? -1;
            if (bound && at >= 0) bound.splice(at, 1);
        }
        this.sceneMeshIdByHandle.set(meshCpp, id);
        const meshes = this.sceneMeshesById.get(id);
        if (meshes) {
            if (!meshes.includes(meshCpp)) meshes.push(meshCpp);
        } else {
            this.sceneMeshesById.set(id, [meshCpp]);
        }
    }

    /**
     * The meshes a light's `includedOnlyMeshIds` set names, as handle
     * spellings, in the Set's own insertion order.
     *
     * The pin gates on the SET being non-empty (`included?.size`), not on
     * what it resolves to, so an id no mesh carries would light nothing at
     * all — a state an index vector cannot express, since an empty one is
     * how the record says "every mesh". That id refuses here rather than
     * silently taking the other arm.
     */
    public resolveSceneMeshIds(
        ids: readonly string[],
        node: ts.Node,
    ): string[] {
        const meshes: string[] = [];
        for (const id of new EmissionSet(ids)) {
            const bound = this.sceneMeshesById.get(id);
            if (!bound || bound.length === 0) {
                this.fail(
                    node,
                    `No mesh carries the id "${id}". A light include ` +
                        "set naming an id no mesh has lights nothing " +
                        "upstream, which the folded per-mesh index list " +
                        "cannot express.",
                );
            }
            this.resolvedLightMeshIds.add(id);
            for (const mesh of bound) {
                if (!meshes.includes(mesh)) meshes.push(mesh);
            }
        }
        return meshes;
    }

    /** Place a light in the current scene topology and bind its generators. */
    public addSceneLight(scene: Value, light: Value, kind: LightKind): void {
        const identity = light.lightIdentity;
        if (!identity) {
            throw new Error("A scene light is missing its compiler identity.");
        }
        const topology = scene.sceneTopologyState ??
            this.sceneTopologyStates.get(scene.cpp) ?? { lights: [] };
        scene.sceneTopologyState = topology;
        this.sceneTopologyStates.set(scene.cpp, topology);
        const index = topology.lights.length;
        topology.lights.push({ identity, kind });
        this.sceneLights.push({ identity, kind });
        if (
            identity.sceneLightIndex !== undefined &&
            identity.sceneLightIndex !== index
        ) {
            throw new Error(
                "A shadow-casting light occupies different light slots across scenes; " +
                    "scene-specific receiver variants are not lowered.",
            );
        }
        identity.sceneLightIndex = index;
        if (identity.shadowGeneratorIndex !== undefined) {
            const generator =
                this.shadowGenerators[identity.shadowGeneratorIndex];
            if (generator) generator.lightIndex = index;
        }
        if (this.frameCallbackDepth > 0 || this.engineHasStarted()) {
            this.dynamicSceneLights = true;
        }
    }

    /** A light recovered from native data has no single AOT kind/identity. */
    public addDynamicSceneLight(): void {
        this.dynamicSceneLights = true;
    }

    /** Remove a light and compact the slots exactly as Array.splice does. */
    public removeSceneLight(scene: Value, light: Value): void {
        const identity = light.lightIdentity;
        if (!identity) return;
        const topology = scene.sceneTopologyState ??
            this.sceneTopologyStates.get(scene.cpp) ?? { lights: [] };
        scene.sceneTopologyState = topology;
        this.sceneTopologyStates.set(scene.cpp, topology);
        const index = topology.lights.findIndex(
            (entry) => entry.identity === identity,
        );
        if (index < 0) return;
        topology.lights.splice(index, 1);
        const globalIndex = this.sceneLights.findIndex(
            (entry) => entry.identity === identity,
        );
        if (globalIndex >= 0) this.sceneLights.splice(globalIndex, 1);
        delete identity.sceneLightIndex;
        for (let slot = index; slot < topology.lights.length; slot++) {
            const moved = topology.lights[slot]!.identity;
            moved.sceneLightIndex = slot;
            if (moved.shadowGeneratorIndex !== undefined) {
                const generator =
                    this.shadowGenerators[moved.shadowGeneratorIndex];
                if (generator) generator.lightIndex = slot;
            }
        }
        if (this.frameCallbackDepth > 0 || this.engineHasStarted()) {
            this.dynamicSceneLights = true;
        }
    }

    /** A tone-mapping enable write can occur after environment loading, and
     *  callback writes can alternate it at run time. */
    public recordToneMappingEnabledMutation(): void {
        this.mutableToneMappingEnabled = true;
    }

    /** Records the exact mesh on which a thin-instance pool exists. */
    public recordThinInstanceMesh(sceneMeshIndex: number | undefined): void {
        if (sceneMeshIndex === undefined) return;
        const mesh = this.sceneMeshes[sceneMeshIndex];
        if (!mesh) return;
        if (this.frameCallbackDepth > 0 && mesh.thinInstances !== "always") {
            mesh.thinInstances = "possible";
        } else {
            mesh.thinInstances = "always";
        }
    }

    /**
     * Whether a `mesh.thinInstances` read on this value can stand.
     *
     * A mesh whose scene identity generation resolved is answered from what
     * it recorded, so a source reading the pool of a mesh that never binds
     * one is refused at its own line. A mesh that arrives as a runtime
     * handle -- read out of plain data, indexed out of a collection -- has
     * no compile-time identity to ask about, so the question is the
     * runtime's: the emitted read raises the pin's own non-null failure.
     */
    public meshHasThinInstancePool(owner: Value): boolean {
        return (
            owner.sceneMeshIndex === undefined ||
            this.sceneMeshes[owner.sceneMeshIndex]?.thinInstances !== undefined
        );
    }

    /**
     * Records that this mesh reached an `enableThinInstanceGpuCulling` that
     * can leave the pin's `_gpuCullingEnabled` set.
     */
    public recordThinInstanceGpuCulling(
        sceneMeshIndex: number | undefined,
    ): void {
        if (sceneMeshIndex === undefined) return;
        const mesh = this.sceneMeshes[sceneMeshIndex];
        if (!mesh) return;
        mesh.thinInstanceGpuCulling = true;
    }

    /**
     * Whether a statically-`false` culling opt-in on this value still has
     * something to say.
     *
     * `_gpuCullingEnabled` starts false, so a `false` call is the pin's own
     * idempotent early return unless an enabling call already ran on the
     * same mesh — which is a question about this mesh's own state, answered
     * from what it recorded during the same single deterministic walk that
     * records its pool. A mesh with no compile-time identity has no such
     * state to read, so the call stands and the runtime decides.
     */
    public meshMayHaveThinInstanceGpuCulling(owner: Value): boolean {
        return (
            owner.sceneMeshIndex === undefined ||
            this.sceneMeshes[owner.sceneMeshIndex]?.thinInstanceGpuCulling ===
                true
        );
    }

    /** Records a scene-code mesh creation for the per-renderable variant key. */
    public recordSceneMesh(
        kind: string,
        streams?: {
            hasUv2: boolean;
            hasTangents: boolean;
            hasColors: boolean;
            runtimeStreams?: true;
        },
    ): number {
        this.sceneMeshes.push({
            kind,
            gltfAssetsBefore: this.currentGltfAssetCount(),
            ...(streams ?? {}),
        });
        return this.sceneMeshes.length - 1;
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
     */
    /**
     * Records that this scene composes the clustered light fragment.
     *
     * Only `hasSpots` reaches composition -- it decides which of the pin's
     * two extensions detects a material, and with it the data layout the
     * fragment reads -- so that is what travels to the compose pipeline.
     */
    public reachClusteredContainer(
        state: ClusteredContainerState,
        node: ts.Node,
    ): void {
        if (
            this.clusteredContainer &&
            this.clusteredContainer.hasSpots !== state.hasSpots
        ) {
            this.fail(
                node,
                "Two clustered light containers disagree about spot " +
                    "lights: the composed fragment carries one data layout.",
            );
        }
        this.clusteredContainer = state;
    }

    /**
     * `site` is the scene-source node that reached the feature, or — for a
     * feature an audited companion file reaches with no call in the scene
     * to name — the already-formatted location of that file.
     */
    public reachFeature(feature: Feature, site?: ts.Node | string): void {
        if ((feature === "math:mat4-invert" && this.features.has("renderer:high-precision-matrix")) ||
            (feature === "renderer:high-precision-matrix" && this.features.has("math:mat4-invert"))) {
            this.fail(typeof site === "object" ? site : this.sourceFile,
                "mat4Invert currently requires Float32 Mat4 storage; high-precision matrix allocation is not supported by this scene-code intrinsic.");
        }
        // Every raw Web Audio node/asset feature is implemented by the same
        // engine PAL and can only be reached through one of its contexts.
        // Record that dependency even when the creating call lives in a
        // deferred platform callback that is lowered after another audio
        // callback first reaches a node family.
        if (feature.startsWith("audio:") && feature !== "audio:engine") {
            this.reachFeature("audio:engine", site);
        }
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
                    "        engine.render_targets[target.value].surface_canvas = scene.surface_canvas;",
                    "        engine.render_targets[resolve_target.value].surface_canvas = scene.surface_canvas;",
                    "        auto render_task = bbl::create_render_task(engine, scene, " +
                        'bbl::RenderTaskOptions{"default-render-task", target, scene.clear_color, true, ' +
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
            setup: `auto ${sceneCpp} = ${scene.cpp};\n` +
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

    public recordGeometryOutputTask(
        manifest: GeometryOutputTaskManifest,
    ): void {
        this.geometryOutputTasks.push(manifest);
    }

    public recordPostProcessTask(manifest: PostProcessTaskManifest): void {
        this.postProcessTasks.push(manifest);
    }

    public recordPostProcessComposite(
        manifest: PostProcessCompositeManifest,
        site: ts.Node,
    ): void {
        if (manifest.intrinsic === "createTaaPostProcessTask" &&
            (this.frameCallbackDepth > 0 || this.engineStartMark !== undefined)) {
            this.fail(site, "TAA task creation after frame execution is not lowered; its source must retain scene UBO history from its first frame.");
        }
        if (manifest.intrinsic === "createTaaPostProcessTask" && this.temporalSceneRegistration) {
            this.fail(site, "TAA tasks must be constructed and attached before initial scene registration; later task record epochs are not lowered.");
        }
        this.postProcessComposites.push(manifest);
    }

    public recordScreenSpaceTask(manifest: ScreenSpaceTaskManifest): void {
        this.screenSpaceTasks.push(manifest);
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

    public cppIdentifier(sourceName: string): string {
        const prefix = this.cppNamePrefixes.at(-1) ?? "";
        return `v_${prefix}${sanitizeCppIdentifier(sourceName)}`;
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
        const code = typeof line === "string" ? line : renderNativeDeclaration(line);
        if (typeof line !== "string") this.nativeDeclarations.set(code, {
            ...line, dependencies: [...this.statementDependencies.at(-1) ?? []].map(binding => binding.name),
        });
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
    private engineStartMark:
        | {
              index: number;
              engine: string;
              node: ts.Node;
              indentLevel: number;
          }
        | undefined;

    private continuationStorageReached = false;

    private readonly deviceRecoveryCallbacks: Array<{ cpp: string; options: Value; node: ts.Expression }> = emissionArray([]);

    public compileDeviceRecoveryIntrinsic(name: string, call: ts.CallExpression): Value | undefined {
        if (!["enableDeviceLostSceneRecovery", "forceWebGpuDeviceLossForTesting", "disposeEngine"].includes(name)) return undefined;
        this.expectArgumentCount(call, 1, name === "enableDeviceLostSceneRecovery" ? 2 : 1);
        const engine = this.compileValue(argumentAt(call, 0));
        this.expectKind(engine, "engine", argumentAt(call, 0));
        this.reachFeature("engine:device-recovery", call);
        if (name === "enableDeviceLostSceneRecovery") {
            if (this.engineHasStarted() || this.isRuntimeResourceConstruction()) this.fail(call, "Device recovery registration requires unconditional construction before engine startup.");
            const cpp = this.allocateTemporaryCppName("device_recovery");
            this.emit({ kind: "declaration", type: "auto", name: cpp, initializer: `bbl::enable_device_lost_scene_recovery(${engine.cpp})` });
            if (call.arguments[1]) {
                const node = call.arguments[1];
                const options = this.compileValue(node);
                this.expectKind(options, "record", node);
                const allowed = new EmissionSet(["onLost", "onRecovered", "onRecoveryFailed"]);
                for (const key of [...Object.keys(options.recordProperties ?? {}), ...Object.keys(options.recordMethods ?? {})]) {
                    if (!allowed.has(key)) this.fail(node, `Unrepresented device recovery option '${key}'.`);
                }
                this.deviceRecoveryCallbacks.push({ cpp, options, node });
            }
            return { kind: "device-recovery", cpp, engineCpp: engine.cpp, dataType: { kind: "handle", handle: "device-recovery" } };
        }
        return { kind: "void", cpp: name === "disposeEngine" ? `bbl::dispose_engine(${engine.cpp})` : `bbl::force_device_loss(${engine.cpp})` };
    }

    private emitDeviceRecoveryCallbacks(): void {
        for (const registration of this.deviceRecoveryCallbacks.splice(0)) {
            const options = registration.options;
            for (const [source, target] of [["onLost", "on_lost"], ["onRecovered", "on_recovered"], ["onRecoveryFailed", "on_failed"]] as const) {
                const callback = options.recordMethods?.[source] ?? options.recordProperties?.[source]?.callbackDeclaration;
                if (!callback) {
                    if (options.recordProperties?.[source]) this.fail(registration.node, `Device recovery '${source}' requires a callback declaration.`);
                    continue;
                }
                const declaration = ts.isIdentifier(callback) ? tryResolveFunctionDeclaration(this.checker, callback) : callback;
                if (!declaration || declaration.parameters.length > (target === "on_failed" ? 1 : 0)) this.fail(callback, `The recovery '${source}' callback parameters are not represented.`);
                const parameter = target === "on_failed" ? { kind: "record", cpp: "", nativeError: true, truthinessCpp: "true", recordProperties: { message: { kind: "string", cpp: "error", dataType: { kind: "string" } } } } satisfies Value : undefined;
                const lines = this.captureEmittedLines(() => {
                    const result = this.compileCallbackWithValues(callback, parameter ? [parameter] : [], registration.node);
                    this.emitDiscardedValue(result);
                });
                this.emit(`${registration.cpp}->${target} = [&](${parameter ? "[[maybe_unused]] const std::string& error" : ""}) {`);
                this.increaseIndent(); for (const line of lines) this.emit(line); this.decreaseIndent(); this.emit("};");
            }
        }
    }

    public markEngineStart(engineCpp: string, node: ts.Node): void {
        this.emitDeviceRecoveryCallbacks();
        if (this.ui.primaryCanvasReadyGate) this.emit(`bbl::defer_capture_until(${engineCpp}, [&]() { return bbl::canvas_dataset(${engineCpp}, "ready") == "true"; });`);
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
        for (const line of cleanup) this.emit(line);
        this.decreaseIndent();
        this.emit("});");
        return guard;
    }

    /** Keep a flat try/finally alive across the startEngine continuation. */
    public emitEngineFinally(body: readonly string[], cleanup: readonly string[], site: ts.TryStatement): boolean {
        const mark = this.engineStartMark;
        if (!mark || site.catchClause) return false;
        const start = body.findIndex((line) => line.startsWith("bbl::start_engine("));
        if (start < 0) return false;
        // The two lifetime guards can run while C++ is unwinding. A second
        // exception would terminate rather than replace the source exception.
        // Until finally has explicit completion lowering, admit plain cleanup
        // writes and refuse calls/accessors whose exception effects are unknown.
        const checkCleanup = (node: ts.Node): void => {
            if (ts.isFunctionLike(node)) return;
            const properties = ts.isPropertyAccessExpression(node)
                ? [this.checker.getSymbolAtLocation(node.name)]
                : ts.isElementAccessExpression(node)
                    ? this.checker.getTypeAtLocation(node.expression).getProperties() : [];
            const accessor = properties.some((property) => property?.declarations?.some(
                (declaration) => ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration),
            ));
            if (ts.isThrowStatement(node) || ts.isCallExpression(node) || ts.isNewExpression(node) || accessor) {
                this.fail(node, "A finally block spanning startEngine requires non-throwing cleanup; calls, accessors and throw are not admitted.");
            }
            ts.forEachChild(node, checkCleanup);
        };
        if (site.finallyBlock) checkCleanup(site.finallyBlock);
        if (body.slice(start + 1).some((line) =>
            line.trim() === Compiler.frameYieldRequeueMarker ||
            line.trim().startsWith(Compiler.startContinuationGatePrefix))) {
            this.fail(site, "A finally block spanning startEngine cannot also span a later frame yield.");
        }
        const guard = this.emitFinallyGuard(cleanup);
        for (const line of body.slice(0, start)) this.emit(line);
        mark.index = this.body.length;
        mark.indentLevel = this.indentLevel;
        this.emit(body[start]!);
        // The outer guard covers setup/start failures. The continuation
        // guard finishes cleanup on its own normal, return or exception
        // completion, while the outer guard remains safe to destroy later.
        const completion = this.allocateTemporaryCppName("finally_completion");
        this.emit({ kind: "declaration", type: "auto", name: completion, initializer: `bbl::js::finally([&]() { ${guard}.run(); })` });
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
        const parts: { gate?: string; frames: number; lines: string[]; sequence: number }[] = [{ frames: 1, lines: [], sequence }];
        for (const line of tail) {
            const trimmed = line.trim();
            if (trimmed === Compiler.frameYieldRequeueMarker) {
                sequence += 1;
                const previous = parts.at(-1)!;
                if (previous.lines.length === 0 && previous.gate === undefined) {
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
        const retainsLocals = persistContinuationLocals(parts, this.nativeDeclarations, this.continuationUses, this.continuationLocals, startDepth, storage);
        this.continuationStorageReached = retainsLocals;
        const captures = retainsLocals ? `[&, ${storage}]` : "[&]";
        let nested: string[] = [];
        // Bound indentation for continuations with many statement-bearing parts.
        const maxIndentedDepth = 8;
        for (let part = parts.length - 1; part >= 0; part -= 1) {
            const step = parts.length - part <= maxIndentedDepth ? "    " : "";
            const { gate, frames } = parts[part]!;
            const resolved = gate !== undefined
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
        if (retainsLocals) nested.unshift(`${indent}auto ${storage} = std::make_shared<bbl::ContinuationStorage>();`);
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
        return { lexical: this.variableScopes.at(-1)!, emission: this.activeEmissionScope,
            block: this.emissionBlocks.at(-1)!, continuation: this.engineStartMark?.index ?? -1 };
    }

    private renderCpp(features: Feature[]): string {
        if (this.presentationHostCpp && !this.ui.presentationCanvasValue) {
            this.failAtFile("An engine-less animation manager needs a reached primary Canvas2D surface for native presentation.");
        }
        if (this.presentationHostCpp && this.defaultEngineCpp !== this.presentationHostCpp) {
            this.failAtFile("A primary Canvas2D presentation host cannot also acquire a source-created GPU engine.");
        }
        let physicsDebugConstructionBody: string[] | undefined;
        if (features.includes("physics:viewer")) {
            if (!this.engineStartMark || this.options.workers || this.presentationHostCpp || this.engineStartMark.indentLevel !== 2) {
                this.failAtFile("Physics debug geometry extraction requires one top-level startEngine after the admitted construction graph.");
            }
            physicsDebugConstructionBody = this.body.slice(0, this.engineStartMark.index);
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
            ...(this.options.workers ? { workers: {
                namespace: this.options.workers.namespace,
                declarations: this.options.workers.declarations(),
                ...(features.includes("platform:window") ? { windowOptions: `bbl::EngineOptions{${this.cppString(this.options.title)}, ${this.options.width}, ${this.options.height}}` } : {}),
            } } : {}),
            features,
            jsDataReached: this.jsDataReached,
            imageDecodeReached: this.imageDecodeReached,
            runtimeMeshProfiles: this.runtimeMeshProfileCount > 0,
            jsRandomReached: this.jsRandomReached,
            audioSessionReached: this.audioSessionReached,
            continuationStorageReached: this.continuationStorageReached,
            throwReached: this.throwReached,
            postProcessCompositeCount: this.postProcessComposites.length,
            screenSpaceTaskCount: this.screenSpaceTasks.length,
            renderDataPreamble: () => this.dataTypes.renderPreamble(!!this.options.workers),
            nativeFunctionPrototypes: this.nativeFunctionPrototypes,
            nativeFunctionDefinitions: this.nativeFunctionDefinitions,
            staticNativeDeclarations: this.staticNativeDeclarations,
            voxelFileStorageReached: this.voxelFileStorageReached,
            ...(physicsDebugConstructionBody ? { physicsDebugConstructionBody } : {}),
            body: this.presentationHostCpp
                ? [
                    `        auto ${this.presentationHostCpp} = bbl::create_engine(bbl::EngineOptions{${this.cppString(this.options.title)}, ${this.options.width}, ${this.options.height}});`,
                    ...this.body,
                    `        bbl::start_engine(${this.presentationHostCpp});`,
                ]
                : this.body,
        });
    }

    private renderCmake(
        features: Feature[],
        runtimeSources: string[],
        generatedSources: string[],
    ): string {
        return renderFeaturesCmake(features, runtimeSources, generatedSources);
    }

    public fail(node: ts.Node, message: string, reason: CompileError["reason"] = "unsupported"): never {
        const { file, line, character } = sourceLocation(node);
        throw new CompileError(
            file === this.sourceFile ? this.options.fileName : file.fileName,
            line,
            character,
            message,
            reason,
        );
    }

    public failAtFile(message: string): never {
        throw new CompileError(this.options.fileName, 1, 1, message);
    }
}
