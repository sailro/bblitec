/**
 * The pinned package's engine object types and the handle kinds their values
 * are held as, apart from handles.ts: a module that only tests handle kinds
 * does not load the pinned program (and the modules it reaches) with them.
 */
import ts from "typescript";
import { isPinnedSource } from "../../pinned-program.js";
import { declaredIn } from "../symbols.js";
import type { HandleKind } from "./model.js";

/** The pinned type name each handle kind is declared as. */
const pinnedHandleTypes: Record<string, HandleKind> = {
    AssetContainer: "asset",
    AudioEngine: "audio-engine",
    AudioInputSource: "audio-source",
    StaticSound: "static-sound",
    AudioBus: "audio-bus",
    SoundBuffer: "sound-buffer",
    StreamingSound: "streaming-sound",
    EngineContext: "engine",
    DeviceLostRecoveryHandle: "device-recovery",
    EnvironmentTextures: "gpu-environment",
    ProceduralSkyEnvironment: "procedural-sky-environment",
    GaussianSplatStream: "gaussian-splat-stream",
    NavigationPlugin: "navigation",
    MeshLoDAsset: "mesh-lod-asset",
    MeshLoDInstance: "mesh-lod-instance",
    MeshLoDMetadata: "mesh-lod-metadata",
    MeshLoDDiagnostics: "mesh-lod-diagnostics",
    GaussianSplatStreamStats: "splat-stream-stats",
    GaussianPointSplatting: "gaussian-point-splatting",
    GaussianPointSplattingProgress: "gaussian-point-splatting-progress",
    SplatVoxelCollision: "splat-voxel-collision",
    NodeInputHandle: "node-input",
    NodeMaterial: "material",
    PbrMaterialProps: "material",
    StandardMaterialProps: "material",
    TextData: "text-data",
    DefaultTextData: "text-data",
    TextRenderable: "text-renderable",
    TextLayer: "text-layer",
    TextRenderer: "text-renderer",
    GlyphRun: "text-run",
    PickingInfo: "picking-info",
    Mesh: "mesh",
    EffectWrapper: "effect-wrapper",
    AnimationGroup: "animation-group",
    VatBakeResult: "vat-bake",
    // A container's declared KHR_interactivity graphs and the runtimes
    // addToScene attaches for them.
    LoadedFlowGraph: "flow-graph",
    FgRuntime: "flow-graph-runtime",
    BillboardSpriteHandle: "billboard-sprite",
    BillboardSpriteSystem: "billboard-system",
    Camera: "camera",
    BankedFreeCamera: "camera",
    UtilityLayer: "utility-layer",
    PointerDrag: "pointer-drag",
    SceneContext: "scene",
    RenderTarget: "render-target",
    RenderTargetTextureResult: "render-target-texture",
    SceneColorGrab: "transmission-grab",
    SceneNode: "scene-node",
    LightBase: "light",
    HemisphericLight: "light",
    DirectionalLight: "light",
    PointLight: "light",
    SpotLight: "light",
    ClusteredPointLight: "clustered-light",
    ClusteredSpotLight: "clustered-light",
    ClusteredLightContainer: "clustered-light-container",
    ShadowGenerator: "shadow-generator",
    HierarchyInstancePool: "hierarchy-instance-pool",
    StorageBuffer: "storage-buffer",
    ComputeStorageTexture: "compute-storage-texture",
    ComputeTask: "compute-task",
    // A frame-graph task stored by its base interface.
    Task: "task",
    ComputeOneShot: "compute-one-shot",
    UniformBuffer: "uniform-buffer",
    ComputeUniformArena: "compute-uniform-arena",
    ComputeUniformWriter: "compute-uniform-writer",
    ComputeShader: "compute-shader",
    ComputeDispatch: "compute-dispatch",
    ComputeTextureResource: "compute-texture-resource",
    ComputeSampler: "compute-sampler",
    ExternalTexture: "external-texture",
    ComputeBindingDecl: "compute-binding-decl",
    ComputeBindingSet: "compute-binding-set",
    ComputeUniformLayout: "compute-uniform-layout",
    Material: "material",
    // Every view the native factories make is a material record of its own.
    MaterialView: "material",
    PhysicsWorld: "physics-world",
    PhysicsBody: "physics-body",
    PhysicsConstraint: "physics-constraint",
    PhysicsAggregate: "physics-aggregate",
    PhysicsViewer: "physics-viewer",
    PhysicsCharacterController: "physics-character-controller",
    PhysicsShape: "physics-shape",
    ShaderMaterial: "material",
    Sprite2DLayer: "sprite-layer",
    SpriteAtlas: "sprite-atlas",
    // A cloud is a SceneNode upstream like a Mesh is, and a container's
    // `_gaussianSplats` is the one place its type is read through the data
    // model rather than produced by an intrinsic.
    GaussianSplattingMesh: "splat-mesh",
    Texture2D: "texture",
    // `Texture2D & { depth }`, named by its alias.
    Texture3D: "texture",
    TransformNode: "transform-node",
    Skeleton: "skeleton",
    Bone: "bone",
    ObstacleHandle: "navigation-obstacle",
};

/**
 * Classify an opaque pinned handle without materializing any data types.
 * Gated on the pinned typings, so a scene's own interface named `Mesh` is
 * never mistaken for the engine resource type.
 */
export function pinnedHandleKind(type: ts.Type): HandleKind | undefined {
    return pinnedHandle(type, false);
}

/** Whether `type` is one of the pin's engine object types (`pinnedHandleKind`). */
export function isPinnedHandleType(type: ts.Type): boolean {
    return pinnedHandleKind(type) !== undefined;
}

/**
 * The kinds of the engine objects the pinned package declares. The package
 * makes each as an object literal (or `Object.create` of one) and declares
 * no class of its own (`test/pinned-engine-objects.test.ts`).
 */
const pinnedEngineObjectKinds: ReadonlySet<string> = new Set(
    Object.values(pinnedHandleTypes),
);

/** Whether a value of `kind` is an engine object the pinned package makes. */
export function isPinnedEngineObjectKind(kind: string): boolean {
    return pinnedEngineObjectKinds.has(kind);
}

/** Effect analysis also reads the exact implementation files registered by the pin. */
export function pinnedSourceHandleKind(type: ts.Type): HandleKind | undefined {
    return pinnedHandle(type, true);
}

function pinnedHandle(
    type: ts.Type,
    includePinnedSource: boolean,
): HandleKind | undefined {
    const symbol =
        type.aliasSymbol && pinnedHandleTypes[type.aliasSymbol.name]
            ? type.aliasSymbol
            : type.symbol;
    const kind = symbol ? pinnedHandleTypes[symbol.name] : undefined;
    return kind &&
        (declaredIn(symbol, "babylon") ||
            (includePinnedSource &&
                symbol?.declarations?.some((declaration) =>
                    isPinnedSource(declaration.getSourceFile()),
                )))
        ? kind
        : undefined;
}

/** The pinned type names whose values are `kind` handles. */
export function pinnedHandleTypeNames(kind: HandleKind): readonly string[] {
    return Object.entries(pinnedHandleTypes).flatMap(([name, handle]) =>
        handle === kind ? [name] : [],
    );
}

/** The handle kind a lowered library's record of this pinned name is held as. */
export function pinnedRecordHandleKind(name: string): HandleKind | undefined {
    return Object.hasOwn(pinnedHandleTypes, name)
        ? pinnedHandleTypes[name]
        : undefined;
}
