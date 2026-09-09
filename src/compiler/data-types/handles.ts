import type { HandleKind } from "./model.js";

const handleCppTypes: Record<HandleKind, string> = {
  "gpu-device": "bbl::GpuDeviceIdentity",
  "gpu-texture": "bbl::GpuTextureIdentity",
  "device-recovery": "std::shared_ptr<bbl::DeviceRecoveryRegistration>",
  "gpu-environment": "bbl::EnvironmentIdentity",
  "node-input": "bbl::NodeInputHandle",
  "text-data": "std::shared_ptr<bbl::TextDataState>",
  "text-renderable": "std::shared_ptr<bbl::TextRenderableState>",
  "text-layer": "std::shared_ptr<bbl::TextLayerState>",
  "text-renderer": "std::shared_ptr<bbl::TextRendererState>",
  "text-run": "std::shared_ptr<bbl::TextRunState>",
  "text-run-ref": "bbl::TextRunRef",
  "picking-info": "bbl::PickingInfo",
  "offscreen-canvas": "std::shared_ptr<bbl::pal::OffscreenCanvas>",
  mesh: "bbl::MeshHandle",
  "animation-group": "bbl::AnimationGroupHandle",
  "flow-graph": "bbl::FlowGraphHandle",
  "flow-graph-runtime": "std::shared_ptr<bbl::FlowGraphRuntime>",
  "audio-buffer": "bbl::pal::AudioBufferHandle",
  "audio-context": "bbl::pal::AudioContextHandle",
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
  material: "bbl::MaterialHandle",
  "physics-body": "bbl::upstream::PhysicsBody",
  "physics-aggregate": "bbl::upstream::PhysicsAggregate",
  "physics-viewer": "bbl::upstream::PhysicsViewerHandle",
  "physics-character-controller": "std::shared_ptr<bbl::character::PhysicsCharacterController>",
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
