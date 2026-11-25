import ts from "typescript";
import { isPinnedSource } from "../../pinned-program.js";
import { declaredIn } from "../symbols.js";
import type { DataType, HandleKind } from "./model.js";

const handleCppTypes: Record<HandleKind, string> = {
    "custom-event": "bbl::PlatformCustomEvent",
    "dom-event": "bbl::OwnedDomEvent",
    "dom-event-identity": "std::shared_ptr<bbl::DomEventState>",
    engine: "bbl::StoredEngine",
    asset: "bbl::AssetHandle",
    "gpu-device": "bbl::GpuDeviceIdentity",
    "gpu-texture": "bbl::GpuTextureIdentity",
    "gpu-texture-view": "bbl::GpuTextureView",
    // A pooled sampler is its device and canonical descriptor: equal ones are
    // one object. A device-made one carries an ordinal of its own.
    "gpu-sampler": "bbl::GpuSampler",
    "device-recovery": "std::shared_ptr<bbl::DeviceRecoveryRegistration>",
    "gpu-environment": "bbl::EnvironmentIdentity",
    "procedural-sky-environment":
        "std::shared_ptr<bbl::ProceduralSkyEnvironment>",
    "gaussian-splat-stream": "std::shared_ptr<bbl::GaussianSplatStream>",
    navigation: "bbl::pal::NavigationHandle",
    "mesh-lod-asset": "std::shared_ptr<bbl::MeshLoDAsset>",
    "mesh-lod-instance": "std::shared_ptr<bbl::MeshLoDInstance>",
    "mesh-lod-metadata": "bbl::MeshLoDMetadata",
    "mesh-lod-diagnostics": "std::shared_ptr<bbl::MeshLoDDiagnostics>",
    "splat-stream-stats": "std::shared_ptr<bbl::GaussianSplatStreamStats>",
    "gaussian-point-splatting": "std::shared_ptr<bbl::GaussianPointSplatting>",
    "gaussian-point-splatting-progress":
        "std::shared_ptr<bbl::GaussianPointSplattingProgress>",
    "splat-voxel-collision": "std::shared_ptr<bbl::SplatVoxelCollision>",
    "node-input": "bbl::NodeInputHandle",
    "text-data": "std::shared_ptr<bbl::TextDataState>",
    "text-renderable": "std::shared_ptr<bbl::TextRenderableState>",
    "text-layer": "std::shared_ptr<bbl::TextLayerState>",
    "text-renderer": "std::shared_ptr<bbl::TextRendererState>",
    "text-run": "bbl::TextRun",
    "text-run-ref": "bbl::TextRunRef",
    "picking-info": "bbl::PickingInfo",
    "offscreen-canvas": "std::shared_ptr<bbl::pal::OffscreenCanvas>",
    "worker-media-query": "std::shared_ptr<bbl::pal::MediaQueryList>",
    "worker-mutation-observer": "std::shared_ptr<bbl::pal::MutationObserver>",
    "message-port": "std::shared_ptr<bbl::pal::MessagePort>",
    "message-channel": "std::shared_ptr<bbl::pal::MessageChannel>",
    // A transfer list's entry: a MessagePort, an OffscreenCanvas or an
    // ArrayBuffer (`bbl::js::BufferTransfer`).
    transferable: "std::shared_ptr<bbl::pal::Transferable>",
    mesh: "bbl::MeshHandle",
    "effect-wrapper": "bbl::EffectWrapperHandle",
    "animation-group": "bbl::AnimationGroupHandle",
    "vat-bake": "bbl::VatBake",
    "flow-graph": "bbl::FlowGraphHandle",
    "flow-graph-runtime": "std::shared_ptr<bbl::FlowGraphRuntime>",
    "audio-buffer": "bbl::pal::AudioBufferHandle",
    "audio-engine": "bbl::AudioEngineHandle",
    "audio-source": "std::shared_ptr<bbl::AudioInputSource>",
    "static-sound": "std::shared_ptr<bbl::StaticSound>",
    "audio-bus": "std::shared_ptr<bbl::AudioBus>",
    "sound-buffer": "std::shared_ptr<bbl::SoundBuffer>",
    "streaming-sound": "std::shared_ptr<bbl::StreamingSound>",
    "audio-element": "bbl::pal::AudioElement",
    "audio-context": "bbl::pal::AudioContextHandle",
    "audio-node": "bbl::pal::AudioNodeHandle",
    "audio-param": "bbl::pal::AudioParamHandle",
    "media-stream": "std::shared_ptr<bbl::pal::MediaStream>",
    "media-stream-track": "std::shared_ptr<bbl::pal::MediaStreamTrack>",
    camera: "bbl::CameraHandle",
    "property-animation-group": "bbl::PropertyAnimationGroup",
    "ui-element": "bbl::UiElementHandle",
    "utility-layer": "bbl::UtilityLayerHandle",
    "pointer-drag": "bbl::PointerDragHandle",
    gamepad: "bbl::GamepadHandle",
    "gamepad-button": "bbl::GamepadButtonHandle",
    touch: "bbl::DomTouch",
    scene: "bbl::Scene",
    "render-target": "bbl::RenderTargetHandle",
    "render-target-texture": "bbl::RenderTargetTexture",
    task: "bbl::TaskHandle",
    "transmission-grab": "bbl::TransmissionGrab",
    "scene-node": "bbl::SceneNodeHandle",
    light: "bbl::LightHandle",
    "clustered-light": "bbl::ClusteredLightHandle",
    "clustered-light-container": "bbl::ClusteredLightContainerHandle",
    "shadow-generator": "bbl::ShadowGeneratorHandle",
    // The generator's `_config` is the generator's own record.
    "shadow-generator-config": "bbl::ShadowGeneratorHandle",
    "hierarchy-instance-pool": "bbl::HierarchyInstancePoolHandle",
    "thin-instance-pool": "std::shared_ptr<bbl::ThinInstancePoolData>",
    "storage-buffer": "bbl::StorageBufferHandle",
    "compute-storage-texture": "std::shared_ptr<bbl::ComputeStorageTexture>",
    "compute-texture-resource": "std::shared_ptr<bbl::ComputeTextureResource>",
    "compute-sampler": "std::shared_ptr<bbl::ComputeSamplerResource>",
    video: "bbl::VideoHandle",
    "external-texture": "bbl::ExternalTextureHandle",
    "compute-binding-decl": "bbl::ComputeBindingDeclPtr",
    "compute-binding-set": "std::shared_ptr<bbl::ComputeBindingSet>",
    "compute-shader": "std::shared_ptr<bbl::ComputeShader>",
    "compute-dispatch": "std::shared_ptr<bbl::ComputeDispatch>",
    "compute-task": "std::shared_ptr<bbl::ComputeTask>",
    "compute-one-shot": "std::shared_ptr<bbl::ComputeOneShot>",
    "uniform-buffer": "std::shared_ptr<bbl::UniformBuffer>",
    "compute-uniform-arena": "std::shared_ptr<bbl::ComputeUniformArena>",
    "compute-uniform-writer": "std::shared_ptr<bbl::ComputeUniformWriter>",
    "compute-uniform-layout":
        "std::shared_ptr<const bbl::ComputeUniformLayout>",
    material: "bbl::MaterialHandle",
    "physics-world": "bbl::upstream::PhysicsWorldHandle",
    "physics-native-body": "bbl::upstream::PhysicsNativeBody",
    "physics-module": "bbl::upstream::PhysicsWorldHandle",
    "physics-thin-context": "bbl::upstream::PhysicsWorldHandle",
    "physics-body-list": "bbl::upstream::PhysicsWorldHandle",
    "physics-body": "bbl::upstream::PhysicsBody",
    "physics-constraint": "bbl::upstream::PhysicsConstraint",
    "physics-aggregate": "bbl::upstream::PhysicsAggregate",
    "physics-viewer": "bbl::upstream::PhysicsViewerHandle",
    "physics-character-controller":
        "std::shared_ptr<bbl::character::PhysicsCharacterController>",
    "physics-shape": "bbl::upstream::PhysicsShape",
    "billboard-sprite": "bbl::BillboardSpriteHandle",
    "billboard-system": "bbl::BillboardSystemHandle",
    "sprite-layer": "bbl::Sprite2DLayerHandle",
    "sprite-atlas": "bbl::SpriteAtlasHandle",
    "splat-mesh": "bbl::SplatMeshHandle",
    texture: "bbl::StoredTexture",
    "transform-node": "bbl::TransformNodeHandle",
    skeleton: "bbl::SkeletonHandle",
    "scene-skeleton": "bbl::SceneSkeletonHandle",
    bone: "bbl::BoneHandle",
    "navigation-obstacle": "bbl::pal::NavObstacleHandle",
};

export function isHandleKind(kind: string): kind is HandleKind {
    return Object.prototype.hasOwnProperty.call(handleCppTypes, kind);
}

export function handleCppType(kind: HandleKind): string {
    return handleCppTypes[kind];
}

const engineScopedHandleKinds = new Set<HandleKind>([
    "asset",
    "mesh",
    "effect-wrapper",
    "thin-instance-pool",
    "material",
    "camera",
    "light",
    "clustered-light",
    "clustered-light-container",
    "animation-group",
    "vat-bake",
    "transform-node",
    "scene-node",
    "hierarchy-instance-pool",
    "render-target",
    "render-target-texture",
    "transmission-grab",
    "sprite-atlas",
    "sprite-layer",
    "billboard-system",
    "billboard-sprite",
    "skeleton",
    "scene-skeleton",
    "bone",
    "splat-mesh",
    "shadow-generator",
    "shadow-generator-config",
    "utility-layer",
    "pointer-drag",
    "ui-element",
    "flow-graph",
]);

/** These native handles name slots inside one Engine, not process-wide identities. */
export function isEngineScopedHandleKind(kind: HandleKind): boolean {
    return engineScopedHandleKinds.has(kind);
}

/**
 * Whether a plain handle of this kind lives in the entry point's engine. A
 * picking result names its picker's engine, a UI element the Window
 * document's, and text runs and node inputs belong to no engine.
 */
export function belongsToEntryEngine(kind: HandleKind): boolean {
    return (
        !kind.startsWith("text-") &&
        kind !== "node-input" &&
        kind !== "picking-info" &&
        kind !== "ui-element"
    );
}

/**
 * Window platform objects (`MediaQueryList`, `MutationObserver`): each is
 * one shared runtime object the Window realm owns, so a nullable binding
 * holds it in ordinary nullable storage.
 */
export function isWindowHandleKind(kind: HandleKind): boolean {
    return kind === "worker-media-query" || kind === "worker-mutation-observer";
}

/**
 * Platform input state the native input model answers though the DOM
 * declares it (a gamepad, its buttons, a Touch): never browser-only, and a
 * function parameter keeps it as its handle.
 */
export function isInputSnapshotHandleKind(kind: HandleKind): boolean {
    return kind === "gamepad" || kind === "gamepad-button" || kind === "touch";
}

/**
 * A handle whose value is its runtime identity alone, nothing generation-
 * known: an input snapshot, a decoded audio buffer, or an owned DOM event. A
 * shared body takes one as a native parameter instead of specializing on its
 * value.
 */
export function isRuntimeIdentityHandleKind(kind: HandleKind): boolean {
    return (
        isInputSnapshotHandleKind(kind) ||
        kind === "audio-buffer" ||
        kind === "dom-event"
    );
}

/** Whether a data type lists input snapshots, as a TouchEvent's TouchList does. */
export function isInputSnapshotList(type: DataType | undefined): boolean {
    return (
        type?.kind === "vector" &&
        type.element.kind === "handle" &&
        isInputSnapshotHandleKind(type.element.handle)
    );
}

/**
 * Whether a stored handle of this kind is one native handle. A texture's
 * storage converts between its stored, file and solid forms.
 */
export function storesOneHandle(kind: HandleKind): boolean {
    return kind !== "texture";
}

/** The node value kinds a `scene-node` handle slot holds. */
export function convertsToSceneNode(kind: string): boolean {
    return (
        kind === "mesh" || kind === "transform-node" || kind === "asset-root"
    );
}

/**
 * Resource values outside the data model whose native value has exactly one
 * type: every intrinsic that produces the kind returns it
 * (`bbl::create_sprite_renderer`, `bbl::create_animation_manager`,
 * `bbl::create_surface`, `bbl::create_gpu_picker`, each gizmo factory and a
 * composite gizmo's parts), and an asset's root is its `bbl::AssetHandle`.
 * A local holding one declares that type, so a closure capturing it has a
 * concrete environment.
 */
const resourceValueCppTypes: ReadonlyMap<string, string> = new Map([
    ["sprite-renderer", "bbl::SpriteRendererHandle"],
    ["animation-manager", "bbl::PropertyAnimationManager"],
    ["surface", "bbl::Surface"],
    ["gpu-picker", "bbl::GpuPickerHandle"],
    ["axis-drag-gizmo", "bbl::EditGizmoHandle"],
    ["axis-scale-gizmo", "bbl::EditGizmoHandle"],
    ["plane-drag-gizmo", "bbl::EditGizmoHandle"],
    ["plane-rotation-gizmo", "bbl::EditGizmoHandle"],
    ["position-gizmo", "bbl::CompositeGizmoHandle"],
    ["rotation-gizmo", "bbl::CompositeGizmoHandle"],
    ["scale-gizmo", "bbl::CompositeGizmoHandle"],
    ["bounding-box-gizmo", "bbl::BoundingBoxGizmoHandle"],
    ["camera-gizmo", "bbl::CameraGizmoHandle"],
    ["light-gizmo", "bbl::LightGizmoHandle"],
    ["asset-root", "bbl::AssetHandle"],
    ["frame-graph", "bbl::Scene"],
]);

export function resourceValueCppType(kind: string): string | undefined {
    return resourceValueCppTypes.get(kind);
}

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
