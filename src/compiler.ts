import ts from "typescript";
import { sourceLocation } from "./source-location.js";
import {
    doubleLiteral,
    sanitizeCppIdentifier,
    stringLiteral,
} from "./cpp-literals.js";
import {
    compileAdaptations,
    type AdaptationContext,
} from "./compiler/adaptations.js";
import {
    emitPropertyAssignment,
    emitStructuralPropertyAssignment,
    isTrsVectorName,
    type AssignmentContext,
} from "./compiler/assignments.js";
import {
    registerAsset,
    registerUiImageAsset,
    probePixelsAsset,
    registerSpriteAtlasAsset,
    resolveBundledAsset,
    type AssetRegistryContext,
} from "./compiler/assets.js";
import {
    compileStaticFetch,
    compileStaticFetchMethod,
    staticFetchProperty,
} from "./compiler/static-fetch.js";
import {
    BrowserErasure,
    type BrowserErasureContext,
} from "./compiler/browser-erasure.js";
import { browserGeneratedString } from "./compiler/browser-generated-string.js";
import { bakeFetchedCanvasAtlas } from "./compiler/fetched-canvas-atlas.js";
import {
    compileEnvironmentOptions,
    compileDdsEnvironmentOptions,
    compileDdsEnvironmentBackgroundOptions,
    compileHdrEnvironmentOptions,
    type AssetOptionContext,
} from "./compiler/intrinsics/asset-options.js";
import {
    compilePostProcessCompositeOptions,
    compilePostProcessTaskOptions,
    type CompiledPostProcessComposite,
    type CompiledPostProcessTask,
} from "./compiler/intrinsics/post-process-options.js";
import {
    compileRenderTargetOptions,
    type CompiledRenderTargetOptions,
    compileRenderTaskOptions,
    compileGeometryTaskOptions,
    compileCopyTaskOptions,
    compileSceneDefaultRenderTask,
    compileEnginePixelRatioCap,
    compileEnginePrecisionPolicy,
    geometryEnumMember,
    type EngineOptionContext,
} from "./compiler/intrinsics/engine-options.js";
import {
    compilePbrMaterialOptions,
    compileMetallicReflectanceOptions,
    compileGridMaterialOptions,
    compileClearCoatOptions,
    compileAnisotropyOptions,
    type CompiledAnisotropyOptions,
    type CompiledClearCoatOptions,
    compileIridescenceOptions,
    type CompiledIridescenceOptions,
    compileSheenOptions,
    type CompiledSheenOptions,
    compileSubsurfaceOptions,
    type CompiledSubsurfaceOptions,
    type CompiledPbrMaterialOptions,
    type CompiledMetallicReflectanceOptions,
    type MaterialOptionContext,
} from "./compiler/intrinsics/material-options.js";
import {
    compileBoxOptions,
    compileGroundOptions,
    compileGroundFromHeightMapOptions,
    compilePlaneOptions,
    compileSphereOptions,
    compileTorusOptions,
    type MeshOptionContext,
} from "./compiler/intrinsics/mesh-options.js";
import {
    compileRegisteredConstant,
    compileRegisteredIntrinsic,
    type IntrinsicContext,
} from "./compiler/intrinsics/registry.js";
import {
    selectedStaticNumberValue,
    validateObjectProperties,
} from "./compiler/option-helpers.js";
import {
    compilePropertyAnimationClip,
    compilePropertyAnimationGroupOptions,
    type PropertyAnimationContext,
} from "./compiler/property-animation.js";
import {
    compileNodeMaterialOptions,
    type CompiledNodeMaterialCall,
    type NodeMaterialContext,
} from "./compiler/node-material.js";
import {
    lineMaterialPermutation,
    reachLineMaterialProgram,
    type LineMaterialPermutation,
    type ReachedLineMaterial,
} from "./compiler/line-material.js";
import { reachLinearDepthMaterialProgram } from "./compiler/linear-depth-material.js";
import type { LinearDepthMaterialOptions } from "./lowering/linear-depth-lowerer.js";
import {
    PinnedShaderText,
    type ShaderTextBinding,
    type ShaderTextContext,
} from "./lowering/pinned-shader-text.js";
import {
    shaderThinInstanceLanes,
    compileShaderMaterialOptions,
    compileShaderUniformComponents,
    reachedShaderProgram,
    resolveShaderTextureSlot,
    resolveShaderUniform,
    type ShaderMaterialContext,
} from "./compiler/shader-material.js";
import {
    DataLowerer,
    type DataLoweringContext,
    isNeverResized,
} from "./compiler/data-lowering.js";
import {
    DataTypeRegistry,
    doubleLiteral as dataDoubleLiteral,
    isHandleKind,
    passesByReference,
    type DataIterationElement,
    type DataType,
    type TypedArrayKind,
} from "./compiler/data-types.js";
import {
    ExpressionLowerer,
    PURE_NUMBER_FORMATTERS,
    type ExpressionContext,
} from "./compiler/expressions.js";
import {
    captureDataFunctionBody,
    NativeFunctionLowerer,
    type NativeFunctionContext,
} from "./compiler/native-functions.js";
import {
    isModuleInitializerStatement,
    planImportedModuleInitializers,
} from "./compiler/module-initializers.js";
import { compileSpriteAtlasRecord } from "./compiler/sprite-atlas-record.js";
import { readPngDimensionsSync } from "./compiler/asset-bytes-sync.js";
import {
    createCompilerProgram,
} from "./compiler/program.js";
import {
    readProperty,
    type PropertyContext,
} from "./compiler/properties.js";
import type {
    PromiseLoweringContext,
} from "./compiler/promises.js";
import {
    CompilerSymbols,
} from "./compiler/symbols.js";
import {
    StaticEvaluator,
} from "./compiler/static-evaluator.js";
import {
    type StatementLoweringContext,
    StatementLowerer,
} from "./compiler/statements.js";
import {
    HandleCollections,
    type HandleCollectionTarget,
} from "./compiler/handle-collections.js";
import {
    aliasedMutationScan,
    type AliasedMutationScan,
    callArgumentIsReadOnly,
    parameterIsReadOnly,
    recursiveStorageEscapes,
    writesThroughTrackedRoot,
    resolveFunctionDeclaration,
    rootIdentifier,
    tryResolveFunctionDeclaration,
    type SupportedFunction,
    type UserFunctionContext,
    UserFunctionLowerer,
} from "./compiler/user-functions.js";
import {
    mutatingArrayMethods,
    storingDataMethods,
} from "./compiler/data-methods.js";
import type {
    CompileAsset,
    CompileOptions,
    CompileResult,
    CompiledNodeMaterial,
    CompiledNodeParticles,
    CompiledShaderProgram,
    Feature,
    GeometryOutputTaskManifest,
    GeometryTextureTypeName,
    LightKind,
    PostProcessCompositeManifest,
    PostProcessTaskManifest,
    ResolvedCompileOptions,
    NativeHostUiElement,
    SceneMeshManifest,
    SceneMeshNamePredicate,
    ShadowCasterManifest,
    ShadowGeneratorManifest,
    ScenePbrClearCoatManifest,
    ScenePbrAnisotropyManifest,
    ScenePbrIridescenceManifest,
    ScenePbrLightmapManifest,
    ScenePbrMaterialManifest,
    ScenePbrMetallicReflectanceManifest,
    ScenePbrSheenManifest,
    ScenePbrSubsurfaceManifest,
    SplatFragmentManifest,
    SpriteCustomShaderManifest,
    EffectManifest,
    FrameCallbackSignature,
    Value,
    ValueKind,
    VariableBinding,
} from "./compiler/types.js";
import type { MaterialPluginManifest } from "./pinned-material-plugins.js";
export type {
    CompileAsset,
    CompileOptions,
    CompileResult,
    CompiledShaderProgram,
    GeometryOutputTaskManifest,
    GeometryTextureTypeName,
    PostProcessCompositeManifest,
    PostProcessTaskManifest,
    ShaderMaterialVariantName,
} from "./compiler/types.js";
import { isCompileTimeOnlyValue } from "./compiler/types.js";
import { runtimeOnlyIntrinsics } from "./compiler/intrinsics/registry.js";
import type { ClusteredContainerState } from "./compiler/types.js";
import { ClassLowerer } from "./compiler/classes.js";
import {
    shaderMaterialPrograms,
} from "./shader-material-programs.js";
import {
    assertDeterministicRandomUnreached,
    isDeterministicRandomRead,
} from "./compiler/deterministic-random.js";
import { nodeParticleManifest } from "./compiler/intrinsics/particle.js";
import { reachedGeneratedSources } from "./generated-sources.js";
import {
    featureOrder,
    featureSources,
    renderFeaturesCmake,
    renderMainCpp,
} from "./compiler/output-projection.js";
export { renderFeaturesCmake };
import { SceneMaterialRecorder } from "./compiler/scene-materials.js";

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

const CANVAS_SIZE_AXES = new Map<string, CanvasSizeProperty>([
    ["width", { axis: "width", client: false }],
    ["height", { axis: "height", client: false }],
    ["clientWidth", { axis: "width", client: true }],
    ["clientHeight", { axis: "height", client: true }],
]);

const KEY_EVENT_FIELDS = new Map<string, string>([
    ["repeat", "repeat"],
    ["shiftKey", "shift_key"],
    ["ctrlKey", "ctrl_key"],
    ["altKey", "alt_key"],
    ["metaKey", "meta_key"],
]);

export class CompileError extends Error {
    public readonly fileName: string;
    public readonly line: number;
    public readonly column: number;

    public constructor(fileName: string, line: number, column: number, message: string) {
        super(`${fileName}:${line}:${column}: ${message}`);
        this.name = "CompileError";
        this.fileName = fileName;
        this.line = line;
        this.column = column;
    }
}

export function compileSource(source: string, options: CompileOptions = {}): CompileResult {
    const fileName = options.fileName ?? "input.ts";
    const frontend = createCompilerProgram(source, fileName);
    const compiler = new Compiler(
        frontend.program,
        frontend.sourceFile,
        frontend.checker,
        {
        fileName,
        title: options.title ?? "Babylon Lite Native",
        width: options.width ?? 1280,
        height: options.height ?? 720,
        search: options.search ?? "",
        ...(options.nativeHostUi
            ? { nativeHostUi: options.nativeHostUi }
            : {}),
        },
    );
    const result = compiler.compile();
    result.manifest.inputs = frontend.localFiles;
    return result;
}

class Compiler
    implements
        IntrinsicContext,
        AdaptationContext,
        AssetOptionContext,
        AssetRegistryContext,
        AssignmentContext,
        BrowserErasureContext,
        DataLoweringContext,
        EngineOptionContext,
        ExpressionContext,
        MaterialOptionContext,
        MeshOptionContext,
        NativeFunctionContext,
        NodeMaterialContext,
        PromiseLoweringContext,
        PropertyAnimationContext,
        PropertyContext,
        ShaderMaterialContext,
        StatementLoweringContext,
        UserFunctionContext {
    public readonly symbols: CompilerSymbols;
    public readonly evaluator: StaticEvaluator;
    /** The handle-collection concept: every collection operation. */
    public readonly handleCollections: HandleCollections =
        new HandleCollections(this);
    private readonly statements = new StatementLowerer();
    public readonly userFunctions: UserFunctionLowerer;
    public readonly dataTypes: DataTypeRegistry;
    public readonly dataLowerer: DataLowerer;
    public readonly classLowerer: ClassLowerer;
    public readonly nativeFunctions: NativeFunctionLowerer;
    private readonly browserErasure: BrowserErasure;
    private readonly browserUtilitySources = new Map<
        ts.SourceFile,
        boolean
    >();
    private readonly sharedClosureSymbols = new WeakMap<
        ts.Node,
        ReadonlySet<ts.Symbol>
    >();
    private staticAssetUrlCandidateCache: readonly string[] | undefined;
    private readonly expressions: ExpressionLowerer;
    private readonly nativeFunctionPrototypes: string[] =
        [];
    private readonly nativeFunctionDefinitions: string[] =
        [];
    private readonly staticNativeDeclarations: string[] =
        [];
    private readonly returnFrames: Array<
        | {
              kind: "native";
              type: DataType | "void";
              contextualVoid?: boolean;
          }
        | { kind: "inline"; wrapped: boolean }
    > = [];
    public jsDataReached = false;
    /** Whether the entry body itself decodes an image (drawn-atlas records). */
    public imageDecodeReached = false;
    public jsRandomReached = false;
    public voxelFileStorageReached = false;
    /** Whether a scene threw one of its own preconditions. */
    public throwReached = false;
    private assetRootsReachableAnswer: boolean | undefined;
    private readonly staticConstants = new Map<
        ts.Symbol,
        ts.Expression
    >();
    private readonly sourceCppNames = new Set<string>();
    public readonly variableScopes: Array<
        Map<ts.Symbol, VariableBinding>
    > = [new Map()];
    private readonly cppNamePrefixes: string[] = [""];
    private readonly features = new Set<Feature>(["core"]);
    /** The clustered container this scene added, if it added one. */
    private clusteredContainer: ClusteredContainerState | undefined;
    private readonly featureSites = new Map<Feature, string>();
    public readonly assets = new Map<string, CompileAsset>();
    public readonly assetPayloads = new Map<string, string>();
    /** The source-keyed record for the most recent `loadGltf` call. */
    private lastGltfContainerAsset: CompileAsset | undefined;
    public readonly reachedShaderPrograms: CompiledShaderProgram[] = [];
    public readonly reachedNodeMaterials: CompiledNodeMaterial[] = [];
    public readonly reachedNodeParticles: CompiledNodeParticles = {
        sets: [],
        steps: [],
        billboards: [],
        registrations: [],
        textures: [],
        sprite2d: [],
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
    public readonly boundPixelsTextures = new Set<string>();
    /** The pinned tone-mapping export the scene selected, if any. */
    private selectedToneMapping: string | undefined;
    private readonly reachedEffects_: EffectManifest[] = [];
    private thisInstance: Value | undefined;
    private readonly classInstances = new Map<Value, ts.ClassDeclaration>();
    private readonly body: string[] = [];
    /**
     * Collision listeners are registered before every startup assignment has
     * necessarily run. Their native bodies are specialized only after the
     * entry walk is complete, while retaining registration-site scopes.
     */
    private readonly deferredPhysicsCallbacks: Array<{
        callback: ts.Identifier | ts.ArrowFunction | ts.FunctionExpression;
        cppName: string;
        eventName: string;
        node: ts.Node;
        scopes: ReadonlyArray<Map<ts.Symbol, VariableBinding>>;
    }> = [];
    public readonly erasedBrowserExpressions = new Set<number>();
    public readonly erasedBrowserInstrumentation = new Set<number>();
    public readonly unwrappedAwaitExpressions = new Set<number>();
    public readonly geometryOutputTasks: GeometryOutputTaskManifest[] = [];
    public readonly postProcessTasks: PostProcessTaskManifest[] = [];
    public readonly postProcessComposites: PostProcessCompositeManifest[] =
        [];
    private readonly sceneMaterials = new SceneMaterialRecorder();
    private readonly sceneMaterialGltfAssetsBefore: number[] = [];
    private readonly sceneMeshes: SceneMeshManifest[] = [];
    private readonly shadowGenerators: ShadowGeneratorManifest[] = [];
    private readonly shadowReceiverMeshes = new Set<number>();
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
    private readonly sceneMeshesById = new Map<string, string[]>();
    /** The id each mesh handle currently carries, so a rewrite is visible. */
    private readonly sceneMeshIdByHandle = new Map<string, string>();
    /** Every id an emitted light include set has already resolved against. */
    private readonly resolvedLightMeshIds = new Set<string>();
    /** `constArrayIsWritten` answers, by binding: the scan walks a file. */
    private readonly writtenConstArrays = new Map<ts.Symbol, boolean>();
    /** The active lights and kinds, kept in one receiver-binding order. */
    private readonly sceneLights: Array<{
        identity: NonNullable<Value["lightIdentity"]>;
        kind: LightKind;
    }> = [];
    private dynamicSceneLights = false;
    private mutableToneMappingEnabled = false;
    private readonly sceneSpriteCustomShaders: SpriteCustomShaderManifest[] =
        [];
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
    private readonly sceneMeshMaterials = new Map<
        number,
        { pbrMaterial: number | null; nodeMaterial: number | null }
    >();
    /** Every reachable assignment, rather than only the final assignment the
     *  lazy shadow view needs. This closes each PBR material over the meshes
     *  it can actually draw on. */
    private readonly scenePbrMaterialMeshes = new Map<number, Set<number>>();
    private readonly scenePbrMaterialsWithUnknownMesh = new Set<number>();
    private reachedPlainSpriteLayer = false;
    /** A standalone SpriteRenderer needs the pure-2D vertex permutation. */
    private reachedPureSpriteVertex = false;
    private reachedPlainBillboardSystem = false;
    public hasMainEntry = false;
    private defaultEngineCpp: string | undefined;
    /** First statement after the one engine is created. */
    private engineCreationInsertion: number | undefined;
    private nativeHostUiIdsCache: ReadonlySet<string> | undefined;
    /** Explicit static surface sample count; absence means the pinned default. */
    private engineMsaaSamples: 1 | 4 | undefined;
    /** Bound only while lowering a platform visibility callback body. */
    private platformDocumentHiddenCpp: string | undefined;
    private indentLevel = 2;
    private temporaryIndex = 0;
    public defaultRenderTaskAdapted = false;

    public constructor(
        private readonly program: ts.Program,
        public readonly sourceFile: ts.SourceFile,
        public readonly checker: ts.TypeChecker,
        public readonly options: ResolvedCompileOptions,
    ) {
        this.symbols = new CompilerSymbols(checker);
        this.userFunctions =
            new UserFunctionLowerer(checker);
        this.dataTypes = new DataTypeRegistry(
            checker,
            (node, message) => this.fail(node, message),
            () => this.assetRootsReachable(),
        );
        this.dataLowerer = new DataLowerer(this);
        this.classLowerer = new ClassLowerer(this);
        this.nativeFunctions =
            new NativeFunctionLowerer(this);
        this.browserErasure = new BrowserErasure(this);
        this.expressions = new ExpressionLowerer(this);
        this.evaluator = new StaticEvaluator(
            this.staticConstants,
            this.checker,
            (identifier) =>
                this.symbols.valueSymbol(identifier),
            (expression) =>
                this.canvasSizeValue(expression) ??
                this.enumMemberValue(expression) ??
                this.lookupRecordProperty(expression) ??
                this.dataLowerer.compileDataPath(
                    expression,
                    "read",
                ) ??
                this.compilePropertyAccess(expression),
            (expression) => this.compileValue(expression),
            (expression) => this.compileValue(expression),
            (expression) => this.compileValue(expression),
            (expression) =>
                this.compileCondition(expression),
            (expression) =>
                this.evaluateBrowserValue(expression),
            (expression) =>
                this.isBrowserOnlyExpression(expression),
            (value, expression) =>
                this.dataLowerer.narrowOptional(value, expression),
            (identifier) => this.lookup(identifier),
            (identifier) => this.lookupOptional(identifier),
            (node, message) => this.fail(node, message),
            (expression) =>
                this.unwrappedAwaitExpressions.add(
                    expression.pos,
                ),
            () => this.reachJsData(),
            (value, arity) => this.bindDataTuple(value, arity),
        );
    }

    public compile(): CompileResult {
        this.collectSourceCppNames();
        this.collectStaticConstants();
        this.predeclareStoredObjectReferences();
        this.emitImportedModuleInitializers();
        for (const statement of this.entryStatements()) {
            this.emitStatement(statement);
        }
        this.emitDeferredPhysicsCallbacks();
        this.emitNativeHostUi();
        assertDeterministicRandomUnreached(
            this,
            this.jsRandomReached,
            this.sourceFile,
        );
        // After the whole entry, because the mesh a shader material ends up
        // on is what decides its instanced form and either may come first.
        this.settleShaderThinInstances();

        // After every feature has settled: retained UI must land on a frame
        // loop that presents it (NA-26).
        this.refuseUiWithoutPresentation();

        const features = featureOrder.filter((feature) => this.features.has(feature));
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
            ...new Set(
                features.flatMap(
                    (feature) => featureSources[feature],
                ),
            ),
        ];
        // The manifest and CMake projection of the same table the upstream
        // lowerer emits from, so a feature's sources are declared once.
        const generatedSources =
            reachedGeneratedSources(features);
        return {
            cpp: this.renderCpp(features),
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
                customShaderPrograms:
                    this.reachedShaderPrograms.filter(
                        ({ name }) =>
                            !shaderMaterialPrograms.some(
                                (predeclared) =>
                                    predeclared.name === name,
                            ),
                    ),
                nodeMaterials: this.reachedNodeMaterials,
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
                adaptations: compileAdaptations(this, features),
                scenePbrMaterials: this.scenePbrMaterials.map(
                    (material, index) => ({
                        ...material,
                        sceneMeshIndices: [
                            ...(this.scenePbrMaterialMeshes.get(index) ?? []),
                        ].sort((left, right) => left - right),
                        ...(this.scenePbrMaterialsWithUnknownMesh.has(index)
                            ? { unknownSceneMesh: true as const }
                            : {}),
                    }),
                ),
                standardMaterialPlugins:
                    this.sceneMaterials.standardMaterialPlugins,
                sceneMaterialCount: this.sceneMaterials.count,
                sceneMaterialGltfAssetsBefore:
                    this.sceneMaterialGltfAssetsBefore,
                sceneMeshes: this.sceneMeshes,
                sceneLightKinds: this.sceneLights.map(({ kind }) => kind),
                dynamicSceneLights: this.dynamicSceneLights,
                mutableToneMappingEnabled: this.mutableToneMappingEnabled,
                ...(this.clusteredContainer
                    ? {
                          clusteredLights: {
                              hasSpots:
                                  this.clusteredContainer.hasSpots,
                          },
                      }
                    : {}),
                shadowGenerators: this.shadowGenerators.map((generator) => {
                    if (generator.lightIndex < 0) {
                        throw new Error(
                            "A shadow generator's light was never added to the scene.",
                        );
                    }
                    return {
                        ...generator,
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
                }),
                shadowReceiverMeshes: [
                    ...this.shadowReceiverMeshes,
                ].sort((left, right) => left - right),
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
    private emitNativeHostUi(): void {
        const hostUi = this.options.nativeHostUi;
        if (!hostUi) return;
        const engine = this.defaultEngineCpp;
        if (!engine) {
            this.failAtFile(
                "A native host UI companion requires a scene engine.",
            );
        }
        this.features.add("ui:rml");
        // The reaching "site" is the audited companion file itself: a
        // companion-only scene has no call in its own source to name, and
        // leaving the site empty would attribute the activation to the
        // compiled scene TypeScript. A scene-source reach recorded during
        // the walk still wins, matching `reachFeature`'s first-reach rule.
        if (!this.featureSites.has("ui:rml")) {
            this.featureSites.set(
                "ui:rml",
                `${hostUi.sourcePath} (host UI companion)`,
            );
        }
        const indent = "    ".repeat(2);
        const emitted: string[] = [];
        const ids = new Set<string>();
        for (const rule of hostUi.classStyles ?? []) {
            if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(rule.className)) {
                this.failAtFile(
                    `Native host UI class '${rule.className}' is not valid.`,
                );
            }
            emitted.push(
                `${indent}bbl::ui_add_class_style(${engine}, ` +
                    `${this.cppString(rule.className)}, ` +
                    `${this.cppString(this.lowerUiAttributeLiteral("style", rule.style))});`,
            );
        }

        const appendElement = (
            element: NativeHostUiElement,
            parent?: string,
        ): string => {
            if (!/^[a-z][a-z0-9-]*$/i.test(element.tag)) {
                this.failAtFile(
                    `Native host UI element tag '${element.tag}' is not valid.`,
                );
            }
            const handle = this.allocateTemporaryCppName(
                "host_ui_element",
            );
            emitted.push(
                `${indent}const auto ${handle} = ` +
                    `bbl::ui_create_element(${engine}, ${this.cppString(element.tag)});`,
            );
            if (element.text !== undefined) {
                emitted.push(
                    `${indent}bbl::ui_set_text(${engine}, ${handle}, ` +
                        `${this.cppString(element.text)});`,
                );
            }
            for (const [name, sourceValue] of Object.entries(
                element.attributes ?? {},
            )) {
                if (name === "id") {
                    if (ids.has(sourceValue)) {
                        this.failAtFile(
                            `Native host UI element id '${sourceValue}' is duplicated.`,
                        );
                    }
                    ids.add(sourceValue);
                }
                const value = this.lowerUiAttributeLiteral(
                    name,
                    sourceValue,
                );
                emitted.push(
                    `${indent}bbl::ui_set_attribute(${engine}, ${handle}, ` +
                        `${this.cppString(name)}, ${this.cppString(value)});`,
                );
            }
            for (const child of element.children ?? []) {
                appendElement(child, handle);
            }
            emitted.push(
                parent
                    ? `${indent}bbl::ui_append_child(${engine}, ${parent}, ${handle});`
                    : `${indent}bbl::ui_append_to_root(${engine}, ${handle});`,
            );
            return handle;
        };
        for (const element of hostUi.elements) {
            appendElement(element);
        }
        const insertion = this.engineCreationInsertion ?? this.body.length;
        this.body.splice(insertion, 0, ...emitted);
    }

    private nativeHostUiIds(): ReadonlySet<string> {
        if (this.nativeHostUiIdsCache) return this.nativeHostUiIdsCache;
        const ids = new Set<string>();
        const visit = (element: NativeHostUiElement): void => {
            const id = element.attributes?.id;
            if (id !== undefined) ids.add(id);
            for (const child of element.children ?? []) visit(child);
        };
        for (const element of this.options.nativeHostUi?.elements ?? []) {
            visit(element);
        }
        this.nativeHostUiIdsCache = ids;
        return ids;
    }

    /**
     * A host lookup becomes native only when its literal id is present in the
     * audited companion. This deliberately excludes renderCanvas and any
     * arbitrary page traversal from the retained UI surface.
     */
    public isNativeHostUiLookup(call: ts.CallExpression): boolean {
        const callee = this.unwrap(call.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            callee.name.text !== "getElementById" ||
            !ts.isIdentifier(callee.expression) ||
            callee.expression.text !== "document" ||
            !this.isDefaultLibraryIdentifier(callee.expression) ||
            call.arguments.length !== 1
        ) {
            return false;
        }
        const id = this.unwrap(call.arguments[0]!);
        return (
            (ts.isStringLiteral(id) ||
                ts.isNoSubstitutionTemplateLiteral(id)) &&
            this.nativeHostUiIds().has(id.text)
        );
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
        const visit = (node: ts.Node): void => {
            if (
                (ts.isInterfaceDeclaration(node) ||
                    ts.isTypeAliasDeclaration(node)) &&
                node.name
            ) {
                this.dataTypes.fromTsType(
                    this.checker.getTypeAtLocation(node.name),
                    node,
                );
            } else if (
                ts.isVariableDeclaration(node) &&
                node.type
            ) {
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
                    this.dataTypes.markStoredObjectReferences(
                        dataType,
                    );
                }
            } else if (ts.isPropertyDeclaration(node)) {
                const dataType = this.dataTypes.fromTsType(
                    this.checker.getTypeAtLocation(node),
                    node,
                );
                if (dataType) {
                    this.dataTypes.markStoredObjectReferences(
                        dataType,
                    );
                }
            } else if (
                ts.isParameter(node) &&
                node.parent &&
                ts.isParameterPropertyDeclaration(
                    node,
                    node.parent,
                )
            ) {
                const dataType = this.dataTypes.fromTsType(
                    this.checker.getTypeAtLocation(node),
                    node,
                );
                if (dataType) {
                    this.dataTypes.markStoredObjectReferences(
                        dataType,
                    );
                }
            }
            ts.forEachChild(node, visit);
        };
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
                for (const declaration of statement
                    .declarationList.declarations) {
                    if (
                        ts.isIdentifier(declaration.name) &&
                        declaration.initializer
                    ) {
                        const symbol =
                            this.symbols.valueSymbol(
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
        const visit = (node: ts.Node): void => {
            if (
                (ts.isVariableDeclaration(node) ||
                    ts.isParameter(node)) &&
                ts.isIdentifier(node.name)
            ) {
                this.sourceCppNames.add(
                    this.cppIdentifier(node.name.text),
                );
            }
            ts.forEachChild(node, visit);
        };
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
                    const symbol = this.symbols.valueSymbol(
                        declaration.name,
                    );
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

    private entryStatements(): readonly ts.Statement[] {
        const main = this.sourceFile.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) && statement.name?.text === "main" && statement.body !== undefined,
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
            this.failAtFile("Expected top-level scene statements or a function named main with a body.");
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
        const settled = (side: ts.Expression): string | undefined => {
            if (
                (this.checker.getNonNullableType(
                    this.checker.getTypeAtLocation(side),
                ).flags &
                    ts.TypeFlags.BooleanLike) ===
                0
            ) {
                return undefined;
            }
            const resolved = this.evaluator.resolveStaticExpression(side);
            if (resolved.kind === ts.SyntaxKind.TrueKeyword) return "true";
            if (resolved.kind === ts.SyntaxKind.FalseKeyword) return "false";
            const value = ts.isIdentifier(resolved)
                ? this.lookupOptional(resolved)
                : ts.isPropertyAccessExpression(resolved)
                  ? this.compilePropertyAccess(resolved)
                  : undefined;
            return value?.kind === "boolean" &&
                (value.cpp === "true" || value.cpp === "false")
                ? value.cpp
                : undefined;
        };
        const left = settled(expression.left);
        const right = settled(expression.right);
        if (left === undefined || right === undefined) {
            return undefined;
        }
        return String((left === right) === equals);
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
        const handler = this.unwrap(call.arguments[0]!);
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
        this.statements.emit(this, statement);
    }

    public statementTerminatesAfterLowering(
        statement: ts.Statement,
    ): boolean {
        return this.statements.terminatesAfterLowering(
            statement,
        );
    }

    private nullableResourceKind(
        node: ts.Node,
    ):
        | { kind: ValueKind; cppType: string }
        | undefined {
        const type = this.checker.getTypeAtLocation(node);
        if ((type.flags & ts.TypeFlags.Union) === 0) {
            return undefined;
        }
        const members = (type as ts.UnionType).types.filter(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.Null |
                        ts.TypeFlags.Undefined)) ===
                0,
        );
        if (members.length !== 1) return undefined;
        const name = members[0]!.symbol?.name;
        if (name === "AudioEngine") {
            return {
                kind: "audio-engine",
                cppType: "bbl::pal::AudioContextHandle",
            };
        }
        if (
            name === "AudioContext" ||
            name === "BaseAudioContext" ||
            name === "OfflineAudioContext"
        ) {
            return {
                kind: "audio-context",
                cppType: "bbl::pal::AudioContextHandle",
            };
        }
        if (name === "AudioParam") {
            return {
                kind: "audio-param",
                cppType: "bbl::pal::AudioParamHandle",
            };
        }
        if (name === "AudioBuffer") {
            return {
                kind: "audio-buffer",
                cppType: "bbl::pal::AudioBufferHandle",
            };
        }
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
        if (name === "SpriteRenderer") {
            return {
                kind: "sprite-renderer",
                cppType: "bbl::SpriteRendererHandle",
            };
        }
        if (name === "Sprite2DLayer") {
            return {
                kind: "sprite-layer",
                cppType: "bbl::Sprite2DLayerHandle",
            };
        }
        if (
            name === "Element" ||
            name === "HTMLElement" ||
            name === "HTMLDivElement" ||
            name === "HTMLCanvasElement"
        ) {
            return {
                kind: "ui-element",
                cppType: "bbl::UiElementHandle",
            };
        }
        if (name === "ObstacleHandle") {
            return {
                kind: "navigation-obstacle",
                cppType: "bbl::pal::NavObstacleHandle",
            };
        }
        if (name === "Mesh") {
            return {
                kind: "mesh",
                cppType: "bbl::MeshHandle",
            };
        }
        if (name?.endsWith("Node")) {
            return {
                kind: "audio-node",
                cppType: "bbl::pal::AudioNodeHandle",
            };
        }
        return undefined;
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
        const visit = (candidate: ts.Node): void => {
            if (found) return;
            if (
                ts.isBinaryExpression(candidate) &&
                candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(this.unwrap(candidate.left)) &&
                this.symbols.valueSymbol(
                    this.unwrap(candidate.left) as ts.Identifier,
                ) === symbol
            ) {
                const right = this.unwrap(candidate.right);
                if (
                    ts.isCallExpression(right) &&
                    ts.isIdentifier(this.unwrap(right.expression)) &&
                    this.symbols.importedName(
                        this.unwrap(right.expression) as ts.Identifier,
                    ) === intrinsic
                ) {
                    found = true;
                    return;
                }
            }
            ts.forEachChild(candidate, visit);
        };
        visit(node.getSourceFile());
        return found;
    }

    public emitExpressionAsStatement(
        expression: ts.Expression,
    ): void {
        this.statements.emitExpression(this, expression);
    }

    /**
     * JavaScript record methods capture mutable bindings, not snapshots of
     * their current values. A `let` read by a function-valued object member
     * therefore needs a shared native cell: separately inlined methods and
     * stored callbacks all dereference the same storage.
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
        const symbol = this.symbols.valueSymbol(declaration.name);
        if (!symbol) return false;
        let owner: ts.Node = declaration;
        while (owner.parent && !ts.isFunctionLike(owner.parent)) {
            owner = owner.parent;
        }
        if (owner.parent) owner = owner.parent;
        let captured = this.sharedClosureSymbols.get(owner);
        if (!captured) {
            captured = this.collectSharedClosureSymbols(owner);
            this.sharedClosureSymbols.set(owner, captured);
        }
        return captured.has(symbol);
    }

    private collectSharedClosureSymbols(
        owner: ts.Node,
    ): ReadonlySet<ts.Symbol> {
        const captured = new Set<ts.Symbol>();
        const storedLocalFunctions = new Set<ts.Symbol>();
        const storedLocalFunctionNames = new Set<string>();
        const collectStoredFunctions = (node: ts.Node): void => {
            if (ts.isShorthandPropertyAssignment(node)) {
                storedLocalFunctionNames.add(node.name.text);
                const symbol = this.symbols.valueSymbol(node.name);
                if (symbol) storedLocalFunctions.add(symbol);
            } else if (
                ts.isPropertyAssignment(node) &&
                ts.isIdentifier(this.unwrap(node.initializer))
            ) {
                storedLocalFunctionNames.add(
                    (this.unwrap(node.initializer) as ts.Identifier).text,
                );
                const symbol = this.symbols.valueSymbol(
                    this.unwrap(node.initializer) as ts.Identifier,
                );
                if (symbol) storedLocalFunctions.add(symbol);
            }
            ts.forEachChild(node, collectStoredFunctions);
        };
        collectStoredFunctions(owner);

        const visit = (
            node: ts.Node,
            insideStoredRecordCallback: boolean,
        ): void => {
            // Local functions returned through a record are compiled into
            // independent native callbacks just like inline object-literal
            // methods. JavaScript still closes every one of them over the
            // same binding. Limit this to functions actually stored in such
            // a record: ordinary recurring frame callbacks keep the existing
            // static-lifetime lowering they require.
            let storedLocalCallback = false;
            if (
                ts.isFunctionDeclaration(node) &&
                node.name
            ) {
                const symbol = this.symbols.valueSymbol(node.name);
                storedLocalCallback =
                    storedLocalFunctionNames.has(node.name.text) ||
                    (!!symbol && storedLocalFunctions.has(symbol));
            } else if (
                (ts.isArrowFunction(node) ||
                    ts.isFunctionExpression(node)) &&
                ts.isVariableDeclaration(node.parent) &&
                ts.isIdentifier(node.parent.name)
            ) {
                const symbol = this.symbols.valueSymbol(node.parent.name);
                storedLocalCallback =
                    storedLocalFunctionNames.has(node.parent.name.text) ||
                    (!!symbol && storedLocalFunctions.has(symbol));
            }
            const storedRecordCallback =
                (ts.isMethodDeclaration(node) &&
                    ts.isObjectLiteralExpression(node.parent)) ||
                ((ts.isArrowFunction(node) ||
                    ts.isFunctionExpression(node)) &&
                    ts.isPropertyAssignment(node.parent) &&
                    ts.isObjectLiteralExpression(node.parent.parent));
            const inside =
                insideStoredRecordCallback ||
                storedRecordCallback ||
                storedLocalCallback;
            if (
                inside &&
                ts.isIdentifier(node)
            ) {
                const symbol = this.symbols.valueSymbol(node);
                if (symbol) captured.add(symbol);
            }
            ts.forEachChild(node, (child) =>
                visit(child, inside));
        };
        visit(owner, false);
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
        if (ts.isObjectBindingPattern(declaration.name)) {
            this.emitObjectBindingDeclaration(declaration);
            return;
        }
        if (ts.isArrayBindingPattern(declaration.name)) {
            this.emitArrayBindingDeclaration(declaration);
            return;
        }
        if (!ts.isIdentifier(declaration.name)) {
            this.fail(declaration.name, "Only identifier variable declarations are supported.");
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
        const declarationSymbol = this.symbols.valueSymbol(
            declaration.name,
        );
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
            const dataType = this.dataTypes.fromTsType(
                this.checker.getTypeAtLocation(declaration.name),
                declaration.name,
            );
            if (!dataType) {
                this.fail(
                    declaration,
                    `Variable '${sourceName}' needs a native data type before it can be assigned.`,
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
                sharedClosureStorage &&
                    this.isSharedClosureScalar(dataType.kind)
                    ? `auto ${cppName} = std::make_shared<${cppType}>();`
                    : `${cppType} ${cppName};`,
            );
            if (
                dataType.kind !== "number" &&
                dataType.kind !== "boolean"
            ) {
                this.dataLowerer.registerLocal(
                    cppName,
                    "owned",
                );
            }
            this.defineVariable(
                declaration.name,
                this.dataLowerer.leafValue(
                    sharedClosureStorage &&
                        this.isSharedClosureScalar(dataType.kind)
                        ? `(*${cppName})`
                        : cppName,
                    dataType,
                ),
            );
            return;
        }

        if (
            declaration.parent !== undefined &&
            ts.isVariableDeclarationList(
                declaration.parent,
            ) &&
            (declaration.parent.flags &
                ts.NodeFlags.Const) ===
                0
        ) {
            const symbol = this.symbols.valueSymbol(
                declaration.name,
            );
            if (symbol) {
                this.staticConstants.delete(symbol);
            }
        }
        if (
            declaration.type &&
            (ts.isArrowFunction(declaration.initializer) ||
                ts.isFunctionExpression(
                    declaration.initializer,
                )) &&
            this.emitAnnotatedDataDeclaration(
                declaration,
                cppName,
            )
        ) {
            return;
        }
        if (
            ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(
                declaration.initializer,
            )
        ) {
            this.emitRecursiveCallbackDeclaration(
                declaration.name,
                declaration.initializer,
                cppName,
            );
            return;
        }

        // `const original = Math.random`, which the corpus writes only to
        // put the generator back after a seeded window. It names the
        // function itself rather than a value, so it emits nothing and the
        // binding exists for the restore assignment to recognize.
        if (
            isDeterministicRandomRead(declaration.initializer)
        ) {
            this.defineVariable(declaration.name, {
                kind: "js-random",
                cpp: "",
            });
            return;
        }

        const nullableResource =
            this.nullableResourceKind(declaration.name);
        if (
            declaration.initializer.kind ===
                ts.SyntaxKind.NullKeyword &&
            nullableResource
        ) {
            this.emit(sharedClosureStorage
                ? `auto ${cppName} = std::make_shared<std::optional<${nullableResource.cppType}>>();`
                : `std::optional<${nullableResource.cppType}> ${cppName};`);
            this.defineVariable(declaration.name, {
                kind: nullableResource.kind,
                cpp: sharedClosureStorage
                    ? `(**${cppName})`
                    : `(*${cppName})`,
                ...(nullableResource.kind === "ui-element" &&
                this.defaultEngineCpp
                    ? { engineCpp: this.defaultEngineCpp }
                    : {}),
                optionalFoundCpp: sharedClosureStorage
                    ? `${cppName}->has_value()`
                    : `${cppName}.has_value()`,
                optionalStorageCpp: sharedClosureStorage
                    ? `(*${cppName})`
                    : cppName,
            });
            return;
        }

        if (
            this.isBrowserOnlyExpression(declaration.initializer) &&
            this.moduleRelativeAssetUrl(declaration.initializer) === undefined
        ) {
            const browserValue =
                this.evaluateBrowserValue(
                    declaration.initializer,
                );
            this.defineVariable(declaration.name, {
                kind: "browser",
                cpp: "",
                ...(browserValue
                    ? { browserValue }
                    : {}),
            });
            return;
        }

        const engineCall = this.importedCall(
            declaration.initializer,
            "createEngine",
        );
        if (engineCall) {
            const engine = this.compileEngineCreation(
                engineCall,
                cppName,
            );
            this.defineVariable(declaration.name, engine);
            return;
        }

        if (
            this.emitAnnotatedDataDeclaration(
                declaration,
                cppName,
            )
        ) {
            return;
        }

        const forwardCallback =
            this.prepareForwardFunctionResult(
                declaration,
                cppName,
            );
        const value = this.compileValue(declaration.initializer);
        if (forwardCallback) {
            this.completeForwardFunctionResult(
                declaration,
                cppName,
                forwardCallback,
                value,
            );
            return;
        }
        if (
            nullableResource &&
            value.kind === nullableResource.kind
        ) {
            // Copy nullable resource STORAGE, not its present-value spelling.
            // A bound nullable resource exposes `(*storage)` for code that a
            // source guard has narrowed, but `const current = context` must
            // preserve an empty `context` as an empty `current`. Dereferencing
            // here engaged the copy with an indeterminate handle before the
            // copied source guard could run.
            const initializerCpp =
                value.optionalStorageCpp ?? value.cpp;
            this.emit(sharedClosureStorage
                ? `auto ${cppName} = std::make_shared<std::optional<${nullableResource.cppType}>>(${initializerCpp});`
                : `std::optional<${nullableResource.cppType}> ${cppName} = ${initializerCpp};`);
            this.defineVariable(declaration.name, {
                ...value,
                cpp: sharedClosureStorage
                    ? `(**${cppName})`
                    : `(*${cppName})`,
                optionalFoundCpp: sharedClosureStorage
                    ? `${cppName}->has_value()`
                    : `${cppName}.has_value()`,
                optionalStorageCpp: sharedClosureStorage
                    ? `(*${cppName})`
                    : cppName,
            });
            return;
        }
        if (
            value.impure ||
            this.expressionHasObservableEvaluation(
                declaration.initializer,
            )
        ) {
            // A `const` bound to a clock is a snapshot of it, so later
            // uses must read the native local rather than fold back to
            // the initializer and call the clock again. Same removal a
            // `let` declaration takes above, for the same reason: the
            // initializer stops being the value.
            const symbol = this.symbols.valueSymbol(
                declaration.name as ts.Identifier,
            );
            if (symbol) {
                this.staticConstants.delete(symbol);
            }
        }
        if (value.kind === "node-particle-2d-binding") {
            // Nothing native to bind: the registrar already ran, and the
            // binding exists so instrumentation can report it.
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
        if (value.kind === "void") {
            this.fail(declaration.initializer, `Expression assigned to '${sourceName}' does not produce a native value.`);
        }
        if (value.kind === "callback" || isCompileTimeOnlyValue(value.kind)) {
            this.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "data") {
            const symbol = this.symbols.valueSymbol(
                declaration.name,
            );
            if (symbol) this.staticConstants.delete(symbol);
            const narrowed =
                this.dataLowerer.narrowForDeclaration(
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
                this.emit(
                    `auto* ${cppName} = ${narrowed.objectIdentityCpp};`,
                );
                this.dataLowerer.registerAlias(
                    cppName,
                    narrowed.objectIdentityCpp,
                );
                this.defineVariable(declaration.name, {
                    ...narrowed,
                    kind: "data",
                    cpp: cppName,
                    optionalFoundCpp: `${cppName} != nullptr`,
                    objectIdentityCpp: cppName,
                });
                return;
            }
            const initializer = this.unwrap(
                declaration.initializer,
            );
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
                ts.isVariableDeclarationList(
                    declaration.parent,
                ) &&
                (declaration.parent.flags &
                    ts.NodeFlags.Const) !==
                    0 &&
                passesByReference(
                    this.dataTypes,
                    narrowed.dataType,
                ) &&
                !narrowed.freshData &&
                (ts.isIdentifier(initializer) ||
                    ts.isElementAccessExpression(initializer) ||
                    ts.isPropertyAccessExpression(
                        initializer,
                    )) &&
                // A value read out of a span is const, so it cannot be
                // bound by reference; the source language would not let
                // it be written through either.
                !narrowed.readOnly;
            const wrapperCopiesIdentity =
                narrowed.dataType.kind === "vector" ||
                narrowed.dataType.kind === "map" ||
                narrowed.dataType.kind === "set" ||
                narrowed.dataType.kind === "arraybuffer" ||
                narrowed.dataType.kind === "dataview" ||
                narrowed.dataType.kind === "u8array";
            const optionalFoundCpp =
                narrowed.optionalFoundCpp === undefined
                    ? undefined
                    : this.allocateTemporaryCppName(
                          "element_found",
                      );
            const referenceStruct =
                narrowed.dataType.kind === "struct" &&
                this.dataTypes.isReferenceStruct(
                    narrowed.dataType.name,
                );
            if (optionalFoundCpp && !referenceStruct) {
                // A JavaScript local captures whether the element existed
                // when its initializer ran. Keep that snapshot separate
                // from the safe default object used to avoid an invalid
                // native read on the missing path.
                this.emit(
                    `[[maybe_unused]] const bool ${optionalFoundCpp} = ${narrowed.optionalFoundCpp};`,
                );
            }
            const localType = narrowed.nativeVectorData
                ? "auto"
                : this.dataTypes.cppType(narrowed.dataType);
            this.emit(
                `${localType}${(aliases && !wrapperCopiesIdentity) || narrowed.borrowedData ? "&" : ""} ${cppName} = ${narrowed.cpp};`,
            );
            if (optionalFoundCpp && referenceStruct) {
                // Reference-backed records already use an empty shared
                // pointer as their safe missing value. Test the stored local
                // instead of repeating a conditional initializer (and all
                // branch preparation it may contain) just to learn whether
                // the result exists.
                this.emit(
                    `[[maybe_unused]] const bool ${optionalFoundCpp} = static_cast<bool>(${cppName});`,
                );
            }
            if (aliases) {
                this.dataLowerer.registerAlias(
                    cppName,
                    narrowed.cpp,
                );
            } else {
                this.dataLowerer.registerLocal(
                    cppName,
                    constructs || referenceStruct || narrowed.freshData
                        ? "owned"
                        : "copy",
                );
            }
            const staticElementsOwner = aliases && narrowed.staticElements
                ? (narrowed.staticElementsOwner ?? narrowed)
                : undefined;
            this.defineVariable(declaration.name, {
                kind: "data",
                cpp: cppName,
                dataType: narrowed.dataType,
                ...(staticElementsOwner
                    ? {
                          staticElements:
                              staticElementsOwner.staticElements ??
                              narrowed.staticElements,
                          staticElementsOwner,
                      }
                    : {}),
                ...(narrowed.recordProperties
                    ? {
                          recordProperties:
                              narrowed.recordProperties,
                      }
                    : {}),
                ...(narrowed.borrowedData ? { borrowedData: true as const } : {}),
                ...(narrowed.nativeVectorData
                    ? { nativeVectorData: true as const }
                    : {}),
                ...(optionalFoundCpp
                    ? { optionalFoundCpp }
                    : {}),
            });
            return;
        }

        const nativeType =
            value.kind === "number"
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
        const maybeUnused =
            value.kind === "boolean" ? "[[maybe_unused]] " : "";
        const sharedPrimitive =
            sharedClosureStorage &&
            this.isSharedClosureScalar(
                value.dataType?.kind === "enum"
                    ? "enum"
                    : value.kind,
            );
        this.emit(sharedPrimitive
            ? `auto ${cppName} = std::make_shared<${nativeType}>(${initializerCpp});`
            : `${maybeUnused}${nativeType} ${cppName} = ${initializerCpp};`);
        // Either spelling reads through the emitted variable, so a static
        // value the initializer carried must not fold past it.
        const stored: Value = {
            ...value,
            cpp: sharedPrimitive ? `(*${cppName})` : cppName,
            nativeBinding: true,
        };
        if (value.kind === "animation-clip") {
            stored.animationFrameRate = `${cppName}.frame_rate`;
            stored.animationDuration = `${cppName}.duration`;
        }
        if (
            declaration.parent !== undefined &&
            ts.isVariableDeclarationList(
                declaration.parent,
            ) &&
            (declaration.parent.flags &
                ts.NodeFlags.Const) ===
                0
        ) {
            // Mutable locals must never fold to their initial value:
            // later reads reference the native local, not the constant
            // the declaration happened to start from.
            delete stored.staticNumber;
            delete stored.staticString;
        }
        this.defineVariable(declaration.name, stored);
        if (value.kind === "engine") {
            if (this.defaultEngineCpp) {
                this.fail(declaration, "The prototype currently supports one engine per entry point.");
            }
            this.defaultEngineCpp = cppName;
        }
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
          }
        | undefined {
        if (!declaration.initializer) return undefined;
        const initializer = this.unwrap(declaration.initializer);
        if (!ts.isCallExpression(initializer)) return undefined;
        const signatures = this.checker
            .getTypeAtLocation(declaration.name)
            .getCallSignatures();
        if (signatures.length !== 1) return undefined;
        const signature = signatures[0]!;
        const returnType = this.checker.getReturnTypeOfSignature(signature);
        if ((returnType.flags & ts.TypeFlags.Void) === 0) return undefined;
        const parameterTypes: DataType[] = [];
        const parameterNames: string[] = [];
        for (const [index, parameter] of signature
            .getParameters()
            .entries()) {
            const site = parameter.valueDeclaration ?? declaration.name;
            if (
                parameter.valueDeclaration &&
                ts.isParameter(parameter.valueDeclaration) &&
                parameter.valueDeclaration.dotDotDotToken
            ) {
                return undefined;
            }
            const type = this.dataTypes.fromTsType(
                this.checker.getTypeOfSymbolAtLocation(
                    parameter,
                    site,
                ),
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
                this.allocateTemporaryCppName(
                    `forward_callback_arg_${index}`,
                ),
            );
        }
        this.reachJsData();
        const parameterCpp = parameterTypes.map((type) =>
            this.dataTypes.cppType(type),
        );
        this.emitNativeCallbackStorage(
            cppName,
            `void(${parameterCpp.join(", ")})`,
            // The slot exists because a closure handed to the builder
            // references it, and that closure's whole purpose is to run
            // when an event fires after the builder returned -- the
            // forward edge always escapes.
            true,
        );
        this.defineVariable(declaration.name as ts.Identifier, {
            kind: "callback",
            cpp: cppName,
            nativeCallbackParameterTypes: parameterTypes,
        });
        return { parameterTypes, parameterNames };
    }

    /** Fills the native slot opened by prepareForwardFunctionResult. */
    private completeForwardFunctionResult(
        declaration: ts.VariableDeclaration,
        cppName: string,
        forward: {
            parameterTypes: readonly DataType[];
            parameterNames: readonly string[];
        },
        value: Value,
    ): void {
        if (
            value.kind !== "callback" ||
            !value.callbackDeclaration
        ) {
            this.fail(
                declaration.initializer!,
                "Function-valued call initializer did not return a supported callback.",
            );
        }
        const arguments_ = forward.parameterTypes.map(
            (type, index) =>
                this.dataValue(forward.parameterNames[index]!, type),
        );
        const lines = this.captureEmittedLines(() => {
            const compile = () =>
                this.compileCallbackWithValues(
                    value.callbackDeclaration!,
                    arguments_,
                    declaration.initializer!,
                );
            const result = value.callbackRecordOwner
                ? this.withRecordScopes(
                      value.callbackRecordOwner,
                      compile,
                  )
                : compile();
            if (result.cpp.length > 0) {
                this.emit(
                    result.requiresExplicitDiscard
                        ? `static_cast<void>(${result.cpp});`
                        : `${result.cpp};`,
                );
            }
        });
        const parameters = forward.parameterTypes.map(
            (type, index) =>
                `${this.dataTypes.cppType(type)} ${forward.parameterNames[index]}`,
        );
        this.emit(`${cppName} = [&](${parameters.join(", ")}) {`);
        this.increaseIndent();
        for (const line of lines) this.emit(line);
        this.decreaseIndent();
        this.emit("};");
    }

    /**
     * Whether re-expanding a scalar initializer could evaluate source work a
     * second time. Calls are conservatively snapshots: even a currently pure
     * helper can close over mutable state, and JavaScript evaluates it once at
     * the declaration rather than again at every numeric sink.
     */
    private expressionHasObservableEvaluation(node: ts.Node): boolean {
        let found = false;
        const visit = (candidate: ts.Node): void => {
            if (found) return;
            if (
                ts.isCallExpression(candidate) ||
                ts.isNewExpression(candidate) ||
                ts.isAwaitExpression(candidate) ||
                ts.isTaggedTemplateExpression(candidate)
            ) {
                found = true;
                return;
            }
            ts.forEachChild(candidate, visit);
        };
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
        const visit = (node: ts.Node): void => {
            if (recursive) return;
            if (
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                this.symbols.valueSymbol(node.expression) === symbol
            ) {
                recursive = true;
                return;
            }
            if (node !== callback && ts.isFunctionLike(node)) {
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(callback.body);
        if (!recursive) return;
        if (!ts.isBlock(callback.body)) {
            this.fail(
                callback.body,
                "Recursive callbacks require a block body.",
            );
        }
        const callbackBody = callback.body;
        const signature =
            this.checker.getSignatureFromDeclaration(callback);
        if (!signature) {
            this.fail(callback, "Recursive callback has no callable signature.");
        }
        const returnTsType =
            this.checker.getReturnTypeOfSignature(signature);
        const returnType =
            (returnTsType.flags & ts.TypeFlags.Void) !== 0
                ? undefined
                : this.dataTypes.fromTsType(
                      returnTsType,
                      callback,
                  );
        if (
            (returnTsType.flags & ts.TypeFlags.Void) === 0 &&
            !returnType
        ) {
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
            const byReference = passesByReference(
                this.dataTypes,
                type,
            );
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
        const parameterTypes = parameters.map(({ type, byReference, readOnly }) =>
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
                new Set<SupportedFunction>([callback]),
                [enclosingBody],
            );
        this.emitNativeCallbackStorage(
            cppName,
            `${returnCpp}(${parameterTypes.join(", ")})`,
            escapes,
        );
        this.defineVariable(name, {
            kind: "callback",
            cpp: cppName,
            callbackDeclaration: callback,
        });
        const { parameterDeclarations, lines } =
            captureDataFunctionBody(
                this,
                parameters,
                returnType,
                () => {
                for (const statement of callbackBody.statements) {
                    this.emitStatement(statement);
                    if (
                        this.statementTerminatesAfterLowering(
                            statement,
                        )
                    ) {
                        break;
                    }
                }
                },
            );
        this.emit(
            `${cppName} = [&](${parameterDeclarations.join(", ")}) -> ${returnCpp} {`,
        );
        this.increaseIndent();
        for (const line of lines) {
            this.emit(line);
        }
        this.decreaseIndent();
        this.emit("};");
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
    private emitAnnotatedDataDeclaration(
        declaration: ts.VariableDeclaration,
        cppName: string,
    ): boolean {
        if (!declaration.initializer) {
            return false;
        }
        const typeSite = declaration.type ?? declaration.name;
        let annotated = this.dataTypes.fromTsType(
            declaration.type
                ? this.checker.getTypeFromTypeNode(declaration.type)
                : this.checker.getTypeAtLocation(declaration.name),
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
        if (
            annotated?.kind === "enum" &&
            this.needsSharedClosureStorage(declaration)
        ) {
            const initializer = this.compileValue(declaration.initializer);
            const cppType = this.dataTypes.cppType(annotated);
            const initializerCpp =
                this.dataLowerer.compileKnownValueForSink(
                    initializer,
                    annotated,
                    declaration.initializer,
                );
            this.emit(
                `auto ${cppName} = std::make_shared<${cppType}>(${initializerCpp});`,
            );
            this.defineVariable(declaration.name as ts.Identifier, {
                kind: "data",
                cpp: `(*${cppName})`,
                dataType: annotated,
            });
            return true;
        }
        const inferredMutableArray =
            !declaration.type &&
            ts.isIdentifier(declaration.name) &&
            ts.isArrayLiteralExpression(this.unwrap(declaration.initializer)) &&
            this.inferredArrayIsMutated(declaration.name);
        const initializer = this.unwrap(declaration.initializer);
        const annotatedOpenRecordLiteral =
            declaration.type !== undefined &&
            annotated?.kind === "map" &&
            ts.isObjectLiteralExpression(initializer) &&
            ts.isIdentifier(declaration.name);
        if (
            annotatedOpenRecordLiteral &&
            !this.openRecordContainerIsMutated(declaration.name as ts.Identifier) &&
            !this.inferredObjectIsRebound(declaration.name as ts.Identifier)
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
        const mutablePlainObject =
            ts.isIdentifier(declaration.name) &&
            inferredPlainObject &&
            (ts.isObjectLiteralExpression(initializer)
                ? this.inferredObjectIsMutated(declaration.name)
                : this.inferredObjectIsRebound(declaration.name));
        const inferredMutableObject =
            !declaration.type && mutablePlainObject;
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
            annotated = this.dataTypes.markStoredObjectReferences(
                annotated,
            );
        }
        const initializerLiteral = this.unwrap(
            declaration.initializer,
        );
        if (
            !annotated ||
            annotated.kind === "number" ||
            annotated.kind === "boolean" ||
            (annotated.kind === "handle" &&
                annotated.handle === "texture") ||
            annotated.kind === "span" ||
            annotated.kind === "table" ||
            (annotated.kind === "optional" &&
                annotated.inner.kind === "handle") ||
            (annotated.kind === "tuple" &&
                !ts.isArrayLiteralExpression(
                    initializerLiteral,
                ))
        ) {
            // Readonly views keep the legacy static-tuple declaration
            // semantics; only owning composites (and mutable tuple
            // locals initialized from array literals) take the data
            // path. An optional HANDLE local (`Mesh | undefined` from a
            // search) keeps the value path too: a handle a search
            // produced carries its found flag, which is this port's
            // representation of that optionality.
            return false;
        }
        if (ts.isIdentifier(declaration.name)) {
            const symbol = this.symbols.valueSymbol(
                declaration.name,
            );
            if (symbol) this.staticConstants.delete(symbol);
        }
        const staticHandleElementType =
            annotated.kind === "vector" &&
            annotated.element.kind === "handle"
                ? annotated.element
                : undefined;
        const staticHandleEntries =
            staticHandleElementType &&
            ts.isArrayLiteralExpression(initializer) &&
            initializer.elements.every(
                (element) =>
                    ts.isIdentifier(element) ||
                    ts.isSpreadElement(element),
            )
            ? this.handleCollections.staticHandleList(initializer)
            : undefined;
        const staticHandleElements = staticHandleEntries?.every(
            ({ value }) =>
                value.kind === staticHandleElementType?.handle,
        )
            ? staticHandleEntries.map(({ value }) => value)
            : undefined;
        const staticElements =
            annotated.kind === "vector" &&
            ts.isArrayLiteralExpression(initializer) &&
            initializer.elements.length === 0
                ? []
                : staticHandleElements;
        this.reachJsData();
        const spreadTarget =
            annotated.kind === "struct"
                ? annotated
                : annotated.kind === "optional" &&
                    annotated.inner.kind === "struct"
                  ? annotated.inner
                  : undefined;
        if (
            spreadTarget &&
            ts.isObjectLiteralExpression(initializer) &&
            initializer.properties.some((property) =>
                ts.isSpreadAssignment(property),
            )
        ) {
            this.dataLowerer.emitSpreadStructDeclaration(
                cppName,
                initializer,
                spreadTarget,
            );
        } else {
            const initializerCpp = this.dataLowerer.compileForSink(
                declaration.initializer,
                annotated,
            );
            this.emit(
                `${this.dataTypes.cppType(annotated)} ${cppName} = ${initializerCpp};`,
            );
        }
        if (
            ts.isArrayLiteralExpression(initializer) &&
            ts.isIdentifier(declaration.name) &&
            isNeverResized(declaration.name)
        ) {
            this.dataLowerer.registerFixedLength(
                cppName,
                initializer.elements.length,
            );
        }
        this.dataLowerer.registerLocal(
            cppName,
            (annotated.kind === "struct" &&
                this.dataTypes.isReferenceStruct(annotated.name)) ||
                ts.isCallExpression(initializer) ||
                ts.isNewExpression(initializer) ||
                ts.isObjectLiteralExpression(initializer) ||
                ts.isArrayLiteralExpression(initializer)
                ? "owned"
                : "copy",
        );
        const staticRecordProperties: Record<string, Value> = {};
        if (
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
        this.defineVariable(declaration.name as ts.Identifier, {
            kind: "data",
            cpp: cppName,
            dataType: annotated,
            ...(annotated.kind === "map" &&
            ts.isObjectLiteralExpression(initializer) &&
            initializer.properties.length === 0
                ? { recordProperties: {} }
                : Object.keys(staticRecordProperties).length > 0
                ? { recordProperties: staticRecordProperties }
                : {}),
            ...(staticElements ? { staticElements } : {}),
        });
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
     * (`const b = arr`) creates an alias.
     */
    private inferredArrayIsMutated(identifier: ts.Identifier): boolean {
        return aliasedMutationScan(
            identifier,
            (name) => this.symbols.valueSymbol(name),
            {
                aliasingInitializer: (initializer, scan) =>
                    scan.namesAlias(this.unwrap(initializer)),
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
                            // A runtime index needs actual array storage
                            // even when the inferred literal is never
                            // resized.
                            return true;
                        }
                    }
                    if (
                        (ts.isPrefixUnaryExpression(node) ||
                            ts.isPostfixUnaryExpression(node)) &&
                        (node.operator ===
                            ts.SyntaxKind.PlusPlusToken ||
                            node.operator ===
                                ts.SyntaxKind.MinusMinusToken) &&
                        ts.isElementAccessExpression(node.operand) &&
                        scan.namesAlias(
                            this.unwrap(node.operand.expression),
                        )
                    ) {
                        // `arr[0]++` writes the element without a binary
                        // assignment node; the runtime-index clause above
                        // only catches non-static subscripts.
                        return true;
                    }
                    if (ts.isCallExpression(node)) {
                        if (
                            ts.isPropertyAccessExpression(
                                node.expression,
                            ) &&
                            scan.namesAlias(
                                this.unwrap(node.expression.expression),
                            ) &&
                            mutatingArrayMethods.has(
                                node.expression.name.text,
                            )
                        ) {
                            return true;
                        }
                        if (node.arguments.some(scan.containsAlias)) {
                            return true;
                        }
                    }
                    return (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind >=
                            ts.SyntaxKind.FirstAssignment &&
                        node.operatorToken.kind <=
                            ts.SyntaxKind.LastAssignment &&
                        ((ts.isElementAccessExpression(node.left) &&
                            scan.namesAlias(
                                this.unwrap(node.left.expression),
                            )) ||
                            scan.namesAlias(this.unwrap(node.left)))
                    );
                },
            },
        );
    }

    private openRecordContainerIsMutated(
        identifier: ts.Identifier,
    ): boolean {
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) return false;
        let mutated = false;
        const directlyIndexes = (expression: ts.Expression): boolean =>
            (ts.isElementAccessExpression(expression) ||
                ts.isPropertyAccessExpression(expression)) &&
            ts.isIdentifier(this.unwrap(expression.expression)) &&
            this.symbols.valueSymbol(
                this.unwrap(expression.expression) as ts.Identifier,
            ) === symbol;
        const visit = (node: ts.Node): void => {
            if (mutated) return;
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
                node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
                directlyIndexes(node.left)
            ) {
                mutated = true;
                return;
            }
            if (
                (ts.isPrefixUnaryExpression(node) ||
                    ts.isPostfixUnaryExpression(node)) &&
                directlyIndexes(node.operand)
            ) {
                mutated = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(identifier.getSourceFile(), visit);
        return mutated;
    }

    /** A non-literal inferred struct needs storage only when its binding changes. */
    private inferredObjectIsRebound(identifier: ts.Identifier): boolean {
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) return false;
        let rebound = false;
        const visit = (node: ts.Node): void => {
            if (rebound) return;
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(node.left) &&
                this.symbols.valueSymbol(node.left) === symbol
            ) {
                rebound = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(identifier.getSourceFile(), visit);
        return rebound;
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
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        ts.isIdentifier(node.left) &&
                        scan.namesAlias(node.left)
                    ) {
                        // Rebinding an inferred object still needs
                        // persistent reference storage even when no field
                        // is written.
                        return true;
                    }
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind >=
                            ts.SyntaxKind.FirstAssignment &&
                        node.operatorToken.kind <=
                            ts.SyntaxKind.LastAssignment &&
                        (ts.isPropertyAccessExpression(node.left) ||
                            ts.isElementAccessExpression(node.left)) &&
                        isAlias(scan, node.left)
                    ) {
                        return true;
                    }
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
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
                        (ts.isPrefixUnaryExpression(node) ||
                            ts.isPostfixUnaryExpression(node)) &&
                        (node.operator ===
                            ts.SyntaxKind.PlusPlusToken ||
                            node.operator ===
                                ts.SyntaxKind.MinusMinusToken) &&
                        (ts.isPropertyAccessExpression(node.operand) ||
                            ts.isElementAccessExpression(node.operand)) &&
                        isAlias(scan, node.operand)
                    ) {
                        return true;
                    }
                    if (ts.isCallExpression(node)) {
                        if (
                            ts.isPropertyAccessExpression(
                                node.expression,
                            ) &&
                            storingDataMethods.has(
                                node.expression.name.text,
                            ) &&
                            node.arguments.some(scan.containsAlias)
                        ) {
                            return true;
                        }
                        const signature =
                            this.checker.getResolvedSignature(node);
                        const parameters =
                            signature?.declaration?.parameters;
                        if (parameters) {
                            node.arguments.forEach((argument, index) => {
                                if (!scan.containsAlias(argument)) return;
                                const parameter = parameters[index];
                                if (
                                    !parameter ||
                                    !ts.isIdentifier(parameter.name)
                                ) {
                                    return;
                                }
                                scan.addAlias(
                                    this.symbols.valueSymbol(
                                        parameter.name,
                                    ),
                                );
                            });
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
        const rawValue = this.compileValue(
            declaration.initializer,
        );
        const value =
            rawValue.kind === "data"
                ? this.dataLowerer.narrowOptional(
                      rawValue,
                      declaration.initializer,
                  )
                : rawValue;
        const bindings = declaration.name.elements;
        const bindElement = (
            element: ts.ArrayBindingElement,
            bound: Value,
        ): void => {
            if (ts.isOmittedExpression(element)) {
                return;
            }
            if (
                !ts.isIdentifier(element.name) ||
                element.initializer ||
                element.dotDotDotToken
            ) {
                this.fail(
                    element,
                    "Tuple destructuring supports plain identifiers.",
                );
            }
            let stored = bound;
            if (bound.kind === "record") {
                const declared = this.dataTypes.fromTsType(
                    this.checker.getTypeAtLocation(element.name),
                    element.name,
                );
                if (declared?.kind === "struct") {
                    const dataType = this.dataTypes.markStoredObjectReferences(
                        declared,
                    );
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
        if (
            value.kind === "tuple" &&
            value.tupleElements
        ) {
            if (
                bindings.length >
                value.tupleElements.length
            ) {
                this.fail(
                    declaration.name,
                    `Tuple has ${value.tupleElements.length} elements, destructuring expects ${bindings.length}.`,
                );
            }
            bindings.forEach((element, index) => {
                bindElement(
                    element,
                    value.tupleElements![index]!,
                );
            });
            return;
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "tuple"
        ) {
            const temporary = this.bindDataTuple(
                value,
                value.dataType.arity,
            );
            bindings.forEach((element, index) => {
                bindElement(element, {
                    kind: "number",
                    cpp: `${temporary}[${index}]`,
                    dataType: { kind: "number" },
                });
            });
            return;
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "vector"
        ) {
            const temporary =
                this.allocateTemporaryCppName("destructure_vector");
            this.emit(`const auto& ${temporary} = ${value.cpp};`);
            const storedVector: Value = {
                ...value,
                cpp: temporary,
            };
            bindings.forEach((element, index) => {
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
        const rawValue = this.compileValue(
            declaration.initializer,
        );
        const value =
            rawValue.kind === "data"
                ? this.dataLowerer.narrowOptional(
                      rawValue,
                      declaration.initializer,
                  )
                : rawValue;
        if (value.kind === "record") {
            this.emitRecordBindingDeclaration(
                declaration.name,
                value,
            );
            return;
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "struct"
        ) {
            const temporary =
                this.allocateTemporaryCppName(
                    "destructure",
                );
            this.emit(`auto&& ${temporary} = ${value.cpp};`);
            for (const element of declaration.name.elements) {
                if (element.initializer) {
                    this.fail(
                        element,
                        "Default values in data-struct destructuring are not supported.",
                    );
                }
                const { name, property } =
                    this.bindingProperty(element);
                const field = this.dataTypes.structField(
                    value.dataType.name,
                    property,
                    element,
                );
                const cppName = this.cppIdentifier(name.text);
                const fieldCpp =
                    `${temporary}${this.dataTypes.isReferenceStruct(value.dataType.name) ? "->" : "."}${field.name}`;
                const aliases =
                    field.type.kind !== "number" &&
                    field.type.kind !== "boolean" &&
                    field.type.kind !== "string" &&
                    field.type.kind !== "enum" &&
                    field.type.kind !== "handle";
                this.emit(
                    `${this.dataTypes.cppType(field.type)}${aliases ? "&" : ""} ${cppName} = ${fieldCpp};`,
                );
                const fieldValue =
                    this.dataLowerer.leafValue(
                        cppName,
                        field.type,
                    );
                const staticField =
                    value.recordProperties?.[property];
                if (
                    staticField?.staticNumber !== undefined
                ) {
                    fieldValue.staticNumber =
                        staticField.staticNumber;
                }
                if (
                    staticField?.staticString !== undefined
                ) {
                    fieldValue.staticString =
                        staticField.staticString;
                }
                if (
                    staticField?.staticBoolean !== undefined
                ) {
                    fieldValue.staticBoolean =
                        staticField.staticBoolean;
                }
                if (aliases && staticField?.staticElements) {
                    fieldValue.staticElements =
                        staticField.staticElements;
                    fieldValue.staticElementsOwner =
                        staticField.staticElementsOwner ?? staticField;
                }
                this.defineVariable(name, fieldValue);
                if (aliases) {
                    this.dataLowerer.registerAlias(
                        cppName,
                        fieldCpp,
                    );
                }
            }
            return;
        }
        if (value.kind === "physics-aggregate") {
            const temporary =
                this.allocateTemporaryCppName("destructure");
            this.emit(`const auto ${temporary} = ${value.cpp};`);
            for (const element of declaration.name.elements) {
                if (element.initializer) {
                    this.fail(
                        element,
                        "Default values in physics aggregate destructuring are not supported.",
                    );
                }
                const { name, property } =
                    this.bindingProperty(element);
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
                this.emit(
                    `const auto ${cppName} = ${propertyValue.cpp};`,
                );
                this.defineVariable(name, {
                    ...propertyValue,
                    cpp: cppName,
                });
            }
            return;
        }
        if (
            value.kind !== "render-target-texture"
        ) {
            this.fail(
                declaration.initializer,
                `Object destructuring is not supported for ${value.kind}.`,
            );
        }
        const temporary =
            this.allocateTemporaryCppName(
                "destructure",
            );
        this.emit(`auto ${temporary} = ${value.cpp};`);
        for (const element of declaration.name.elements) {
            const { name, property } =
                this.bindingProperty(element);
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
            this.emit(
                `auto ${cppName} = ${propertyValue.cpp};`,
            );
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
        if (
            element.dotDotDotToken ||
            !ts.isIdentifier(element.name)
        ) {
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
        for (const element of pattern.elements) {
            const { name, property } =
                this.bindingProperty(element);
            const propertyValue =
                value.recordProperties?.[property];
            if (!propertyValue) {
                this.fail(
                    element,
                    `Record has no property '${property}'.`,
                );
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
                `[[maybe_unused]] double ${cppName} = ${propertyValue.cpp};`,
            );
            this.defineVariable(name, {
                kind: "number",
                cpp: cppName,
                ...(propertyValue.staticNumber === undefined
                    ? {}
                    : {
                          staticNumber:
                              propertyValue.staticNumber,
                      }),
            });
        }
    }

    public emitAssignment(expression: ts.BinaryExpression): void {
        if (
            emitStructuralPropertyAssignment(
                this,
                expression,
            )
        ) {
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

    private uiElementValue(
        expression: ts.Expression,
    ): Value | undefined {
        const owner = this.unwrap(expression);
        if (ts.isIdentifier(owner)) {
            const value = this.lookupOptional(owner);
            return value?.kind === "ui-element" ? value : undefined;
        }
        if (
            ts.isPropertyAccessExpression(owner) &&
            owner.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
            const value = this.resolveThisField(owner.name.text);
            return value?.kind === "ui-element" ? value : undefined;
        }
        if (ts.isPropertyAccessExpression(owner)) {
            const value =
                this.resolveRecordMember(owner) ??
                this.dataLowerer.compileDataPath(owner, "read");
            return value?.kind === "ui-element" ? value : undefined;
        }
        if (ts.isCallExpression(owner)) {
            const callee = this.unwrap(owner.expression);
            if (
                ts.isPropertyAccessExpression(callee) &&
                callee.name.text === "getContext"
            ) {
                const canvas = this.uiElementValue(callee.expression);
                if (canvas?.uiCanvas) {
                    return { ...canvas, uiCanvasContext: true };
                }
            }
        }
        return undefined;
    }

    private uiCreatedElementTag(
        expression: ts.Expression,
    ): string | undefined {
        const direct = this.uiElementValue(expression)?.uiTag;
        if (direct) return direct;
        const owner = this.unwrap(expression);
        if (!ts.isIdentifier(owner)) return undefined;
        const declaration = this.symbols.valueSymbol(owner)?.valueDeclaration;
        if (
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !declaration.initializer
        ) {
            return undefined;
        }
        const initializer = this.unwrap(declaration.initializer);
        if (
            !ts.isCallExpression(initializer) ||
            !ts.isPropertyAccessExpression(initializer.expression) ||
            initializer.expression.name.text !== "createElement" ||
            initializer.arguments.length !== 1
        ) {
            return undefined;
        }
        const tag = this.tryUiStaticString(initializer.arguments[0]!);
        return tag?.toLowerCase();
    }

    /** Whether an expression is already known to produce retained UI state. */
    public isNativeUiValueExpression(expression: ts.Expression): boolean {
        const value = this.unwrap(expression);
        if (ts.isElementAccessExpression(value)) {
            const dataType = this.dataLowerer.dataTypeAt(value);
            return (
                dataType?.kind === "handle" &&
                dataType.handle === "ui-element"
            );
        }
        if (ts.isIdentifier(value)) {
            return this.lookupOptional(value)?.kind === "ui-element";
        }
        if (ts.isPropertyAccessExpression(value)) {
            return (
                this.uiElementValue(value)?.kind === "ui-element" ||
                this.resolveRecordMember(value)?.kind === "ui-element"
            );
        }
        if (!ts.isCallExpression(value)) return false;
        if (this.uiElementValue(value)?.kind === "ui-element") {
            return true;
        }
        const callee = this.unwrap(value.expression);
        const createsElement =
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "createElement" &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "document" &&
            this.isDefaultLibraryIdentifier(callee.expression) &&
            value.arguments[0] !== undefined &&
            (ts.isStringLiteral(value.arguments[0]) ||
                ts.isNoSubstitutionTemplateLiteral(value.arguments[0]));
        return (
            createsElement ||
            this.isNativeHostUiLookup(value) ||
            this.isNativeUiHelperCall(value)
        );
    }

    private uiStringCpp(
        expression: ts.Expression,
        purpose: string,
    ): string {
        const staticValue = this.tryUiStaticString(expression);
        if (staticValue !== undefined) {
            return this.cppString(staticValue);
        }
        const value = this.compileValue(expression);
        if (
            value.kind === "string" ||
            (value.kind === "data" && value.dataType?.kind === "string")
        ) {
            return value.cpp;
        }
        this.fail(
            expression,
            `${purpose} requires a string, received ${value.kind}.`,
        );
    }

    private tryUiStaticString(
        expression: ts.Expression,
    ): string | undefined {
        try {
            return this.evaluator.compileStringLiteral(
                expression,
            );
        } catch (error) {
            if (error instanceof CompileError) return undefined;
            throw error;
        }
    }

    private collectUiStringParts(
        expression: ts.Expression,
    ): Array<string | ts.Expression> | undefined {
        const parts: Array<string | ts.Expression> = [];
        const collect = (node: ts.Expression): boolean => {
            const value = this.tryUiStaticString(node);
            if (value !== undefined) {
                parts.push(value);
                return true;
            }
            const current = this.unwrap(node);
            if (ts.isTemplateExpression(current)) {
                parts.push(current.head.text);
                for (const span of current.templateSpans) {
                    parts.push(span.expression, span.literal.text);
                }
                return true;
            }
            return (
                ts.isBinaryExpression(current) &&
                current.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                collect(current.left) &&
                collect(current.right)
            );
        };
        return collect(expression) ? parts : undefined;
    }

    private uiTemplateSubstitutionCpp(
        expression: ts.Expression,
        purpose: string,
        allowStringFallback = false,
    ): string {
        const logical = this.unwrap(expression);
        if (
            allowStringFallback &&
            ts.isBinaryExpression(logical) &&
            logical.operatorToken.kind === ts.SyntaxKind.BarBarToken
        ) {
            const left = this.compileValue(logical.left);
            const right = this.compileValue(logical.right);
            const isString = (value: Value): boolean =>
                value.kind === "string" ||
                (value.kind === "data" && value.dataType?.kind === "string");
            if (isString(left) && isString(right)) {
                return (
                    `(!std::string(${left.cpp}).empty()` +
                    ` ? std::string(${left.cpp})` +
                    ` : std::string(${right.cpp}))`
                );
            }
        }
        const value = this.compileValue(expression);
        if (value.staticString !== undefined) {
            return this.cppString(value.staticString);
        }
        if (value.staticNumber !== undefined) {
            return this.cppString(String(value.staticNumber));
        }
        if (value.kind === "number") {
            return `bbl::js::number_to_string(${value.cpp})`;
        }
        if (
            value.kind === "string" ||
            (value.kind === "data" && value.dataType?.kind === "string")
        ) {
            return value.cpp;
        }
        this.fail(
            expression,
            `${purpose} template substitutions must be strings or numbers.`,
        );
    }

    private uiBooleanCpp(
        expression: ts.Expression,
        purpose: string,
    ): string {
        const value = this.compileValue(expression);
        if (
            value.kind === "boolean" ||
            (value.kind === "data" && value.dataType?.kind === "boolean")
        ) {
            return value.cpp;
        }
        this.fail(
            expression,
            `${purpose} requires a boolean, received ${value.kind}.`,
        );
    }

    /**
     * The reviewed retained-UI style surface (AP-3). Every property here was
     * reached by the pinned applications, the audited host companions, or the
     * registered corpus scenes, and lowers with browser-equivalent meaning
     * (directly or through the compatibility rewrites below). A property in
     * none of the four sets refuses at generation naming itself, so an
     * unreviewed declaration can never silently drop into the projection.
     */
    private static readonly PROJECTED_UI_STYLE_PROPERTIES = new Set<string>([
        "align-items",
        "animation",
        "background",
        "background-color",
        "border",
        "border-color",
        "border-radius",
        "bottom",
        "color",
        "cursor",
        "display",
        "flex-direction",
        "font",
        "font-family",
        "font-size",
        "font-weight",
        "gap",
        "height",
        "inset",
        "justify-content",
        "left",
        "letter-spacing",
        "line-height",
        "margin",
        "margin-bottom",
        "margin-top",
        "max-width",
        "min-width",
        "opacity",
        "overflow",
        "padding",
        "pointer-events",
        "position",
        "right",
        "text-align",
        "text-shadow",
        "top",
        "transform",
        "transition",
        "white-space",
        "width",
        "z-index",
    ]);

    /**
     * Reached hints with no rendering semantics in the retained projection:
     * `will-change`/`touch-action`/`user-select` describe browser scrolling,
     * selection, and compositor behaviour the native input path does not
     * have, and `image-rendering` is superseded by the sampling intent the
     * retained canvas commands already carry per blit.
     */
    private static readonly INERT_UI_STYLE_PROPERTIES = new Set<string>([
        "image-rendering",
        "touch-action",
        "user-select",
        "will-change",
    ]);

    /**
     * Reached properties the projection accepts WITHOUT a native rendering:
     * box shadows need render layers the backend-neutral recorder does not
     * expose (`pal_ui_rml.cpp` filters the dynamic writes for the same
     * reason), backdrop filters would sample the composited scene, and RmlUi
     * has no numeral variants. Each acceptance is recorded per scene in the
     * `substituted-ui-runtime` fidelity adaptation.
     */
    private static readonly DEGRADED_UI_STYLE_PROPERTIES = new Set<string>([
        "-webkit-backdrop-filter",
        "backdrop-filter",
        "box-shadow",
        "font-variant-numeric",
    ]);

    /**
     * Properties consumed by the gradient-text projection (the reached
     * `background-clip:text` shimmer combination). Outside that combination
     * nothing lowers them, so they refuse rather than silently dropping.
     */
    private static readonly GRADIENT_TEXT_UI_STYLE_PROPERTIES = new Set<string>([
        "-webkit-background-clip",
        "-webkit-text-stroke",
        "background-clip",
        "background-size",
        "filter",
    ]);

    /** The one gradient-text `filter` form the projection consumes. */
    private static readonly GRADIENT_TEXT_SHADOW_PATTERN =
        /\bfilter\s*:\s*drop-shadow\(\s*([^\s]+)\s+([^\s]+)\s+(?:[^\s]+\s+)?(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s*\)/i;

    /** The one gradient-text stroke form the projection consumes. */
    private static readonly GRADIENT_TEXT_STROKE_PATTERN =
        /-webkit-text-stroke\s*:\s*([^\s;]+)\s+([^;]+)/i;

    /** The reached CSS-grid combination the block projection lowers. */
    private static readonly GRID_TEMPLATE_COLUMNS_PATTERN =
        /\bgrid-template-columns\s*:\s*repeat\(\s*(\d+)\s*,\s*([0-9]+(?:\.[0-9]*)?)px\s*\)\s*;?/i;

    /** The gradient-text projection trigger both the audit and the
     *  projection test on one declaration list. */
    private static readonly GRADIENT_TEXT_CLIP_PATTERN =
        /(?:-webkit-)?background-clip\s*:\s*text/i;

    /** The gradient-text background half of the same combination; group 1
     *  is the gradient's argument list for the projection's colour reads. */
    private static readonly GRADIENT_TEXT_BACKGROUND_PATTERN =
        /\bbackground\s*:\s*linear-gradient\(([^;]*)\)/i;

    /** The `display:grid` half of the grid-projection pairing. */
    private static readonly DISPLAY_GRID_PATTERN =
        /\bdisplay\s*:\s*grid\b/i;

    /** The grid projection's pairing rule, stated once for the audit and
     *  the projection: `display:grid` lowers only beside the reached
     *  `grid-template-columns:repeat(N, px)` form in the same list. */
    private static projectsUiGrid(declarations: string): boolean {
        return (
            Compiler.DISPLAY_GRID_PATTERN.test(declarations) &&
            Compiler.GRID_TEMPLATE_COLUMNS_PATTERN.test(declarations)
        );
    }

    /**
     * Walks one inline declaration list, calling `visit` for each
     * declaration split at top-level semicolons only — a `;` inside
     * parentheses (`url(...)`, a gradient argument) does not end a
     * declaration. The one segmentation authority for the audit and the
     * projection.
     */
    private static forEachUiStyleDeclaration(
        value: string,
        visit: (declaration: string) => void,
    ): void {
        let depth = 0;
        let start = 0;
        for (let index = 0; index <= value.length; index++) {
            const character = value[index];
            if (character === "(") depth++;
            if (character === ")") depth--;
            if (
                index !== value.length &&
                (character !== ";" || depth > 0)
            ) {
                continue;
            }
            visit(value.slice(start, index));
            start = index + 1;
        }
    }

    /** Placeholder for a `;` inside parentheses while the projection's
     *  declaration-scoped rewrites run; restored on the way out. Never
     *  appears in authored CSS. */
    private static readonly UI_MASKED_SEMICOLON = "\u0001";

    /**
     * The projection's rewrites are declaration-scoped regexes whose
     * `[^;]*` classes must stop exactly where the audited splitter
     * stops. Masking every parenthesized `;` makes both parsers segment
     * by the same walk; on a list with none — every reached sheet — the
     * text is rebuilt unchanged, byte for byte.
     */
    private static maskUiParenthesizedSemicolons(
        value: string,
    ): string {
        const declarations: string[] = [];
        Compiler.forEachUiStyleDeclaration(value, (declaration) =>
            declarations.push(
                declaration.replaceAll(
                    ";",
                    Compiler.UI_MASKED_SEMICOLON,
                ),
            ),
        );
        return declarations.join(";");
    }

    /**
     * Style properties accepted with a recorded rendering degradation, for
     * this scene's `substituted-ui-runtime` fidelity adaptation.
     */
    public readonly uiDegradedStyleProperties = new Set<string>();

    /**
     * Reviewed `#id .class` sheet selectors this scene projects as global
     * class rules, recorded in the `substituted-ui-runtime` adaptation.
     */
    public readonly uiWidenedSheetSelectors = new Set<string>();

    /** Sheet rule targets seen so far, for widened-selector collisions. */
    private readonly uiSheetRuleTargets = new Map<
        string,
        { selector: string; style: string; widened: boolean }
    >();

    /**
     * Logical sizes that reached `scale()` calls map exactly onto a retained
     * canvas backing store (`scale(c.width / X, c.height / Y)`), which is
     * what proves a later statically-sized `clearRect(0, 0, X, Y)` covers
     * the full surface.
     */
    private readonly uiCanvasFullClearSizes = new Set<string>();

    /**
     * Statically-assigned retained-canvas backing sizes, keyed by the
     * canvas's generation identity (`uiCanvasId` — the element and its
     * 2D-context views spell different C++ locals but share the id): the
     * other statically-provable full-surface `clearRect` shape. `pairs`
     * holds every (width, height) state the static assignments provably
     * put THAT canvas through, so a width recorded from one canvas never
     * combines with a height from another into a surface no canvas ever
     * had.
     */
    private readonly uiCanvasStaticSizes = new Map<
        number,
        { width?: number; height?: number; pairs: Set<string> }
    >();

    /** Mints `uiCanvasId` for each created retained canvas element. */
    private uiCanvasIds = 0;

    private uiStyleRefusal(
        site: ts.Node | undefined,
        property: string,
        reason: string,
    ): never {
        const message =
            `Retained UI style property '${property}' is not lowered: ` +
            `${reason}. The projected surface is ` +
            `${[...Compiler.PROJECTED_UI_STYLE_PROPERTIES].join(", ")}; ` +
            "accepted with a recorded degradation: " +
            `${[...Compiler.DEGRADED_UI_STYLE_PROPERTIES].join(", ")}; ` +
            "accepted inert hints: " +
            `${[...Compiler.INERT_UI_STYLE_PROPERTIES].join(", ")}.`;
        if (site) this.fail(site, message);
        this.failAtFile(message);
    }

    /**
     * Enforce the reviewed style surface over one static CSS declaration
     * list (AP-3): a projected property lowers, a reached degraded property
     * is accepted and recorded for the scene's `substituted-ui-runtime`
     * adaptation, an inert hint passes through, and anything else refuses at
     * generation naming the property. Values may be runtime substitutions;
     * only the static property names are policed here.
     */
    private auditUiStyleDeclarations(
        value: string,
        site: ts.Node | undefined,
    ): void {
        const clipsGradientToText =
            Compiler.GRADIENT_TEXT_CLIP_PATTERN.test(value);
        const hasGradientBackground =
            Compiler.GRADIENT_TEXT_BACKGROUND_PATTERN.test(value);
        const projectsGrid = Compiler.projectsUiGrid(value);
        Compiler.forEachUiStyleDeclaration(value, (declaration) => {
            const colon = declaration.indexOf(":");
            if (colon < 0) {
                // Empty segments between semicolons; a declaration is only
                // a declaration once it names a property.
                return;
            }
            const property = declaration
                .slice(0, colon)
                .trim()
                .toLowerCase();
            const literalValue = declaration
                .slice(colon + 1)
                .trim()
                .toLowerCase();
            if (property.length === 0) return;
            if (property === "mix-blend-mode") {
                if (literalValue !== "difference") {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only the reached difference-mode crosshair is accepted as a recorded degradation",
                    );
                }
                this.uiDegradedStyleProperties.add(property);
                return;
            }
            if (Compiler.DEGRADED_UI_STYLE_PROPERTIES.has(property)) {
                this.uiDegradedStyleProperties.add(property);
                return;
            }
            if (Compiler.INERT_UI_STYLE_PROPERTIES.has(property)) return;
            if (
                Compiler.GRADIENT_TEXT_UI_STYLE_PROPERTIES.has(property)
            ) {
                if (!clipsGradientToText) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "it is consumed only by the gradient-text " +
                            "projection, which needs background-clip:text " +
                            "in the same declaration list",
                    );
                }
                if (
                    (property === "background-clip" ||
                        property === "-webkit-background-clip") &&
                    !hasGradientBackground
                ) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "the gradient-text projection needs a " +
                            "linear-gradient background beside " +
                            "background-clip:text",
                    );
                }
                if (
                    property === "filter" &&
                    !Compiler.GRADIENT_TEXT_SHADOW_PATTERN.test(value)
                ) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only the gradient-text drop-shadow(x y color) " +
                            "form is consumed",
                    );
                }
                if (
                    property === "-webkit-text-stroke" &&
                    !Compiler.GRADIENT_TEXT_STROKE_PATTERN.test(value)
                ) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "only the gradient-text 'width color' stroke " +
                            "form is consumed",
                    );
                }
                return;
            }
            if (
                property === "grid-template-columns" ||
                property === "grid-template-rows"
            ) {
                if (!projectsGrid) {
                    this.uiStyleRefusal(
                        site,
                        property,
                        "the grid projection lowers only display:grid " +
                            "with grid-template-columns:repeat(N, px) in " +
                            "the same declaration list",
                    );
                }
                return;
            }
            if (
                property === "display" &&
                /\bgrid\b/.test(literalValue) &&
                !projectsGrid
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "display:grid lowers only with " +
                        "grid-template-columns:repeat(N, px) in the same " +
                        "declaration list",
                );
            }
            if (
                property === "color" &&
                literalValue === "transparent" &&
                !clipsGradientToText
            ) {
                this.uiStyleRefusal(
                    site,
                    property,
                    "color:transparent is consumed only by the " +
                        "gradient-text projection",
                );
            }
            if (Compiler.PROJECTED_UI_STYLE_PROPERTIES.has(property)) {
                return;
            }
            this.uiStyleRefusal(
                site,
                property,
                "it is outside the reviewed retained-UI surface",
            );
        });
    }

    /**
     * The same reviewed-surface enforcement for one `style.<property>`
     * write or read, where the CSS name is static and the value may be a
     * runtime string.
     */
    private auditUiStylePropertyName(
        cssName: string,
        site: ts.Node,
    ): void {
        if (Compiler.DEGRADED_UI_STYLE_PROPERTIES.has(cssName)) {
            this.uiDegradedStyleProperties.add(cssName);
            return;
        }
        if (
            Compiler.INERT_UI_STYLE_PROPERTIES.has(cssName) ||
            Compiler.PROJECTED_UI_STYLE_PROPERTIES.has(cssName)
        ) {
            return;
        }
        this.uiStyleRefusal(
            site,
            cssName,
            "it is outside the reviewed retained-UI surface",
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

    /**
     * True when the expression reads a retained canvas's backing size on
     * the given axis -- directly (`canvas.width`), or through one `const`
     * alias of such a read (`const w = this._canvas.width`), which are the
     * reached shapes. The proof is the compiled value itself: a retained
     * canvas dimension always lowers to `bbl::ui_canvas_<axis>(...)`, so
     * aliasing of the canvas handle cannot defeat it.
     */
    private isUiCanvasSizeRead(
        expression: ts.Expression,
        axis: "width" | "height",
    ): boolean {
        let target = this.unwrap(expression);
        if (ts.isIdentifier(target)) {
            const declaration =
                this.checker.getSymbolAtLocation(target)?.valueDeclaration;
            if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                (ts.getCombinedNodeFlags(declaration) &
                    ts.NodeFlags.Const) !== 0
            ) {
                target = this.unwrap(declaration.initializer);
            }
        }
        if (
            !ts.isPropertyAccessExpression(target) ||
            target.name.text !== axis
        ) {
            return false;
        }
        const value = this.compileValue(target);
        return (
            value.kind === "number" &&
            value.cpp.startsWith(`bbl::ui_canvas_${axis}(`)
        );
    }

    /**
     * A reached `scale(c.width / X, c.height / Y)` maps the logical size
     * (X, Y) exactly onto the canvas backing store; remember it so a later
     * statically-sized `clearRect(0, 0, X, Y)` is provably a full-surface
     * clear (the racer minimap's shape). The record is compilation-global
     * rather than per-canvas because the retained clear is full-surface
     * regardless; the check exists to catch an authored partial clear, not
     * to re-derive canvas identity through aliases it cannot track.
     */
    private recordUiCanvasLogicalScale(call: ts.CallExpression): void {
        if (call.arguments.length !== 2) return;
        const logical = (
            argument: ts.Expression,
            axis: "width" | "height",
        ): number | undefined => {
            const expression = this.unwrap(argument);
            if (
                !ts.isBinaryExpression(expression) ||
                expression.operatorToken.kind !== ts.SyntaxKind.SlashToken ||
                !this.isUiCanvasSizeRead(expression.left, axis)
            ) {
                return undefined;
            }
            const divisor = this.compileValue(expression.right).staticNumber;
            return divisor !== undefined && divisor > 0
                ? divisor
                : undefined;
        };
        const width = logical(call.arguments[0]!, "width");
        const height = logical(call.arguments[1]!, "height");
        if (width !== undefined && height !== undefined) {
            this.uiCanvasFullClearSizes.add(`${width}x${height}`);
        }
    }

    /**
     * The retained Canvas2D clear is full-surface: the PAL drops the whole
     * draw list and ignores the rect (`docs/ui.md` Limits). Accept only
     * calls provably equal to the full surface -- origin statically (0, 0)
     * and extents that read the canvas's own width/height (directly or
     * through a const alias), or a statically-sized rect a reached
     * `scale()` maps exactly onto the backing store -- and refuse anything
     * else at generation, so a partial clear can never silently become a
     * full one (AP-2).
     */
    private expectUiCanvasFullSurfaceClear(
        call: ts.CallExpression,
        canvasId: number | undefined,
    ): void {
        if (call.arguments.length !== 4) return;
        const refuse = (shape: string): never =>
            this.fail(
                call,
                "Retained Canvas2D clearRect is lowered only as a " +
                    `full-surface clear, and ${shape}. Clear (0, 0, ` +
                    "canvas.width, canvas.height) -- or the logical size " +
                    "a reached scale() maps onto the backing store.",
            );
        for (const index of [0, 1]) {
            const origin = this.compileValue(
                call.arguments[index]!,
            ).staticNumber;
            if (origin !== 0) {
                refuse(
                    `argument ${index + 1} is not statically 0, so the ` +
                        "rect origin is not provably the surface origin",
                );
            }
        }
        if (
            this.isUiCanvasSizeRead(call.arguments[2]!, "width") &&
            this.isUiCanvasSizeRead(call.arguments[3]!, "height")
        ) {
            return;
        }
        const width = this.compileValue(call.arguments[2]!).staticNumber;
        const height = this.compileValue(call.arguments[3]!).staticNumber;
        if (width !== undefined && height !== undefined) {
            if (this.uiCanvasFullClearSizes.has(`${width}x${height}`)) {
                return;
            }
            // Only a (width, height) pair the static assignments put THIS
            // canvas through proves the rect covers its surface; matching
            // one canvas's width with another's height proves nothing.
            if (
                canvasId !== undefined &&
                this.uiCanvasStaticSizes
                    .get(canvasId)
                    ?.pairs.has(`${width}x${height}`)
            ) {
                return;
            }
            refuse(
                `the static rect ${width}x${height} is neither a ` +
                    "backing size statically assigned to this canvas " +
                    "nor a logical size a reached scale() maps onto one",
            );
        }
        refuse(
            "the extent arguments are not reads of the canvas's own " +
                "width and height",
        );
    }

    /** CSSStyleDeclaration camelCase to the CSS spelling consumed by RmlUi. */
    private nativeUiStyleProperty(property: string): string {
        const cssName = property
            .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
            .toLowerCase();
        return cssName === "background"
            ? "background-color"
            : cssName;
    }

    private lowerUiTextShadow(value: string): string | undefined {
        const shadows: string[] = [];
        let start = 0;
        let depth = 0;
        for (let index = 0; index <= value.length; index++) {
            const character = value[index];
            if (character === "(") depth++;
            if (character === ")") depth--;
            if (index !== value.length && (character !== "," || depth > 0)) {
                continue;
            }
            shadows.push(value.slice(start, index).trim());
            start = index + 1;
        }

        const length = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px|rem)?`;
        const color = String.raw`(?:#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z][a-z0-9-]*)`;
        const pattern = new RegExp(
            String.raw`^(?:(${color})\s+)?(${length})\s+(${length})(?:\s+(${length}))?(?:\s+(${color}))?$`,
            "i",
        );
        const effects: string[] = [];
        for (const shadow of shadows) {
            const match = shadow.match(pattern);
            if (!match) return undefined;
            const shadowColor = match[1] ?? match[5] ?? "currentcolor";
            const offsetX = match[2]!;
            const offsetY = match[3]!;
            const blur = match[4];
            effects.push(
                blur && Number.parseFloat(blur) > 0
                    ? `glow(0px ${blur} ${offsetX} ${offsetY} ${shadowColor})`
                    : `shadow(${offsetX} ${offsetY} ${shadowColor})`,
            );
        }
        return effects.length > 0 ? effects.join(",") : undefined;
    }

    private lowerUiAttributeLiteral(
        name: string,
        value: string,
        site?: ts.Node,
    ): string {
        if (name !== "style") return value;
        this.auditUiStyleDeclarations(value, site);
        // From here every read and rewrite is declaration-scoped by
        // regex; masking parenthesized semicolons makes those regexes
        // segment exactly where the audit's splitter did. The mask is
        // restored on the single return below.
        value = Compiler.maskUiParenthesizedSemicolons(value);
        const clipsGradientToText =
            Compiler.GRADIENT_TEXT_CLIP_PATTERN.test(value);
        const gradientTextColors = clipsGradientToText
            ? (value
                  .match(
                      Compiler.GRADIENT_TEXT_BACKGROUND_PATTERN,
                  )?.[1]
                  ?.match(/#[0-9a-f]{3,8}/gi) ?? [])
            : [];
        const gradientTextColor = gradientTextColors[0];
        const gradientTextDuration = clipsGradientToText
            ? value.match(
                  /\banimation\s*:[^;]*?\b([0-9]+(?:\.[0-9]*)?)s\b/i,
              )?.[1]
            : undefined;
        const gradientTextBackgroundScale = clipsGradientToText
            ? value.match(
                  /\bbackground-size\s*:\s*([0-9]+(?:\.[0-9]*)?)%/i,
              )?.[1]
            : undefined;
        const gradientTextStroke = clipsGradientToText
            ? value.match(Compiler.GRADIENT_TEXT_STROKE_PATTERN)
            : undefined;
        const gradientTextShadow = clipsGradientToText
            ? value.match(Compiler.GRADIENT_TEXT_SHADOW_PATTERN)
            : undefined;
        const gradientFontEffects: string[] = [];
        if (gradientTextStroke) {
            gradientFontEffects.push(
                `outline(${gradientTextStroke[1]!} ${gradientTextStroke[2]!.trim()})`,
            );
        }
        if (gradientTextShadow) {
            gradientFontEffects.push(
                `shadow(${gradientTextShadow[1]!} ${gradientTextShadow[2]!} ${gradientTextShadow[3]!})`,
            );
        }
        const sourceValue = gradientTextColor
            ? value.replace(
                  /\bbackground\s*:\s*linear-gradient\([^;]*;?/gi,
                  "",
              )
            : value;
        // RmlUi 6.4 does not accept calc() for positioned offsets. For the
        // static inline CSS surface supported here, preserve the browser
        // equation as a percentage offset plus a same-side pixel margin.
        let lowered = sourceValue
            .replace(/\bposition\s*:\s*fixed\b/gi, "position:absolute")
            .replace(
                /\bfont\s*:\s*(?:(\d+|normal|bold)\s+)?clamp\(\s*[0-9.]+px\s*,\s*[0-9.]+vw\s*,\s*([0-9.]+)px\s*\)\s+([^;]+)\s*;?/gi,
                (_match, weight, maximum, family) =>
                    `${weight ? `font-weight:${weight};` : ""}` +
                    `font-size:${maximum}px;font-family:${String(family)};`,
            )
            .replace(
                /\bfont\s*:\s*(?:(\d+|normal|bold)\s+)?([0-9]+(?:\.[0-9]*)?)(px|rem)(?:\s*\/\s*([0-9]+(?:\.[0-9]*)?(?:px|rem)?))?\s+([^;]+)\s*;?/gi,
                (_match, weight, size, unit, lineHeight, family) =>
                    `${weight ? `font-weight:${weight};` : ""}` +
                    `font-size:${size}${unit};` +
                    `${lineHeight ? `line-height:${lineHeight};` : ""}` +
                    `font-family:${String(family)};`,
            )
            .replace(
                /\bfont\s*:\s*(?:(\d+|normal|bold)\s+)?clamp\(\s*[^,]+,\s*[^,]+,\s*([0-9]+(?:\.[0-9]*)?)(px|rem)\s*\)\s+([^;]+)\s*;?/gi,
                (_match, weight, maximum, unit, family) =>
                    `${weight ? `font-weight:${weight};` : ""}` +
                    `font-size:${maximum}${unit};` +
                    `font-family:${String(family)};`,
            )
            // RmlUi resolves one family name here rather than a browser-style
            // fallback list. Route generic UI stacks to the system face that
            // the PAL loads, otherwise retain the first requested family.
            .replace(/\bfont-family\s*:\s*([^;]+)\s*;?/gi, (_match, family) => {
                const families = String(family)
                    .split(",")
                    .map((candidate) => candidate.trim())
                    .filter(Boolean);
                const first = families[0] ?? "sans-serif";
                if (/^system-ui$/i.test(first)) {
                    return "font-family:system-ui;";
                }
                if (/^sans-serif$/i.test(first)) {
                    return "font-family:sans-serif;";
                }
                if (/^monospace$/i.test(first)) {
                    return "font-family:monospace;";
                }
                return `font-family:${first};`;
            })
            .replace(
                /\binset\s*:\s*0(?:px)?\s*;?/gi,
                "top:0;right:0;bottom:0;left:0;",
            )
            // The reached voxel HUD spells its crosshair as two centred,
            // non-repeating background gradients. RmlUi gradients cover the
            // entire decorator box and cannot express CSS background sizing,
            // so preserve this exact shape as private PAL metadata. The PAL
            // materializes the vertical and horizontal bars as retained
            // children while the parent continues to own position/opacity.
            .replace(
                /\bbackground\s*:\s*linear-gradient\(\s*(#[0-9a-f]{3,8}|[a-z][a-z0-9-]*)\s*,\s*\1\s*\)\s+center\s*\/\s*2px\s+22px\s+no-repeat\s*,\s*linear-gradient\(\s*\1\s*,\s*\1\s*\)\s+center\s*\/\s*22px\s+2px\s+no-repeat\s*;?/gi,
                "--bbl-crosshair:$1;",
            )
            // RmlUi exposes CSS image gradients through its decorator
            // property. The shared render recorder implements the resulting
            // shader callback once for every PAL graphics backend.
            .replace(
                /\bbackground\s*:\s*((?:repeating-)?(?:linear|radial|conic)-gradient\([^;]*\))\s*;?/gi,
                "decorator:$1;",
            )
            // A browser background can combine a fallback colour with a
            // runtime-selected root-relative image. RmlUi exposes the image
            // through its decorator, while generation packages the closed
            // source image directory at the same logical paths.
            .replace(
                /\bbackground\s*:\s*([^;]*?)\s+url\(\s*["']?__BBLITE_UI_STYLE_(\d+)__["']?\s*\)\s+center\s*\/\s*cover\s*;?/gi,
                (_match, color, index) =>
                    `background-color:${String(color).trim()};` +
                    `decorator:image("__BBLITE_UI_ASSET_${String(index)}__" cover);`,
            )
            // RmlUi exposes the colour property explicitly rather than the
            // browser background shorthand used by the reached HUDs.
            .replace(/\bbackground\s*:/gi, "background-color:")
            .replace(/\bbackdrop-filter\s*:[^;]*;?/gi, "")
            .replace(/\bbox-shadow\s*:[^;]*;?/gi, "")
            .replace(/\bmix-blend-mode\s*:[^;]*;?/gi, "")
            // RmlUi's border shorthand is `width color`; it deliberately
            // omits CSS border-style because every non-zero border is solid.
            // Translate the ordinary browser spelling instead of letting the
            // entire declaration be rejected by its shorthand parser.
            .replace(
                /\bborder\s*:\s*([^;\s]+)\s+solid\s+([^;]+)\s*;?/gi,
                "border:$1 $2;",
            )
            .replace(/\bborder\s*:\s*none\s*;?/gi, "border:0 transparent;")
            .replace(/\bbackground-size\s*:[^;]*;?/gi, "")
            .replace(
                /(^|;)\s*(?:-webkit-)?background-clip\s*:[^;]*(?=;|$)/gi,
                "$1",
            )
            .replace(/-webkit-text-stroke\s*:[^;]*;?/gi, "")
            .replace(/\bfilter\s*:[^;]*;?/gi, "")
            .replace(/\btext-shadow\s*:\s*([^;]+)\s*;?/gi, (_match, shadow) => {
                const effect = this.lowerUiTextShadow(String(shadow));
                if (effect === undefined) {
                    this.uiStyleRefusal(
                        site,
                        "text-shadow",
                        `the shadow list '${String(shadow).trim()}' is ` +
                            "outside the reviewed '[color] x y [blur] " +
                            "[color]' form",
                    );
                }
                return `font-effect:${effect};`;
            })
            .replace(
                /\bcolor\s*:\s*transparent\s*;?/gi,
                `color:${gradientTextColor ?? "#fff"};`,
            )
            .replace(
                /\b(left|top|right|bottom)\s*:\s*calc\(\s*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))%\s*([+-])\s*([0-9]+(?:\.[0-9]*)?|\.[0-9]+)px\s*\)\s*;?/gi,
                (_match, property, percent, sign, pixels) =>
                    `${String(property).toLowerCase()}:${percent}%;` +
                    `margin-${String(property).toLowerCase()}:` +
                    `${sign === "-" ? "-" : ""}${pixels}px;`,
            );

        if (gradientTextColors.length > 1) {
            // RmlUi has no background-clip:text. Preserve the declarative
            // intent as private PAL metadata so native UI can materialize a
            // per-glyph gradient and advance the reached shimmer animation.
            lowered +=
                `;--bbl-text-gradient:${gradientTextColors.join("|")};` +
                `--bbl-text-gradient-duration:${gradientTextDuration ?? "0"}s;` +
                `--bbl-text-gradient-scale:${gradientTextBackgroundScale ?? "100"}%;`;
            if (gradientFontEffects.length > 0) {
                lowered += `font-effect:${gradientFontEffects.join(",")};`;
            }
        }

        // RmlUi 6.4 has no CSS Grid formatting context. Mark the reached
        // regular `repeat(N, px)` surface for the PAL to project as a
        // full-width outer box with a centred wrapping-flex inner box. Keeping
        // those boxes separate matters: in the browser the Tetris preview's
        // background spans the panel while only its 4x4 cells are centred.
        if (Compiler.projectsUiGrid(lowered)) {
            const gridColumns = lowered.match(
                Compiler.GRID_TEMPLATE_COLUMNS_PATTERN,
            )!;
            const count = Number(gridColumns[1]);
            const cell = Number(gridColumns[2]);
            const gap = Number(
                lowered.match(/\bgap\s*:\s*([0-9]+(?:\.[0-9]*)?)px/i)?.[1] ??
                    "0",
            );
            const width = count * cell + Math.max(0, count - 1) * gap;
            lowered = lowered
                .replace(/\bdisplay\s*:\s*grid\b/gi, "display:block")
                .replace(/\bgrid-template-columns\s*:[^;]+;?/gi, "")
                .replace(/\bgrid-template-rows\s*:[^;]+;?/gi, "")
                .replace(/\bgap\s*:[^;]+;?/gi, "")
                .replace(/\bjustify-content\s*:\s*center\s*;?/gi, "") +
                `;--bbl-grid-width:${width}px;--bbl-grid-gap:${gap}px;`;
        }

        if (/\bposition\s*:\s*absolute\b/i.test(lowered)) {
            const hasWidth = /(?:^|;)\s*width\s*:/i.test(lowered);
            const minimum = lowered.match(
                /(?:^|;)\s*min-width\s*:\s*([^;]+)/i,
            )?.[1]?.trim();
            if (!hasWidth && minimum) {
                // RmlUi cannot complete CSS shrink-to-fit when percentage-
                // width inline children contribute to an absolute block's
                // max-content size. Start from the authored minimum and leave
                // generic measurement metadata for the retained PAL pass.
                lowered +=
                    `;width:${minimum};` +
                    `--bbl-intrinsic-min-width:${minimum};`;
            } else if (
                !hasWidth &&
                !minimum &&
                !/\bdisplay\s*:/i.test(lowered) &&
                (/\bleft\s*:/i.test(lowered) !== /\bright\s*:/i.test(lowered))
            ) {
                lowered += ";display:inline-block;";
            }
        }
        if (
            /\bdisplay\s*:\s*(?:inline-)?flex\b/i.test(lowered) &&
            /\balign-items\s*:\s*center\b/i.test(lowered) &&
            /\bjustify-content\s*:\s*center\b/i.test(lowered) &&
            !/\bline-height\s*:/i.test(lowered)
        ) {
            const height = lowered.match(
                /(?:^|;)\s*height\s*:\s*([0-9]+(?:\.[0-9]*)?px)/i,
            )?.[1];
            if (height) {
                if (/\bdisplay\s*:\s*inline-flex\b/i.test(lowered)) {
                    // RmlUi does not synthesize the browser's anonymous flex
                    // item for direct text. An inline centred badge needs no
                    // flex distribution beyond that text, so an inline block
                    // with the equivalent line box preserves its layout.
                    lowered = lowered.replace(
                        /\bdisplay\s*:\s*inline-flex\b/gi,
                        "display:inline-block",
                    );
                }
                // RmlUi does not construct an anonymous flex item for a
                // direct text node. A centred fixed-height browser button
                // therefore needs the equivalent line box explicitly.
                lowered += `;line-height:${height};text-align:center;`;
            }
        }
        return lowered.replaceAll(
            Compiler.UI_MASKED_SEMICOLON,
            ";",
        );
    }

    /**
     * `@keyframes` blocks are not sheet rules: the whole sheet text also
     * rides `ui_set_text`, and the PAL extracts and projects the keyframes
     * from there (`pal_ui_rml.cpp` `keyframes_from`), so their interior
     * percentage blocks must not reach the rule parser. Mirrors the PAL's
     * brace-depth walk.
     */
    private static stripUiKeyframesBlocks(source: string): string {
        let result = "";
        let cursor = 0;
        for (;;) {
            const at = source.indexOf("@keyframes", cursor);
            if (at < 0) {
                result += source.slice(cursor);
                break;
            }
            result += source.slice(cursor, at);
            const opening = source.indexOf("{", at);
            if (opening < 0) break;
            let depth = 0;
            let end = opening;
            for (; end < source.length; end++) {
                if (source[end] === "{") {
                    depth++;
                } else if (source[end] === "}" && --depth === 0) {
                    end++;
                    break;
                }
            }
            cursor = end;
            if (depth !== 0) break;
        }
        return result;
    }

    /**
     * The reviewed `<style>` sheet surface (AP-4): exact `.class` and `#id`
     * rules, the audited `#id .class` descendant form, and `@keyframes`
     * blocks. A descendant rule is projected as a global class rule -- the
     * retained IR carries no scoped rules -- which is sound for the reached
     * sheets because they attach those classes only inside the id's own
     * subtree; the projection is recorded per scene in the
     * `substituted-ui-runtime` adaptation, and a second rule targeting the
     * same class with a different body refuses because the global merge
     * could not preserve the browser cascade. Any other selector refuses by
     * name instead of silently skipping.
     */
    private lowerUiStyleSheetLiteral(
        value: string,
        site?: ts.Node,
    ): Array<{
        kind: "class" | "id";
        name: string;
        style: string;
    }> {
        const rules: Array<{
            kind: "class" | "id";
            name: string;
            style: string;
        }> = [];
        const refuseSelector = (selector: string): never => {
            const message =
                `Retained stylesheet selector '${selector}' is not ` +
                "lowered: the reviewed sheet surface is exact '.class' " +
                "and '#id' rules, the '#id .class' descendant form " +
                "(projected as a global class rule), and '@keyframes' " +
                "blocks.";
            if (site) this.fail(site, message);
            this.failAtFile(message);
        };
        const source = Compiler.stripUiKeyframesBlocks(
            value.replace(/\/\*[\s\S]*?\*\//g, ""),
        );
        const blocks = /([^{}]+)\{([^{}]*)\}/g;
        for (let match = blocks.exec(source); match; match = blocks.exec(source)) {
            const style = this.lowerUiAttributeLiteral(
                "style",
                match[2]!.trim(),
                site,
            );
            for (const rawSelector of match[1]!.split(",")) {
                const selector = rawSelector.trim();
                const exact = selector.match(
                    /^([.#])([A-Za-z_][A-Za-z0-9_-]*)$/,
                );
                const descendant = selector.match(
                    /^#[A-Za-z_][A-Za-z0-9_-]*\s+\.([A-Za-z_][A-Za-z0-9_-]*)$/,
                );
                if (!exact && !descendant) refuseSelector(selector);
                const kind =
                    exact && exact[1] === "#" ? "id" : ("class" as const);
                const name = exact ? exact[2]! : descendant![1]!;
                const widened = descendant !== null;
                const key = `${kind}:${name}`;
                const previous = this.uiSheetRuleTargets.get(key);
                if (
                    previous &&
                    previous.style !== style &&
                    (previous.widened || widened)
                ) {
                    const message =
                        `Retained stylesheet selectors '${previous.selector}' ` +
                        `and '${selector}' both project onto the global ` +
                        `${kind} rule '${name}' with different bodies; the ` +
                        "widened projection cannot preserve the browser " +
                        "cascade between them.";
                    if (site) this.fail(site, message);
                    this.failAtFile(message);
                }
                this.uiSheetRuleTargets.set(key, {
                    selector,
                    style,
                    widened:
                        widened || (previous?.widened ?? false),
                });
                if (widened) this.uiWidenedSheetSelectors.add(selector);
                if (!style) continue;
                rules.push({ kind, name, style });
            }
        }
        return rules;
    }

    private compileUiStyleString(expression: ts.Expression): string {
        const staticValue = this.tryUiStaticString(expression);
        if (staticValue !== undefined) {
            return this.cppString(
                this.lowerUiAttributeLiteral(
                    "style",
                    staticValue,
                    expression,
                ),
            );
        }
        const unwrapped = this.unwrap(expression);
        if (ts.isConditionalExpression(unwrapped)) {
            return (
                `(${this.compileCondition(unwrapped.condition)} ? ` +
                `${this.compileUiStyleString(unwrapped.whenTrue)} : ` +
                `${this.compileUiStyleString(unwrapped.whenFalse)})`
            );
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken
        ) {
            const containsConditional = (node: ts.Expression): boolean => {
                const current = this.unwrap(node);
                return (
                    ts.isConditionalExpression(current) ||
                    (ts.isBinaryExpression(current) &&
                        current.operatorToken.kind ===
                            ts.SyntaxKind.PlusToken &&
                        (containsConditional(current.left) ||
                            containsConditional(current.right)))
                );
            };
            if (containsConditional(unwrapped)) {
                return (
                    `std::string(${this.compileUiStyleString(unwrapped.left)}) + ` +
                    this.compileUiStyleString(unwrapped.right)
                );
            }
        }
        const sourceParts = this.collectUiStringParts(unwrapped);
        if (sourceParts) {
            const substitutions: ts.Expression[] = [];
            let source = "";
            for (const part of sourceParts) {
                if (typeof part === "string") {
                    source += part;
                } else {
                    source += `__BBLITE_UI_STYLE_${substitutions.length}__`;
                    substitutions.push(part);
                }
            }
            const lowered = this.lowerUiAttributeLiteral(
                "style",
                source,
                expression,
            );
            const chunks = lowered.split(
                /(__BBLITE_UI_(?:STYLE|ASSET)_\d+__)/g,
            );
            const parts: string[] = [];
            for (const chunk of chunks) {
                if (!chunk) continue;
                const marker = chunk.match(
                    /^__BBLITE_UI_(STYLE|ASSET)_(\d+)__$/,
                );
                if (!marker) {
                    parts.push(this.cppString(chunk));
                    continue;
                }
                const substitution = this.uiTemplateSubstitutionCpp(
                    substitutions[Number(marker[2])]!,
                    "Native UI cssText",
                );
                parts.push(substitution);
            }
            this.reachJsData();
            return `bbl::js::concat(${parts.join(", ")})`;
        }
        this.fail(
            expression,
            "Native UI cssText must be a template or static fragments joined by string concatenation or a conditional.",
        );
    }

    private lowerUiMarkupLiteral(
        value: string,
        site?: ts.Node,
    ): string {
        // Elements parsed by SetInnerRML do not pass through the retained
        // record projector's tiny browser-UA defaults. Preserve HTML div
        // block flow directly in the bounded static markup we accept.
        let lowered = value
            .replace(
                /<(?:div|span)\s+style=(['"])(.*?)\1\s*>/gi,
                (match, quote, style) =>
                    match.toLowerCase().startsWith("<div")
                        ? `<div style=${quote}display:block;${this.lowerUiAttributeLiteral("style", String(style), site)}${quote}>`
                        : `<span style=${quote}${this.lowerUiAttributeLiteral("style", String(style), site)}${quote}>`,
            )
            .replace(/<div\s*>/gi, '<div style="display:block">');

        return lowered;
    }

    private compileUiMarkupString(expression: ts.Expression): string {
        const staticValue = this.tryUiStaticString(expression);
        if (staticValue !== undefined) {
            return this.cppString(
                this.lowerUiMarkupLiteral(staticValue, expression),
            );
        }
        const unwrapped = this.unwrap(expression);
        if (ts.isConditionalExpression(unwrapped)) {
            return (
                `(${this.compileCondition(unwrapped.condition)} ? ` +
                `${this.compileUiMarkupString(unwrapped.whenTrue)} : ` +
                `${this.compileUiMarkupString(unwrapped.whenFalse)})`
            );
        }
        const sourceParts = this.collectUiStringParts(unwrapped);
        if (!sourceParts) {
            this.fail(
                expression,
                "Native UI innerHTML must be a template or static fragments joined by string concatenation or a conditional.",
            );
        }
        const substitutions: ts.Expression[] = [];
        let source = "";
        for (const part of sourceParts) {
            if (typeof part === "string") {
                source += part;
            } else {
                source += `__BBLITE_UI_MARKUP_${substitutions.length}__`;
                substitutions.push(part);
            }
        }
        const lowered = this.lowerUiMarkupLiteral(source);
        const chunks = lowered.split(/(__BBLITE_UI_MARKUP_\d+__)/g);
        const parts: string[] = [];
        for (const chunk of chunks) {
            if (!chunk) continue;
            const marker = chunk.match(/^__BBLITE_UI_MARKUP_(\d+)__$/);
            if (!marker) {
                parts.push(this.cppString(chunk));
                continue;
            }
            parts.push(this.uiTemplateSubstitutionCpp(
                substitutions[Number(marker[1])]!,
                "Native UI innerHTML",
                true,
            ));
        }
        this.reachJsData();
        return `bbl::js::concat(${parts.join(", ")})`;
    }

    public emitUiPropertyAssignment(
        expression: ts.BinaryExpression,
    ): boolean {
        if (
            expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !ts.isPropertyAccessExpression(expression.left)
        ) {
            return false;
        }
        const property = expression.left.name.text;
        const directElement = this.uiElementValue(
            expression.left.expression,
        );
        if (directElement) {
            const engine = this.requireEngine(
                directElement,
                expression.left,
            );
            if (
                directElement.uiCanvas &&
                !directElement.uiCanvasContext &&
                (property === "width" || property === "height")
            ) {
                // The probe and the emission still compile the RHS twice:
                // collapsing them to one `castNumber(size, "double")` is
                // semantically clean, but the duplicate resolution burns
                // anonymous-record counter numbers, and removing it
                // renumbers quake's record types (Record22 -> Record18).
                // Byte identity of generated/ wins until a renumbering
                // window is open.
                const staticSize = this.compileValue(
                    expression.right,
                ).staticNumber;
                if (
                    staticSize !== undefined &&
                    directElement.uiCanvasId !== undefined
                ) {
                    const sizes = this.uiCanvasStaticSizes.get(
                        directElement.uiCanvasId,
                    ) ?? { pairs: new Set<string>() };
                    sizes[property] = staticSize;
                    if (
                        sizes.width !== undefined &&
                        sizes.height !== undefined
                    ) {
                        sizes.pairs.add(
                            `${sizes.width}x${sizes.height}`,
                        );
                    }
                    this.uiCanvasStaticSizes.set(
                        directElement.uiCanvasId,
                        sizes,
                    );
                }
                this.emit(
                    `bbl::ui_canvas_set_${property}(${engine}, ${directElement.cpp}, ` +
                        `${this.compileNumber(expression.right, "double")});`,
                );
                return true;
            }
            if (directElement.uiCanvasContext) {
                if (property === "fillStyle" || property === "strokeStyle") {
                    this.emit(
                        `bbl::ui_canvas_set_${property === "fillStyle" ? "fill_style" : "stroke_style"}(` +
                            `${engine}, ${directElement.cpp}, ` +
                            `${this.uiStringCpp(expression.right, `Canvas2D ${property}`)});`,
                    );
                    return true;
                }
                if (property === "lineWidth") {
                    this.emit(
                        `bbl::ui_canvas_set_line_width(${engine}, ${directElement.cpp}, ` +
                            `${this.compileNumber(expression.right, "double")});`,
                    );
                    return true;
                }
                if (property === "lineJoin" || property === "lineCap") {
                    this.emit(
                        `bbl::ui_canvas_set_${property === "lineJoin" ? "line_join" : "line_cap"}(` +
                            `${engine}, ${directElement.cpp}, ` +
                            `${this.uiStringCpp(expression.right, `Canvas2D ${property}`)});`,
                    );
                    return true;
                }
                if (property === "imageSmoothingEnabled") {
                    this.emit(
                        `bbl::ui_canvas_set_image_smoothing(${engine}, ${directElement.cpp}, ` +
                            `${this.compileBoolean(expression.right)});`,
                    );
                    return true;
                }
                if (
                    property === "font" ||
                    property === "textBaseline" ||
                    property === "shadowColor"
                ) {
                    const runtimeProperty =
                        property === "textBaseline"
                            ? "text_baseline"
                            : property === "shadowColor"
                              ? "shadow_color"
                              : "font";
                    this.emit(
                        `bbl::ui_canvas_set_${runtimeProperty}(${engine}, ${directElement.cpp}, ` +
                            `${this.uiStringCpp(expression.right, `Canvas2D ${property}`)});`,
                    );
                    return true;
                }
                if (property === "shadowBlur") {
                    this.emit(
                        `bbl::ui_canvas_set_shadow_blur(${engine}, ${directElement.cpp}, ` +
                            `${this.compileNumber(expression.right, "double")});`,
                    );
                    return true;
                }
            }
            if (property === "textContent" || property === "innerText") {
                if (
                    this.uiCreatedElementTag(
                        expression.left.expression,
                    ) === "style"
                ) {
                    const sheet = this.compileStringLiteral(expression.right);
                    for (const rule of this.lowerUiStyleSheetLiteral(
                        sheet,
                        expression.right,
                    )) {
                        this.emit(
                            `bbl::ui_add_${rule.kind}_style(${engine}, ` +
                                `${this.cppString(rule.name)}, ` +
                                `${this.cppString(rule.style)});`,
                        );
                    }
                }
                this.emit(
                    `bbl::ui_set_text(${engine}, ${directElement.cpp}, ` +
                        `${this.uiStringCpp(expression.right, `UI ${property}`)});`,
                );
                return true;
            }
            if (property === "innerHTML") {
                this.emit(
                    `bbl::ui_set_inner_rml(${engine}, ${directElement.cpp}, ` +
                        `${this.compileUiMarkupString(expression.right)});`,
                );
                return true;
            }
            const attribute =
                property === "className"
                    ? "class"
                    : property === "id" || property === "type"
                      ? property
                      : undefined;
            if (attribute) {
                this.emit(
                    `bbl::ui_set_attribute(${engine}, ${directElement.cpp}, ` +
                        `${this.cppString(attribute)}, ` +
                        `${this.uiStringCpp(expression.right, `UI ${property}`)});`,
                );
                return true;
            }
        }
        const style = this.unwrap(expression.left.expression);
        if (
            !ts.isPropertyAccessExpression(style) ||
            style.name.text !== "style"
        ) {
            return false;
        }
        if (
            property === "cursor" &&
            this.isCanvasElement(style.expression)
        ) {
            this.emit(
                `bbl::set_canvas_cursor(${this.requireDefaultEngine(expression)}, ` +
                    `${this.uiStringCpp(expression.right, "canvas style.cursor")});`,
            );
            return true;
        }
        const styleElement = this.uiElementValue(style.expression);
        if (!styleElement) return false;
        const engine = this.requireEngine(styleElement, expression.left);
        if (property === "cssText") {
            this.emit(
                `bbl::ui_set_attribute(${engine}, ${styleElement.cpp}, ` +
                    `${this.cppString("style")}, ${this.compileUiStyleString(expression.right)});`,
            );
            return true;
        }
        const nativeProperty = this.nativeUiStyleProperty(property);
        this.auditUiStylePropertyName(nativeProperty, expression.left.name);
        this.emit(
            `bbl::ui_set_style_property(${engine}, ${styleElement.cpp}, ` +
                `${this.cppString(nativeProperty)}, ` +
                `${this.uiStringCpp(expression.right, `UI style.${property}`)});`,
        );
        return true;
    }

    public compileValue(expression: ts.Expression): Value {
        const value = this.expressions.compileValue(expression);
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
            if (strings) return { ...value, staticStrings: strings };
        }
        return value;
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
                const nested = this.staticStringElements(
                    element.expression,
                );
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
    private constArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined {
        const unwrapped = this.unwrap(expression);
        if (!ts.isIdentifier(unwrapped)) return undefined;
        const declarations =
            this.symbols.valueSymbol(unwrapped)?.declarations ?? [];
        const declaration = declarations.length === 1
            ? declarations[0]!
            : undefined;
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
                mutates: (node, scan) =>
                    this.writesThroughArray(node, scan),
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
        return browserGeneratedString(this.checker, call, (argument) =>
            this.foldGeneratedStringArgument(argument),
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

    public compilePropertyAccess(expression: ts.PropertyAccessExpression): Value {
        if (
            expression.questionDotToken &&
            expression.name.text === "direction" &&
            ts.isPropertyAccessExpression(
                this.unwrap(expression.expression),
            )
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
        const ownerExpression = this.unwrap(
            expression.expression,
        );
        const enumMember = this.enumMemberValue(
            expression,
        );
        if (enumMember) {
            return enumMember;
        }
        const staticField =
            this.classLowerer.resolveStaticField(expression);
        if (staticField?.initializer) {
            return this.compileValue(staticField.initializer);
        }
        if (
            ts.isPropertyAccessExpression(ownerExpression) &&
            ownerExpression.name.text === "style"
        ) {
            const element = this.uiElementValue(ownerExpression.expression);
            if (element) {
                const engine = this.requireEngine(element, expression);
                const property = this.nativeUiStyleProperty(
                    expression.name.text,
                );
                this.auditUiStylePropertyName(
                    property,
                    expression.name,
                );
                return {
                    kind: "string",
                    cpp: `bbl::ui_get_style_property(${engine}, ${element.cpp}, ${this.cppString(property)})`,
                };
            }
        }
        if (
            expression.name.text === "body" &&
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
            const property = expression.name.text === "innerWidth"
                ? "width"
                : "height";
            return {
                kind: "number",
                cpp:
                    `static_cast<double>(${this.requireDefaultEngine(expression)}` +
                    `.options.${property})`,
                dataType: { kind: "number" },
            };
        }
        if (
            ownerExpression.kind ===
            ts.SyntaxKind.ThisKeyword
        ) {
            // Field reads resolve through the instance record the
            // constructor built.
            const instance = this.compileValue(ownerExpression);
            const field =
                instance.recordProperties?.[
                    expression.name.text
                ];
            if (!field) {
                const accessor =
                    instance.recordGetters?.[
                        expression.name.text
                    ];
                if (accessor) {
                    return this.compileRecordGetter(
                        instance,
                        accessor,
                    );
                }
                this.fail(
                    expression,
                    `Field '${expression.name.text}' is not assigned before this read.`,
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
        // Through compileValue rather than lookup: a module-level
        // constant is never bound in a variable scope, so it resolves
        // through its own initializer the way an entry-scope constant
        // resolves through its binding, and a property-access owner
        // resolves by recursing here, so `camera.ortho.halfHeight` reads
        // as the path it is written as. Unknown identifiers still fail
        // in lookup at the end of that chain, and an owner that is
        // itself unsupported fails naming the sub-path that failed.
        const owner = this.compileValue(ownerExpression);
        const property = expression.name.text;
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
                            : property === "clientX" || property === "offsetX"
                              ? `${owner.cpp}.client_x`
                            : property === "clientY" || property === "offsetY"
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
            const axis = property === "width" || property === "height"
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
        const fetchedProperty = staticFetchProperty(
            owner,
            property,
        );
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
            let size = property === "width"
                ? owner.textureWidth
                : owner.textureHeight;
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
                    size = property === "width"
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
        if (
            owner.kind === "sprite-renderer" &&
            property === "layers"
        ) {
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
            if (accessor) {
                return this.compileRecordGetter(
                    owner,
                    accessor,
                );
            }
            const value =
                owner.recordProperties?.[property];
            if (!value) {
                const declared =
                    this.dataLowerer.dataTypeAt(expression);
                if (declared?.kind === "optional") {
                    // Object literals omit optional fields entirely. A
                    // compile-time record preserves that absence as the
                    // nullish value consumed by `??` and equality guards.
                    return { kind: "json-null", cpp: "" };
                }
                const method =
                    owner.recordMethods?.[property];
                if (method) {
                    return {
                        kind: "callback",
                        cpp: "",
                        callbackDeclaration: method,
                        callbackRecordOwner: owner,
                    };
                }
                this.fail(
                    expression,
                    `Static record has no property '${property}' ` +
                        `(fields: ${Object.keys(owner.recordProperties ?? {}).join(", ") || "none"}; ` +
                        `getters: ${Object.keys(owner.recordGetters ?? {}).join(", ") || "none"}; ` +
                        `class: ${owner.classDeclaration?.name?.text ?? "none"}).`,
                );
            }
            if (owner.optionalFoundCpp === undefined) {
                return value;
            }
            const present =
                value.optionalFoundCpp === undefined
                    ? owner.optionalFoundCpp
                    : `(${owner.optionalFoundCpp} && ${value.optionalFoundCpp})`;
            return { ...value, optionalFoundCpp: present };
        }
        const resolved = this.readOwnerProperty(owner, expression);
        if (resolved) {
            if (
                expression.questionDotToken &&
                owner.optionalFoundCpp !== undefined
            ) {
                const present =
                    resolved.optionalFoundCpp === undefined
                        ? owner.optionalFoundCpp
                        : `(${owner.optionalFoundCpp} && ${resolved.optionalFoundCpp})`;
                return { ...resolved, optionalFoundCpp: present };
            }
            return resolved;
        }
        return (
            this.fail(
                expression,
                `Unsupported property value '${this.propertyPathForDiagnostic(expression)}' (owner ${owner.kind} ${owner.dataType ? JSON.stringify(owner.dataType) : "without data type"}).`,
            )
        );
    }

    private enumMemberValue(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const constant =
            this.checker.getConstantValue(expression);
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

    public compileRegisteredConstant(
        importedName: string,
    ): Value | undefined {
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
        return compileStaticFetchMethod(
            this,
            call,
            owner,
            method,
        );
    }

    public compileRegisteredIntrinsic(
        importedName: string,
        call: ts.CallExpression,
    ): Value | undefined {
        return compileRegisteredIntrinsic(
            this,
            importedName,
            call,
        );
    }

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
            declaration.parameters.length !== 3 ||
            !declaration.parameters.every(({ name }) =>
                ts.isIdentifier(name),
            )
        ) {
            return undefined;
        }
        const [meshParameter, bufferParameter, countParameter] =
            declaration.parameters.map(({ name }) =>
                (name as ts.Identifier).text,
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
        const mesh = this.compileValue(call.arguments[0]!);
        this.expectKind(mesh, "mesh", call.arguments[0]!);
        const matrices = this.compileTypedArrayArgument(
            call.arguments[1]!,
            "f32array",
        );
        const count = this.compileNumber(call.arguments[2]!);
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
        const destination = this.unwrap(call.arguments[0]!);
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
        if (
            texture.kind !== "texture" ||
            texture.textureStorage !== "pixels"
        ) {
            this.fail(
                textureMember.expression,
                "GPUQueue.writeTexture currently updates createTexture2DFromPixels results.",
            );
        }
        const pixelValue = this.compileValue(call.arguments[1]!);
        if (
            pixelValue.kind !== "data" ||
            pixelValue.dataType?.kind !== "u8array"
        ) {
            this.fail(
                call.arguments[1]!,
                "GPUQueue.writeTexture source must be a Uint8Array.",
            );
        }
        this.reachFeature("texture:pixels", call);
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
        const dirtyFields = new Set<string>();
        const visit = (node: ts.Node): void => {
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
                const source = node.arguments[2]!;
                const offset = node.arguments[3]!;
                const size = node.arguments[4]!;
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
                ["_version", "_dirtyMin", "_dirtyMax"].includes(
                    node.name.text,
                )
            ) {
                dirtyFields.add(node.name.text);
            }
            ts.forEachChild(node, visit);
        };
        visit(body);
        return (
            thinInstancesRead &&
            directUpload &&
            dirtyFields.size === 3
        );
    }

    public compileBoxOptions(
        expression: ts.Expression,
    ): [string, string, string] {
        return compileBoxOptions(this, expression);
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

    public compilePostProcessTaskOptions(
        intrinsic: string,
        expression: ts.Expression,
        shaderIndex: number,
    ): CompiledPostProcessTask {
        return compilePostProcessTaskOptions(
            this,
            intrinsic,
            expression,
            shaderIndex,
        );
    }

    public compilePostProcessCompositeOptions(
        intrinsic: string,
        expression: ts.Expression,
        compositeIndex: number,
    ): CompiledPostProcessComposite {
        return compilePostProcessCompositeOptions(
            this,
            intrinsic,
            expression,
            compositeIndex,
        );
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

    public compileShaderMaterialOptions(
        expression: ts.Expression,
    ): {
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
        if (
            this.selectedToneMapping &&
            this.selectedToneMapping !== name
        ) {
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
        return resolveShaderTextureSlot(
            this,
            material,
            nameExpression,
        );
    }

    public compileShaderUniformComponents(
        expression: ts.Expression,
        count: number,
    ): string[] {
        return compileShaderUniformComponents(
            this,
            expression,
            count,
        );
    }

    public compilePropertyAnimationClip(
        nameExpression: ts.Expression,
        tracksExpression: ts.Expression,
        optionsExpression: ts.Expression | undefined,
    ): {
        cpp: string;
        frameRate: string;
        duration: string;
        target: "mesh" | "camera";
    } {
        return compilePropertyAnimationClip(
            this,
            nameExpression,
            tracksExpression,
            optionsExpression,
        );
    }

    public compilePropertyAnimationGroupOptions(
        expression: ts.Expression | undefined,
        clip: Value,
    ): string {
        return compilePropertyAnimationGroupOptions(
            this,
            expression,
            clip,
        );
    }

    public expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression {
        return this.evaluator.expectStaticArrayLiteral(
            expression,
        );
    }

    public compileEnvironmentOptions(expression: ts.Expression): {
        groundTextureUrl: string;
        skyboxUrl: string;
        skyboxSize: string;
        brdfUrl: string;
        skipSkybox: boolean;
        skipGround: boolean;
    } {
        return compileEnvironmentOptions(this, expression);
    }

    public compileDdsEnvironmentOptions(
        expression: ts.Expression,
    ): string {
        return compileDdsEnvironmentOptions(this, expression);
    }

    public compileDdsEnvironmentBackgroundOptions(
        expression: ts.Expression,
    ): {
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

    public isDefaultLibraryIdentifier(
        identifier: ts.Identifier,
    ): boolean {
        const declarations =
            this.symbols.valueSymbol(identifier)?.declarations;
        return declarations?.some((declaration) =>
            this.program.isSourceFileDefaultLibrary(
                declaration.getSourceFile(),
            ),
        ) ?? false;
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
                        const signatures =
                            propertyType.getCallSignatures();
                        return (
                            signatures.length > 0 &&
                            signatures.every(
                                (signature) =>
                                    (this.checker
                                        .getReturnTypeOfSignature(
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
                        const declaration = property.valueDeclaration ??
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
            const visit = (node: ts.Node): void => {
                if (ts.isTypeNode(node)) {
                    return;
                }
                if (ts.isIdentifier(node)) {
                    if (
                        this.symbols.importedName(node) !==
                        undefined
                    ) {
                        reachesBabylon = true;
                    }
                    if (
                        ["document", "window", "globalThis"].includes(
                            node.text,
                        ) &&
                        this.isDefaultLibraryIdentifier(node)
                    ) {
                        reachesBrowser = true;
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(declaration.body);
            if (reachesBrowser && !reachesBabylon) {
                return true;
            }
        }
        const hasBrowserInput = call.arguments.some((argument) =>
            this.isBrowserOnlyExpression(argument),
        );
        const returnsVoid =
            (observableResult.flags & ts.TypeFlags.Void) !== 0;
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
        const declaration = this.checker.getResolvedSignature(call)
            ?.declaration;
        if (
            !declaration ||
            (!ts.isFunctionDeclaration(declaration) &&
                !ts.isMethodDeclaration(declaration) &&
                !ts.isFunctionExpression(declaration) &&
                !ts.isArrowFunction(declaration)) ||
            !declaration.body
        ) {
            return false;
        }
        let reached = false;
        const visit = (node: ts.Node): void => {
            if (reached) return;
            if (ts.isCallExpression(node)) {
                const callee = this.unwrap(node.expression);
                if (
                    ts.isPropertyAccessExpression(callee) &&
                    callee.name.text === "createElement" &&
                    ts.isIdentifier(callee.expression) &&
                    callee.expression.text === "document" &&
                    this.isDefaultLibraryIdentifier(callee.expression)
                ) {
                    const tag = node.arguments[0];
                    if (
                        tag &&
                        (ts.isStringLiteral(tag) ||
                            ts.isNoSubstitutionTemplateLiteral(tag)) &&
                        tag.text.toLowerCase() !== "canvas"
                    ) {
                        reached = true;
                        return;
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration.body);
        return reached;
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
        const declaration = target?.declarations?.find(
            ts.isClassDeclaration,
        );
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
            !(concrete[0]!.symbol?.declarations ?? []).includes(
                declaration,
            )
        ) {
            return false;
        }

        const isPrivateOrProtected = (member: ts.ClassElement): boolean =>
            (ts.getCombinedModifierFlags(member) &
                (ts.ModifierFlags.Private |
                    ts.ModifierFlags.Protected)) !==
            0;
        const isStatic = (member: ts.ClassElement): boolean =>
            (ts.getCombinedModifierFlags(member) &
                ts.ModifierFlags.Static) !==
            0;
        const domOwned = declaration.members.some(
            (member) =>
                ts.isPropertyDeclaration(member) &&
                this.typeComesFromDom(
                    this.checker.getTypeAtLocation(member),
                ),
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

        const publicSurfaceIsWriteOnly = declaration.members.every(
            (member) => {
                if (
                    isStatic(member) ||
                    isPrivateOrProtected(member) ||
                    ts.isConstructorDeclaration(member)
                ) {
                    return true;
                }
                if (!ts.isMethodDeclaration(member)) return false;
                const signature =
                    this.checker.getSignatureFromDeclaration(member);
                return (
                    signature !== undefined &&
                    (this.checker.getReturnTypeOfSignature(signature)
                        .flags &
                        ts.TypeFlags.Void) !==
                        0
                );
            },
        );
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
        const visit = (node: ts.Node): void => {
            if (reachesBabylon) return;
            if (
                ts.isIdentifier(node) &&
                this.symbols.importedName(node) !== undefined
            ) {
                reachesBabylon = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
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
            ts.isIdentifier(unwrapped) ||
            ts.isElementAccessExpression(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped)
        ) {
            const value = this.compileValue(unwrapped);
            if (
                value.kind === "data" &&
                value.dataType?.kind === "struct"
            ) {
                return this.vec3FromRecord(
                    value,
                    unwrapped,
                    precision,
                );
            }
        }
        return this.evaluator.compileVec3(
            expression,
            precision,
        );
    }

    public vec3FromRecord(
        value: Value,
        node: ts.Node,
        precision: "float" | "double" = "float",
    ): string {
        if (
            value.kind === "data" &&
            value.dataType?.kind === "struct"
        ) {
            const type =
                precision === "float"
                    ? "bbl::Vec3"
                    : "bbl::Vec3d";
            const arrow = this.dataTypes.isReferenceStruct(
                value.dataType.name,
            )
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
        return this.evaluator.vec3FromRecord(
            value,
            node,
            precision,
        );
    }

    /** One number Value at one sink's width — the rule, in one place. */
    public castNumber(
        value: Value,
        precision: "float" | "double",
    ): string {
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
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.BarBarToken)
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
            let right: string;
            if (left === identity) {
                right = this.compileCondition(unwrapped.right);
            } else {
                this.enterRuntimeControlFlow();
                try {
                    right = this.compileCondition(unwrapped.right);
                } finally {
                    this.leaveRuntimeControlFlow();
                }
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
            const isPointerLockElement = (
                operand: ts.Expression,
            ): boolean => {
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
            const condition =
                this.evaluateBrowserCondition(unwrapped);
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
                        this.evaluateBrowserValue(operand)?.kind ===
                        "number",
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
        if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.ExclamationToken) {
            const operand = this.compileCondition(unwrapped.operand);
            if (operand === "true") return "false";
            if (operand === "false") return "true";
            return `!(${operand})`;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            if (
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.InstanceOfKeyword &&
                ts.isIdentifier(unwrapped.right) &&
                !this.lookupOptional(unwrapped.right)
            ) {
                const expected = new Map<string, string>([
                    ["ArrayBuffer", "arraybuffer"],
                    ["DataView", "dataview"],
                    ["Uint8Array", "u8array"],
                    ["Uint16Array", "u16array"],
                    ["Int16Array", "i16array"],
                    ["Uint32Array", "u32array"],
                    ["Int32Array", "i32array"],
                    ["Float64Array", "f64array"],
                    ["Float32Array", "f32array"],
                ]).get(unwrapped.right.text);
                if (expected) {
                    const value = this.compileValue(
                        unwrapped.left,
                    );
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
                this.handleCollections.compileHandleEquality(
                    unwrapped,
                );
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
                if (value.kind === "boolean") {
                    return value.cpp;
                }
                this.fail(
                    unwrapped.operatorToken,
                    "'??' in a condition must select a boolean, " +
                        `received ${value.kind}.`,
                );
            }
            const operator = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
                [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!="],
                [ts.SyntaxKind.LessThanToken, "<"],
                [ts.SyntaxKind.LessThanEqualsToken, "<="],
                [ts.SyntaxKind.GreaterThanToken, ">"],
                [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
            ]).get(unwrapped.operatorToken.kind);
            if (!operator) {
                if (
                    this.evaluator.isNumberExpression(
                        unwrapped,
                    )
                ) {
                    this.reachJsData();
                    return `bbl::js::number_truthy(${this.compileNumber(unwrapped, "double")})`;
                }
                this.fail(
                    unwrapped.operatorToken,
                    "Reached callback conditions support numeric comparisons and logical operators.",
                );
            }
            const leftValue = this.compileValue(
                unwrapped.left,
            );
            const rightValue = this.compileValue(
                unwrapped.right,
            );
            const staticLeft =
                leftValue.kind === "number" &&
                !leftValue.parameterBinding
                    ? leftValue.staticNumber
                    : undefined;
            const staticRight =
                rightValue.kind === "number" &&
                !rightValue.parameterBinding
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
                (value.kind === "data" &&
                    value.dataType?.kind === "string");
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
                staticLeft !== undefined &&
                staticRight !== undefined &&
                Number.isFinite(staticLeft) &&
                Number.isFinite(staticRight)
            ) {
                const folded = new Map<ts.SyntaxKind, boolean>([
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
            ts.isIdentifier(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
        ) {
            const data =
                this.dataLowerer.conditionOperand(
                    unwrapped,
                );
            if (data) {
                return data;
            }
        }
        if (ts.isCallExpression(unwrapped)) {
            const value = this.compileValue(unwrapped);
            if (value.kind === "boolean") {
                return value.cpp;
            }
            if (value.truthinessCpp !== undefined) {
                return value.truthinessCpp;
            }
            if (value.optionalFoundCpp !== undefined) {
                return value.optionalFoundCpp;
            }
            if (
                value.kind === "data" &&
                value.dataType?.kind === "optional"
            ) {
                return `${value.cpp}.has_value()`;
            }
            this.fail(
                unwrapped,
                `Condition call must produce a boolean, received ${value.kind}.`,
            );
        }
        if (
            unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
            unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
            ts.isIdentifier(unwrapped)
        ) {
            if (ts.isIdentifier(unwrapped)) {
                const value =
                    this.lookupOptional(unwrapped);
                if (value?.kind === "callback") {
                    return "true";
                }
                if (value?.kind === "json-null") {
                    return "false";
                }
                if (value?.kind === "ui-element") {
                    return value.truthinessCpp ?? "true";
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
            if (
                value.kind === "boolean" ||
                (value.kind === "data" &&
                    value.dataType?.kind === "boolean")
            ) {
                return value.cpp;
            }
            if (value.truthinessCpp !== undefined) {
                return value.truthinessCpp;
            }
            if (value.optionalFoundCpp !== undefined) {
                return value.optionalFoundCpp;
            }
            if (
                value.kind === "data" &&
                value.dataType?.kind === "optional"
            ) {
                return `${value.cpp}.has_value()`;
            }
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

    public meshTransformDirtyEntry():
        | "mark_mesh_dirty"
        | "mark_mesh_runtime_transform" {
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
                    return `[&]() { ${bound.cpp}(); }`;
                }
                this.fail(
                    unwrapped,
                    "A named deferred callback must resolve to a native zero-argument function.",
                );
            }
            return this.compileNamedFrameCallback(
                unwrapped,
                signature,
            );
        }
        if (!ts.isArrowFunction(unwrapped) && !ts.isFunctionExpression(unwrapped)) {
            this.fail(unwrapped, "onBeforeRender requires an inline callback.");
        }
        if (unwrapped.parameters.length > 1) {
            this.fail(unwrapped, "onBeforeRender callback supports at most one deltaMs parameter.");
        }
        if (
            (signature === "void" || signature === "interval") &&
            unwrapped.parameters.length > 0
        ) {
            this.fail(
                unwrapped,
                "A timer callback takes no parameters.",
            );
        }

        const parameter = unwrapped.parameters[0];
        if (parameter && !ts.isIdentifier(parameter.name)) {
            this.fail(parameter.name, "onBeforeRender deltaMs parameter must be an identifier.");
        }
        const parameterName = parameter && ts.isIdentifier(parameter.name)
            ? parameter.name.text
            : undefined;

        const start = this.body.length;
        const previousIndent = this.indentLevel;
        this.indentLevel = 0;
        // Everything the outermost frame callback pushes lives on its own
        // stack frame; a deferred body may not reach into it.
        const previousFrameFloor = this.frameCallbackScopeFloor;
        if (this.frameCallbackDepth === 0) {
            this.frameCallbackScopeFloor =
                this.variableScopes.length;
        }
        const previousDeferredFloor = this.deferredCaptureFloor;
        const previousDeferredCeiling = this.deferredCaptureCeiling;
        this.deferredCaptureFloor =
            signature === "void" || signature === "interval"
            ? this.frameCallbackScopeFloor
            : undefined;
        this.deferredCaptureCeiling =
            this.deferredCaptureFloor === undefined
                ? undefined
                : this.variableScopes.length;
        this.pushScope(
            this.cppNamePrefixes.at(-1) ?? "",
        );
        // This body is emitted into a real native callback lambda. A source
        // `return` therefore leaves that lambda directly, including when it
        // guards statements later in the callback; it is not an inlined
        // function return that needs the breakable wrapper path.
        this.beginNativeFunctionBody(undefined, true);
        try {
            if (
                parameter &&
                ts.isIdentifier(parameter.name)
            ) {
                this.defineVariable(parameter.name, {
                    kind: "number",
                    cpp: this.cppIdentifier(
                        parameter.name.text,
                    ),
                });
            }
            this.frameCallbackDepth += 1;
            // A concise arrow body is one expression whose value the
            // pinned callback contract discards, so it lowers as the
            // statement it would have been written as.
            if (ts.isBlock(unwrapped.body)) {
                for (const statement of unwrapped.body
                    .statements) {
                    this.emitStatement(statement);
                }
            } else {
                this.emitExpressionAsStatement(
                    unwrapped.body,
                );
            }
        } finally {
            this.endNativeFunctionBody();
            this.frameCallbackDepth -= 1;
            this.popScope();
            this.deferredCaptureFloor = previousDeferredFloor;
            this.deferredCaptureCeiling = previousDeferredCeiling;
            this.frameCallbackScopeFloor = previousFrameFloor;
            this.indentLevel = previousIndent;
        }
        const callbackBody = this.body.splice(start);
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
                `${this.cppIdentifier(parameterName)}`
            : signature === "timestamp" ? "double" : "float";
        const lambdaParameter =
            signature === "void" || signature === "interval"
                ? ""
                : cppParameter;
        return `[&](${lambdaParameter}) {\n${callbackBody.map((line) => `            ${line}`).join("\n")}\n        }`;
    }

    /** A retained zero-argument callback with the same capture checks as timers. */
    public compileVoidCallback(expression: ts.Expression): string {
        return this.compileFrameCallback(expression, "void");
    }

    private compileNamedFrameCallback(
        identifier: ts.Identifier,
        signature: Exclude<FrameCallbackSignature, "void">,
    ): string {
        const start = this.body.length;
        const previousIndent = this.indentLevel;
        this.indentLevel = 0;
        const parameter = signature === "interval"
            ? undefined
            : this.allocateTemporaryCppName("frame_callback_value");
        const previousDeferredFloor = this.deferredCaptureFloor;
        const previousDeferredCeiling = this.deferredCaptureCeiling;
        if (signature === "interval") {
            this.deferredCaptureFloor = this.frameCallbackScopeFloor;
            this.deferredCaptureCeiling =
                this.deferredCaptureFloor === undefined
                    ? undefined
                    : this.variableScopes.length;
        }
        this.frameCallbackDepth += 1;
        try {
            const value = this.compileCallbackWithValues(
                identifier,
                parameter
                    ? [{ kind: "number", cpp: parameter }]
                    : [],
                identifier,
            );
            if (value.cpp.length > 0) {
                this.emit(`${value.cpp};`);
            }
        } finally {
            this.frameCallbackDepth -= 1;
            this.deferredCaptureFloor = previousDeferredFloor;
            this.deferredCaptureCeiling = previousDeferredCeiling;
            this.indentLevel = previousIndent;
        }
        const callbackBody = this.body.splice(start);
        const lambdaParameter = parameter
            ? `[[maybe_unused]] ${signature === "timestamp" ? "double" : "float"} ${parameter}`
            : "";
        return `[&](${lambdaParameter}) {\n${callbackBody
            .map((line) => `            ${line}`)
            .join("\n")}\n        }`;
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
        return this.evaluator.compileNumber(
            expression,
            precision,
        );
    }

    public compileEnumSwitchLabel(
        expression: ts.Expression,
        dataType: DataType & { kind: "enum" },
    ): string | undefined {
        const literal = this.evaluator.staticTextValue(
            expression,
        );
        if (literal === undefined) {
            this.fail(
                expression,
                "Enum switch case labels must be compile-time strings.",
            );
        }
        return this.dataTypes
            .enumMembers(dataType.name)
            .includes(literal)
            ? this.dataTypes.enumMemberCpp(
                  dataType,
                  literal,
                  expression,
              )
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
    public expectObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression {
        const resolved = this.evaluator.resolveStaticExpression(expression);
        if (!ts.isObjectLiteralExpression(resolved)) {
            this.fail(resolved, "Expected an object literal.");
        }
        return resolved;
    }

    public objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
        for (const property of object.properties) {
            if (ts.isPropertyAssignment(property) && this.propertyName(property.name) === name) {
                return property.initializer;
            }
            if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
                return property.name;
            }
        }
        return undefined;
    }

    public propertyName(name: ts.PropertyName): string | undefined {
        if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
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
            ts.isElementAccessExpression(unwrapped)
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
            const generated =
                this.bakedBrowserGeneratedString(resolved);
            if (generated !== undefined) return generated;
            const callee = this.unwrap(resolved.expression);
            if (ts.isIdentifier(callee)) {
                const declaration = resolveFunctionDeclaration(
                    this.checker,
                    callee,
                    (node, message) => this.fail(node, message),
                );
                const body = declaration?.body;
                const onlyStatement = body && ts.isBlock(body)
                    ? body.statements[0]
                    : undefined;
                const returned = body && !ts.isBlock(body)
                    ? body
                    : body && ts.isBlock(body) && body.statements.length === 1 &&
                        onlyStatement && ts.isReturnStatement(onlyStatement)
                      ? onlyStatement.expression
                      : undefined;
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
                    const arguments_ = resolved.arguments.map((argument) =>
                        this.compileValue(
                            this.alwaysUsedParameterDefault(argument) ??
                                argument,
                        ));
                    const value = declaration &&
                        !ts.isFunctionDeclaration(declaration)
                        ? this.userFunctions.compileCallbackWithValues(
                              this,
                              declaration,
                              arguments_,
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
        const candidates = new Set<string>();
        const visit = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                node.arguments.length === 2 &&
                (ts.isStringLiteral(node.arguments[0]!) ||
                    ts.isNoSubstitutionTemplateLiteral(
                        node.arguments[0]!,
                    ))
            ) {
                const url = this.moduleRelativeAssetUrl(node);
                if (url !== undefined) candidates.add(url);
            }
            ts.forEachChild(node, visit);
        };
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
        const parameter = symbol?.valueDeclaration &&
            ts.isParameter(symbol.valueDeclaration)
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
              ? owner.parent && ts.isVariableDeclaration(owner.parent) &&
                    ts.isIdentifier(owner.parent.name)
                  ? owner.parent.name
                  : undefined
              : undefined;
        const ownerSymbol = ownerName
            ? this.symbols.valueSymbol(ownerName)
            : undefined;
        const visit = (candidate: ts.Node): void => {
            if (passedExplicitly) return;
            if (
                ts.isCallExpression(candidate) &&
                (this.checker.getResolvedSignature(candidate)?.declaration ===
                    owner ||
                    (ownerSymbol !== undefined &&
                        ts.isIdentifier(this.unwrap(candidate.expression)) &&
                        this.symbols.valueSymbol(
                            this.unwrap(candidate.expression) as ts.Identifier,
                        ) === ownerSymbol))
            ) {
                reachedCall = true;
                if (candidate.arguments.length > index) {
                    passedExplicitly = true;
                    return;
                }
            }
            ts.forEachChild(candidate, visit);
        };
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
            !this.isImportMetaUrl(resolved.arguments[1]!)
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
        if (ts.isTemplateExpression(resolved.arguments[0]!)) {
            return undefined;
        }
        const path = this.evaluator.compileStringLiteral(
            resolved.arguments[0]!,
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
            !this.isImportMetaUrl(resolved.arguments[1]!)
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
        const path = this.unwrap(resolved.arguments[0]!);
        if (
            !ts.isTemplateExpression(path) ||
            path.templateSpans.length !== 1 ||
            path.templateSpans[0]!.literal.text.length !== 0
        ) {
            return undefined;
        }
        const suffix = this.compileValue(
            path.templateSpans[0]!.expression,
        );
        if (
            suffix.kind !== "string" &&
            !(
                suffix.kind === "data" &&
                suffix.dataType?.kind === "string"
            )
        ) {
            return undefined;
        }
        const url = new URL(
            path.head.text,
            "https://bblite.invalid/",
        );
        for (const [search, replacement] of replacements) {
            url.pathname = url.pathname.replace(search, replacement);
        }
        const prefix =
            url.origin === "https://bblite.invalid"
                ? `${url.pathname}${url.search}${url.hash}`
                : url.href;
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
            declaration.initializer.arguments?.length !== 2 ||
            !ts.isIdentifier(declaration.initializer.arguments[0]!) ||
            declaration.initializer.arguments[0]!.text !== pathParameter ||
            !ts.isIdentifier(declaration.initializer.arguments[1]!) ||
            declaration.initializer.arguments[1]!.text !== moduleParameter
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
                call.arguments.length !== 2 ||
                !ts.isStringLiteralLike(call.arguments[0]!) ||
                !ts.isStringLiteralLike(call.arguments[1]!)
            ) {
                return undefined;
            }
            replacements.push([
                call.arguments[0]!.text,
                call.arguments[1]!.text,
            ]);
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
            this.symbols.importedName(unwrapped.expression) !==
                importedName
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
            const options = this.expectObjectLiteral(
                call.arguments[1],
            );
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
            const samples = this.objectProperty(
                options,
                "msaaSamples",
            );
            if (samples) {
                const staticSamples =
                    selectedStaticNumberValue(this, samples);
                if (staticSamples !== 1 && staticSamples !== 4) {
                    this.fail(
                        samples,
                        "Native engine lowering supports explicit msaaSamples: 1 or 4 only.",
                    );
                }
                msaaSamples = staticSamples;
                this.engineMsaaSamples = staticSamples;
            }
            const limits = this.objectProperty(
                options,
                "requiredLimits",
            );
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
        this.emit(
            `auto ${cppName} = bbl::create_engine(bbl::EngineOptions{${this.cppString(this.options.title)}, ${this.options.width}, ${this.options.height}});`,
        );
        this.engineCreationInsertion = this.body.length;
        this.defaultEngineCpp = cppName;
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
            cpp: cppName,
            engineCpp: cppName,
            msaaSamples,
        };
    }

    public allocateTemporaryCppName(label: string): string {
        while (true) {
            const candidate =
                `v_bblite_${label}_${this.temporaryIndex++}`;
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
    public compileShaderSource(expression: ts.Expression): {
        source: string;
        dynamicUniforms: Array<{
            name: string;
            type: "f32";
            components: string[];
        }>;
    } {
        const resolved = this.resolveStaticExpression(expression);
        if (
            !ts.isCallExpression(resolved) ||
            !ts.isIdentifier(this.unwrap(resolved.expression))
        ) {
            return {
                source: this.compileStaticString(expression),
                dynamicUniforms: [],
            };
        }
        const callee = this.unwrap(resolved.expression) as ts.Identifier;
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
            const parameters = new Map<string, ShaderTextBinding>();
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
        if (
            !declaration ||
            !body ||
            ts.isBlock(body) ||
            !ts.isTemplateExpression(body) ||
            body.templateSpans.length !== 1
        ) {
            return {
                source: this.compileStaticString(expression),
                dynamicUniforms: [],
            };
        }
        const span = body.templateSpans[0]!;
        const formatted = this.unwrap(span.expression);
        if (
            !ts.isCallExpression(formatted) ||
            !ts.isPropertyAccessExpression(formatted.expression) ||
            !PURE_NUMBER_FORMATTERS.has(
                formatted.expression.name.text,
            ) ||
            !ts.isIdentifier(formatted.expression.expression)
        ) {
            return {
                source: this.compileStaticString(expression),
                dynamicUniforms: [],
            };
        }
        const formatter = formatted.expression;
        const parameterIndex = declaration.parameters.findIndex(
            ({ name }) =>
                ts.isIdentifier(name) &&
                this.symbols.valueSymbol(name) ===
                    this.symbols.valueSymbol(
                        formatter.expression as ts.Identifier,
                    ),
        );
        const argument = parameterIndex >= 0
            ? resolved.arguments[parameterIndex] ??
                declaration.parameters[parameterIndex]!.initializer
            : undefined;
        if (!argument) {
            return {
                source: this.compileStaticString(expression),
                dynamicUniforms: [],
            };
        }

        const marker = "__BBL_DYNAMIC_SHADER_FLOAT__";
        const templated = body.head.text + marker + span.literal.text;
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
            const file = this.program.getSourceFile(modulePath) ??
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
                for (const declaration of statement.declarationList.declarations) {
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
                const visit = (node: ts.Node): void => {
                    if (found) return;
                    if (predicate(node)) {
                        found = true;
                        return;
                    }
                    ts.forEachChild(node, visit);
                };
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
                    const imported = statement.importClause.namedBindings.elements.find(
                        (element) => element.name.text === importedName,
                    );
                    if (!imported) continue;
                    const symbol = this.checker.getSymbolAtLocation(imported.name);
                    const target = symbol &&
                        (symbol.flags & ts.SymbolFlags.Alias) !== 0
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
        resolving: ReadonlySet<ts.Symbol> = new Set(),
    ): ts.Expression {
        return this.evaluator.resolveStaticExpression(
            expression,
            resolving,
        );
    }

    public lookupIdentifierValue(
        identifier: ts.Identifier,
    ): Value | undefined {
        return this.lookupOptional(identifier);
    }

    public compileTypedArrayArgument(
        expression: ts.Expression,
        kind: TypedArrayKind,
    ): string {
        return this.dataLowerer.compileForSink(
            expression,
            { kind },
        );
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

    public compileSpriteAtlas(
        expression: ts.Expression,
    ): Value {
        const unwrapped = this.unwrap(expression);
        const value = this.compileValue(unwrapped);
        if (value.kind === "record") {
            const cpp = compileSpriteAtlasRecord(
                this,
                value,
                expression,
            );
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
        const resolved =
            this.resolveStaticExpression(expression);
        return ts.isArrayLiteralExpression(resolved)
            ? resolved
            : undefined;
    }

    public cppLocalName(sourceName: string): string {
        return this.cppIdentifier(sourceName);
    }

    public isEntrySourceFile(
        file: ts.SourceFile,
    ): boolean {
        return file === this.sourceFile;
    }

    public sourceFiles(): readonly ts.SourceFile[] {
        return this.program.getSourceFiles();
    }

    /**
     * Whether any reached module can mint an imported asset's synthetic
     * root: the pin spells it `container.entities[0]`, the one access
     * `assetRootElementAccess` answers. The data-type registry asks this
     * once, before it gives `TransformNode` a native handle.
     */
    public assetRootsReachable(): boolean {
        this.assetRootsReachableAnswer ??= this.sourceFiles().some(
            (file) => {
                if (file.isDeclarationFile) return false;
                let found = false;
                const visit = (node: ts.Node): void => {
                    if (found) return;
                    if (
                        ts.isPropertyAccessExpression(node) &&
                        node.name.text === "entities"
                    ) {
                        found = true;
                        return;
                    }
                    ts.forEachChild(node, visit);
                };
                visit(file);
                return found;
            },
        );
        return this.assetRootsReachableAnswer;
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
        fieldValues: (
            element: string,
        ) => Readonly<Record<string, string>>,
    ): Value {
        const dataType = this.dataLowerer.dataTypeAt(node);
        if (
            dataType?.kind !== "vector" ||
            dataType.element.kind !== "struct"
        ) {
            this.fail(
                node,
                "This query answers a list of records, which needs a " +
                    "generated struct element at the call site.",
            );
        }
        const structName = dataType.element.name;
        // The loop variable is MINTED and handed to the caller, so the name
        // the loop declares and the names the fields read cannot disagree.
        const elementName =
            this.allocateTemporaryCppName("data_element");
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

    public reachVoxelFileStorage(): void {
        this.voxelFileStorageReached = true;
    }

    /** Native host-file-dialog adapter for the pinned voxel save/load module. */
    public compileVoxelFileCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        // Every identifier call passes through here; the two names decide
        // before the declaration is resolved.
        const name = callee.text;
        if (name !== "saveToFile" && name !== "loadFromFile") {
            return undefined;
        }
        const declaration = tryResolveFunctionDeclaration(
            this.checker,
            callee,
        );
        if (!declaration) {
            return undefined;
        }
        const fileName = declaration
            .getSourceFile()
            .fileName.replace(/\\/g, "/");
        if (!/\/demos\/minecraft\/save-load\.(?:ts|js)$/i.test(fileName)) {
            return undefined;
        }
        this.reachVoxelFileStorage();
        this.reachJsData();
        if (name === "saveToFile") {
            this.expectArgumentCount(call, 1, 1);
            const parameter = declaration.parameters[0];
            if (!parameter) {
                this.fail(call, "Voxel save is missing its SaveData parameter.");
            }
            const dataType = this.dataTypes.markStoredObjectReferences(
                this.dataTypes.requireFromTsType(
                    this.checker.getTypeAtLocation(parameter),
                    parameter,
                    "Voxel save parameter",
                ),
            );
            return {
                kind: "boolean",
                cpp:
                    `bbl::js::save_voxel_world(${this.requireDefaultEngine(call)}, ` +
                    `${this.dataLowerer.compileForSink(call.arguments[0]!, dataType)})`,
                dataType: { kind: "boolean" },
            };
        }
        this.expectArgumentCount(call, 0, 0);
        const signature = this.checker.getResolvedSignature(call);
        const promised = signature
            ? this.checker.getReturnTypeOfSignature(signature)
            : undefined;
        const awaited = promised
            ? this.checker.getAwaitedType(promised)
            : undefined;
        const mapped = awaited
            ? this.dataTypes.fromTsType(awaited, call)
            : undefined;
        if (!mapped) {
            this.fail(
                call,
                "Voxel load result must be a SaveData value or null.",
            );
        }
        const stored =
            this.dataTypes.markStoredObjectReferences(mapped);
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

    public restoreAliasState(
        snapshot: Map<string, string>,
    ): void {
        this.dataLowerer.restoreAliasState(snapshot);
    }

    public enterRuntimeControlFlow(): void {
        this.runtimeControlFlowDepth += 1;
    }

    public leaveRuntimeControlFlow(): void {
        this.runtimeControlFlowDepth -= 1;
    }

    public isInRuntimeControlFlow(): boolean {
        return this.runtimeControlFlowDepth > 0;
    }

    public defineThis(instance: Value | undefined): void {
        this.thisInstance = instance;
    }

    /**
     * True when an identifier names a local function declaration, so a
     * record property holding it is a method rather than a value.
     */
    public namesLocalFunction(
        identifier: ts.Identifier,
    ): boolean {
        if (this.lookupOptional(identifier)) {
            // A bound value wins: a local shadowing a function name is
            // that local.
            return false;
        }
        return resolveFunctionDeclaration(
            this.checker,
            identifier,
            (node, message) => this.fail(node, message),
        ) !== undefined;
    }

    /**
     * The value a property access reads out of a compile-time record,
     * or undefined when the owner is not one. Asking rather than
     * asserting, so the data lowerer can probe a path it may not own.
     */
    public resolveRecordMember(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        const ownerExpression = this.unwrap(
            expression.expression,
        );
        const owner = ts.isIdentifier(ownerExpression)
            ? this.lookupOptional(ownerExpression)
            : ownerExpression.kind ===
                ts.SyntaxKind.ThisKeyword
              ? this.activeThis()
              : ts.isPropertyAccessExpression(
                    ownerExpression,
                )
                ? (this.resolveRecordMember(
                      ownerExpression,
                  ) ??
                  this.lookupRecordProperty(
                      ownerExpression,
                  ))
              : undefined;
        if (owner?.kind !== "record") {
            return undefined;
        }
        const accessor =
            owner.recordGetters?.[expression.name.text];
        if (accessor) {
            return this.compileRecordGetter(
                owner,
                accessor,
            );
        }
        return owner.recordProperties?.[
            expression.name.text
        ];
    }

    public resolveRecordValue(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.unwrap(expression);
        const value = ts.isIdentifier(unwrapped)
            ? this.lookupOptional(unwrapped)
            : unwrapped.kind === ts.SyntaxKind.ThisKeyword
              ? this.activeThis()
              : ts.isPropertyAccessExpression(unwrapped)
                ? this.resolveRecordMember(unwrapped)
                : undefined;
        return value?.kind === "record"
            ? value
            : undefined;
    }

    public compileRecordSetter(
        owner: Value,
        setter: ts.SetAccessorDeclaration,
        value: ts.Expression,
    ): void {
        this.withRecordScopes(owner, () =>
            this.classLowerer.compileSetter(owner, setter, value),
        );
    }

    /**
     * Runs `work` with a record's captured scope chain in force, so a
     * method or getter of that record sees the state it closed over
     * even when the scope that built it has since been left.
     */
    public withRecordScopes<T>(
        owner: Value,
        work: () => T,
    ): T {
        if (!owner.recordScopes) {
            return work();
        }
        const saved = [...this.variableScopes];
        this.variableScopes.length = 0;
        this.variableScopes.push(...owner.recordScopes);
        try {
            return work();
        } finally {
            this.variableScopes.length = 0;
            this.variableScopes.push(...saved);
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
        const statements =
            accessor.body?.statements ?? [];
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
                return this.compileValue(expression);
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
    ): void {
        const nullableResource =
            this.nullableResourceKind(name);
        const nullableInitializer = nullableResource
            ? this.compileValue(initializer)
            : undefined;
        if (
            nullableResource &&
            nullableInitializer?.kind === "json-null"
        ) {
            const cppName = this.allocateTemporaryCppName(
                `class_field_${name.text}`,
            );
            this.emit(
                `std::optional<${nullableResource.cppType}> ${cppName};`,
            );
            this.defineVariable(name, {
                kind: nullableResource.kind,
                cpp: `(*${cppName})`,
                ...(nullableResource.kind === "ui-element" &&
                this.defaultEngineCpp
                    ? { engineCpp: this.defaultEngineCpp }
                    : {}),
                optionalFoundCpp: `${cppName}.has_value()`,
                optionalStorageCpp: cppName,
            });
            return;
        }
        if (this.bindClassDataField(name, initializer)) {
            return;
        }
        this.bindLocalOrParameterValue(
            name,
            nullableInitializer ?? this.compileValue(initializer),
            false,
            this.allocateTemporaryCppName(
                `class_field_${name.text}`,
            ),
        );
    }

    /** Predeclare an uninitialized nullable resource class field. */
    public bindNullableClassField(
        name: ts.Identifier,
    ): Value | undefined {
        const resource = this.nullableResourceKind(name);
        if (!resource) return undefined;
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        this.emit(
            `std::optional<${resource.cppType}> ${cppName};`,
        );
        const value: Value = {
            kind: resource.kind,
            cpp: `(*${cppName})`,
            ...(resource.kind === "ui-element" && this.defaultEngineCpp
                ? { engineCpp: this.defaultEngineCpp }
                : {}),
            optionalFoundCpp: `${cppName}.has_value()`,
            optionalStorageCpp: cppName,
        };
        this.defineVariable(name, value);
        return value;
    }

    /** Predeclare an optional plain-data class field at JavaScript undefined. */
    public bindUninitializedClassDataField(
        name: ts.Identifier,
    ): Value | undefined {
        const dataType = this.dataLowerer.dataTypeAt(name);
        if (dataType?.kind !== "optional") {
            return undefined;
        }
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        this.emit(`${this.dataTypes.cppType(dataType)} ${cppName}{};`);
        this.dataLowerer.registerLocal(cppName, "owned");
        const value = this.dataLowerer.leafValue(cppName, dataType);
        value.nativeLvalue = true;
        this.defineVariable(name, value);
        return value;
    }

    /** Predeclare optional storage for a resource-valued expression. */
    public bindOptionalResourceValue(
        name: ts.Identifier,
    ): Value | undefined {
        const declared = this.nullableResourceKind(name);
        const typeName = this.checker.getTypeAtLocation(name).symbol?.name;
        const direct = typeName?.endsWith("Node")
            ? {
                  kind: "audio-node" as const,
                  cppType: "bbl::pal::AudioNodeHandle",
              }
            : typeName === "AudioBuffer"
              ? {
                    kind: "audio-buffer" as const,
                    cppType: "bbl::pal::AudioBufferHandle",
                }
              : typeName === "AudioParam"
                ? {
                      kind: "audio-param" as const,
                      cppType: "bbl::pal::AudioParamHandle",
                  }
                : undefined;
        const resource = declared ?? direct;
        if (!resource) return undefined;
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        this.emit(
            `std::optional<${resource.cppType}> ${cppName};`,
        );
        const value: Value = {
            kind: resource.kind,
            cpp: `(*${cppName})`,
            ...(resource.kind === "ui-element" && this.defaultEngineCpp
                ? { engineCpp: this.defaultEngineCpp }
                : {}),
            optionalFoundCpp: `${cppName}.has_value()`,
            optionalStorageCpp: cppName,
        };
        this.defineVariable(name, value);
        return value;
    }

    /**
     * An explicitly declared class field without an initializer is first
     * assigned in the constructor body. Give a data-model field the same
     * native storage as an initialized declaration at that assignment; a
     * resource or compile-time record returns undefined for the existing
     * one-time binding path to own.
     */
    public bindClassDataField(
        name: ts.Identifier,
        initializer: ts.Expression,
    ): Value | undefined {
        const dataType =
            this.dataLowerer.dataTypeAt(name);
        if (!dataType || dataType.kind === "handle") {
            return undefined;
        }
        const cppName = this.allocateTemporaryCppName(
            `class_field_${name.text}`,
        );
        const cpp = this.dataLowerer.compileForSink(
            initializer,
            dataType,
        );
        this.emit(
            `${this.dataTypes.cppType(dataType)} ${cppName} = ${cpp};`,
        );
        this.dataLowerer.registerLocal(
            cppName,
            "owned",
        );
        // Leaves use the same surface as a container read: numbers stay
        // numeric and stored resource handles remain resources.
        const value = this.dataLowerer.leafValue(
            cppName,
            dataType,
        );
        value.nativeLvalue = true;
        this.defineVariable(name, value);
        return value;
    }

    public resolveThisField(
        name: string,
    ): Value | undefined {
        return this.thisInstance?.recordProperties?.[name];
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

    public classOf(
        instance: Value,
    ): ts.ClassDeclaration | undefined {
        return instance.classDeclaration ?? this.classInstances.get(instance);
    }

    public defaultEngine(): string | undefined {
        return this.defaultEngineCpp;
    }

    public reachJsRandom(): void {
        this.jsRandomReached = true;
    }

    /**
     * Give a recursive local function JavaScript closure lifetime when an
     * engine exists. A reference to the heap function keeps existing `[&]`
     * callback lowering correct, and the owner local keeps the object
     * alive for every synchronous call the emitting scope makes. Only a
     * callback that can outlive that scope -- one some other emission
     * retains, like a timer registration -- is co-owned by the engine:
     * `native_callback_owners` is never drained, so pushing every
     * recursive callback grew it once per execution of the emitting body
     * (one push per frame from platformer's RAF arm, 52 doom sites).
     */
    public emitNativeCallbackStorage(
        cppName: string,
        signature: string,
        escapesEmittingScope: boolean,
    ): void {
        const engine = this.defaultEngine();
        if (
            !engine ||
            this.activeNativeReturnType() !== undefined
        ) {
            // Namespace-scope data functions do not capture the entry
            // engine. Their recursive callbacks are invoked synchronously
            // within the function, so ordinary stack lifetime is sufficient.
            this.emit(`std::function<${signature}> ${cppName};`);
            return;
        }
        const owner = `${cppName}_owner`;
        this.emit(
            `auto ${owner} = std::make_shared<std::function<${signature}>>();`,
        );
        if (escapesEmittingScope) {
            this.emit(
                `${engine}.native_callback_owners.push_back(${owner});`,
            );
        }
        this.emit(`auto& ${cppName} = *${owner};`);
    }

    /**
     * Runs a shape probe, keeping what it emitted only when it answers.
     *
     * A lowering that asks "is this expression a tuple / a data container"
     * answers by RESOLVING the expression, and resolving a call compiles
     * it — so a probe that then declines leaves the call's whole inlined
     * body in the stream, and the shape that does answer compiles the same
     * call a second time. The first copy is unreachable, and unreachable is
     * not free: `break-meshes` fractured every mesh twice and retained 304
     * orphaned meshes for the copy nothing read. Neither gate could see it,
     * because an orphan is never drawn and `bbl::js::Array` has a
     * non-trivial destructor, so the unused-variable warnings stay silent.
     *
     * Indentation is left where it is, unlike `captureEmittedLines`: a kept
     * line stays exactly where the probe emitted it.
     */
    public probeEmission<T>(
        probe: () => T,
        answered: (result: T) => boolean = (result) =>
            result !== undefined,
    ): T {
        const start = this.body.length;
        const result = probe();
        if (!answered(result)) {
            this.body.splice(start);
        }
        return result;
    }

    /**
     * Runs an emission body with indentation reset to column zero and
     * returns the produced lines, removing them from the main body stream.
     * Native function definitions and for-headers use this.
     */
    public captureEmittedLines(
        emitBody: () => void,
    ): string[] {
        const start = this.body.length;
        const previousIndent = this.indentLevel;
        this.indentLevel = 0;
        try {
            emitBody();
        } finally {
            this.indentLevel = previousIndent;
        }
        return this.body.splice(start);
    }

    /**
     * Mark an already-emitted local `[[maybe_unused]]`.
     *
     * One case reaches this: a numeric local whose only reader is the
     * `Math.random` arrow a node-particle bake moves to generation. The
     * source reads it; the lowered program does not, and MSVC /W4 warns on
     * a local that is initialized and never referenced.
     */
    public markEmittedLocalUnused(
        cppName: string,
        site: ts.Node,
    ): void {
        const declaration = `double ${cppName} = `;
        for (let index = this.body.length - 1; index >= 0; index -= 1) {
            const line = this.body[index]!;
            const trimmed = line.trimStart();
            if (trimmed.startsWith(declaration)) {
                this.body[index] = line.replace(
                    declaration,
                    `[[maybe_unused]] ${declaration}`,
                );
                return;
            }
        }
        // A miss cannot be silent: the annotation is what keeps the
        // generated C++ warning-clean under /W4, and a declaration this no
        // longer recognizes would surface as a warning in a native build
        // with nothing pointing back here.
        this.fail(
            site,
            `Cannot mark local '${cppName}' unused: no emitted ` +
                "declaration matches it.",
        );
    }

    /**
     * Mark every emitted numeric local that nothing else in the body reads.
     *
     * Folding is what creates them: a scene's `const x = Math.round(...)`
     * can end up with every reader folded too, or moved to generation as a
     * bake step, and MSVC /W4 warns on a local that is initialized and never
     * referenced. This runs once over the finished body and marks only the
     * declarations whose name appears nowhere else, so a local that IS read
     * keeps the warning that would catch a lowering bug.
     */
    private markUnreadNumericLocals(): void {
        const declarations: Array<{
            index: number;
            name: string;
        }> = [];
        for (let index = 0; index < this.body.length; index += 1) {
            const match = this.body[index]!.match(
                /^\s*(?:static\s+)?double\s+(v_[A-Za-z0-9_]+)\s*=/,
            );
            if (match) {
                declarations.push({ index, name: match[1]! });
            }
        }
        for (const declaration of declarations) {
            const token = new RegExp(`\\b${declaration.name}\\b`);
            const target = new RegExp(
                `(?:\\+\\+|--)\\s*${declaration.name}\\b|` +
                    `\\b${declaration.name}\\b\\s*(?:\\+\\+|--|[+\\-*/%]?=)`,
                "g",
            );
            const read = this.body.some((line, index) => {
                if (index === declaration.index || !token.test(line)) {
                    return false;
                }
                return token.test(line.replace(target, ""));
            });
            if (!read) {
                this.body[declaration.index] = this.body[
                    declaration.index
                ]!.replace(
                    /(^\s*)(?=(?:static\s+)?double\s)/,
                    "$1[[maybe_unused]] ",
                );
            }
        }
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
    private readonly staticRecordAccessors = new Map<string, string>();

    public staticRecordAccessor(
        mapType: string,
        entries: readonly string[],
    ): string {
        const initializer = `${mapType} values{${entries.join(", ")}};`;
        const existing = this.staticRecordAccessors.get(initializer);
        if (existing) return existing;
        const name = `bbl_static_table_${this.staticRecordAccessors.size}`;
        this.registerNativeFunction(`${mapType}& ${name}();`, [
            `${mapType}& ${name}() {`,
            `    static ${initializer}`,
            `    return values;`,
            `}`,
        ]);
        this.staticRecordAccessors.set(initializer, name);
        return name;
    }

    public registerNativeFunction(
        prototype: string,
        definitionLines: string[],
    ): void {
        this.nativeFunctionPrototypes.push(prototype);
        this.nativeFunctionDefinitions.push(
            ...definitionLines,
            "",
        );
    }

    public beginNativeFunctionBody(
        returnType: DataType | undefined,
        contextualVoid = false,
    ): void {
        this.returnFrames.push({
            kind: "native",
            type: returnType ?? "void",
            ...(contextualVoid ? { contextualVoid: true } : {}),
        });
    }

    public endNativeFunctionBody(): void {
        this.returnFrames.pop();
    }

    /**
     * Stored callbacks retain their defining locals, but an entry callback
     * must keep using the one live engine rather than mutating a copied scene.
     * Namespace data-function closures have no entry engine in their scope.
     */
    public storedDataFunctionCapture(lines: readonly string[]): string {
        const engine = this.defaultEngine();
        return engine && lines.some((line) => line.includes(engine))
            ? `[=, &${engine}]`
            : "[=]";
    }

    public beginInlineFrame(wrapped: boolean): void {
        this.returnFrames.push({
            kind: "inline",
            wrapped,
        });
    }

    public endInlineFrame(): void {
        this.returnFrames.pop();
    }

    public activeNativeReturnType():
        | DataType
        | "void"
        | undefined {
        const top = this.returnFrames.at(-1);
        return top?.kind === "native"
            ? top.type
            : undefined;
    }

    public activeInlineWrapper(): boolean {
        const top = this.returnFrames.at(-1);
        return top?.kind === "inline" && top.wrapped;
    }

    public emitNativeReturn(
        statement: ts.ReturnStatement,
    ): void {
        const frame = this.returnFrames.at(-1);
        const returnType = this.activeNativeReturnType();
        if (returnType === undefined) {
            this.fail(
                statement,
                "Return outside a native function.",
            );
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
            this.emit("return;");
            return;
        }
        if (!statement.expression) {
            this.fail(
                statement,
                "Non-void native functions must return a value.",
            );
        }
        if (returnType.kind === "number") {
            this.emit(
                `return ${this.compileNumber(statement.expression, "double")};`,
            );
            return;
        }
        if (returnType.kind === "boolean") {
            this.emit(
                `return ${this.compileCondition(statement.expression)};`,
            );
            return;
        }
        this.emit(
            `return ${this.dataLowerer.compileForSink(statement.expression, returnType)};`,
        );
    }

    public emitDataAssignment(
        expression: ts.BinaryExpression,
    ): boolean {
        return this.dataLowerer.emitAssignment(
            expression,
        );
    }

    public emitDataPostfix(
        expression: ts.PostfixUnaryExpression,
    ): boolean {
        return this.dataLowerer.emitPostfixUnary(
            expression,
        );
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
            delete target.spriteDepthMode;
            return true;
        }
        const value = this.compileValue(right);
        if (value.kind === "json-null") {
            this.emit(`${storage}.reset();`);
            delete target.spriteDepthMode;
            return true;
        }
        if (
            value.kind === "data" &&
            value.dataType?.kind === "optional" &&
            value.dataType.inner.kind === "handle" &&
            value.dataType.inner.handle === target.kind
        ) {
            this.emit(`${storage} = ${value.cpp};`);
            delete target.spriteDepthMode;
            return true;
        }
        if (value.kind !== target.kind) {
            this.fail(
                right,
                `Nullable ${target.kind} assignment received ${value.kind}.`,
            );
        }
        if (value.optionalFoundCpp !== undefined) {
            // A nullable handle property is represented by the invalid native
            // handle, while local nullable storage is std::optional. Do not
            // engage that optional with the sentinel: the next guarded read
            // would then index a collection with invalid_handle.
            this.emit(`if (${value.optionalFoundCpp}) {`);
            this.emit(`    ${storage} = ${value.cpp};`);
            this.emit("} else {");
            this.emit(`    ${storage}.reset();`);
            this.emit("}");
        } else {
            this.emit(`${storage} = ${value.cpp};`);
        }
        if (value.audioContextCpp !== undefined) {
            target.audioContextCpp =
                value.audioContextCpp;
        }
        if (value.audioMainBusCpp !== undefined) {
            target.audioMainBusCpp =
                value.audioMainBusCpp;
        }
        if (value.engineCpp !== undefined) {
            target.engineCpp = value.engineCpp;
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
        return true;
    }

    public dataIterationTarget(
        expression: ts.Expression,
    ):
        | { container: Value; element: DataIterationElement }
        | undefined {
        return this.dataLowerer.iterationTarget(
            expression,
        );
    }

    public dataValue(
        cpp: string,
        dataType: DataType,
    ): Value {
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
    public compileAnimationGroupList(
        expression: ts.Expression,
    ): { cpp: string; engineCpp: string } {
        return this.handleCollections.compileAnimationGroupList(
            expression,
        );
    }

    /** `<container>.entities` — the concept's entity-walk fold. */
    public assetEntitiesIterationTarget(
        expression: ts.Expression,
    ): Value | undefined {
        return this.handleCollections.assetEntitiesIterationTarget(
            expression,
        );
    }

    /** `<gltf container>.entities[0]` — the concept's root indexing. */
    public assetRootElementAccess(
        expression: ts.ElementAccessExpression,
    ): Value | undefined {
        return this.handleCollections.assetRootElementAccess(
            expression,
        );
    }

    /**
     * A proven container flatten's mesh collection, with the container it
     * flattened — the licence a whole-list setter needs.
     */
    public assetFlattenedMeshesIterationTarget(
        expression: ts.Expression,
    ):
        | { target: HandleCollectionTarget; asset: CompileAsset }
        | undefined {
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
        return this.handleCollections.iterationTarget(
            expression,
        );
    }

    public assetMeshCollection(
        owner: Value,
        expression: ts.Expression,
    ): Value {
        return this.handleCollections.assetMeshCollection(
            owner,
            expression,
        );
    }

    public bindDataIterationVariable(
        name: ts.BindingName,
        itemCpp: string,
        element: DataIterationElement,
    ): void {
        this.dataLowerer.bindIterationVariable(
            name,
            itemCpp,
            element,
            (identifier, value) =>
                this.defineVariable(identifier, value),
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
        root.assetRootState.reparented = true;
    }

    /**
     * The current root setters address the asset's outer transform. After
     * `setParent`, the hierarchy follows the new TransformNode instead, so a
     * later write through the old root handle would mutate stale state.
     */
    public assertAssetRootWritable(root: Value, node: ts.Node): void {
        if (root.assetRootState?.reparented) {
            this.fail(
                node,
                "Writing an imported root after setParent is not lowered; " +
                    "the hierarchy now follows its new TransformNode parent.",
            );
        }
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
    public recordGltfContainerLoad(
        asset: CompileAsset,
        node: ts.Node,
    ): void {
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
        this.lastGltfContainerAsset = asset;
    }

    public probePixelsAsset(
        expression: ts.Expression,
    ): { cpp: string; source: string } | undefined {
        return probePixelsAsset(this, expression);
    }

    public registerSpriteAtlasAsset(
        expression: ts.Expression,
    ): string {
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
                candidate !== asset &&
                candidate.selectedVariant !== undefined,
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
        if (
            existing &&
            existing.tint?.join() !== tint?.join()
        ) {
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
        return resolveBundledAsset(source);
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
        if (this.uiElementValue(unwrapped.expression)?.uiCanvas) {
            return undefined;
        }
        const ownerType = this.checker.getTypeAtLocation(
            unwrapped.expression,
        );
        const members =
            (ownerType.flags & ts.TypeFlags.Union) !== 0
                ? (ownerType as ts.UnionType).types
                : [ownerType];
        const canvases = new Set([
            "HTMLCanvasElement",
            "OffscreenCanvas",
        ]);
        return members.length > 0 &&
            members.every((member) =>
                canvases.has(
                    member.getSymbol()?.getName() ?? "",
                ),
            )
            ? axis
            : undefined;
    }

    public canvasSizeProperty(
        expression: ts.Expression,
    ): "width" | "height" | undefined {
        return this.canvasSizeInfo(expression)?.axis;
    }

    public staticCanvasSize(
        expression: ts.Expression,
    ): number | undefined {
        const property = this.canvasSizeInfo(expression);
        if (!property) return undefined;
        return property.axis === "width"
            ? this.options.width
            : this.options.height;
    }

    public canvasSizeValue(
        expression: ts.Expression,
    ): Value | undefined {
        const property =
            this.canvasSizeInfo(expression);
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

    public isBrowserOnlyExpression(
        expression: ts.Expression,
    ): boolean {
        return this.browserErasure.isBrowserOnlyExpression(
            expression,
        );
    }

    /**
     * Recognize either the pinned two-RAF Promise directly or the exact
     * zero-argument local helper that returns it. The call itself must be
     * awaited and discarded as an expression statement; a returned timestamp
     * used as data is a different contract and must continue through ordinary
     * Promise lowering (which currently refuses it).
     */
    public isBoundedNestedFrameYield(
        expression: ts.Expression,
    ): boolean {
        const awaited = expression.parent;
        if (
            !ts.isAwaitExpression(awaited) ||
            awaited.expression !== expression ||
            !ts.isExpressionStatement(awaited.parent)
        ) {
            return false;
        }
        if (
            this.browserErasure.isBoundedNestedFrameYield(
                expression,
            )
        ) {
            return this.requireClosedBoundedFrameYield(
                expression,
            );
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
            !this.browserErasure.isBoundedNestedFrameYield(
                returned.expression,
            )
        ) {
            return false;
        }
        return this.requireClosedBoundedFrameYield(
            returned.expression,
        );
    }

    /**
     * Erasing a wait is sound only while its two callbacks are the complete
     * user RAF set. Another callback can mutate state between the current
     * turn and the continuation even when the wait's timestamp is discarded.
     * Scan every non-declaration module in this program and refuse that
     * interleaving instead of silently moving the continuation earlier.
     */
    private requireClosedBoundedFrameYield(
        allowed: ts.Expression,
    ): true {
        const belongsToAllowed = (node: ts.Node): boolean => {
            let current: ts.Node | undefined = node;
            while (current) {
                if (current === allowed) return true;
                current = current.parent;
            }
            return false;
        };
        let other: ts.CallExpression | undefined;
        const visit = (node: ts.Node): void => {
            if (other) return;
            if (
                ts.isCallExpression(node) &&
                this.browserErasure.isDefaultRequestAnimationFrameCall(
                    node,
                ) &&
                !belongsToAllowed(node)
            ) {
                other = node;
                return;
            }
            ts.forEachChild(node, visit);
        };
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
        const members = (type.flags & ts.TypeFlags.Union) !== 0
            ? (type as ts.UnionType).types
            : [type];
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
                bound.kind !== "node-particle-2d-binding"
            ) {
                // A local function can bridge DOM setup and return an ordinary
                // native record. Once that record is bound, its data fields do
                // not become browser-only merely because the initializer also
                // registered DOM listeners.
                return false;
            }
            const declaration = this.symbols.valueSymbol(unwrapped)
                ?.valueDeclaration;
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

    /** See `BrowserErasure.isDeferredCallbackCall`. */
    public isDeferredCallbackCall(
        call: ts.CallExpression,
    ): boolean {
        return this.browserErasure.isDeferredCallbackCall(call);
    }

    public evaluateBrowserCondition(
        expression: ts.Expression,
    ): boolean | undefined {
        const condition =
            this.browserErasure.evaluateBrowserCondition(
                expression,
            );
        this.recordBrowserExpression(expression);
        return condition;
    }

    public evaluateBrowserValue(
        expression: ts.Expression,
    ): Value["browserValue"] | undefined {
        const value = this.browserErasure.evaluateBrowserValue(
            expression,
        );
        this.recordBrowserExpression(expression);
        return value;
    }

    private recordBrowserExpression(
        expression: ts.Expression,
    ): void {
        this.erasedBrowserExpressions.add(
            this.unwrap(expression).pos,
        );
    }

    public isBrowserInstrumentationCall(
        call: ts.CallExpression,
    ): boolean {
        return this.browserErasure.isBrowserInstrumentationCall(
            call,
        );
    }

    public platformDocumentHidden(): string | undefined {
        return this.platformDocumentHiddenCpp;
    }

    /** Platform-backed browser APIs that remain ordinary expression values. */
    public compilePlatformCall(
        call: ts.CallExpression,
    ): Value | undefined {
        const callee = this.unwrap(call.expression);
        if (ts.isPropertyAccessExpression(callee)) {
            if (this.isNativeHostUiLookup(call)) {
                const id = this.compileStringLiteral(call.arguments[0]!);
                const engine = this.requireDefaultEngine(call);
                this.reachFeature("ui:rml", call);
                return {
                    kind: "ui-element",
                    cpp:
                        `bbl::ui_get_element_by_id(${engine}, ` +
                        `${this.cppString(id)})`,
                    engineCpp: engine,
                    truthinessCpp: "true",
                };
            }
            if (
                callee.name.text === "createElement" &&
                ts.isIdentifier(callee.expression) &&
                callee.expression.text === "document" &&
                this.isDefaultLibraryIdentifier(callee.expression)
            ) {
                this.expectArgumentCount(call, 1, 1);
                const tag = this.compileStringLiteral(call.arguments[0]!);
                if (!/^[a-z][a-z0-9-]*$/i.test(tag)) {
                    this.fail(
                        call.arguments[0]!,
                        `Native UI element tag '${tag}' is not valid.`,
                    );
                }
                const engine = this.requireDefaultEngine(call);
                this.reachFeature("ui:rml", call);
                return {
                    kind: "ui-element",
                    cpp: `bbl::ui_create_element(${engine}, ${this.cppString(tag)})`,
                    engineCpp: engine,
                    uiTag: tag.toLowerCase(),
                    ...(tag.toLowerCase() === "canvas"
                        ? {
                              uiCanvas: true as const,
                              uiCanvasId: this.uiCanvasIds++,
                          }
                        : {}),
                };
            }

            const element = this.uiElementValue(callee.expression);
            if (
                element?.uiTag === "image-bitmap" &&
                callee.name.text === "close"
            ) {
                this.expectArgumentCount(call, 0, 0);
                return { kind: "void", cpp: "" };
            }
            if (
                element?.uiCanvas &&
                !element.uiCanvasContext &&
                callee.name.text === "getContext"
            ) {
                this.expectArgumentCount(call, 1, 1);
                const context = this.compileStringLiteral(call.arguments[0]!);
                if (context !== "2d") {
                    this.fail(
                        call.arguments[0]!,
                        "Retained native canvas only supports the '2d' context.",
                    );
                }
                return {
                    ...element,
                    uiCanvasContext: true,
                };
            }
            if (element?.uiCanvasContext) {
                const engine = this.requireEngine(element, call);
                const number = (index: number): string =>
                    this.compileNumber(call.arguments[index]!, "double");
                const invocation = (
                    name: string,
                    minimum: number,
                    maximum = minimum,
                ): Value => {
                    this.expectArgumentCount(call, minimum, maximum);
                    return {
                        kind: "void",
                        cpp:
                            `bbl::ui_canvas_${name}(${engine}, ${element.cpp}` +
                            `${call.arguments.length > 0 ? ", " : ""}` +
                            `${call.arguments.map((_argument, index) => number(index)).join(", ")})`,
                    };
                };
                switch (callee.name.text) {
                    case "scale":
                        this.recordUiCanvasLogicalScale(call);
                        return invocation("scale", 2);
                    case "clearRect":
                        this.expectUiCanvasFullSurfaceClear(
                            call,
                            element.uiCanvasId,
                        );
                        return invocation("clear_rect", 4);
                    case "beginPath":
                        return invocation("begin_path", 0);
                    case "moveTo":
                        return invocation("move_to", 2);
                    case "lineTo":
                        return invocation("line_to", 2);
                    case "closePath":
                        return invocation("close_path", 0);
                    case "arcTo":
                        return invocation("arc_to", 5);
                    case "arc":
                        this.expectArgumentCount(call, 5, 6);
                        return {
                            kind: "void",
                            cpp:
                                `bbl::ui_canvas_arc(${engine}, ${element.cpp}, ` +
                                `${call.arguments.slice(0, 5).map((_argument, index) => number(index)).join(", ")}, ` +
                                `${call.arguments[5] ? this.compileBoolean(call.arguments[5]) : "false"})`,
                        };
                    case "fill":
                        return invocation("fill", 0);
                    case "stroke":
                        return invocation("stroke", 0);
                    case "getImageData": {
                        this.expectArgumentCount(call, 4, 4);
                        const sourceText = call.getSourceFile().text;
                        if (
                            !sourceText.includes("createImageBitmap") ||
                            !sourceText.includes("ctx.drawImage") ||
                            !sourceText.includes("ctx.getImageData")
                        ) {
                            this.fail(
                                call,
                                "Retained Canvas2D getImageData is lowered only for the bounded fetched-atlas bake.",
                            );
                        }
                        const atlas = bakeFetchedCanvasAtlas(
                            call.getSourceFile().fileName,
                        );
                        for (const image of atlas.images) {
                            registerUiImageAsset(
                                this,
                                image.source,
                                image.logicalPath,
                            );
                        }
                        const asset = this.registerAsset(
                            `data:application/octet-stream;base64,${Buffer.from(atlas.pixels).toString("base64")}`,
                            "pixels",
                        );
                        this.reachJsData();
                        return {
                            kind: "record",
                            cpp: "",
                            recordProperties: {
                                data: {
                                    kind: "data",
                                    cpp:
                                        `bbl::js::U8Array(bbl::js::ArrayBuffer(` +
                                        `bbl::pal::read_binary_file(bbl::asset_path(` +
                                        `${this.cppString(asset.output)}))))`,
                                    dataType: { kind: "u8array" },
                                },
                            },
                        };
                    }
                    case "putImageData": {
                        this.expectArgumentCount(call, 3, 3);
                        const imageData = this.unwrap(call.arguments[0]!);
                        if (
                            !ts.isNewExpression(imageData) ||
                            !ts.isIdentifier(imageData.expression) ||
                            imageData.expression.text !== "ImageData" ||
                            (imageData.arguments?.length ?? 0) !== 3
                        ) {
                            this.fail(
                                call.arguments[0]!,
                                "Retained Canvas2D putImageData requires new ImageData(rgba, width, height).",
                            );
                        }
                        let pixelsExpression = imageData.arguments![0]!;
                        const pixelsConstructor = this.unwrap(pixelsExpression);
                        if (
                            ts.isNewExpression(pixelsConstructor) &&
                            ts.isIdentifier(pixelsConstructor.expression) &&
                            (pixelsConstructor.expression.text ===
                                "Uint8ClampedArray" ||
                                pixelsConstructor.expression.text ===
                                    "Uint8Array") &&
                            pixelsConstructor.arguments?.length === 1
                        ) {
                            pixelsExpression = pixelsConstructor.arguments[0]!;
                        }
                        const pixels = this.compileValue(pixelsExpression);
                        if (
                            pixels.kind !== "data" ||
                            pixels.dataType?.kind !== "u8array"
                        ) {
                            this.fail(
                                pixelsExpression,
                                "Retained Canvas2D ImageData pixels must lower to a Uint8Array.",
                            );
                        }
                        return {
                            kind: "void",
                            cpp:
                                `bbl::ui_canvas_put_image_data(${engine}, ${element.cpp}, ` +
                                `${pixels.cpp}, ` +
                                `${this.compileNumber(imageData.arguments![1]!, "double")}, ` +
                                `${this.compileNumber(imageData.arguments![2]!, "double")}, ` +
                                `${number(1)}, ${number(2)})`,
                        };
                    }
                    case "drawImage": {
                        this.expectArgumentCount(call, 5, 5);
                        const source = this.compileValue(call.arguments[0]!);
                        if (source.kind !== "ui-element") {
                            this.fail(
                                call.arguments[0]!,
                                "Retained Canvas2D drawImage source must be a retained UI element; " +
                                    `received ${source.kind}.`,
                            );
                        }
                        if (source.uiTag === "image-bitmap") {
                            return { kind: "void", cpp: "" };
                        }
                        this.expectSameEngine(element, source, call);
                        const sourceText = this.unwrap(
                            call.arguments[0]!,
                        ).getText();
                        const extent = (
                            argumentIndex: number,
                            axis: "width" | "height",
                        ): string => {
                            const argument = this.unwrap(
                                call.arguments[argumentIndex]!,
                            );
                            let dimension: ts.Expression = argument;
                            let multiplier = "1.0";
                            if (
                                ts.isBinaryExpression(argument) &&
                                argument.operatorToken.kind ===
                                    ts.SyntaxKind.AsteriskToken
                            ) {
                                const left = this.unwrap(argument.left);
                                const right = this.unwrap(argument.right);
                                const leftIsDimension =
                                    ts.isPropertyAccessExpression(left) &&
                                    left.name.text === axis;
                                const rightIsDimension =
                                    ts.isPropertyAccessExpression(right) &&
                                    right.name.text === axis;
                                if (leftIsDimension) {
                                    dimension = left;
                                    multiplier = this.compileNumber(
                                        argument.right,
                                        "double",
                                    );
                                } else if (rightIsDimension) {
                                    dimension = right;
                                    multiplier = this.compileNumber(
                                        argument.left,
                                        "double",
                                    );
                                }
                            }
                            if (
                                !ts.isPropertyAccessExpression(dimension) ||
                                dimension.name.text !== axis ||
                                this.unwrap(dimension.expression).getText() !==
                                    sourceText
                            ) {
                                this.fail(
                                    call.arguments[argumentIndex]!,
                                    `Retained Canvas2D drawImage ${axis} must be source.${axis}, optionally multiplied by a scale.`,
                                );
                            }
                            return (
                                `(bbl::ui_canvas_${axis}(${engine}, ${source.cpp}) * ` +
                                `(${multiplier}))`
                            );
                        };
                        return {
                            kind: "void",
                            cpp:
                                `bbl::ui_canvas_draw_image(${engine}, ${element.cpp}, ${source.cpp}, ` +
                                `${number(1)}, ${number(2)}, ${extent(3, "width")}, ${extent(4, "height")})`,
                        };
                    }
                    case "fillText":
                        this.expectArgumentCount(call, 3, 3);
                        return {
                            kind: "void",
                            cpp:
                                `bbl::ui_canvas_fill_text(${engine}, ${element.cpp}, ` +
                                `${this.uiStringCpp(call.arguments[0]!, "Canvas2D fillText")}, ` +
                                `${number(1)}, ${number(2)})`,
                        };
                }
            }
            if (element && callee.name.text === "setAttribute") {
                this.expectArgumentCount(call, 2, 2);
                const name = this.compileStringLiteral(call.arguments[0]!);
                const staticValue = this.tryUiStaticString(
                    call.arguments[1]!,
                );
                const sourceValue = staticValue === undefined
                    ? this.compileValue(call.arguments[1]!)
                    : undefined;
                if (
                    sourceValue !== undefined &&
                    sourceValue.kind !== "string" &&
                    !(
                        sourceValue.kind === "data" &&
                        sourceValue.dataType?.kind === "string"
                    )
                ) {
                    this.fail(
                        call.arguments[1]!,
                        `UI setAttribute value requires a string, received ${sourceValue?.kind}.`,
                    );
                }
                const value =
                    staticValue !== undefined
                        ? this.cppString(
                              this.lowerUiAttributeLiteral(
                                  name,
                                  staticValue,
                                  call.arguments[1]!,
                              ),
                          )
                        : sourceValue!.cpp;
                const engine = this.requireEngine(element, call);
                return {
                    kind: "void",
                    cpp:
                        `bbl::ui_set_attribute(${engine}, ${element.cpp}, ` +
                        `${this.cppString(name)}, ` +
                        `${value})`,
                };
            }
            if (element && callee.name.text === "appendChild") {
                this.expectArgumentCount(call, 1, 1);
                const child = this.compileValue(call.arguments[0]!);
                this.expectKind(child, "ui-element", call.arguments[0]!);
                if (!element.uiRoot) {
                    this.expectSameEngine(element, child, call);
                }
                const engine = this.requireEngine(
                    element.uiRoot ? child : element,
                    call,
                );
                return {
                    kind: "ui-element",
                    cpp: element.uiRoot
                        ? `bbl::ui_append_to_root(${engine}, ${child.cpp})`
                        : `bbl::ui_append_child(${engine}, ${element.cpp}, ${child.cpp})`,
                    engineCpp: engine,
                };
            }
            if (element && callee.name.text === "append") {
                const children = call.arguments.map((argument) => {
                    const child = this.compileValue(argument);
                    this.expectKind(child, "ui-element", argument);
                    return child;
                });
                if (children.length === 0) {
                    return { kind: "void", cpp: "" };
                }
                const engine = this.requireEngine(
                    element.uiRoot ? children[0]! : element,
                    call,
                );
                const appends = children.map((child) => {
                    if (element.uiRoot) {
                        this.expectSameEngine(children[0]!, child, call);
                        return `bbl::ui_append_to_root(${engine}, ${child.cpp})`;
                    }
                    this.expectSameEngine(element, child, call);
                    return `bbl::ui_append_child(${engine}, ${element.cpp}, ${child.cpp})`;
                });
                return { kind: "void", cpp: appends.join(", ") };
            }
            if (element && callee.name.text === "replaceChildren") {
                this.expectArgumentCount(call, 0, 0);
                const engine = this.requireEngine(element, call);
                return {
                    kind: "void",
                    cpp: `bbl::ui_replace_children(${engine}, ${element.cpp})`,
                };
            }
            if (element && callee.name.text === "remove") {
                this.expectArgumentCount(call, 0, 0);
                const engine = this.requireEngine(element, call);
                return {
                    kind: "void",
                    cpp: `bbl::ui_remove(${engine}, ${element.cpp})`,
                };
            }
            if (element && callee.name.text === "getBoundingClientRect") {
                this.expectArgumentCount(call, 0, 0);
                const engine = this.requireEngine(element, call);
                const rect =
                    `bbl::ui_get_client_rect(${engine}, ${element.cpp})`;
                const component = (name: string): Value => ({
                    kind: "number",
                    cpp: `${rect}.${name}`,
                    dataType: { kind: "number" },
                    engineCpp: engine,
                });
                return {
                    kind: "record",
                    cpp: "",
                    recordProperties: {
                        left: component("left"),
                        top: component("top"),
                        width: component("width"),
                        height: component("height"),
                    },
                };
            }
            if (
                element &&
                (callee.name.text === "setPointerCapture" ||
                    callee.name.text === "releasePointerCapture")
            ) {
                this.expectArgumentCount(call, 1, 1);
                // RmlUi owns pointer capture while dispatching a pressed
                // control. The DOM call has no additional native action.
                return { kind: "void", cpp: "" };
            }
            if (element && callee.name.text === "hasPointerCapture") {
                this.expectArgumentCount(call, 1, 1);
                // RmlUi dispatches captured pointer motion back to the pressed
                // element. Reaching this callback is therefore the native
                // equivalent of the DOM capture predicate used by the demos.
                return { kind: "boolean", cpp: "true" };
            }
            if (element && callee.name.text === "animate") {
                this.expectArgumentCount(call, 2, 2);
                // Web Animations remains outside this retained UI slice. The
                // state mutation around it (text/style/removal) is preserved.
                return { kind: "void", cpp: "" };
            }
            if (element && callee.name.text === "removeEventListener") {
                this.expectArgumentCount(call, 2, 2);
                // Retained UI records share the engine lifetime.
                // Listener identity/removal is deferred with DOM lifecycle.
                return { kind: "void", cpp: "" };
            }
            if (
                callee.name.text === "toggle" &&
                ts.isPropertyAccessExpression(callee.expression) &&
                callee.expression.name.text === "classList"
            ) {
                const classElement = this.uiElementValue(
                    callee.expression.expression,
                );
                if (classElement) {
                    this.expectArgumentCount(call, 2, 2);
                    const name = this.compileStringLiteral(call.arguments[0]!);
                    const enabled = this.uiBooleanCpp(
                        call.arguments[1]!,
                        "UI classList.toggle",
                    );
                    const engine = this.requireEngine(classElement, call);
                    return {
                        kind: "void",
                        cpp:
                            `bbl::ui_toggle_class(${engine}, ${classElement.cpp}, ` +
                            `${this.cppString(name)}, ${enabled})`,
                    };
                }
            }
            if (
                callee.name.text === "appendChild" &&
                ts.isPropertyAccessExpression(callee.expression) &&
                callee.expression.name.text === "body" &&
                ts.isIdentifier(callee.expression.expression) &&
                callee.expression.expression.text === "document" &&
                this.isDefaultLibraryIdentifier(
                    callee.expression.expression,
                )
            ) {
                this.expectArgumentCount(call, 1, 1);
                const child = this.compileValue(call.arguments[0]!);
                this.expectKind(child, "ui-element", call.arguments[0]!);
                const engine = this.requireEngine(child, call);
                return {
                    kind: "ui-element",
                    cpp: `bbl::ui_append_to_root(${engine}, ${child.cpp})`,
                    engineCpp: engine,
                };
            }
        }
        // `Number.isFinite(x)` is the same predicate as the global, and a
        // shared module writes whichever spelling reads better beside its
        // own guard. Both settle where generation knows the number and
        // emit the one C++ test where it does not.
        if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "isFinite" &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "Number" &&
            this.isDefaultLibraryIdentifier(callee.expression)
        ) {
            this.expectArgumentCount(call, 1, 1);
            const argument = this.compileValue(call.arguments[0]!);
            if (argument.staticNumber !== undefined) {
                return {
                    kind: "boolean",
                    cpp: Number.isFinite(argument.staticNumber)
                        ? "true"
                        : "false",
                };
            }
            return {
                kind: "boolean",
                cpp: `std::isfinite(${this.compileNumber(
                    call.arguments[0]!,
                    "double",
                )})`,
            };
        }
        if (
            ts.isIdentifier(callee) &&
            this.isDefaultLibraryIdentifier(callee)
        ) {
            if (callee.text === "isFinite") {
                this.expectArgumentCount(call, 1, 1);
                return {
                    kind: "boolean",
                    cpp:
                        `std::isfinite(` +
                        `${this.compileNumber(call.arguments[0]!, "double")})`,
                };
            }
            if (callee.text === "setInterval") {
                this.expectArgumentCount(call, 2, 2);
                const engine = this.requireDefaultEngine(call);
                const callback = this.compileFrameCallback(
                    call.arguments[0]!,
                    "interval",
                );
                const delay = this.compileNumber(
                    call.arguments[1]!,
                    "double",
                );
                return {
                    kind: "number",
                    cpp: `bbl::set_interval(${engine}, ${callback}, ${delay})`,
                    impure: true,
                };
            }
            if (callee.text === "clearInterval") {
                this.expectArgumentCount(call, 1, 1);
                const engine = this.requireDefaultEngine(call);
                return {
                    kind: "void",
                    cpp:
                        `bbl::clear_interval(${engine}, ` +
                        `${this.compileNumber(call.arguments[0]!, "double")})`,
                };
            }
            if (callee.text === "clearTimeout") {
                this.expectArgumentCount(call, 1, 1);
                const engine = this.requireDefaultEngine(call);
                return {
                    kind: "void",
                    cpp:
                        `bbl::clear_timeout(${engine}, ` +
                        `${this.compileNumber(call.arguments[0]!, "double")})`,
                };
            }
        }
        if (!ts.isPropertyAccessExpression(callee)) {
            return undefined;
        }
        const receiver = this.unwrap(callee.expression);
        if (
            callee.name.text === "destroy" &&
            call.arguments.length === 0 &&
            ts.isPropertyAccessExpression(receiver) &&
            receiver.name.text === "texture"
        ) {
            const texture = this.compileValue(
                receiver.expression,
            );
            if (texture.kind === "texture") {
                if (texture.textureStorage !== "render") {
                    // File and pixel textures are immutable engine assets;
                    // only createRenderTexture2D exposes a live GPU target
                    // whose WebGPU destroy call has observable lifetime.
                    return { kind: "void", cpp: "" };
                }
                return {
                    kind: "void",
                    cpp:
                        `bbl::dispose_sprite_render_texture(` +
                        `${texture.engineCpp ?? this.requireDefaultEngine(call)}, ` +
                        `${texture.cpp})`,
                };
            }
        }
        if (
            callee.name.text === "now" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            receiver.text === "performance" &&
            this.isDefaultLibraryIdentifier(receiver)
        ) {
            return {
                kind: "number",
                cpp: "bbl::pal::performance_milliseconds()",
                impure: true,
            };
        }
        if (
            callee.name.text === "preventDefault" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            (this.lookupOptional(receiver)?.kind ===
                "platform-keyboard-event" ||
                this.lookupOptional(receiver)?.kind ===
                    "platform-mouse-event")
        ) {
            // The native window already owns key dispatch; there is no
            // browser default action to cancel.
            return { kind: "void", cpp: "" };
        }
        if (
            callee.name.text === "requestPointerLock" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            this.isCanvasElement(receiver)
        ) {
            return {
                kind: "void",
                cpp: `bbl::request_pointer_lock(${this.requireDefaultEngine(call)})`,
            };
        }
        if (
            callee.name.text === "exitPointerLock" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            receiver.text === "document" &&
            this.isDefaultLibraryIdentifier(receiver)
        ) {
            return {
                kind: "void",
                cpp: `bbl::exit_pointer_lock(${this.requireDefaultEngine(call)})`,
            };
        }
        return undefined;
    }

    /** Whether a named RAF callback explicitly schedules itself again. */
    private animationFrameCallbackRearmsItself(
        expression: ts.Expression,
    ): boolean {
        const callback = this.unwrap(expression);
        if (!ts.isIdentifier(callback)) return false;
        const symbol = this.symbols.valueSymbol(callback);
        if (!symbol) return false;
        const declaration = symbol.valueDeclaration;
        let functionNode: ts.FunctionLikeDeclaration | undefined;
        if (
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer
        ) {
            const initializer = this.unwrap(declaration.initializer);
            if (
                ts.isArrowFunction(initializer) ||
                ts.isFunctionExpression(initializer)
            ) {
                functionNode = initializer;
            }
        } else if (declaration && ts.isFunctionDeclaration(declaration)) {
            functionNode = declaration;
        }
        if (!functionNode?.body) return false;

        let rearmed = false;
        const visit = (node: ts.Node): void => {
            if (rearmed) return;
            if (node !== functionNode && ts.isFunctionLike(node)) return;
            if (ts.isCallExpression(node)) {
                const callee = this.unwrap(node.expression);
                const argument = node.arguments[0]
                    ? this.unwrap(node.arguments[0])
                    : undefined;
                if (
                    ts.isIdentifier(callee) &&
                    callee.text === "requestAnimationFrame" &&
                    argument &&
                    ts.isIdentifier(argument) &&
                    this.symbols.valueSymbol(argument) === symbol
                ) {
                    rearmed = true;
                    return;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(functionNode.body);
        return rearmed;
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
        this.expectArgumentCount(call, 1, 1);
        const recurring = this.animationFrameCallbackRearmsItself(
            call.arguments[0]!,
        );
        const nested = this.frameCallbackDepth > 0;
        if (nested && recurring) {
            return { kind: "void", cpp: "" };
        }
        const engine = this.requireDefaultEngine(call);
        const callback = this.compileFrameCallback(
            call.arguments[0]!,
            "timestamp",
        );
        const callbacks = !recurring
            ? "animation_frame_once_callbacks"
            : this.engineStartMark
              ? "post_render_animation_frame_callbacks"
              : "animation_frame_callbacks";
        return {
            kind: "void",
            cpp: `${engine}.${callbacks}.push_back(${callback})`,
        };
    }

    /**
     * Lowers the browser listener shapes that have a native platform event.
     * Unknown event targets stay on the browser-erasure path.
     */
    public emitPlatformEventListener(
        call: ts.CallExpression,
    ): boolean {
        const callee = this.unwrap(call.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            callee.name.text !== "addEventListener"
        ) {
            return false;
        }
        const uiElement = this.uiElementValue(callee.expression);
        if (uiElement) {
            this.expectArgumentCount(call, 2, 2);
            const event = this.compileStringLiteral(call.arguments[0]!);
            const mappedEvent =
                event === "pointerdown"
                    ? "mousedown"
                    : event === "pointerup"
                      ? "mouseup"
                      : event === "pointermove"
                        ? "mousemove"
                      : event === "pointercancel" ||
                          event === "lostpointercapture"
                        ? "mouseout"
                        : event;
            if (
                event !== "click" &&
                event !== "pointerdown" &&
                event !== "pointerup" &&
                event !== "pointermove" &&
                event !== "pointercancel" &&
                event !== "lostpointercapture" &&
                event !== "contextmenu"
            ) {
                this.fail(
                    call.arguments[0]!,
                    `Native UI elements do not support the '${event}' event.`,
                );
            }
            const callback = call.arguments[1]!;
            this.hoistForwardCallbackBindings(callback, call.pos);
            const engine = this.requireEngine(uiElement, call);
            if (event === "contextmenu") {
                // Native has no browser context menu to suppress.
                return true;
            }
            const parameter =
                this.allocateTemporaryCppName("ui_pointer_event");
            const pointerValue: Value = {
                kind: "platform-mouse-event",
                cpp: parameter,
                readOnly: true,
            };
            const lambda = this.compilePlatformCallback(
                callback,
                event === "click"
                    ? undefined
                    : {
                          cppType: "const bbl::PlatformMouseEvent&",
                          name: parameter,
                      },
                event === "click" ? [] : [pointerValue],
            );
            this.emit(
                `bbl::${event === "click" ? "ui_on_click" : "ui_on_event"}(` +
                    `${engine}, ${uiElement.cpp}, ` +
                    `${event === "click" ? "" : `${this.cppString(mappedEvent)}, `}` +
                    `${lambda});`,
            );
            return true;
        }
        if (!ts.isIdentifier(callee.expression)) return false;
        const target = this.isDefaultLibraryIdentifier(callee.expression)
            ? callee.expression.text
            : this.isCanvasElement(callee.expression)
              ? "canvas"
              : undefined;
        if (
            target !== "window" &&
            target !== "document" &&
            target !== "canvas"
        ) {
            return false;
        }
        if (call.arguments.length < 2 || call.arguments.length > 3) {
            this.fail(
                call,
                "Platform event listeners require an event name, callback, and optional options record.",
            );
        }
        const event = this.evaluator.staticTextValue(
            call.arguments[0]!,
        );
        const callback = call.arguments[1]!;
        this.hoistForwardCallbackBindings(callback, call.pos);
        let once = false;
        if (call.arguments[2]) {
            const options = this.unwrap(call.arguments[2]);
            if (!ts.isObjectLiteralExpression(options)) {
                this.fail(
                    options,
                    "Native event listener options require a static object literal.",
                );
            }
            const onceExpression = this.objectProperty(options, "once");
            if (onceExpression) {
                const compiled = this.compileCondition(onceExpression);
                if (compiled !== "true" && compiled !== "false") {
                    this.fail(
                        onceExpression,
                        "The event listener 'once' option must be static.",
                    );
                }
                once = compiled === "true";
            }
        }
        const engine = this.requireDefaultEngine(call);
        if (target === "window" && event === "resize") {
            this.emit(
                `bbl::on_window_resize(${engine}, ${this.compilePlatformCallback(callback, undefined, [], undefined, once)});`,
            );
            return true;
        }
        if (
            (target === "window" || target === "canvas") &&
            (event === "keydown" || event === "keyup")
        ) {
            const parameter =
                this.allocateTemporaryCppName("key_event");
            const lambda = this.compilePlatformCallback(
                callback,
                {
                    cppType: "const bbl::PlatformKeyboardEvent&",
                    name: parameter,
                },
                [
                    {
                        kind: "platform-keyboard-event",
                        cpp: parameter,
                        readOnly: true,
                    },
                ],
                undefined,
                once,
            );
            this.emit(
                `bbl::on_key_${event === "keydown" ? "down" : "up"}(${engine}, ${lambda});`,
            );
            return true;
        }
        if (target === "window" && event === "pointerdown") {
            this.emit(
                `bbl::on_pointer_down(${engine}, ${this.compilePlatformCallback(callback, undefined, [], undefined, once)});`,
            );
            return true;
        }
        if (target === "canvas" && event === "click") {
            this.emit(
                `bbl::on_canvas_click(${engine}, ${this.compilePlatformCallback(callback, undefined, [], undefined, once)});`,
            );
            return true;
        }
        if (
            (target === "window" || target === "canvas") &&
            (event === "mousedown" ||
                event === "mouseup" ||
                event === "pointerdown" ||
                event === "pointerup")
        ) {
            const parameter =
                this.allocateTemporaryCppName("mouse_event");
            const lambda = this.compilePlatformCallback(
                callback,
                {
                    cppType: "const bbl::PlatformMouseEvent&",
                    name: parameter,
                },
                [
                    {
                        kind: "platform-mouse-event",
                        cpp: parameter,
                        readOnly: true,
                    },
                ],
                undefined,
                once,
            );
            this.emit(
                `bbl::on_mouse_${event === "mousedown" || event === "pointerdown" ? "down" : "up"}(${engine}, ${lambda});`,
            );
            return true;
        }
        if (
            ((target === "window" ||
                target === "document" ||
                target === "canvas") &&
                (event === "pointermove" || event === "mousemove")) ||
            ((target === "window" || target === "canvas") &&
                event === "wheel")
        ) {
            const parameter =
                this.allocateTemporaryCppName("mouse_event");
            const lambda = this.compilePlatformCallback(
                callback,
                {
                    cppType: "const bbl::PlatformMouseEvent&",
                    name: parameter,
                },
                [
                    {
                        kind: "platform-mouse-event",
                        cpp: parameter,
                        readOnly: true,
                    },
                ],
                undefined,
                once,
            );
            this.emit(
                `bbl::on_mouse_${event === "wheel" ? "wheel" : "move"}(${engine}, ${lambda});`,
            );
            return true;
        }
        if (
            (target === "window" || target === "canvas") &&
            event === "pointercancel"
        ) {
            const parameter =
                this.allocateTemporaryCppName("mouse_event");
            const lambda = this.compilePlatformCallback(
                callback,
                {
                    cppType: "const bbl::PlatformMouseEvent&",
                    name: parameter,
                },
                [
                    {
                        kind: "platform-mouse-event",
                        cpp: parameter,
                        readOnly: true,
                    },
                ],
                undefined,
                once,
            );
            this.emit(
                `bbl::on_mouse_cancel(${engine}, ${lambda});`,
            );
            return true;
        }
        if (target === "document" && event === "pointerlockchange") {
            this.emit(
                `bbl::on_pointer_lock_change(${engine}, ${this.compilePlatformCallback(callback, undefined, [], undefined, once)});`,
            );
            return true;
        }
        if (
            target === "document" &&
            event === "visibilitychange"
        ) {
            const parameter =
                this.allocateTemporaryCppName("document_hidden");
            this.emit(
                `bbl::on_visibility_change(${engine}, ${this.compilePlatformCallback(callback, { cppType: "bool", name: parameter }, [], parameter, once)});`,
            );
            return true;
        }
        return false;
    }

    private isCanvasElement(expression: ts.Expression): boolean {
        const type = this.checker.getTypeAtLocation(expression);
        const members =
            (type.flags & ts.TypeFlags.Union) !== 0
                ? (type as ts.UnionType).types
                : [type];
        const canvases = new Set([
            "HTMLCanvasElement",
            "OffscreenCanvas",
        ]);
        return (
            members.length > 0 &&
            members.every((member) =>
                canvases.has(member.getSymbol()?.getName() ?? ""),
            )
        );
    }

    private readonly hoistedCallbackBindings = new Set<ts.Symbol>();

    /**
     * JavaScript closures may name a `const` declared later in the same
     * function. Native callback lambdas need that storage to exist before
     * registration, so materialize such locals just ahead of the listener
     * and skip their original declaration when the source walk reaches it.
     */
    private hoistForwardCallbackBindings(
        callback: ts.Expression,
        before: number,
    ): void {
        const candidates = new Map<ts.Symbol, ts.VariableDeclaration>();
        const belongsToCallback = (declaration: ts.Node): boolean => {
            let current: ts.Node | undefined = declaration;
            while (current) {
                if (current === callback) return true;
                current = current.parent;
            }
            return false;
        };
        const visit = (node: ts.Node): void => {
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
                    !belongsToCallback(declaration) &&
                    !this.lookupOptional(declaration.name)
                ) {
                    candidates.set(symbol, declaration);
                }
            }
            ts.forEachChild(node, visit);
        };
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
    private compilePlatformCallback(
        callback: ts.Expression,
        parameter: { cppType: string; name: string } | undefined,
        values: readonly Value[],
        documentHiddenCpp?: string,
        once = false,
    ): string {
        const previousHidden = this.platformDocumentHiddenCpp;
        const previousFrameFloor = this.frameCallbackScopeFloor;
        if (this.frameCallbackDepth === 0) {
            this.frameCallbackScopeFloor =
                this.variableScopes.length;
        }
        this.platformDocumentHiddenCpp = documentHiddenCpp;
        this.frameCallbackDepth += 1;
        let lines: string[];
        try {
            lines = this.captureEmittedLines(() => {
                const unwrapped = this.unwrap(callback) as
                    | ts.Identifier
                    | ts.PropertyAccessExpression
                    | ts.ArrowFunction
                    | ts.FunctionExpression;
                const bound =
                    ts.isIdentifier(unwrapped)
                        ? this.lookupOptional(unwrapped)
                        : ts.isPropertyAccessExpression(unwrapped)
                          ? this.compileValue(unwrapped)
                          : undefined;
                const declaration =
                    bound?.kind === "callback" &&
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
                const result = bound?.callbackRecordOwner
                    ? this.withRecordScopes(
                          bound.callbackRecordOwner,
                          compile,
                      )
                    : compile();
                if (result.cpp.length > 0) {
                    this.emit(
                        result.requiresExplicitDiscard
                            ? `static_cast<void>(${result.cpp});`
                            : `${result.cpp};`,
                    );
                }
            });
        } finally {
            this.frameCallbackDepth -= 1;
            this.platformDocumentHiddenCpp = previousHidden;
            this.frameCallbackScopeFloor = previousFrameFloor;
        }
        const onceName = once
            ? this.allocateTemporaryCppName("event_once")
            : undefined;
        const cppParameter = parameter
            ? `[[maybe_unused]] ${parameter.cppType} ${parameter.name}`
            : "";
        const prefix = onceName
            ? `            if (${onceName}) return;\n            ${onceName} = true;\n`
            : "";
        return `[&${onceName ? `, ${onceName} = false` : ""}](${cppParameter})${onceName ? " mutable" : ""} {\n${prefix}${lines
            .map((line) => `            ${line}`)
            .join("\n")}\n        }`;
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
        return Boolean(
            returned && this.browserErasure.isFrameYield(returned),
        );
    }

    public frameDrainCondition(
        expression: ts.Expression,
    ): ts.Expression | undefined {
        return this.browserErasure.frameDrainCondition(expression);
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

    public lookupOptional(
        identifier: ts.Identifier,
    ): Value | undefined {
        const symbol =
            this.symbols.valueSymbol(identifier);
        if (!symbol) {
            return undefined;
        }
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            const binding =
                this.variableScopes[index]!.get(symbol);
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
                this.refusePoisonedRebind(identifier, binding);
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

    private lookupRecordProperty(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        if (
            ts.isPropertyAccessExpression(
                expression.expression,
            )
        ) {
            // A path resolves one link at a time, through this same
            // non-throwing lookup: an owner nobody here can name is
            // still the data lowerer's to try, not an error.
            const nested = this.lookupRecordProperty(
                expression.expression,
            );
            return nested
                ? this.readOwnerProperty(
                      nested,
                      expression,
                  )
                : undefined;
        }
        if (!ts.isIdentifier(expression.expression)) {
            return undefined;
        }
        const owner = this.lookupOptional(
            expression.expression,
        ) ?? (() => {
            const resolved =
                this.resolveStaticExpression(
                    expression.expression,
                );
            return resolved !== expression.expression
                ? this.compileValue(resolved)
                : undefined;
        })();
        return owner
            ? this.readOwnerProperty(owner, expression)
            : undefined;
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
        if (!owner || owner.kind === "data") {
            return undefined;
        }
        // Through the same single funnel every other read uses, so this
        // does not become a third reader of the table.
        const declared = this.readOwnerProperty(
            owner,
            expression,
        );
        return declared?.dataType ? declared : undefined;
    }

    public readResolvedProperty(
        owner: Value,
        expression: ts.PropertyAccessExpression,
    ): Value | undefined {
        return this.readOwnerProperty(owner, expression);
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
        const staticProperty = owner.recordProperties?.[
            expression.name.text
        ];
        if (staticProperty) {
            // A materialized record can still carry an exact value for a
            // property produced during static iteration. Prefer that fact
            // over reconstructing the field from its wider declared type
            // (notably `boolean | undefined`), just as a plain record does.
            return staticProperty;
        }
        if (owner.kind === "record") {
            return undefined;
        }
        if (owner.kind === "data") {
            const dataProperty =
                this.dataLowerer.compilePropertyFromValue(
                    owner,
                    expression,
                );
            if (dataProperty) {
                return dataProperty;
            }
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
        if (
            owner.kind === "tuple" &&
            expression.name.text === "length"
        ) {
            const length =
                owner.tupleElements?.length ?? 0;
            return {
                kind: "number",
                cpp: `${length}.0f`,
                staticNumber: length,
            };
        }
        if (
            owner.kind === "string" &&
            expression.name.text === "length"
        ) {
            const length = owner.staticString?.length;
            return {
                kind: "number",
                cpp: length === undefined
                    ? `static_cast<double>(${owner.cpp}.size())`
                    : doubleLiteral(length),
                ...(length === undefined ? {} : { staticNumber: length }),
                dataType: { kind: "number" },
            };
        }
        if (
            owner.kind === "engine" &&
            expression.name.text === "msaaSamples"
        ) {
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
            owner.kind === "camera" &&
            (expression.name.text === "position" ||
                expression.name.text === "target")
        ) {
            // Not a field but three of them: the record this synthesizes
            // is what makes `camera.position.x`, `camera.target.x`, and
            // destructuring either vector read the same components.
            const record = `${this.requireEngine(owner, expression)}.cameras[${owner.cpp}.value]`;
            const vector = expression.name.text;
            const component = (
                name: "x" | "y" | "z",
            ): Value => ({
                kind: "number",
                cpp: `${record}.${vector}.${name}`,
                dataType: { kind: "number" },
                ...(owner.engineCpp
                    ? { engineCpp: owner.engineCpp }
                    : {}),
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
        if (
            (owner.kind === "mesh" || owner.kind === "transform-node") &&
            isTrsVectorName(expression.name.text)
        ) {
            const engine = this.requireEngine(owner, expression);
            const collection =
                owner.kind === "mesh" ? "meshes" : "transform_nodes";
            const field = expression.name.text;
            const component = (name: "x" | "y" | "z"): Value => ({
                kind: "number",
                cpp:
                    `${engine}.${collection}[${owner.cpp}.value].` +
                    `${field}.${name}`,
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
            // composite's output is its last pass's, which is what the pin
            // assigns to `outputTexture` at the end of its own `record`.
            return {
                kind: "render-target",
                cpp: `${this.requireEngine(owner, expression)}.frame_tasks[${owner.cpp}.value].post_process.passes.back().output_target`,
                ...(owner.engineCpp
                    ? { engineCpp: owner.engineCpp }
                    : {}),
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
        const engineCpp = owner.engineCpp
            ? { engineCpp: owner.engineCpp }
            : {};
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
        const geometryProperties: Record<
            string,
            GeometryTextureTypeName
        > = {
            geometryIrradianceTexture: "IRRADIANCE",
            geometryWorldPositionTexture: "WORLD_POSITION",
            geometryLocalPositionTexture: "LOCAL_POSITION",
            geometryReflectivityTexture: "REFLECTIVITY",
            geometryViewDepthTexture: "VIEW_DEPTH",
            geometryNormalizedViewDepthTexture:
                "NORMALIZED_VIEW_DEPTH",
            geometryScreenspaceDepthTexture:
                "SCREENSPACE_DEPTH",
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
            this.fail(
                expression,
                `Geometry task did not request ${type}.`,
            );
        }
        return {
            kind: "render-texture",
            cpp: `bbl::geometry_task_texture(${owner.cpp}, bbl::GeometryTextureType::${geometryEnumMember(type)})`,
            renderTextureSource: "geometry",
            ...engineCpp,
        };
    }

    public unwrap(expression: ts.Expression): ts.Expression {
        let current = expression;
        while (
            ts.isAwaitExpression(current) ||
            ts.isParenthesizedExpression(current) ||
            ts.isAsExpression(current) ||
            ts.isTypeAssertionExpression(current) ||
            ts.isNonNullExpression(current)
        ) {
            if (ts.isAwaitExpression(current)) {
                this.unwrappedAwaitExpressions.add(current.pos);
            }
            current = current.expression;
        }
        return current;
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
        const symbol =
            this.symbols.valueSymbol(identifier);
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
            const binding =
                this.variableScopes[index]!.get(symbol);
            if (binding) {
                this.refuseDeadDeferredCapture(
                    identifier,
                    index,
                    binding.frameLocal === true,
                );
                this.refusePoisonedRebind(identifier, binding);
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
    public rebindVariable(
        identifier: ts.Identifier,
        value: Value,
    ): void {
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
        const rebound = {
            ...binding,
            value: { ...value, cpp: binding.value.cpp },
        };
        if (owner === innermost) {
            owner.set(symbol, rebound);
            return;
        }
        owner.set(symbol, {
            ...binding,
            reboundInNestedScope: true,
        });
        innermost.set(symbol, rebound);
    }

    public defineVariable(
        identifier: ts.Identifier,
        value: Value,
    ): void {
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
            ...(this.frameCallbackDepth > 0
                ? { frameLocal: true }
                : {}),
        });
        const continuationStorage =
            value.optionalStorageCpp ?? value.cpp;
        if (
            this.engineStartMark &&
            this.indentLevel ===
                this.engineStartMark.indentLevel &&
            /^v_[A-Za-z0-9_]+$/.test(continuationStorage)
        ) {
            this.engineContinuationStorage.add(
                continuationStorage,
            );
        }
    }

    public bindLocalValue(
        identifier: ts.Identifier,
        value: Value,
    ): void {
        this.bindLocalOrParameterValue(
            identifier,
            value,
            false,
        );
    }

    public bindCompileTimeValue(
        identifier: ts.Identifier,
        value: Value,
    ): void {
        this.defineVariable(identifier, value);
    }

    public materializeStaticNativeValue(
        identifier: ts.Identifier,
        value: Value,
    ): Value {
        const existing = this.lookupOptional(identifier);
        if (existing) return existing;
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.fail(identifier, `Unable to resolve variable '${identifier.text}'.`);
        }
        const cppName = this.cppIdentifier(identifier.text);
        this.staticNativeDeclarations.push(
            `auto ${cppName} = ${value.cpp};`,
        );
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
    public bindParameterValue(
        identifier: ts.Identifier,
        value: Value,
    ): void {
        const narrowed =
            value.kind === "data"
                ? this.dataLowerer.narrowForDeclaration(
                      value,
                      identifier,
                  )
                : value;
        this.bindLocalOrParameterValue(
            identifier,
            narrowed,
            true,
        );
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
        let dataType =
            this.dataLowerer.dataTypeAt(identifier);
        if (dataType?.kind === "struct") {
            dataType = this.dataTypes.markStoredObjectReferences(dataType);
        }
        if (!dataType || dataType.kind === "handle") {
            return this.compileValue(argument);
        }
        if (dataType.kind === "function") {
            const unwrappedCallback = this.unwrap(argument);
            const bound = ts.isIdentifier(unwrappedCallback)
                ? this.lookupOptional(unwrappedCallback)
                : undefined;
            const declaration = !bound && ts.isIdentifier(unwrappedCallback)
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
                          recordScopes: [
                              ...this.variableScopes,
                          ],
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
        if (
            (dataType.kind === "struct" ||
                (dataType.kind === "vector" &&
                    dataType.element.kind === "struct")) &&
            (ts.isIdentifier(unwrapped) ||
                ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped))
        ) {
            const actual = this.compileValue(unwrapped);
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
        }
        const cpp = this.dataLowerer.compileForSink(
            argument,
            dataType,
        );
        return this.dataLowerer.leafValue(cpp, dataType);
    }

    /** Materialize scalar members when a compile-time value escapes. */
    public materializeEscapingValue(
        value: Value,
        label: string,
    ): Value {
        if (value.kind === "record") {
            return this.materializeRecordScalars(value, label, true);
        }
        if (value.kind === "tuple" && value.tupleElements) {
            return {
                ...value,
                tupleElements: value.tupleElements.map((element, index) =>
                    this.materializeEscapingValue(
                        element,
                        `${label}_${index}`,
                    ),
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
    public pinValueToTemporary(value: Value, label: string): Value {
        if (value.kind === "record") {
            return this.materializeRecordScalars(value, label, true);
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
                : value.kind === "boolean" &&
                    value.staticBoolean === undefined
                  ? "bool"
                  : undefined;
        if (!cppType) return value;
        const cppName = this.allocateTemporaryCppName(label);
        this.emit(`const ${cppType} ${cppName} = ${value.cpp};`);
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
    public bindDataTuple(
        value: Value,
        arity: number,
        label = "tuple",
    ): string {
        const cppName = this.allocateTemporaryCppName(label);
        this.emit(
            `const ${this.dataTypes.cppType({
                kind: "tuple",
                arity,
            })} ${cppName} = ${value.cpp};`,
        );
        return cppName;
    }

    /** Materialize scalar members when a compile-time record escapes. */
    private materializeRecordScalars(
        record: Value,
        label: string,
        preserveIdentity = false,
    ): Value {
        const properties: Record<string, Value> = {};
        for (const [name, property] of Object.entries(
            record.recordProperties ?? {},
        )) {
            if (property.kind === "record") {
                properties[name] = this.materializeRecordScalars(
                    property,
                    `${label}_${name}`,
                    preserveIdentity,
                );
                continue;
            }
            const cppName = this.allocateTemporaryCppName(
                `${label}_${name}`,
            );
            if (property.kind === "number") {
                const {
                    staticNumber: _staticNumber,
                    ...dynamicProperty
                } = property;
                this.emit(
                    `[[maybe_unused]] double ${cppName} = ${
                        property.staticNumber === undefined
                            ? property.cpp
                            : doubleLiteral(property.staticNumber)
                    };`,
                );
                properties[name] = {
                    ...dynamicProperty,
                    cpp: cppName,
                };
                continue;
            }
            if (property.kind === "boolean") {
                this.emit(
                    `[[maybe_unused]] bool ${cppName} = ${property.cpp};`,
                );
                properties[name] = {
                    ...property,
                    cpp: cppName,
                };
                continue;
            }
            if (property.staticString !== undefined) {
                this.emit(
                    `[[maybe_unused]] std::string ${cppName} = ${this.cppString(property.staticString)};`,
                );
                properties[name] = {
                    kind: "data",
                    cpp: cppName,
                    dataType: { kind: "string" },
                    staticString: property.staticString,
                };
                continue;
            }
            properties[name] = property;
        }
        if (preserveIdentity) {
            record.recordProperties = properties;
            return record;
        }
        return { ...record, recordProperties: properties };
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
    ): Value {
        const callable = ts.isFunctionDeclaration(declaration)
            ? declaration.name ??
              this.fail(
                  declaration,
                  "Callback function declarations require a name.",
              )
            : declaration;
        return this.userFunctions.compileCallbackWithValues(
            this,
            callable,
            arguments_,
            callNode,
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
        const compile = (): string =>
            this.userFunctions.compileStoredDataFunction(
                this,
                expression,
                dataType,
            );
        return owner ? this.withRecordScopes(owner, compile) : compile();
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
    public compilePhysicsCollisionCallback(
        expression: ts.Expression,
    ): string {
        const callback = this.unwrap(expression);
        if (
            !ts.isIdentifier(callback) &&
            !ts.isArrowFunction(callback) &&
            !ts.isFunctionExpression(callback)
        ) {
            this.fail(
                callback,
                "Physics collision callbacks must be a local function or function literal.",
            );
        }
        const event = this.allocateTemporaryCppName("physics_collision");
        const callbackName = this.allocateTemporaryCppName(
            "physics_collision_callback",
        );
        this.reachJsData();
        this.emit(
            `std::function<void(const bbl::upstream::PhysicsCollisionInfo&)> ${callbackName};`,
        );
        this.deferredPhysicsCallbacks.push({
            callback,
            cppName: callbackName,
            eventName: event,
            node: expression,
            scopes: this.variableScopes.map((scope) => new Map(scope)),
        });
        return (
            `[&](const bbl::upstream::PhysicsCollisionInfo& ${event}) { ` +
            `if (${callbackName}) { ${callbackName}(${event}); } }`
        );
    }

    /** Emit deferred collision bodies immediately before the engine starts. */
    private emitDeferredPhysicsCallbacks(): void {
        if (this.deferredPhysicsCallbacks.length === 0) return;
        const emitted: string[] = [];
        for (const deferred of this.deferredPhysicsCallbacks) {
            const savedScopes = [...this.variableScopes];
            this.variableScopes.length = 0;
            this.variableScopes.push(...deferred.scopes);
            const event = deferred.eventName;
            const vec3 = (member: string): Value => ({
                kind: "record",
                cpp: "",
                recordProperties: {
                    x: { kind: "number", cpp: `${event}.${member}.x` },
                    y: { kind: "number", cpp: `${event}.${member}.y` },
                    z: { kind: "number", cpp: `${event}.${member}.z` },
                },
            });
            const info: Value = {
                kind: "record",
                cpp: "",
                recordProperties: {
                    type: {
                        kind: "data",
                        cpp:
                            `std::string(bbl::upstream::physics_collision_type_name(` +
                            `${event}.type))`,
                        dataType: { kind: "string" },
                    },
                    point: vec3("point"),
                    normal: vec3("normal"),
                    impulse: { kind: "number", cpp: `${event}.impulse` },
                },
            };
            const previousDepth = this.frameCallbackDepth;
            this.frameCallbackDepth += 1;
            try {
                const lines = this.captureEmittedLines(() => {
                    const result = this.compileCallbackWithValues(
                        deferred.callback,
                        [info],
                        deferred.node,
                    );
                    if (result.cpp.length > 0) {
                        this.emit(
                            result.requiresExplicitDiscard
                                ? `static_cast<void>(${result.cpp});`
                                : `${result.cpp};`,
                        );
                    }
                });
                const indent = "    ".repeat(2);
                // The signature is the pin's, so the parameter stays whether
                // the body reads it or not -- scene 100's collision handler
                // logs and writes a dataset flag, both of which erase, so it
                // reads nothing at all. Announced unused unconditionally, as
                // `compileFrameCallback` announces its delta.
                emitted.push(
                    `${indent}${deferred.cppName} = [&]([[maybe_unused]] const bbl::upstream::PhysicsCollisionInfo& ${event}) {`,
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
    ): void {
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
        const cppName =
            explicitCppName ??
            this.cppIdentifier(identifier.text);
        const reference =
            value.kind === "engine" ||
            value.kind === "scene";
        const copiesHandle =
            parameter &&
            (this.dataLowerer.dataTypeAt(identifier)?.kind ===
                "handle" ||
                isHandleKind(value.kind));
        const nativeType = reference
            ? "auto&"
            : value.kind === "number"
              ? "double"
              : value.kind === "boolean"
                ? "bool"
                : value.kind === "data" &&
                    value.dataType?.kind === "string"
                  ? "std::string"
                : parameter && !copiesHandle
                  ? "auto&&"
                  : "auto";
        const initializerCpp =
            value.kind === "number" &&
            value.staticNumber !== undefined
                ? doubleLiteral(value.staticNumber)
                : value.cpp;
        const maybeUnused =
            value.kind === "boolean" || parameter
                ? "[[maybe_unused]] "
                : "";
        this.emit(
            `${maybeUnused}${nativeType} ${cppName} = ${initializerCpp};`,
        );
        const stored: Value = {
            ...value,
            cpp: cppName,
            ...(parameter ? { parameterBinding: true } : {}),
            ...(!parameter ? { nativeBinding: true } : {}),
            ...(parameter && value.staticElements
                ? {
                      staticElementsOwner:
                          value.staticElementsOwner ?? value,
                  }
                : {}),
        };
        if (
            value.kind === "data" &&
            value.dataType?.kind === "struct" &&
            this.dataTypes.isReferenceStruct(value.dataType.name)
        ) {
            stored.objectIdentityCpp = `${cppName}.get()`;
        }
        if (value.kind === "animation-clip") {
            stored.animationFrameRate =
                `${cppName}.frame_rate`;
            stored.animationDuration =
                `${cppName}.duration`;
        }
        this.defineVariable(identifier, stored);
    }

    private visibleValues(): Value[] {
        const names = new Set<string>();
        const result: Value[] = [];
        for (
            let index = this.variableScopes.length - 1;
            index >= 0;
            index -= 1
        ) {
            for (const binding of this.variableScopes[
                index
            ]!.values()) {
                if (!names.has(binding.name)) {
                    names.add(binding.name);
                    result.push(binding.value);
                }
            }
        }
        return result;
    }

    /** Visit bindings and the generation facts nested inside their values. */
    private visitScopedValues(visitor: (value: Value) => void): void {
        const seen = new Set<Value>();
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
    public invalidateStaticElements(value: Value): void {
        const owner = value.staticElementsOwner ?? value;
        const elements = owner.staticElements ?? value.staticElements;
        const invalidate = (candidate: Value): void => {
            if (
                candidate === value ||
                candidate === owner ||
                candidate.staticElementsOwner === owner ||
                (elements !== undefined && candidate.staticElements === elements)
            ) {
                delete candidate.staticElements;
                delete candidate.staticElementsOwner;
            }
        };
        this.visitScopedValues(invalidate);
        invalidate(value);
        invalidate(owner);
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

    public pushScope(cppPrefix: string): void {
        this.variableScopes.push(new Map());
        this.cppNamePrefixes.push(cppPrefix);
    }

    public popScope(): void {
        if (this.variableScopes.length === 1) {
            throw new Error(
                "Cannot pop the compiler root scope.",
            );
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
        if (left.engineCpp && right.engineCpp && left.engineCpp !== right.engineCpp) {
            this.fail(node, "Values from different engines cannot be combined.");
        }
    }

    public requireEngine(value: Value, node: ts.Node): string {
        if (!value.engineCpp) {
            this.fail(node, `A ${value.kind} value is not associated with an engine.`);
        }
        return value.engineCpp;
    }

    public requireDefaultEngine(node: ts.Node): string {
        if (!this.defaultEngineCpp) {
            this.fail(node, "This intrinsic requires createEngine to run first.");
        }
        return this.defaultEngineCpp;
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

    public recordScenePbrNoColorView(
        sourceIndex: number | undefined,
    ): number {
        this.sceneMaterialGltfAssetsBefore.push(
            this.currentGltfAssetCount(),
        );
        return this.sceneMaterials.recordScenePbrNoColorView(
            sourceIndex,
        );
    }

    public recordSceneMaterialSlot(): number {
        this.sceneMaterialGltfAssetsBefore.push(
            this.currentGltfAssetCount(),
        );
        return this.sceneMaterials.recordSceneMaterialSlot();
    }

    public currentGltfAssetCount(): number {
        return [...this.assets.values()]
            .filter((asset) => asset.kind === "gltf")
            .reduce(
                (count, asset) =>
                    count + (asset.containerCount ?? 0),
                0,
            );
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

    public recordScenePbrPlugins(
        plugins: readonly MaterialPluginManifest[],
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrPlugins(plugins, index);
    }

    public recordStandardMaterialPlugins(
        plugins: readonly MaterialPluginManifest[],
    ): number {
        return this.sceneMaterials.recordStandardMaterialPlugins(plugins);
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
        this.sceneMaterials.recordScenePbrClearCoat(
            clearCoat,
            index,
        );
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
        this.sceneMaterials.recordScenePbrIridescence(
            iridescence,
            index,
        );
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
        if (containers.length !== 1 || (containers[0]!.containerCount ?? 0) > 1) {
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
        this.sceneMaterials.recordScenePbrSubsurface(
            subsurface,
            index,
        );
    }

    public recordScenePbrAnisotropy(
        anisotropy: ScenePbrAnisotropyManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterials.recordScenePbrAnisotropy(
            anisotropy,
            index,
        );
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
    public recordSpriteCustomShader(
        shader: SpriteCustomShaderManifest,
    ): void {
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
        entry: Omit<ShadowGeneratorManifest, "casters">,
    ): number {
        this.shadowGenerators.push({ ...entry, casters: [] });
        return this.shadowGenerators.length - 1;
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
        if (sceneMeshIndex === undefined) return;
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
            const program = this.reachedShaderProgram(
                variant,
                this.sourceFile,
            );
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
            sceneShaderVariant?: string | undefined;
        },
    ): void {
        this.sceneMeshMaterials.set(meshIndex, {
            pbrMaterial: material.pbrMaterial,
            nodeMaterial: material.nodeMaterial,
        });
        if (material.standardMaterial) {
            const mesh = this.sceneMeshes[meshIndex];
            if (mesh) mesh.standardMaterial = true;
        }
        if (material.sceneShaderVariant !== undefined) {
            const mesh = this.sceneMeshes[meshIndex];
            if (mesh) mesh.shaderVariant = material.sceneShaderVariant;
        }
        if (material.pbrMaterial !== null) {
            const meshes = this.scenePbrMaterialMeshes.get(
                material.pbrMaterial,
            ) ?? new Set<number>();
            meshes.add(meshIndex);
            this.scenePbrMaterialMeshes.set(material.pbrMaterial, meshes);
        }
    }

    /** A material assignment reached a mesh handle not tied to one static
     *  scene-mesh row (for example an imported collection element). */
    public recordUnknownSceneMeshMaterial(materialIndex: number): void {
        this.scenePbrMaterialsWithUnknownMesh.add(materialIndex);
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

    public recordShadowCasters(
        generatorIndex: number,
        casters: readonly ShadowCasterManifest[],
    ): void {
        const generator = this.shadowGenerators[generatorIndex];
        if (!generator) {
            throw new Error(
                `Shadow generator ${generatorIndex} was never recorded.`,
            );
        }
        generator.casters = [...casters];
    }

    public shadowGeneratorHasRecordedCasters(generatorIndex: number): boolean {
        const generator = this.shadowGenerators[generatorIndex];
        return Boolean(
            generator &&
                (generator.casters.length > 0 || generator.dynamicCasters),
        );
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
    public recordSceneMeshId(
        meshCpp: string,
        id: string,
        node: ts.Node,
    ): void {
        const previous = this.sceneMeshIdByHandle.get(meshCpp);
        if (previous === id) return;
        const stale = this.resolvedLightMeshIds.has(id)
            ? id
            : previous !== undefined &&
                this.resolvedLightMeshIds.has(previous)
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
        for (const id of new Set(ids)) {
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
    public addSceneLight(light: Value, kind: LightKind): void {
        const identity = light.lightIdentity;
        if (!identity) {
            throw new Error("A scene light is missing its compiler identity.");
        }
        const index = this.sceneLights.length;
        this.sceneLights.push({ identity, kind });
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

    /** Remove a light and compact the slots exactly as Array.splice does. */
    public removeSceneLight(light: Value): void {
        const identity = light.lightIdentity;
        if (!identity) return;
        const index = this.sceneLights.findIndex(
            (entry) => entry.identity === identity,
        );
        if (index < 0) return;
        this.sceneLights.splice(index, 1);
        delete identity.sceneLightIndex;
        for (let slot = index; slot < this.sceneLights.length; slot++) {
            const moved = this.sceneLights[slot]!.identity;
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

    /** Records a scene-code mesh creation for the per-renderable variant key. */
    public recordSceneMesh(
        kind: string,
        streams?: {
            hasUv2: boolean;
            hasTangents: boolean;
            hasColors: boolean;
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

    public reachFeature(feature: Feature, site?: ts.Node): void {
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
            const { file, line } = sourceLocation(site);
            const fileName =
                file === this.sourceFile
                    ? this.options.fileName
                    : file.fileName;
            this.featureSites.set(feature, `${fileName}:${line}`);
        }
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
    ): string | undefined {
        if (
            !scene.defaultRenderTask ||
            scene.defaultRenderTaskEmitted
        ) {
            return undefined;
        }
        scene.defaultRenderTaskEmitted = true;
        this.defaultRenderTaskAdapted = true;
        const engine = this.requireEngine(scene, node);
        this.reachFeature("renderer:scene", node);
        this.reachFeature("renderer:geometry-output", node);
        this.reachFeature("frame-graph:resources", node);
        const target =
            this.allocateTemporaryCppName(
                "default_target",
            );
        const resolveTarget =
            this.allocateTemporaryCppName(
                "default_resolve",
            );
        const renderTask =
            this.allocateTemporaryCppName(
                "default_render_task",
            );
        const resolveTask =
            this.allocateTemporaryCppName(
                "default_resolve_task",
            );
        const presentTask =
            this.allocateTemporaryCppName(
                "default_present_task",
            );
        return (
            `auto ${target} = bbl::create_render_target(${engine}, ` +
            `bbl::RenderTargetOptions{${scene.msaaSamples ?? 4}u, true, true, false, 0u, 0u});\n` +
            `        auto ${resolveTarget} = bbl::create_render_target(${engine}, ` +
            `bbl::RenderTargetOptions{1u, true, false, false, 0u, 0u});\n` +
            `        auto ${renderTask} = bbl::create_render_task(${engine}, ${scene.cpp}, ` +
            `bbl::RenderTaskOptions{"default-render-task", ` +
            `${target}, ` +
            `${scene.cpp}.clear_color, true, ` +
            `bbl::CameraHandle{}, false, true, true, true});\n` +
            `        bbl::add_task(${scene.cpp}, ${renderTask});\n` +
            `        auto ${resolveTask} = bbl::create_copy_to_texture_task(${engine}, ${scene.cpp}, ` +
            `bbl::CopyTaskOptions{"default-resolve", ` +
            `bbl::render_target_texture(${target}), ` +
            `bbl::RenderTargetHandle{}, ${resolveTarget}, false, ` +
            `bbl::NormalizedViewport{}});\n` +
            `        bbl::add_task(${scene.cpp}, ${resolveTask});\n` +
            `        auto ${presentTask} = bbl::create_copy_to_texture_task(${engine}, ${scene.cpp}, ` +
            `bbl::CopyTaskOptions{"default-present", ` +
            `bbl::render_target_texture(${resolveTarget}), ` +
            `bbl::swapchain_render_target(${engine}), ` +
            `bbl::RenderTargetHandle{}, false, ` +
            `bbl::NormalizedViewport{}});\n` +
            `        bbl::add_task(${scene.cpp}, ${presentTask})`
        );
    }

    public importedName(
        identifier: ts.Identifier,
    ): string | undefined {
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
        const visitedFunctions = new Set<ts.Node>();
        let required = false;
        const visitFunction = (node: ts.Node): void => {
            if (visitedFunctions.has(node)) return;
            visitedFunctions.add(node);
            if (
                (ts.isFunctionDeclaration(node) ||
                    ts.isFunctionExpression(node) ||
                    ts.isArrowFunction(node) ||
                    ts.isMethodDeclaration(node)) &&
                node.body
            ) {
                visit(node.body);
            }
        };
        const visit = (node: ts.Node): void => {
            if (required) return;
            if (ts.isCallExpression(node)) {
                const callee = this.unwrap(node.expression);
                if (ts.isIdentifier(callee)) {
                    const imported = this.symbols.importedName(callee);
                    if (
                        imported !== undefined &&
                        !runtimeOnlyIntrinsics.has(imported)
                    ) {
                        required = true;
                        return;
                    }
                    if (imported !== undefined) return;
                    for (const declaration of
                        this.symbols.valueSymbol(callee)?.declarations ?? []) {
                        if (ts.isVariableDeclaration(declaration)) {
                            const initializer = declaration.initializer;
                            if (
                                initializer &&
                                (ts.isFunctionExpression(initializer) ||
                                    ts.isArrowFunction(initializer))
                            ) {
                                visitFunction(initializer);
                            }
                        } else {
                            visitFunction(declaration);
                        }
                    }
                }
            }
            ts.forEachChild(node, (child) => {
                if (!ts.isFunctionLike(child)) visit(child);
            });
        };
        visit(statement);
        return required;
    }

    public eraseBrowserInstrumentation(
        position: number,
    ): void {
        this.erasedBrowserInstrumentation.add(position);
    }

    public recordGeometryOutputTask(
        manifest: GeometryOutputTaskManifest,
    ): void {
        this.geometryOutputTasks.push(manifest);
    }

    public recordPostProcessTask(
        manifest: PostProcessTaskManifest,
    ): void {
        this.postProcessTasks.push(manifest);
    }

    public recordPostProcessComposite(
        manifest: PostProcessCompositeManifest,
    ): void {
        this.postProcessComposites.push(manifest);
    }

    public requireDefaultScene(node: ts.Node): Value {
        const scenes = this.visibleValues().filter(
            (value) => value.kind === "scene",
        );
        if (scenes.length !== 1) {
            this.fail(
                node,
                "This intrinsic requires exactly one scene context.",
            );
        }
        return scenes[0]!;
    }

    public expectArgumentCount(call: ts.CallExpression, minimum: number, maximum: number): void {
        if (call.arguments.length < minimum || call.arguments.length > maximum) {
            const expected = minimum === maximum ? `${minimum}` : `${minimum}-${maximum}`;
            this.fail(call, `Expected ${expected} arguments, received ${call.arguments.length}.`);
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

    public emit(line: string): void {
        this.body.push(`${"    ".repeat(this.indentLevel)}${line}`);
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

    /** Native locals initialized by the post-start continuation. */
    private readonly engineContinuationStorage = new Set<string>();

    public markEngineStart(
        engineCpp: string,
        node: ts.Node,
    ): void {
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

    /**
     * Move everything after `bbl::start_engine(...)` into the callback the
     * conductor runs at the next frame boundary, registered before the loop
     * starts. A scene whose body ends at `startEngine` -- every scene that
     * shipped before this contract -- has an empty continuation and emits
     * exactly what it emitted before.
     *
     * A frame-yield marker in the tail cuts it: the statements after the
     * yield become a nested `defer_start_continuation`, queued while the
     * conductor is draining and therefore run at the NEXT frame's drain --
     * one elapsed frame per yield, with `pending_start_continuations` held
     * above zero until the innermost part has run, so a capture cannot
     * land before the whole continuation has.
     */
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
            (line) =>
                line.trim().length > 0 && depth(line) < startDepth,
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
        const unpersistedStorage = new Set(
            this.engineContinuationStorage,
        );
        const persistentTail = tail.map((line) => {
            if (depth(line) !== startDepth) return line;
            const storage = [...unpersistedStorage].find(
                (name) =>
                    new RegExp(
                        `\\b${name}\\b\\s*(?:=|;)`,
                    ).test(line.split(/\r?\n/, 1)[0]!),
            );
            if (!storage) return line;
            // Only the declaration owns storage duration. A later assignment
            // to the same continuation local must remain an assignment.
            unpersistedStorage.delete(storage);
            const leading = line.slice(
                0,
                line.length - line.trimStart().length,
            );
            const declaration = line.trimStart();
            if (declaration.startsWith("[[")) {
                const attributeEnd = declaration.indexOf("]]", 2);
                if (attributeEnd >= 0) {
                    return (
                        leading +
                        declaration.slice(0, attributeEnd + 2) +
                        " static" +
                        declaration.slice(attributeEnd + 2)
                    );
                }
            }
            return `${leading}static ${declaration}`;
        });
        // Cut the tail at each frame-yield marker. Building from the
        // innermost part outward nests each later part inside the one
        // before it, so a part's statics stay lexically visible to
        // everything after its yield. The outer hoist is part 0's own
        // wrap, so the loop runs down to it and the deferred-callback
        // shape is emitted in exactly one place.
        const parts: string[][] = [[]];
        for (const line of persistentTail) {
            if (line.trim() === Compiler.frameYieldRequeueMarker) {
                parts.push([]);
            } else {
                parts.at(-1)!.push(line);
            }
        }
        let nested: string[] = [];
        // Each part re-indents everything already nested inside it, so
        // indenting unconditionally makes the emitted whitespace quadratic
        // in the number of frame boundaries: a 160-yield continuation
        // reaches 115 KB, 92% of it leading spaces. Past a depth no
        // reached scene comes near, the nesting stops adding columns and
        // the text stays linear. The deepest continuation any registered
        // scene emits is six levels, so this moves no emitted byte today.
        const maxIndentedDepth = 8;
        for (let part = parts.length - 1; part >= 0; part -= 1) {
            const step = parts.length - part <= maxIndentedDepth ? "    " : "";
            nested = [
                `${indent}bbl::defer_start_continuation(` +
                    `${mark.engine}, [&]() {`,
                ...[...parts[part]!, ...nested].map(
                    (line) => `${step}${line}`,
                ),
                `${indent}});`,
            ];
        }
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
    }

    public decreaseIndent(): void {
        this.indentLevel -= 1;
    }

    private renderCpp(features: Feature[]): string {
        this.hoistEngineContinuation();
        if (
            this.body.some(
                (line) =>
                    line.trim() ===
                    Compiler.frameYieldRequeueMarker,
            )
        ) {
            this.failAtFile(
                "A frame-yield re-queue marker survived outside the " +
                    "hoisted continuation; the frame boundary it parks " +
                    "the rest of the continuation behind was never " +
                    "emitted.",
            );
        }
        this.markUnreadNumericLocals();
        return renderMainCpp({
            features,
            jsDataReached: this.jsDataReached,
            imageDecodeReached: this.imageDecodeReached,
            jsRandomReached: this.jsRandomReached,
            throwReached: this.throwReached,
            postProcessCompositeCount:
                this.postProcessComposites.length,
            renderDataPreamble: () =>
                this.dataTypes.renderPreamble(),
            nativeFunctionPrototypes:
                this.nativeFunctionPrototypes,
            nativeFunctionDefinitions:
                this.nativeFunctionDefinitions,
            staticNativeDeclarations:
                this.staticNativeDeclarations,
            voxelFileStorageReached: this.voxelFileStorageReached,
            body: this.body,
        });
    }

    private renderCmake(features: Feature[], runtimeSources: string[], generatedSources: string[]): string {
        return renderFeaturesCmake(features, runtimeSources, generatedSources);
    }

    public fail(node: ts.Node, message: string): never {
        const { file, line, character } = sourceLocation(node);
        throw new CompileError(
            file === this.sourceFile
                ? this.options.fileName
                : file.fileName,
            line,
            character,
            message,
        );
    }

    private failAtFile(message: string): never {
        throw new CompileError(this.options.fileName, 1, 1, message);
    }
}
