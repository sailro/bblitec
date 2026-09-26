import type { HandleKind } from "./model.js";

const handleCppTypes: Record<HandleKind, string> = {
    "custom-event": "bbl::PlatformCustomEvent",
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
    "worker-mutation-observer": "std::shared_ptr<bbl::pal::MutationObserver>",
    mesh: "bbl::MeshHandle",
    "animation-group": "bbl::AnimationGroupHandle",
    "flow-graph": "bbl::FlowGraphHandle",
    "flow-graph-runtime": "std::shared_ptr<bbl::FlowGraphRuntime>",
    "audio-buffer": "bbl::pal::AudioBufferHandle",
    "audio-engine": "bbl::AudioEngineHandle",
    "audio-source": "bbl::AudioSourceHandle",
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
    "thin-instance-pool": "bbl::MeshHandle",
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
]);

export function resourceValueCppType(kind: string): string | undefined {
    return resourceValueCppTypes.get(kind);
}
