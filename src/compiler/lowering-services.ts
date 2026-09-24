import type ts from "typescript";
import type { AssetDecoderConfiguration } from "../asset-decoders.js";
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
import type {
    LineMaterialPermutation,
    ReachedLineMaterial,
} from "./line-material.js";
import type { LinearDepthMaterialOptions } from "../lowering/linear-depth-lowerer.js";
import type { DataLowerer } from "./data-lowering.js";
import type {
    DataTypeRegistry,
    DataIterationElement,
    DataType,
    TypedArrayKind,
} from "./data-types.js";
import type { NativeFunctionLowerer } from "./native-functions.js";
import type { CompilerSymbols } from "./symbols.js";
import type { StaticEvaluator } from "./static-evaluator.js";
import type {
    HandleCollections,
    HandleCollectionTarget,
} from "./handle-collections.js";
import type {
    CallbackInvocationOptions,
    SupportedFunction,
    UserFunctionLowerer,
} from "./user-functions.js";
import type {
    CompileAsset,
    DefaultRenderTaskEmission,
    Feature,
    GeometryOutputTaskManifest,
    ResolvedCompileOptions,
    FrameCallbackSignature,
    Value,
    ValueKind,
} from "./types.js";
import type {
    CapturedClosure,
    NativeCaptureBinding,
    NativeExpression,
} from "./closure-captures.js";
import type { NativeDeclaration } from "./native-declarations.js";
import type {
    ParameterizedResourceLoop,
    ResourceLoop,
} from "./resource-loops.js";
import type { ClassLowerer } from "./classes.js";
import type { SceneManifestRecorder } from "./scene-manifest.js";
import type { BindingScopes } from "./binding-scopes.js";
import type { ConditionLowerer } from "./conditions.js";
import type { BrowserErasure } from "./browser-erasure.js";
import type { DeclarationLowerer } from "./declarations.js";
import type { PropertyAccessLowerer } from "./properties.js";

/** Convert an already evaluated return value, including adopted promise results. */
export type NativeReturnValueCompiler = (
    value: Value,
    type: DataType,
    node: ts.Node,
) => string;

/** Execution facts for one native function body. */
export interface NativeFunctionBodyOptions {
    coroutine?: boolean;
    /** A namespace-scope definition: the entry's bindings, its engine among them, are out of scope. */
    namespaceScope?: boolean;
    runtimeDataLoops?: boolean;
    callSiteEffects?: boolean;
    compileReturn?: (expression: ts.Expression, type: DataType) => string;
}

/** Shared compiler operations; each lowering module selects its required services. */
export interface LoweringServices {
    withAsyncActivation<T>(work: () => T): T;
    withEngineBootstrap<T>(declaration: SupportedFunction, work: () => T): T;
    compileAsyncCall(
        declaration: SupportedFunction,
        arguments_: readonly Value[],
        node: ts.Node,
    ): Value | undefined;
    compileSynchronousPromise(node: ts.NewExpression): Value;
    pendingActivations(): import("./pending-activations.js").PendingActivations;
    emitActivationBoundary(
        statement: ts.ExpressionStatement,
        emit: () => boolean | void,
    ): boolean | void;
    compileAsyncReturn(
        expression: ts.Expression,
        type: DataType | undefined,
        compileResult?: NativeReturnValueCompiler,
    ): string;
    emitNativeThrow(
        errorCpp: string,
        node?: ts.ThrowStatement,
        rethrow?: boolean,
    ): void;
    isInFrameCallback(): boolean;
    hasPresentationHost(): boolean;
    hasFeature(feature: Feature): boolean;
    failAtFile(message: string): never;
    hoistForwardCallbackBindings(callback: ts.Expression, before: number): void;
    platformEventCallbackIdentity(callback: Value, node: ts.Node): string;
    compilePlatformCallback(
        callback: ts.Expression,
        parameter: { cppType: string; name: string } | undefined,
        values: readonly Value[],
        documentHiddenCpp?: string,
        captureByValue?: boolean,
        assignIdentity?: boolean,
    ): { cpp: string; identity: string };
    readonly sourceFile: ts.SourceFile;
    readonly checker: ts.TypeChecker;
    readonly options: ResolvedCompileOptions;
    readonly symbols: CompilerSymbols;
    readonly evaluator: StaticEvaluator;
    readonly handleCollections: HandleCollections;
    readonly sceneManifest: SceneManifestRecorder;
    readonly bindings: BindingScopes;
    readonly conditions: ConditionLowerer;
    readonly browserErasure: BrowserErasure;
    readonly declarations: DeclarationLowerer;
    readonly propertyAccess: PropertyAccessLowerer;
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
    functionEmissionScope(): import("./function-specializations.js").FunctionEmissionScope;
    readonly assets: Map<string, CompileAsset>;
    setAssetDecoderConfiguration(
        configuration: AssetDecoderConfiguration,
        node: ts.Node,
    ): void;
    readonly assetPayloads: Map<string, string>;
    readonly boundPixelsTextures: Set<string>;
    readonly erasedBrowserExpressions: Set<number>;
    readonly erasedBrowserInstrumentation: Set<number>;
    readonly unwrappedAwaitExpressions: Set<number>;
    readonly localCubemapState: {
        maxCandidates?: number;
    };
    hasMainEntry: boolean;
    defaultRenderTaskAdapted: boolean;
    isNativeHostUiLookup(call: ts.CallExpression): boolean;
    emitStatement(statement: ts.Statement): void;
    statementTerminatesAfterLowering(statement: ts.Statement): boolean;
    emitExpressionAsStatement(expression: ts.Expression): void;
    compileTextMutation(expression: ts.Expression): Value | undefined;
    compileNodeInputMutation(expression: ts.Expression): Value | undefined;
    checkNodeGeometryMutation(expression: ts.Expression): void;
    noteNodeGeometryMutation(node: ts.Node): void;
    assertNodeInputMutable(node: ts.Node): void;
    noteNodeInputAdmissionFailure(node: ts.Node, message: string): void;
    noteTextCameraControl(
        node: ts.Node,
        camera: Value,
        arcRotate: boolean,
    ): void;
    noteTextSceneLifecycle(node: ts.Node, message?: string): void;
    noteTextSceneCameraAssignment(node: ts.Node): void;
    assertTextPipelineMutable(node: ts.Node): void;
    promoteTextData(node: ts.Node): void;
    recordTextAttachment(node: ts.Node): void;
    assertTextDisposal(node: ts.Node): void;
    emitDiscardedValue(value: Value): void;
    emitAssignment(expression: ts.BinaryExpression): void;
    /** `??=`, `||=`, `&&=` over a data-model target; any other target refuses. */
    emitLogicalAssignment(expression: ts.BinaryExpression): void;
    /** `delete object[key]` / `delete object.field` over the data model. */
    emitDelete(expression: ts.DeleteExpression): void;
    recordDataAssignmentMetadata(
        target: Value,
        source: ts.Expression,
        destination?: ts.Expression,
    ): boolean;
    isNativeUiValueExpression(expression: ts.Expression): boolean;
    readonly uiDegradedStyleProperties: Set<string>;
    readonly uiScopedSheetSelectors: Set<string>;
    emitUiPropertyAssignment(expression: ts.BinaryExpression): boolean;
    compileValue(expression: ts.Expression): Value;
    compileWorkerValue(expression: ts.Expression): Value | undefined;
    emitAwaitExpression(expression: ts.Expression): boolean;
    withOwnedCallbackBody<T>(body: () => T): T;
    withAsyncInvocation<T>(node: ts.Node, body: () => T): T;
    isNativeWorkerExpression(expression: ts.Expression): boolean;
    workerCheckpointCpp(): string | undefined;
    workerAbortCpp(): string | undefined;
    compileAsyncEngineStart(engine: Value, node: ts.Node): Value | undefined;
    compileWorkerCallback(
        expression: ts.Expression,
        event: "message" | "error",
    ): string;
    staticStringElements(
        expression: ts.Expression,
    ): readonly string[] | undefined;
    constArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined;
    compileBrowserGeneratedString(call: ts.CallExpression): Value | undefined;
    compileRegisteredConstant(importedName: string): Value | undefined;
    compileStaticFetch(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined;
    compileStaticFetchMethod(
        call: ts.CallExpression,
        owner: Value,
        method: string,
    ): Value | undefined;
    compileRegisteredIntrinsic(
        importedName: string,
        call: ts.CallExpression,
    ): Value | undefined;
    isRuntimeResourceConstruction(): boolean;
    compileThinInstanceUploadHelper(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined;
    compilePixelsTextureUpload(call: ts.CallExpression): Value | undefined;
    compileBoxOptions(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): [string, string, string];
    compileRenderTargetOptions(
        expression: ts.Expression,
    ): CompiledRenderTargetOptions;
    compileRenderTaskOptions(expression: ts.Expression): string;
    compileGeometryTaskOptions(expression: ts.Expression): {
        cpp: string;
        manifest: GeometryOutputTaskManifest;
    };
    compileCopyTaskOptions(expression: ts.Expression): string;
    compileGroundOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string];
    compileGroundFromHeightMapOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string, string, string];
    compilePlaneOptions(expression: ts.Expression): [string, string];
    compileSphereOptions(
        expression: ts.Expression,
    ): [string, string, string, string];
    compileTorusOptions(expression: ts.Expression): [string, string, string];
    compilePbrMaterialOptions(
        expression: ts.Expression,
    ): CompiledPbrMaterialOptions;
    compileMetallicReflectanceOptions(
        expression: ts.Expression,
    ): CompiledMetallicReflectanceOptions;
    compileGridMaterialOptions(expression: ts.Expression): string[];
    compileClearCoatOptions(
        expression: ts.Expression,
    ): CompiledClearCoatOptions;
    compileIridescenceOptions(
        expression: ts.Expression,
    ): CompiledIridescenceOptions;
    compileAnisotropyOptions(
        expression: ts.Expression,
    ): CompiledAnisotropyOptions;
    compileSheenOptions(expression: ts.Expression): CompiledSheenOptions;
    compileSubsurfaceOptions(
        expression: ts.Expression,
    ): CompiledSubsurfaceOptions;
    compileShaderMaterialOptions(expression: ts.Expression): {
        name: string;
        id: number;
        dynamicUniforms?: Array<{
            offset: number;
            components: string[];
        }>;
    };
    reachLineMaterial(
        node: ts.Node,
        options: ReachedLineMaterial,
    ): {
        name: string;
        id: number;
    };
    reachPhysicsViewerMaterial(
        node: ts.Node,
        color: readonly [number, number, number, number],
    ): {
        name: string;
        id: number;
    };
    guardStaticConstructionRead(operation: string): void;
    reachLinearDepthMaterial(
        node: ts.Node,
        options: LinearDepthMaterialOptions,
    ): {
        name: string;
        id: number;
    };
    lineMaterialPermutation(
        name: string,
        node: ts.Node,
    ): LineMaterialPermutation | undefined;
    compileNodeMaterialOptions(
        snippetExpression: ts.Expression,
        optionsExpression: ts.Expression | undefined,
    ): CompiledNodeMaterialCall;
    resolveShaderUniform(
        material: Value,
        nameExpression: ts.Expression,
        expectedCounts: number[],
    ): {
        offset: number;
        count: number;
    };
    resolveShaderTextureSlot(
        material: Value,
        nameExpression: ts.Expression,
    ): number;
    resolveShaderStorageBufferSlot(
        material: Value,
        nameExpression: ts.Expression,
    ): number;
    compileShaderUniformComponents(
        expression: ts.Expression,
        count: number,
    ): string[];
    compilePropertyAnimationClip(
        nameExpression: ts.Expression,
        tracksExpression: ts.Expression,
        optionsExpression: ts.Expression | undefined,
    ): {
        cpp: string;
        frameRate: string;
        duration: string;
        target: "mesh" | "camera" | "record";
        paths: readonly string[];
    };
    compilePropertyAnimationTargets(
        target: Value,
        paths: readonly string[],
        node: ts.Expression,
    ): {
        cpp: string;
        engineCpp: string;
    };
    compileRecordSetterValue(
        owner: Value,
        setter: ts.SetAccessorDeclaration,
        node: ts.Expression,
        value: Value,
    ): void;
    compilePropertyAnimationGroupOptions(
        expression: ts.Expression | undefined,
        clip: Value,
    ): string;
    expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression;
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
    /** The default-library global an expression names (symbols.ts `libraryGlobal`). */
    libraryGlobal(expression: ts.Expression): string | undefined;
    isNativeUiHelperCall(call: ts.CallExpression): boolean;
    compileSceneDefaultRenderTask(
        expression: ts.Expression | undefined,
    ): boolean;
    compileHdrEnvironmentOptions(expression: ts.Expression): {
        faceSize: number;
        useCubemapSkybox: boolean;
        skipGround: boolean;
        skyboxSize: string;
        skyboxPosition: string;
    };
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    vec3FromRecord(
        value: Value,
        node: ts.Node,
        precision?: "float" | "double",
    ): string;
    castNumber(value: Value, precision: "float" | "double"): string;
    compileVec2(expression: ts.Expression): string;
    compileVec4(expression: ts.Expression): string;
    compileBoolean(expression: ts.Expression): string;
    meshTransformDirtyEntry():
        "mark_mesh_dirty" | "mark_mesh_runtime_transform";
    compileFrameCallback(
        expression: ts.Expression,
        signature?: FrameCallbackSignature,
        retainCaptures?: boolean,
    ): string;
    compileVoidCallback(expression: ts.Expression): string;
    compileF32ArrayCallback(expression: ts.Expression): string;
    compileColor3(expression: ts.Expression): string;
    compileColor4(expression: ts.Expression): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileEnumSwitchLabel(
        expression: ts.Expression,
        dataType: DataType & {
            kind: "enum";
        },
    ): string | undefined;
    isNumberExpression(expression: ts.Expression): boolean;
    expectObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    propertyName(name: ts.PropertyName): string | undefined;
    compileStringLiteral(expression: ts.Expression): string;
    staticAssetUrlCandidates(): readonly string[];
    moduleRelativeAssetUrl(expression: ts.Expression): string | undefined;
    compileDynamicModuleRelativeAssetUrl(
        expression: ts.Expression,
    ): Value | undefined;
    compileEngineCreation(call: ts.CallExpression, cppName: string): Value;
    allocateTemporaryCppName(label: string): string;
    registerNativeTemporary(name: string, type?: DataType): void;
    registerNativeConstBinding(
        name: string,
        allowReference?: boolean,
    ): NativeCaptureBinding;
    takeNativeTemporary(cpp: string, boundary: number): string;
    identifierIsRebound(identifier: ts.Identifier): boolean;
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
    resolveStaticExpression(
        expression: ts.Expression,
        resolving?: ReadonlySet<ts.Symbol>,
    ): ts.Expression;
    lookupIdentifierValue(identifier: ts.Identifier): Value | undefined;
    compileTypedArrayArgument(
        expression: ts.Expression,
        kind: TypedArrayKind,
    ): string;
    compileForDataSink(expression: ts.Expression, dataType: DataType): string;
    compileSpriteAtlasRecord(value: Value, node: ts.Node): string | undefined;
    compileSpriteAtlas(expression: ts.Expression): Value;
    probeStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined;
    sourceFiles(): readonly ts.SourceFile[];
    reachThrow(): void;
    emitDataVectorOfStructs(
        node: ts.Node,
        sourceCpp: string,
        fieldValues: (element: string) => Readonly<Record<string, string>>,
    ): Value;
    reachJsData(): void;
    constructsLocalClass(expression: ts.NewExpression): boolean;
    reachJson(): void;
    reachLocalStorage(): void;
    compileVoxelFileCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined;
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
    parameterizedResourceLoop(
        statement: ResourceLoop,
        knownIterations?: number,
    ): ParameterizedResourceLoop | undefined;
    emitParameterizedResourceLoop(
        statement: ResourceLoop,
        iterations: number,
        emitBody: () => void,
    ): void;
    callbackEvaluationIdentity(): object | undefined;
    defineThis(instance: Value | undefined): void;
    namesLocalFunction(identifier: ts.Identifier): boolean;
    resolveRecordMember(
        expression: ts.PropertyAccessExpression,
    ): Value | undefined;
    resolveRecordValue(expression: ts.Expression): Value | undefined;
    compileRecordSetter(
        owner: Value,
        setter: ts.SetAccessorDeclaration,
        value: ts.Expression,
    ): void;
    withRecordScopes<T>(owner: Value, work: () => T, method?: ts.Node): T;
    captureRecordScopes(): Pick<Value, "recordScopes" | "recordTypeArguments">;
    bindClassField(
        name: ts.MemberName,
        initializer: ts.Expression,
        declared?: DataType,
    ): void;
    bindNullableClassField(name: ts.MemberName): Value | undefined;
    bindUninitializedClassDataField(
        name: ts.MemberName,
        declared?: DataType,
    ): Value | undefined;
    bindOptionalResourceValue(name: ts.Identifier): Value | undefined;
    bindClassDataField(
        name: ts.MemberName,
        initializer: ts.Expression,
        declared?: DataType,
        knownValue?: Value,
    ): Value | undefined;
    resolveThisField(name: string): Value | undefined;
    activeThis(): Value | undefined;
    registerClassInstance(
        instance: Value,
        declaration: ts.ClassDeclaration,
    ): void;
    classOf(instance: Value): ts.ClassDeclaration | undefined;
    callbackIdentity(declaration: ts.Node, owner: Value | undefined): number;
    defaultEngine(): string | undefined;
    reachJsRandom(): void;
    emitNativeCallbackStorage(
        cppName: string,
        signature: string,
        escapesEmittingScope: boolean,
    ): Value<"callback">;
    probeEmission<T>(probe: () => T, answered?: (result: T) => boolean): T;
    /** True while a speculative probe is open: a refusal inside is the probe's to decide. */
    readonly speculating: boolean;
    /** Runs `work` in an emission transaction: committed on return, rolled back on a throw. */
    transaction(work: () => void): void;
    captureEmittedLines(emitBody: () => void): string[];
    recordAccessor(
        owner: Value,
        mapType: string,
        entries: readonly string[],
        canHoist: boolean,
    ): string;
    registerNativeFunction(
        prototype: string,
        definitionLines: string[],
        source?: ts.Node,
    ): void;
    registerSharedNativeFunction(
        name: string,
        definitionLines: string[],
        localBindings: readonly string[],
        declaration?: { source: ts.Node; prototype: string },
    ): string;
    renderSharedCoroutine(
        closure: CapturedClosure,
        returnType: string,
        source: ts.Node,
        parameters?: string,
        args?: string,
        environment?: string,
        parameterNames?: readonly string[],
    ): string;
    renderSharedClosure(
        closure: CapturedClosure,
        returnType: string,
        source: ts.Node,
        parameters: string,
        parameterNames: readonly string[],
        name?: string,
    ): string;
    registerNativeTemplate(
        name: string,
        lines: string[],
        prototype?: string,
    ): void;
    canReplaySharedCallEffects(body: ts.Node): boolean;
    beginNativeFunctionBody(
        returnType: DataType | undefined,
        contextualVoid?: boolean,
        options?: NativeFunctionBodyOptions,
    ): void;
    prefersNativeDataIteration(): boolean;
    endNativeFunctionBody(): void;
    registerNativeBinding(
        name: string,
        borrowed?: boolean,
        allowReference?: boolean,
        cppType?: string,
    ): NativeCaptureBinding;
    registerNativeBindingType(name: string, cppType: string): void;
    nativeBindingCheckpoint(): number;
    captureHoistedLines(
        emitBody: () => void,
        beforeBody: number,
        site: ts.Node,
    ): string[];
    useNativeValue(value: Value, seen?: Set<Value>): void;
    captureNativeExpression(compile: () => string): NativeExpression;
    captureManagedClosureLines(
        emitBody: () => void,
        byReference?: boolean | "entry",
    ): CapturedClosure;
    beginInlineFrame(wrapped: boolean): void;
    endInlineFrame(): void;
    trackResourceLoopEarlyReturn(condition: ts.Expression): void;
    activeNativeReturnType(): DataType | "void" | undefined;
    activeInlineWrapper(): boolean;
    emitNativeReturn(statement: ts.ReturnStatement): void;
    emitDataAssignment(expression: ts.BinaryExpression): boolean;
    emitDataPostfix(expression: ts.PostfixUnaryExpression): boolean;
    noteCameraVectorSet(
        vector: NonNullable<Value["cameraVector"]>,
        site: ts.Node,
    ): void;
    noteCameraVectorCopy(value: Value, site: ts.Node): void;
    noteTemporalAdmissionFailure(node: ts.Node, message: string): void;
    noteMaterialColorRead(property: "baseColorFactor" | "diffuseColor"): void;
    noteMaterialColorObjectWrite(
        node: ts.Node,
        property: "baseColorFactor" | "diffuseColor",
    ): void;
    noteMaterialColorRenderBoundary(
        node: ts.Node,
        reason: string,
        always?: boolean,
    ): void;
    noteTemporalRecordBoundary(
        node: ts.Node,
        reason: string,
        mode?: "runtime" | "registration" | "always",
        scene?: Value,
    ): void;
    noteTemporalCameraControl(
        node: ts.Node,
        tracksWorldMatrixVersion?: boolean,
    ): void;
    assignOptionalResourceValue(
        target: Value,
        value: Value,
        node: ts.Node,
    ): void;
    emitOptionalResourceAssignment(
        expression: ts.BinaryExpression,
        target: Value,
    ): boolean;
    dataIterationTarget(
        expression: ts.Expression,
        knownTuple?: Value,
    ):
        | {
              container: Value;
              element: DataIterationElement;
              template?: Value;
          }
        | undefined;
    requiresStaticDataIteration(statement: ts.Node): boolean;
    canShareFunctionBody(body: ts.Node): boolean;
    compileSharedMethod(
        declaration: ts.MethodDeclaration,
        call: ts.CallExpression,
        arguments_: readonly Value[],
    ): Value | undefined;
    emitNativeDataIteration<T>(statement: ts.Statement, emitBody: () => T): T;
    dataValue(cpp: string, dataType: DataType): Value;
    compileAnimationGroupList(expression: ts.Expression): {
        cpp: string;
        engineCpp: string;
    };
    assetEntitiesIterationTarget(expression: ts.Expression): Value | undefined;
    assetRootElementAccess(
        expression: ts.ElementAccessExpression,
    ): Value | undefined;
    assetFlattenedMeshesIterationTarget(expression: ts.Expression):
        | {
              target: HandleCollectionTarget;
              asset: CompileAsset;
          }
        | undefined;
    isFoldedFlattenLoop(statement: ts.Statement): boolean;
    assetRootChildrenIterationTarget(
        expression: ts.Expression,
    ): HandleCollectionTarget | undefined;
    handleCollectionIterationTarget(
        expression: ts.Expression,
    ): HandleCollectionTarget | undefined;
    assetMeshCollection(owner: Value, expression: ts.Expression): Value;
    bindDataIterationVariable(
        name: ts.BindingName,
        itemCpp: string,
        element: DataIterationElement,
        template?: Value,
    ): void;
    registerAsset(
        source: string,
        kind: CompileAsset["kind"],
        faceSize?: number,
    ): CompileAsset;
    markAssetRootReparented(root: Value, node: ts.Node): void;
    assertAssetRootWritable(root: Value, node: ts.Node): void;
    recordGltfContainerLoad(asset: CompileAsset, node: ts.Node): void;
    enableGltfCameras(node: ts.Node): void;
    probePixelsAsset(expression: ts.Expression):
        | {
              cpp: string;
              source: string;
          }
        | undefined;
    compileBrowserTextureFunctionCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined;
    compileExecutedUrlFunctionCall(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined;
    registerSpriteAtlasAsset(expression: ts.Expression): string;
    selectGltfVariant(
        asset: CompileAsset,
        variantName: string,
        node: ts.Node,
    ): void;
    recordAssetSceneUnlit(
        asset: CompileAsset,
        tint: readonly [number, number, number] | undefined,
        node: ts.Node,
    ): void;
    resolveBundledAsset(source: string): string;
    canvasSizeProperty(
        expression: ts.Expression,
    ): "width" | "height" | undefined;
    staticCanvasSize(expression: ts.Expression): number | undefined;
    canvasSizeValue(expression: ts.Expression): Value | undefined;
    isBoundedNestedFrameYield(expression: ts.Expression): boolean;
    isBrowserInstrumentationCall(call: ts.CallExpression): boolean;
    platformDocumentHidden(): string | undefined;
    compilePlatformCall(call: ts.CallExpression): Value | undefined;
    compileAnimationFrameCall(call: ts.CallExpression): Value | undefined;
    requireCompatibleFrameConductor(
        owner: "manager" | "persistent",
        site: ts.Node,
    ): void;
    emitPlatformEventListener(call: ts.CallExpression): boolean;
    isCanvasElement(expression: ts.Expression): boolean;
    isFrameYield(expression: ts.Expression): boolean;
    emitFramePollAwait(call: ts.CallExpression): boolean;
    emitFrameYieldRequeue(expression: ts.Expression): void;
    promiseLatchCondition(expression: ts.Expression): string | undefined;
    emitStartContinuationGate(expression: ts.Expression, latch: string): void;
    constantInitializer(identifier: ts.Identifier): ts.Expression | undefined;
    moduleFunctionDeclaration(
        identifier: ts.Identifier,
    ): ts.FunctionDeclaration | undefined;
    refuseBorrowedPlatformEventEscape(
        value: Value,
        node: ts.Node,
        destination: string,
    ): void;
    unwrap(expression: ts.Expression): ts.Expression;
    /** Whether a caught value bound to `binding` is only reported by `body`, so it needs no native representation. */
    catchBindingIsErased(binding: ts.Identifier, body: ts.Node): boolean;
    materializeStaticNativeValue(
        identifier: ts.Identifier,
        value: Value,
    ): Value;
    bindClassParameterValue(
        identifier: ts.Identifier,
        argument: ts.Expression,
    ): void;
    compileClassParameterValue(
        identifier: ts.Identifier,
        argument: ts.Expression,
    ): Value;
    compileCallbackWithValues(
        declaration:
            | ts.Identifier
            | ts.FunctionDeclaration
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        arguments_: readonly Value[],
        callNode: ts.Node,
        discardReturn?: boolean,
        body?: CallbackInvocationOptions,
    ): Value;
    compileStoredDataFunction(
        expression:
            | ts.Identifier
            | ts.FunctionDeclaration
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        dataType: DataType & {
            kind: "function";
        },
        owner?: Value,
    ): string;
    compilePredicateWithValues(
        declaration:
            | ts.Identifier
            | ts.ArrowFunction
            | ts.FunctionExpression
            | ts.MethodDeclaration,
        arguments_: readonly Value[],
        callNode: ts.Node,
    ): Value;
    compilePhysicsCollisionCallback(expression: ts.Expression): string;
    compilePhysicsTriggerCallback(expression: ts.Expression): string;
    compilePhysicsCharacterCallback(expression: ts.Expression): string;
    knownValueWithoutEvaluation(expression: ts.Expression): Value | undefined;
    knownCollectionCardinality(expression: ts.Expression): number | undefined;
    runtimeCollectionCardinality(expression: ts.Expression): number | undefined;
    recordArrayPush(value: Value, added: number | undefined): boolean;
    recordCollectionKey(value: Value, key: Value, removed?: boolean): void;
    recordCollectionClear(value: Value): void;
    expectKind(value: Value, kind: ValueKind, node: ts.Node): void;
    expectShaderVariant(value: Value, variant: string, node: ts.Node): void;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    requireEngine(value: Value, node: ts.Node): string;
    engineFor(value: Value, node: ts.Node): string;
    audioSessionCpp(): string;
    requireDefaultEngine(node: ts.Node): string;
    requirePresentationHost(node: ts.Node): string;
    pbrLightmapEnabled(): boolean;
    reachFeature(feature: Feature, site?: ts.Node | string): void;
    gltfAlreadyLoaded(): boolean;
    compileSceneRegistration(scene: Value, node: ts.Node): string;
    ensureDefaultRenderTask(
        scene: Value,
        node: ts.Node,
    ): DefaultRenderTaskEmission;
    importedName(identifier: ts.Identifier): string | undefined;
    requiresStaticIteration(statement: ts.Statement): boolean;
    eraseBrowserInstrumentation(position: number): void;
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    cppString(value: string): string;
    engineHasStarted(): boolean;
    hasRegisteredScene(): boolean;
    emit(line: string | NativeDeclaration): void;
    compileDeviceRecoveryIntrinsic(
        name: string,
        call: ts.CallExpression,
    ): Value | undefined;
    markEngineStart(engineCpp: string, node: ts.Node): void;
    emitFinallyGuard(cleanup: readonly string[]): string;
    emitEngineFinally(
        body: readonly string[],
        cleanup: () => readonly string[],
        site: ts.TryStatement,
    ): boolean;
    isEntryBodyScope(): boolean;
    increaseIndent(): void;
    decreaseIndent(): void;
    fail(node: ts.Node, message: string): never;
}
