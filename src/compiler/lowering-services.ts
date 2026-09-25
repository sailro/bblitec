import type ts from "typescript";
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
import type { HandleCollections } from "./handle-collections.js";
import type {
    CallbackInvocationOptions,
    UserFunctionLowerer,
} from "./user-functions.js";
import type {
    CompileAsset,
    DefaultRenderTaskEmission,
    Feature,
    ResolvedCompileOptions,
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
import type { EvaluationOrder } from "./evaluation-order.js";
import type { SceneManifestRecorder } from "./scene-manifest.js";
import type { BindingScopes } from "./binding-scopes.js";
import type { ConditionLowerer } from "./conditions.js";
import type { BrowserErasure } from "./browser-erasure.js";
import type { DeclarationLowerer } from "./declarations.js";
import type { PropertyAccessLowerer } from "./properties.js";
import type { CallbackLowerer } from "./callbacks.js";
import type { AsyncActivations } from "./async-activations.js";
import type { EngineLifecycle } from "./engine-lifecycle.js";
import type { SharedClosureAnalysis } from "./shared-closure-analysis.js";
import type { NativeEmissionRegistry } from "./native-emission-registry.js";
import type { AssetRegistry } from "./asset-registry.js";
import type { AdmissionRecorder } from "./admissions.js";
import type { IntrinsicOptions } from "./intrinsic-options.js";

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
    emitNativeThrow(
        errorCpp: string,
        node?: ts.ThrowStatement,
        rethrow?: boolean,
    ): void;
    isInFrameCallback(): boolean;
    hasPresentationHost(): boolean;
    hasFeature(feature: Feature): boolean;
    failAtFile(message: string): never;
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
    readonly callbacks: CallbackLowerer;
    readonly asyncActivations: AsyncActivations;
    readonly engineLifecycle: EngineLifecycle;
    readonly sharedClosures: SharedClosureAnalysis;
    readonly nativeEmission: NativeEmissionRegistry;
    readonly assetRegistry: AssetRegistry;
    readonly admissions: AdmissionRecorder;
    readonly intrinsicOptions: IntrinsicOptions;
    readonly userFunctions: UserFunctionLowerer;
    readonly dataTypes: DataTypeRegistry;
    readonly dataLowerer: DataLowerer;
    readonly classLowerer: ClassLowerer;
    readonly evaluationOrder: EvaluationOrder;
    readonly nativeFunctions: NativeFunctionLowerer;
    jsDataReached: boolean;
    fileReaderReached: boolean;
    jsRandomReached: boolean;
    readonly browserTextureFunctions: Set<string>;
    readonly canvasReadbackFunctions: Set<string>;
    functionEmissionScope(): import("./function-specializations.js").FunctionEmissionScope;
    readonly assets: Map<string, CompileAsset>;
    readonly assetOutputs: Map<string, CompileAsset>;
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
    promoteTextData(node: ts.Node): void;
    emitDiscardedValue(value: Value): void;
    emitAssignment(expression: ts.BinaryExpression): void;
    /** `delete object[key]` / `delete object.field` over the data model. */
    emitDelete(expression: ts.DeleteExpression): void;
    recordDataAssignmentMetadata(
        target: Value,
        source: ts.Expression,
        destination?: ts.Expression,
    ): boolean;
    isNativeUiValueExpression(expression: ts.Expression): boolean;
    emitUiPropertyAssignment(expression: ts.BinaryExpression): boolean;
    compileValue(expression: ts.Expression): Value;
    compileWorkerValue(expression: ts.Expression): Value | undefined;
    withOwnedCallbackBody<T>(body: () => T): T;
    isNativeWorkerExpression(expression: ts.Expression): boolean;
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
    guardStaticConstructionRead(operation: string): void;
    expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression;
    referenceSearch(): string;
    /** The default-library global an expression names (symbols.ts `libraryGlobal`). */
    libraryGlobal(expression: ts.Expression): string | undefined;
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
    compileBoolean(expression: ts.Expression): string;
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
    /** Whether a value names a native binding nothing reassigns. */
    hasStableNativeBinding(value: Value): boolean;
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
    reachFileReader(): void;
    reachLocalStorage(): void;
    reachImageDecode(): void;
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
    compileRecordGetter(
        owner: Value,
        accessor: ts.GetAccessorDeclaration,
    ): Value;
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
    captureNativeDependencies<T>(compile: () => T): {
        value: T;
        nativeCaptures: readonly NativeCaptureBinding[];
    };
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
    emitDataPostfix(expression: ts.PostfixUnaryExpression): boolean;
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
    reachesOnlyClosedEffects(body: ts.Node): boolean;
    reachesOpaqueCallee(body: ts.Node): boolean;
    emitReusableNativeBody<T>(declaration: ts.Node, emitBody: () => T): T;
    compileSharedMethod(
        declaration: ts.MethodDeclaration,
        call: ts.CallExpression,
        arguments_: readonly Value[],
    ): Value | undefined;
    emitNativeDataIteration<T>(statement: ts.Statement, emitBody: () => T): T;
    dataValue(cpp: string, dataType: DataType): Value;
    bindDataIterationVariable(
        name: ts.BindingName,
        itemCpp: string,
        element: DataIterationElement,
        template?: Value,
    ): void;
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
    canvasSizeProperty(
        expression: ts.Expression,
    ): "width" | "height" | undefined;
    canvasSizeValue(expression: ts.Expression): Value | undefined;
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
    knownValueWithoutEvaluation(expression: ts.Expression): Value | undefined;
    knownCollectionCardinality(expression: ts.Expression): number | undefined;
    runtimeCollectionCardinality(expression: ts.Expression): number | undefined;
    recordArrayPush(value: Value, added: number | undefined): boolean;
    recordCollectionKey(value: Value, key: Value, removed?: boolean): void;
    recordCollectionClear(value: Value): void;
    expectKind(value: Value, kind: ValueKind, node: ts.Node): void;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    requireEngine(value: Value, node: ts.Node): string;
    engineFor(value: Value, node: ts.Node): string;
    audioSessionCpp(): string;
    requireDefaultEngine(node: ts.Node): string;
    requirePresentationHost(node: ts.Node): string;
    pbrLightmapEnabled(): boolean;
    reachFeature(feature: Feature, site?: ts.Node | string): void;
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
    hasRegisteredScene(): boolean;
    emit(line: string | NativeDeclaration): void;
    isEntryBodyScope(): boolean;
    increaseIndent(): void;
    decreaseIndent(): void;
    fail(
        node: ts.Node,
        message: string,
        reason?: import("./compile-error.js").CompileError["reason"],
    ): never;
}
