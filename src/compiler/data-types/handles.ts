import type { HandleKind } from "./model.js";

const handleCppTypes: Record<HandleKind, string> = {
    engine: "bbl::Engine*",
    asset: "bbl::AssetHandle",
    "gpu-device": "bbl::GpuDeviceIdentity",
    "gpu-texture": "bbl::GpuTextureIdentity",
    "device-recovery": "std::shared_ptr<bbl::DeviceRecoveryRegistration>",
    "gpu-environment": "bbl::EnvironmentIdentity",
    "procedural-sky-environment":
        "std::shared_ptr<bbl::ProceduralSkyEnvironment>",
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
    mesh: "bbl::MeshHandle",
    "animation-group": "bbl::AnimationGroupHandle",
    "flow-graph": "bbl::FlowGraphHandle",
    "flow-graph-runtime": "std::shared_ptr<bbl::FlowGraphRuntime>",
    "audio-buffer": "bbl::pal::AudioBufferHandle",
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
    scene: "bbl::Scene",
    "scene-node": "bbl::SceneNodeHandle",
    light: "bbl::LightHandle",
    "shadow-generator": "bbl::ShadowGeneratorHandle",
    "hierarchy-instance-pool": "bbl::HierarchyInstancePoolHandle",
    "storage-buffer": "bbl::StorageBufferHandle",
    "compute-storage-texture": "std::shared_ptr<bbl::ComputeStorageTexture>",
    "compute-texture-resource": "std::shared_ptr<bbl::ComputeTextureResource>",
    "compute-sampler": "std::shared_ptr<bbl::ComputeSamplerResource>",
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
    "physics-body": "bbl::upstream::PhysicsBody",
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

/**
 * Handles whose native value is an engine identity -- a record index, an
 * engine pointer, stored texture pixels -- and so owns no traced edge. Every
 * other handle owns shared state and counts as traced. A native fixture
 * checks each against `bbl::js::gc_traceable`.
 */
export const untracedHandleKinds: ReadonlySet<HandleKind> = new Set<HandleKind>(
    [
        "engine",
        "asset",
        "gpu-device",
        "gpu-texture",
        "gpu-environment",
        "mesh",
        "animation-group",
        "flow-graph",
        "camera",
        "ui-element",
        "utility-layer",
        "pointer-drag",
        "gamepad",
        "gamepad-button",
        "scene-node",
        "light",
        "shadow-generator",
        "hierarchy-instance-pool",
        "storage-buffer",
        "material",
        "billboard-sprite",
        "billboard-system",
        "sprite-layer",
        "sprite-atlas",
        "splat-mesh",
        "texture",
        "transform-node",
        "skeleton",
        "scene-skeleton",
        "bone",
    ],
);

export function handleOwnsTracedEdge(kind: HandleKind): boolean {
    return !untracedHandleKinds.has(kind);
}

export function isHandleKind(kind: string): kind is HandleKind {
    return Object.prototype.hasOwnProperty.call(handleCppTypes, kind);
}

export function handleCppType(kind: HandleKind): string {
    return handleCppTypes[kind];
}
