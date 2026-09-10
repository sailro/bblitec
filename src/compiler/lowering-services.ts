import type ts from "typescript";
import type { CompiledMeshWalk } from "../gltf-mesh-walks.js";
import type { CompiledRenderTargetOptions } from "./intrinsics/engine-options.js";
import type {
    CompiledAnisotropyOptions,
    CompiledClearCoatOptions,
    CompiledIridescenceOptions,
    CompiledSheenOptions,
    CompiledSubsurfaceOptions,
    CompiledPbrMaterialOptions,
    CompiledMetallicReflectanceOptions,
} from "./intrinsics/material-options.js";
import type { CompiledNodeMaterialCall } from "./node-material.js";
import type { LineMaterialPermutation, ReachedLineMaterial } from "./line-material.js";
import type { LinearDepthMaterialOptions } from "../lowering/linear-depth-lowerer.js";
import type { DataLowerer } from "./data-lowering.js";
import type { DataTypeRegistry, DataIterationElement, DataType, TypedArrayKind } from "./data-types.js";
import type { NativeFunctionLowerer } from "./native-functions.js";
import type { CompilerSymbols } from "./symbols.js";
import type { StaticEvaluator } from "./static-evaluator.js";
import type { HandleCollections, HandleCollectionTarget } from "./handle-collections.js";
import type { UserFunctionLowerer } from "./user-functions.js";
import type {
    CompileAsset,
    DefaultRenderTaskEmission,
    CompiledNodeMaterial,
    CompiledNodeParticles,
    CompiledShaderProgram,
    Feature,
    GeometryOutputTaskManifest,
    LightKind,
    PostProcessCompositeManifest,
    PostProcessTaskManifest,
    ScreenSpaceTaskManifest,
    ResolvedCompileOptions,
    SceneMeshNamePredicate,
    ShadowCasterMeshManifest,
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
} from "./types.js";
import type { MaterialPluginManifest } from "../pinned-material-plugins.js";
import type { CapturedClosure, NativeCaptureBinding, NativeExpression } from "./closure-captures.js";
import type { NativeDeclaration } from "./native-declarations.js";
import type { ParameterizedResourceLoop, ResourceLoop } from "./resource-loops.js";
import type { ClusteredContainerState } from "./types.js";
import type { ClassLowerer } from "./classes.js";
import type { CompiledTextData } from "../pinned-text-data.js";



/** Execution facts for one native function body. */
export interface NativeFunctionBodyOptions {
    runtimeDataLoops?: boolean;
    callSiteEffects?: boolean;
    compileReturn?: (expression: ts.Expression, type: DataType) => string;
}

/** Shared compiler operations; each lowering module selects its required services. */
export interface LoweringServices {
    isInFrameCallback(): boolean;
    hasPresentationHost(): boolean;
    hasFeature(feature: Feature): boolean;
    failAtFile(message: string): never;
    isPrimaryCanvas2DContextCall(call: ts.CallExpression): boolean;
    hoistForwardCallbackBindings(callback: ts.Expression, before: number): void;
    compilePlatformCallback(
        callback: ts.Expression,
        parameter: { cppType: string; name: string } | undefined,
        values: readonly Value[],
        documentHiddenCpp?: string,
        captureByValue?: boolean,
        assignIdentity?: boolean,
    ): { cpp: string; identity: number };
    readonly sourceFile: ts.SourceFile;
    readonly checker: ts.TypeChecker;
    readonly options: ResolvedCompileOptions;
    readonly symbols: CompilerSymbols;
    readonly evaluator: StaticEvaluator;
    readonly handleCollections: HandleCollections;
    readonly userFunctions: UserFunctionLowerer;
    readonly dataTypes: DataTypeRegistry;
    readonly dataLowerer: DataLowerer;
    readonly classLowerer: ClassLowerer;
    readonly nativeFunctions: NativeFunctionLowerer;
    jsDataReached: boolean;
    jsRandomReached: boolean;
    voxelFileStorageReached: boolean;
    readonly browserTextureFunctions: Set<string>;
    readonly canvasReadbackFunctions: Set<string>;
    readonly variableScopes: Array<Map<ts.Symbol, VariableBinding>>;
    functionEmissionScope(): import("./function-specializations.js").FunctionEmissionScope;
    readonly assets: Map<string, CompileAsset>;
    readonly assetPayloads: Map<string, string>;
    readonly reachedTextData: CompiledTextData[];
    readonly reachedShaderPrograms: CompiledShaderProgram[];
    readonly reachedNodeMaterials: CompiledNodeMaterial[];
    readonly meshWalks: CompiledMeshWalk[];
    readonly reachedNodeParticles: CompiledNodeParticles;
    readonly boundPixelsTextures: Set<string>;
    readonly erasedBrowserExpressions: Set<number>;
    readonly erasedBrowserInstrumentation: Set<number>;
    readonly unwrappedAwaitExpressions: Set<number>;
    readonly geometryOutputTasks: GeometryOutputTaskManifest[];
    readonly postProcessTasks: PostProcessTaskManifest[];
    readonly postProcessComposites: PostProcessCompositeManifest[];
    readonly screenSpaceTasks: ScreenSpaceTaskManifest[];
    readonly localCubemapState: {
        maxCandidates?: number;
    };
    hasMainEntry: boolean;
    defaultRenderTaskAdapted: boolean;
    isNativeHostUiLookup(call: ts.CallExpression): boolean;
    isBrowserOnlyHandler(handler: ts.Expression): boolean;
    emitStatement(statement: ts.Statement): void;
    statementTerminatesAfterLowering(statement: ts.Statement): boolean;
    emitExpressionAsStatement(expression: ts.Expression): void;
    compileTextMutation(expression: ts.Expression): Value | undefined;
    compileNodeInputMutation(expression: ts.Expression): Value | undefined;
    checkNodeGeometryMutation(expression: ts.Expression): void;
    noteNodeGeometryMutation(node: ts.Node): void;
    assertNodeInputMutable(node: ts.Node): void;
    noteNodeInputAdmissionFailure(node: ts.Node, message: string): void;
    noteTextCameraControl(node: ts.Node, camera: Value, arcRotate: boolean): void;
    noteTextSceneLifecycle(node: ts.Node, message?: string): void;
    noteTextSceneCameraAssignment(node: ts.Node): void;
    assertTextPipelineMutable(node: ts.Node): void;
    promoteTextData(node: ts.Node): void;
    recordTextAttachment(node: ts.Node): void;
    assertTextDisposal(node: ts.Node): void;
    emitDiscardedValue(value: Value): void;
    emitVariableDeclaration(declaration: ts.VariableDeclaration): void;
    emitAssignment(expression: ts.BinaryExpression): void;
    /** `??=`, `||=`, `&&=` over a data-model target; any other target refuses. */
    emitLogicalAssignment(expression: ts.BinaryExpression): void;
    /** `delete object[key]` / `delete object.field` over the data model. */
    emitDelete(expression: ts.DeleteExpression): void;
    /** Binds an object pattern from a record or struct value. */
    bindObjectPattern(pattern: ts.ObjectBindingPattern, value: Value, source?: ts.Node): void;
    recordDataAssignmentMetadata(target: Value, source: ts.Expression, destination?: ts.Expression): boolean;
    isNativeUiValueExpression(expression: ts.Expression): boolean;
    readonly uiDegradedStyleProperties: Set<string>;
    readonly uiScopedSheetSelectors: Set<string>;
    readonly uiGridSubstitutions: Set<string>;
    emitUiPropertyAssignment(expression: ts.BinaryExpression): boolean;
    compileValue(expression: ts.Expression): Value;
    compileWorkerValue(expression: ts.Expression): Value | undefined;
    emitAwaitExpression(expression: ts.Expression): boolean;
    withOwnedCallbackBody<T>(body: () => T): T;
    isNativeWorkerExpression(expression: ts.Expression): boolean;
    workerCheckpointCpp(): string | undefined;
    workerAbortCpp(): string | undefined;
    compileAsyncEngineStart(engine: Value, node: ts.Node): Value | undefined;
    compileWorkerCallback(expression: ts.Expression, event: "message" | "error"): string;
    staticStringElements(expression: ts.Expression): readonly string[] | undefined;
    constArrayLiteral(expression: ts.Expression): ts.ArrayLiteralExpression | undefined;
    compileBrowserGeneratedString(call: ts.CallExpression): Value | undefined;
    compilePropertyAccess(expression: ts.PropertyAccessExpression): Value;
    compileRegisteredConstant(importedName: string): Value | undefined;
    compileStaticFetch(call: ts.CallExpression, callee: ts.Identifier): Value | undefined;
    compileStaticFetchMethod(call: ts.CallExpression, owner: Value, method: string): Value | undefined;
    compileRegisteredIntrinsic(importedName: string, call: ts.CallExpression): Value | undefined;
    isRuntimeResourceConstruction(): boolean;
    compileThinInstanceUploadHelper(call: ts.CallExpression, callee: ts.Identifier): Value | undefined;
    compilePixelsTextureUpload(call: ts.CallExpression): Value | undefined;
    compileBoxOptions(expression: ts.Expression, precision?: "float" | "double"): [string, string, string];
    compileRenderTargetOptions(expression: ts.Expression): CompiledRenderTargetOptions;
    compileRenderTaskOptions(expression: ts.Expression): string;
    compileGeometryTaskOptions(expression: ts.Expression): {
        cpp: string;
        manifest: GeometryOutputTaskManifest;
    };
    compileCopyTaskOptions(expression: ts.Expression): string;
    compileGroundOptions(expression: ts.Expression): [string, string, string, string, string];
    compileGroundFromHeightMapOptions(expression: ts.Expression): [string, string, string, string, string, string, string];
    compilePlaneOptions(expression: ts.Expression): [string, string];
    compileSphereOptions(expression: ts.Expression): [string, string, string, string];
    compileTorusOptions(expression: ts.Expression): [string, string, string];
    compilePbrMaterialOptions(expression: ts.Expression): CompiledPbrMaterialOptions;
    compileMetallicReflectanceOptions(expression: ts.Expression): CompiledMetallicReflectanceOptions;
    compileGridMaterialOptions(expression: ts.Expression): string[];
    compileClearCoatOptions(expression: ts.Expression): CompiledClearCoatOptions;
    compileIridescenceOptions(expression: ts.Expression): CompiledIridescenceOptions;
    compileAnisotropyOptions(expression: ts.Expression): CompiledAnisotropyOptions;
    compileSheenOptions(expression: ts.Expression): CompiledSheenOptions;
    compileSubsurfaceOptions(expression: ts.Expression): CompiledSubsurfaceOptions;
    compileShaderMaterialOptions(expression: ts.Expression): {
        name: string;
        id: number;
        dynamicUniforms?: Array<{
            offset: number;
            components: string[];
        }>;
    };
    reachLineMaterial(node: ts.Node, options: ReachedLineMaterial): {
        name: string;
        id: number;
    };
    reachPhysicsViewerMaterial(node: ts.Node, color: readonly [number, number, number, number]): {
        name: string;
        id: number;
    };
    recordRuntimeMeshProfile(index: number): void;
    guardStaticConstructionRead(operation: string): void;
    reachLinearDepthMaterial(node: ts.Node, options: LinearDepthMaterialOptions): {
        name: string;
        id: number;
    };
    lineMaterialPermutation(name: string, node: ts.Node): LineMaterialPermutation | undefined;
    recordEffect(effect: EffectManifest): number;
    selectToneMapping(name: string, node: ts.Node): void;
    compileNodeMaterialOptions(snippetExpression: ts.Expression, optionsExpression: ts.Expression | undefined): CompiledNodeMaterialCall;
    resolveShaderUniform(material: Value, nameExpression: ts.Expression, expectedCounts: number[]): {
        offset: number;
        count: number;
    };
    resolveShaderTextureSlot(material: Value, nameExpression: ts.Expression): number;
    resolveShaderStorageBufferSlot(material: Value, nameExpression: ts.Expression): number;
    compileShaderUniformComponents(expression: ts.Expression, count: number): string[];
    compilePropertyAnimationClip(nameExpression: ts.Expression, tracksExpression: ts.Expression, optionsExpression: ts.Expression | undefined): {
        cpp: string;
        frameRate: string;
        duration: string;
        target: "mesh" | "camera" | "record";
        paths: readonly string[];
    };
    compilePropertyAnimationTargets(target: Value, paths: readonly string[], node: ts.Expression): {
        cpp: string;
        engineCpp: string;
    };
    compileRecordSetterValue(owner: Value, setter: ts.SetAccessorDeclaration, node: ts.Expression, value: Value): void;
    compilePropertyAnimationGroupOptions(expression: ts.Expression | undefined, clip: Value): string;
    expectStaticArrayLiteral(expression: ts.Expression): ts.ArrayLiteralExpression;
    compileEnvironmentOptions(expression: ts.Expression): {
        groundTextureUrl: string;
        skyboxUrl: string;
        skyboxSize: string;
        brdfUrl: string;
        brdfPathCpp?: string;
        skipSkybox: boolean;
        skipGround: boolean;
    };
    compileDdsEnvironmentOptions(expression: ts.Expression): string;
    compileDdsEnvironmentBackgroundOptions(expression: ts.Expression): {
        groundTextureUrl: string;
        skyboxUrl: string;
        skyboxSize: string;
        enableNoise: boolean;
    };
    referenceSearch(): string;
    isDefaultLibraryIdentifier(identifier: ts.Identifier): boolean;
    isBrowserOnlyLocalCall(call: ts.CallExpression): boolean;
    isNativeUiHelperCall(call: ts.CallExpression): boolean;
    isBrowserOnlyNullableClassFactoryCall(call: ts.CallExpression): boolean;
    compileSceneDefaultRenderTask(expression: ts.Expression | undefined): boolean;
    compileHdrEnvironmentOptions(expression: ts.Expression): {
        faceSize: number;
        useCubemapSkybox: boolean;
        skipGround: boolean;
        skyboxSize: string;
        skyboxPosition: string;
    };
    compileVec3(expression: ts.Expression, precision?: "float" | "double"): string;
    vec3FromRecord(value: Value, node: ts.Node, precision?: "float" | "double"): string;
    castNumber(value: Value, precision: "float" | "double"): string;
    compileVec2(expression: ts.Expression): string;
    compileVec4(expression: ts.Expression): string;
    compileBoolean(expression: ts.Expression): string;
    compileCondition(expression: ts.Expression): string;
    meshTransformDirtyEntry(): "mark_mesh_dirty" | "mark_mesh_runtime_transform";
    compileFrameCallback(expression: ts.Expression, signature?: FrameCallbackSignature, retainCaptures?: boolean): string;
    compileVoidCallback(expression: ts.Expression): string;
    compileF32ArrayCallback(expression: ts.Expression): string;
    compileColor3(expression: ts.Expression): string;
    compileColor4(expression: ts.Expression): string;
    compileNumber(expression: ts.Expression, precision?: "float" | "double"): string;
    compileEnumSwitchLabel(expression: ts.Expression, dataType: DataType & {
        kind: "enum";
    }): string | undefined;
    isNumberExpression(expression: ts.Expression): boolean;
    expectObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression;
    objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined;
    propertyName(name: ts.PropertyName): string | undefined;
    compileStringLiteral(expression: ts.Expression): string;
    staticAssetUrlCandidates(): readonly string[];
    moduleRelativeAssetUrl(expression: ts.Expression): string | undefined;
    compileDynamicModuleRelativeAssetUrl(expression: ts.Expression): Value | undefined;
    compileEngineCreation(call: ts.CallExpression, cppName: string): Value;
    allocateTemporaryCppName(label: string): string;
    allocateUserFunctionPrefix(): string;
    allocateBlockPrefix(): string;
    compileStaticString(expression: ts.Expression): string;
    compileShaderSource(expression: ts.Expression): {
        source: string;
        dynamicUniforms: Array<{
            name: string;
            type: "f32";
            components: string[];
        }>;
    };
    resolveStaticExpression(expression: ts.Expression, resolving?: ReadonlySet<ts.Symbol>): ts.Expression;
    lookupIdentifierValue(identifier: ts.Identifier): Value | undefined;
    compileTypedArrayArgument(expression: ts.Expression, kind: TypedArrayKind): string;
    compileForDataSink(expression: ts.Expression, dataType: DataType): string;
    compileSpriteAtlasRecord(value: Value, node: ts.Node): string | undefined;
    compileSpriteAtlas(expression: ts.Expression): Value;
    probeStaticArrayLiteral(expression: ts.Expression): ts.ArrayLiteralExpression | undefined;
    cppLocalName(sourceName: string): string;
    sourceFiles(): readonly ts.SourceFile[];
    reachThrow(): void;
    emitDataVectorOfStructs(node: ts.Node, sourceCpp: string, fieldValues: (element: string) => Readonly<Record<string, string>>): Value;
    reachJsData(): void;
    constructsLocalClass(expression: ts.NewExpression): boolean;
    reachJson(): void;
    reachLocalStorage(): void;
    compileVoxelFileCall(call: ts.CallExpression, callee: ts.Identifier): Value | undefined;
    reachImageDecode(): void;
    snapshotAliasState(): Map<string, string>;
    restoreAliasState(snapshot: Map<string, string>): void;
    enterRuntimeControlFlow(): void;
    leaveRuntimeControlFlow(): void;
    isInRuntimeControlFlow(): boolean;
    enterRuntimeIteration(): void;
    leaveRuntimeIteration(): void;
    isInRuntimeIteration(): boolean;
    isInNativeFunctionBody(): boolean;
    isLocalCallbackEvaluationRepeated(declaration: ts.Node): boolean;
    enterStaticIteration(statement: ts.IterationStatement): void;
    leaveStaticIteration(): void;
    isInParameterizedResourceLoop(statement?: ts.IterationStatement): boolean;
    parameterizedResourceLoop(statement: ResourceLoop, knownIterations?: number): ParameterizedResourceLoop | undefined;
    emitParameterizedResourceLoop(statement: ResourceLoop, iterations: number, emitBody: () => void): void;
    callbackEvaluationIdentity(): object | undefined;
    defineThis(instance: Value | undefined): void;
    namesLocalFunction(identifier: ts.Identifier): boolean;
    resolveRecordMember(expression: ts.PropertyAccessExpression): Value | undefined;
    resolveRecordValue(expression: ts.Expression): Value | undefined;
    compileRecordSetter(owner: Value, setter: ts.SetAccessorDeclaration, value: ts.Expression): void;
    withRecordScopes<T>(owner: Value, work: () => T, method?: ts.Node): T;
    bindClassField(name: ts.Identifier, initializer: ts.Expression, declared?: DataType): void;
    bindNullableClassField(name: ts.Identifier): Value | undefined;
    bindUninitializedClassDataField(name: ts.Identifier, declared?: DataType): Value | undefined;
    bindOptionalResourceValue(name: ts.Identifier): Value | undefined;
    bindClassDataField(name: ts.Identifier, initializer: ts.Expression, declared?: DataType, knownValue?: Value): Value | undefined;
    resolveThisField(name: string): Value | undefined;
    activeThis(): Value | undefined;
    registerClassInstance(instance: Value, declaration: ts.ClassDeclaration): void;
    classOf(instance: Value): ts.ClassDeclaration | undefined;
    callbackIdentity(declaration: ts.Node, owner: Value | undefined): number;
    defaultEngine(): string | undefined;
    reachJsRandom(): void;
    emitNativeCallbackStorage(cppName: string, signature: string, escapesEmittingScope: boolean): Value<"callback">;
    probeEmission<T>(probe: () => T, answered?: (result: T) => boolean): T;
    captureEmittedLines(emitBody: () => void): string[];
    recordAccessor(owner: Value, mapType: string, entries: readonly string[], canHoist: boolean): string;
    registerNativeFunction(prototype: string, definitionLines: string[]): void;
    registerSharedNativeFunction(name: string, definitionLines: string[], localBindings: readonly string[]): string;
    canReplaySharedCallEffects(body: ts.Node): boolean;
    beginNativeFunctionBody(returnType: DataType | undefined, contextualVoid?: boolean, options?: NativeFunctionBodyOptions): void;
    prefersNativeDataIteration(): boolean;
    endNativeFunctionBody(): void;
    registerNativeBinding(name: string, borrowed?: boolean, allowReference?: boolean): NativeCaptureBinding;
    nativeBindingCheckpoint(): number;
    captureHoistedLines(emitBody: () => void, beforeBody: number, site: ts.Node): string[];
    useNativeValue(value: Value, seen?: Set<Value>): void;
    captureNativeExpression(compile: () => string): NativeExpression;
    captureManagedClosureLines(emitBody: () => void, byReference?: boolean | "entry"): CapturedClosure;
    beginInlineFrame(wrapped: boolean): void;
    endInlineFrame(): void;
    trackResourceLoopEarlyReturn(condition: ts.Expression): void;
    activeNativeReturnType(): DataType | "void" | undefined;
    activeInlineWrapper(): boolean;
    emitNativeReturn(statement: ts.ReturnStatement): void;
    emitDataAssignment(expression: ts.BinaryExpression): boolean;
    emitDataPostfix(expression: ts.PostfixUnaryExpression): boolean;
    noteCameraVectorSet(vector: NonNullable<Value["cameraVector"]>, site: ts.Node): void;
    noteCameraVectorCopy(value: Value, site: ts.Node): void;
    noteTemporalAdmissionFailure(node: ts.Node, message: string): void;
    noteMaterialColorRead(property: "baseColorFactor" | "diffuseColor"): void;
    noteMaterialColorObjectWrite(node: ts.Node, property: "baseColorFactor" | "diffuseColor"): void;
    noteMaterialColorRenderBoundary(node: ts.Node, reason: string, always?: boolean): void;
    noteTemporalRecordBoundary(node: ts.Node, reason: string, mode?: "runtime" | "registration" | "always", scene?: Value): void;
    noteTemporalCameraControl(node: ts.Node): void;
    assignOptionalResourceValue(target: Value, value: Value, node: ts.Node): void;
    emitOptionalResourceAssignment(expression: ts.BinaryExpression, target: Value): boolean;
    dataIterationTarget(expression: ts.Expression, knownTuple?: Value): {
        container: Value;
        element: DataIterationElement;
        template?: Value;
    } | undefined;
    requiresStaticDataIteration(statement: ts.Node): boolean;
    canShareFunctionBody(body: ts.Node): boolean;
    compileSharedMethod(declaration: ts.MethodDeclaration, call: ts.CallExpression, arguments_: readonly Value[]): Value | undefined;
    emitNativeDataIteration<T>(statement: ts.Statement, emitBody: () => T): T;
    dataValue(cpp: string, dataType: DataType): Value;
    compileAnimationGroupList(expression: ts.Expression): {
        cpp: string;
        engineCpp: string;
    };
    assetEntitiesIterationTarget(expression: ts.Expression): Value | undefined;
    assetRootElementAccess(expression: ts.ElementAccessExpression): Value | undefined;
    assetFlattenedMeshesIterationTarget(expression: ts.Expression): {
        target: HandleCollectionTarget;
        asset: CompileAsset;
    } | undefined;
    isFoldedFlattenLoop(statement: ts.Statement): boolean;
    assetRootChildrenIterationTarget(expression: ts.Expression): HandleCollectionTarget | undefined;
    handleCollectionIterationTarget(expression: ts.Expression): HandleCollectionTarget | undefined;
    assetMeshCollection(owner: Value, expression: ts.Expression): Value;
    bindDataIterationVariable(name: ts.BindingName, itemCpp: string, element: DataIterationElement, template?: Value): void;
    registerAsset(source: string, kind: CompileAsset["kind"], faceSize?: number): CompileAsset;
    markAssetRootReparented(root: Value, node: ts.Node): void;
    assertAssetRootWritable(root: Value, node: ts.Node): void;
    recordGltfContainerLoad(asset: CompileAsset, node: ts.Node): void;
    enableGltfCameras(node: ts.Node): void;
    probePixelsAsset(expression: ts.Expression): {
        cpp: string;
        source: string;
    } | undefined;
    compileBrowserTextureFunctionCall(call: ts.CallExpression, callee: ts.Identifier): Value | undefined;
    compileExecutedUrlFunctionCall(call: ts.CallExpression, callee: ts.Identifier): Value | undefined;
    registerSpriteAtlasAsset(expression: ts.Expression): string;
    selectGltfVariant(asset: CompileAsset, variantName: string, node: ts.Node): void;
    recordAssetSceneUnlit(asset: CompileAsset, tint: readonly [number, number, number] | undefined, node: ts.Node): void;
    resolveBundledAsset(source: string): string;
    canvasSizeProperty(expression: ts.Expression): "width" | "height" | undefined;
    staticCanvasSize(expression: ts.Expression): number | undefined;
    canvasSizeValue(expression: ts.Expression): Value | undefined;
    isBrowserOnlyExpression(expression: ts.Expression): boolean;
    isBoundedNestedFrameYield(expression: ts.Expression): boolean;
    isBrowserDomValue(expression: ts.Expression): boolean;
    isNativeBrowserFileExpression(expression: ts.Expression): boolean;
    isDeferredCallbackCall(call: ts.CallExpression): boolean;
    evaluateBrowserValue(expression: ts.Expression): Value["browserValue"] | undefined;
    isBrowserInstrumentationCall(call: ts.CallExpression): boolean;
    platformDocumentHidden(): string | undefined;
    compilePlatformCall(call: ts.CallExpression): Value | undefined;
    compileAnimationFrameCall(call: ts.CallExpression): Value | undefined;
    requireCompatibleFrameConductor(owner: "manager" | "persistent", site: ts.Node): void;
    emitPlatformEventListener(call: ts.CallExpression): boolean;
    isCanvasElement(expression: ts.Expression): boolean;
    isFrameYield(expression: ts.Expression): boolean;
    frameDrainCondition(expression: ts.Expression): ts.Expression | undefined;
    emitFramePollAwait(call: ts.CallExpression): boolean;
    emitFrameYieldRequeue(expression: ts.Expression): void;
    promiseLatchCondition(expression: ts.Expression): string | undefined;
    emitStartContinuationGate(expression: ts.Expression, latch: string): void;
    constantInitializer(identifier: ts.Identifier): ts.Expression | undefined;
    moduleFunctionDeclaration(identifier: ts.Identifier): ts.FunctionDeclaration | undefined;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    refuseBorrowedPlatformEventEscape(value: Value, node: ts.Node, destination: string): void;
    declaredDataProperty(expression: ts.PropertyAccessExpression): Value | undefined;
    readResolvedProperty(owner: Value, expression: ts.PropertyAccessExpression): Value | undefined;
    unwrap(expression: ts.Expression): ts.Expression;
    lookup(identifier: ts.Identifier): Value;
    bindPendingLet(identifier: ts.Identifier, value: Value): void;
    rebindVariable(identifier: ts.Identifier, value: Value): void;
    defineVariable(identifier: ts.Identifier, value: Value): void;
    bindLocalValue(identifier: ts.Identifier, value: Value): void;
    bindCompileTimeValue(identifier: ts.Identifier, value: Value): void;
    rebindCompileTimeValue(identifier: ts.Identifier, value: Value): void;
    materializeStaticNativeValue(identifier: ts.Identifier, value: Value): Value;
    bindParameterValue(identifier: ts.Identifier, value: Value): void;
    bindClassParameterValue(identifier: ts.Identifier, argument: ts.Expression): void;
    compileClassParameterValue(identifier: ts.Identifier, argument: ts.Expression): Value;
    materializeEscapingValue(value: Value, label: string, node?: ts.Expression): Value;
    pinValueToTemporary(value: Value, label: string, node?: ts.Expression): Value;
    bindDataTuple(value: Value, arity: number, label?: string): string;
    compileCallbackWithValues(declaration: ts.Identifier | ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration, arguments_: readonly Value[], callNode: ts.Node, discardReturn?: boolean): Value;
    compileStoredDataFunction(expression: ts.Identifier | ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration, dataType: DataType & {
        kind: "function";
    }, owner?: Value): string;
    compilePredicateWithValues(declaration: ts.Identifier | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration, arguments_: readonly Value[], callNode: ts.Node): Value;
    compilePhysicsCollisionCallback(expression: ts.Expression): string;
    compilePhysicsTriggerCallback(expression: ts.Expression): string;
    compilePhysicsCharacterCallback(expression: ts.Expression): string;
    invalidateStaticElements(value: Value, preserveCardinality?: boolean): void;
    knownValueWithoutEvaluation(expression: ts.Expression): Value | undefined;
    knownCollectionCardinality(expression: ts.Expression): number | undefined;
    runtimeCollectionCardinality(expression: ts.Expression): number | undefined;
    recordArrayPush(value: Value, added: number | undefined): boolean;
    recordCollectionKey(value: Value, key: Value, removed?: boolean): void;
    recordCollectionClear(value: Value): void;
    invalidateRecordProperties(value: Value): void;
    pushScope(cppPrefix: string, propagateRebindings?: boolean): void;
    popScope(): void;
    expectKind(value: Value, kind: ValueKind, node: ts.Node): void;
    expectShaderVariant(value: Value, variant: string, node: ts.Node): void;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    requireEngine(value: Value, node: ts.Node): string;
    engineFor(value: Value, node: ts.Node): string;
    audioSessionCpp(): string;
    requireDefaultEngine(node: ts.Node): string;
    requirePresentationHost(node: ts.Node): string;
    get scenePbrMaterials(): ScenePbrMaterialManifest[];
    recordScenePbrNoColorView(sourceIndex: number | undefined): number;
    recordSceneMaterialSlot(): number;
    currentGltfAssetCount(): number;
    recordScenePbrUnlit(index: number | undefined): void;
    recordScenePbrSkybox(index: number | undefined): void;
    recordScenePbrGammaAlbedo(index: number | undefined): void;
    recordScenePbrShadowOnly(index: number | undefined, options: NonNullable<ScenePbrMaterialManifest["shadowOnly"]>): void;
    recordScenePbrPlugins(plugins: readonly MaterialPluginManifest[], index: number | undefined): void;
    recordStandardMaterialPlugins(plugins: readonly MaterialPluginManifest[], material: NonNullable<Value["standardMaterialInput"]>): number;
    withBoundParameters<T>(parameters: readonly {
        name: ts.Identifier;
        value: Value;
    }[], work: () => T): T;
    recordScenePbrSheen(sheen: ScenePbrSheenManifest, index: number | undefined): void;
    recordScenePbrClearCoat(clearCoat: ScenePbrClearCoatManifest, index: number | undefined): void;
    recordScenePbrEmissive(color: readonly [number, number, number] | undefined, index: number | undefined): void;
    recordScenePbrIridescence(iridescence: ScenePbrIridescenceManifest, index: number | undefined): void;
    recordScenePbrLightmap(lightmap: ScenePbrLightmapManifest, index: number | undefined): void;
    pbrLightmapEnabled(): boolean;
    recordAssetSceneLightmap(meshNamePredicate: SceneMeshNamePredicate, lightmap: ScenePbrLightmapManifest, node: ts.Node): void;
    recordScenePbrSubsurface(subsurface: ScenePbrSubsurfaceManifest, index: number | undefined): void;
    recordScenePbrAnisotropy(anisotropy: ScenePbrAnisotropyManifest, index: number | undefined): void;
    recordScenePbrMetallicReflectance(reflectance: ScenePbrMetallicReflectanceManifest, index: number | undefined): void;
    recordPlainSpriteProgram(family: "sprite" | "billboard"): void;
    recordPureSpriteVertex(): void;
    spriteCustomShaders(): readonly SpriteCustomShaderManifest[];
    recordSpriteCustomShader(shader: SpriteCustomShaderManifest): void;
    recordSplatFragments(fragments: readonly SplatFragmentManifest[], node: ts.Node): void;
    recordShadowGenerator(entry: Omit<ShadowGeneratorManifest, "casters"> & {
        lightIdentity?: NonNullable<Value["lightIdentity"]>;
    }): number;
    recordDataLightSlot(value: Value, index: number): void;
    shadowGeneratorLight(index: number, node: ts.Node): {
        lightIndex: number;
    };
    recordThinInstanceColorMesh(sceneMeshIndex: number | undefined): void;
    recordSceneMeshMaterial(meshIndex: number, material: {
        pbrMaterial: number | null;
        nodeMaterial: number | null;
        standardMaterial: boolean;
        standardMaterialPluginIndex?: number | undefined;
        sceneShaderVariant?: string | undefined;
        sceneShaderVariants?: readonly string[] | undefined;
    }): void;
    recordUnknownSceneMeshMaterial(materialIndex: number): void;
    recordUnknownSceneMaterialAssignment(): void;
    recordUnknownStandardMeshMaterial(): void;
    recordSceneMeshAssetPbrMaterial(meshIndex: number): void;
    recordSceneMeshDeformation(meshIndex: number, property: "skinned" | "morphTargets", site: ts.Node): void;
    recordShadowCasters(generatorIndex: number, casters: readonly ShadowCasterMeshManifest[]): void;
    recordDynamicShadowCasters(generatorIndex: number): void;
    recordDynamicShadowCastersForUnknownGenerator(): void;
    esmGeneratorOrdinal(): number;
    recordShadowReceiver(sceneMeshIndex: number): void;
    recordDynamicShadowReceivers(): void;
    recordSceneMeshId(meshCpp: string, id: string, node: ts.Node): void;
    resolveSceneMeshIds(ids: readonly string[], node: ts.Node): string[];
    addSceneLight(scene: Value, light: Value, kind: LightKind): void;
    addDynamicSceneLight(): void;
    removeSceneLight(scene: Value, light: Value): void;
    recordToneMappingEnabledMutation(): void;
    recordThinInstanceMesh(sceneMeshIndex: number | undefined): void;
    meshHasThinInstancePool(owner: Value): boolean;
    recordThinInstanceGpuCulling(sceneMeshIndex: number | undefined): void;
    meshMayHaveThinInstanceGpuCulling(owner: Value): boolean;
    recordSceneMesh(kind: string, streams?: {
        hasUv2: boolean;
        hasTangents: boolean;
        hasColors: boolean;
        runtimeStreams?: true;
    }): number;
    reachClusteredContainer(state: ClusteredContainerState, node: ts.Node): void;
    reachFeature(feature: Feature, site?: ts.Node | string): void;
    gltfAlreadyLoaded(): boolean;
    ensureDefaultRenderTask(scene: Value, node: ts.Node): DefaultRenderTaskEmission;
    importedName(identifier: ts.Identifier): string | undefined;
    requiresStaticIteration(statement: ts.Statement): boolean;
    eraseBrowserInstrumentation(position: number): void;
    recordGeometryOutputTask(manifest: GeometryOutputTaskManifest): void;
    recordPostProcessTask(manifest: PostProcessTaskManifest): void;
    recordPostProcessComposite(manifest: PostProcessCompositeManifest, site: ts.Node): void;
    recordScreenSpaceTask(manifest: ScreenSpaceTaskManifest): void;
    expectArgumentCount(call: ts.CallExpression, minimum: number, maximum: number): void;
    cppString(value: string): string;
    engineHasStarted(): boolean;
    hasRegisteredScene(): boolean;
    emit(line: string | NativeDeclaration): void;
    compileDeviceRecoveryIntrinsic(name: string, call: ts.CallExpression): Value | undefined;
    markEngineStart(engineCpp: string, node: ts.Node): void;
    emitFinallyGuard(cleanup: readonly string[]): string;
    emitEngineFinally(body: readonly string[], cleanup: readonly string[], site: ts.TryStatement): boolean;
    isEntryBodyScope(): boolean;
    increaseIndent(): void;
    decreaseIndent(): void;
    fail(node: ts.Node, message: string): never;
}
