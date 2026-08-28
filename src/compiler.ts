import ts from "typescript";
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
    type AssignmentContext,
} from "./compiler/assignments.js";
import {
    registerAsset,
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
import {
    compileEnvironmentOptions,
    compileDdsEnvironmentOptions,
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
import { validateObjectProperties } from "./compiler/option-helpers.js";
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
    passesByReference,
    type DataIterationElement,
    type DataType,
} from "./compiler/data-types.js";
import {
    ExpressionLowerer,
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
    parameterIsReadOnly,
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
    SceneMeshManifest,
    ShadowCasterManifest,
    ShadowGeneratorManifest,
    ScenePbrClearCoatManifest,
    ScenePbrAnisotropyManifest,
    ScenePbrIridescenceManifest,
    ScenePbrMaterialManifest,
    ScenePbrMetallicReflectanceManifest,
    ScenePbrSheenManifest,
    ScenePbrSubsurfaceManifest,
    SplatFragmentManifest,
    SpriteCustomShaderManifest,
    EffectManifest,
    Value,
    ValueKind,
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
        },
    );
    return compiler.compile();
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
    private readonly expressions: ExpressionLowerer;
    private readonly nativeFunctionPrototypes: string[] =
        [];
    private readonly nativeFunctionDefinitions: string[] =
        [];
    private readonly returnFrames: Array<
        | { kind: "native"; type: DataType | "void" }
        | { kind: "inline"; wrapped: boolean }
    > = [];
    public jsDataReached = false;
    public jsRandomReached = false;
    /** Whether a scene threw one of its own preconditions. */
    public throwReached = false;
    private readonly staticConstants = new Map<
        ts.Symbol,
        ts.Expression
    >();
    private readonly sourceCppNames = new Set<string>();
    public readonly variableScopes: Array<
        Map<
            ts.Symbol,
            { name: string; value: Value }
        >
    > = [new Map()];
    private readonly cppNamePrefixes: string[] = [""];
    private readonly features = new Set<Feature>(["core"]);
    private readonly featureSites = new Map<Feature, string>();
    public readonly assets = new Map<string, CompileAsset>();
    public readonly assetPayloads = new Map<string, string>();
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
    public readonly erasedBrowserExpressions = new Set<number>();
    public readonly erasedBrowserInstrumentation = new Set<number>();
    public readonly unwrappedAwaitExpressions = new Set<number>();
    public readonly geometryOutputTasks: GeometryOutputTaskManifest[] = [];
    public readonly postProcessTasks: PostProcessTaskManifest[] = [];
    public readonly postProcessComposites: PostProcessCompositeManifest[] =
        [];
    private readonly sceneMaterials = new SceneMaterialRecorder();
    private readonly sceneMeshes: SceneMeshManifest[] = [];
    private readonly shadowGenerators: ShadowGeneratorManifest[] = [];
    private readonly shadowReceiverMeshes = new Set<number>();
    /** How many lights `addToScene` has added, which is their slot order. */
    private sceneLightCount = 0;
    private readonly sceneLightKinds: LightKind[] = [];
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
    private reachedPlainBillboardSystem = false;
    public hasMainEntry = false;
    private defaultEngineCpp: string | undefined;
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
        );
    }

    public compile(): CompileResult {
        this.collectSourceCppNames();
        this.collectStaticConstants();
        this.emitImportedModuleInitializers();
        for (const statement of this.entryStatements()) {
            this.emitStatement(statement);
        }
        assertDeterministicRandomUnreached(
            this,
            this.jsRandomReached,
            this.sourceFile,
        );

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
                features,
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
                sceneMeshes: this.sceneMeshes,
                sceneLightKinds: this.sceneLightKinds,
                dynamicSceneLights: this.dynamicSceneLights,
                mutableToneMappingEnabled: this.mutableToneMappingEnabled,
                shadowGenerators: this.shadowGenerators.map((generator) => ({
                    ...generator,
                    // The caster's material as the mesh finally carried it,
                    // which is what the pin's own lazy view lookup reads.
                    casters: generator.casters.map((caster) => ({
                        meshIndex: caster.meshIndex,
                        pbrMaterial: null,
                        nodeMaterial: null,
                        ...(this.sceneMeshMaterials.get(caster.meshIndex) ??
                            {}),
                    })),
                })),
                shadowReceiverMeshes: [
                    ...this.shadowReceiverMeshes,
                ].sort((left, right) => left - right),
                splatFragments: this.sceneSplatFragments ?? [],
                spriteCustomShaders: this.sceneSpriteCustomShaders,
                effects: this.reachedEffects_,
                plainSpriteLayer: this.reachedPlainSpriteLayer,
                plainBillboardSystem: this.reachedPlainBillboardSystem,
            },
        };
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

        const statements = this.sourceFile.statements.filter(
            (statement) =>
                !ts.isImportDeclaration(statement) &&
                !ts.isFunctionDeclaration(statement) &&
                !ts.isExportDeclaration(statement),
        );
        if (statements.length === 0) {
            this.failAtFile("Expected top-level scene statements or a function named main with a body.");
        }
        return statements;
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
        if (name?.endsWith("Node")) {
            return {
                kind: "audio-node",
                cppType: "bbl::pal::AudioNodeHandle",
            };
        }
        return undefined;
    }

    public emitExpressionAsStatement(
        expression: ts.Expression,
    ): void {
        this.statements.emitExpression(this, expression);
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
        const sourceName = declaration.name.text;
        const cppName = this.cppIdentifier(sourceName);
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
            this.emit(
                `${this.dataTypes.cppType(dataType)} ${cppName};`,
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
                    cppName,
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
            this.emit(
                `std::optional<${nullableResource.cppType}> ${cppName};`,
            );
            this.defineVariable(declaration.name, {
                kind: nullableResource.kind,
                cpp: `(*${cppName})`,
                optionalFoundCpp: `${cppName}.has_value()`,
                optionalStorageCpp: cppName,
            });
            return;
        }

        if (this.isBrowserOnlyExpression(declaration.initializer)) {
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

        const value = this.compileValue(declaration.initializer);
        if (value.impure) {
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
        if (value.kind === "void" || value.kind === "browser") {
            this.fail(declaration.initializer, `Expression assigned to '${sourceName}' does not produce a native value.`);
        }
        if (isCompileTimeOnlyValue(value.kind)) {
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
            // element/member binds a reference, so writes through it reach
            // the same storage as a JavaScript object binding.
            // `let` keeps the copy: a reference cannot be reseated.
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
                (ts.isIdentifier(initializer) ||
                    ts.isElementAccessExpression(initializer) ||
                    ts.isPropertyAccessExpression(
                        initializer,
                    )) &&
                // A value read out of a span is const, so it cannot be
                // bound by reference; the source language would not let
                // it be written through either.
                !narrowed.readOnly;
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
            this.emit(
                `${this.dataTypes.cppType(narrowed.dataType)}${aliases || narrowed.borrowedData ? "&" : ""} ${cppName} = ${narrowed.cpp};`,
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
                    constructs || referenceStruct
                        ? "owned"
                        : "copy",
                );
            }
            this.defineVariable(declaration.name, {
                kind: "data",
                cpp: cppName,
                dataType: narrowed.dataType,
                ...(narrowed.borrowedData ? { borrowedData: true as const } : {}),
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
                  : "auto";
        // compileValue already emits a JS number at double precision.
        // Compiling the initializer again is observably wrong for calls and
        // other expressions that materialize temporaries.
        const initializerCpp = value.cpp;
        const maybeUnused =
            value.kind === "boolean" ? "[[maybe_unused]] " : "";
        this.emit(
            `${maybeUnused}${nativeType} ${cppName} = ${initializerCpp};`,
        );
        const stored = { ...value, cpp: cppName };
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
        this.emit(
            `std::function<${returnCpp}(${parameterTypes.join(", ")})> ${cppName};`,
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
     * or object literal is subsequently mutated. The latter distinction
     * preserves compile-time tuples and option records while giving ordinary
     * JavaScript containers runtime identity as soon as the source writes
     * through them (including through a reached local-function parameter).
     */
    private emitAnnotatedDataDeclaration(
        declaration: ts.VariableDeclaration,
        cppName: string,
    ): boolean {
        if (!declaration.initializer) {
            return false;
        }
        const inferredMutableArray =
            !declaration.type &&
            ts.isIdentifier(declaration.name) &&
            ts.isArrayLiteralExpression(this.unwrap(declaration.initializer)) &&
            this.inferredArrayIsMutated(declaration.name);
        const inferredMutableObject =
            !declaration.type &&
            ts.isObjectLiteralExpression(this.unwrap(declaration.initializer)) &&
            ts.isIdentifier(declaration.name) &&
            this.inferredObjectIsMutated(declaration.name);
        if (
            !declaration.type &&
            !inferredMutableArray &&
            !inferredMutableObject
        ) {
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
        if (annotated && inferredMutableObject) {
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
        this.reachJsData();
        const initializer = this.unwrap(
            declaration.initializer,
        );
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
            this.emit(
                `${this.dataTypes.cppType(annotated)} ${cppName} = ${this.dataLowerer.compileForSink(declaration.initializer, annotated)};`,
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
            ts.isCallExpression(initializer) ||
                ts.isNewExpression(initializer) ||
                ts.isObjectLiteralExpression(initializer) ||
                ts.isArrayLiteralExpression(initializer)
                ? "owned"
                : "copy",
        );
        this.defineVariable(declaration.name as ts.Identifier, {
            kind: "data",
            cpp: cppName,
            dataType: annotated,
        });
        return true;
    }

    private inferredArrayIsMutated(identifier: ts.Identifier): boolean {
        const symbol = this.symbols.valueSymbol(identifier);
        if (!symbol) return false;
        const aliases = new Set<ts.Symbol>([symbol]);
        const namesAlias = (node: ts.Node): boolean =>
            ts.isIdentifier(node) &&
            aliases.has(this.symbols.valueSymbol(node)!);
        const containsAlias = (node: ts.Node): boolean => {
            let found = false;
            const visit = (candidate: ts.Node): void => {
                if (found) return;
                if (namesAlias(candidate)) {
                    found = true;
                    return;
                }
                ts.forEachChild(candidate, visit);
            };
            visit(node);
            return found;
        };
        let changed = true;
        while (changed) {
            changed = false;
            let mutated = false;
            const visit = (node: ts.Node): void => {
                if (mutated) return;
                if (
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.initializer &&
                    namesAlias(this.unwrap(node.initializer))
                ) {
                    const alias = this.symbols.valueSymbol(
                        node.name,
                    );
                    if (alias && !aliases.has(alias)) {
                        aliases.add(alias);
                        changed = true;
                    }
                }
                if (ts.isCallExpression(node)) {
                    if (
                        ts.isPropertyAccessExpression(
                            node.expression,
                        ) &&
                        namesAlias(
                            this.unwrap(
                                node.expression.expression,
                            ),
                        ) &&
                        mutatingArrayMethods.has(
                            node.expression.name.text,
                        )
                    ) {
                        mutated = true;
                        return;
                    }
                    if (node.arguments.some(containsAlias)) {
                        mutated = true;
                        return;
                    }
                }
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind >=
                        ts.SyntaxKind.FirstAssignment &&
                    node.operatorToken.kind <=
                        ts.SyntaxKind.LastAssignment &&
                    ((ts.isElementAccessExpression(node.left) &&
                        namesAlias(
                            this.unwrap(node.left.expression),
                        )) ||
                        namesAlias(this.unwrap(node.left)))
                ) {
                    mutated = true;
                    return;
                }
                ts.forEachChild(node, visit);
            };
            ts.forEachChild(identifier.getSourceFile(), visit);
            if (mutated) return true;
        }
        return false;
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
     */
    private inferredObjectIsMutated(identifier: ts.Identifier): boolean {
        const initial = this.symbols.valueSymbol(identifier);
        if (!initial) return false;
        const aliases = new Set<ts.Symbol>([initial]);
        const source = identifier.getSourceFile();

        const rootIdentifier = (
            expression: ts.Expression,
        ): ts.Identifier | undefined => {
            let current = this.unwrap(expression);
            while (
                ts.isPropertyAccessExpression(current) ||
                ts.isElementAccessExpression(current)
            ) {
                current = this.unwrap(current.expression);
            }
            return ts.isIdentifier(current) ? current : undefined;
        };
        const isAlias = (expression: ts.Expression): boolean => {
            const root = rootIdentifier(expression);
            return (
                root !== undefined &&
                aliases.has(this.symbols.valueSymbol(root)!)
            );
        };
        const containsAlias = (node: ts.Node): boolean => {
            let found = false;
            const visit = (candidate: ts.Node): void => {
                if (found) return;
                if (
                    ts.isIdentifier(candidate) &&
                    aliases.has(
                        this.symbols.valueSymbol(candidate)!,
                    )
                ) {
                    found = true;
                    return;
                }
                ts.forEachChild(candidate, visit);
            };
            visit(node);
            return found;
        };
        let changed = true;
        while (changed) {
            changed = false;
            let mutated = false;
            const visit = (node: ts.Node): void => {
                if (mutated) return;
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind >=
                        ts.SyntaxKind.FirstAssignment &&
                    node.operatorToken.kind <=
                        ts.SyntaxKind.LastAssignment &&
                    (ts.isPropertyAccessExpression(node.left) ||
                        ts.isElementAccessExpression(node.left)) &&
                    isAlias(node.left)
                ) {
                    mutated = true;
                    return;
                }
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    (ts.isPropertyAccessExpression(node.left) ||
                        ts.isElementAccessExpression(node.left)) &&
                    containsAlias(node.right)
                ) {
                    // Storing an object in another object/container makes
                    // identity observable through the second path.
                    mutated = true;
                    return;
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
                    isAlias(node.operand)
                ) {
                    mutated = true;
                    return;
                }
                if (
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.initializer &&
                    isAlias(node.initializer)
                ) {
                    const symbol = this.symbols.valueSymbol(node.name);
                    if (symbol && !aliases.has(symbol)) {
                        aliases.add(symbol);
                        changed = true;
                    }
                }
                if (ts.isCallExpression(node)) {
                    if (
                        ts.isPropertyAccessExpression(
                            node.expression,
                        ) &&
                        storingDataMethods.has(
                            node.expression.name.text,
                        ) &&
                        node.arguments.some(containsAlias)
                    ) {
                        mutated = true;
                        return;
                    }
                    const signature =
                        this.checker.getResolvedSignature(node);
                    const parameters =
                        signature?.declaration?.parameters;
                    if (parameters) {
                        node.arguments.forEach((argument, index) => {
                            if (!isAlias(argument)) return;
                            const parameter = parameters[index];
                            if (!parameter || !ts.isIdentifier(parameter.name)) {
                                return;
                            }
                            const symbol = this.symbols.valueSymbol(
                                parameter.name,
                            );
                            if (symbol && !aliases.has(symbol)) {
                                aliases.add(symbol);
                                changed = true;
                            }
                        });
                    }
                }
                ts.forEachChild(node, visit);
            };
            ts.forEachChild(source, visit);
            if (mutated) return true;
        }
        return false;
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
            this.bindLocalValue(element.name, bound);
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
            const temporary =
                this.allocateTemporaryCppName("tuple");
            this.emit(
                `const ${this.dataTypes.cppType(value.dataType)} ${temporary} = ${value.cpp};`,
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
                this.fail(
                    element,
                    `Record destructuring supports numeric properties only, received ${propertyValue.kind}.`,
                );
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

    public compileValue(expression: ts.Expression): Value {
        return this.expressions.compileValue(expression);
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
        const ownerExpression = this.unwrap(
            expression.expression,
        );
        const enumMember = this.enumMemberValue(
            expression,
        );
        if (enumMember) {
            return enumMember;
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
            !ts.isElementAccessExpression(ownerExpression)
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
        if (owner.kind === "platform-keyboard-event") {
            if (property === "repeat") {
                return {
                    kind: "boolean",
                    cpp: `${owner.cpp}.repeat`,
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
            this.fail(
                expression.name,
                `Platform keyboard events do not expose '${property}'.`,
            );
        }
        if (owner.kind === "platform-mouse-event") {
            if (property === "button") {
                return {
                    kind: "number",
                    cpp: `${owner.cpp}.button`,
                    dataType: { kind: "number" },
                };
            }
            this.fail(
                expression.name,
                `Platform mouse events do not expose '${property}'.`,
            );
        }
        const fetchedProperty = staticFetchProperty(
            owner,
            property,
        );
        if (fetchedProperty) return fetchedProperty;
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
                    `Static record has no property '${property}'.`,
                );
            }
            return value;
        }
        return (
            this.readOwnerProperty(owner, expression) ??
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
    ): { name: string; id: number } {
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
        if (!ts.isIdentifier(callee)) return false;
        const declaration = this.symbols
            .valueSymbol(callee)
            ?.declarations?.find(ts.isFunctionDeclaration);
        if (!declaration?.body) return false;
        const hasBrowserInput = call.arguments.some((argument) =>
            this.isBrowserOnlyExpression(argument),
        );
        if (
            !hasBrowserInput ||
            !call.arguments.every((argument) =>
                this.isBrowserHelperArgument(argument),
            )
        ) {
            return false;
        }
        const source = declaration.getSourceFile();
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
            const right = this.compileCondition(unwrapped.right);
            if (right === absorbing) return absorbing;
            if (left === identity) return right;
            if (right === identity) return left;
            return `(${left} ${isAnd ? "&&" : "||"} ${right})`;
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
                    "Browser-dependent condition cannot be determined for native AOT lowering.",
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
                    ["Uint32Array", "u32array"],
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
            const typed =
                this.dataLowerer.equalityComparison(
                    unwrapped,
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
            return `${this.compileNumber(unwrapped.left, "double")} ${operator} ${this.compileNumber(unwrapped.right, "double")}`;
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
            if (value.kind === "callback") {
                return "true";
            }
            if (value.kind === "json-null") {
                return "false";
            }
        }
        this.fail(unwrapped, "Expected a reached callback condition.");
    }

    /** Nonzero while a frame callback's statements are being lowered. */
    private frameCallbackDepth = 0;

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
        signature: "delta" | "void" = "delta",
    ): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            if (signature === "void") {
                this.fail(
                    unwrapped,
                    "A deferred callback must be written inline.",
                );
            }
            return this.compileNamedFrameCallback(unwrapped);
        }
        if (!ts.isArrowFunction(unwrapped) && !ts.isFunctionExpression(unwrapped)) {
            this.fail(unwrapped, "onBeforeRender requires an inline callback.");
        }
        if (unwrapped.parameters.length > 1) {
            this.fail(unwrapped, "onBeforeRender callback supports at most one deltaMs parameter.");
        }
        if (signature === "void" && unwrapped.parameters.length > 0) {
            this.fail(
                unwrapped,
                "A deferred callback takes no parameters: a timeout is " +
                    "not a frame and carries no delta.",
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
        this.deferredCaptureFloor = signature === "void"
            ? this.frameCallbackScopeFloor
            : undefined;
        this.pushScope(
            this.cppNamePrefixes.at(-1) ?? "",
        );
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
            this.frameCallbackDepth -= 1;
            this.popScope();
            this.deferredCaptureFloor = previousDeferredFloor;
            this.frameCallbackScopeFloor = previousFrameFloor;
            this.indentLevel = previousIndent;
        }
        const callbackBody = this.body.splice(start);
        const cppParameter = parameterName
            ? `float ${this.cppIdentifier(parameterName)}`
            : "float";
        const lambdaParameter =
            signature === "void" ? "" : cppParameter;
        return `[&](${lambdaParameter}) {\n${callbackBody.map((line) => `            ${line}`).join("\n")}\n        }`;
    }

    private compileNamedFrameCallback(
        identifier: ts.Identifier,
    ): string {
        const start = this.body.length;
        const previousIndent = this.indentLevel;
        this.indentLevel = 0;
        this.frameCallbackDepth += 1;
        try {
            const value =
                this.userFunctions.compileReference(
                    this,
                    identifier,
                );
            if (!value) {
                this.fail(
                    identifier,
                    `Callback '${identifier.text}' does not resolve to a local function.`,
                );
            }
            if (value.cpp.length > 0) {
                this.emit(`${value.cpp};`);
            }
        } finally {
            this.frameCallbackDepth -= 1;
            this.indentLevel = previousIndent;
        }
        const callbackBody = this.body.splice(start);
        return `[&](float) {\n${callbackBody
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

    public expectObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression {
        const unwrapped = this.unwrap(expression);
        if (!ts.isObjectLiteralExpression(unwrapped)) {
            this.fail(unwrapped, "Expected an object literal.");
        }
        return unwrapped;
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
        return this.evaluator.compileStringLiteral(expression);
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
                    "msaaSamples",
                    "requiredLimits",
                    "useHighPrecisionMatrix",
                    "useFloatingOrigin",
                ],
                "Reached engine options support msaaSamples, requiredLimits, " +
                    "useHighPrecisionMatrix and useFloatingOrigin.",
            );
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
                const value =
                    this.resolveStaticExpression(samples);
                if (
                    !ts.isNumericLiteral(value) ||
                    Number(value.text) !== 4
                ) {
                    this.fail(
                        samples,
                        "Native engine lowering currently supports explicit msaaSamples: 4 only.",
                    );
                }
                msaaSamples = 4;
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
        kind: "f32array" | "u32array",
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

    public reachThrow(): void {
        this.throwReached = true;
    }

    public reachJsData(): void {
        this.jsDataReached = true;
    }

    public snapshotAliasState(): Map<string, string> {
        return this.dataLowerer.snapshotAliasState();
    }

    public restoreAliasState(
        snapshot: Map<string, string>,
    ): void {
        this.dataLowerer.restoreAliasState(snapshot);
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
        // A shorthand property's own identifier resolves to the
        // literal's property symbol, so the value symbol is what says
        // which declaration the name actually refers to.
        const symbol = this.symbols.valueSymbol(identifier);
        return (symbol?.declarations ?? []).some(
            (declaration) =>
                ts.isFunctionDeclaration(declaration) &&
                declaration.body !== undefined,
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
            if (this.classOf(owner)) {
                this.defineThis(owner);
            }
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
        if (
            initializer.kind === ts.SyntaxKind.NullKeyword &&
            nullableResource
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
            this.compileValue(initializer),
            false,
            this.allocateTemporaryCppName(
                `class_field_${name.text}`,
            ),
        );
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
        this.classInstances.set(instance, declaration);
    }

    public classOf(
        instance: Value,
    ): ts.ClassDeclaration | undefined {
        return this.classInstances.get(instance);
    }

    public defaultEngine(): string | undefined {
        return this.defaultEngineCpp;
    }

    public reachJsRandom(): void {
        this.jsRandomReached = true;
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
    /** How many lines the body stream holds, for a caller that may undo. */

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
    ): void {
        this.returnFrames.push({
            kind: "native",
            type: returnType ?? "void",
        });
    }

    public endNativeFunctionBody(): void {
        this.returnFrames.pop();
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
        const returnType = this.activeNativeReturnType();
        if (returnType === undefined) {
            this.fail(
                statement,
                "Return outside a native function.",
            );
        }
        if (returnType === "void") {
            if (statement.expression) {
                this.fail(
                    statement.expression,
                    "Void functions cannot return a value.",
                );
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
            return true;
        }
        const value = this.compileValue(right);
        if (value.kind !== target.kind) {
            this.fail(
                right,
                `Nullable ${target.kind} assignment received ${value.kind}.`,
            );
        }
        this.emit(`${storage} = ${value.cpp};`);
        if (value.audioContextCpp !== undefined) {
            target.audioContextCpp =
                value.audioContextCpp;
        }
        if (value.audioMainBusCpp !== undefined) {
            target.audioMainBusCpp =
                value.audioMainBusCpp;
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
    public canvasSizeProperty(
        expression: ts.Expression,
    ): "width" | "height" | undefined {
        const unwrapped = this.unwrap(expression);
        if (
            !ts.isPropertyAccessExpression(unwrapped) ||
            (unwrapped.name.text !== "width" &&
                unwrapped.name.text !== "height")
        ) {
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
            ? unwrapped.name.text
            : undefined;
    }

    public staticCanvasSize(
        expression: ts.Expression,
    ): number | undefined {
        const property = this.canvasSizeProperty(expression);
        if (!property) return undefined;
        return property === "width"
            ? this.options.width
            : this.options.height;
    }

    public canvasSizeValue(
        expression: ts.Expression,
    ): Value | undefined {
        const property =
            this.canvasSizeProperty(expression);
        return property
            ? {
                  kind: "number",
                  cpp: `static_cast<double>(${this.requireDefaultEngine(
                      expression,
                  )}.options.${property})`,
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
        if (!ts.isPropertyAccessExpression(callee)) {
            return undefined;
        }
        const receiver = this.unwrap(callee.expression);
        if (
            callee.name.text === "now" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            receiver.text === "performance" &&
            this.isDefaultLibraryIdentifier(receiver)
        ) {
            return {
                kind: "number",
                cpp: "bbl::pal::monotonic_milliseconds()",
                impure: true,
            };
        }
        if (
            callee.name.text === "preventDefault" &&
            call.arguments.length === 0 &&
            ts.isIdentifier(receiver) &&
            this.lookupOptional(receiver)?.kind ===
                "platform-keyboard-event"
        ) {
            // The native window already owns key dispatch; there is no
            // browser default action to cancel.
            return { kind: "void", cpp: "" };
        }
        return undefined;
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
            callee.name.text !== "addEventListener" ||
            !ts.isIdentifier(callee.expression) ||
            !this.isDefaultLibraryIdentifier(callee.expression)
        ) {
            return false;
        }
        const target = callee.expression.text;
        if (target !== "window" && target !== "document") {
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
        if (
            target === "window" &&
            (event === "keydown" || event === "keyup")
        ) {
            const parameter =
                this.allocateTemporaryCppName("key_event");
            const lambda = this.compilePlatformCallback(
                callback,
                `[[maybe_unused]] const bbl::PlatformKeyboardEvent& ${parameter}`,
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
                `bbl::on_pointer_down(${engine}, ${this.compilePlatformCallback(callback, "", [], undefined, once)});`,
            );
            return true;
        }
        if (
            target === "window" &&
            (event === "mousedown" || event === "mouseup")
        ) {
            const parameter =
                this.allocateTemporaryCppName("mouse_event");
            const lambda = this.compilePlatformCallback(
                callback,
                `[[maybe_unused]] const bbl::PlatformMouseEvent& ${parameter}`,
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
                `bbl::on_mouse_${event === "mousedown" ? "down" : "up"}(${engine}, ${lambda});`,
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
                `bbl::on_visibility_change(${engine}, ${this.compilePlatformCallback(callback, `bool ${parameter}`, [], parameter, once)});`,
            );
            return true;
        }
        return false;
    }

    private compilePlatformCallback(
        callback: ts.Expression,
        cppParameter: string,
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
                const result = this.compileCallbackWithValues(
                    this.unwrap(callback) as
                        | ts.Identifier
                        | ts.ArrowFunction
                        | ts.FunctionExpression,
                    values,
                    callback,
                );
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
        const prefix = onceName
            ? `            if (${onceName}) return;\n            ${onceName} = true;\n`
            : "";
        return `[&${onceName ? `, ${onceName} = false` : ""}](${cppParameter})${onceName ? " mutable" : ""} {\n${prefix}${lines
            .map((line) => `            ${line}`)
            .join("\n")}\n        }`;
    }

    public isFrameYield(expression: ts.Expression): boolean {
        return this.browserErasure.isFrameYield(expression);
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
                if (
                    this.deferredCaptureFloor !== undefined &&
                    index >= this.deferredCaptureFloor
                ) {
                    this.fail(
                        identifier,
                        `A deferred callback cannot name '${identifier.text}': ` +
                            "it is bound inside the callback that queued " +
                            "the timeout, and that frame has returned by " +
                            "the time the timeout runs. Bind it outside " +
                            "the enclosing callback.",
                    );
                }
                return binding.value;
            }
        }
        return undefined;
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
        if (owner.kind === "record") {
            return owner.recordProperties?.[
                expression.name.text
            ];
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
            owner.kind === "camera" &&
            expression.name.text === "target"
        ) {
            // Not a field but three of them: the record this synthesizes
            // is what makes `camera.target.x` and destructuring it read
            // the same components.
            const record = `${this.requireEngine(owner, expression)}.cameras[${owner.cpp}.value]`;
            const component = (
                name: "x" | "y" | "z",
            ): Value => ({
                kind: "number",
                cpp: `${record}.target.${name}`,
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
                return binding.value;
            }
        }
        this.fail(
            identifier,
            `Unknown or unsupported variable '${identifier.text}'.`,
        );
    }

    public defineVariable(
        identifier: ts.Identifier,
        value: Value,
    ): void {
        const symbol =
            this.symbols.valueSymbol(identifier);
        if (!symbol) {
            this.fail(
                identifier,
                `Unable to resolve variable '${identifier.text}'.`,
            );
        }
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
        });
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

    /**
     * Binds an inlined user-function parameter. Unlike local
     * declarations (the pinned value model copies path-bound locals),
     * JavaScript object arguments alias, and the native-function path
     * already passes struct/vector/typed-array parameters by reference
     * — so the inline path binds through a forwarding reference:
     * lvalue arguments alias the caller's binding (writes through the
     * parameter mutate it) while temporaries stay owned.
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
        const dataType =
            this.dataLowerer.dataTypeAt(identifier);
        if (!dataType || dataType.kind === "handle") {
            this.bindParameterValue(
                identifier,
                this.compileValue(argument),
            );
            return;
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
                this.bindParameterValue(identifier, actual);
                return;
            }
        }
        const cpp = this.dataLowerer.compileForSink(
            argument,
            dataType,
        );
        this.bindParameterValue(
            identifier,
            this.dataLowerer.leafValue(cpp, dataType),
        );
    }

    public compileCallbackWithValues(
        declaration:
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression,
        arguments_: readonly Value[],
        callNode: ts.Node,
    ): Value {
        return this.userFunctions.compileCallbackWithValues(
            this,
            declaration,
            arguments_,
            callNode,
        );
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
        const nativeType = reference
            ? "auto&"
            : value.kind === "number"
              ? "double"
              : value.kind === "boolean"
                ? "bool"
                : value.kind === "data" &&
                    value.dataType?.kind === "string"
                  ? "std::string"
                : parameter
                  ? "auto&&"
                  : "auto";
        const initializerCpp =
            value.kind === "number" &&
            value.staticNumber !== undefined
                ? doubleLiteral(value.staticNumber)
                : value.cpp;
        const maybeUnused =
            value.kind === "boolean" ||
            (parameter && value.staticNumber !== undefined)
                ? "[[maybe_unused]] "
                : "";
        this.emit(
            `${maybeUnused}${nativeType} ${cppName} = ${initializerCpp};`,
        );
        const stored: Value = {
            ...value,
            cpp: cppName,
            ...(parameter ? { parameterBinding: true } : {}),
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
        return this.sceneMaterials.recordScenePbrNoColorView(
            sourceIndex,
        );
    }

    public recordSceneMaterialSlot(): number {
        return this.sceneMaterials.recordSceneMaterialSlot();
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
        color: readonly number[],
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
        return { lightIndex: generator.lightIndex };
    }

    /** Which material a scene-code mesh was assigned, by its mesh index. */
    public recordSceneMeshMaterial(
        meshIndex: number,
        material: { pbrMaterial: number | null; nodeMaterial: number | null },
    ): void {
        this.sceneMeshMaterials.set(meshIndex, material);
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

    /** The scene slot the next `addToScene(scene, light)` fills. */
    public nextSceneLightIndex(kind?: LightKind): number {
        const index = this.sceneLightCount++;
        if (kind) this.sceneLightKinds.push(kind);
        if (this.frameCallbackDepth > 0) this.dynamicSceneLights = true;
        return index;
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
            gltfAssetsBefore: [...this.assets.values()].filter(
                (asset) => asset.kind === "gltf",
            ).length,
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
    public reachFeature(feature: Feature, site?: ts.Node): void {
        this.features.add(feature);
        if (site !== undefined && !this.featureSites.has(feature)) {
            const file = site.getSourceFile();
            const position = file.getLineAndCharacterOfPosition(
                site.getStart(file),
            );
            const fileName =
                file === this.sourceFile
                    ? this.options.fileName
                    : file.fileName;
            this.featureSites.set(
                feature,
                `${fileName}:${position.line + 1}`,
            );
        }
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
        this.reachFeature("renderer:pbr", node);
        this.reachFeature("renderer:geometry-output", node);
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
            `bbl::CameraHandle{}, false, true, true});\n` +
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
                    if (this.symbols.importedName(callee) !== undefined) {
                        required = true;
                        return;
                    }
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

    public emit(line: string): void {
        this.body.push(`${"    ".repeat(this.indentLevel)}${line}`);
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
        return renderMainCpp({
            features,
            jsDataReached: this.jsDataReached,
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
            body: this.body,
        });
    }

    private renderCmake(features: Feature[], runtimeSources: string[], generatedSources: string[]): string {
        return renderFeaturesCmake(features, runtimeSources, generatedSources);
    }

    public fail(node: ts.Node, message: string): never {
        const file = node.getSourceFile();
        const position =
            file.getLineAndCharacterOfPosition(
                node.getStart(file),
            );
        throw new CompileError(
            file === this.sourceFile
                ? this.options.fileName
                : file.fileName,
            position.line + 1,
            position.character + 1,
            message,
        );
    }

    private failAtFile(message: string): never {
        throw new CompileError(this.options.fileName, 1, 1, message);
    }
}
