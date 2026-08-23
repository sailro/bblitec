import ts from "typescript";
import {
    sanitizeCppIdentifier,
    stringLiteral,
} from "./cpp-literals.js";
import {
    compileAdaptations,
    type AdaptationContext,
} from "./compiler/adaptations.js";
import {
    emitPropertyAssignment,
    type AssignmentContext,
} from "./compiler/assignments.js";
import {
    registerAsset,
    registerPixelsAsset,
    registerSpriteAtlasAsset,
    resolveBundledAsset,
    type AssetRegistryContext,
} from "./compiler/assets.js";
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
    geometryEnumMember,
    type EngineOptionContext,
} from "./compiler/intrinsics/engine-options.js";
import {
    compilePbrMaterialOptions,
    compileGridMaterialOptions,
    compileClearCoatOptions,
    compileAnisotropyOptions,
    type CompiledAnisotropyOptions,
    compileIridescenceOptions,
    compileSheenOptions,
    type CompiledLayerOptions,
    type CompiledPbrMaterialOptions,
    type MaterialOptionContext,
} from "./compiler/intrinsics/material-options.js";
import {
    compileBoxOptions,
    compileGroundOptions,
    compilePlaneOptions,
    compileSphereOptions,
    compileTorusOptions,
    type MeshOptionContext,
} from "./compiler/intrinsics/mesh-options.js";
import { requireGroupSource } from "./compiler/intrinsics/animation.js";
import {
    compileRegisteredConstant,
    compileRegisteredIntrinsic,
    type IntrinsicContext,
} from "./compiler/intrinsics/registry.js";
import {
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
} from "./compiler/data-lowering.js";
import {
    DataTypeRegistry,
    type DataType,
} from "./compiler/data-types.js";
import {
    ExpressionLowerer,
    type ExpressionContext,
} from "./compiler/expressions.js";
import {
    NativeFunctionLowerer,
    type NativeFunctionContext,
} from "./compiler/native-functions.js";
import {
    createCompilerProgram,
} from "./compiler/program.js";
import {
    nativeLocation,
    readHandleCollection,
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
    type UserFunctionContext,
    UserFunctionLowerer,
} from "./compiler/user-functions.js";
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
    PostProcessCompositeManifest,
    PostProcessTaskManifest,
    ResolvedCompileOptions,
    SceneMeshManifest,
    ScenePbrClearCoatManifest,
    ScenePbrAnisotropyManifest,
    ScenePbrIridescenceManifest,
    ScenePbrMaterialManifest,
    ScenePbrSheenManifest,
    SpriteCustomShaderManifest,
    EffectManifest,
    Value,
    ValueKind,
} from "./compiler/types.js";
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
import { isNodeParticleValue } from "./compiler/types.js";
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

const featureSources: Record<Feature, string[]> = {
    "animation:gltf-groups": [],
    "animation:property": [],
    "animation:property-blending": [],
    "animation:managed-groups": [],
    "animation:gltf-blending": [],
    "core": ["src/pal.cpp"],
    "backend:sdl": ["src/pal_sdl.cpp"],
    "camera:arc-rotate": [],
    "camera:default": [],
    "camera:free": [],
    "camera:orthographic": [],
    "environment:ibl": [],
    "environment:env": [],
    "environment:hdr": [],
    "environment:dds": [],
    "background:ground": [],
    "background:skybox": [],
    "background:image-skybox": [],
    "background:solid-skybox": [],
    "light:hemispheric": [],
    "light:directional": [],
    "light:point": [],
    "light:spot": [],
    "loader:babylon": [],
    "loader:gltf": [],
    "loader:gltf-variants": [],
    "loader:splat": [],
    "material:pbr": [],
    "material:clearcoat": [],
    "material:sheen": [],
    "material:sheen-albedo-scaling": [],
    "material:clearcoat-f0-remap": [],
    "material:iridescence": [],
    "material:anisotropy": [],
    "material:tracking": [],
    "material:emissive": [],
    "material:no-color-view": [],
    "material:grid": [],
    "material:node": [],
    "material:shader": [],
    "material:standard": [],
    "material:standard-diffuse-render-texture": [],
    "material:standard-diffuse-pixels-texture": [],
    "material:standard-diffuse-file-texture": [],
    "material:standard-uv-transform": [],
    "material:standard-emissive-render-texture": [],
    "material:standard-emissive-file-texture": [],
    "material:standard-vertex-colors": [],
    "mesh:box": [],
    "mesh:from-data": [],
    "mesh:ground": [],
    "mesh:lines": [],
    "mesh:morph-targets": [],
    "mesh:plane": [],
    "mesh:sphere": [],
    "mesh:thin-instances": [],
    "mesh:thin-instance-colors": [],
    "mesh:thin-instances-dynamic": [],
    "mesh:torus": [],
    "scene:remove": [],
    "sprite:2d": [],
    "sprite:uv-scroll": [],
    "sprite:custom-shader": [],
    "texture:file": [],
    "texture:compressed": [],
    "texture:pixels": [],
    "sprite:billboard": [],
    // A frozen node-particle system draws through the billboard family; the
    // simulation itself is baked at generation, so nothing of the pin's own
    // particle runtime compiles.
    "particle:node": [],
    "sprite:billboard-axis-locked": [],
    "sprite:billboard-cutout": [],
    "sprite:billboard-custom-shader": [],
    "renderer:sprite": ["src/pal_sdl_gpu_sprite.cpp"],
    // The scene-less fullscreen-effect path: an EffectRenderer is its own
    // rendering context on the engine, exactly as a SpriteRenderer is, so a
    // scene registering one and no SceneContext compiles no scene renderer
    // and draws from this translation unit instead.
    "renderer:effect": ["src/pal_sdl_gpu_effect.cpp"],
    "effect:wrapper": [],
    "effect:task": [],
    "renderer:pbr": ["src/pal_sdl_gpu.cpp"],
    "renderer:transmission": [],
    "renderer:fog": [],
    "renderer:geometry-output": [],
    "renderer:post-process": [],
};

const featureOrder = Object.keys(featureSources) as Feature[];

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

/**
 * The features.cmake render, a pure function of the three lists so a caller
 * that augments the manifest's features after compilation (the CLI joins the
 * assets' own KHR_lights_punctual kinds there) re-renders the same authority
 * instead of patching the string.
 */
export function renderFeaturesCmake(
    features: readonly Feature[],
    runtimeSources: readonly string[],
    generatedSources: readonly string[],
): string {
    const sourceLines = runtimeSources.map((source) => `    "\${BBLITE_NATIVE_ROOT}/${source}"`).join("\n");
    const generatedSourceLines = generatedSources
        .map((source) => `    "\${BBLITE_GENERATED_DIR}/${source}"`)
        .join("\n");
    const featureLines = features.map((feature) => `    "${feature}"`).join("\n");
    return `# Generated by bblitec. Included by native/CMakeLists.txt.
set(BBLITE_RUNTIME_FEATURES
${featureLines}
)

set(BBLITE_RUNTIME_SOURCES
${sourceLines}
)

set(BBLITE_GENERATED_SOURCES
${generatedSourceLines}
)
`;
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
    private readonly statements = new StatementLowerer();
    public readonly userFunctions: UserFunctionLowerer;
    public readonly dataTypes: DataTypeRegistry;
    public readonly dataLowerer: DataLowerer;
    public readonly classLowerer: ClassLowerer;
    public readonly nativeFunctions: NativeFunctionLowerer;
    private readonly browserErasure: BrowserErasure;
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
    public readonly scenePbrMaterials: ScenePbrMaterialManifest[] = [];
    private readonly sceneMeshes: SceneMeshManifest[] = [];
    private readonly sceneSpriteCustomShaders: SpriteCustomShaderManifest[] =
        [];
    private reachedPlainSpriteLayer = false;
    private reachedPlainBillboardSystem = false;
    private sceneMaterialCount = 0;
    public hasMainEntry = false;
    private defaultEngineCpp: string | undefined;
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
            (identifier) =>
                this.symbols.valueSymbol(identifier),
            (expression) =>
                this.canvasSizeValue(expression) ??
                this.lookupRecordProperty(expression) ??
                this.dataLowerer.compileDataPath(
                    expression,
                    "read",
                ),
            (expression) => this.compileValue(expression),
            (expression) => this.compileValue(expression),
            (expression) => this.compileValue(expression),
            (expression) =>
                this.compileCondition(expression),
            (expression) =>
                this.evaluateBrowserValue(expression),
            (expression) =>
                this.isBrowserOnlyExpression(expression),
            (identifier) => this.lookup(identifier),
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
                scenePbrMaterials: this.scenePbrMaterials,
                sceneMaterialCount: this.sceneMaterialCount,
                sceneMeshes: this.sceneMeshes,
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
        if (!declaration.initializer) {
            this.fail(declaration, `Variable '${declaration.name.text}' requires an initializer.`);
        }

        const sourceName = declaration.name.text;
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
        const cppName = this.cppIdentifier(sourceName);
        if (
            ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(
                declaration.initializer,
            )
        ) {
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
        if (value.kind === "node-particle-2d-binding") {
            // Nothing native to bind: the registrar already ran, and the
            // binding exists so instrumentation can report it.
            this.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "void" || value.kind === "browser") {
            this.fail(declaration.initializer, `Expression assigned to '${sourceName}' does not produce a native value.`);
        }
        if (
            value.kind === "tuple" ||
            value.kind === "record" ||
            value.kind === "morph-targets" ||
            // A custom-shader descriptor is compile-time data: the program
            // it names is composed at generation and the layer it is passed
            // to carries only that it has one, so there is nothing to
            // declare natively.
            value.kind === "sprite-custom-shader" ||
            value.kind === "billboard-custom-shader" ||
            isNodeParticleValue(value.kind)
        ) {
            this.defineVariable(declaration.name, value);
            return;
        }
        if (value.kind === "data") {
            const narrowed =
                this.dataLowerer.narrowForDeclaration(
                    value,
                    declaration.name,
                );
            if (!narrowed.dataType) {
                this.fail(
                    declaration.initializer,
                    "Data expression is missing its type.",
                );
            }
            const initializer = this.unwrap(
                declaration.initializer,
            );
            const constructs =
                ts.isCallExpression(initializer) ||
                ts.isNewExpression(initializer) ||
                ts.isObjectLiteralExpression(initializer) ||
                ts.isArrayLiteralExpression(initializer);
            // A const local bound to an element or member of a
            // container binds a reference, so writes through it reach
            // the container the way a JavaScript object binding does.
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
                (ts.isElementAccessExpression(initializer) ||
                    ts.isPropertyAccessExpression(
                        initializer,
                    )) &&
                narrowed.dataType.kind !== "table" &&
                // A value read out of a span is const, so it cannot be
                // bound by reference; the source language would not let
                // it be written through either.
                !narrowed.readOnly;
            this.emit(
                `${this.dataTypes.cppType(narrowed.dataType)}${aliases ? "&" : ""} ${cppName} = ${narrowed.cpp};`,
            );
            if (aliases) {
                this.dataLowerer.registerAlias(
                    cppName,
                    narrowed.cpp,
                );
            } else {
                this.dataLowerer.registerLocal(
                    cppName,
                    constructs ? "owned" : "copy",
                );
            }
            this.defineVariable(declaration.name, {
                kind: "data",
                cpp: cppName,
                dataType: narrowed.dataType,
            });
            return;
        }

        const nativeType =
            value.kind === "number"
                ? "double"
                : value.kind === "boolean"
                  ? "bool"
                  : "auto";
        const initializerCpp =
            value.kind === "number" &&
            !ts.isCallExpression(
                this.unwrap(declaration.initializer),
            ) &&
            !ts.isConditionalExpression(
                this.unwrap(declaration.initializer),
            )
                ? this.compileNumber(
                      declaration.initializer,
                      "double",
                  )
                : value.cpp;
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

    /**
     * Emits a data-typed local when the declaration carries an explicit
     * annotation mapping to a composite data type. Object literals compile
     * against the annotated struct (including one leading spread); other
     * initializers compile through the typed sink. Returns false when the
     * annotation is absent or not a composite data type.
     */
    private emitAnnotatedDataDeclaration(
        declaration: ts.VariableDeclaration,
        cppName: string,
    ): boolean {
        if (!declaration.type || !declaration.initializer) {
            return false;
        }
        const annotated = this.dataTypes.fromTsType(
            this.checker.getTypeFromTypeNode(
                declaration.type,
            ),
            declaration.type,
        );
        const initializerLiteral = this.unwrap(
            declaration.initializer,
        );
        if (
            !annotated ||
            annotated.kind === "number" ||
            annotated.kind === "boolean" ||
            annotated.kind === "span" ||
            annotated.kind === "table" ||
            (annotated.kind === "tuple" &&
                !ts.isArrayLiteralExpression(
                    initializerLiteral,
                ))
        ) {
            // Readonly views keep the legacy static-tuple declaration
            // semantics; only owning composites (and mutable tuple
            // locals initialized from array literals) take the data
            // path.
            return false;
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
        const value = this.compileValue(
            declaration.initializer,
        );
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
        const value = this.compileValue(
            declaration.initializer,
        );
        if (value.kind === "record") {
            this.emitRecordBindingDeclaration(
                declaration.name,
                value,
            );
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
            const cppName = this.cppIdentifier(name.text);
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
        if (this.dataLowerer.emitAssignment(expression)) {
            return;
        }
        emitPropertyAssignment(this, expression);
    }

    public compileValue(expression: ts.Expression): Value {
        return this.expressions.compileValue(expression);
    }
    public compilePropertyAccess(expression: ts.PropertyAccessExpression): Value {
        const ownerExpression = this.unwrap(
            expression.expression,
        );
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
                this.fail(
                    expression,
                    `Field '${expression.name.text}' is not assigned before this read.`,
                );
            }
            return field;
        }
        if (
            !ts.isIdentifier(ownerExpression) &&
            !ts.isPropertyAccessExpression(ownerExpression)
        ) {
            this.fail(
                expression,
                `Unsupported property value '${expression.getText()}'.`,
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
                if (owner.recordMethods?.[property]) {
                    this.fail(
                        expression,
                        `Property '${property}' is a method; it can be called but not read as a value.`,
                    );
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
                `Unsupported property value '${expression.getText()}'.`,
            )
        );
    }

    public compileRegisteredConstant(
        importedName: string,
    ): Value | undefined {
        return compileRegisteredConstant(importedName);
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

    public compileGridMaterialOptions(expression: ts.Expression): string[] {
        return compileGridMaterialOptions(this, expression);
    }

    public compileClearCoatOptions(
        expression: ts.Expression,
    ): CompiledLayerOptions {
        return compileClearCoatOptions(this, expression);
    }

    public compileIridescenceOptions(
        expression: ts.Expression,
    ): CompiledLayerOptions {
        return compileIridescenceOptions(this, expression);
    }

    public compileAnisotropyOptions(
        expression: ts.Expression,
    ): CompiledAnisotropyOptions {
        return compileAnisotropyOptions(this, expression);
    }

    public compileSheenOptions(
        expression: ts.Expression,
    ): {
        enabled: string;
        color: string;
        roughness: string;
        intensity: string;
        texture: ts.Expression | undefined;
        albedoScaling: boolean;
    } {
        return compileSheenOptions(this, expression);
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
        return this.evaluator.compileVec3(
            expression,
            precision,
        );
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
        if (this.isBrowserOnlyExpression(unwrapped)) {
            const condition =
                this.evaluateBrowserCondition(unwrapped);
            if (condition === undefined) {
                this.fail(
                    unwrapped,
                    "Browser-dependent condition cannot be determined for native AOT lowering.",
                );
            }
            return condition ? "true" : "false";
        }
        if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.ExclamationToken) {
            const operand = this.compileCondition(unwrapped.operand);
            if (operand === "true") return "false";
            if (operand === "false") return "true";
            return `!(${operand})`;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            const typed =
                this.dataLowerer.equalityComparison(
                    unwrapped,
                );
            if (typed) {
                return typed;
            }
            const operator = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
                [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!="],
                [ts.SyntaxKind.LessThanToken, "<"],
                [ts.SyntaxKind.LessThanEqualsToken, "<="],
                [ts.SyntaxKind.GreaterThanToken, ">"],
                [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
                [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
                [ts.SyntaxKind.BarBarToken, "||"],
            ]).get(unwrapped.operatorToken.kind);
            if (!operator) {
                this.fail(
                    unwrapped.operatorToken,
                    "Reached callback conditions support numeric comparisons and logical operators.",
                );
            }
            if (
                unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken
            ) {
                const left = this.compileCondition(unwrapped.left);
                const right = this.compileCondition(unwrapped.right);
                // Short-circuit over a settled operand: the surviving side
                // is the whole condition, and where both settled the
                // condition itself is a constant `emitIf` drops the branch
                // for. Only a side-effect-free operand reaches here --
                // `compileCondition` refuses anything else -- so dropping
                // one is dropping nothing.
                const identity =
                    unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.AmpersandAmpersandToken
                        ? "true"
                        : "false";
                const absorbing = identity === "true" ? "false" : "true";
                if (left === absorbing || right === absorbing) {
                    return absorbing;
                }
                if (left === identity) return right;
                if (right === identity) return left;
                return `(${left} ${operator} ${right})`;
            }
            return `(${this.compileNumber(unwrapped.left, "double")} ${operator} ${this.compileNumber(unwrapped.right, "double")})`;
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
            return this.compileBoolean(unwrapped);
        }
        this.fail(unwrapped, "Expected a reached callback condition.");
    }

    /** Nonzero while a frame callback's statements are being lowered. */
    private frameCallbackDepth = 0;

    public compileFrameCallback(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            return this.compileNamedFrameCallback(unwrapped);
        }
        if (!ts.isArrowFunction(unwrapped) && !ts.isFunctionExpression(unwrapped)) {
            this.fail(unwrapped, "onBeforeRender requires an inline callback.");
        }
        if (unwrapped.parameters.length > 1) {
            this.fail(unwrapped, "onBeforeRender callback supports at most one deltaMs parameter.");
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
            this.indentLevel = previousIndent;
        }
        const callbackBody = this.body.splice(start);
        const cppParameter = parameterName
            ? `float ${this.cppIdentifier(parameterName)}`
            : "float";
        return `[&](${cppParameter}) {\n${callbackBody.map((line) => `            ${line}`).join("\n")}\n        }`;
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
        return undefined;
    }

    public compileStringLiteral(expression: ts.Expression): string {
        return this.evaluator.compileStringLiteral(expression);
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
        if (call.arguments[1]) {
            const options = this.expectObjectLiteral(
                call.arguments[1],
            );
            validateObjectProperties(
                this,
                options,
                ["msaaSamples", "requiredLimits"],
                "Reached engine options support msaaSamples and requiredLimits.",
            );
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
        return this.withRecordScopes(owner, () =>
            this.compileValue(expression),
        );
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
        const dataType =
            this.dataLowerer.dataTypeAt(name);
        if (dataType) {
            const cppName = this.cppIdentifier(name.text);
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
            // Numeric and boolean leaves keep their scalar kinds so
            // arithmetic and conditions treat them like any local.
            this.defineVariable(name, {
                kind:
                    dataType.kind === "number"
                        ? "number"
                        : dataType.kind === "boolean"
                          ? "boolean"
                          : "data",
                cpp: cppName,
                dataType,
            });
            return;
        }
        this.bindLocalValue(
            name,
            this.compileValue(initializer),
        );
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
    private markUnreferencedNumericLocals(): void {
        const declaration = /^(\s*)(double )([A-Za-z_][A-Za-z0-9_]*) = /;
        const counts = new Map<string, number>();
        for (const line of this.body) {
            for (const name of line.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
                counts.set(name, (counts.get(name) ?? 0) + 1);
            }
        }
        for (const [index, line] of this.body.entries()) {
            const match = declaration.exec(line);
            if (!match || counts.get(match[3]!) !== 1) continue;
            this.body[index] =
                `${match[1]}[[maybe_unused]] ${line.trimStart()}`;
        }
    }

    /** How many lines the body stream holds, for a caller that may undo. */
    public emittedLineCount(): number {
        return this.body.length;
    }

    /**
     * Drop every line emitted after `count`.
     *
     * An unrolled static loop whose body lowers to no statement at all --
     * every statement in it a compile-time record, as a particle
     * simulation's steps are -- would otherwise leave one braced block per
     * iteration declaring a loop index nothing reads, which MSVC /W4 warns
     * on.
     */
    public truncateEmittedLines(count: number): void {
        this.body.length = count;
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

    public dataIterationTarget(
        expression: ts.Expression,
    ):
        | { container: Value; element: DataType }
        | undefined {
        return this.dataLowerer.iterationTarget(
            expression,
        );
    }

    /**
     * The engine collection an expression names, resolved through the
     * declarative table in `properties.ts` rather than by testing one
     * property name here. A collection the table does not carry returns
     * undefined, so for-of falls through to the plain-data and
     * static-literal paths.
     */
    /**
     * A collection expression past the two shapes that leave it
     * unchanged: `container.animationGroups ?? []` and `?.`.
     *
     * `AssetContainer.animationGroups` is optional upstream, so a scene
     * reading it writes one of those; both resolve to the container's own
     * collection, and an absent one is the empty vector the loader
     * already leaves behind — the same zero iterations `?? []` produces.
     */
    private unwrapCollectionExpression(
        expression: ts.Expression,
    ): ts.Expression {
        const unwrapped = this.unwrap(expression);
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken &&
            ts.isArrayLiteralExpression(unwrapped.right) &&
            unwrapped.right.elements.length === 0
        ) {
            return this.unwrapCollectionExpression(
                unwrapped.left,
            );
        }
        return unwrapped;
    }

    /**
     * The glTF animation groups a call names: a container's own
     * collection, or a static array of groups the scene selected.
     */
    public compileAnimationGroupList(
        expression: ts.Expression,
    ): { cpp: string; engineCpp: string } {
        const collection =
            this.handleCollectionIterationTarget(expression);
        if (collection) {
            if (collection.elementKind !== "animation-group") {
                this.fail(
                    expression,
                    `Expected animation groups, received ${collection.property}.`,
                );
            }
            return {
                cpp: collection.containerCpp,
                engineCpp: collection.engineCpp,
            };
        }
        const literal = this.probeStaticArrayLiteral(
            this.unwrapCollectionExpression(expression),
        );
        if (!literal) {
            this.fail(
                expression,
                "Expected a container's animationGroups or a static array of groups.",
            );
        }
        const groups = literal.elements.map((element) => {
            const value = this.compileValue(element);
            this.expectKind(
                value,
                "animation-group",
                element,
            );
            requireGroupSource(
                this,
                value,
                element,
                "addAnimationGroups",
                "gltf",
            );
            return value;
        });
        const engineCpp = groups[0]
            ? this.requireEngine(groups[0], expression)
            : this.fail(
                  expression,
                  "addAnimationGroups requires at least one group.",
              );
        return {
            cpp:
                `std::vector<bbl::AnimationGroupHandle>{` +
                `${groups.map((group) => group.cpp).join(", ")}}`,
            engineCpp,
        };
    }

    /**
     * `<container>.entities`, when the container is a glTF asset.
     *
     * The iteration folds to one body emission over the container itself.
     * That is not a claim about how many entities there are — `load-gltf`
     * seeds `[root]` and every loader feature appends its own, so a file
     * with punctual lights carries several — but about what the body can
     * do with one: an entity value is accepted by `addToScene` alone, and
     * adding each entity of a container adds exactly the meshes and lights
     * the loader created for it, which is what the emitted call does in
     * one step. A body reaching an entity any other way fails on the
     * value's kind.
     *
     * A `.babylon` container refuses: nothing reached iterates one, and
     * its entity list carries lights beside the roots, so the fold would
     * need its own proof.
     */
    public assetEntitiesIterationTarget(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.unwrap(expression);
        if (
            !ts.isPropertyAccessExpression(unwrapped) ||
            unwrapped.name.text !== "entities"
        ) {
            return undefined;
        }
        const owner = this.compileValue(unwrapped.expression);
        if (owner.kind !== "asset") {
            return undefined;
        }
        if (owner.asset?.kind !== "gltf") {
            this.fail(
                unwrapped,
                "Iterating entities is lowered for a glTF container, whose entities are one root node; another container's roots are not.",
            );
        }
        return {
            ...owner,
            kind: "asset-entity",
            engineCpp: this.requireEngine(owner, unwrapped),
        };
    }

    public handleCollectionIterationTarget(
        expression: ts.Expression,
    ):
        | {
              property: string;
              temporaryLabel: string;
              containerCpp: string;
              elementKind: ValueKind;
              elementCppType: string;
              engineCpp: string;
          }
        | undefined {
        const unwrapped =
            this.unwrapCollectionExpression(expression);
        if (!ts.isPropertyAccessExpression(unwrapped)) {
            return undefined;
        }
        const owner = this.compileValue(unwrapped.expression);
        const collection = readHandleCollection(
            owner,
            unwrapped.name.text,
        );
        if (!collection) {
            return undefined;
        }
        // The declared type carries the element model: the property's own
        // number-index type is what an iteration yields, and the pinned
        // handle registry turns that type into the kind it binds as and the
        // C++ type the range-for declares. Neither is restated in the table.
        // A container's own collections are optional upstream
        // (`animationGroups?: AnimationGroup[]`), and a scene reads one
        // through `?? []` or `?.`; the element model is the same either
        // way, so the nullable half is dropped before the index lookup.
        const elementType = this.checker.getIndexTypeOfType(
            this.checker.getNonNullableType(
                this.checker.getTypeAtLocation(unwrapped),
            ),
            ts.IndexKind.Number,
        );
        if (!elementType) {
            this.fail(
                unwrapped,
                `'${unwrapped.name.text}' is not an indexable collection.`,
            );
        }
        const element = this.dataTypes.fromTsType(
            elementType,
            unwrapped,
        );
        if (element?.kind !== "handle") {
            this.fail(
                unwrapped,
                `Iterating '${unwrapped.name.text}' yields ` +
                    `${element?.kind ?? "an unmapped type"}, which carries ` +
                    "no engine handle to bind.",
            );
        }
        const engineCpp = this.requireEngine(owner, unwrapped);
        return {
            property: collection.property,
            temporaryLabel: collection.temporaryLabel,
            containerCpp: nativeLocation(
                collection,
                owner.cpp,
                engineCpp,
            ),
            elementKind: element.handle,
            elementCppType: this.dataTypes.cppType(element),
            engineCpp,
        };
    }

    public bindDataIterationVariable(
        name: ts.BindingName,
        itemCpp: string,
        element: DataType,
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

    public registerPixelsAsset(
        expression: ts.Expression,
    ): { cpp: string; source: string } {
        return registerPixelsAsset(this, expression);
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
        return ownerType.getSymbol()?.getName() ===
            "HTMLCanvasElement"
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
        this.bindLocalOrParameterValue(
            identifier,
            value,
            true,
        );
    }

    private bindLocalOrParameterValue(
        identifier: ts.Identifier,
        value: Value,
        parameter: boolean,
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
            value.kind === "tuple" ||
            value.kind === "record" ||
            value.kind === "string" ||
            value.kind === "callback" ||
            isNodeParticleValue(value.kind)
        ) {
            this.defineVariable(identifier, value);
            return;
        }
        const cppName = this.cppIdentifier(
            identifier.text,
        );
        const reference =
            value.kind === "engine" ||
            value.kind === "scene";
        const nativeType = reference
            ? "auto&"
            : value.kind === "number"
              ? "double"
              : value.kind === "boolean"
                ? "bool"
                : parameter
                  ? "auto&&"
                  : "auto";
        const initializerCpp =
            value.kind === "number" &&
            value.staticNumber !== undefined
                ? Number.isInteger(value.staticNumber)
                    ? `${value.staticNumber}.0`
                    : `${value.staticNumber}`
                : value.cpp;
        const maybeUnused =
            value.kind === "boolean" ? "[[maybe_unused]] " : "";
        this.emit(
            `${maybeUnused}${nativeType} ${cppName} = ${initializerCpp};`,
        );
        const stored: Value = {
            ...value,
            cpp: cppName,
        };
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
     * Stamps setter options on the scene-code material the call names, the
     * way the pin's `setPbrSheen`/`setPbrClearCoat` stamp the props object
     * onto the material object they are handed. `index` is that object
     * identity at compile time and rides the value the setter was passed,
     * so a material of another family — which owns no manifest entry to
     * stamp — is a named failure rather than a guess.
     */
    private sceneMaterialForSetter(
        setter: string,
        index: number | undefined,
    ): ScenePbrMaterialManifest {
        const material =
            index === undefined
                ? undefined
                : this.scenePbrMaterials[index];
        if (!material) {
            throw new Error(
                `${setter} names no scene-code PBR material; only a value ` +
                    "createPbrMaterial produced, or a mesh one was assigned " +
                    "to, resolves which record to stamp.",
            );
        }
        return material;
    }

    /**
     * Records a no-color view of the scene material the call names: the
     * pin's view is the same material record rendered with
     * `PBR2_NO_COLOR_OUTPUT`, so the derived entry copies its source and
     * appends in creation order. Returns the new entry's index, which is
     * the view's own compile-time identity.
     */
    public recordScenePbrNoColorView(
        sourceIndex: number | undefined,
    ): number {
        const source = this.sceneMaterialForSetter(
            "createPbrNoColorMaterialView",
            sourceIndex,
        );
        this.scenePbrMaterials.push({
            ...source,
            materialsBefore: this.recordSceneMaterialSlot(),
            noColorView: true,
        });
        return this.scenePbrMaterials.length - 1;
    }

    /**
     * Counts one scene-code material creation of any family. Every creator
     * bumps this: material handles are creation-ordered across families, so
     * a standard material shifts the next PBR handle.
     */
    public recordSceneMaterialSlot(): number {
        return this.sceneMaterialCount++;
    }

    public recordScenePbrUnlit(index: number | undefined): void {
        this.sceneMaterialForSetter("setPbrUnlit", index).unlit = true;
    }

    public recordScenePbrSkybox(index: number | undefined): void {
        this.sceneMaterialForSetter("setPbrSkybox", index).skyboxMode = true;
    }

    public recordScenePbrSheen(
        sheen: ScenePbrSheenManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter("setPbrSheen", index).sheen = sheen;
    }

    public recordScenePbrClearCoat(
        clearCoat: ScenePbrClearCoatManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter(
            "setPbrClearCoat",
            index,
        ).clearCoat = clearCoat;
    }

    public recordScenePbrEmissive(
        color: readonly number[],
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter(
            "setPbrEmissive",
            index,
        ).emissiveColor = color;
    }

    public recordScenePbrIridescence(
        iridescence: ScenePbrIridescenceManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter(
            "setPbrIridescence",
            index,
        ).iridescence = iridescence;
    }

    public recordScenePbrAnisotropy(
        anisotropy: ScenePbrAnisotropyManifest,
        index: number | undefined,
    ): void {
        this.sceneMaterialForSetter(
            "setPbrAnisotropy",
            index,
        ).anisotropy = anisotropy;
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

    /** Records a scene-code mesh creation for the per-renderable variant key. */
    public recordSceneMesh(
        kind: string,
        streams?: {
            hasUv2: boolean;
            hasTangents: boolean;
            hasColors: boolean;
        },
    ): void {
        this.sceneMeshes.push({
            kind,
            gltfAssetsBefore: [...this.assets.values()].filter(
                (asset) => asset.kind === "gltf",
            ).length,
            ...(streams ?? {}),
        });
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
        // Scene code names a blend descriptor and a layer at the call
        // site, so the factories the sprite lowerer emits have to be visible
        // to main.cpp.
        const spriteInclude = features.includes("sprite:2d")
            ? "#include <bblite/upstream/sprite_layer.hpp>\n"
            : "";
        const billboardInclude = features.includes(
            "sprite:billboard",
        )
            ? "#include <bblite/upstream/billboard_system.hpp>\n"
            : "";
        // The frozen node-particle bridge: main.cpp calls the two folded
        // pinned functions by name.
        const nodeParticleInclude = features.includes("particle:node")
            ? "#include <bblite/upstream/node_particles.hpp>\n"
            : "";
        const cameraMathInclude =
            features.some((feature) =>
                feature.startsWith("camera:"),
            )
                ? "#include <bblite/upstream/camera_math.hpp>\n"
                : "";
        const jsDataInclude = this.jsDataReached
            ? "#include <bblite/js_data.hpp>\n"
            : "";
        // A composite's factory is generated, so the scene calls it by a name
        // only its own generated header declares.
        const postProcessInclude =
            this.postProcessComposites.length > 0
                ? "#include <bblite/upstream/frame_graph_post_process.hpp>\n"
                : "";
        const preambleSections: string[] = [];
        const dataPreamble =
            this.dataTypes.renderPreamble();
        if (dataPreamble.length > 0) {
            preambleSections.push(dataPreamble);
        }
        if (this.nativeFunctionPrototypes.length > 0) {
            preambleSections.push(
                [
                    "namespace bblscene {",
                    "",
                    ...this.nativeFunctionPrototypes,
                    "",
                    ...this.nativeFunctionDefinitions,
                    "}  // namespace bblscene",
                ].join("\n"),
            );
        }
        // The body is finished, so a local nothing referenced is now
        // decidable — mark those, and only those.
        this.markUnreferencedNumericLocals();
        const preamble =
            preambleSections.length > 0
                ? `\n${preambleSections.join("\n\n")}\n`
                : "";
        const seedRandom = this.jsRandomReached
            ? "        bbl::js::seed_random(1u);\n"
            : "";
        return `// Generated by bblitec. Do not edit.
#include <bblite/runtime.hpp>
${jsDataInclude}${cameraMathInclude}${spriteInclude}${billboardInclude}${nodeParticleInclude}${postProcessInclude}
#include <cmath>
#include <exception>
#include <iostream>${this.throwReached ? "\n#include <stdexcept>" : ""}
${preamble}
int main() {
    try {
${seedRandom}${this.body.join("\n")}
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Babylon Lite native error: " << error.what() << '\\n';
        return 1;
    }
}
`;
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
